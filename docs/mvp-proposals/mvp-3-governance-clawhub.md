# MVP-3 Governance + Clawhub Proposal & Plan

Status: in_progress  
Last updated: 2026-03-03

## Proposal Summary

Goal: reach publication-grade governance and provenance posture for Clawhub distribution.

Scope:

1. Signature verification trust path + key store integration.
2. Approval artifact recording for high-risk capabilities.
3. Secret scanning/redaction in publish path.
4. Signed provenance checks in CI.
5. Clawhub packaging/docs metadata completion.

Success Gates:

1. Clawhub publish checklist fully complete.
2. Security review sign-off.

Disposition (current):

1. Execution started on `main` via kickoff WI:
   1. `docs/work-items/WI-20260303-mvp3-governance-clawhub-kickoff.md`
2. Slice A focus:
   1. publication metadata normalization
   2. release gate automation (`npm run test:release:gate`)
   3. checklist hardening for Clawhub submit readiness
3. Slice B started:
   1. CI governance workflow (`.github/workflows/mvp3-governance-gates.yml`)
   2. provenance contract gate (`npm run test:provenance:gate`)
4. Slice C started:
   1. `G2_PROVENANCE` signature verification (`ed25519`) implemented in runtime
   2. trust key-store configuration wired via `manifestTrust.trustedPublisherKeys`
   3. legacy unsigned policy switch added via `manifestTrust.allowUnsignedLegacy`
