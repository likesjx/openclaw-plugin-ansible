# OpenClaw & Pi Internals

Reference documentation for OpenClaw's plugin system, runtime API, agent dispatch pipeline, and the Pi (`@mariozechner/pi-ai`) LLM provider abstraction. Captured during ansible plugin development.

## OpenClaw Architecture Overview

OpenClaw is a gateway that bridges external channels (Telegram, Twitch, Zalo, etc.) to LLM providers. The gateway:

1. Receives messages from channels
2. Routes them through a dispatch pipeline
3. Runs an agent turn (LLM call with tools)
4. Delivers the reply back to the originating channel

```
Channel (Telegram, Ansible, etc.)
  → Message Context (MsgContext)
    → Dispatch Pipeline
      → Agent Runner (Pi)
        → LLM Provider (Anthropic, Gemini, OpenAI, etc.)
          → Tool execution
            → Reply generation
              → Deliver callback
                → Channel reply
```

## Plugin System

### Plugin Manifest (`openclaw.plugin.json`)

Every plugin has a manifest declaring its ID, config schema, and UI hints:

```json
{
  "id": "ansible",
  "name": "Ansible",
  "version": "0.1.0",
  "configSchema": {
    "type": "object",
    "properties": { ... },
    "required": ["tier"]
  },
  "uiHints": { ... }
}
```

### Plugin Entry Point

Plugins export a `register(api)` function. The `api` object (`OpenClawPluginApi`) provides:

| Method | Purpose |
|---|---|
| `api.registerService(service)` | Register a background service (starts/stops with gateway) |
| `api.registerTool(tool)` | Register an agent-facing tool (available in LLM tool calls) |
| `api.on(hookName, handler)` | Register lifecycle hooks |
| `api.registerCli(registrar, options)` | Register CLI commands under `openclaw <pluginId>` |
| `api.pluginConfig` | The plugin's config from `openclaw.json` |
| `api.config` | The full OpenClaw configuration (all plugins, gateway settings, etc.) |
| `api.logger` | Structured logger (`.info()`, `.warn()`, `.debug()`, `.error()`) |
| `api.runtime` | Access to the channel dispatch system (undocumented, used for message dispatch) |

### Plugin Configuration

Plugin config lives in `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "<plugin-id>": {
        "enabled": true,
        "config": {
          // Plugin-specific config matching configSchema
        }
      }
    }
  }
}
```

### Services

Services are long-running background processes. They receive a `ServiceContext` with:
- `config` — OpenClaw configuration
- `workspaceDir` — Path to `~/.openclaw/workspace/`
- `stateDir` — Path to `~/.openclaw/`
- `logger` — Structured logger

Services must implement `start(ctx)` and optionally `stop(ctx)`.

### Tools

Tools are agent-facing capabilities registered via `api.registerTool()`:

```typescript
api.registerTool({
  name: "ansible.status",
  label: "Ansible Status",
  description: "Check which hemispheres are online...",
  parameters: {
    type: "object",
    properties: { ... },
    required: [],
  },
  execute: async (id, params) => { ... },
});
```

Tools appear in the LLM's tool list and can be called during agent turns. The `execute` function receives a tool call ID and parameters, and returns a result object.

### Hooks

Hooks are lifecycle events. The key hook for plugins is:

- **`before_agent_start`** — Fires before every agent turn. The handler receives the current context and can return `{ prependContext: string }` to inject text at the start of the agent prompt.

```typescript
api.on("before_agent_start", async (ctx) => {
  return { prependContext: "<ansible-context>...</ansible-context>" };
});
```

Multiple plugins can register `before_agent_start` handlers. OpenClaw merges all `prependContext` values together.

### CLI Commands

CLI commands are registered under the plugin's namespace:

```typescript
api.registerCli?.((ctx) => {
  const ansible = ctx.program.command("ansible").description("Ansible mesh management");
  ansible.command("status").description("Show network health").action(async () => { ... });
}, { commands: ["ansible"] });
```

This makes commands available as `openclaw ansible status`, `openclaw ansible send`, etc.

## Runtime Channel API

The runtime API (`api.runtime`) is the internal dispatch system. It's not part of the documented plugin SDK but is available on the real `api` object at runtime. This is how plugins dispatch messages into the agent loop — the same mechanism used by built-in channels.

### `api.runtime.channel.reply`

| Method | Purpose |
|---|---|
| `formatAgentEnvelope(opts)` | Format a message with channel/sender/timestamp headers |
| `resolveEnvelopeFormatOptions(cfg)` | Resolve envelope formatting config |
| `finalizeInboundContext(ctx)` | Normalize a `MsgContext` with defaults (sets missing fields) |
| `dispatchReplyWithBufferedBlockDispatcher(opts)` | Trigger a full agent turn and deliver the reply |

### `api.runtime.channel.session`

| Method | Purpose |
|---|---|
| `recordInboundSession(opts)` | Record session metadata (session key, store path, etc.) |
| `resolveStorePath()` | Resolve the session store file path |

### MsgContext Fields

The `MsgContext` object represents an inbound message. Key fields:

| Field | Example | Purpose |
|---|---|---|
| `Body` | Formatted envelope text | What the agent sees as the message |
| `RawBody` | Raw message content | Unformatted content |
| `CommandBody` | Raw message content | Content for command parsing |
| `From` | `ansible:vps-jane` | Sender identifier |
| `To` | `ansible:mac-jane` | Recipient identifier |
| `SessionKey` | `ansible:vps-jane` | Session isolation key |
| `Provider` | `"ansible"` | Channel provider name |
| `Surface` | `"ansible"` | UI surface identifier |
| `ChatType` | `"direct"` | Chat type (direct, group, etc.) |
| `SenderName` | `vps-jane` | Human-readable sender name |
| `SenderId` | `vps-jane` | Unique sender ID |
| `MessageSid` | UUID | Unique message ID |
| `OriginatingChannel` | `"ansible"` | Source channel |
| `OriginatingTo` | `ansible:vps-jane` | Reply-to address |

### Dispatch Flow

To dispatch a message into the agent loop (same pattern as Telegram, Twitch, Zalo):

```typescript
// 1. Format envelope
const body = reply.formatAgentEnvelope({ channel, from, timestamp, envelope, body });

// 2. Build and finalize context
const ctx = reply.finalizeInboundContext({ Body: body, From, To, SessionKey, ... });

// 3. Record session
await session.recordInboundSession({ storePath, sessionKey, ctx, onRecordError });

// 4. Dispatch (triggers full agent turn)
await reply.dispatchReplyWithBufferedBlockDispatcher({
  ctx,
  cfg,
  dispatcherOptions: {
    deliver: async (payload, info) => {
      // info.kind: "block" (intermediate) or "final" (last reply)
      // payload.text: the agent's reply text
    },
    onError: (err, info) => { ... },
  },
});
```

The `deliver` callback is called once per reply block. For streaming, intermediate blocks have `info.kind === "block"` and the last has `info.kind === "final"`. Most plugins only act on `"final"`.

## Agent Execution Pipeline

### Dispatch Pipeline (from channel to agent)

```
dispatchReplyWithBufferedBlockDispatcher()
  → dispatchInboundMessageWithBufferedDispatcher()
    → command-queue (lane system) — serializes concurrent requests
      → dispatchReplyFromConfig()
        → getReplyFromConfig()
          → runPreparedReply() — the actual agent execution
```

### Lane/Queue System (`command-queue.ts`)

The command queue serializes agent turns to prevent concurrent execution on the same session. Key behavior:

- Each session gets its own "lane"
- New messages queue behind in-progress turns
- `lane task done` is logged when a turn completes
- The resolved result propagates back up the dispatch chain

### Agent Runner

The agent runner uses Pi (`@mariozechner/pi-ai`) to execute LLM calls:

1. Build the prompt (system + context + messages)
2. Call the LLM provider with tools
3. Process tool calls if any
4. Return the final response

Errors during execution are caught in `agent-runner-execution.ts` (lines 499-589) and converted to reply text:
```
"⚠️ Agent failed before reply: <error message>.\nLogs: openclaw logs --follow"
```

This is why LLM provider errors (like the Gemini `.filter()` bug) show up as actual message replies — the error-to-reply conversion is intentional for user visibility.

### Session Transcripts

Session transcripts are stored as JSONL files at:
```
~/.openclaw/agents/<agent-name>/sessions/<session-id>.jsonl
```

Each line is a JSON object with role, content, provider info, and metadata. When `stopReason` is `"error"`, the `errorMessage` field contains the error text.

## Pi (LLM Provider Abstraction)

OpenClaw uses `@mariozechner/pi-ai` as its LLM provider abstraction layer. Pi normalizes different LLM APIs behind a common interface.

### Built-in Providers

| Provider | API Type | Notes |
|---|---|---|
| Anthropic | Native | Claude models |
| OpenAI | Native | GPT models |
| Google Gemini CLI | Native | `google-gemini-cli` in config |
| GitHub Copilot | OpenAI-compatible | |
| Bedrock | AWS SDK | |
| MiniMax, Moonshot, Qwen, Xiaomi | OpenAI-compatible | |
| Venice, Ollama | OpenAI-compatible | Local/self-hosted |
| Synthetic | Custom | HuggingFace via `hf:` URI scheme |

### Custom Providers

Custom providers use `openai-completions` API type with an OpenAI-compatible endpoint:

```jsonc
{
  "providers": {
    "my-provider": {
      "apiType": "openai-completions",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "...",
      "models": ["model-name"]
    }
  }
}
```

### Known Bug: Gemini `.filter()` Crash

**Location**: `node_modules/@mariozechner/pi-ai/dist/providers/google-shared.js`, line 174

```javascript
const textContent = msg.content.filter((c) => c.type === "text");
```

When `msg.content` is `undefined` (which can happen for `toolResult` role messages), this throws:
```
Cannot read properties of undefined (reading 'filter')
```

**Impact**: Any agent using `google-gemini-cli` provider will crash on affected sessions. The error propagates through the agent runner error handling and appears as a reply: `"⚠️ Agent failed before reply: Cannot read properties of undefined (reading 'filter')"`.

**Workaround**: Reset the session with `/new` or switch to a non-Gemini provider.

**Fix**: The line needs a null guard: `const textContent = (msg.content || []).filter(...)`. This is an upstream bug in pi-ai, not in OpenClaw or the ansible plugin.

## Skills System

Skills are markdown files that get injected into the agent's system prompt. They live in:
```
~/.openclaw/workspace/skills/<skill-name>/SKILL.md
```

The `SKILL.md` file has YAML frontmatter with `name` and `description`, followed by markdown instructions. OpenClaw loads all skills at gateway startup and includes them in every agent turn.

Skills are purely instructional — they don't register tools or services. They teach the agent behavioral patterns for using existing tools.

## Key File Paths

| Path | Purpose |
|---|---|
| `~/.openclaw/openclaw.json` | Main configuration |
| `~/.openclaw/logs/gateway.log` | Gateway logs (structured JSON) |
| `~/.openclaw/agents/<name>/sessions/` | Session transcripts (JSONL) |
| `~/.openclaw/workspace/skills/` | Skills directory |
| `~/.openclaw/ansible-state.yjs` | Ansible CRDT state persistence |

## Port Architecture

| Port | Protocol | Purpose |
|---|---|---|
| 18789 | JSON WebSocket | OpenClaw gateway — agent communication |
| 1235 | Binary y-websocket | Ansible plugin — Yjs CRDT sync |

These are completely separate protocols. Never mix them.
