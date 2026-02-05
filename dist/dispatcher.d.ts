/**
 * Ansible Message Dispatcher
 *
 * Observes the Yjs messages map for new inbound messages and dispatches
 * them into the agent loop using the same pattern as built-in extensions
 * (Telegram, Twitch, Zalo): build a MsgContext, finalize it, record the
 * session, and call dispatchReplyWithBufferedBlockDispatcher.
 */
import type { OpenClawPluginApi } from "./types.js";
import type { AnsibleConfig } from "./schema.js";
/**
 * Start observing the Yjs messages map and dispatching new inbound
 * messages into the agent loop.
 */
export declare function startMessageDispatcher(api: OpenClawPluginApi, config: AnsibleConfig): void;
//# sourceMappingURL=dispatcher.d.ts.map