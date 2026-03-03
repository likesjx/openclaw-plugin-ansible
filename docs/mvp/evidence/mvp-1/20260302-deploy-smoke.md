# MVP-1 Deploy + Smoke Disposition (2026-03-02)

## Deployed Commit

- `fb0ea79` (`main`)

## Rollout Steps

1. Local (`mac-jane`): build + gateway restart.
2. VPS (`vps-jane`): plugin repo pulled to `fb0ea79`; container restarted.
3. MBP (`mbp-jane`): plugin repo at `~/.openclaw/extensions/ansible` pulled to `fb0ea79`; build + gateway restart.

## Notable Runtime Observation

- VPS container `npm run build` exits with code `137` during `tsc` (resource kill). Since compiled `dist/` is committed and pulled, rollout used pulled artifacts and successful gateway restart.

## Post-Deploy Smoke Checks

1. `vps-ansible-status-json` shows canonical nodes online: `mac-jane`, `mbp-jane`, `vps-jane`.
2. Conversation `mvp1-close-1772477060` transport checks:
   - `mac-jane -> vps-jane` delivered
   - `mac-jane -> mbp-jane` sent/observed
   - `mbp-jane -> mac-jane` delivered
   - `vps-jane -> mac-jane` observed in VPS dump
3. Dumps verified from mac/mbp/vps views (`messages-dump`).

## MVP-1 Disposition

- **Closed**: MVP-1 controlled production gates complete and deployed.
- Next execution focus: MVP-2 lifecycle automation backlog.
