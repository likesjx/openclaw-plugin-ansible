/**
 * Ansible CLI Commands
 *
 * Management commands for the Ansible coordination layer.
 *
 * Commands that read live state (status, nodes, tasks, send) call the running
 * gateway's /tools/invoke HTTP endpoint so they see the real Yjs document.
 * Setup commands (bootstrap, join, invite, revoke) still use direct Yjs access
 * because they run when the gateway IS the current process.
 */
import type { OpenClawPluginApi } from "./types.js";
import type { AnsibleConfig } from "./schema.js";
export declare function registerAnsibleCli(api: OpenClawPluginApi, config: AnsibleConfig): void;
//# sourceMappingURL=cli.d.ts.map