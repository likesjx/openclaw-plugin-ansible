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
6. 🔄 Need to rebuild and test

## Current Step
**Local test PASSED - protocol works correctly locally**

The y-websocket sync protocol works fine between setupWSConnection and WebsocketProvider on the same machine. This means the issue is likely:
1. Version mismatch on VPS
2. Corrupted persisted state on VPS
3. Network/encoding issue

## Next Steps
- [x] Run local test with setupWSConnection + WebsocketProvider ✅ PASSED
- [ ] Commit and push fixes to GitHub
- [ ] Run VPS commands above to update plugin
- [ ] Verify versions match: y-websocket 2.1.0, yjs 13.6.29
- [ ] Clear any corrupted state files
- [ ] Restart VPS gateway
- [ ] Test two-node sync from Mac

## Key Code Locations
- `src/service.ts:291-327` - connectToPeer() with WebsocketProvider
- `src/service.ts:212-247` - startBackboneMode() with setupWSConnection
- `node_modules/y-websocket/bin/utils.cjs` - server protocol
- `node_modules/y-websocket/src/y-websocket.js` - client protocol

---
Last updated: VPS gateway running! Ansible listening on port 1235. Testing from Mac...
