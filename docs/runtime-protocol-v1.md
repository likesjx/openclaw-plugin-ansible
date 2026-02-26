# Runtime Protocol v1 (Draft)

Status: Draft Spec  
Last updated: 2026-02-25

## Scope

This document defines concrete wire-level contracts for:

1. Capability publication and routing activation.
2. Message/task event envelopes and ACK semantics.
3. Cursor semantics.
4. Task execution lifecycle.

This spec assumes the architecture decisions in:

- `docs/state-model-v2.md`
- `docs/distributed-pipes-v2.md`
- `docs/external-agent-auth-v1.md`

## Terminology (Quick)

- `Control plane`: shared state room metadata only.
- `Data plane`: gateway outbox/inbox event streams.
- `Publisher`: gateway appending event to its own outbox.
- `Consumer`: gateway reading other outboxes.
- `Owner`: gateway currently hosting target agent capability execution.

## 1) Common Event Envelope

All data-plane events MUST use this envelope.

```json
{
  "eventId": "evt_01JV3M2N8V1ZK4J2A0M7Y6P9QF",
  "seq": 1842,
  "kind": "message",
  "sourceNodeId": "vps-jane",
  "sourceAgentId": "architect",
  "toAgentId": "mbp-jane",
  "corrId": "corr_01JV3M2B1P2M4E6R7T8Y9U0I1O",
  "createdAt": "2026-02-25T16:22:10.123Z",
  "expiresAt": "2026-02-26T16:22:10.123Z",
  "payload": {},
  "trace": {
    "attempt": 1,
    "routingPolicyVersion": "rpv_2026_02_25_1",
    "capabilityPolicyVersion": "cpv_2026_02_25_3"
  }
}
```

Rules:

1. `eventId` MUST be globally unique.
2. `seq` MUST be strictly monotonic per outbox stream.
3. `corrId` MUST be present for all `reply`, `ack`, and task lifecycle events.
4. `trace.attempt` MUST increment on resend of same logical operation.

## 2) Capability Publish Contract

### Control Plane Record: `capabilities.catalog.<capabilityId>`

```json
{
  "capabilityId": "cap.fs.diff-apply",
  "name": "Filesystem Diff Apply",
  "version": "1.3.0",
  "status": "active",
  "ownerAgentId": "executor-mbp",
  "ownerNodeId": "mbp-jane",
  "delegationSkillRef": {
    "name": "ansible-delegate-fs",
    "version": "1.3.0",
    "path": "/skills/ansible-delegate-fs"
  },
  "executorSkillRef": {
    "name": "ansible-executor-fs",
    "version": "1.3.0",
    "path": "/skills/ansible-executor-fs"
  },
  "contractSchemaRef": "schema://ansible/cap.fs.diff-apply/1.3.0",
  "defaultEtaSeconds": 900,
  "publishedAt": "2026-02-25T16:30:00.000Z",
  "publishedByAgentId": "architect"
}
```

Validation:

1. `ownerAgentId` MUST exist and be active.
2. `executorSkillRef` MUST resolve on owner gateway.
3. `defaultEtaSeconds` MUST be between `30` and `86400`.

### Control Plane Index: `capabilities.index.<capabilityId>`

```json
{
  "capabilityId": "cap.fs.diff-apply",
  "eligibleAgentIds": ["executor-mbp"],
  "policyVersion": "cpv_2026_02_25_3",
  "updatedAt": "2026-02-25T16:30:05.000Z"
}
```

## 3) Message Contract

### Publish Message

`kind=message`

```json
{
  "toAgents": ["mbp-jane", "vps-jane"],
  "subject": "Coordination update",
  "body": "Build completed. Please validate release notes.",
  "priority": "normal",
  "expectsReply": false
}
```

Rules:

1. `toAgents` MUST be present and non-empty.
2. `toAgents=["all"]` MAY be used and MUST be expanded to concrete recipients at publish time.
3. Message injection into recipient session MUST be exactly-once per (`eventId`, `toAgentId`) via delivery ledger.

## 4) Task Contract

### Task Create

`kind=task_create`

```json
{
  "taskId": "tsk_01JV3Q9A1V7M4R3N8E2W0D6Y5U",
  "title": "Publish v1 release checklist",
  "description": "Generate and validate release checklist for plugin v1.3.0",
  "toAgents": [],
  "requiredCapabilities": ["cap.release.checklist"],
  "priority": "high",
  "requesterAgentId": "architect",
  "responseRequired": true,
  "deadlineAt": "2026-02-25T20:00:00.000Z"
}
```

Routing rules:

1. If `toAgents` non-empty, route to those agents after validation.
2. If `toAgents` empty, `requiredCapabilities` MUST be present and non-empty.
3. If neither yields eligible targets, reject `400 no_route`.

### Task Accept

`kind=task_accept` (or `ack` with task payload in minimal profile)

```json
{
  "taskId": "tsk_01JV3Q9A1V7M4R3N8E2W0D6Y5U",
  "acceptedByAgentId": "executor-mbp",
  "etaAt": "2026-02-25T18:00:00.000Z",
  "planSummary": "Validate checklist template, gather release artifacts, emit final report."
}
```

Rules:

1. MUST be emitted before execution starts.
2. MUST include `etaAt` or `etaSeconds`.

### Task Update

`kind=task_update`

```json
{
  "taskId": "tsk_01JV3Q9A1V7M4R3N8E2W0D6Y5U",
  "status": "in_progress",
  "progress": 60,
  "note": "Artifact scan complete; validating links.",
  "revisedEtaAt": "2026-02-25T18:30:00.000Z"
}
```

### Task Complete

`kind=task_complete`

```json
{
  "taskId": "tsk_01JV3Q9A1V7M4R3N8E2W0D6Y5U",
  "completedByAgentId": "executor-mbp",
  "resultSummary": "Checklist generated and validated.",
  "resultRef": "artifact://reports/release-checklist-1.3.0.md",
  "completedAt": "2026-02-25T17:54:10.000Z"
}
```

### Task Failed

`kind=task_failed`

```json
{
  "taskId": "tsk_01JV3Q9A1V7M4R3N8E2W0D6Y5U",
  "failedByAgentId": "executor-mbp",
  "failureClass": "dependency_missing",
  "errorSummary": "Release artifacts missing changelog metadata.",
  "failedAt": "2026-02-25T17:40:02.000Z"
}
```

## 5) ACK Contract

### ACK Event

`kind=ack`

```json
{
  "refEventId": "evt_01JV3M2N8V1ZK4J2A0M7Y6P9QF",
  "refKind": "task_create",
  "ackType": "accepted",
  "ackedByNodeId": "mbp-jane",
  "ackedByAgentId": "executor-mbp",
  "ackedAt": "2026-02-25T16:31:00.000Z",
  "etaAt": "2026-02-25T18:00:00.000Z"
}
```

Allowed `ackType`:

1. `accepted`
2. `processed`
3. `failed_terminal`

Rules:

1. ACK MUST be emitted on receiver gateway outbox.
2. `accepted` MUST imply durable local enqueue.
3. `processed` MUST imply terminal execution outcome exists (`reply`, `task_complete`, or `task_failed`).

## 6) Cursor Semantics

Cursor model:

- Per consumer node, per source node.
- Tracks last contiguous sequence durably queued for routing.

### Cursor Record: `delivery.cursors.<consumerNodeId>.<sourceNodeId>`

```json
{
  "consumerNodeId": "mbp-jane",
  "sourceNodeId": "vps-jane",
  "lastSeq": 1842,
  "updatedAt": "2026-02-25T16:32:00.000Z",
  "status": "active",
  "leaseExpiresAt": "2026-02-25T16:37:00.000Z",
  "epoch": "route-epoch-2026-02-25T16:00:00.000Z"
}
```

Rules:

1. Cursor advances only after durable enqueue to local processing ledger.
2. Gaps MUST block advancement up to `gapTimeoutSeconds`.
3. After gap timeout, consumer MAY emit incident and apply configured skip/tombstone policy.
4. Compaction watermark MUST use active subscriber cursors only.

Default timings:

1. `gapTimeoutSeconds=30`
2. `cursorLeaseSeconds=300`
3. `acceptedAckTimeoutSeconds=20`
4. `processedSlaGraceSeconds=120`

## 7) Skill Distribution Task (on Capability Publish)

On capability publish:

1. System creates `task_create` with `taskType=skill_distribution`.
2. Targets are all active non-owner agents.
3. Completion requires install/version confirmation.

Skill distribution payload:

```json
{
  "taskType": "skill_distribution",
  "capabilityId": "cap.fs.diff-apply",
  "delegationSkillRef": {
    "name": "ansible-delegate-fs",
    "version": "1.3.0"
  },
  "requiredBy": "2026-02-25T18:30:00.000Z"
}
```

## 8) Auto-Review Triggers

A skill review item MUST be created when:

1. Task misses ETA + grace.
2. Task ends with `task_failed`.
3. Output fails contract schema validation.
4. Route resolution repeatedly fails for active capability.

Review item shape:

```json
{
  "reviewId": "rev_01JV3T7E6Q8M1W2R4D9K0N5P7H",
  "capabilityId": "cap.fs.diff-apply",
  "delegationSkillVersion": "1.3.0",
  "executorSkillVersion": "1.3.0",
  "failureClass": "sla_breach",
  "sampleCorrIds": ["corr_01...", "corr_02..."],
  "createdAt": "2026-02-25T18:05:00.000Z"
}
```

## 9) Conformance Levels

### L1 (Minimum Deployable)

1. Event envelope + per-source cursor.
2. `ack:accepted` + `ack:processed`.
3. Task create/accept/complete.

### L2 (Operationally Robust)

1. Gap handling + incidenting.
2. Skill publish capability index.
3. Auto-review triggers.

### L3 (Security Hardened)

1. PoP-bound tokens for external agents.
2. Strict replay protections (`nonce`, `jti`) across auth and invoke.
3. Full audit correlation by `corrId` and `sessionId`.

