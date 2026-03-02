# Ansible Completion Checklist v1 (MVP Deployment Cycles)

Status: Working checklist  
Last updated: 2026-03-02

## Purpose

Track delivery by deployable MVP cycles, not by one giant finish line.

## MVP-0: Safe Canary (current target)

Goal:

- prove lifecycle stability without escalation storms.

Must-have:

- [x] Manifest validation + persistent manifest/revision maps.
- [x] Publish pipeline skeleton (`G0..G9`) with gate result reporting.
- [x] Update safety via predecessor snapshot + rollback restore.
- [x] Unpublish pipeline skeleton (`U0..U4`) with gate reporting.
- [x] Task idempotency keys (claim/update/complete).
- [x] SLA sweep engine (manual + coordinator service).
- [x] Anti-storm controls (`recordOnly`, message budget, FYI fallback).
- [x] Ownership failover at routing time (pulse-based stale detection + standby owner fallback).

Canary exit criteria:

- [x] 24h soak on one coordinator backbone with no message storm.
- [x] `publishPipeline` and `unpublishPipeline` show expected gate progression.
- [x] At least one full task lifecycle verified with idempotency replay.
- [x] SLA sweep outcomes recorded with clear reason fields.

## MVP-1: Controlled Production

Goal:

- safe broad rollout with enforceable risk controls.

Must-have:

- [x] High-risk approval gate enforcement before execution.
- [x] Concurrency/backpressure limits (`maxConcurrent`, queue depth, retry budget).
- [x] Failure taxonomy normalization (`failed_terminal`, `dependency_missing`, etc.).
- [x] Publish/update smoke test harness for contract lifecycle.
- [ ] Basic observability APIs:
  - [x] task lifecycle timeline query
  - [x] capability health summary (`success`, `p95 accept`, `p95 complete`)

Production exit criteria:

- [x] Two-node and multi-node validation runs green.
- [x] No uncontrolled escalation fanout under synthetic stress.
- [x] Rollback runbook tested once in staging.

## MVP-2: Skill Lifecycle Automation

Goal:

- move from contract skeleton to fully managed skill pair lifecycle.

Must-have:

- [ ] `ansible-main` installer/wirer for delegation skills.
- [ ] `ansible-main` installer/wirer for executor skills.
- [ ] Detach/unwire logic for unpublish + rollback.
- [ ] Canary rollout controller + soak evaluator.
- [ ] Automated remediation hooks on SLA/error misfire.

Exit criteria:

- [ ] Publish/update/unpublish runs end-to-end without manual workspace wiring.
- [ ] Skill pair rollback is deterministic and auditable.

## MVP-3: Governance + Clawhub Readiness

Goal:

- publication-ready security and provenance posture.

Must-have:

- [ ] Signature verification trust path + key store integration.
- [ ] Approval artifact recording for high-risk capabilities.
- [ ] Secret scanning/redaction checks in publish path.
- [ ] Signed provenance checks in CI.
- [ ] Clawhub package docs/metadata finalized.

Exit criteria:

- [ ] Clawhub publish checklist fully complete.
- [ ] Security review sign-off.

## Test Matrix (cross-cutting)

- [ ] Unit tests: manifest validation + gate failures.
- [ ] Integration tests: publish success + rollback.
- [ ] Integration tests: claim/update/complete contract + idempotency.
- [ ] Multi-node tests: failover and ownership transfer.
- [ ] Chaos tests: partial rollout, reconnect replay safety.

## Commit / Push / Deploy Gate

Local readiness:

- [x] `npm run typecheck`
- [x] `npm run build`
- [ ] tests green (when test suite is present)
- [x] docs updated

Git hygiene:

- [ ] verify `git status` only expected files
- [ ] verify no secrets/tokens in diff
- [ ] scoped commit messages

Release:

- [ ] push branch
- [ ] open PR with risk + rollback notes
- [ ] review signoff on schema/auth/runtime changes

Deploy:

- [x] run canary flow in [deployment-runbook-v1.md](deployment-runbook-v1.md)
- [x] record outcome and decision (promote/hold/rollback)

Notes:

- 2026-03-01: canary rerun passed (gateway health OK, SLA dry-run/record-only clean, capability publish/unpublish canary verified).
- 2026-03-01 decision: **promote** current rollout baseline; keep MVP-1/2/3 items in progress.
- 2026-03-01: publish/unpublish lifecycle advanced from no-op to concrete workspace state transitions (`G4_INSTALL_STAGE`, `G5_WIRE_STAGE`, `U2_UNWIRE`) using `capabilitiesInstallStages` and `capabilitiesWiring` maps.
- 2026-03-02: high-risk approval gate enforced before `in_progress`/`completed` transitions; added `ansible_approve_task` with approval artifact recording and audit event emission.
- 2026-03-02: normalized failure taxonomy added in task metadata (`ansible.failure`) with CLI/tool support (`failure_class`, `failure_code`, `terminal`, `retryable`); distribution cleanup failures now emit typed classes/codes.
- 2026-03-02: backpressure policy added with runtime enforcement (`maxConcurrent`, `maxQueueDepth`, `retryBudget`) across delegate/claim/update paths; admin setter `ansible_set_backpressure_policy` + `openclaw ansible admin backpressure ...`.
- 2026-03-02: added mutating capability lifecycle smoke harness (`scripts/integration-capability-lifecycle-smoke.mjs`) and npm entrypoint `test:integration:capability-lifecycle` validating publish/update/unpublish gate progression.
- 2026-03-02: observability APIs added: `ansible_task_timeline` + `ansible_capability_health_summary` with CLI commands `openclaw ansible tasks timeline` and `openclaw ansible capability health`.
- 2026-03-02: MVP-1 exit criterion #1 closed: canonical three-node mesh validated (`mac-jane`, `mbp-jane`, `vps-jane`) with 6-path transport matrix evidence under `conversation_id=mvp1-matrix-1772467165`. MBP identity drift (`nodeIdOverride=comms`) corrected to `mbp-jane` before validation.
- 2026-03-02: opened WI `WI-20260302-mvp1-industrial-testing` with executable stress harness (`scripts/integration-mvp1-industrial.mjs` + suite) and deterministic fixtures to close MVP-1 #2 with auditable evidence.
- 2026-03-02: MVP-1 #2/#3 evidence captured in `docs/evidence/mvp1/20260302-mvp1-exit-gates.md` with industrial stress artifacts (`20260302-122707-safe/storm/live.json`) and staging rollback drill (`cap.rollback.drill.20260302`: publish v1 -> v2 -> rollback to v1 -> unpublish).
