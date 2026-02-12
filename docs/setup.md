# Setup & Ops Guide

This doc is the practical "how we run this" guide for:

- adding the plugin + skill to a new agent on an *existing* gateway
- adding a new gateway (new machine/container)
- choosing backbone vs edge
- making delegation reliable (Coordinator + sweep loop)

## Terms

- **Gateway**: the OpenClaw gateway process running on a machine (Mac launchd, VPS container, etc.)
- **Node**: one running gateway instance connected to the shared ansible Yjs doc (identified by `nodeId`)
- **Backbone**: always-on node hosting the Yjs websocket server (`ws://...:1235`)
- **Edge**: intermittent node connecting to one or more backbones

## Option A (Recommended): Post-Install Setup

Assumption: OpenClaw gateway + agent(s) already exist on this machine.

Use:

```bash
openclaw ansible setup \
  --tier edge \
  --backbone ws://jane-vps:1235 \
  --inject-agent mac-jane \
  --inject-agent architect
```

What it does (idempotent):

1. Installs/updates the companion skill into `~/.openclaw/workspace/skills/ansible`
2. Patches `~/.openclaw/openclaw.json` to enable/configure the ansible plugin
3. Restarts the gateway (unless `--no-restart`)

### Flags You’ll Actually Use

- `--tier backbone|edge`
- `--backbone ws://host:1235` (repeat or comma separate)
- `--inject-agent <agentId>` (repeat)
- `--dispatch-incoming true|false` (see "Reliability" below)

## Adding The Plugin/Skill To A New Agent (Same Gateway)

Important: the **plugin is installed per gateway**, not per agent. What changes per agent is:

- which agents receive ansible context injection (`injectContextAgents`)
- which agents you operationally want to run the "Coordinator" loop

Steps (on the gateway host):

1. Add the agent id to `plugins.entries.ansible.config.injectContextAgents` in `~/.openclaw/openclaw.json`
2. Restart the gateway (`openclaw gateway restart`)

That’s it. The agent should now have ansible message/task context injected, and can call ansible tools.

## Adding A New Gateway (New Machine/Container)

Checklist:

1. Install OpenClaw
2. Install + log into Tailscale (same tailnet; MagicDNS enabled)
3. Decide `tier`:
   - **backbone**: always-on coordination host; use this for a VPS
   - **edge**: laptop/desktop
4. Run `openclaw ansible setup ...` (above)
5. Join the mesh:
   - backbone: `openclaw ansible bootstrap` (first backbone only)
   - edge: `openclaw ansible join --token <token from backbone>`

## Reliability: Coordinator + Sweep Loop

Today, do **not** assume auto-dispatch alone is sufficient for "never miss a message".

Recommended production posture:

- A designated **Coordinator** performs a deterministic sweep loop.
- Workers may keep `dispatchIncoming=false` to reduce surprise full-turn injection.
- The sweep loop polls:
  - unread messages
  - pending tasks
  - timeouts / stalled work
  - closes the loop by notifying the requester when done

## Session Lock Sweeper (Per-Gateway)

OpenClaw uses per-session `.jsonl.lock` files to guard session writes. If a run crashes or is interrupted, a stale lock can block future turns for that session.

The plugin includes a small per-gateway sweeper service (`ansible-lock-sweep`) to automatically remove stale locks.

Defaults (safe + pragmatic):

- enabled by default
- `everySeconds = 60`
- `staleSeconds = 300` (remove any lock older than 5 minutes, even if the PID is the long-running gateway PID)

### Coordinator State (Implemented)

Shared config lives in the Yjs `coordination` map:

- `coordinator`: node id (string)
- `sweepEverySeconds`: integer
- `pref:<nodeId>`: per-node preferences (`desiredCoordinator`, `desiredSweepEverySeconds`)
- Retention / roll-off (coordinator-only):
  - `retentionClosedTaskSeconds` (default: 604800 = 7 days)
  - `retentionPruneEverySeconds` (default: 86400 = daily)
  - `retentionLastPruneAt` (ms epoch; informational)

Tools:

- `ansible_get_coordination`
- `ansible_set_coordination_preference`
- `ansible_set_coordination` (requires `confirmLastResort=true` when switching coordinators)
- `ansible_set_retention` (set closed-task roll-off policy)

CLI:

```bash
openclaw ansible retention set --closed-days 7 --every-hours 24
```

### Initial Policy (What We’re Doing Now)

- Coordinator: `vps-jane`
- Maintenance agent: `architect` (monitoring + improvements + incident response)
- Default sweep: 60 seconds (tune later)

## Delegation Directory (Spec)

To make delegation stable and discoverable for *new agents* and *new gateways*, we need a shared "directory"
that can be read without having to infer intent from chat history.

Proposed shared state (future; document-first):

- `directory.nodes[<nodeId>]`:
  - `tier`, `capabilities[]`, `tailscaleName`, `endpointWs`, `lastSeenAt`, `heartbeatAt`
- `directory.agents[<agentId>]`:
  - `role`: `coordinator|maintenance|worker`
  - `ownerNodeId` (optional)
  - `delegationPolicyRef`: link/name of policy doc in skill
- `directory.delegations[<agentId>]`:
  - `canDelegateTo[]` (agent ids)
  - `mustRouteThroughCoordinator: boolean`
  - `defaultPriority`, `slaSeconds`

This directory is what every listener uses to decide:

- "who should handle this message/task"
- "should I self-handle vs delegate"
- "who do I notify when I’m done"

Implemented documentation standard:

- `docs/delegation-directory.md`
- `docs/identity-delegation-template.md`

### Rollout Checklist (All Agents)

1. Add `## Delegation Directory` section to each agent `IDENTITY.md` from template.
2. Coordinator publishes `delegationPolicyVersion` + `delegationPolicyChecksum` in shared state.
3. Coordinator sends `policy_update` messages to each active agent.
4. Each agent applies update and replies `policy_ack` (same version/checksum).
5. Coordinator sweep flags only actionable exceptions:
   - missing ACK after threshold
   - checksum mismatch
   - invalid routing row
