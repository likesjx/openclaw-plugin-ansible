# Ansible End-to-End Deployment Test Plan v1

Status: Active  
Last updated: 2026-02-28

## Purpose

Define a standard, repeatable E2E test flow for Ansible deployment changes across gateways before and after rollout.

## Scope

Covers:

1. Code/build/deploy sync on all gateways.
2. Mesh liveness and node identity correctness.
3. Message transport across all gateway pairs.
4. Task lifecycle behavior (claim/update/complete + idempotency replay).
5. Capability publish/unpublish pipeline behavior.
6. SLA sweep behavior in safe mode.

Does not cover:

1. Provider/model quality evaluation.
2. Product feature acceptance outside Ansible transport/runtime.

## Canonical Node Set

Expected production node IDs:

1. `mac-jane`
2. `mbp-jane`
3. `vps-jane`

## Preconditions

1. Local source repo clean and pushed (`main` or approved release branch).
2. Each gateway plugin source is known and reachable.
3. Gateway auth token present in each gateway config.
4. No destructive maintenance window conflicts.

## Phase 0: Pre-Deploy Baseline

Run and record:

```bash
openclaw gateway health
openclaw ansible status
openclaw ansible nodes
openclaw ansible sla sweep --dry-run --limit 200
```

Pass criteria:

1. Gateways reachable.
2. Node set is expected (or deviations are documented).
3. No unexpected SLA breach spikes.

## Phase 1: Build + Deploy Sync

For each gateway source checkout:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
npm run build
```

Restart gateways:

```bash
openclaw gateway restart
```

Pass criteria:

1. All deploy targets built successfully.
2. Gateway restart successful (allow brief warm-up retries).
3. `openclaw plugins info ansible` shows expected tools/services.

## Phase 2: Mesh Identity Validation

Verify node IDs:

```bash
openclaw ansible nodes
```

Pass criteria:

1. Only canonical node IDs appear.
2. Any decommissioned/legacy node IDs are revoked.

## Phase 3: Transport Matrix (All Pairs)

Run directed message tests for all 6 paths:

1. `mac-jane -> mbp-jane`
2. `mac-jane -> vps-jane`
3. `mbp-jane -> mac-jane`
4. `mbp-jane -> vps-jane`
5. `vps-jane -> mac-jane`
6. `vps-jane -> mbp-jane`

Recommended payload format:

`mesh3 <src>-><dst> t<unix_ts>`

Verify with:

```bash
openclaw ansible messages
openclaw ansible messages-dump --from <src> --to <dst> -n 10
```

Pass criteria:

1. All 6 sends return success.
2. Recipient has evidence of receipt (`readBy_agents` and/or `delivery` metadata).
3. No route is silently dropped.

## Phase 4: Task Lifecycle + Idempotency

On a canary task only:

1. Claim task.
2. Replay same claim idempotency key.
3. Update task.
4. Replay same update key.
5. Complete task.
6. Replay same complete key.

Pass criteria:

1. First transition mutates state.
2. Replay is accepted as idempotent (no duplicate mutation).
3. No invalid state transition errors for valid sequence.

## Phase 5: Capability Lifecycle

Publish canary capability and then unpublish:

```bash
openclaw ansible capability publish ...
openclaw ansible capability unpublish --id <capabilityId> ...
```

Pass criteria:

1. `publishPipeline` gate progression visible.
2. `unpublishPipeline` gate progression visible.
3. Capability ends disabled/unpublished as intended.

## Phase 6: SLA Sweep Safety

Run:

```bash
openclaw ansible sla sweep --dry-run --limit 200
openclaw ansible sla sweep --record-only --limit 200
```

Pass criteria:

1. Command succeeds.
2. No escalation storm/fanout anomaly.
3. Breach outcomes (if any) include reason metadata.

## Phase 7: Post-Deploy Stability Check

Observe for a short window (15-30 min) or full soak as required.

Record:

1. Node online/offline transitions.
2. Message send/receive reliability.
3. Unexpected task churn.

Known quirk:

`ansible status` may briefly mark a node offline while message transport still succeeds. Track under `DEF-004` and validate transport before incident declaration.

## Exit Gates (Release Ready)

Deployment is release-ready when all are true:

1. Build/deploy succeeded on all target gateways.
2. Node identity is canonical and clean.
3. 6/6 transport matrix passes.
4. Task lifecycle + idempotency passes.
5. Capability publish/unpublish canary passes.
6. SLA sweep safe-mode checks pass.

## Failure Handling

If a gate fails:

1. Stop rollout progression.
2. Capture command output and timestamps.
3. Revert gateway(s) to last known good plugin build.
4. Re-run baseline (Phase 0) before retry.

## Evidence Template

For each deployment run, record:

1. commit SHA deployed
2. gateways updated
3. test start/end timestamps
4. pass/fail per phase
5. defects/quirks observed
6. promote/hold/rollback decision

