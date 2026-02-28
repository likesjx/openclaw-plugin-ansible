# Defects & Technical Debt

## Active Bugs

### DEF-001: Plugin tool results crash pi-ai providers (FIXED + UPSTREAM)

- **Severity**: High
- **Status**: Fixed in plugin (fdb0577); upstream pi-ai still lacks null guard
- **Points**: 3
- **Discovered**: 2026-02-04
- **Fixed**: 2026-02-05

**Symptom**: Agent replies with `"Cannot read properties of undefined (reading 'filter')"` after any ansible tool call. Affects ALL providers (OpenRouter, Gemini, etc.), not just one.

**Root Cause (plugin side)**: Plugin tools returned plain objects `{ success: true, ... }` instead of the `AgentToolResult` format expected by pi-agent-core: `{ content: [{type: "text", text: "..."}], details: T }`. This caused the `toolResult` session entry to have no `content` field. When pi-ai built the next LLM request, `toolMsg.content.filter(...)` (`openai-completions.js` line 578) crashed on `undefined`.

**Root Cause (upstream)**: pi-ai's provider code (`openai-completions.js` line 578, `google-shared.js` line 174) calls `.filter()` on `toolMsg.content` without a null guard. Even with the plugin fix, any other tool that returns the wrong format would trigger the same crash.

**Fix (applied)**: All ansible tool `execute()` methods now return `{ content: [{type: "text", text: JSON.stringify(data)}], details: data }` via the `toolResult()` helper.

**Remaining upstream**: pi-ai should add `(toolMsg.content || []).filter(...)` guards. Should be reported/PR'd to `@mariozechner/pi-ai`.

---

### DEF-002: Container hostname shows hash instead of meaningful name

- **Severity**: Low (cosmetic)
- **Status**: Open
- **Points**: 1

**Symptom**: When running inside Docker, the node ID is the container ID (e.g., `2ad9255a2f3e`) instead of the Tailscale hostname.

**Impact**: Cosmetic only — message routing works correctly regardless because the dispatcher processes all new messages.

**Workaround**: Set `hostname` in Docker compose to a meaningful name.

---

### DEF-003: Auto-dispatch is not backlog-safe and not retry-safe (DESIGN GAP)

- **Severity**: High (reliability)
- **Status**: Open
- **Points**: 5

**Symptom**:
- Messages that arrive while a node is offline do not trigger a turn when the node comes online (unless a separate turn happens for another reason).
- If the dispatch pipeline errors, the message may remain unread but will not be automatically retried.

**Root cause**:
- The dispatcher seeds a `seen` set with all existing message IDs on startup, so it intentionally skips backlog.
- The dispatcher also suppresses re-processing of message IDs once `seen`, even if the dispatch failed.

**Impact**:
Best-effort realtime auto-dispatch is convenient, but it cannot be treated as a sole transport if you need “always reliable” inter-agent communication without a polling operator.

**Workaround (recommended today)**:
Use the **Architect-managed inbox** operating model:
- `dispatchIncoming=false` on worker nodes.
- Operator agent polls `ansible_read_messages` and replies via `ansible_send_message`.

**Fix (planned)**:
Implement startup backlog dispatch + retry semantics, as specified in `docs/protocol.md`.

---

### DEF-004: Pulse/heartbeat status can show node offline while messaging still works

- **Severity**: Medium (observability accuracy)
- **Status**: Open
- **Points**: 3
- **Discovered**: 2026-02-28

**Symptom**:
- `ansible status` / `ansible nodes` may briefly report a node (notably `vps-jane`) as `offline`.
- During the same period, directed messages are still delivered successfully end-to-end.

**Impact**:
- Operator confidence issue: status board can imply a connectivity outage when transport is actually healthy.
- Can cause unnecessary triage noise.

**Workaround**:
- Validate liveness with a directed message test (`ansible send` + inbox/read/dump confirmation) before treating it as a transport incident.

**Fix (planned)**:
- Review pulse write cadence and stale threshold interaction.
- Ensure heartbeat updates are not starved by gateway lifecycle/restart edges.
- Consider decoupling “transport reachable” from “recent pulse timestamp” in status rendering.

## Technical Debt

### TD-001: Type stubs vs. real OpenClaw SDK types

- **Severity**: Low
- **Points**: 3

The plugin uses stub types in `src/types.ts` that mirror a subset of the real OpenClaw plugin API. Runtime access to `api.runtime.channel.*` requires `as any` casts. When OpenClaw publishes a proper plugin SDK package, these stubs should be replaced with the real types.

### TD-002: No automated tests

- **Severity**: Medium
- **Points**: 5

The plugin has no unit or integration tests. Key areas to test:
- Dispatcher message filtering (own messages, addressed to other nodes, already read)
- MsgContext construction
- Yjs document operations (message write, read, mark-read)
- Service start/stop lifecycle

### TD-003: Old analysis files in repo root

- **Severity**: Low
- **Points**: 1

`ANSIBLE-ANALYSIS.md`, `ANSIBLE-ARCHITECTURE.md`, `ANSIBLE-PLAN.md`, and `DEBUG_STATUS.md` are development artifacts from the initial build. They've been superseded by `docs/architecture.md` and `docs/openclaw-internals.md`. Should be cleaned up or moved to a `docs/archive/` directory.
