/**
 * Admission helpers for pre-Yjs websocket authorization.
 *
 * This module intentionally has no dependency on service/auth modules to avoid
 * circular imports. Callers pass the active Y.Doc and actor/node context.
 */
import { randomUUID } from "crypto";
export const WS_TICKET_TTL_MS = 60_000;
function pruneExpiredTickets(map, now = Date.now()) {
    for (const [ticket, raw] of map.entries()) {
        const rec = raw;
        if (!rec || rec.usedAt || now > rec.expiresAt)
            map.delete(ticket);
    }
}
export function mintWsTicketFromInvite(doc, createdBy, inviteToken, expectedNodeId, ttlMs = WS_TICKET_TTL_MS) {
    const ticketMap = doc.getMap("authTickets");
    pruneExpiredTickets(ticketMap);
    const token = String(inviteToken || "").trim();
    const nodeId = String(expectedNodeId || "").trim();
    if (!token)
        return { error: "Invite token required" };
    if (!nodeId)
        return { error: "Node ID required" };
    if (!Number.isFinite(ttlMs) || ttlMs < 5_000 || ttlMs > 10 * 60_000) {
        return { error: "Invalid ticket TTL (must be 5s to 10m)" };
    }
    const invites = doc.getMap("pendingInvites");
    const invite = invites.get(token);
    if (!invite)
        return { error: "Invalid or expired token" };
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
export function consumeInviteForNode(doc, inviteToken, presentedNodeId) {
    const token = String(inviteToken || "").trim();
    const node = String(presentedNodeId || "").trim();
    if (!token || !node)
        return { ok: false, error: "invalid_params" };
    const invites = doc.getMap("pendingInvites");
    const invite = invites.get(token);
    if (!invite)
        return { ok: false, error: "invalid_token" };
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
    });
    invite.usedByNode = node;
    invite.usedAt = Date.now();
    invites.delete(token);
    return { ok: true };
}
export function consumeWsTicket(doc, ticket, presentedNodeId) {
    const tk = String(ticket || "").trim();
    const node = String(presentedNodeId || "").trim();
    if (!tk || !node)
        return { ok: false, error: "invalid_params" };
    const ticketMap = doc.getMap("authTickets");
    pruneExpiredTickets(ticketMap);
    const rec = ticketMap.get(tk);
    if (!rec)
        return { ok: false, error: "invalid_ticket" };
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
    if (!accepted.ok)
        return accepted;
    rec.usedAt = Date.now();
    ticketMap.set(tk, rec);
    return { ok: true };
}
//# sourceMappingURL=admission.js.map