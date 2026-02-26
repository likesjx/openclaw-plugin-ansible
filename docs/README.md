# Documentation Index

## Architecture & Design

- **[architecture.md](architecture.md)** — System overview, component descriptions, data flow diagrams, port architecture, session key strategy, and the OpenClaw plugin API surface
- **[openclaw-integration.md](openclaw-integration.md)** — How the ansible plugin + companion skill integrate with OpenClaw (one-page mental model)
- **[delegation-directory.md](delegation-directory.md)** — Delegation table standard for `IDENTITY.md`, coordinator distribution protocol, ACK model, and SLA enforcement rules
- **[identity-delegation-template.md](identity-delegation-template.md)** — Copy/paste template section for each agent `IDENTITY.md`
- **[protocol.md](protocol.md)** — Inter-agent messaging conventions, delivery semantics, current limitations, and the concrete reliability improvement plan
- **[state-model-v2.md](state-model-v2.md)** — RFC for state-only control plane and per-gateway data pipes (no message payloads in shared state)
- **[distributed-pipes-v2.md](distributed-pipes-v2.md)** — Mermaid architecture diagrams and end-to-end lifecycle for write-only gateway outboxes, routing, ACKs, replies, and failure handling
- **[external-agent-auth-v1.md](external-agent-auth-v1.md)** — External agent interface spec (Codex/Claude), auth endpoints, short-lived session tokens, scopes, and terminology reference
- **[runtime-protocol-v1.md](runtime-protocol-v1.md)** — Wire-level runtime contracts (events, ACKs, cursors, task lifecycle, capability publish, skill distribution, and conformance levels)
- **[federation-merge-v1.md](federation-merge-v1.md)** — Safe multinode cluster merge/federation protocol (handshake, conflict resolution, commit/rollback, staged propagation, and outstanding work matrix)
- **[skill-pair-dod-v1.md](skill-pair-dod-v1.md)** — Definition-of-done gates and recommended defaults for delegation/executor skill pair publish, update, rollback, and unpublish lifecycle
- **[skill-pair-manifest-schema-v1.md](skill-pair-manifest-schema-v1.md)** — Canonical JSON schema for manifest contract between ansible-meta (author) and ansible-main (enforcer)
- **[skill-pair-publish-executor-v1.md](skill-pair-publish-executor-v1.md)** — Normative gate execution order for publish/update/unpublish, including rollback and audit events
- **[ansible-completion-checklist-v1.md](ansible-completion-checklist-v1.md)** — Remaining implementation + release checklist to reach commit/push/deploy readiness
- **[documentation-status-v1.md](documentation-status-v1.md)** — Canonical vs historical doc map to prevent stale concepts from driving implementation
- **[clawhub-publish-prep-v1.md](clawhub-publish-prep-v1.md)** — Packaging, security, docs, and quality gates for publishing this plugin/skill to Clawhub
- **[deployment-runbook-v1.md](deployment-runbook-v1.md)** — Step-by-step canary rollout and rollback runbook with safe SLA defaults and go/no-go checks
- **[setup.md](setup.md)** — Practical setup and operations guide (new agent, new gateway, coordinator sweep)
- **[update-architecture.md](update-architecture.md)** — Source-of-truth update model (`setup` scope, plugin update path, config write safety, canonical defaults)

## Platform Knowledge

- **[openclaw-internals.md](openclaw-internals.md)** — Reference documentation for OpenClaw's plugin system, runtime channel API, agent dispatch pipeline, Pi LLM provider abstraction, and the skills system. Captured during ansible plugin development.

## Tracking

- **[DEFECTS.md](DEFECTS.md)** — Known bugs, workarounds, and technical debt

## Quick Links

| Topic | Document |
|---|---|
| How message dispatch works | [architecture.md — Data Flow](architecture.md#data-flow) |
| Plugin API methods | [openclaw-internals.md — Plugin System](openclaw-internals.md#plugin-system) |
| Runtime channel API | [openclaw-internals.md — Runtime Channel API](openclaw-internals.md#runtime-channel-api) |
| Gemini .filter() bug | [DEFECTS.md — DEF-001](DEFECTS.md#def-001-gemini-provider-filter-crash-upstream) |
| Port architecture | [architecture.md — Port Architecture](architecture.md#port-architecture) |
