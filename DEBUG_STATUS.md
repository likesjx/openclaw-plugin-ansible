# Ansible Plugin Debug Status

## Current Issue
Two-node Yjs sync fails with "Invalid typed array length: 1022146939"

## VPS Commands Needed
Run these on VPS (jane-vps) to update the plugin:
```bash
cd ~/.openclaw/plugins/ansible
git pull origin main
npm install
npm run build

# Clear any corrupted state
rm -f ~/.openclaw/state/ansible*.yjs 2>/dev/null
find ~/.openclaw -name "ansible-state.yjs" -delete 2>/dev/null

# Check versions match Mac
npm ls y-websocket yjs

# Restart gateway
pkill -f "openclaw gateway" || true
openclaw gateway start
```

## Environment
- **Mac (edge)**: y-websocket 2.1.0, yjs 13.6.29
- **VPS (backbone)**: Unknown versions (need to verify)
- **Connection**: Establishes successfully, fails during sync handshake

## Root Cause Hypothesis
Binary protocol mismatch between `setupWSConnection` (server) and `WebsocketProvider` (client). The huge number suggests bytes are being misinterpreted.

## Changes Made
1. ✅ Fixed initialization order - edge now loads persisted state BEFORE connecting
2. ✅ Added debug logging for doc updates and connection events
3. ✅ Generated package-lock.json for version consistency
4. ✅ Enhanced logging across service, tools, and hooks for better observability
5. ✅ Refactored persistence to use service logger
6. ✅ Updated plugin code on VPS (`/home/deploy/code/openclaw-plugin-ansible`)
7. ✅ Updated VPS `docker-compose.yml` to mount plugin directory into container
8. ✅ Recreated VPS Docker container to apply volume mount
9. ✅ Cleaned up invalid OpenClaw configuration using `jq` on host
10. ✅ Manually created plugin symlink and injected valid config to bypass CLI validation loop
11. ✅ Restarted VPS gateway - **Ansible Plugin is Running!**
12. ✅ Opened VPS firewall port `1235`.
13. ✅ Updated Mac config to use VPS Public IP.
14. ✅ **Verified Sync!** Mac logs show "Successfully synced with ws://31.97.130.98:1235".

## Current Step
**Verifying State Sync**

Sync is working at the protocol level.
**CLI Issue:** `openclaw ansible status` reports "not initialized" because the CLI process doesn't start the background sync service.
**Next Step:** Test via the running agent (which HAS the active sync service).

## Next Steps
- [x] Run local test with setupWSConnection + WebsocketProvider ✅ PASSED
- [x] Commit and push fixes to GitHub ✅ (commit f1f39ac)
- [x] Update plugin code on VPS ✅
- [x] Mount plugin to VPS container ✅
- [x] Fix VPS OpenClaw configuration & install plugin ✅
- [x] Restart VPS gateway & verify logs ✅
- [x] Test sync from Mac ✅ (Protocol verified)
- [ ] **Verify data sync via Agent**
    - [ ] Run `openclaw agent --message "ansible status"`
    - [ ] Verify both nodes are visible
- [ ] Fix CLI command initialization (ensure it can read doc state)
- [ ] Fix Tailscale connectivity (long term)

## Key Code Locations
- `src/service.ts:291-327` - connectToPeer() with WebsocketProvider
- `src/service.ts:212-247` - startBackboneMode() with setupWSConnection
- `node_modules/y-websocket/bin/utils.cjs` - server protocol
- `node_modules/y-websocket/src/y-websocket.js` - client protocol

---
Last updated: VPS gateway running! Ansible listening on port 1235. Testing from Mac...
