/**
 * Admission helpers for pre-Yjs websocket authorization.
 *
 * This module intentionally has no dependency on service/auth modules to avoid
 * circular imports. Callers pass the active Y.Doc and actor/node context.
 */
import type * as Y from "yjs";
import type { TailscaleId } from "./schema.js";
export declare const WS_TICKET_TTL_MS = 60000;
export declare function mintWsTicketFromInvite(doc: Y.Doc, createdBy: TailscaleId, inviteToken: string, expectedNodeId: string, ttlMs?: number): {
    ticket: string;
    expiresAt: number;
} | {
    error: string;
};
export declare function consumeInviteForNode(doc: Y.Doc, inviteToken: string, presentedNodeId: string): {
    ok: boolean;
    error?: string;
};
export declare function consumeWsTicket(doc: Y.Doc, ticket: string, presentedNodeId: string): {
    ok: boolean;
    error?: string;
};
//# sourceMappingURL=admission.d.ts.map