# OpenClaw Plugin: Ansible

**Distributed coordination layer for OpenClaw — one agent, multiple bodies.**

Ansible enables a single agent identity (e.g., "Jane") to operate seamlessly across multiple devices (VPS, Mac, Laptop). It synchronizes tasks, messages, and context in real-time using CRDTs (Yjs) over a secure mesh network (Tailscale).

## Architecture

- **Backbone Nodes (VPS):** Always-on servers that host the coordination mesh.
- **Edge Nodes (Mac/PC):** Client devices that connect to the backbone to sync state.
- **Transport:** Tailscale (WireGuard) for secure, zero-config peer-to-peer networking.

---

## Prerequisites

1.  **OpenClaw:** Installed on all nodes (`npm install -g openclaw`).
2.  **Tailscale:** Installed and running on all nodes.
    *   **Install:** [https://tailscale.com/download](https://tailscale.com/download)
    *   **MagicDNS:** Enable MagicDNS in your Tailscale admin console. This allows you to use hostnames like `jane-vps` instead of IPs.
    *   **Verify:** Run `tailscale ping <hostname>` from each node to ensure connectivity.

---

## Installation

### 1. Install Plugin

On every node (VPS and Mac):

```bash
openclaw plugins install likesjx/openclaw-plugin-ansible
```

*(Or link locally for development: `openclaw plugins install /path/to/repo --link`)*

### 2. Configuration

Add the `ansible` entry to your `~/.openclaw/openclaw.json` configuration file.

#### Backbone Node (VPS / Docker)

**Note:** When running in Docker, you must expose the port and bind to `0.0.0.0`.

```json
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "entries": {
      "ansible": {
        "enabled": true,
        "config": {
          "tier": "backbone",
          "listenPort": 1235,
          "listenHost": "0.0.0.0", // Required for Docker
          "capabilities": ["always-on"]
        }
      }
    }
  }
}
```

**Docker Compose Setup:**
Ensure the port is mapped securely to your Tailscale interface IP (recommended) or Public IP (with firewall rules).

```yaml
# docker-compose.yml
services:
  jane:
    # ...
    ports:
      # Bind 1235 only to Tailscale IP (100.x.y.z) for security
      - "100.x.y.z:1235:1235"
```

#### Edge Node (Mac / Laptop)

Connect to the backbone using its **Tailscale Hostname**.

```json
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "entries": {
      "ansible": {
        "enabled": true,
        "config": {
          "tier": "edge",
          "backbonePeers": [
            "ws://jane-vps:1235" // Use MagicDNS hostname!
          ],
          "capabilities": ["local-files", "voice"]
        }
      }
    }
  }
}
```

### 3. Bootstrap Network

1.  **Start Backbone:** Restart OpenClaw on the VPS.
2.  **Initialize:** Run this command *on the Backbone node*:
    ```bash
    openclaw ansible bootstrap
    ```
    *Output: "Successfully bootstrapped as first node"*

3.  **Invite Edge Node:** Run this on the Backbone:
    ```bash
    openclaw ansible invite --tier edge
    ```
    *Output: Token: `a1b2c3...`*

4.  **Join Edge Node:** Run this *on the Edge node*:
    ```bash
    openclaw ansible join --token a1b2c3...
    ```

---

## Agent Tools

The agent can use these tools to coordinate with itself:

| Tool | Description |
|---|---|
| `ansible.status` | Check who is online and what tasks are pending. |
| `ansible.delegate_task` | Send work to another node (e.g., "Run this heavy script on vps-jane"). |
| `ansible.claim_task` | Pick up a task assigned to you. |
| `ansible.send_message` | Broadcast a thought or update to other nodes. |
| `ansible.update_context` | Update your "current focus" visible to other nodes. |

## CLI Commands

Manage the mesh directly from the terminal:

```bash
openclaw ansible status              # Show network health
openclaw ansible nodes               # List all authorized bodies
openclaw ansible tasks               # View shared task list
openclaw ansible send --message "hi" # Broadcast manual message
```

---

## Troubleshooting

- **Connection Refused:**
    - Check if the Backbone is running: `openclaw ansible status`.
    - Check Firewall (VPS): `sudo ufw allow 1235/tcp` (or allow on Tailscale interface).
    - Check Docker Binding: Ensure `listenHost: "0.0.0.0"` is set in config.

- **Tailscale Issues:**
    - If `ws://jane-vps:1235` fails, try `ws://<tailscale-ip>:1235`.
    - Run `tailscale ping <hostname>` to verify the tunnel.

- **"Ansible not initialized"**:
    - The background sync service must be running. Ensure `openclaw gateway` is active.
    - CLI commands might report this if the Gateway isn't running or synced yet.

## License

MIT