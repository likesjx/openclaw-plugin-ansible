# Ansible Protocol & Reliability Notes (v1)

This document defines how to use Ansible as a dependable inter-agent communication substrate **today**, and what needs to change in the plugin for "always reliable" delivery without a human driving turns.

## Reality Check: What The Plugin Currently Does

Ansible is fundamentally a **shared, durable state store** (Yjs doc) plus optional conveniences:

- **Durable state**: messages, tasks, and context are stored in the shared Yjs doc and replicate across nodes.
- **Context injection** (optional): unread messages + shared context can be prepended to agent prompts via `before_agent_start`.
- **Auto-dispatch** (optional): new inbound messages *observed as additions* to the Yjs `messages` map can be injected into the agent loop as normal inbound turns.

Limitations that matter for "rely on this completely":

1. **Backlog dispatch**: auto-dispatch does not currently process backlog that existed before a node came online (it seeds a `seen` set with existing IDs).
2. **Retry**: auto-dispatch does not currently retry dispatch after failure. A failed message may remain unread but will not be re-dispatched automatically because it is marked `seen`.

As a result, the most reliable operating model today is:

- Treat **unread messages** as the durable inbox (source of truth).
- Use auto-dispatch as a convenience when it fires.
- Run an **operator loop** (usually the Architect agent) that periodically polls unread messages, processes them, and replies explicitly.

## Operating Models

### Model A: Architect-Managed Inbox (Recommended Today)

Goal: deterministic delivery and handling even when no "other inbound channel" events occur.

- On worker nodes: `dispatchIncoming=false` (avoid surprise full-turn dispatch).
- On operator node(s): run the operator agent (Architect) with a periodic inbox loop:
  - `ansible_status` (online + unread count)
  - `ansible_read_messages` (unread)
  - process each message
  - `ansible_send_message` back to sender (and optionally `ansible_mark_read`)

This makes Ansible behave like a durable, centralized inter-agent DM system.

### Model B: Auto-Dispatch Everywhere (Convenient, Not Fully Reliable Yet)

Goal: “messages trigger turns automatically” everywhere.

Today this is *best-effort realtime* only. Backlog and retry gaps mean it cannot be your only mechanism if you need strong guarantees.

## Coordinator Role (Preferred Naming)

"Architect-managed" is an instance of a more general concept: a **coordinator** agent/node.

The coordinator is responsible for keeping Ansible humming:
- polling unread messages deterministically
- routing requests into tasks
- chasing stale tasks
- closing loops (making sure results get back to the requester)

Coordinator selection should be explicit and shared, not implicit.

### Shared Coordinator Config (Current Implementation)

The plugin stores a small shared coordination config in the Yjs map `coordination`:
- `coordinator`: node id (e.g., `vps-jane`)
- `sweepEverySeconds`: suggested sweep cadence
- `pref:<nodeId>`: per-node preference record (`desiredCoordinator`, `desiredSweepEverySeconds`)

Tools:
- `ansible_get_coordination`
- `ansible_set_coordination_preference`
- `ansible_set_coordination` (initial setup or last-resort failover; requires `confirmLastResort=true` when switching)

## Delegation Directory (Identity.md + Shared Policy)

For delegation to happen consistently across the entire mesh, use the Delegation Directory standard:

- Canonical policy lives in shared ansible state (`coordination` map).
- Each agent keeps a local published copy in `IDENTITY.md` under `## Delegation Directory`.
- Coordinator distributes policy updates and tracks ACKs (version + checksum).

Reference:

- `docs/delegation-directory.md`
- `docs/identity-delegation-template.md`

This gives a deterministic routing contract while keeping local identity files human-auditable.

## Message Content Convention (Works With Current Schema)

Ansible messages are stored as:

- `id`, `from`, optional `to`, `content`, `timestamp`, `readBy[]`

`content` is currently free-form text. To make inter-agent comms machine-readable and audit-friendly, use a lightweight header convention:

```text
kind: request|status|result|alert|decision
priority: low|normal|high
corr: <message-id-or-short-token>   # for replies; optional for first message
thread: <short human label>         # optional

<body...>
```

Rules:

- Replies should include `corr:` referring to the originating message `id` (or a short token both parties agree on).
- For operational requests, include enough context to act without requiring shared conversational state.
- For sensitive requests, route through the operator (Architect) instead of broadcasting.

## Task Protocol (Preferred Over Ad-Hoc Requests)

Use tasks when you want explicit lifecycle:

- Create: `ansible_delegate_task`
- Claim: `ansible_claim_task`
- Progress: `ansible_update_task` (with `notify=true` for updates)
- Complete: `ansible_complete_task` (always notifies the creator)

Recommended conventions:

- Put minimal context in the task description to make it self-contained.
- Use `requires` to ensure only capable nodes claim tasks.
- Use notifications for progress/completion so the creator receives a message even if they are not polling tasks.

## Specs: What “Reliable Inter-Agent Communication” Requires (Plan)

This is the concrete plan to make auto-dispatch safe to rely on without an operator polling loop.

### 1. Backlog Dispatch On Startup

Spec:

- On dispatcher start (or `onDocReady`), scan the `messages` map for **unread messages addressed to me** (or broadcast) and dispatch them in timestamp order.
- Mark as read only when the dispatch completes successfully.

Design notes:

- Avoid “seed `seen` with all existing IDs”; instead seed only those that are already read by me, or use a persisted per-node cursor.

### 2. Retry Semantics

Spec:

- If dispatch fails:
  - Do not mark the message as read.
  - Do not permanently suppress it via `seen`.
  - Retry with bounded backoff.

Suggested state additions (minimally invasive):

- `attemptsBy: { [nodeId]: number }`
- `lastAttemptAtBy: { [nodeId]: number }`
- Optional `errorBy: { [nodeId]: string }`

### 3. Delivery Acknowledgements (Optional but Strong)

Today, `readBy[]` is “processed/handled”. It is not a delivery ack.

Spec:

- Add `deliveredTo[]` or per-recipient status to separate “replicated + visible” from “processed”.
- Keep `readBy[]` as “processed/handled”.

### 4. Operator Policy (Architect) As First-Class Mode

Spec:

- Document and support an explicit "operator mode":
  - `dispatchIncoming=false` on workers
  - `injectContextAgents=[architectAgentId]` (or inject only on operator)
- Provide a recommended polling cadence (e.g., every 30-60s) and a clear “do not miss messages” checklist.

## Current Effectiveness Summary (So Expectations Match Reality)

Today you can rely on Ansible as a durable inbox:

- Messages persist and replicate.
- Unread messages can be surfaced via context injection and `ansible_read_messages`.
- Tasks have an explicit lifecycle with notifications on completion/updates (when `notify=true`).

You should not rely on auto-dispatch as your only mechanism yet:

- Backlog dispatch is skipped on startup.
- Dispatch failures do not automatically retry.
