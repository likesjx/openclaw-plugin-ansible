/**
 * Ansible Authorization
 *
 * Handles node invitation, bootstrap tokens, and revocation.
 */
import type { TailscaleId, PendingInvite } from "./schema.js";
interface InviteOptions {
    expectedNodeId?: string;
}
/**
 * Generate a bootstrap token for inviting a new node
 */
export declare function generateInviteToken(tier: "backbone" | "edge", options?: InviteOptions): {
    token: string;
    expiresAt: number;
} | {
    error: string;
};
/**
 * Join the Ansible network using a bootstrap token
 */
export declare function joinWithToken(token: string, capabilities?: string[]): {
    success: boolean;
    error?: string;
};
/**
 * Exchange an invite token for a short-lived websocket ticket.
 * Intended for pre-Yjs admission flows where unknown nodes are gated at upgrade time.
 */
export declare function exchangeInviteForWsTicket(inviteToken: string, expectedNodeId: string, ttlSeconds?: number): {
    ticket: string;
    expiresAt: number;
} | {
    error: string;
};
/**
 * Self-register as the first node (bootstrap)
 */
export declare function bootstrapFirstNode(tier: "backbone" | "edge", capabilities?: string[]): {
    success: boolean;
    error?: string;
};
/**
 * Revoke a node's access
 */
export declare function revokeNode(nodeIdToRevoke: TailscaleId): {
    success: boolean;
    error?: string;
};
/**
 * Check if a node is authorized
 */
export declare function isNodeAuthorized(checkNodeId: TailscaleId): boolean;
/**
 * Get list of pending invites (for backbone nodes)
 */
export declare function listPendingInvites(): PendingInvite[];
/**
 * Prune expired invites
 */
export declare function pruneExpiredInvites(): number;
export {};
//# sourceMappingURL=auth.d.ts.map