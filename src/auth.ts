/**
 * Ansible Authorization
 *
 * Handles node invitation, bootstrap tokens, and revocation.
 */

import { randomUUID } from "crypto";
import type { TailscaleId, NodeInfo, PendingInvite } from "./schema.js";
import { INVITE_TTL_MS } from "./schema.js";
import { getDoc, getNodeId } from "./service.js";
import { mintWsTicketFromInvite } from "./admission.js";

interface InviteOptions {
  expectedNodeId?: string;
}

/**
 * Generate a bootstrap token for inviting a new node
 */
export function generateInviteToken(
  tier: "backbone" | "edge",
  options: InviteOptions = {}
): { token: string; expiresAt: number } | { error: string } {
  const doc = getDoc();
  const myId = getNodeId();

  if (!doc || !myId) {
    return { error: "Ansible not initialized" };
  }

  // Check if we're a backbone node (only backbone can invite)
  const nodes = doc.getMap("nodes");
  const myInfo = nodes.get(myId) as NodeInfo | undefined;

  // If nodes map is empty, we're the first node - allow self-registration
  const isFirstNode = nodes.size === 0;

  if (!isFirstNode && myInfo?.tier !== "backbone") {
    return { error: "Only backbone nodes can invite new nodes" };
  }

  const token = randomUUID().replace(/-/g, "");
  const expiresAt = Date.now() + INVITE_TTL_MS;
  const expectedNodeId = String(options.expectedNodeId || "").trim();

  const invites = doc.getMap("pendingInvites");
  const invite: PendingInvite = {
    tier,
    expiresAt,
    createdBy: myId,
  };
  if (expectedNodeId) invite.expectedNodeId = expectedNodeId;
  invites.set(token, invite);

  return { token, expiresAt };
}

/**
 * Join the Ansible network using a bootstrap token
 */
export function joinWithToken(
  token: string,
  capabilities: string[] = []
): { success: boolean; error?: string } {
  const doc = getDoc();
  const myId = getNodeId();

  if (!doc || !myId) {
    return { success: false, error: "Ansible not initialized" };
  }

  const invites = doc.getMap("pendingInvites");
  const invite = invites.get(token) as PendingInvite | undefined;

  if (!invite) {
    return { success: false, error: "Invalid or expired token" };
  }

  if (Date.now() > invite.expiresAt) {
    invites.delete(token);
    return { success: false, error: "Token expired" };
  }

  if (invite.expectedNodeId && invite.expectedNodeId !== myId) {
    return {
      success: false,
      error: `Token is bound to node '${invite.expectedNodeId}', not '${myId}'`,
    };
  }

  // Register ourselves
  const nodes = doc.getMap("nodes");
  nodes.set(myId, {
    name: myId,
    tier: invite.tier,
    capabilities,
    addedBy: invite.createdBy,
    addedAt: Date.now(),
  } as NodeInfo);

  // Mark consumed for visibility, then remove token (single-use)
  invite.usedByNode = myId;
  invite.usedAt = Date.now();
  invites.delete(token);

  return { success: true };
}

/**
 * Exchange an invite token for a short-lived websocket ticket.
 * Intended for pre-Yjs admission flows where unknown nodes are gated at upgrade time.
 */
export function exchangeInviteForWsTicket(
  inviteToken: string,
  expectedNodeId: string,
  ttlSeconds = 60
): { ticket: string; expiresAt: number } | { error: string } {
  const doc = getDoc();
  const myId = getNodeId();
  if (!doc || !myId) return { error: "Ansible not initialized" };
  const ttlMs = Math.floor(Number(ttlSeconds) * 1000);
  return mintWsTicketFromInvite(doc, myId, inviteToken, expectedNodeId, ttlMs);
}

/**
 * Self-register as the first node (bootstrap)
 */
export function bootstrapFirstNode(
  tier: "backbone" | "edge",
  capabilities: string[] = []
): { success: boolean; error?: string } {
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
  } as NodeInfo);

  return { success: true };
}

/**
 * Revoke a node's access
 */
export function revokeNode(nodeIdToRevoke: TailscaleId): { success: boolean; error?: string } {
  const doc = getDoc();
  const myId = getNodeId();

  if (!doc || !myId) {
    return { success: false, error: "Ansible not initialized" };
  }

  // Check if we're a backbone node
  const nodes = doc.getMap("nodes");
  const myInfo = nodes.get(myId) as NodeInfo | undefined;

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
export function isNodeAuthorized(checkNodeId: TailscaleId): boolean {
  const doc = getDoc();
  if (!doc) return false;

  const nodeId = String(checkNodeId || "").trim();
  if (!nodeId) return false;

  const nodes = doc.getMap("nodes");

  // If no nodes registered yet, allow (bootstrapping)
  if (nodes.size === 0) return true;

  if (nodes.has(nodeId)) return true;

  // Fallback 1: allow nodes that are actively heartbeating in this shared doc.
  const pulse = doc.getMap("pulse");
  if (pulse.has(nodeId)) return true;

  // Fallback 2: allow nodes that host at least one internal registered agent.
  const agents = doc.getMap("agents");
  for (const raw of agents.values()) {
    const rec = raw as { type?: string; gateway?: string | null } | undefined;
    if (!rec) continue;
    if (rec.type === "internal" && rec.gateway === nodeId) return true;
  }

  return false;
}

/**
 * Get list of pending invites (for backbone nodes)
 */
export function listPendingInvites(): PendingInvite[] {
  const doc = getDoc();
  if (!doc) return [];

  const invites = doc.getMap("pendingInvites");
  const now = Date.now();
  const result: PendingInvite[] = [];

  // Clean up expired invites while listing
  for (const [token, invite] of invites.entries()) {
    const inv = invite as PendingInvite;
    if (now > inv.expiresAt) {
      invites.delete(token);
    } else {
      result.push(inv);
    }
  }

  return result;
}

/**
 * Prune expired invites
 */
export function pruneExpiredInvites(): number {
  const doc = getDoc();
  if (!doc) return 0;

  const invites = doc.getMap("pendingInvites");
  const now = Date.now();
  let pruned = 0;

  for (const [token, invite] of invites.entries()) {
    const inv = invite as PendingInvite;
    if (now > inv.expiresAt) {
      invites.delete(token);
      pruned++;
    }
  }

  return pruned;
}
