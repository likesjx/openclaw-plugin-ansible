# MVP-1 Industrial Stress & Rollback Readiness Test Plan v1

Status: Active  
Last updated: 2026-03-02  
Work Item: `WI-20260302-mvp1-industrial-testing`

## Purpose

Provide a repeatable, auditable test program for MVP-1 exit criteria with special focus on escalation fanout safety under stress.

## Test Targets

1. Fanout safety controls: message budget capping and anti-storm posture.
2. Routing hygiene: no escalations routed to unknown/ghost assignees.
3. Deterministic reproducibility via snapshot fixtures.
4. Live environment analysis using current gateway state without mutation.

## Artifacts

1. Harness: `scripts/integration-mvp1-industrial.mjs`
2. Safe fixture: `scripts/testdata/mvp1-industrial/safe-snapshot.json`
3. Storm fixture: `scripts/testdata/mvp1-industrial/storm-snapshot.json`
4. Optional status fixtures for known-agent checks.

## Modes

1. `snapshot`: deterministic from fixture files.
2. `live`: reads current gateway dumps (`tasks-dump`, `status`) and evaluates projected fanout risk.

## Phase A: Deterministic Snapshot Regression

### A1. Safe scenario (must pass)

```bash
node scripts/integration-mvp1-industrial.mjs \
  --mode snapshot \
  --tasks-dump scripts/testdata/mvp1-industrial/safe-snapshot.json \
  --status-dump scripts/testdata/mvp1-industrial/safe-status.json \
  --now-ms 1700001000000 \
  --max-messages 3 \
  --fyi architect
```

Expected:

1. `pass=true`
2. `breaches >= 1`
3. `messages_bounded <= max_messages_per_sweep * (1 + fyi_agents)`
4. `known_agent_gaps=0`

### A2. Storm scenario (expected to fail for unknown assignee hygiene)

```bash
node scripts/integration-mvp1-industrial.mjs \
  --mode snapshot \
  --tasks-dump scripts/testdata/mvp1-industrial/storm-snapshot.json \
  --status-dump scripts/testdata/mvp1-industrial/storm-status.json \
  --now-ms 1700001000000 \
  --max-messages 3 \
  --fyi architect
```

Expected:

1. non-zero exit code
2. fail reason includes `unknown_assignees_exceeded`
3. output demonstrates bounded fanout despite high unbounded potential

## Phase B: Live Read-Only Risk Analysis

```bash
node scripts/integration-mvp1-industrial.mjs --mode live --max-messages 3 --fyi architect
```

Expected:

1. Command succeeds and emits structured summary.
2. Any fail result is treated as a release blocker signal, not auto-remediated by the harness.

## Phase C: Evidence Capture

Capture these artifacts per run:

1. Harness stdout for A1/A2/B.
2. Timestamp + commit SHA.
3. Decision: pass/hold/fix.
4. Follow-up issue if fail reason exists.

## Pass/Fail Rules for MVP-1 #2

MVP-1 `#2` is considered complete when:

1. A1 passes.
2. A2 fails for the expected controlled reason and still shows bounded messaging.
3. Live mode on target environment passes with no unknown assignee gaps and adequate breach sample volume.

## Notes

1. This harness is intentionally non-mutating; it does not emit escalation messages.
2. For rollback execution (`#3`), use `docs/deployment-runbook-v1.md` staging drill and record separately.
