# OpenClaw Plugin: Ansible

**Distributed coordination layer for OpenClaw — one agent, multiple bodies (or one operator, many agents).**

Ansible enables a single agent identity (e.g., "Jane") to operate seamlessly across multiple devices. It synchronizes tasks, messages, and shared context in real-time using CRDTs (Yjs) over a secure mesh network (Tailscale).

This repo also documents a pragmatic way to use Ansible as a reliable inter-agent communication substrate today: treat the shared Yjs document as the durable inbox, and treat auto-dispatch as an optimization (not the only delivery mechanism).

## Key Concepts

### Hemispheres vs. Friends (Default: Friends)

Ansible coordinates **hemispheres** — mirrored instances of the *same* agent identity that share memory, context, and purpose. Think of it like one brain controlling multiple bodies:

| | Hemispheres (Ansible) | Friends / Employees |
|---|---|---|
| **Identity** | Same agent (e.g., "Jane" on VPS + "Jane" on Mac) | Different agents (e.g., "Jane" and "Alex") |
| **Memory** | Shared via CRDT sync | Separate memory stores |
| **Purpose** | Same goals, different capabilities | Different roles and responsibilities |
| **Communication** | Self-to-self (direct, efficient) | Inter-agent (polite, contextual) |
| **Session** | Shared session state | Independent sessions |

A hemisphere is your agent's presence on another machine.

In many setups, you do *not* want every agent to see cross-node context or have inbound ansible messages routed into the default agent. In those setups, treat nodes as **friends/employees** and centralize ops in a single operator agent (for example, an "Architect").

### Node Topology

- **Backbone nodes** (always-on) — Servers, VPS instances. Handle long-running tasks, scheduled work, background coordination. Host the Yjs WebSocket server.
- **Edge nodes** (intermittent) — Laptops, desktops. Have local filesystem access, run interactively with the user. Connect to backbone on startup.

## Prerequisites

### 1. OpenClaw

Install OpenClaw on all nodes:

```bash
npm install -g openclaw
```

Each node needs a working OpenClaw gateway (`openclaw gateway` or managed via launchd/systemd).

### 2. Tailscale

Ansible uses Tailscale for secure, zero-config networking between nodes.

1. **Install Tailscale** on all nodes: [tailscale.com/download](https://tailscale.com/download)
2. **Sign in** to the same Tailscale network (tailnet) on every node
3. **Enable MagicDNS** in your Tailscale admin console — this lets you use hostnames like `jane-vps` instead of IPs
4. **Verify connectivity** between nodes:
   ```bash
   tailscale ping <other-node-hostname>
   ```

**Important Tailscale details:**
- Backbone peers in the ansible config MUST use Tailscale MagicDNS hostnames or Tailscale IPs (100.x.y.z), NOT SSH aliases or public IPs
- If running inside Docker, Tailscale runs on the *host*, not inside the container. The container reaches Tailscale peers via the host's network
- The ansible WebSocket port (default 1235) is separate from the OpenClaw gateway port (default 18789) — never mix them

### 3. Ansible Skill (Recommended)

Install the companion skill so your agent knows how to use ansible:

```bash
cd ~/.openclaw/workspace/skills
git clone https://github.com/likesjx/openclaw-skill-ansible.git ansible
```

Restart your OpenClaw gateway to pick up the skill.

To enforce base ansible skills across all configured agent workspaces on a gateway:

```bash
openclaw ansible skills sync --skill ansible
openclaw ansible skills verify --skill ansible
```

`sync` links the skill into each agent workspace and is safe by default (it will not replace existing mismatched paths unless you pass `--force-replace`).

## Installation

### 1. Install the Plugin

On every node:

```bash
openclaw plugins install likesjx/openclaw-plugin-ansible
```

For local development:
```bash
openclaw plugins install /path/to/repo --link
```

### 2. Configure

Add the `ansible` plugin to `~/.openclaw/openclaw.json` on each node.

#### Backbone Node (VPS / Docker)

```jsonc
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "entries": {
      "ansible": {
        "enabled": true,
        "config": {
          "tier": "backbone",
          "listenPort": 1235,
          "listenHost": "0.0.0.0",
          "capabilities": ["always-on"]
        }
      }
    }
  }
}
```

When running in Docker, expose the port bound to your Tailscale IP:

```yaml
# docker-compose.yml
services:
  jane:
    ports:
      # Bind to Tailscale IP only (NOT 0.0.0.0) for security
      - "100.x.y.z:1235:1235"
```

#### Edge Node (Mac / Laptop)

```jsonc
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "entries": {
      "ansible": {
        "enabled": true,
        "config": {
          "tier": "edge",
          "backbonePeers": [
            "ws://jane-vps:1235"
          ],
          "capabilities": ["local-files", "voice"]
        }
      }
    }
  }
}
```

`backbonePeers` must use Tailscale MagicDNS hostnames or Tailscale IPs. SSH config aliases do NOT work here.

### Architect-Managed (Recommended for Multi-Agent Ops)

If you want ansible to be operated only by a dedicated agent (e.g., Architect), disable:
- prompt context injection
- auto-dispatch of inbound ansible messages into the default agent

```jsonc
{
  "plugins": {
    "entries": {
      "ansible": {
        "enabled": true,
        "config": {
          "tier": "edge",
          "backbonePeers": ["ws://jane-vps:1235"],
          "injectContext": false,
          "dispatchIncoming": false
        }
      }
    }
  }
}
```

In this mode, the operator agent should poll and respond using tools like:
- `ansible_read_messages`
- `ansible_send_message`

## Reliability & Delivery Semantics (If You Want To Rely On It)

Ansible has two distinct mechanisms:

1. **Durable state replication**: messages/tasks/context are written into the shared Yjs document and replicated across nodes.
2. **Auto-dispatch (optional)**: when a node observes inbound work (messages, and explicitly-assigned tasks) in the shared Yjs doc, it can inject that work into the agent loop as a normal inbound turn.

What this means today:

- **Messages are durable** (persist in the Yjs doc; readable via `ansible_read_messages`; visible in context injection if enabled).
- **Auto-dispatch is best-effort realtime + reconnect-safe**:
  - New messages dispatch immediately while connected.
  - On reconnect (provider `sync=true`), the dispatcher reconciles backlog deterministically (timestamp order) and injects any undelivered items.
  - Dispatch failures are retried with exponential backoff (with jitter) instead of being "seen forever".

If you want to "completely rely" on Ansible for inter-agent communication, treat the shared Yjs doc as the source of truth and the dispatcher as the delivery worker. You can still keep manual tools (`ansible_read_messages`, `ansible_find_task`) as an operator backstop.

For a concrete protocol and improvement plan, see `docs/protocol.md`.
For the practical "how do I add a new agent/gateway" guide, see `docs/setup.md`.

### 3. Bootstrap the Network

1. **Start the backbone**: Restart OpenClaw on the VPS
2. **Bootstrap** (run on the backbone node):
   ```bash
   openclaw ansible bootstrap
   ```
3. **Invite edge nodes** (run on backbone):
   ```bash
   openclaw ansible invite --tier edge
   ```
4. **Join** (run on each edge node):
   ```bash
   openclaw ansible join --token <token-from-invite>
   ```

## How It Works

### Message Dispatch

When one hemisphere sends a message, the ansible dispatcher automatically injects it into the receiving hemisphere's agent loop — just like a Telegram or Twitch message would. The agent processes it as a full turn and can reply, call tools, or delegate tasks.

Replies are delivered back through the Yjs document automatically.

Important: backlog is durable and will also be delivered on reconnect via reconciliation; this is what makes restarts/offline edges reliable.

### Session Isolation

Each sender gets a separate ansible session (`ansible:{nodeId}`). Conversation history is preserved per-hemisphere, so ongoing coordination has continuity. This mirrors how Telegram creates per-chat sessions.

### State Sync

All state is synchronized via Yjs CRDTs:
- **Messages**: Inter-hemisphere communication
- **Tasks**: Delegated work items with claim/complete lifecycle
- **Context**: Current focus, active threads, recent decisions
- **Pulse**: Online status and heartbeat data

## Agent Tools

| Tool | Description |
|---|---|
| `ansible_status` | Check who's online, what they're working on, pending tasks |
| `ansible_delegate_task` | Create a task for another hemisphere |
| `ansible_claim_task` | Pick up a pending task |
| `ansible_complete_task` | Mark a claimed task as done |
| `ansible_send_message` | Send a message (targeted or broadcast) |
| `ansible_update_context` | Update your current focus, threads, or decisions |
| `ansible_read_messages` | Read messages (unread by default) |
| `ansible_mark_read` | Mark messages as read |
| `ansible_delete_messages` | **Operator-only emergency purge** (destructive; strongly discouraged for agent workflows) |
| `ansible_get_coordination` | Read coordinator configuration (who coordinates, sweep cadence) |
| `ansible_set_coordination_preference` | Record your preferred coordinator/cadence (per-node preference) |
| `ansible_set_coordination` | Set coordinator configuration (initial setup or last-resort failover) |
| `ansible_set_retention` | Configure coordinator roll-off (daily prune of closed tasks by TTL) |
| `ansible_get_delegation_policy` | Read shared delegation policy + per-agent ACK records |
| `ansible_set_delegation_policy` | Coordinator-only publish/update delegation policy (+ optional notify) |
| `ansible_ack_delegation_policy` | Record this agent's ACK for the current policy version/checksum |

`ansible_delete_messages` is intentionally high-friction (`confirm` token + required justification + explicit filters) and should only be used by human operators for emergency cleanup. It is hard-gated to nodes that advertise capability `admin`.

## CLI Commands

```bash
openclaw ansible status              # Show network health and nodes
openclaw ansible nodes               # List authorized nodes
openclaw ansible tasks               # View shared task list
openclaw ansible send --message "hi" # Send a manual message
openclaw ansible retention set       # Configure closed-task roll-off (coordinator-only service)
openclaw ansible messages-delete --dry-run --from architect --reason "Emergency cleanup of stale chatter"
openclaw ansible delegation show     # Show policy + ACK status
openclaw ansible delegation set      # Publish policy from markdown file (coordinator-only)
openclaw ansible delegation ack      # ACK current policy
openclaw ansible bootstrap           # Initialize as first node
openclaw ansible invite --tier edge  # Generate invite token
openclaw ansible join --token <tok>  # Join with invite token
```

## Updating (Maintainers + Users)

### Maintainers (this repo)

This plugin is typically installed from GitHub, so **`dist/` must be committed**.

1. Make changes in `src/` and/or docs.
2. Build: `npm ci && npm run build`
3. Verify `dist/` changed as expected.
4. Commit both `src/` and `dist/` (plus docs), then push.

### Users (machines running OpenClaw)

After updating the plugin:

1. Update the plugin checkout (either via `openclaw plugins update ansible` if you have an install record, or by re-running `openclaw plugins install likesjx/openclaw-plugin-ansible`).
2. Run `openclaw ansible setup` to align skill + config (use `--dry-run` first if desired).
3. Restart the gateway (`openclaw gateway restart`, or your supervisor).

`openclaw ansible setup` intentionally updates **skill + config only**. Plugin code update remains a separate explicit step.

## Troubleshooting

### Connection Refused
- Check backbone is running: `openclaw ansible status`
- Check firewall: `sudo ufw allow 1235/tcp` (or allow on Tailscale interface only)
- Docker: Ensure `listenHost: "0.0.0.0"` is set in the backbone config
- Try using the Tailscale IP directly: `ws://100.x.y.z:1235`

### Tailscale Issues
- Run `tailscale ping <hostname>` to verify the tunnel
- Ensure MagicDNS is enabled in your Tailscale admin console
- Inside Docker containers, Tailscale hostname resolution depends on host DNS — if DNS is broken on the host, containers will fail too

### "Ansible not initialized"
- The gateway must be running and the Yjs document must be synced
- For edge nodes, wait for the first successful sync with the backbone

### Node ID Shows Container Hash Instead of Hostname
- When running inside Docker, the hostname is the container ID (e.g., `2ad9255a2f3e`), not the Tailscale hostname
- This is cosmetic — messages still route correctly because the dispatcher processes all new messages regardless of `to` field

## Known Issues

- **Gemini provider `.filter()` crash**: If using `google-gemini-cli` provider and the session transcript contains a corrupted `toolResult` message, the pi-ai library crashes with "Cannot read properties of undefined (reading 'filter')". Workaround: reset the session with `/new` or switch to a different provider. This is an upstream bug in `@mariozechner/pi-ai`.

## Architecture

See [docs/architecture.md](docs/architecture.md) for detailed technical architecture.

## License

MIT
