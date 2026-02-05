/**
 * Ansible Plugin - Distributed coordination layer for OpenClaw
 *
 * Enables a single agent identity to operate across multiple OpenClaw instances
 * ("one agent, multiple bodies") via Yjs CRDT synchronization.
 */

import type { OpenClawPluginApi } from "./types.js";
import { createAnsibleService, onDocReady } from "./service.js";
import { registerAnsibleHooks } from "./hooks.js";
import { registerAnsibleTools } from "./tools.js";
import { registerAnsibleCli } from "./cli.js";
import { startMessageDispatcher } from "./dispatcher.js";
import type { AnsibleConfig } from "./schema.js";

export function register(api: OpenClawPluginApi) {
  const config = api.pluginConfig as AnsibleConfig | undefined;

  if (!config?.tier) {
    api.logger?.warn("Ansible plugin: 'tier' not configured, skipping initialization");
    return;
  }

  // Register the Yjs sync service
  api.registerService(createAnsibleService(api, config));

  // Register hooks for context injection
  registerAnsibleHooks(api, config);

  // Register agent tools
  registerAnsibleTools(api, config);

  // Register CLI commands
  registerAnsibleCli(api, config);

  // Start message dispatcher once the Yjs doc is ready
  onDocReady(() => startMessageDispatcher(api, config));

  api.logger?.info(`Ansible plugin initialized (tier: ${config.tier})`);
}

export type { AnsibleConfig } from "./schema.js";
export type { AnsibleState, Task, Message, NodeContext, NodeInfo } from "./schema.js";
