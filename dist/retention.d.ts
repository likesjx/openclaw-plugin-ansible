/**
 * Coordinator Retention / Roll-off
 *
 * Goal: keep shared coordination state trustworthy by pruning closed tasks
 * after a configurable TTL. This is intentionally coordinator-only to avoid
 * multi-node races and surprises.
 *
 * Defaults:
 * - Run cadence: daily
 * - Closed task retention: 7 days
 *
 * Storage: coordination Y.Map keys (shared):
 * - retentionClosedTaskSeconds: number
 * - retentionPruneEverySeconds: number
 * - retentionLastPruneAt: number (ms epoch)
 * - retentionUpdatedAt: number (ms epoch)
 * - retentionUpdatedBy: TailscaleId
 */
import type { OpenClawPluginApi, ServiceContext } from "./types.js";
import type { AnsibleConfig } from "./schema.js";
export declare function createAnsibleRetentionService(api: OpenClawPluginApi, config: AnsibleConfig): {
    id: string;
    start(ctx: ServiceContext): Promise<void>;
    stop(_ctx: ServiceContext): Promise<void>;
};
//# sourceMappingURL=retention.d.ts.map