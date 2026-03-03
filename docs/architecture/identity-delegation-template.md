# Identity.md Delegation Section Template

Copy this section into each agent's `IDENTITY.md`.

## Delegation Directory

```yaml
delegationPolicyVersion: 2026-02-12.1
delegationPolicyChecksum: sha256:REPLACE_ME
delegationUpdatedAt: "2026-02-12T18:00:00Z"
delegationUpdatedBy: "vps-jane"
```

| intent | owner_agent | backup_agent | requires | sla_claim_sec | sla_update_sec | escalate_after_sec | close_notify |
|---|---|---|---|---:|---:|---:|---|
| github_issue_ops | vps-jane | architect | always-on,github | 120 | 600 | 1800 | requester,coordinator |
| docs_architecture | architect | vps-jane | local-files,reasoning | 300 | 900 | 3600 | requester |
| gateway_recovery | vps-jane | architect | always-on,ops | 60 | 300 | 900 | requester,coordinator |

```yaml
defaultEscalation:
  unavailableOwnerAction: "assign_backup"
  missingBackupAction: "notify_coordinator_only"
  maxAutoReassignments: 1
  suppressNoopReports: true
```

```yaml
appliedBy:
  agentId: "REPLACE_WITH_THIS_AGENT"
  appliedAt: "2026-02-12T18:05:00Z"
  sourceVersion: "2026-02-12.1"
  sourceChecksum: "sha256:REPLACE_ME"
```
