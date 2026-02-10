# Architecture

## System Overview

```
                    Tailscale Mesh Network
                    =====================

  +-----------------+          +-----------------+
  |   VPS (Backbone)|          |  Mac (Edge)     |
  |                 |          |                 |
  |  OpenClaw GW    |          |  OpenClaw GW    |
  |  ├── Ansible    |  y-ws    |  ├── Ansible    |
  |  │   Plugin ◄───┼──────────┼──►   Plugin     |
  |  │   (listen    |  :1235   |  │   (connect   |
  |  │    :1235)    |          |  │    to peer)   |
  |  │              |          |  │              |
  |  ├── Yjs Doc ◄──┼── CRDT ──┼──► Yjs Doc     |
  |  │   (shared)   |  sync    |  │   (shared)   |
  |  │              |          |  │              |
  |  └── Agent      |          |  └── Agent      |
  |      "Jane"     |          |      "Jane"     |
  +-----------------+          +-----------------+
```

## Components

### Plugin Entry Point (`src/index.ts`)

Registers all plugin components with the OpenClaw plugin API:
- Service (Yjs sync)
- Tools (agent-facing)
- Hooks (before_agent_start context injection)
- CLI commands
- Message dispatcher
- Per-gateway lock sweeper service
- Coordinator-only retention / roll-off service

### Sync Service (`src/service.ts`)

Manages the Yjs document and WebSocket connections:
- **Backbone mode**: Creates a y-websocket server on the configured port
- **Edge mode**: Connects to backbone peers as a y-websocket client
- Persists state to `~/.openclaw/ansible-state.yjs` on disk
- Fires `docReady` callbacks after the document is initialized and synced

### Message Dispatcher (`src/dispatcher.ts`)

Observes the Yjs messages map for new inbound messages and dispatches them into the agent loop. Follows the same pattern as built-in OpenClaw extensions (Telegram, Twitch, Zalo):

1. Observe Yjs `messages` map for new entries
2. Filter: skip own messages, messages for other nodes, already-read messages
3. Build a `MsgContext` with `formatAgentEnvelope()`
4. Call `finalizeInboundContext()` to set defaults
5. Call `recordInboundSession()` for session metadata
6. Call `dispatchReplyWithBufferedBlockDispatcher()` to trigger a full agent turn
7. Deliver callback writes the reply as a new Yjs message
8. Mark the original message as read

Dispatcher also supports:

- reconnect reconciliation (on `sync=true`) to scan backlog deterministically
- per-node delivery state (`delivery[receiver]`) to avoid duplicates
- retries with exponential backoff for transient dispatch failures

### Hooks (`src/hooks.ts`)

Registers a `before_agent_start` hook that injects shared ansible context into every agent prompt:
- Current focus of all hemispheres
- Active threads and recent decisions
- Pending tasks assigned to this node
- Unread messages from other hemispheres

### Tools (`src/tools.ts`)

Agent-facing tools for inter-hemisphere coordination. Registered via `api.registerTool()`. All tools operate on the shared Yjs document.

### Lock Sweeper (`src/lock-sweep.ts`)

Per-gateway reliability guard: periodically removes stale session `.jsonl.lock` files so a crashed/aborted run cannot permanently wedge future turns.

### Retention / Roll-Off (`src/retention.ts`)

Coordinator-only service that prunes old closed tasks to keep the shared state trustworthy.

Defaults:

- runs daily
- removes tasks with status `completed` or `failed` once older than 7 days

Configuration is stored in the shared `coordination` map and can be updated via the `ansible_set_retention` tool (or `openclaw ansible retention set`).

### Auth (`src/auth.ts`)

Node authorization using invite tokens. Tokens are stored in the Yjs document and validated on tool use.

### CLI (`src/cli.ts`)

Terminal commands for manual mesh management (status, send, bootstrap, invite, join).

### Schema (`src/schema.ts`)

TypeScript types and validation constants for all shared data structures (Messages, Tasks, Context, Pulse).

## Data Flow

### Inbound Message (hemisphere A -> hemisphere B)

```
A calls ansible.send_message
  → writes to Yjs messages map
    → CRDT syncs to B's Yjs doc
      → B's dispatcher observes new message
        → builds MsgContext, dispatches into agent loop
          → B's agent processes message, generates reply
            → deliver callback writes reply to Yjs
              → CRDT syncs reply back to A
```

### Context Injection (every agent turn)

```
Agent turn starts
  → before_agent_start hook fires
    → reads shared Yjs state (context, tasks, messages)
      → builds markdown context block
        → prepends to agent prompt as <ansible-context>
```

## Port Architecture

- **Port 1235** (default): Ansible plugin — binary y-websocket/Yjs protocol for CRDT sync
- **Port 18789** (default): OpenClaw gateway — JSON WebSocket protocol for agent communication

These are completely separate protocols. Never mix them.

## Session Key Strategy

Sessions use `ansible:{senderNodeId}` as the key (e.g., `ansible:vps-jane`). Each ansible peer gets its own conversation session with the agent. Session history is preserved across messages from the same peer.

## OpenClaw Plugin API

The plugin uses the OpenClaw plugin API (`api`) which provides:
- `api.registerService()` — register background services
- `api.registerTool()` — register agent-facing tools
- `api.on(hookName, handler)` — register hooks
- `api.registerCli()` — register CLI commands
- `api.runtime` — access to the channel dispatch system (for message dispatcher)
- `api.config` — the full OpenClaw configuration
- `api.logger` — structured logging

### Runtime Channel API (for dispatcher)

The dispatcher accesses `api.runtime.channel.reply` which provides:
- `formatAgentEnvelope()` — format channel/sender/timestamp headers
- `resolveEnvelopeFormatOptions()` — resolve envelope configuration
- `finalizeInboundContext()` — normalize MsgContext with defaults
- `dispatchReplyWithBufferedBlockDispatcher()` — trigger a full agent turn

And `api.runtime.channel.session` which provides:
- `recordInboundSession()` — record session metadata
- `resolveStorePath()` — resolve session store file path
