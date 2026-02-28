# MVP-0 Commit/Push/Deploy Handoff Checklist

Status: ready_for_operator

## Scope

Covers:

1. capability lifecycle canary validation
2. task idempotency replay behavior
3. SLA sweep anti-storm controls
4. MVP-0 soak kickoff

## Verified This Session

1. `publishPipeline` and `unpublishPipeline` gate progression visible in CLI.
2. Task lifecycle replay behavior validated:
   - claim replay handled idempotently
   - update replay handled idempotently
   - complete replay handled idempotently
3. SLA reason-field behavior validated in `runSlaSweep` harness:
   - `record_only`
   - `message_budget_exhausted`
   - `no_targets`
4. 24h soak started at `2026-02-27T07:02:32Z`:
   - see `docs/mvp0-soak-log-2026-02-27.md`

## Pre-Push Gate

1. `npm run typecheck`
2. `npm run build`
3. confirm no secrets/tokens in changed docs or code
4. verify canary capabilities are disabled (`cap.canary.m0/m1/m2/sla`)

## Suggested Commit Set

1. CLI reliability and visibility:
   - capability publish version flag (`--cap-version`)
   - pipeline gate output rendering
   - idempotent replay user feedback in task commands
2. Task claim idempotency handling:
   - replay-safe behavior when same agent replays explicit key
3. Docs:
   - checklist updates
   - runbook execution notes
   - soak log
   - this handoff checklist

## Push/PR Template

Title:

`MVP-0 hardening: pipeline visibility, claim replay safety, soak kickoff`

PR notes:

1. What changed:
   - CLI capability version flag conflict removed
   - pipeline progression surfaced in CLI
   - claim replay path hardened; idempotent UX improved
2. Validation:
   - canary capability publish/unpublish
   - task claim/update/complete replay
   - SLA sweep safe-mode + reason harness
3. Risk:
   - low to moderate (runtime task transition logic touched)
4. Rollback:
   - revert plugin build
   - keep `recordOnly=true`
   - set `maxMessagesPerSweep=0` if needed

## Deploy Steps

1. Push branch and open PR.
2. Land after review.
3. Keep soak running for full 24h window.
4. At T+24h, apply exit rules from `docs/mvp0-soak-log-2026-02-27.md`.

