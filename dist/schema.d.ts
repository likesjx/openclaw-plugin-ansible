/**
 * Ansible State Schema
 *
 * Defines the Yjs document structure for distributed coordination.
 */
export interface AnsibleConfig {
    /** Node tier: backbone (always-on) or edge (intermittent) */
    tier: "backbone" | "edge";
    /** WebSocket port for backbone nodes to listen on */
    listenPort?: number;
    /** Host/IP to bind WebSocket server to. Defaults to auto-detected Tailscale IP. */
    listenHost?: string;
    /** WebSocket URLs of backbone peers to connect to */
    backbonePeers?: string[];
    /** Capabilities this node provides */
    capabilities?: string[];
    /**
     * Inject shared ansible context into the agent prompt via the
     * `before_agent_start` hook.
     *
     * Default: true
     *
     * Set false if you want ansible to be "manual only" (e.g., an Architect-managed
     * ops mesh where other agents should not see cross-node context).
     */
    injectContext?: boolean;
    /**
     * Restrict context injection to specific agent IDs.
     *
     * When set, only these agents will receive prependContext from ansible.
     * This is useful when you want hemisphere sync for "Jane" agents but not
     * for an operator/manager agent like "architect".
     *
     * Example: ["mac-jane", "vps-jane"]
     */
    injectContextAgents?: string[];
    /**
     * Auto-dispatch inbound ansible messages into the agent loop.
     *
     * Default: true
     *
     * Set false to prevent messages from being routed to the default agent.
     * In this mode, an operator agent should poll with `ansible_read_messages`
     * and respond with `ansible_send_message`.
     */
    dispatchIncoming?: boolean;
}
export declare const VALIDATION_LIMITS: {
    readonly maxTitleLength: 200;
    readonly maxDescriptionLength: 5000;
    readonly maxMessageLength: 10000;
    readonly maxContextLength: 5000;
    readonly maxResultLength: 5000;
    readonly maxStateFileBytes: number;
};
/** Tailscale node ID (e.g., "vps-jane", "macbook-air") */
export type TailscaleId = string;
export interface NodeInfo {
    name: string;
    tier: "backbone" | "edge";
    capabilities: string[];
    addedBy: TailscaleId;
    addedAt: number;
}
export interface PendingInvite {
    tier: "backbone" | "edge";
    expiresAt: number;
    createdBy: TailscaleId;
}
export type TaskStatus = "pending" | "claimed" | "in_progress" | "completed" | "failed";
export interface Task {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    createdBy: TailscaleId;
    createdAt: number;
    /** Explicit assignment to a specific node */
    assignedTo?: TailscaleId;
    /** Capability requirements for claiming */
    requires?: string[];
    /** Who claimed/is working on the task */
    claimedBy?: TailscaleId;
    claimedAt?: number;
    /** Completion info */
    completedAt?: number;
    result?: string;
    /** Context transferred for delegation */
    context?: string;
    /** Operational metadata */
    updatedAt?: number;
    updates?: Array<{
        at: number;
        by: TailscaleId;
        status: TaskStatus;
        note?: string;
    }>;
}
export interface Message {
    id: string;
    from: TailscaleId;
    to?: TailscaleId;
    content: string;
    timestamp: number;
    readBy: TailscaleId[];
}
export interface Thread {
    id: string;
    summary: string;
    lastActivity: number;
}
export interface Decision {
    decision: string;
    reasoning: string;
    madeAt: number;
}
export interface NodeContext {
    currentFocus: string;
    activeThreads: Thread[];
    recentDecisions: Decision[];
}
export interface PulseData {
    lastSeen: number;
    status: "online" | "busy" | "offline";
    currentTask?: string;
    version?: string;
}
export interface CoordinationPreference {
    desiredCoordinator?: TailscaleId;
    desiredSweepEverySeconds?: number;
    updatedAt: number;
}
/**
 * Stored in the shared Yjs doc map `coordination`.
 *
 * Keys:
 * - coordinator: TailscaleId
 * - sweepEverySeconds: number
 * - updatedAt: number
 * - updatedBy: TailscaleId
 * - pref:<nodeId>: CoordinationPreference
 */
export interface CoordinationState {
    coordinator?: TailscaleId;
    sweepEverySeconds?: number;
    updatedAt?: number;
    updatedBy?: TailscaleId;
}
export interface AnsibleState {
    nodes: Map<TailscaleId, NodeInfo>;
    pendingInvites: Map<string, PendingInvite>;
    tasks: Map<string, Task>;
    messages: Map<string, Message>;
    context: Map<TailscaleId, NodeContext>;
    pulse: Map<TailscaleId, PulseData>;
    coordination: Map<string, unknown>;
}
export declare const CONTEXT_LIMITS: {
    readonly activeThreads: 3;
    readonly recentDecisions: 3;
    readonly pendingTasks: 5;
    readonly unreadMessages: 5;
    readonly maxAgeHours: 24;
};
export declare const MESSAGE_RETENTION: {
    readonly maxAgeHours: 24;
    readonly maxCount: 50;
    readonly keepUnread: true;
};
export declare const STANDARD_CAPABILITIES: readonly ["always-on", "local-files", "gpu"];
export declare const INVITE_TTL_MS: number;
//# sourceMappingURL=schema.d.ts.map