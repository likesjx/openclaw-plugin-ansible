# Rust Port Proposal v1 (Ansible)

Status: Draft  
Last updated: 2026-03-02

## Goal

Identify what parts of the Ansible plugin should move to Rust, and define a low-risk migration path that improves reliability without freezing feature delivery.

## Recommendation (Short Version)

Use a hybrid model first:

1. Keep OpenClaw plugin surface and CLI integration in TypeScript.
2. Port runtime-critical engines to a Rust sidecar/daemon.
3. Migrate more only after parity, soak, and operational confidence.

This gives us performance and safety gains where they matter most, without a risky full rewrite.

## What To Port First

## Priority A: High-Value Runtime Core

1. Delivery/queue core (cursors, dedupe ledger, retry scheduler, dead-letter transitions).
2. Task lifecycle state machine enforcement (claim/update/complete/fail invariants).
3. SLA sweep engine + escalation budgeting logic.
4. Capability lifecycle gate executor internals (publish/update/unpublish gate transitions and rollback).

Why:

1. Deterministic state transitions and memory safety matter most here.
2. These paths are hot and sensitive to race conditions.
3. Rust gives stricter contracts and better long-running process behavior.

## Priority B: Security-Critical Paths

1. Invite/token/ticket validation + replay protection store.
2. Signature/checksum verification pipeline.
3. Approval artifact validation policy hooks.

Why:

1. Strong typing and explicit error handling reduce auth and validation bugs.
2. Easier to audit and fuzz-test.

## Keep in TypeScript (For Now)

1. OpenClaw tool registration and plugin API wiring.
2. User-facing CLI commands and output formatting.
3. Fast-changing policy/UX orchestration glue.

Why:

1. TS iteration speed is better for operator workflows.
2. OpenClaw plugin ecosystem is already TS-native.

## Interface Model

Use a local Rust service with explicit JSON contracts.

Transport options:

1. Unix domain socket (preferred on macOS/Linux).
2. Loopback HTTP fallback.

TS responsibilities:

1. Validate/normalize user tool inputs.
2. Forward deterministic commands to Rust core.
3. Translate Rust responses into tool outputs/events.

Rust responsibilities:

1. Own state transition correctness for core runtime domains.
2. Return typed result envelopes (success/failure + machine codes).
3. Emit structured audit events for TS to publish.

## Suggested Crate Layout

1. `ansible-core-model`: canonical structs/enums and schema versions.
2. `ansible-core-runtime`: task/capability state machines.
3. `ansible-core-security`: token/ticket/signature validation.
4. `ansible-core-service`: socket/http service layer.
5. `ansible-core-cli` (optional later): operator/debug utilities.

## Migration Plan

## Phase 0: Contract Freeze

1. Freeze JSON request/response schema for target domains.
2. Add golden test vectors from current TS behavior.

Exit:

1. Shared contract fixtures committed.
2. TS contract tests passing against fixtures.

## Phase 1: Shadow Mode

1. Rust engine runs read-only or "advice mode".
2. TS remains source of truth.
3. Compare Rust decisions to TS decisions, log diffs.

Exit:

1. Zero critical decision mismatches across soak window.

## Phase 2: Write Authority by Domain

1. Flip one domain at a time to Rust authority:
   1. SLA sweep
   2. task lifecycle enforcement
   3. capability lifecycle gates
2. Keep fast rollback feature flag per domain.

Exit:

1. Domain parity tests green.
2. Soak stable, no regressions.

## Phase 3: Harden and Expand

1. Add fuzz/property tests on state transitions.
2. Consider migrating more orchestration only if TS becomes bottleneck.

## Risks and Mitigations

1. Dual-logic drift:
   1. Mitigation: shadow mode + golden fixtures + parity CI.
2. Operational complexity (two runtimes):
   1. Mitigation: single managed sidecar lifecycle and health checks.
3. Debugging friction:
   1. Mitigation: shared correlation IDs and machine-readable failure taxonomy end to end.

## Confidence

Current recommendation confidence: Medium-High.

Reason:

1. Hybrid migration preserves delivery velocity.
2. Rust focus is on the exact places where safety and determinism pay off.
3. Full rewrite is high-risk and unnecessary right now.

## Immediate Next Steps (Tomorrow-Ready)

1. Approve hybrid architecture and Phase 0 scope.
2. Pick first Rust-owned domain:
   1. Recommended: SLA sweep engine.
3. Create `rust-core-contract-v1.md` with exact request/response envelopes.
4. Add a feature flag in TS for Rust shadow mode (`ANSIBLE_RUST_SHADOW=1`).

