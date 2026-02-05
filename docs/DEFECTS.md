# Defects & Technical Debt

## Active Bugs

### DEF-001: Gemini provider `.filter()` crash (UPSTREAM)

- **Severity**: High
- **Status**: Open (upstream bug in `@mariozechner/pi-ai`)
- **Points**: 1 (fix is trivial, but it's in an upstream dependency)
- **Discovered**: 2026-02-04

**Symptom**: Agent replies to every message with `"⚠️ Agent failed before reply: Cannot read properties of undefined (reading 'filter')"` when using the `google-gemini-cli` provider.

**Root Cause**: `node_modules/@mariozechner/pi-ai/dist/providers/google-shared.js` line 174 calls `msg.content.filter()` without a null guard. When a `toolResult` message has `undefined` content, this crashes. The error propagates through `agent-runner-execution.ts` which converts it to a reply message.

**Affected**: Any agent using `google-gemini-cli` with `gemini-3-pro-preview` (or similar) when the session transcript contains a malformed `toolResult` entry.

**Workaround**: Reset the session with `/new` or switch to a non-Gemini provider (e.g., Anthropic Claude).

**Fix**: Needs a null guard in pi-ai: `(msg.content || []).filter(...)`. Same issue exists on line 177 for image content filtering. Should be reported/PR'd upstream to `@mariozechner/pi-ai`.

---

### DEF-002: Container hostname shows hash instead of meaningful name

- **Severity**: Low (cosmetic)
- **Status**: Open
- **Points**: 1

**Symptom**: When running inside Docker, the node ID is the container ID (e.g., `2ad9255a2f3e`) instead of the Tailscale hostname.

**Impact**: Cosmetic only — message routing works correctly regardless because the dispatcher processes all new messages.

**Workaround**: Set `hostname` in Docker compose to a meaningful name.

---

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
