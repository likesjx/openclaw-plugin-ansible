# MVP-1 Exit Gates Evidence (2026-03-02)

## Scope

Evidence run to close MVP-1 remaining exit criteria:

1. `#2` No uncontrolled escalation fanout under synthetic stress.
2. `#3` Rollback runbook tested once in staging.

## #2 Industrial Stress Evidence

Harness:

- `scripts/integration-mvp1-industrial.mjs`
- `scripts/integration-mvp1-industrial-suite.mjs`

Artifacts:

1. `docs/evidence/mvp1/20260302-122707-safe.json` (expected pass)
2. `docs/evidence/mvp1/20260302-122707-storm.json` (expected controlled fail)
3. `docs/evidence/mvp1/20260302-122707-live.json` (live read-only)

Observed outcomes:

1. Safe fixture: `pass=true`, `breaches=3`, bounded messages respected.
2. Storm fixture: controlled fail on routing hygiene (`unknown_assignees_exceeded`), with budget cap active:
   - `messages_unbounded=20`
   - `messages_bounded=6`
   - `messages_prevented_by_budget=14`
3. Live read-only check: `pass=true`, `unknownAssignees=[]`, `breaches=0`.

Conclusion:

- Anti-storm budget and fanout controls validated for synthetic stress behavior.
- Live environment check passed strict unknown-assignee guard after `aria` registration normalization.

## #3 Staging Rollback Drill Evidence

Drill capability:

- `cap.rollback.drill.20260302`

Execution sequence (staging mesh):

1. Publish `v1.0.0` (success; `publishPipeline` passed).
2. Publish `v1.1.0` (success; `publishPipeline` passed).
3. Roll back by publishing `v1.0.0` again (success; `publishPipeline` passed).
4. Unpublish cleanup (success; `unpublishPipeline=U1..U4` passed).
5. Final capability listing confirms `cap.rollback.drill.20260302` is `[disabled]`.

Notes:

1. Initial rollback logging attempt used an older shell CLI context (`unknown command 'ansible'`); rerun in correct OpenClaw CLI context succeeded.
2. A transient list read briefly showed stale status before subsequent list settled to `[disabled]`.

Conclusion:

- Staging rollback drill executed successfully with explicit rollback and cleanup.

## Gate Decision

1. MVP-1 `#2`: **PASS**
2. MVP-1 `#3`: **PASS**
