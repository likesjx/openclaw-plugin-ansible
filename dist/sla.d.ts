import type * as Y from "yjs";
import type { OpenClawPluginApi, ServiceContext } from "./types.js";
import type { AnsibleConfig } from "./schema.js";
type SlaBreach = {
    taskId: string;
    title: string;
    breachType: "accept" | "progress" | "complete";
    dueAt: number;
    status: string;
};
export type SlaSweepResult = {
    success: true;
    dryRun: boolean;
    scanned: number;
    breaches: SlaBreach[];
    breachCount: number;
    escalationsWritten: number;
};
type SweepOptions = {
    dryRun?: boolean;
    limit?: number;
    recordOnly?: boolean;
    maxMessages?: number;
    fyiAgents?: string[];
};
export declare function runSlaSweep(doc: Y.Doc, nodeId: string, options?: SweepOptions): SlaSweepResult;
export declare function createAnsibleSlaSweepService(api: OpenClawPluginApi, config: AnsibleConfig): {
    id: string;
    start(_ctx: ServiceContext): Promise<void>;
    stop(_ctx: ServiceContext): Promise<void>;
};
export {};
//# sourceMappingURL=sla.d.ts.map