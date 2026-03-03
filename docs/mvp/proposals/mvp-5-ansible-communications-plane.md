# MVP-5 Ansible Communications Plane Proposal v1 (Telegram Edge Adapter)

Status: Draft  
Last updated: 2026-03-03

## Goal

Move communication control from the current OpenClaw/Jane message path to an Ansible-first transport model, with Telegram treated as an external channel adapter.

This proposal is designed to improve reliability, auditability, and operational clarity without forcing an immediate full agent-framework rewrite.

## Problem Statement

Current pain points indicate control-plane instability rather than pure model/runtime quality issues:

1. Inbound Telegram delivery uncertainty (messages not consistently picked up).
2. Secrets ambiguity across processes/environments.
3. Weak visibility into which model/provider handled each response.
4. Hard-to-debug failures across multiple loosely defined hops.

The architecture should make transport deterministic and observable first, then support gradual runtime evolution.

## Recommendation (Short Version)

Use Ansible as the authoritative bus with explicit ingress and egress channels.

1. Introduce a central `telegram-adapter` service (poll + send).
2. Map `telegram_bot_id -> ansible_agent_id` in a versioned registry.
3. Publish normalized inbound events to Ansible ingress queues.
4. Have agents consume those events through a dedicated external-input queue path.
5. Publish outbound events back to the adapter for Telegram delivery.
6. Handle attachments out-of-band via object storage + metadata references.

## Architecture Overview

## Components

1. `telegram-adapter`
   1. Polls Telegram updates for all configured bots.
   2. Resolves bot/tenant mapping to target Ansible agent.
   3. Stores attachment binaries in blob storage.
   4. Publishes normalized ingress events.
   5. Consumes outbound events and sends replies via Telegram API.

2. `mapping-registry`
   1. Authoritative mapping for `bot_id`, `tenant_id`, `agent_id`, and credential profile.
   2. Versioned with audit trail for changes.

3. `ansible-bus`
   1. Separate channels for `ingress.external.telegram` and `egress.external.telegram`.
   2. Ack/nack + retry + dead-letter behavior.

4. `agent-runtime-bridge`
   1. Converts ingress event to internal pipeline input.
   2. Emits outbound event envelopes (text and/or attachments).
   3. Attaches model execution metadata for observability.

5. `blob-store` (S3/MinIO/file-backed)
   1. Holds attachment bytes.
   2. Enforced retention policy.
   3. Access via signed URLs or service credentials.

## Logical Flow

1. Telegram user sends message to bot.
2. Adapter polls update, normalizes metadata, writes attachments to blob store.
3. Adapter publishes ingress event to Ansible channel keyed by `agent_id`.
4. Agent consumes, processes, and generates reply event.
5. Adapter consumes outbound event, uploads outbound attachments if needed, sends via Telegram.
6. Adapter emits delivery result event and updates retry state.

## Message Contracts (v1)

All events share base fields:

1. `event_id` (global unique UUID; idempotency key)
2. `trace_id` (single request trace across ingress->egress)
3. `channel` (`telegram`)
4. `direction` (`ingress` | `egress`)
5. `created_at` (ISO-8601 UTC)
6. `schema_version` (`telecom.v1`)

## Ingress Event Schema

```json
{
  "event_id": "evt_01J123...",
  "trace_id": "trc_01J123...",
  "schema_version": "telecom.v1",
  "channel": "telegram",
  "direction": "ingress",
  "source": {
    "bot_id": "123456:ABC",
    "chat_id": "99887766",
    "user_id": "44556677",
    "message_id": "9123",
    "update_id": "120001122"
  },
  "routing": {
    "agent_id": "vps-jane",
    "tenant_id": "default",
    "priority": "normal"
  },
  "content": {
    "text": "Can you check deployment health?",
    "caption": null,
    "attachments": [
      {
        "attachment_id": "att_01J123...",
        "kind": "image",
        "mime_type": "image/jpeg",
        "size_bytes": 181223,
        "telegram_file_id": "AgACAg...",
        "telegram_file_unique_id": "AQAD9...",
        "storage_uri": "s3://oc-telegram/2026/03/03/att_01J123.jpg",
        "sha256": "5b6f...e4c9"
      }
    ]
  },
  "security": {
    "ingress_profile": "telegram:bot:ops",
    "signed": true
  }
}
```

## Egress Event Schema

```json
{
  "event_id": "evt_01J124...",
  "trace_id": "trc_01J123...",
  "schema_version": "telecom.v1",
  "channel": "telegram",
  "direction": "egress",
  "routing": {
    "agent_id": "vps-jane",
    "bot_id": "123456:ABC",
    "chat_id": "99887766"
  },
  "reply_to": {
    "source_message_id": "9123"
  },
  "content": {
    "text": "Health check completed. No active errors.",
    "attachments": []
  },
  "execution": {
    "provider": "openai",
    "model": "gpt-5-codex",
    "run_id": "run_abc123"
  }
}
```

## Attachment Handling

Attachments must not be inlined in queue payloads.

1. Inbound:
   1. Download from Telegram by `file_id`.
   2. Virus/content-safety scan (policy configurable).
   3. Store bytes in blob store.
   4. Publish metadata reference only.

2. Outbound:
   1. Agent references `storage_uri` or inline local path for adapter upload step.
   2. Adapter uploads/transmits to Telegram.
   3. Adapter records Telegram `message_id` and `file_id` in delivery receipt.

3. Policy:
   1. Max file size per media kind.
   2. MIME allowlist.
   3. Retention lifecycle (for example 30-90 days depending on tenancy).
   4. Optional redaction/quarantine for blocked content.

## Queue Topology and Delivery Semantics

## Channels

1. `ingress.external.telegram.<agent_id>`
2. `egress.external.telegram.<agent_id>`
3. `receipt.external.telegram.<agent_id>`
4. `dlq.external.telegram.<agent_id>`

## Guarantees

1. At-least-once delivery on ingress/egress channels.
2. Idempotent consumer behavior keyed by `event_id`.
3. Explicit ack/nack contract.
4. Bounded retries with exponential backoff + jitter.
5. Dead-letter after max attempts or permanent policy failures.

## Ordering

1. Preserve per-chat ordering best-effort via partition key `chat_id`.
2. Do not enforce global ordering across chats/agents.

## Reliability and Failure Handling

## Known Failure Classes

1. Telegram API transient failure (rate limit, timeout).
2. Adapter crash between download/store/publish steps.
3. Agent crash after processing but before reply emit.
4. Duplicate delivery during retry/restart.
5. Storage unavailability for attachments.

## Controls

1. Outbox table for outbound send requests and receipts.
2. Dedupe ledger keyed by `event_id` + `telegram update_id`.
3. Retry budget policy with DLQ fallback.
4. Reconciliation worker for stale in-flight events.
5. Replay tool for DLQ requeue with explicit operator approval.

## Security and Secrets Model

1. Telegram bot tokens live only in `telegram-adapter` secret scope.
2. Agents never require direct Telegram credentials.
3. Blob storage access is scoped to service identity (or signed short-lived URLs).
4. Event envelopes carry no raw secrets.
5. All state changes are audit-logged with actor/process identity.

## Observability Requirements

Minimum telemetry:

1. Queue lag per channel and per agent.
2. Retry count, DLQ count, and replay count.
3. Ingress-to-egress latency p50/p95/p99.
4. Attachment ingest failures by type/size/mime.
5. Delivery success rate per bot and per agent.
6. Model audit fields (`provider`, `model`, `run_id`) per outbound event.
7. Traceability across hops via `trace_id`.

## Migration Plan

## Phase 0: Contract + Instrumentation (No Traffic Shift)

1. Finalize `telecom.v1` envelope and queue names.
2. Add trace/model metadata requirements in agent responses.
3. Build dashboards and alert thresholds before cutover.

Exit criteria:

1. Contract tests pass in CI.
2. Dashboards show stable metrics on synthetic traffic.

## Phase 1: Shadow Ingress

1. Adapter polls Telegram and publishes ingress events.
2. Existing pipeline remains user-facing source of truth.
3. Compare event parity and timing, no user-visible response from adapter path.

Exit criteria:

1. >=99.5% ingress parity over soak window.
2. No critical data-loss defects.

## Phase 2: Controlled Egress for Pilot Agents

1. Enable egress for 1-2 non-critical bots.
2. Keep rollback flag to legacy path per bot.
3. Exercise attachment send path and receipt tracking.

Exit criteria:

1. Delivery success >=99%.
2. DLQ <1% and no unresolved critical incidents.

## Phase 3: Scale-Out and Hardening

1. Expand to remaining bots in cohorts.
2. Tune retry/backpressure and storage lifecycle.
3. Add operator runbooks and replay drills.

Exit criteria:

1. All active bots migrated.
2. Operational SLOs stable through soak period.

## Phase 4: Legacy Path Decommission

1. Remove deprecated direct Telegram ingestion paths.
2. Freeze old interfaces and archive docs.

Exit criteria:

1. No dependency on legacy Telegram communication plane.

## Open Decisions

1. Queue substrate details for new channels (reuse existing map/list vs dedicated queue primitive).
2. Blob storage backend for first deployment (local file-backed, S3, MinIO).
3. Attachment retention policy by environment (dev/stage/prod).
4. Whether to require moderation/safety scanning at ingress by default.
5. Standardized error taxonomy for permanent vs transient failures.

## Risks and Mitigations

1. Central adapter bottleneck:
   1. Mitigate with horizontal workers + partitioning by `bot_id`.
2. Contract drift:
   1. Mitigate with schema versioning + compatibility tests.
3. Attachment cost growth:
   1. Mitigate with TTL/lifecycle and size caps.
4. Hidden operational coupling during migration:
   1. Mitigate with shadow mode and per-bot rollback switches.

## Implementation Slice Proposal (First 2 Weeks)

1. Slice A: Envelope/schema package + validation tests.
2. Slice B: Telegram adapter ingress path (text only first, attachment metadata plumbing included).
3. Slice C: Agent bridge + outbound receipt tracking.
4. Slice D: Attachment store abstraction + minimal S3/MinIO driver.
5. Slice E: Dashboards + alerts + replay command.

## Final Recommendation

Do not rewrite the entire agent framework yet.

1. First stabilize transport, observability, and secrets boundaries with this Ansible-centered plane.
2. Reassess framework rewrite only after the communications plane meets reliability targets for one full soak cycle.
