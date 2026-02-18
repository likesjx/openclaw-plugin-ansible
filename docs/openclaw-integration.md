# OpenClaw Integration (Plugin + Skill)

This document is the "one page" architecture for how:

- the **ansible plugin** (`likesjx/openclaw-plugin-ansible`) integrates with OpenClaw, and
- the companion **ansible skill** (`likesjx/openclaw-skill-ansible`) shapes agent behavior

to form a reliable coordination mesh across gateways.

## Mental Model

OpenClaw is a gateway process that:

- exposes a JSON WebSocket interface for agent turns (default `:18789`), and
- loads **plugins** (code) and **skills** (markdown instructions) at startup.

The ansible system has two parts:

1. **Plugin (code, required)**
   - runs inside each gateway process
   - provides shared state (Yjs), tools, services, and (optional) auto-dispatch
2. **Skill (markdown, recommended)**
   - is injected into the agent prompt
   - teaches conventions for delegation, coordination, and operational behavior

Without the plugin, the skill has no tools.
Without the skill, the plugin tools exist but the agent will use them inconsistently.

## Where Things Run

### Plugin

The plugin executes in the gateway process on every node:

- **Backbone** nodes host a y-websocket server for shared state sync (default `:1235`)
- **Edge** nodes connect to one or more backbones

### Skill

The skill is loaded by the gateway at startup from:

`~/.openclaw/workspace/skills/ansible/SKILL.md`

OpenClaw injects skill text into each agent turn's system prompt. The skill contains
behavioral rules only; it cannot register tools/services.

## What The Plugin Registers

Plugin entry point: `src/index.ts`

It registers:

- **Sync service** (`src/service.ts`)
  - creates/loads the Yjs doc
  - starts y-websocket server (backbone) or websocket providers (edge)
  - persists state to `~/.openclaw/ansible-state.yjs` (edge; and on some backbones depending on runtime)
  - emits `onDocReady` and `onSync` events
- **Agent tools** (`src/tools.ts`)
  - status, messages, task delegation lifecycle, coordination configuration
- **Hook** (`src/hooks.ts`)
  - `before_agent_start` context injection (optional)
- **CLI** (`src/cli.ts`)
  - `openclaw ansible ...` commands (setup, join, invite, status, retention set)
- **Dispatcher** (`src/dispatcher.ts`)
  - optional best-effort listener + reconnect reconciliation
  - injects inbound work into the agent loop and writes replies back to Yjs
- **Lock sweeper** (`src/lock-sweep.ts`)
  - per-gateway reliability guard for stale `.jsonl.lock` files
- **Retention / roll-off** (`src/retention.ts`)
  - coordinator-only daily prune of closed tasks by TTL (configurable)

## Shared State (Yjs) and Durability

The shared Yjs doc stores maps for:

- `messages`: inter-node messages (broadcast or targeted)
- `tasks`: durable delegation records (`pending/claimed/in_progress/completed/failed`)
- `pulse`: heartbeat/presence per node (`lastSeen`, `status`)
- `coordination`: coordinator settings + preferences + retention knobs
- `context`: optional cross-node prompt context (focus, threads, decisions)

### Source Of Truth

The **Yjs doc is the source of truth**, not the listener.

- Auto-dispatch is best-effort. If an agent was asleep/offline, it can reconcile on reconnect.
- Polling (`ansible_status`, `ansible_read_messages`) should always be able to recover.

## Message and Task Delivery Semantics

### Listener (Best-Effort)

If `dispatchIncoming=true` on a node:

- the dispatcher observes new inbound messages/tasks in Yjs and tries to dispatch them into the agent loop immediately

### Reconnect Reconciliation (Reliability Backstop)

On a `sync=true` event, the dispatcher:

- scans for backlog addressed to this node (or broadcast)
- dispatches deterministically (timestamp order)
- records per-node delivery state to avoid duplicates
- retries with backoff on transient dispatch failures

### Polling Mode (Operator-Managed)

If `dispatchIncoming=false` (recommended for many worker agents):

- inbound items still accumulate durably in Yjs
- an operator/coordinator reads them via tools and routes explicitly

## Coordinator Responsibilities

Coordinator is a *role* declared in shared state (`coordination.coordinator`).

The coordinator is expected to:

- detect and close operational loops (stuck tasks, undelivered items)
- keep reporting non-noisy (only actionable DEGRADED events)
- perform retention roll-off (daily prune closed tasks older than TTL)
- publish and enforce Delegation Directory policy (versioned + ACKed)

### Delegation Directory (Identity.md Distribution)

Delegation should be controlled by a versioned policy:

- canonical: shared `coordination` state (`delegationPolicyVersion`, checksum, markdown)
- published: each agent `IDENTITY.md` section `## Delegation Directory`
- transport: coordinator sends policy update messages and records ACKs

This ensures every agent delegates with the same routing/SLA rules and gives you a clear audit trail when policy changes.

### Retention / Roll-Off

Coordinator-only service prunes tasks that are `completed` or `failed` once older than TTL.

Defaults:

- prune cadence: daily (`retentionPruneEverySeconds = 86400`)
- closed task TTL: 7 days (`retentionClosedTaskSeconds = 604800`)

Config:

- Tool: `ansible_set_retention { closedTaskRetentionDays, pruneEveryHours }`
- CLI: `openclaw ansible retention set --closed-days N --every-hours H`

## How "ansible setup" Connects Plugin and Skill

`openclaw ansible setup` is the practical glue:

- installs/updates the skill repo into `~/.openclaw/workspace/skills/ansible`
- patches `~/.openclaw/openclaw.json` to enable/configure the plugin
- restarts the gateway (unless `--no-restart`)

This is intentionally idempotent to support both first-time install and later maintenance.

## Dist Folder (Why It Exists)

OpenClaw installs plugins from GitHub repos. For that to work reliably, the repository must contain built JS output.

Therefore, for this plugin:

- `src/` is the TypeScript source of truth
- `dist/` is committed build output used by OpenClaw at runtime

Maintainers must commit both when changing code.
