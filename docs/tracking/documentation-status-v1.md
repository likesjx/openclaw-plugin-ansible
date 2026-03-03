# Documentation Status Matrix v1

Status: Active index  
Last updated: 2026-03-03

## Purpose

Identify which docs are normative vs historical so deprecated concepts do not leak into implementation or publishing.

## Canonical (Normative / Current)

1. `docs/protocols/state-model-v2.md`
2. `docs/protocols/distributed-pipes-v2.md`
3. `docs/protocols/runtime-protocol-v1.md`
4. `docs/protocols/external-agent-auth-v1.md`
5. `docs/protocols/federation-merge-v1.md`
6. `docs/standards/skill-pair-dod-v1.md`
7. `docs/standards/skill-pair-manifest-schema-v1.md`
8. `docs/standards/skill-pair-publish-executor-v1.md`
9. `docs/operations/ansible-completion-checklist-v1.md`

## Operationally Current

1. `docs/operations/setup.md`
2. `docs/architecture/core-architecture.md`
3. `docs/architecture/openclaw-integration.md`
4. `docs/architecture/delegation-directory-standard.md`
5. `docs/architecture/identity-delegation-template.md`
6. `docs/architecture/update-architecture.md`

## Historical / Superseded (keep for context, not implementation source of truth)

1. `docs/protocols/protocol-historical-v1.md`
   - superseded by `docs/protocols/runtime-protocol-v1.md` and `docs/protocols/distributed-pipes-v2.md`
2. `docs/architecture/agent-addressing-migration.md`
   - migration guidance only
3. `docs/architecture/openclaw-internals-reference.md`
   - platform reference snapshot (may drift from upstream)

## Review Cadence

1. Run doc status review before each release.
2. Any doc that contradicts canonical docs must be marked superseded in-file.
3. Clawhub publish must include only canonical + operational docs.

## Fast Path

1. If protocol semantics conflict, follow `docs/protocols/runtime-protocol-v1.md`.
2. If replication/pipe behavior conflicts, follow `docs/protocols/distributed-pipes-v2.md`.
3. If shared-state model conflicts, follow `docs/protocols/state-model-v2.md`.
