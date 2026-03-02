# MVP-2 Skill Lifecycle Automation Proposal & Plan

Status: in_progress  
Last updated: 2026-03-02
Related WI: `docs/work-items/WI-20260302-mvp2-lifecycle-automation-kickoff.md`

## Launch Theme

MVP-1 proved the mesh can route safely under pressure. MVP-2 is where we take the training wheels off operations: no more brittle manual wiring rituals, no more rollback guesswork, and no hidden tribal runbooks.

## Proposal Summary

Goal: make skill pair lifecycle fully automated so publish/update/unpublish/rollback execute end-to-end without manual workspace intervention.

Primary outcomes:

1. Existing delegation contracts keep working (compatibility-first).
2. Skill pair install/wire/unwire state transitions are deterministic and auditable.
3. Rollout decisions move from gut-feel to policy + evidence.

## Compatibility Contract (Critical)

1. Existing delegation contracts are valid by default.
2. No forced manual re-creation of existing delegations.
3. Any schema change must include read-compat and migration logic.
4. If migration cannot be automatic, publish gate must fail with explicit operator guidance.

## Scope

1. `ansible-main` installer/wirer for delegation skills.
2. `ansible-main` installer/wirer for executor skills.
3. Deterministic detach/unwire logic for unpublish + rollback.
4. Canary rollout controller + soak evaluator.
5. Automated remediation hooks on SLA/error misfire.

Out of scope for MVP-2:

1. Full governance/provenance hardening (MVP-3).
2. Clawhub publication packaging finalization (MVP-3).

## Architecture Decisions

1. Shared state remains control-plane only; payload traffic stays out of state room.
2. Lifecycle state machine is source of truth:
   - install stage
   - wire stage
   - verify stage
   - rollback/unwire stage
3. Rollback is version-targeted, not best-effort.
4. Rollout controller must obey backpressure policy and anti-storm caps.

## Execution Phases

### Phase A: Deterministic Lifecycle Core

1. Finalize installer + wirer for both delegation and executor skill paths.
2. Normalize stage metadata maps and audit event emission.
3. Guarantee idempotent replay for install/wire/unwire transitions.

Exit check:

1. Manual workspace intervention no longer required for baseline publish/update/unpublish.

### Phase B: Rollback and Unpublish Hardening

1. Implement deterministic unwind graph for rollbacks.
2. Ensure predecessor snapshot restore is exact, not heuristic.
3. Emit rollback evidence artifact with stage-by-stage outcomes.

Exit check:

1. Rollback returns system to exact prior eligible/wired state with audit trace.

### Phase C: Rollout Controller + Soak Evaluation

1. Add controlled fanout rollout stages and gates.
2. Add soak evaluator policy (promote/hold/rollback recommendation).
3. Produce machine-readable disposition summary for each rollout.

Exit check:

1. Rollout controller can gate progression with explicit go/no-go evidence.

### Phase D: Remediation Hooks

1. Bind SLA/error taxonomy to remediation trigger points.
2. Add bounded automated actions (retry/reassign/fyi/escalate).
3. Preserve anti-storm guarantees and message budgets.

Exit check:

1. Remediation executes within bounded policy and emits reasoned outcomes.

## Test & Evidence Plan

Evidence root:

1. `docs/evidence/mvp2/`

Required artifacts:

1. `*-lifecycle-core.json` (install/wire idempotency evidence)
2. `*-rollback-drill.json` (deterministic unwind evidence)
3. `*-rollout-soak.json` (controller decision evidence)
4. `*-remediation-bounds.json` (bounded automation evidence)
5. `*-mvp2-exit-gates.md` (final disposition)

## Success Gates

1. Publish/update/unpublish run end-to-end without manual workspace wiring.
2. Skill pair rollback is deterministic and auditable.
3. Existing delegations continue working without forced manual recreation.
4. Rollout controller emits promote/hold/rollback decisions based on evidence.
5. Remediation hooks operate within anti-storm bounds.

## Risks & Mitigations

1. Risk: hidden manual assumptions break automation.
   - Mitigation: compatibility guard + fail-fast publish diagnostics.
2. Risk: rollback automation causes broad blast radius.
   - Mitigation: version-targeted unwind + strict scope boundaries.
3. Risk: rollout controller over-fans out distribution tasks.
   - Mitigation: enforce backpressure + per-stage concurrency caps.

## Immediate Next Slice

Slice 1 (start now): Lifecycle core implementation for installer/wirer idempotency with deterministic audit outputs.

Definition of done for Slice 1:

1. installer/wirer transitions are idempotent under replay.
2. both delegation + executor paths share consistent stage outcomes.
3. evidence artifact produced under `docs/evidence/mvp2/`.

## Disposition (current)

1. MVP-2 initiated.
2. Kickoff WI opened and proposal expanded.
3. Slice 1 implementation started (lifecycle core idempotency + evidence API/CLI).
4. First evidence artifact captured: `docs/evidence/mvp2/20260302-153035-lifecycle-core.json`.
5. Slice 2 implementation started (deterministic unwind evidence + rollback parity drill harness).
6. First Slice 2 evidence artifact captured: `docs/evidence/mvp2/20260302-160714-rollback-drill.json`.
