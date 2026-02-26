# Ansible Completion Checklist v1

Status: Working checklist  
Last updated: 2026-02-26

## Purpose

Track remaining work to complete the ansible tool and safely commit/push/deploy.

## A) Core Implementation Remaining

- [x] Add runtime validator for `SkillPairManifest` schema in plugin code.
- [x] Add persistent manifest maps:
  - [x] `capabilities.manifests`
  - [x] `capabilities.revisions`
- [x] Implement publish gate executor (`G0..G9`) in code. (skeleton with ordered gates, per-gate results, and rollback hook signals)
- [x] Implement update pipeline with predecessor rollback safety. (publish-as-update with predecessor snapshot + postcheck rollback restore)
- [x] Implement unpublish pipeline (`U0..U4`) in code. (gate-recorded pipeline with disable/archive/emit + unwire placeholder)
- [ ] Implement ownership lease + standby failover.
- [x] Implement compatibility negotiation at task accept. (single-capability path, manifest-mode aware)
- [x] Add deterministic rollback event emission + audit payload. (gate-fail + rollback-required lifecycle events)

## B) Runtime Semantics Remaining

- [x] Enforce idempotency keys for accept/update/complete transitions.
- [x] Add SLA timeout engine (`accept/progress/complete`) with escalation events. (via `ansible_sla_sweep`; background scheduler still optional)
- [ ] Add high-risk approval gate enforcement before execution.
- [ ] Add concurrency limits (`maxConcurrent`, `maxQueueDepth`, `retryBudget`).
- [ ] Add failure taxonomy normalization (`failed_terminal`, `dependency_missing`, etc.).

## C) Skill Lifecycle Automation Remaining

- [ ] Add `ansible-main` workspace installer/wirer for delegation skills.
- [ ] Add `ansible-main` workspace installer/wirer for executor skills.
- [ ] Add detach/unwire logic for unpublish/update rollback.
- [ ] Add smoke test harness that runs full task lifecycle against manifest contract.
- [ ] Add canary rollout controller and soak evaluation.

## D) Observability and Ops Remaining

- [ ] Add lifecycle timeline query tool/API (single task, full chain).
- [ ] Add capability health metrics (`success rate`, `p95 accept`, `p95 complete`).
- [ ] Add dead-letter inspection and replay helper.
- [ ] Add publish/update/unpublish audit stream export.

## E) Security and Governance Remaining

- [ ] Add manifest signature verification path and key trust store.
- [ ] Add secret scanning/redaction in publish path.
- [ ] Add approval artifact recording for high-risk capabilities.
- [ ] Add signed provenance checks in CI.

## F) Tests Remaining

- [ ] Unit tests for manifest validation and gate failures.
- [ ] Integration tests for publish success + rollback.
- [ ] Integration tests for claim/update/complete contract enforcement.
- [ ] Multi-node tests for failover and ownership transfer.
- [ ] Chaos tests for partial rollout and reconnect replay safety.

## G) Commit / Push / Deploy Checklist

## Local readiness

- [ ] `npm run typecheck`
- [ ] `npm test` (or project test suite) green
- [ ] docs updated for any protocol change
- [ ] changelog/release note entry prepared

## Git hygiene

- [ ] review `git status` for intended files only
- [ ] review `git diff` for secrets/tokens/hostnames
- [ ] commit with scoped message(s)

## Push and release

- [ ] push branch
- [ ] open PR with risk + rollback notes
- [ ] require review signoff on:
  - [ ] schema changes
  - [ ] auth or runtime lifecycle changes
  - [ ] migration/compatibility behavior

## Deploy

- [ ] deploy to canary gateway first
- [ ] run publish smoke tests
- [ ] monitor SLA/error metrics for soak window
- [ ] promote to full rollout
- [ ] record deployment outcome in ops notes
