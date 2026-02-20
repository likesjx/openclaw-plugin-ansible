/**
 * Ansible Authorization
 *
 * Handles node invitation, bootstrap tokens, and revocation.
 */
import { randomUUID } from "crypto";
import { INVITE_TTL_MS } from "./schema.js";
import { getDoc, getNodeId } from "./service.js";
/**
 * Generate a bootstrap token for inviting a new node
 */
export function generateInviteToken(tier) {
    const doc = getDoc();
    const myId = getNodeId();
    if (!doc || !myId) {
        return { error: "Ansible not initialized" };
    }
    // Check if we're a backbone node (only backbone can invite)
    const nodes = doc.getMap("nodes");
    const myInfo = nodes.get(myId);
    // If nodes map is empty, we're the first node - allow self-registration
    const isFirstNode = nodes.size === 0;
    if (!isFirstNode && myInfo?.tier !== "backbone") {
        return { error: "Only backbone nodes can invite new nodes" };
    }
    const token = randomUUID().replace(/-/g, "");
    const expiresAt = Date.now() + INVITE_TTL_MS;
    const invites = doc.getMap("pendingInvites");
    invites.set(token, {
        tier,
        expiresAt,
        createdBy: myId,
    });
    return { token, expiresAt };
}
/**
 * Join the Ansible network using a bootstrap token
 */
export function joinWithToken(token, capabilities = []) {
    const doc = getDoc();
    const myId = getNodeId();
    if (!doc || !myId) {
        return { success: false, error: "Ansible not initialized" };
    }
    const invites = doc.getMap("pendingInvites");
    const invite = invites.get(token);
    if (!invite) {
        return { success: false, error: "Invalid or expired token" };
    }
    if (Date.now() > invite.expiresAt) {
        invites.delete(token);
        return { success: false, error: "Token expired" };
    }
    // Register ourselves
    const nodes = doc.getMap("nodes");
    nodes.set(myId, {
        name: myId,
        tier: invite.tier,
        capabilities,
        addedBy: invite.createdBy,
        addedAt: Date.now(),
    });
    // Remove the used token (single-use)
    invites.delete(token);
    return { success: true };
}
/**
 * Self-register as the first node (bootstrap)
 */
export function bootstrapFirstNode(tier, capabilities = []) {
    const doc = getDoc();
    const myId = getNodeId();
    if (!doc || !myId) {
        return { success: false, error: "Ansible not initialized" };
    }
    const nodes = doc.getMap("nodes");
    if (nodes.size > 0) {
        return { success: false, error: "Network already has nodes. Use invite flow." };
    }
    // Register ourselves as the first node
    nodes.set(myId, {
        name: myId,
        tier,
        capabilities,
        addedBy: myId, // Self-added
        addedAt: Date.now(),
    });
    return { success: true };
}
/**
 * Revoke a node's access
 */
export function revokeNode(nodeIdToRevoke) {
    const doc = getDoc();
    const myId = getNodeId();
    if (!doc || !myId) {
        return { success: false, error: "Ansible not initialized" };
    }
    // Check if we're a backbone node
    const nodes = doc.getMap("nodes");
    const myInfo = nodes.get(myId);
    if (myInfo?.tier !== "backbone") {
        return { success: false, error: "Only backbone nodes can revoke access" };
    }
    // Can't revoke yourself
    if (nodeIdToRevoke === myId) {
        return { success: false, error: "Cannot revoke your own access" };
    }
    const targetInfo = nodes.get(nodeIdToRevoke);
    if (!targetInfo) {
        return { success: false, error: "Node not found" };
    }
    // Remove from authorized nodes
    nodes.delete(nodeIdToRevoke);
    // Also remove their context and pulse
    const context = doc.getMap("context");
    const pulse = doc.getMap("pulse");
    context.delete(nodeIdToRevoke);
    pulse.delete(nodeIdToRevoke);
    return { success: true };
}
/**
 * Check if a node is authorized
 */
export function isNodeAuthorized(checkNodeId) {
    const doc = getDoc();
    if (!doc)
        return false;
    const nodeId = String(checkNodeId || "").trim();
    if (!nodeId)
        return false;
    const nodes = doc.getMap("nodes");
    // If no nodes registered yet, allow (bootstrapping)
    if (nodes.size === 0)
        return true;
    if (nodes.has(nodeId))
        return true;
    // Fallback 1: allow nodes that are actively heartbeating in this shared doc.
    const pulse = doc.getMap("pulse");
    if (pulse.has(nodeId))
        return true;
    // Fallback 2: allow nodes that host at least one internal registered agent.
    const agents = doc.getMap("agents");
    for (const raw of agents.values()) {
        const rec = raw;
        if (!rec)
            continue;
        if (rec.type === "internal" && rec.gateway === nodeId)
            return true;
    }
    return false;
}
/**
 * Get list of pending invites (for backbone nodes)
 */
export function listPendingInvites() {
    const doc = getDoc();
    if (!doc)
        return [];
    const invites = doc.getMap("pendingInvites");
    const now = Date.now();
    const result = [];
    // Clean up expired invites while listing
    for (const [token, invite] of invites.entries()) {
        const inv = invite;
        if (now > inv.expiresAt) {
            invites.delete(token);
        }
        else {
            result.push(inv);
        }
    }
    return result;
}
/**
 * Prune expired invites
 */
export function pruneExpiredInvites() {
    const doc = getDoc();
    if (!doc)
        return 0;
    const invites = doc.getMap("pendingInvites");
    const now = Date.now();
    let pruned = 0;
    for (const [token, invite] of invites.entries()) {
        const inv = invite;
        if (now > inv.expiresAt) {
            invites.delete(token);
            pruned++;
        }
    }
    return pruned;
}
//# sourceMappingURL=auth.js.map