# Ansible Layer Architecture

## Overview

Ansible is a distributed coordination layer that enables a **single agent identity** ("Jane") to operate across multiple OpenClaw instances. Unlike multi-agent systems where independent agents collaborate, Ansible creates **one agent with multiple bodies**—each instance shares the same personality, knowledge, and context.

```
              ┌─────────────────────────────┐
              │      "Jane" (singular)      │
              │  • Consistent personality   │
              │  • Shared context           │
              │  • Unified knowledge        │
              └─────────────────────────────┘
                     │           │
           ┌─────────┘           └─────────┐
           ▼                               ▼
    ┌─────────────┐                 ┌─────────────┐
    │  Mac Body   │                 │  VPS Body   │
    │  (edge)     │                 │  (backbone) │
    └─────────────┘                 └─────────────┘
```

---

## Network Topology

### Two-Tier Architecture

```
        ┌─────────────────────────────────────┐
        │      Always-On Backbone (VPS)       │
        │                                     │
        │   VPS-1 ◄──── peer-to-peer ────► VPS-2
        │     ▲                             ▲  │
        └─────┼─────────────────────────────┼──┘
              │                             │
              └──────────┬──────────────────┘
                         │
                         ▼
                ┌─────────────────┐
                │   Edge (Mac)    │
                │   (intermittent)│
                └─────────────────┘
```

| Tier | Nodes | Behavior |
|------|-------|----------|
| **Backbone** | VPS instances | Always on, full mesh sync, hold authoritative state |
| **Edge** | Mac, laptops | Connect when available, sync to any backbone peer, work offline |

### Transport: Tailscale

- WireGuard-based mesh VPN
- Direct peer-to-peer connections (no relay needed when possible)
- Cryptographic node identity built-in
- MagicDNS for human-readable addressing (`vps-jane.tail`, `macbook.tail`)

---

## Authentication & Onboarding

### Identity Model

- **Primary ID**: Tailscale node identity (cryptographically verified)
- **No separate auth tokens**: Tailscale provides network-level authentication
- **Application-level allowlist**: Only authorized nodes can participate in Ansible sync

### Onboarding Flow

```
┌─────────────────────────────────────────────────────────┐
│ 1. NETWORK ONBOARDING                                   │
├─────────────────────────────────────────────────────────┤
│  New node joins Tailscale network                       │
│  → Gets identity: "vps-2" @ 100.64.x.x                  │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ 2. ANSIBLE INVITATION (backbone only)                   │
├─────────────────────────────────────────────────────────┤
│  $ openclaw ansible invite vps-2 --tier backbone        │
│  → Generates single-use bootstrap token (15 min TTL)    │
│  → Prints config snippet for new node                   │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│ 3. NEW NODE JOINS                                       │
├─────────────────────────────────────────────────────────┤
│  $ openclaw ansible join --token <bootstrap-token>      │
│  → Connects to backbone, verifies token                 │
│  → Registers Tailscale identity in authorized_nodes     │
│  → Begins sync                                          │
└─────────────────────────────────────────────────────────┘
```

### Authorization Rules

- Only **backbone nodes** can invite new nodes
- Edge nodes cannot invite (higher compromise risk)
- Revocation: `openclaw ansible revoke <node-id>` removes from allowlist immediately

---

## Plugin Architecture

Ansible is implemented as a single OpenClaw plugin leveraging the existing plugin system.

### Plugin Capabilities Used

| OpenClaw Feature | Ansible Usage |
|------------------|---------------|
| `api.registerService()` | Persistent Yjs sync connection |
| `before_agent_start` hook | Inject shared context into system prompt |
| `api.registerTool()` | Agent tools: `ansible.send_message`, `ansible.delegate_task` |
| `api.registerCli()` | CLI commands: `ansible status`, `ansible invite`, `ansible revoke` |
| `api.registerGatewayMethod()` | RPC for UI status queries |
| `stateDir` | Persist Yjs state across restarts |

### Configuration

```yaml
# openclaw.yaml
plugins:
  ansible:
    tier: backbone          # or "edge"
    listenPort: 1234        # backbone only
    backbonePeers:          # for edge nodes
      - ws://vps-jane.tail:1234
      - ws://vps-2.tail:1234
```

### Plugin Structure

```
openclaw-plugin-ansible/
├── src/
│   ├── index.ts           # Plugin entry, register()
│   ├── service.ts         # Yjs sync (backbone server or edge client)
│   ├── hooks.ts           # before_agent_start context injection
│   ├── tools.ts           # Agent-facing tools
│   ├── cli.ts             # CLI commands
│   └── schema.ts          # TypeScript types for shared state
├── openclaw.plugin.json
└── package.json
```

---

## Data Architecture

### Division of Responsibility

```
┌─────────────────────────────────────────────────────────┐
│                    GitHub (existing)                     │
│  memory/*.md - durable knowledge, preferences, facts     │
│  • Versioned, persistent                                 │
│  • Pulled on startup, pushed on significant changes      │
│  • Indexed locally by OpenClaw memory system             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                    Ansible (new)                         │
│  Real-time coordination via Yjs CRDT:                    │
│  • tasks      - delegate work between bodies             │
│  • messages   - inter-hemisphere communication           │
│  • context    - current focus, active threads            │
│  • pulse      - health, presence, status                 │
│  • nodes      - authorized node registry                 │
└─────────────────────────────────────────────────────────┘
```

### Ansible State Schema

```typescript
interface AnsibleState {
  // === Authorization ===
  nodes: YMap<TailscaleId, {
    name: string;                    // "vps-jane", "macbook-air"
    tier: "backbone" | "edge";
    addedBy: TailscaleId;
    addedAt: number;
  }>;

  pendingInvites: YMap<Token, {
    tier: "backbone" | "edge";
    expiresAt: number;
    createdBy: TailscaleId;
  }>;

  // === Coordination ===
  tasks: YMap<TaskId, {
    id: string;
    title: string;
    description: string;
    status: "pending" | "claimed" | "in_progress" | "completed" | "failed";
    createdBy: TailscaleId;
    createdAt: number;
    assignedTo?: TailscaleId;        // Explicit assignment
    requires?: string[];             // Capability requirements: ["always-on", "gpu"]
    claimedBy?: TailscaleId;
    claimedAt?: number;
    completedAt?: number;
    result?: string;
    context?: string;                // Transferred context for delegation
  }>;

  messages: YMap<MessageId, {
    id: string;
    from: TailscaleId;
    to?: TailscaleId;                // Optional: broadcast if omitted
    content: string;
    timestamp: number;
    readBy: TailscaleId[];           // Track who has read (for retention)
  }>;

  // === Live Context (per-node to avoid conflicts) ===
  context: YMap<TailscaleId, {
    currentFocus: string;            // "Designing Ansible architecture"
    activeThreads: Array<{
      id: string;
      summary: string;
      lastActivity: number;
    }>;
    recentDecisions: Array<{
      decision: string;
      reasoning: string;
      madeAt: number;
    }>;
  }>;

  // === Health ===
  pulse: YMap<TailscaleId, {
    lastSeen: number;
    status: "online" | "busy" | "offline";
    currentTask?: string;
    version?: string;
  }>;
}
```

---

## Sync Architecture

### Backbone Mesh (Peer-to-Peer)

```
VPS-1                           VPS-2
  │                               │
  │◄─────── Yjs updates ─────────►│
  │      (bidirectional)          │
  │                               │
  ├─ WebSocket server (:1234)     ├─ WebSocket server (:1234)
  └─ WebSocket client (to VPS-2)  └─ WebSocket client (to VPS-1)
```

- Each backbone node runs a WebSocket server AND connects as client to peers
- Yjs CRDTs merge automatically—no conflict resolution needed
- Either node can go down; the other continues operating

### Edge Sync (Client Only)

```
Mac (Edge)
  │
  ├─ Connect to any backbone peer
  │  (failover if unreachable)
  │
  ├─ Sync Yjs state
  │
  └─ Work offline with local state
     (merge on reconnect)
```

- Edge nodes only connect as clients (no server)
- Connect to first available backbone peer
- Local Yjs state persists in `stateDir`
- Reconnect + merge when back online

---

## Agent Integration

### Context Injection

Via `before_agent_start` hook, inject shared context into every agent turn:

```typescript
// hooks.ts
api.registerHook("before_agent_start", async (event, ctx) => {
  const state = await getAnsibleState();
  const myId = getMyTailscaleId();
  const myContext = state.context.get(myId);
  const otherContexts = getOtherContexts(state, myId);

  const prependContext = `
<ansible-context>
## What Jane is Working On
- **${myId}** (me): ${myContext?.currentFocus || "No active focus"}
${otherContexts.map(c => `- **${c.nodeId}**: ${c.currentFocus}`).join('\n')}

## My Active Threads
${(myContext?.activeThreads || []).slice(0, 3).map(t => `- ${t.summary}`).join('\n')}

## Recent Decisions
${(myContext?.recentDecisions || []).slice(0, 3).map(d =>
  `- ${d.decision} (${d.reasoning})`
).join('\n')}

## Pending Tasks for Me
${getMyPendingTasks(state, myId).slice(0, 5).map(t => `- ${t.title}`).join('\n')}

## Unread Messages
${getUnreadMessages(state, myId).slice(0, 5).map(m =>
  `- From ${m.from}: ${m.content}`
).join('\n')}
</ansible-context>
`;

  return { prependContext };
});
```

### Agent Tools

```typescript
// tools.ts

// Delegate a task to another hemisphere
ansible.delegate_task({
  title: "Research Yjs persistence options",
  description: "...",
  context: "Current conversation summary...",
  preferredNode?: "vps-jane"  // Optional: specific target
});

// Send a message to other hemispheres
ansible.send_message({
  content: "Found the bug—it was a race condition in the sync logic",
  to?: "macbook-air"  // Optional: broadcast if omitted
});

// Update shared context
ansible.update_context({
  currentFocus: "Implementing Ansible plugin",
  decision: {
    decision: "Using Yjs over plain WebSocket",
    reasoning: "CRDTs handle offline + conflict resolution automatically"
  }
});

// Check hemisphere status
ansible.status();  // Returns pulse data for all nodes
```

---

## Security Model

### Layers of Defense

| Layer | Mechanism | What it prevents |
|-------|-----------|------------------|
| **Network** | Tailscale | Only Tailnet members can reach ports |
| **Application** | `nodes` allowlist | Only authorized nodes can sync |
| **Task Execution** | Human-in-loop for sensitive ops | Injected task RCE |

### Task Safety

Tasks from other hemispheres are **suggestions**, not commands:

1. Task appears in agent context via `before_agent_start`
2. Agent decides whether to work on it
3. Sensitive operations still require human approval (existing OpenClaw safeguards)

### What Ansible Does NOT Do

- Execute arbitrary code from sync
- Bypass existing permission systems
- Trust task content implicitly

---

## CLI Commands

```bash
# Status
openclaw ansible status              # Show all nodes, pulse, pending tasks

# Node management
openclaw ansible invite <node> --tier backbone|edge
openclaw ansible revoke <node>
openclaw ansible nodes               # List authorized nodes

# Messaging
openclaw ansible send "message"      # Broadcast to all
openclaw ansible send "message" --to vps-jane

# Tasks
openclaw ansible tasks               # List all tasks
openclaw ansible task create "title" --description "..."
```

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Plugin scaffold with service, hooks, CLI
- [ ] Yjs state schema implementation
- [ ] Backbone peer-to-peer sync
- [ ] Edge client sync
- [ ] Basic CLI (status, nodes)

### Phase 2: Coordination
- [ ] Task creation and delegation
- [ ] Message passing
- [ ] Context injection via hook
- [ ] Agent tools

### Phase 3: Polish
- [ ] Onboarding flow (invite/join)
- [ ] Revocation
- [ ] UI integration (gateway methods)
- [ ] Persistence and recovery

---

## Design Decisions

### Task Claiming: Hybrid Approach

Tasks support three assignment modes with fallback:

```typescript
interface Task {
  // Explicit assignment (highest priority)
  assignedTo?: TailscaleId;      // "vps-jane, handle this"

  // Capability filter (medium priority)
  requires?: string[];            // ["always-on", "gpu", "local-files"]

  // If neither specified → any hemisphere can claim (first-come)
}
```

**Standard capabilities:**
- `always-on` — Long-running tasks needing persistent uptime
- `local-files` — Needs access to Mac filesystem
- `gpu` — Requires GPU for inference/compute

### Message Retention: Time + Count + Read Status

Messages are ephemeral coordination, not long-term memory. Retention policy:

```typescript
// Keep messages that match ANY of:
// - Unread
// - Less than 24 hours old
// - In the last 50 messages
// Prune everything else

const MESSAGE_RETENTION = {
  maxAgeHours: 24,
  maxCount: 50,
  keepUnread: true,
};
```

Important information should flow to GitHub memory (durable) or task results (work output).

### Context Injection: Fixed Limits + Recency

Inject bounded context via `before_agent_start`, with tool access for more:

```typescript
const CONTEXT_LIMITS = {
  activeThreads: 3,
  recentDecisions: 3,
  pendingTasks: 5,
  unreadMessages: 5,
  maxAgeHours: 24,        // Ignore stale items
};
```

Agent can call `ansible.status()` for full details beyond these limits.

### Context Ownership: Per-Node

Each hemisphere maintains its own context (no conflicts):

```typescript
context: YMap<TailscaleId, {
  currentFocus: string;
  activeThreads: Thread[];
  recentDecisions: Decision[];
}>;
```

Injected view shows all bodies:
```
## What Jane is Working On
- **macbook-air**: Designing Ansible architecture
- **vps-jane**: Running background research task
```

This fits the "one agent, multiple bodies" model—each body has its own current activity.

---

## Relationship to Existing Systems

| System | Relationship |
|--------|--------------|
| **OpenClaw Node System** | Separate. Nodes are client devices, Ansible is instance-to-instance. |
| **GitHub Memory** | Complementary. GitHub = durable knowledge, Ansible = real-time coordination. |
| **OpenClaw Memory System** | Uses it. Each instance indexes shared GitHub memory locally. |
| **Tailscale** | Depends on it. Provides network layer and node identity. |
