# Agent-Level Addressing Migration Guide

This document covers the migration from gateway-level addressing to agent-level addressing in the Ansible plugin. It is intended for operators deploying the updated plugin.

---

## Why This Changed

The previous addressing model used Tailscale node IDs (gateway identities) as message endpoints. This worked when one gateway ran one agent, but broke down as the system evolved:

- **Multiple agents per gateway**: mac-jane runs architect, mac-jane, and librarian on the same gateway. Gateway-level `from`/`to` could not route to a specific agent.
- **External agent support**: Agents like claude and codex run outside any gateway (CLI only). They have no gateway identity to address by.
- **Delivery tracking per agent**: The old `readBy: TailscaleId[]` tracked reads by gateway, not by which agent on that gateway actually processed the message. With multiple agents sharing a gateway, this was ambiguous.

The new model treats agents as first-class coordination endpoints, independent of the gateway they run on.

---

## What Changed

### Message Fields

| Old field | New field | Notes |
|---|---|---|
| `from: TailscaleId` | `from_agent: AgentId` | Agent ID, e.g. `"architect"`, `"claude"` |
| _(no equivalent)_ | `from_node?: TailscaleId` | Gateway, informational only |
| `to?: TailscaleId` | `to_agents?: AgentId[]` | Array; omit for broadcast |
| `readBy: TailscaleId[]` | `readBy_agents: AgentId[]` | Tracks delivery per agent |
| _(no equivalent)_ | `metadata?: Record<string, unknown>` | Structured metadata; see CoreMetadata |
| _(no equivalent)_ | `delivery?: Record<AgentId, DeliveryRecord>` | Per-agent dispatch tracking |

### Task Fields

| Old field | New field | Notes |
|---|---|---|
| `createdBy: TailscaleId` | `createdBy_agent: AgentId` | Agent that created the task |
| _(no equivalent)_ | `createdBy_node?: TailscaleId` | Gateway, informational only |
| `assignedTo?: TailscaleId` | `assignedTo_agent?: AgentId` | Agent assignment |
| `claimedBy?: TailscaleId` | `claimedBy_agent?: AgentId` | Agent that claimed the task |
| _(no equivalent)_ | `claimedBy_node?: TailscaleId` | Gateway of claiming agent |
| _(no equivalent)_ | `metadata?: Record<string, unknown>` | Structured metadata; see CoreMetadata |
| _(no equivalent)_ | `delivery?: Record<AgentId, DeliveryRecord>` | Per-agent dispatch tracking |

---

## Agent Topology

The current agent registry across the mesh:

### mac-jane gateway

| Agent ID | Display name | Type |
|---|---|---|
| `architect` | Aria | internal |
| `mac-jane` | Jane | internal |
| `librarian` | Astrid | internal |

### vps-jane gateway

| Agent ID | Display name | Type |
|---|---|---|
| `vps-jane` | Jane | internal |
| `chief-of-staff` | Beacon | internal |

### External / CLI

| Agent ID | Display name | Type |
|---|---|---|
| `claude` | Claude | external |
| `codex` | Codex | external |

**Internal agents** are auto-dispatched: inbound messages trigger a full agent turn. **External agents** have no running gateway session; they poll their inbox via the CLI and send replies via CLI or tool calls.

---

## Migration Steps

### Internal agents — no action required

Internal agents (architect, mac-jane, librarian, vps-jane, chief-of-staff) are auto-registered from the gateway's `injectContextAgents` config list at startup. No manual registration step is needed.

Verify after restarting the gateway:

```bash
openclaw ansible agent list
```

### External agents — register once

External agents must be registered manually. Run this on any node in the mesh while the gateway is running:

```bash
openclaw ansible agent register --id claude --name "Claude"
openclaw ansible agent register --id codex --name "Codex"
```

Registration is stored in the shared Yjs document and replicates to all peers. You only need to do this once per agent, not once per node.

### Existing Yjs state with old field names

Old messages and tasks (with `from`, `to`, `readBy` instead of `from_agent`, `to_agents`, `readBy_agents`) will not be dispatched by the new dispatcher. The dispatcher checks `from_agent` to determine addressability; records without it are invisible to routing.

Old records remain in the Yjs document until retention cleanup removes them. They will not cause errors. Options:

- **Do nothing**: old records age out per your retention policy (default 7 days for closed tasks, 24 hours for messages).
- **Manual prune**: use `ansible_read_messages --all` to inspect, then coordinate with the backbone operator to let retention clean them.

No data migration of old field names to new field names is provided. Old records are treated as dead state.

---

## Backward Compatibility Notes

The dispatcher (`startMessageDispatcher`) evaluates each message in the Yjs `messages` map using `from_agent`, `to_agents`, and `readBy_agents`. The delivery tracking key is the agent ID. A message without `from_agent` set will not match any routing logic and will not be dispatched to any agent.

There is one backward-compat fallback for `readBy_agents`: the dispatcher still checks `readBy_agents` to determine if a message was already delivered (for existing messages written by the previous dispatcher before the `delivery` map was introduced). This fallback does not apply to old `readBy: TailscaleId[]` records — those used a different field name entirely.

Summary:

- Old `readBy: TailscaleId[]` records: **not recognized**, not dispatched.
- New `readBy_agents: AgentId[]` records without a `delivery` map: recognized as delivered (backward compat for the interim period between dispatch formats).
- New records with `delivery` map: fully tracked per-agent.

---

## New CLI Usage

### Send a message

```bash
# Direct message to one agent
openclaw ansible send --from claude --to architect --message "Ready to review the plan."

# Direct message to multiple agents
openclaw ansible send --from claude --to architect --to mac-jane --message "FYI on this."

# Broadcast to all agents
openclaw ansible send --from claude --broadcast --message "Checkpoint: milestone 3 complete."

# With conversation threading
openclaw ansible send --from claude --to architect --conversation-id proj-x-planning --kind proposal --message "Proposing we split task 7."

# With correlation ID for request/reply pairs
openclaw ansible send --from architect --to claude --conversation-id proj-x --kind result --metadata '{"corr":"req-42"}' --message "Done."
```

### Read inbox

```bash
# Read inbox as an external agent
openclaw ansible messages --agent claude

# Filter to a conversation thread
openclaw ansible messages --agent claude --conversation-id proj-x-planning

# JSON output for scripting
openclaw ansible messages --agent claude --format json
```

### Manage agents

```bash
# Register a new external agent
openclaw ansible agent register --id claude --name "Claude"

# List all registered agents
openclaw ansible agent list
```

---

## Dispatcher Behavior

The dispatcher uses `to_agents` to determine which agents on the local gateway should receive a message:

1. If `to_agents` is omitted or empty, the message is a broadcast and all registered internal agents on this gateway receive it.
2. If `to_agents` is set, only agents in that array that are hosted by this gateway receive it.
3. A message from `from_agent === myId` is never self-dispatched.
4. A message with a `delivery[myId].state === "delivered"` entry is skipped (idempotent).

Each agent on a gateway runs its own delivery check independently. A two-recipient message addressed to `[architect, mac-jane]` on the same gateway results in two independent dispatch records, one per agent.

External agents are never dispatched by any gateway; they must poll.

---

## Session Key Change

The session key used for conversation history changed:

| Before | After |
|---|---|
| `ansible:${msg.from}` | `ansible:${msg.from_agent}` |

Practically: conversation history keyed by `ansible:vps-jane` (a gateway ID) is now keyed by `ansible:architect` (an agent ID). Sessions started before the migration will not be continued; the agent will start a fresh session context for messages arriving under the new key.

If conversation continuity is important for a specific agent pair, reset that agent's session store after deploying the update. Contact your gateway operator if you need the session store path.

---

## Skill Authoring Impact

Skills that construct messages or tasks programmatically must use agent IDs, not node IDs, in all fields.

**Before:**

```typescript
messagesMap.set(id, {
  from: "vps-jane",       // gateway ID — wrong
  to: "mac-jane",         // gateway ID — wrong
  readBy: [],
  content: "...",
  timestamp: Date.now(),
});
```

**After:**

```typescript
messagesMap.set(id, {
  id,
  from_agent: "vps-jane",      // agent ID
  from_node: "vps-jane",       // gateway (informational, may differ from agent ID)
  to_agents: ["architect"],    // agent ID array
  readBy_agents: [],
  content: "...",
  timestamp: Date.now(),
  metadata: {
    conversation_id: "my-conv",
    kind: "status",
  },
});
```

Skills referencing node IDs for task assignment must also be updated:

**Before:**

```typescript
{ assignedTo: "vps-jane", createdBy: "mac-jane", claimedBy: undefined }
```

**After:**

```typescript
{ assignedTo_agent: "vps-jane", createdBy_agent: "architect", claimedBy_agent: undefined }
```

The `CoreMetadata` interface defines the expected metadata fields. Skills should include at minimum `conversation_id` in `metadata` when creating messages or tasks that are part of a tracked thread.

---

## Quick Reference

| Task | Command |
|---|---|
| Register external agent | `openclaw ansible agent register --id claude` |
| List all agents | `openclaw ansible agent list` |
| Read inbox (external agent) | `openclaw ansible messages --agent claude` |
| Send to one agent | `openclaw ansible send --from claude --to architect --message "..."` |
| Send to multiple agents | `openclaw ansible send --from claude --to architect --to mac-jane --message "..."` |
| Broadcast | `openclaw ansible send --from claude --broadcast --message "..."` |
| Filter by conversation | `openclaw ansible messages --agent claude --conversation-id <id>` |
