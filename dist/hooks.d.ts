/**
 * Ansible Hooks
 *
 * Integrates with OpenClaw's hook system to inject shared context
 * into agent prompts via the before_agent_start hook.
 */
import type { OpenClawPluginApi } from "./types.js";
import type { AnsibleConfig } from "./schema.js";
export declare function registerAnsibleHooks(api: OpenClawPluginApi, config: AnsibleConfig): void;
//# sourceMappingURL=hooks.d.ts.map