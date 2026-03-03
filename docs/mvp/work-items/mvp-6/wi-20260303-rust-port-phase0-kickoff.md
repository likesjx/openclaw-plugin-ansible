# WI-MVP6-001 Rust Port Phase 0 Kickoff

Status: in_progress  
Owner: codex  
Created: 2026-03-03

## Intent

Start MVP-6 with a concrete Phase 0 baseline:

1. Freeze the first Rust-core contract.
2. Commit deterministic golden fixtures from current TypeScript behavior.
3. Add a parity harness that can validate TS baseline now and Rust shadow outputs later.

## Deliverables

1. `rust-core/` scaffold workspace + crate skeletons.
2. `contracts/rust-core-contract-v1.md` (SLA sweep v1 request/response envelope).
3. `contracts/fixtures/sla-sweep-v1/*.input.json` and `*.expected.json`.
4. Parity scripts:
   1. `scripts/parity/generate-sla-sweep-phase0-fixtures.mjs`
   2. `scripts/parity/check-sla-sweep-phase0-parity.mjs`
5. Package scripts:
   1. `npm run phase0:fixtures:refresh`
   2. `npm run test:parity:mvp6`

## Exit Criteria

1. Fixture refresh command succeeds.
2. TS parity command succeeds against committed fixtures.
3. Rust shadow mode pathway is ready via:
   1. `ANSIBLE_RUST_SHADOW=1`
   2. `ANSIBLE_RUST_OUTPUTS_DIR=<dir>`

## Notes

1. Fixture mode uses `recordOnly=true` for deterministic outputs (no random message IDs).
2. This is intentional Phase 0 behavior to freeze decision semantics first.
