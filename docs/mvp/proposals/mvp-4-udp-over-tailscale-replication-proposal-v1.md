# UDP over Tailscale for Ansible Replication (Proposal v1)

Status: draft  
Last updated: 2026-03-03

## Purpose

Evaluate whether we can replace Yjs synchronization with a lower-level network replication plane using UDP on Tailscale.

Short answer:

1. Yes, we can run replication over Tailscale using UDP-based transport.
2. We should not build raw UDP reliability from scratch for control-plane correctness.
3. Best path is QUIC (UDP) as the transport substrate, with protocol-level event/cursor semantics on top.

## Ground Truth from Tailscale

Based on current docs (validated references at end):

1. Tailscale prefers direct peer-to-peer UDP when possible.
2. If direct path fails, Tailscale relays traffic (peer relay first, DERP fallback).
3. Traffic remains WireGuard end-to-end encrypted in both direct and relayed paths.
4. Access policy can explicitly grant UDP protocol/ports using grants syntax (`udp:<port>`).

Implication:

1. A UDP-based app transport can work across heterogeneous NATs.
2. Performance profile varies by connection type (direct best, relay slower).
3. We still need app-level reliability and ordering semantics regardless of transport.

## Why UDP in This Design

What we gain versus doc-CRDT coupling:

1. Explicit protocol and replay control.
2. Better backpressure and congestion behavior options.
3. Lower framing overhead for high-frequency event traffic.
4. Cleaner future Rust implementation boundary.

What UDP alone does not give us:

1. Reliable delivery.
2. Ordered delivery.
3. Stream-level flow control.
4. Built-in replay protection.

## Transport Options

### Option A: Raw UDP + Custom Reliability

How:

1. Custom packet framing over UDP.
2. Build ACK windows, retransmit timers, congestion/backoff, fragmentation, reassembly, anti-replay.

Pros:

1. Maximum control.
2. Potentially minimal overhead.

Cons:

1. High engineering and security risk.
2. Easy to get edge-case behavior wrong.
3. Reinvents solved transport problems.

Verdict:

1. Not recommended for MVP path.

### Option B: QUIC over UDP (Recommended)

How:

1. Use QUIC streams for reliable ordered channels (control, state delta, snapshots).
2. Use QUIC datagrams for best-effort gossip/telemetry if needed.

Pros:

1. Reliable multiplexed streams built in.
2. Congestion control and loss recovery built in.
3. NAT-friendly and robust in variable links.
4. Strong Rust ecosystem support.

Cons:

1. Slightly higher complexity than plain TCP in trivial cases.
2. Requires clean certificate/key strategy (or Noise-like identity wrapping).

Verdict:

1. Best balance of performance, correctness, and delivery speed.

### Option C: TCP over Tailscale

How:

1. Persistent TCP sessions on tailnet IP.

Pros:

1. Operationally simple.
2. Mature tooling.

Cons:

1. Head-of-line blocking across multiplexed traffic unless app-layer channels added.
2. Less flexible for mixed reliable/unreliable traffic.

Verdict:

1. Acceptable fallback, not preferred target.

## Recommended Design

Use QUIC as transport with an explicit event protocol.

### Channel Layout

1. `control` stream: hello/auth/membership/summary.
2. `replication` stream(s): append-only event batches by stream owner.
3. `snapshot` stream: checkpoint transfer for large catch-up.
4. `cursor-ack` stream: durable processed offsets.
5. Optional datagram channel: non-critical hints/heartbeats.

### Message Envelope

```text
Envelope {
  version: 1
  cluster_id: string
  from_node: string
  stream_id: string
  event_id: string
  seq: uint64
  hlc: uint64
  event_type: string
  payload_hash: bytes32
  signature: bytes64
  payload: bytes
}
```

### Semantics

1. Transport reliability: QUIC stream-level.
2. Application idempotency: `(stream_id, seq, event_id)` dedupe.
3. Apply ordering: per-stream monotonic `seq`.
4. Cross-stream causality: `hlc` + `corr` metadata.

## Tailscale Policy and Port Plan

### Porting Rule

1. Run QUIC listener on one dedicated UDP port per gateway (example `42001`).

### Grants Example

```json
{
  "grants": [
    {
      "src": ["tag:ansible-gateway"],
      "dst": ["tag:ansible-gateway"],
      "ip": ["udp:42001"]
    }
  ]
}
```

### Operational Notes

1. Verify `tailscale netcheck` reports UDP reachable where possible.
2. Expect relayed links for hard-NAT pairs.
3. Monitor replication lag by peer to detect relay-induced performance drops.

## Failure Behavior with UDP/QUIC

### Packet Loss

1. QUIC handles retransmit and recovery.
2. App sees delayed stream delivery, not silent corruption.

### Reorder/Duplication

1. QUIC stream reorders before delivery.
2. App dedupe still mandatory for safety.

### Partition

1. Writer continues local append.
2. Peer reconciles by cursor on reconnect.
3. Snapshot path for large gap.

## Security

1. Keep invite/token/ticket gate before replication admission.
2. Keep node key identity binding to stream ownership.
3. Sign envelopes end-to-end even on encrypted tunnel for audit/non-repudiation.
4. Enforce replay window and monotonic sequence checks.

## Performance Expectations

### Direct UDP Path

1. Lowest latency.
2. Highest throughput.
3. Best for near-real-time replication.

### Relayed Path (Peer Relay / DERP)

1. Higher latency and lower throughput.
2. Still functional and encrypted.
3. Requires backlog-aware batching and adaptive pacing.

## Migration Plan (Yjs to UDP/QUIC)

1. Phase 0: implement protocol and local log/projector in shadow mode.
2. Phase 1: dual-write from existing logic to QUIC channel.
3. Phase 2: compare materialized parity against current state store.
4. Phase 3: make QUIC primary read path with Yjs fallback.
5. Phase 4: remove Yjs runtime dependency.

## Recommendation

Proceed with QUIC-over-UDP on Tailscale as the primary replication transport.

Do not use raw UDP custom reliability for the control/data plane in MVP.

This gives us the low-level network ownership model you want while minimizing protocol-risk and aligning cleanly with the Rust-core direction.

## References

1. Tailscale connection types (direct UDP, DERP, peer relay): https://tailscale.com/docs/reference/connection-types
2. Tailscale DERP behavior and fallback: https://tailscale.com/docs/reference/derp-servers
3. Tailscale device connectivity matrix and `netcheck`: https://tailscale.com/docs/reference/device-connectivity
4. Tailscale peer relay setup and UDP relay port: https://tailscale.com/docs/features/peer-relay
5. Tailscale grants syntax (`udp:<port>` support): https://tailscale.com/docs/reference/syntax/grants
