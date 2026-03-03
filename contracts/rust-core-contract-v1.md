# Rust Core Contract v1 (Phase 0)

Status: draft  
Last updated: 2026-03-03

## Scope

Phase 0 freezes request/response contracts for the first Rust-owned candidate domain:

1. SLA sweep engine (`sla_sweep_v1`)

TypeScript remains authority. Rust must match these envelopes exactly in shadow mode.

## Contract ID

- `schema://ansible/rust-core/sla-sweep/1.0.0`

## Request Envelope (`SlaSweepRequestV1`)

```json
{
  "contractSchemaRef": "schema://ansible/rust-core/sla-sweep/1.0.0",
  "caseId": "safe",
  "nowMs": 1700001000000,
  "nodeId": "backbone-alpha",
  "options": {
    "dryRun": false,
    "recordOnly": true,
    "maxMessages": 3,
    "fyiAgents": ["architect"]
  },
  "tasks": []
}
```

Field rules:

1. `contractSchemaRef`: required exact string for this version.
2. `caseId`: required fixture/test ID.
3. `nowMs`: required epoch milliseconds, must drive all time-based logic.
4. `nodeId`: required emitting node identity.
5. `options.dryRun`: required boolean.
6. `options.recordOnly`: required boolean.
7. `options.maxMessages`: required non-negative integer.
8. `options.fyiAgents`: required array of non-empty strings.
9. `tasks`: required array of task records in OpenClaw task shape.

## Response Envelope (`SlaSweepResponseV1`)

```json
{
  "contractSchemaRef": "schema://ansible/rust-core/sla-sweep/1.0.0",
  "caseId": "safe",
  "result": {
    "success": true,
    "dryRun": false,
    "scanned": 4,
    "breaches": [],
    "breachCount": 0,
    "escalationsWritten": 0
  },
  "tasksAfter": [],
  "messagesAfter": []
}
```

Field rules:

1. `contractSchemaRef`: required exact match.
2. `caseId`: required exact echo of request `caseId`.
3. `result`: required result object with deterministic values.
4. `tasksAfter`: required full post-sweep task set (sorted by `id` in fixtures).
5. `messagesAfter`: required post-sweep message set (sorted by `id` in fixtures).

## Determinism Rules (Phase 0)

1. `nowMs` must be the only time source for comparisons and writes.
2. Fixture mode uses `recordOnly=true` to avoid random message IDs.
3. Fixture outputs are compared as strict JSON equality.
4. Arrays are sorted by `id` before comparison.

## Golden Fixtures

- Directory: `contracts/fixtures/sla-sweep-v1/`
- Files per case:
1. `<caseId>.input.json`
2. `<caseId>.expected.json`

Current cases:

1. `safe`
2. `storm`
