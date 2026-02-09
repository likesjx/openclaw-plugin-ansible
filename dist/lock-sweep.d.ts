/**
 * Lock Sweep Service
 *
 * Per-gateway reliability guard: periodically remove stale session lock files.
 *
 * OpenClaw sessions are stored as `.jsonl` with a `.jsonl.lock` file used to
 * prevent concurrent writers. A stale lock can block agent runs indefinitely.
 *
 * Safety rules:
 * - Only remove a lock if it references a PID and that PID is not running.
 * - If the lock contains no PID, only remove if older than staleSeconds.
 *
 * The service is intentionally conservative and only touches files under:
 *   ~/.openclaw/agents/<agentId>/sessions/*.jsonl.lock
 */
import type { OpenClawPluginApi, ServiceContext } from "./types.js";
import type { AnsibleConfig } from "./schema.js";
export declare function createLockSweepService(_api: OpenClawPluginApi, config: AnsibleConfig): {
    id: string;
    start(ctx: ServiceContext): Promise<void>;
    stop(ctx: ServiceContext): Promise<void>;
};
//# sourceMappingURL=lock-sweep.d.ts.map