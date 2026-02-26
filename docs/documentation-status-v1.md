# Documentation Status Matrix v1

Status: Active index  
Last updated: 2026-02-26

## Purpose

Identify which docs are normative vs historical so deprecated concepts do not leak into implementation or publishing.

## Canonical (Normative / Current)

1. `docs/state-model-v2.md`
2. `docs/distributed-pipes-v2.md`
3. `docs/runtime-protocol-v1.md`
4. `docs/external-agent-auth-v1.md`
5. `docs/federation-merge-v1.md`
6. `docs/skill-pair-dod-v1.md`
7. `docs/skill-pair-manifest-schema-v1.md`
8. `docs/skill-pair-publish-executor-v1.md`
9. `docs/ansible-completion-checklist-v1.md`

## Operationally Current

1. `docs/setup.md`
2. `docs/architecture.md`
3. `docs/openclaw-integration.md`
4. `docs/delegation-directory.md`
5. `docs/identity-delegation-template.md`
6. `docs/update-architecture.md`

## Historical / Superseded (keep for context, not implementation source of truth)

1. `docs/protocol.md`
   - superseded by `docs/runtime-protocol-v1.md` and `docs/distributed-pipes-v2.md`
2. `docs/agent-addressing-migration.md`
   - migration guidance only
3. `docs/openclaw-internals.md`
   - platform reference snapshot (may drift from upstream)

## Review Cadence

1. Run doc status review before each release.
2. Any doc that contradicts canonical docs must be marked superseded in-file.
3. Clawhub publish must include only canonical + operational docs.
