/**
 * Ansible State Schema
 *
 * Defines the Yjs document structure for distributed coordination.
 */

// ============================================================================
// Configuration
// ============================================================================

export interface AnsibleConfig {
  /** Node tier: backbone (always-on) or edge (intermittent) */
  tier: "backbone" | "edge";

  /**
   * Override the node id used for addressing within the ansible mesh.
   *
   * Use this in environments where tailscale isn't available inside the runtime
   * (e.g., docker container), so the nodeId would otherwise be a random container
   * hostname like `a7f3fa01dade`.
   */
  nodeIdOverride?: string;

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

  /**
   * Periodically sweep stale session lock files (per-gateway reliability guard).
   *
   * This addresses cases where a crashed/interrupted agent run leaves behind a
   * `*.jsonl.lock` file that blocks future turns for that session.
   */
  lockSweep?: {
    /** Enable/disable the sweeper. Default: false (opt-in). */
    enabled?: boolean;
    /** Sweep interval. Default: 300 seconds. */
    everySeconds?: number;
    /** For locks without a PID, treat as stale after this many seconds. Default: 1800. */
    staleSeconds?: number;
  };
}

// ============================================================================
// Validation Limits
// ============================================================================

export const VALIDATION_LIMITS = {
  maxTitleLength: 200,
  maxDescriptionLength: 5000,
  maxMessageLength: 10000,
  maxContextLength: 5000,
  maxResultLength: 5000,
  maxStateFileBytes: 50 * 1024 * 1024, // 50MB
} as const;

// ============================================================================
// Node Identity
// ============================================================================

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

// ============================================================================
// Tasks
// ============================================================================

export type TaskStatus = "pending" | "claimed" | "in_progress" | "completed" | "failed";

// ============================================================================
// Delivery / Dispatch Tracking
// ============================================================================

/**
 * Tracks whether a specific node has had an item injected into its agent loop.
 *
 * We keep this in shared state so reconnect/restart reconciliation can be
 * idempotent (avoid duplicates) and can retry after transient failures.
 */
export type DeliveryState = "attempted" | "delivered";

export interface DeliveryRecord {
  state: DeliveryState;
  at: number;
  by: TailscaleId;
  attempts?: number;
  lastError?: string;
}

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

  /**
   * Per-node dispatch tracking so reconnect reconciliation can be deterministic
   * and idempotent. Keyed by receiver nodeId.
   */
  delivery?: Record<TailscaleId, DeliveryRecord>;
}

// ============================================================================
// Messages
// ============================================================================

export interface Message {
  id: string;
  from: TailscaleId;
  to?: TailscaleId; // Broadcast if omitted
  content: string;
  timestamp: number;
  readBy: TailscaleId[];

  /**
   * Per-node dispatch tracking so reconnect reconciliation can be deterministic
   * and idempotent. Keyed by receiver nodeId.
   */
  delivery?: Record<TailscaleId, DeliveryRecord>;
}

// ============================================================================
// Context (per-node to avoid conflicts)
// ============================================================================

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

// ============================================================================
// Pulse (health/presence)
// ============================================================================

export interface PulseData {
  lastSeen: number;
  status: "online" | "busy" | "offline";
  currentTask?: string;
  version?: string;
}

// ============================================================================
// Coordination (Coordinator Role + Preferences)
// ============================================================================

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

// ============================================================================
// Full State
// ============================================================================

export interface AnsibleState {
  nodes: Map<TailscaleId, NodeInfo>;
  pendingInvites: Map<string, PendingInvite>;
  tasks: Map<string, Task>;
  messages: Map<string, Message>;
  context: Map<TailscaleId, NodeContext>;
  pulse: Map<TailscaleId, PulseData>;
  coordination: Map<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

export const CONTEXT_LIMITS = {
  activeThreads: 3,
  recentDecisions: 3,
  pendingTasks: 5,
  unreadMessages: 5,
  maxAgeHours: 24,
} as const;

export const MESSAGE_RETENTION = {
  maxAgeHours: 24,
  maxCount: 50,
  keepUnread: true,
} as const;

export const STANDARD_CAPABILITIES = ["always-on", "local-files", "gpu"] as const;

export const INVITE_TTL_MS = 15 * 60 * 1000; // 15 minutes
