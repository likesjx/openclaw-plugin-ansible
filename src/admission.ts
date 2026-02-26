/**
 * Admission helpers for pre-Yjs websocket authorization.
 *
 * This module intentionally has no dependency on service/auth modules to avoid
 * circular imports. Callers pass the active Y.Doc and actor/node context.
 */

import { randomUUID } from "crypto";
import type * as Y from "yjs";
import type { NodeInfo, PendingInvite, TailscaleId } from "./schema.js";

export const WS_TICKET_TTL_MS = 60_000;

interface WsTicketRecord {
  ticket: string;
  inviteToken: string;
  expectedNodeId: TailscaleId;
  createdBy: TailscaleId;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}

function pruneExpiredTickets(map: Y.Map<any>, now = Date.now()): void {
  for (const [ticket, raw] of map.entries()) {
    const rec = raw as WsTicketRecord | undefined;
    if (!rec || rec.usedAt || now > rec.expiresAt) map.delete(ticket);
  }
}

export function mintWsTicketFromInvite(
  doc: Y.Doc,
  createdBy: TailscaleId,
  inviteToken: string,
  expectedNodeId: string,
  ttlMs = WS_TICKET_TTL_MS
): { ticket: string; expiresAt: number } | { error: string } {
  const ticketMap = doc.getMap("authTickets");
  pruneExpiredTickets(ticketMap);
  const token = String(inviteToken || "").trim();
  const nodeId = String(expectedNodeId || "").trim();
  if (!token) return { error: "Invite token required" };
  if (!nodeId) return { error: "Node ID required" };
  if (!Number.isFinite(ttlMs) || ttlMs < 5_000 || ttlMs > 10 * 60_000) {
    return { error: "Invalid ticket TTL (must be 5s to 10m)" };
  }

  const invites = doc.getMap("pendingInvites");
  const invite = invites.get(token) as PendingInvite | undefined;
  if (!invite) return { error: "Invalid or expired token" };
  if (Date.now() > invite.expiresAt) {
    invites.delete(token);
    return { error: "Token expired" };
  }
  if (invite.expectedNodeId && invite.expectedNodeId !== nodeId) {
    return { error: `Token is bound to node '${invite.expectedNodeId}', not '${nodeId}'` };
  }

  const ticket = randomUUID().replace(/-/g, "");
  const expiresAt = Date.now() + Math.floor(ttlMs);
  ticketMap.set(ticket, {
    ticket,
    inviteToken: token,
    expectedNodeId: nodeId,
    createdBy,
    createdAt: Date.now(),
    expiresAt,
  });

  return { ticket, expiresAt };
}

export function consumeInviteForNode(
  doc: Y.Doc,
  inviteToken: string,
  presentedNodeId: string
): { ok: boolean; error?: string } {
  const token = String(inviteToken || "").trim();
  const node = String(presentedNodeId || "").trim();
  if (!token || !node) return { ok: false, error: "invalid_params" };

  const invites = doc.getMap("pendingInvites");
  const invite = invites.get(token) as PendingInvite | undefined;
  if (!invite) return { ok: false, error: "invalid_token" };

  if (Date.now() > invite.expiresAt) {
    invites.delete(token);
    return { ok: false, error: "expired_token" };
  }

  if (invite.expectedNodeId && invite.expectedNodeId !== node) {
    return { ok: false, error: "node_mismatch" };
  }

  const nodes = doc.getMap("nodes");
  nodes.set(node, {
    name: node,
    tier: invite.tier,
    capabilities: [],
    addedBy: invite.createdBy,
    addedAt: Date.now(),
  } as NodeInfo);

  invite.usedByNode = node;
  invite.usedAt = Date.now();
  invites.delete(token);
  return { ok: true };
}

export function consumeWsTicket(
  doc: Y.Doc,
  ticket: string,
  presentedNodeId: string
): { ok: boolean; error?: string } {
  const tk = String(ticket || "").trim();
  const node = String(presentedNodeId || "").trim();
  if (!tk || !node) return { ok: false, error: "invalid_params" };

  const ticketMap = doc.getMap("authTickets");
  pruneExpiredTickets(ticketMap);
  const rec = ticketMap.get(tk) as WsTicketRecord | undefined;
  if (!rec) return { ok: false, error: "invalid_ticket" };
  if (rec.usedAt) {
    ticketMap.delete(tk);
    return { ok: false, error: "ticket_already_used" };
  }
  if (Date.now() > rec.expiresAt) {
    ticketMap.delete(tk);
    return { ok: false, error: "expired_ticket" };
  }
  if (rec.expectedNodeId !== node) {
    return { ok: false, error: "ticket_node_mismatch" };
  }

  const accepted = consumeInviteForNode(doc, rec.inviteToken, node);
  if (!accepted.ok) return accepted;

  rec.usedAt = Date.now();
  ticketMap.set(tk, rec);
  return { ok: true };
}
