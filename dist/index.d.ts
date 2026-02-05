/**
 * Ansible Plugin - Distributed coordination layer for OpenClaw
 *
 * Enables a single agent identity to operate across multiple OpenClaw instances
 * ("one agent, multiple bodies") via Yjs CRDT synchronization.
 */
import type { OpenClawPluginApi } from "./types.js";
export declare function register(api: OpenClawPluginApi): void;
export type { AnsibleConfig } from "./schema.js";
export type { AnsibleState, Task, Message, NodeContext, NodeInfo } from "./schema.js";
//# sourceMappingURL=index.d.ts.map