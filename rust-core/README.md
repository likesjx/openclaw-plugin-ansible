# rust-core (MVP-6 scaffold)

This workspace is the Rust runtime scaffold from `docs/mvp/proposals/mvp-6-rust-port-proposal-v1.md`.

Current status:

1. Phase 0 in progress (contract freeze + golden fixture parity).
2. TypeScript remains source of truth.
3. Rust crates are scaffold-only for now.

Planned crates:

1. `ansible-core-model`: canonical request/response types and schema versions.
2. `ansible-core-runtime`: deterministic runtime engines/state machines.
3. `ansible-core-security`: token/ticket/signature validation.
4. `ansible-core-service`: local sidecar transport and API surface.
