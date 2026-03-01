# Deployment Runbook v1

Status: Active  
Last updated: 2026-02-27

## Goal

Safely deploy current Ansible lifecycle updates with low escalation risk and a clean rollback path.

## Default Safety Profile

Use these SLA settings for initial rollout:

1. `slaSweep.enabled=true`
2. `slaSweep.everySeconds=300`
3. `slaSweep.recordOnly=true`
4. `slaSweep.maxMessagesPerSweep=3`
5. `slaSweep.fyiAgents=["architect"]`

## Phase 0: Preflight (local)

Run:

```bash
npm run typecheck
npm run build
```

Expected:

1. typecheck passes
2. build succeeds

Note:

- This repo currently has no `npm test` script.

## Phase 1: Canary Deploy (single coordinator backbone)

1. Deploy plugin build to one backbone/coordinator node only.
2. Restart gateway/plugin on canary node.
3. Confirm service health:

```bash
openclaw gateway status
openclaw ansible status
```

4. Validate SLA sweep in dry run:

```bash
openclaw ansible sla sweep --dry-run --limit 100
```

5. Validate real sweep in safe mode:

```bash
openclaw ansible sla sweep --record-only --limit 100
```

Go/no-go:

1. no unexpected error bursts
2. no message storm
3. task metadata updates are stable

## Phase 2: Capability Lifecycle Validation

1. Publish one low-risk capability:

```bash
openclaw ansible capability publish ... 
```

2. Confirm publish output includes:
   - `publishPipeline`
   - expected gate progression
3. Run one delegated task lifecycle:
   - claim (with ETA)
   - update
   - complete
4. Verify idempotency replay behavior by repeating same idempotency key.

## Phase 3: Expand Rollout

1. Deploy to remaining backbones.
2. Deploy to edge nodes.
3. Keep `recordOnly=true` for one soak window.
4. If stable, enable notifications gradually:
   - keep `maxMessagesPerSweep` low
   - keep `fyiAgents` fallback

## Rollback Plan

Trigger rollback if any:

1. unexpected escalation volume
2. repeated publish/unpublish pipeline failures
3. task lifecycle corruption or duplicate transitions

Rollback actions:

1. revert plugin version to last known good build
2. keep `slaSweep.recordOnly=true`
3. set `slaSweep.maxMessagesPerSweep=0` if needed
4. run manual `sla sweep --dry-run` until stable

## Operator Commands (quick reference)

```bash
# manual SLA checks
openclaw ansible sla sweep --dry-run --limit 200
openclaw ansible sla sweep --record-only --limit 200

# capability lifecycle
openclaw ansible capability list
openclaw ansible capability publish ...
openclaw ansible capability unpublish --id <capabilityId>

# task lifecycle
openclaw ansible tasks claim <taskId> --eta-seconds 900 --idempotency-key <k>
openclaw ansible tasks update <taskId> --status in_progress --idempotency-key <k>
openclaw ansible tasks complete <taskId> --result "..." --idempotency-key <k>
```

## Latest Execution Notes (2026-02-27)

1. Preflight passed: `npm run typecheck`, `npm run build`.
2. SLA sweep checks passed in safe mode:
   - `openclaw ansible sla sweep --dry-run --limit 100`
   - `openclaw ansible sla sweep --record-only --limit 100`
3. Capability canary validated:
   - publish: `publishPipeline=G4..G9` progression visible
   - unpublish: `unpublishPipeline=U1..U4` progression visible
4. Task lifecycle + idempotency replay validated on canary task:
   - claim replay handled as idempotent
   - update replay handled as idempotent
   - complete replay handled as idempotent
5. Remaining MVP-0 exit blockers:
   - 24h soak window still pending
   - SLA breach-path reason field validation still pending (no breaches observed).

## Latest Execution Notes (2026-03-01)

1. Runtime canary health checks passed on `vps-jane`:
   - `openclaw gateway health` = OK
   - `openclaw ansible status` = stable (online mesh participants, no unread buildup)
2. SLA safety checks passed:
   - `openclaw ansible sla sweep --dry-run --limit 200` = `scanned=57, breaches=0`
   - `openclaw ansible sla sweep --record-only --limit 200` = `scanned=57, breaches=0`
3. Capability canary validation passed:
   - publish/unpublish succeeded with expected pipeline gate reporting
   - distribution fanout now emits per-target tasks (no shared-claim deadlock)
4. Task authorization hardening validated:
   - non-assignee claim attempts are rejected
5. Rollout decision:
   - **Promote** current MVP-0 rollout baseline
   - Continue MVP-1/2 backlog items without blocking deployment
