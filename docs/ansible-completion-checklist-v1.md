# Ansible Completion Checklist v1 (MVP Deployment Cycles)

Status: Working checklist  
Last updated: 2026-02-27

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

- [ ] 24h soak on one coordinator backbone with no message storm.
- [x] `publishPipeline` and `unpublishPipeline` show expected gate progression.
- [x] At least one full task lifecycle verified with idempotency replay.
- [x] SLA sweep outcomes recorded with clear reason fields.

## MVP-1: Controlled Production

Goal:

- safe broad rollout with enforceable risk controls.

Must-have:

- [ ] High-risk approval gate enforcement before execution.
- [ ] Concurrency/backpressure limits (`maxConcurrent`, queue depth, retry budget).
- [ ] Failure taxonomy normalization (`failed_terminal`, `dependency_missing`, etc.).
- [ ] Publish/update smoke test harness for contract lifecycle.
- [ ] Basic observability APIs:
  - [ ] task lifecycle timeline query
  - [ ] capability health summary (`success`, `p95 accept`, `p95 complete`)

Production exit criteria:

- [ ] Two-node and multi-node validation runs green.
- [ ] No uncontrolled escalation fanout under synthetic stress.
- [ ] Rollback runbook tested once in staging.

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

- [ ] run canary flow in [deployment-runbook-v1.md](deployment-runbook-v1.md)
- [ ] record outcome and decision (promote/hold/rollback)
