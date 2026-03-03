# WI-20260302: MVP-2 Lifecycle Automation Kickoff

Status: In Progress  
Owner: Codex  
Created: 2026-03-02

## Why

MVP-1 closed with routing and safety controls in production. The remaining operational drag is manual skill-pair lifecycle wiring and rollback choreography.

## Goal

Kick off MVP-2 so delegation/executor lifecycle becomes automated, deterministic, and backward-compatible with existing delegations.

## Objectives

1. Preserve current delegation contracts without forced manual rework.
2. Automate delegation/executor install + wire + verify across target agents.
3. Automate rollback/unpublish unwind with deterministic audit traces.
4. Introduce rollout controller + soak evaluator for promote/hold/rollback decisions.
5. Add remediation hooks for SLA/error misfires.

## Deliverables

1. MVP-2 proposal expanded to implementation-grade plan.
2. Implementation workstream slices for installer, wiring, unwind, rollout controller, and remediation.
3. MVP-2 evidence template and closure artifact path under `docs/mvp/evidence/mvp-2/`.

## Acceptance Criteria

1. MVP-2 proposal includes architecture, migration rules, phases, risks, and exit gates.
2. Existing delegation contracts are explicitly marked as compatible-by-default.
3. First execution slice is identified and ready to implement.

## Execution Checklist

- [x] Create kickoff WI.
- [x] Expand MVP-2 proposal document.
- [x] Start Slice 1 implementation (`installer/wirer` path).
- [x] Add MVP-2 evidence template file.
- [x] Record first slice decision and owner.

## Risks

1. Hidden assumptions in existing manual wiring could surface during automation.
2. Rollback automation can create broad blast radius if not strictly scoped.
3. Distribution backlogs can amplify if rollout controller does not gate concurrency.

## Decision Log

1. Compatibility is default: do not force manual re-creation of existing delegations.
2. Any schema evolution must include migration/read-compat handling.
3. MVP-2 starts with deterministic install/wire/unwire before advanced remediation policies.
4. Slice 1 owner: Codex. Scope: lifecycle core idempotency + evidence surface.
5. First Slice 1 evidence artifact: `docs/mvp/evidence/mvp-2/20260302-153035-lifecycle-core.json`.
6. Slice 2 started: rollback/unpublish unwind determinism + rollback parity drill.
7. First Slice 2 evidence artifact: `docs/mvp/evidence/mvp-2/20260302-160714-rollback-drill.json`.
