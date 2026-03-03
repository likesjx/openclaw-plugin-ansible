# WI-20260303 MVP-3 Governance + Clawhub Kickoff

Status: in_progress  
Owner: Codex + Jared  
Created: 2026-03-03

## Objective

Begin MVP-3 execution on `main` and make Clawhub readiness measurable with repeatable quality gates.

## Scope (Slice A)

1. Move MVP-3 from `draft` to active execution tracking.
2. Add a release gate script for metadata/docs/secret checks and package artifact validation.
3. Normalize package metadata required for publication.
4. Define the immediate next slices for security/provenance hardening.

## Scope (Slice B)

1. Add CI governance gates for provenance and release readiness on `main` PR/push.
2. Add a provenance gate script that asserts runtime/doc/checklist provenance hooks stay intact.
3. Wire CI to run typecheck/build + release/provenance gates together.

## Delivered in this slice

1. `scripts/release-gate.mjs`:
   1. package + plugin metadata checks
   2. required docs bundle presence checks
   3. secret-literal scan on tracked sources/docs/scripts
   4. `npm pack --dry-run --json` artifact checks
2. `npm run test:release:gate` script in `package.json`.
3. package metadata set: author/repository/homepage/bugs.
4. MVP-3 status and checklists updated to reflect kickoff.

## Remaining MVP-3 work

1. Signature verification trust path + key store integration.
2. Signed provenance checks in CI and release process.
3. Publish-path redaction/secret policy enforcement coverage.
4. Clawhub docs bundle final curation and submit runbook.

## Slice B deliverables (started)

1. `.github/workflows/mvp3-governance-gates.yml`
2. `scripts/provenance-gate.mjs`
3. `npm run test:provenance:gate`

## Slice C deliverables (started)

1. Runtime signature verification for `G2_PROVENANCE`:
   1. supports `ed25519:<base64>` and `ed25519:<keyId>:<base64>` signature formats
   2. verifies canonical manifest payload against configured trusted public key
2. Trust store integration:
   1. `manifestTrust.trustedPublisherKeys` config in plugin schema/runtime
   2. `manifestTrust.allowUnsignedLegacy` policy switch for compatibility mode
3. Provenance CI gate hardened:
   1. asserts runtime signature verifier/trust-store hooks remain present

## Slice D deliverables (started)

1. High-risk capability governance:
   1. `ansible_capability_publish` enforces `approval_artifact_id` when manifest declares high-risk + human approval required
   2. approval metadata recorded on published catalog entries and returned in publish result
2. Publish-path secret safeguards:
   1. manifest secret-literal scan blocks publish on sensitive candidates
   2. lifecycle metadata redaction prevents sensitive field/value leakage in emitted events
3. CLI support:
   1. `openclaw ansible capability publish` adds `--approval-artifact`, `--approved-by`, `--approval-note`

## Exit Criteria for this WI

1. `npm run test:release:gate` passes.
2. MVP-3 docs/checklists point to this WI and show active state.
3. Next implementation slices are clearly identified.
