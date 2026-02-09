/**
 * Ansible Dispatcher (Messages + Assigned Tasks)
 *
 * Guarantees:
 * - Live dispatch: new inbound messages are injected into the agent loop.
 * - Reconnect reconciliation: when sync completes, scan for backlog and deliver
 *   deterministically (timestamp order) without duplicates.
 * - Retry: failed dispatches are retried with exponential backoff + jitter.
 */
import type { OpenClawPluginApi } from "./types.js";
import type { AnsibleConfig } from "./schema.js";
/**
 * Start observing the Yjs state and dispatching inbound work into the agent loop.
 */
export declare function startMessageDispatcher(api: OpenClawPluginApi, config: AnsibleConfig): void;
//# sourceMappingURL=dispatcher.d.ts.map