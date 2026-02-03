# OpenClaw Plugin: Ansible

Distributed coordination layer for OpenClaw — **one agent, multiple bodies**.

Ansible enables a single agent identity ("Jane") to operate across multiple OpenClaw instances. Unlike multi-agent systems where independent agents collaborate, Ansible creates one agent with multiple bodies that share the same personality, knowledge, and real-time context.

## Architecture

```
              ┌─────────────────────────────┐
              │      "Jane" (singular)      │
              │  • Consistent personality   │
              │  • Shared context           │
              │  • Unified knowledge        │
              └─────────────────────────────┘
                     │           │
           ┌─────────┘           └─────────┐
           ▼                               ▼
    ┌─────────────┐                 ┌─────────────┐
    │  Mac Body   │                 │  VPS Body   │
    │  (edge)     │                 │  (backbone) │
    └─────────────┘                 └─────────────┘
```

### Two-Tier Design

- **Backbone** (VPS): Always-on nodes that form a peer-to-peer sync mesh
- **Edge** (Mac/laptops): Intermittent nodes that sync when available

### Transport

- **Tailscale** for secure mesh networking
- **Yjs CRDTs** for conflict-free state synchronization
- Works offline, merges on reconnect

## Installation

```bash
# In your OpenClaw config directory
npm install openclaw-plugin-ansible
```

## Configuration

```yaml
# openclaw.yaml

plugins:
  ansible:
    tier: backbone          # or "edge"
    listenPort: 1234        # backbone only
    backbonePeers:          # for connecting to other nodes
      - ws://vps-jane.tail:1234
      - ws://vps-2.tail:1234
    capabilities:           # what this node can do
      - always-on
      - gpu
```

## Agent Tools

The plugin provides these tools to the agent:

| Tool | Description |
|------|-------------|
| `ansible.delegate_task` | Delegate work to another hemisphere |
| `ansible.send_message` | Send a message to other hemispheres |
| `ansible.update_context` | Update your current focus/decisions |
| `ansible.status` | Get status of all hemispheres |
| `ansible.claim_task` | Claim a pending task |
| `ansible.complete_task` | Mark a task as completed |
| `ansible.mark_read` | Mark messages as read |

## CLI Commands

```bash
openclaw ansible status              # Show all hemispheres
openclaw ansible nodes               # List authorized nodes
openclaw ansible tasks               # List tasks
openclaw ansible invite <node>       # Invite a new node
openclaw ansible revoke <node>       # Revoke access
openclaw ansible send "message"      # Send a message
```

## Shared State

Ansible syncs the following via Yjs CRDTs:

- **tasks** — Work delegation between hemispheres
- **messages** — Inter-hemisphere communication
- **context** — Current focus, threads, decisions (per-node)
- **pulse** — Health and presence data
- **nodes** — Authorized node registry

Memory and durable knowledge remain in GitHub (existing system).

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev

# Type check
npm run typecheck
```

## License

MIT
