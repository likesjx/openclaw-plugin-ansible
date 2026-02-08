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
// Full State
// ============================================================================

export interface AnsibleState {
  nodes: Map<TailscaleId, NodeInfo>;
  pendingInvites: Map<string, PendingInvite>;
  tasks: Map<string, Task>;
  messages: Map<string, Message>;
  context: Map<TailscaleId, NodeContext>;
  pulse: Map<TailscaleId, PulseData>;
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
