/**
 * Ansible Plugin - Distributed coordination layer for OpenClaw
 *
 * Enables a single agent identity to operate across multiple OpenClaw instances
 * ("one agent, multiple bodies") via Yjs CRDT synchronization.
 */
import { createAnsibleService, onDocReady } from "./service.js";
import { createLockSweepService } from "./lock-sweep.js";
import { registerAnsibleHooks } from "./hooks.js";
import { registerAnsibleTools } from "./tools.js";
import { registerAnsibleCli } from "./cli.js";
import { startMessageDispatcher } from "./dispatcher.js";
export function register(api) {
    const config = api.pluginConfig;
    if (!config?.tier) {
        api.logger?.warn("Ansible plugin: 'tier' not configured, skipping initialization");
        return;
    }
    // Register the Yjs sync service
    api.registerService(createAnsibleService(api, config));
    // Per-gateway reliability guard (stale session locks)
    api.registerService(createLockSweepService(api, config));
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
//# sourceMappingURL=index.js.map