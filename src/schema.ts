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
    /** Enable/disable the sweeper. Default: true. */
    enabled?: boolean;
    /** Sweep interval. Default: 60 seconds. */
    everySeconds?: number;
    /** For stale lock files, remove after this many seconds. Default: 300. */
    staleSeconds?: number;
  };

  /**
   * Actor auth mode for mutating ansible operations.
   * - legacy: ignore tokens and use current node / explicit handle behavior
   * - mixed: prefer token when provided, fallback to legacy behavior
   * - token-required: mutating operations require agent_token
   */
  authMode?: "legacy" | "mixed" | "token-required";

  /**
   * Canonical admin actor handle for destructive admin operations.
   * Default: "admin"
   */
  adminAgentId?: string;
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

/** Tailscale node ID (e.g., "vps-jane", "macbook-air") - Gateway/infrastructure level */
export type TailscaleId = string;

/** Agent ID (e.g., "architect", "claude", "mac-jane") - Coordination endpoint */
export type AgentId = string;

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
// Agent Registry
// ============================================================================

/**
 * Represents a coordination endpoint — the addressable actor in ansible.
 * Internal agents run on a gateway and receive messages via auto-dispatch.
 * External agents (e.g., claude, codex) poll via the CLI.
 */
export interface AgentRecord {
  /** Display name (e.g., "Aria", "Beacon", "Astrid") */
  name?: string;

  /** Gateway that hosts this agent. null for external agents. */
  gateway: TailscaleId | null;

  /** internal = auto-dispatch into agent session; external = CLI poll only */
  type: "internal" | "external";

  /** When the agent was registered */
  registeredAt: number;

  /** Who registered this agent */
  registeredBy: TailscaleId;

  /** Token auth material (never store plaintext token; hash only). */
  auth?: {
    tokenHash: string;
    issuedAt: number;
    rotatedAt?: number;
    tokenHint?: string;
    acceptedAt?: number;
    acceptedByNode?: TailscaleId;
    acceptedByAgent?: string;
  };
}

// ============================================================================
// Core Metadata
// ============================================================================

/**
 * Core metadata fields required for all ansible coordination messages/tasks.
 * Skills can extend this with additional fields.
 */
export interface CoreMetadata {
  /** Conversation thread identifier for tracking related messages/tasks */
  conversation_id: string;

  /** Correlation ID for request/reply pairs (optional) */
  corr?: string;

  /** Message/task kind hint (proposal, status, result, alert, decision, etc.) */
  kind?: string;
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

  /** Agent that created this task (e.g., "architect", "claude") */
  createdBy_agent: AgentId;
  /** Gateway node the task was created from (informational) */
  createdBy_node?: TailscaleId;
  createdAt: number;

  /** Explicit assignment to a specific agent */
  assignedTo_agent?: AgentId;
  /** Optional multi-assignment target list (superset of assignedTo_agent) */
  assignedTo_agents?: AgentId[];

  /** Capability requirements for claiming */
  requires?: string[];

  /** Agent that claimed/is working on this task */
  claimedBy_agent?: AgentId;
  /** Gateway node that claimed the task (informational) */
  claimedBy_node?: TailscaleId;
  claimedAt?: number;

  /** Completion info */
  completedAt?: number;
  result?: string;

  /** Context transferred for delegation */
  context?: string;

  /** Semantic type for this task (e.g., "skill-setup", "delegation", "maintenance") */
  intent?: string;

  /** If set, only nodes that have advertised this skill will auto-dispatch this task */
  skillRequired?: string;

  /** Structured metadata. Should include CoreMetadata fields; skills add their own. */
  metadata?: Record<string, unknown>;

  /** Operational tracking */
  updatedAt?: number;
  updates?: Array<{
    at: number;
    by_agent: AgentId;
    status: TaskStatus;
    note?: string;
  }>;

  /**
   * Per-agent dispatch tracking so reconnect reconciliation can be deterministic
   * and idempotent. Keyed by agent ID.
   */
  delivery?: Record<AgentId, DeliveryRecord>;
}

// ============================================================================
// Messages
// ============================================================================

export interface Message {
  id: string;

  /** Agent that sent this message (e.g., "architect", "claude", "codex") */
  from_agent: AgentId;
  /** Gateway node the message was sent from (informational) */
  from_node?: TailscaleId;

  /** Semantic type (e.g., "skill-advertised", "status-update") */
  intent?: string;

  /**
   * Target agents. Broadcast to all authorized agents if omitted.
   * Multiple recipients share one message record; delivery tracked per agent.
   */
  to_agents?: AgentId[];

  content: string;
  /** Creation time (epoch ms) */
  timestamp: number;
  /** Last mutation time (epoch ms): delivery/read/metadata updates */
  updatedAt?: number;

  /** Agents that have read this message */
  readBy_agents: AgentId[];

  /** Structured metadata. Should include CoreMetadata fields; skills add their own. */
  metadata?: Record<string, unknown>;

  /**
   * Per-agent dispatch tracking so reconnect reconciliation can be deterministic
   * and idempotent. Keyed by agent ID.
   */
  delivery?: Record<AgentId, DeliveryRecord>;
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
  /** Advertised skill names this node handles */
  skills?: string[];
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
 * - retentionClosedTaskSeconds: number (default 604800 / 7 days)
 * - retentionPruneEverySeconds: number (default 86400 / daily)
 * - retentionLastPruneAt: number (ms epoch)
 * - retentionUpdatedAt: number (ms epoch)
 * - retentionUpdatedBy: TailscaleId
 * - delegationPolicyVersion: string
 * - delegationPolicyChecksum: string
 * - delegationPolicyMarkdown: string
 * - delegationPolicyUpdatedAt: number (ms epoch)
 * - delegationPolicyUpdatedBy: TailscaleId
 * - delegationAck:<nodeId>:version: string
 * - delegationAck:<nodeId>:checksum: string
 * - delegationAck:<nodeId>:at: number (ms epoch)
 * - pref:<nodeId>: CoordinationPreference
 */
export interface CoordinationState {
  coordinator?: TailscaleId;
  sweepEverySeconds?: number;
  updatedAt?: number;
  updatedBy?: TailscaleId;
  delegationPolicyVersion?: string;
  delegationPolicyChecksum?: string;
  delegationPolicyMarkdown?: string;
  delegationPolicyUpdatedAt?: number;
  delegationPolicyUpdatedBy?: TailscaleId;
}

// ============================================================================
// Full State
// ============================================================================

export interface AnsibleState {
  nodes: Map<TailscaleId, NodeInfo>;
  agents: Map<AgentId, AgentRecord>;
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
