# Ansible Plugin Status

## Architecture (as understood)

```
Mac (edge)                          VPS (backbone)
┌──────────────────┐                ┌─────────────────────────────────┐
│ openclaw-tui     │                │ Docker: jane-gateway            │
│ + LaunchAgent GW │                │   openclaw-gateway (port 18789) │
│   (port 18789)   │                │   ansible plugin (port 1235)    │
│ ansible plugin   │──ws://jane-vps:1235──▶│   telegram channel           │
│   (edge mode)    │                │   = "vps-jane"                  │
└──────────────────┘                └─────────────────────────────────┘
      "mac-jane"                    Docker volumes:
                                      ./data -> /home/node/.openclaw
                                      ./workspace -> /home/node/.openclaw/workspace
                                      plugin -> /home/node/code/openclaw-plugin-ansible
```

## Current State: PARTIALLY WORKING

| Component | Status | Notes |
|-----------|--------|-------|
| Mac gateway | RUNNING | LaunchAgent on port 18789 |
| VPS Docker container | RUNNING | `984be14cb661_jane-gateway`, up since ~04:46 UTC |
| vps-jane agent | ALIVE | Processing Telegram messages (Gemini Flash) |
| Ansible sync (Mac→VPS) | BROKEN | Mac sends to ws://jane-vps:1235 but plugin inside Docker binds to 127.0.0.1 |
| Tailscale | WORKING | Both nodes online, MagicDNS resolves |

## ROOT CAUSE: Ansible sync broken inside Docker

The ansible plugin's backbone WebSocket server binds to `127.0.0.1:1235` inside the container:
```
Backbone mode: starting WebSocket server on 127.0.0.1:1235
```

This happens because `getTailscaleIP()` fails inside Docker (no tailscale binary), falling back to `127.0.0.1`. Docker's port forwarding sends traffic to the container's network interface (172.x.x.x), which can't reach 127.0.0.1.

**Mac state: 725 bytes** (stale from when standalone gateway was running)
**Container state: 110 bytes** (no external connections received)

### Fix Required (2 changes)

1. **Container ansible config** (`~/apps/jane/data/openclaw.json` on host, needs sudo):
   Add `listenHost: "0.0.0.0"` to ansible plugin config. Safe inside Docker since Docker networking handles isolation.
   ```json
   "ansible": {
     "enabled": true,
     "config": {
       "tier": "backbone",
       "listenPort": 1235,
       "listenHost": "0.0.0.0",
       "capabilities": ["always-on"]
     }
   }
   ```

2. **docker-compose.yml** (`~/apps/jane/docker-compose.yml`):
   Change `"1235:1235"` to `"100.64.212.8:1235:1235"` so port 1235 is only exposed on Tailscale, not public internet.
   ```yaml
   ports:
     - "100.64.212.8:18789:18789"
     - "127.0.0.1:9090:9090"
     - "100.64.212.8:1235:1235"  # was "1235:1235" (exposed to 0.0.0.0!)
   ```

   Then: `cd ~/apps/jane && docker compose up -d` to recreate container.

---

## What mac-jane did (incident at ~04:33-04:41 UTC)

Mac-jane investigated why vps-jane was silent. She:
1. Found `jane-gateway` Docker container in "Created" state
2. Found standalone `openclaw-gateway` (PID 3226623) on port 1235
3. Tried `docker compose up -d` - port conflict with standalone gateway
4. **Killed standalone gateway** (`sudo kill 3226623`)
5. Docker container auto-restarted (`restart: unless-stopped`)
6. Container came up, but ansible plugin binds to 127.0.0.1 (see root cause above)

Standalone gateway I started on port 18789 (as `deploy` user) appears to have been superseded by Docker taking port 18789.

---

## SECURITY: Port 1235 publicly exposed AGAIN

Docker maps `1235:1235` to `0.0.0.0` on the host, bypassing UFW via iptables:
```
docker-pr  root  TCP *:1235 (LISTEN)
```
Fix: change docker-compose to `"100.64.212.8:1235:1235"`.

---

## SECURITY AUDIT - Code Fixes (all applied)

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1-4 | CRITICAL | Auth, binding, CRDT writes, command injection | ALL FIXED |
| 5-8 | HIGH | Validation, path traversal, deserialization, ws CVE | ALL FIXED |
| 9 | MEDIUM | Log info disclosure | OPEN |

Commit: `5981cdf - security: harden WebSocket, auth, validation, and dependencies`

---

## TODO

### P0 - Fix ansible sync in Docker
- [ ] Add `listenHost: "0.0.0.0"` to container's ansible config (needs sudo on `~/apps/jane/data/openclaw.json`)
- [ ] Fix docker-compose port: `"1235:1235"` → `"100.64.212.8:1235:1235"`
- [ ] Recreate container: `cd ~/apps/jane && docker compose up -d`
- [ ] Verify Mac can connect and sync (check for "incoming connection" in container logs)

### P1 - Operational
- [ ] Kill any leftover standalone openclaw-gateway on host (check `ps aux | grep openclaw | grep deploy`)
- [ ] Clean up host's `/home/deploy/.openclaw/openclaw.json` (misleading, not used by vps-jane)
- [ ] Sanitize production logs (security finding #9)

### P2 - Hardening
- [ ] Consider disabling Tailscale key expiry for VPS
- [ ] VPS container gateway token should not be logged/exposed

---
**Status Update (05:25 UTC):** VPS is undergoing a hard reboot to clear extreme load (150+) and memory exhaustion.

**After Reboot Checklist:**
1. Verify `jane-gateway` container is running: `ssh deploy@vps-jane "docker ps"`
2. Verify Ansible is listening on port 1235: `ssh deploy@vps-jane "sudo lsof -i :1235"`
3. Check Mac sync status: `grep "Successfully synced" /tmp/openclaw/openclaw-*.log`

---
Last updated: 2026-02-04 05:25 UTC
