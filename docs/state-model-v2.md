# State Model v2: State-Only Control Plane + Per-Gateway Data Pipes

Status: Draft RFC  
Owner: Ansible maintainers  
Last updated: 2026-02-25

## Decision (Crisp)

The shared Ansible plane must carry system state only.

- No message bodies in shared state.
- No task descriptions/results in shared state.
- Shared state is for membership, routing, health, policy, and cursors.

All communication payloads move to gateway-owned data pipes.

## Why This Model

The current single shared document is elegant for coordination metadata, but mixing metadata and payload traffic causes failure coupling:

- one hot sender can increase write pressure for everyone
- replay and retries become ambiguous (state vs transport)
- retention policy for "state forever" and "messages with SLA" collide

Separating control and data planes gives clear ownership and deterministic delivery.

## Topology

Two layers:

1. Control plane (shared):
- one shared Yjs doc/room (e.g., `ansible-control`)
- lightweight, low-churn, long-lived records

2. Data plane (per gateway):
- one inbox stream per gateway (e.g., `pipe:<nodeId>:inbox`)
- optional outbox stream per gateway (for audit/replay)
- append-only events + explicit ACK cursors

## Non-Goals

- Not replacing Tailscale identity and transport trust
- Not introducing a central SQL dependency for core delivery
- Not requiring all gateways to run as backbone

## Control Plane Schema (State Only)

The control plane contains no payload content.

### `nodes`

Keyed by `nodeId`.

- `tier`: `backbone|edge`
- `endpointWs`: `ws://host:port`
- `capabilities`: string[]
- `status`: `online|degraded|offline`
- `lastHeartbeatAt`: epoch ms
- `protocolVersion`: string
- `addedBy`, `addedAt`

### `agents`

Keyed by `agentId`.

- `gateway`: `nodeId|null`
- `type`: `internal|external`
- `role`: optional (`coordinator|maintenance|worker`)
- `lastSeenAt`

### `routing`

Keyed by target (`agentId` or `nodeId`).

- `ownerNodeId`
- `fallbackNodeIds`: string[]
- `requiresCapabilities`: string[]
- `priorityDefault`

### `capabilities`

Two maps:

1. `capabilities.catalog.<capabilityId>`
- `name`
- `version`
- `ownerAgentId` (must host executor skill)
- `delegationSkillRef` (skill id/path + version)
- `executorSkillRef` (skill id/path + version)
- `defaultEtaSeconds`
- `contractSchemaRef` (input/output contract)
- `status`: `active|deprecated|disabled`

2. `capabilities.index.<capabilityId>`
- `eligibleAgentIds` (currently routable agents)
- `updatedAt`
- `policyVersion`

### `invites`

Keyed by invite token hash or invite id (not raw token if possible).

- `tier`
- `expectedNodeId` (optional now, recommended)
- `expiresAt`
- `createdBy`
- `usedAt` / `revokedAt`

### `delivery`

Keyed by `nodeId`.

- `inboxCursorAcked`: last contiguous sequence ACKed by owner
- `inboxCursorSeen`: optional high-water mark for observability
- `deadLetterCount`
- `lastAckAt`

### `coordination`

- `coordinator`
- `sweepEverySeconds`
- retention settings for control records only
- `skillReviewQueue` (contract/SLA misfire review items)

## Data Plane Schema (Per-Gateway Pipe)

Each gateway owns exactly one inbox stream.

Stream identity:
- `pipe:<nodeId>:inbox`

Optional audit stream:
- `pipe:<nodeId>:outbox`

Event envelope (append-only):

- `eventId`: globally unique id (ULID/UUIDv7 preferred)
- `seq`: monotonically increasing per inbox
- `fromNodeId`
- `fromAgentId`
- `toNodeId`
- `toAgentId` (optional for node-level events)
- `kind`: `message|task|task_update|task_result|signal`
- `corrId`: correlation id
- `createdAt`
- `expiresAt` (optional)
- `payloadRef` or `payload` (see storage options below)
- `attempt`: integer
- `trace`: minimal routing metadata

ACK record (written by inbox owner only):

- `nodeId`
- `ackedSeq`
- `ackedAt`
- `agentId` (optional)

## Payload Storage Options

Preferred order:

1. Inline encrypted payload in data-pipe event (`payload`)
2. External blob with strong reference (`payloadRef`) for large payloads

Constraint:
- Payloads must never be mirrored into control plane maps.

## Ownership Rules

Hard rule:
- Only node `N` may write ACK cursor for `pipe:N:inbox`.

Soft rule:
- Any authorized sender may append to `pipe:N:inbox`, subject to routing policy.

GC rule:
- A sender may drop local resend state only after ACK observed.
- Inbox compaction may prune events <= `ackedSeq - retentionWindow`.

## Delivery Semantics

Target semantics: at-least-once transport + idempotent handlers.

Requirements:

- Receiver deduplicates by `eventId`.
- Processing must be idempotent by `eventId`/`corrId`.
- ACK advances only after durable handling.

Failure handling:

- No ACK before successful processing
- Retry with exponential backoff + jitter
- Move to dead-letter after max attempts
- Emit control-plane incident counters only (not payload)

## Task Routing Contract (Capability-First)

Validation and routing rules for `task_create`:

1. If `toAgents` is provided:
- validate all targets exist/active
- reject when none valid (`400 invalid_targets`)

2. If `toAgents` is missing:
- require `requiredCapabilities` list
- resolve through `capabilities.index`
- if no eligible agent matches, reject (`400 no_route`)

3. If both `toAgents` and `requiredCapabilities` are missing:
- reject (`400 missing_route_fields`)

4. If capability exists but owner/executor skill is unavailable:
- reject (`409 capability_unavailable`)

Operational note:

- Capability routing is deterministic at publish-time policy version; events carry that version in trace metadata.

## Invite/Join v2 (No Pairing UX)

Desired operator flow:

1. Backbone agent: "invite mbp-jane"
2. System issues invite bound to `expectedNodeId=mbp-jane`
3. New gateway agent: "join vps-jane with token X"
4. Join succeeds only if caller node id matches expected id

CLI/API additions:

- `openclaw ansible invite --tier edge --node mbp-jane`
- `openclaw ansible join --token <token>` (enforces expected node when present)

This preserves current token flow but eliminates ambiguous invites when desired.

## Handshake v2 (Pre-Yjs Auth Gate)

Normative requirements:

1. A node must not connect to any Yjs room before auth exchange succeeds.
2. Invite token is exchanged for a short-lived single-use WS ticket.
3. WS upgrade validates ticket before `setupWSConnection`.
4. Invite token is consumed only after successful WS auth.

Protocol:

1. Inviter creates invite:
- includes `tier`, `expectedNodeId` (recommended required), `expiresAt`.

2. Joiner performs auth exchange:
- `POST /ansible/auth/exchange` with `inviteToken`, `nodeId`, `nonce`.

3. Server validates:
- token exists, unexpired, unused
- `expectedNodeId` match when present
- replay guard for token/nonce

4. Server returns `wsTicket`:
- one-time, 30-60s TTL, bound to `nodeId` and allowed rooms.

5. Joiner opens WS with `wsTicket`.

6. WS endpoint validates ticket:
- signature, expiry, unused `jti`, node binding.
- only then allow Yjs room access.

Recommended hardening:

- Add `nodeProof` challenge-response (signed nonce) and require it in production mode.

Security note:

- This closes the current hole where network reachability can imply read access before app-level authorization.

External-agent note:

- External agents (Codex/Claude Code) should use gateway agent-auth endpoints and must not connect directly to Yjs rooms.
- See `docs/external-agent-auth-v1.md` for endpoint and token lifecycle specs.

## Migration Plan (Zero Big-Bang)

Phase 1: Introduce schemas + dual-write (safe)

- add control-plane maps: `routing`, `delivery`
- add capability maps: `capabilities.catalog`, `capabilities.index`
- add per-node inbox streams
- write new messages/tasks to both old shared maps and new pipes

Phase 2: Consumer cutover

- dispatcher reads from per-node inbox first
- shared-map delivery path becomes fallback only

Phase 3: Disable shared payload writes

- stop writing message/task payloads to shared maps
- keep compact summaries in control plane if needed (counts only)

Phase 4: Cleanup

- remove legacy message/task payload maps from core path
- keep migration readers for one release window

## Observability and SLOs

Control-plane metrics:

- node heartbeat freshness
- ack lag (`latestSeq - ackedSeq`)
- dead-letter counts
- retry rate

Data-plane metrics:

- end-to-end latency by kind
- per-node throughput
- duplicate rate

Initial SLO targets:

- p95 delivery < 5s (online nodes)
- no unacked backlog growth for > 10 min without alert

## Security Notes

- Treat invite tokens as secrets; prefer hashed storage in control plane.
- Prefer target-bound invites (`expectedNodeId`) for operator safety.
- Keep control plane free of sensitive payloads to reduce blast radius.
- Require pre-Yjs auth gate with single-use short-lived `wsTicket`.
- Enforce replay protection on invite exchange and ticket use (`nonce`, `jti`).

## Open Questions

1. Should per-node pipes be separate Yjs rooms or a different append-log substrate?
2. Do we require payload encryption-at-rest in pipe events for local persistence?
3. What max payload size triggers mandatory `payloadRef` indirection?

## Recommendation

Adopt this hybrid architecture now:

- shared control plane for system state only
- gateway-owned data pipes for all communication payloads

This keeps the mental model simple, isolates failures, and gives us reliable delivery primitives without losing Ansible's distributed coordination strengths.
