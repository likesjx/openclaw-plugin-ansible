/**
 * Ansible Sync Service
 *
 * Manages Yjs document synchronization between OpenClaw instances.
 * - Backbone nodes: Run WebSocket server + connect to peers
 * - Edge nodes: Connect to backbone peers as client
 */
import * as Y from "yjs";
import type { OpenClawPluginApi, ServiceContext } from "./types.js";
import type { AnsibleConfig, AnsibleState, TailscaleId } from "./schema.js";
export type { AnsibleState };
/**
 * Get the shared Yjs document
 * For backbone: returns the y-websocket managed doc
 * For edge: returns our local doc (synced via WebsocketProvider)
 */
export declare function getDoc(): Y.Doc | null;
/**
 * Get this node's Tailscale ID
 */
export declare function getNodeId(): TailscaleId | null;
/**
 * Get the current Ansible state from the Yjs document
 */
export declare function getAnsibleState(): AnsibleState | null;
/**
 * Register a callback to run once the Yjs doc is initialized and ready.
 * If the doc is already ready, the callback fires immediately.
 */
export declare function onDocReady(cb: () => void): void;
/**
 * Create the Ansible sync service
 */
export declare function createAnsibleService(_api: OpenClawPluginApi, config: AnsibleConfig): {
    id: string;
    start(ctx: ServiceContext): Promise<void>;
    stop(ctx: ServiceContext): Promise<void>;
};
//# sourceMappingURL=service.d.ts.map