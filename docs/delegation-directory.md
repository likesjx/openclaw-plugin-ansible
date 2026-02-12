# Delegation Directory Standard (Identity.md + Ansible Distribution)

This standard makes delegation deterministic across all agents/gateways.

## Design Principle

- **Canonical source of truth**: Ansible shared state (Yjs `coordination` map).
- **Human-readable local copy**: each agent's `IDENTITY.md` delegation section.
- **Distribution**: coordinator publishes version updates through Ansible and verifies ACKs.

Why this split:

- Markdown-only policies drift.
- Shared state alone is hard for humans to inspect quickly.
- Keeping both gives reliability + clarity.

## Identity.md Contract

Each agent `IDENTITY.md` must include exactly one section:

`## Delegation Directory`

It must contain:

1. Metadata block
2. Delegation routing table
3. Escalation defaults
4. Ack metadata (last applied policy version/checksum)

### Metadata Block

```yaml
delegationPolicyVersion: 2026-02-12.1
delegationPolicyChecksum: sha256:REPLACE_ME
delegationUpdatedAt: "2026-02-12T18:00:00Z"
delegationUpdatedBy: "vps-jane"
```

### Routing Table Schema

| intent | owner_agent | backup_agent | requires | sla_claim_sec | sla_update_sec | escalate_after_sec | close_notify |
|---|---|---|---|---:|---:|---:|---|

Field definitions:

- `intent`: stable routing key (snake_case). Must be unique.
- `owner_agent`: primary assignee.
- `backup_agent`: fallback when owner unavailable.
- `requires`: comma-separated capabilities (or empty).
- `sla_claim_sec`: max seconds from task creation to claim.
- `sla_update_sec`: max seconds between progress updates while in progress.
- `escalate_after_sec`: max seconds before coordinator escalates/reassigns.
- `close_notify`: comma-separated recipients (`requester`, `coordinator`, optional explicit agent IDs).

### Example Rows

| intent | owner_agent | backup_agent | requires | sla_claim_sec | sla_update_sec | escalate_after_sec | close_notify |
|---|---|---|---|---:|---:|---:|---|
| github_issue_ops | vps-jane | architect | always-on,github | 120 | 600 | 1800 | requester,coordinator |
| docs_architecture | architect | vps-jane | local-files,reasoning | 300 | 900 | 3600 | requester |
| gateway_recovery | vps-jane | architect | always-on,ops | 60 | 300 | 900 | requester,coordinator |

### Escalation Defaults

```yaml
defaultEscalation:
  unavailableOwnerAction: "assign_backup"
  missingBackupAction: "notify_coordinator_only"
  maxAutoReassignments: 1
  suppressNoopReports: true
```

## Canonical Shared State Keys (coordination map)

Coordinator writes:

- `delegationPolicyVersion`
- `delegationPolicyChecksum`
- `delegationPolicyMarkdown` (canonical rendered table + metadata)
- `delegationPolicyUpdatedAt`
- `delegationPolicyUpdatedBy`

Per-agent ACK keys:

- `delegationAck:<agentId>:version`
- `delegationAck:<agentId>:checksum`
- `delegationAck:<agentId>:at`

## Distribution Protocol

1. Coordinator updates canonical policy in shared state.
2. Coordinator emits targeted Ansible message to each agent:
   - `kind: policy_update`
   - `policyVersion`, `policyChecksum`
   - instruction to apply/update local `IDENTITY.md` section.
3. Agent applies/update section, then replies ACK:
   - `kind: policy_ack`
   - same `policyVersion`, `policyChecksum`
4. Coordinator records ACK under `delegationAck:*`.
5. Sweep reports only actionable exceptions:
   - missing ACK after threshold
   - checksum/version mismatch
   - invalid table row detected

## Coordinator Sweep Validation Rules

Run during normal sweep cadence:

1. **Schema validation**
   - required columns present
   - unique `intent`
   - numeric SLA fields are positive
2. **Coverage validation**
   - every active intent has `owner_agent`
   - if `backup_agent` empty, emit single degraded warning (actionable)
3. **Runtime enforcement**
   - create tasks with `assignedTo=owner_agent`
   - if claim SLA missed, reassign once to `backup_agent`
   - always notify requester on terminal state
4. **Close-the-loop guarantee**
   - completion/failed must send final status to requester
   - if notify fails, retry with backoff

## Noise Policy

Do not emit periodic "all good" delegation messages.

Only report:

- invalid policy schema
- missing ACKs beyond threshold
- SLA breach with real routing action taken
- unresolved close-the-loop failure after retries

## Minimal Rollout Plan

1. Publish this standard.
2. Add Delegation Directory section to each `IDENTITY.md`.
3. Coordinator publishes version `YYYY-MM-DD.N`.
4. Verify ACKs from all active agents.
5. Start strict sweep enforcement for SLA and close-the-loop.

