# WI-20260303: Move Communications Plane to Ansible (Telegram as Edge Adapter)

Status: In Progress  
Owner: Codex  
Created: 2026-03-03

## Why

Current reliability and operator visibility gaps are concentrated in the communication/control path (message pickup uncertainty, model call ambiguity, and secrets confusion). We need a deterministic communications plane with explicit contracts and auditable flow.

## Goal

Design and stage migration to an Ansible-centered communications plane where Telegram is an external transport adapter, not the primary coordination fabric.

## Objectives

1. Make Ansible the authoritative inter-agent transport for inbound and outbound chat events.
2. Add first-class support for attachment-bearing messages (images/audio/files/video) via metadata + blob indirection.
3. Improve operational confidence through idempotency, retries, dead-lettering, and end-to-end tracing.
4. Reduce secrets sprawl by centralizing Telegram credentials in the adapter boundary.
5. Preserve agent-side conversation behavior while changing transport under the hood.

## Deliverables

1. Detailed design proposal: `docs/mvp/proposals/mvp-5-ansible-communications-plane.md`.
2. Versioned event envelope schemas (ingress/egress/attachments).
3. Queue/topic topology and delivery semantics spec.
4. Migration/cutover plan with shadow mode and rollback gates.
5. Observability and operations checklist (lag, retry, DLQ, trace, model audit).

## Acceptance Criteria

1. Proposal defines components, contracts, failure handling, and attachment lifecycle in implementation-ready detail.
2. Migration plan includes phased rollout, explicit exit criteria, and rollback steps.
3. Security section defines credential ownership, encryption boundaries, and audit requirements.
4. Proposal names open decisions and assigns next implementation slice.

## Non-Goals (this WI)

1. Full replacement of existing agent runtime logic.
2. Full rewrite of OpenClaw/Jane in this workstream.
3. Building provider-specific media processing pipelines beyond minimal ingest/send support.

## Execution Checklist

- [x] Create WI record.
- [x] Draft detailed proposal.
- [ ] Review with architect and confirm queue contract version `v1`.
- [ ] Approve Phase 0/1 implementation slices.
- [ ] Create follow-up implementation WI(s).

## Risks

1. Adapter centralization can become a bottleneck if queue backpressure controls are weak.
2. Attachment storage growth can become expensive without lifecycle/TTL policies.
3. Contract drift between adapter and agents can cause silent processing drops.

## Decision Log

1. Treat Telegram as an edge adapter and keep Ansible as authoritative transport.
2. Handle attachments as out-of-band blobs with signed references, not inline queue payloads.
3. Preserve existing agent pipeline semantics while changing only transport and envelope boundaries first.
