# Federation Merge Protocol v1

Status: Draft Spec  
Last updated: 2026-02-25

## Goal

Safely merge two independent Ansible multinode systems (clusters) into one federated mesh, with deterministic conflict handling and rollback.

## Definitions

- `Cluster`: a connected multinode Ansible system sharing one control plane.
- `Bridge node`: the trusted node performing handshake and merge orchestration.
- `Federation epoch`: monotonic version marking a committed merge state.
- `Control plane`: state-room metadata only (nodes, agents, routing, capabilities, policies, cursors).
- `Data plane`: outbox/inbox event streams.

## Non-Goals

- Blind merge of all payload/event history.
- Unattended conflict resolution without policy rules.
- Immediate global fanout before health verification.

## Protocol Phases

## 0) Preconditions

1. Both clusters have auth gate enabled.
2. Bridge nodes trust each other via explicit invite/exchange.
3. Both clusters expose control-plane snapshot endpoint/tool.

## 1) Handshake

1. Cluster A bridge invites Cluster B bridge (node-bound).
2. Cluster B bridge obtains WS ticket via exchange endpoint.
3. Cluster B bridge joins Cluster A control plane as `federation-pending`.
4. Both sides record `federationSessionId`.

## 2) Snapshot Exchange

Exchange signed control-plane snapshots (no payload streams):

- `nodes`
- `agents`
- `routing`
- `capabilities.catalog/index`
- `coordination` policy versions
- subscriber metadata and cursor domains

Required snapshot fields:

- `clusterId`
- `snapshotId`
- `createdAt`
- `policyVersions`
- `hash`
- `signature`

## 3) Preflight Conflict Resolution

The merge MUST stop if unresolved conflicts remain.

Conflict classes:

1. `nodeId_collision`
2. `agentId_collision`
3. `capability_owner_conflict`
4. `routing_policy_conflict`
5. `admin_policy_conflict`
6. `schema_version_incompatible`

Resolver outputs:

- `renames` (namespacing/remap table)
- `ownerDecisions`
- `policyWinner`
- `blockedItems`

## 4) Merge Plan Commit (Control Plane Only)

1. Create `federationPlan` record with:
- `federationSessionId`
- source snapshot ids
- conflict decisions
- target `federationEpoch`

2. Apply merged control-plane state atomically (single transaction boundary where possible).
3. Mark both bridge nodes `federated=true`.

## 5) Pipe Directory Propagation

Propagate pipe metadata through control plane:

- `pipes.<nodeId>.outboxEndpoint`
- `subscriptions.<nodeId>.sources[]`

Rules:

1. Only metadata is propagated.
2. No payload copying between clusters in this phase.
3. Subscription rollout is staged (canary -> partial -> full).

## 6) Data-Plane Federation

After control-plane commit:

1. Start bridge forwarding for selected source outboxes.
2. Add federation stamps to forwarded events:
- `originClusterId`
- `forwardedBy[]`
- `federationEpoch`
3. Enforce loop prevention using stamp checks and dedupe keys.

## 7) Optional History Import

Default: disabled.

If enabled:

1. Import bounded history window only.
2. Rehydrate as archived references, not live dispatch events.
3. Preserve original cluster provenance on each imported record.

## 8) Health Gates and Finalize

Promotion gates:

1. No unresolved conflicts.
2. Ack lag under threshold for canary subscriptions.
3. No replay/loop incidents for defined soak window.
4. Task/message success rates above SLO target.

If all pass:

1. Mark federation `active`.
2. Enable full subscription policy.

If failed:

1. Trigger rollback plan.

## Rollback Plan

1. Freeze bridge forwarding.
2. Revert control-plane to pre-merge snapshot.
3. Remove temporary subscription routes.
4. Keep audit records and incident report.

## Identity and Namespace Strategy

Default safe mode:

1. Namespace colliding ids (`clusterB:<id>`).
2. Preserve original aliases for display only.
3. Allow explicit alias remap after verification.

## Cursor and Dedupe Rules

1. Maintain per-source-cluster cursor domains during federation.
2. Dedupe key: `(originClusterId, eventId)`.
3. Do not compact cross-cluster history until both sides acknowledge stable cursors.

## Security Requirements

1. Node-bound invites for bridge handshake.
2. Exchange endpoint with nonce replay protection.
3. PoP proof required for production federation.
4. Rate limiting and audit logging on exchange and bridge actions.
5. Signed snapshots and plan records.

## Automation Model

Safe autonomy pattern:

1. Auto-run preflight checks.
2. Auto-generate merge plan.
3. Require explicit approval for conflictful plans.
4. Auto-rollback on critical gate failure.

## Outstanding Work Matrix

## A) Federation-Specific

1. Implement snapshot export/import API.
2. Implement conflict resolver engine + decision schema.
3. Implement atomic merge commit + rollback snapshots.
4. Implement bridge forwarding service with loop prevention.
5. Implement staged subscription rollout controller.

## B) Auth / Admission

1. Persist/reconcile replay cache TTL cleanup policy.
2. Add mandatory PoP mode with key registration lifecycle.
3. Add endpoint-level structured audit events (exportable).
4. Add configurable IP/actor allowlists for exchange.

## C) Runtime Semantics

1. Finalize ACK timeout/backoff constants as normative.
2. Enforce task accept ETA contract in dispatcher.
3. Enforce exactly-once session injection ledger.
4. Add terminal failure taxonomy and escalation actions.

## D) Capability + Skill Lifecycle

1. Implement `capability_publish/unpublish` tools.
2. Implement distribution fanout task generation.
3. Implement contract schema validation at runtime.
4. Implement auto-review queue processor and remediation workflow.

## E) Cursors / Retention

1. Implement lease-aware compaction watermark.
2. Implement gap timeout + tombstone skip policy.
3. Implement rewind/replay operation with guardrails.
4. Define retention SLO tiers (hot/warm/archive).

## F) Observability / Ops

1. Add federation health dashboard fields.
2. Add per-recipient lifecycle status query endpoint.
3. Add dead-letter inspection + replay tooling.
4. Add incident hooks for SLA/loop/replay anomalies.

## G) Docs / Tests

1. Add wire-format examples for federation endpoints.
2. Add integration tests for merge happy path.
3. Add chaos tests for split-brain/partition/replay.
4. Add security tests for PoP/replay/rate-limit bypass attempts.

## Confidence (Current)

1. Architecture direction: high.
2. Protocol completeness for federation: medium.
3. Implementation readiness for safe automated merge: low-medium until conflict resolver + rollback are built.

