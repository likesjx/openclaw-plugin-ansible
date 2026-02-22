/**
 * Ansible Agent Tools
 *
 * Tools available to the agent for inter-hemisphere coordination.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import type { OpenClawPluginApi } from "./types.js";
import type { AnsibleConfig, Task, Message, NodeContext, Decision, Thread, PulseData, CoordinationPreference } from "./schema.js";
import { VALIDATION_LIMITS } from "./schema.js";
import { getDoc, getNodeId, getAnsibleState } from "./service.js";
import { requestDispatcherReconcile } from "./dispatcher.js";
import { isNodeAuthorized } from "./auth.js";
import { getLockSweepStatus } from "./lock-sweep.js";

/**
 * Wrap a tool result in the AgentToolResult format expected by pi-agent-core.
 * Tools must return { content: [{type: "text", text: "..."}], details: T }
 * or the toolResult message will be missing its content field, causing
 * pi-ai providers to crash with "Cannot read properties of undefined (reading 'filter')".
 */
function toolResult(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    details: data,
  };
}

function isMapLike(value: unknown): value is { entries: () => IterableIterator<[unknown, unknown]> } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as any).entries === "function" &&
    typeof (value as any).get === "function" &&
    typeof (value as any).set === "function"
  );
}

function serializeValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => serializeValue(v, seen));

  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);

    if (isMapLike(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value.entries()) {
        out[String(k)] = serializeValue(v, seen);
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeValue(v, seen);
    }
    return out;
  }

  return String(value);
}

function validateString(value: unknown, maxLength: number, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${fieldName} exceeds max length of ${maxLength}`);
  }
  return value;
}

function validateNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return value;
}

function requireAuth(nodeId: string): void {
  if (!isNodeAuthorized(nodeId)) {
    throw new Error("Node not authorized. Use 'ansible join' first.");
  }
}

function getAuthMode(config: AnsibleConfig): "legacy" | "mixed" | "token-required" {
  const mode = (config as any)?.authMode;
  if (mode === "legacy" || mode === "token-required") return mode;
  return "mixed";
}

function hashAgentToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function tokenHintFromHash(hash: string): string {
  const normalized = String(hash || "");
  const hex = normalized.startsWith("sha256:") ? normalized.slice("sha256:".length) : normalized;
  if (!hex) return "";
  return `sha256:${hex.slice(0, 12)}`;
}

function mintAgentToken(): string {
  return `at_${randomBytes(24).toString("hex")}`;
}

function mintAgentInviteToken(): string {
  return `ait_${randomBytes(20).toString("hex")}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function resolveAgentByToken(doc: ReturnType<typeof getDoc>, token: string): string | null {
  if (!doc) return null;
  const agents = doc.getMap("agents");
  const want = hashAgentToken(token);
  for (const [id, raw] of agents.entries()) {
    const rec = raw as Record<string, unknown> | undefined;
    const auth = (rec?.auth as Record<string, unknown> | undefined) || undefined;
    const tokenHash = typeof auth?.tokenHash === "string" ? auth.tokenHash : "";
    if (!tokenHash) continue;
    if (safeEqual(tokenHash, want)) return String(id);
  }
  return null;
}

type AgentInviteRecord = {
  agent_id: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  createdBy: string;
  createdByAgent?: string;
  usedAt?: number;
  usedByNode?: string;
  usedByAgent?: string;
  revokedAt?: number;
  revokedReason?: string;
};

function getAgentInvitesMap(doc: ReturnType<typeof getDoc>) {
  if (!doc) return null;
  return doc.getMap("agentInvites");
}

function pruneExpiredAgentInvites(invites: ReturnType<typeof getAgentInvitesMap>): number {
  if (!invites) return 0;
  let removed = 0;
  const now = Date.now();
  for (const [id, raw] of invites.entries()) {
    const invite = raw as AgentInviteRecord | undefined;
    if (!invite) continue;
    if (invite.usedAt || invite.revokedAt) continue;
    if (typeof invite.expiresAt === "number" && invite.expiresAt < now) {
      invites.delete(String(id));
      removed += 1;
    }
  }
  return removed;
}

function findInviteByToken(
  invites: ReturnType<typeof getAgentInvitesMap>,
  inviteToken: string,
): { id: string; invite: AgentInviteRecord } | null {
  if (!invites) return null;
  const want = hashAgentToken(inviteToken);
  const now = Date.now();

  for (const [id, raw] of invites.entries()) {
    const invite = raw as AgentInviteRecord | undefined;
    if (!invite || typeof invite.tokenHash !== "string") continue;
    if (invite.usedAt || invite.revokedAt) continue;
    if (typeof invite.expiresAt === "number" && invite.expiresAt < now) continue;
    if (safeEqual(invite.tokenHash, want)) {
      return { id: String(id), invite };
    }
  }
  return null;
}

function requireAdmin(nodeId: string, doc: ReturnType<typeof getDoc>): void {
  const nodes = doc?.getMap("nodes");
  const me = nodes?.get(nodeId) as { capabilities?: string[] } | undefined;
  const caps = Array.isArray(me?.capabilities) ? me!.capabilities : [];
  if (!caps.includes("admin")) {
    throw new Error(
      "Admin capability required for this destructive operation. Add capability 'admin' to this node configuration.",
    );
  }
}

/**
 * Resolve the effective admin actor for a privileged operation.
 *
 * Secure path (always allowed): agent_token present → resolve via token hash.
 * Bootstrap path (internal agents only): no token, but from_agent is an internal
 * agent running on this node. Gateway-level auth is sufficient — internal agents
 * cannot be impersonated by external callers.
 * External agents must always supply agent_token.
 */
function resolveAdminActorOrError(
  doc: ReturnType<typeof getDoc>,
  nodeId: string,
  token: string | undefined,
  requestedFrom: string | undefined,
): { actor: string; error?: never } | { actor?: never; error: string } {
  if (token) {
    const tokenActor = resolveAgentByToken(doc, token);
    if (!tokenActor) return { error: "Invalid agent_token." };
    if (requestedFrom && requestedFrom.trim() && requestedFrom.trim() !== tokenActor) {
      return { error: "from_agent does not match token identity. Omit from_agent when using agent_token." };
    }
    return { actor: tokenActor };
  }

  // No token: only permit internal agents running on this node (bootstrap path).
  const from = (requestedFrom || "").trim();
  if (!from) {
    return { error: "agent_token is required, or provide from_agent if acting as an internal agent on this node." };
  }
  const agents = doc?.getMap("agents");
  const rec = agents?.get(from) as Record<string, unknown> | undefined;
  if (!rec) {
    return { error: `Agent '${from}' is not registered. Use agent_token or register the agent first.` };
  }
  if (rec.type !== "internal" || rec.gateway !== nodeId) {
    return { error: `agent_token is required for '${from}' (external agents or agents on other nodes must provide a token).` };
  }
  return { actor: from };
}

function requireAdminActor(
  doc: ReturnType<typeof getDoc>,
  nodeId: string,
  adminAgentId: string,
  requestedFrom: string | undefined,
): void {
  const from = (requestedFrom || "").trim();
  if (!from) {
    throw new Error(
      `from_agent is required for this operation and must be '${adminAgentId}'.`,
    );
  }
  if (from !== adminAgentId) {
    throw new Error(
      `from_agent must be '${adminAgentId}' for this operation (got '${from}').`,
    );
  }

  const agents = doc?.getMap("agents");
  const rec = agents?.get(from) as Record<string, unknown> | undefined;
  if (!rec) {
    throw new Error(
      `Admin agent '${adminAgentId}' is not registered. Register it with ansible_register_agent first.`,
    );
  }
  const t = String(rec.type || "");
  if (t === "external") return;
  if (t === "internal") {
    const gateway = typeof rec.gateway === "string" ? rec.gateway : "";
    if (gateway !== nodeId) {
      throw new Error(
        `Admin agent '${adminAgentId}' is internal on gateway '${gateway}', not this node '${nodeId}'.`,
      );
    }
    return;
  }
  throw new Error(
    `Admin agent '${adminAgentId}' has unsupported type '${t}'.`,
  );
}

function getCoordinationMap(doc: ReturnType<typeof getDoc>) {
  return doc?.getMap("coordination");
}

function readCoordinationState(doc: ReturnType<typeof getDoc>) {
  const m = getCoordinationMap(doc);
  if (!m) return null;
  return {
    coordinator: m.get("coordinator") as string | undefined,
    sweepEverySeconds: m.get("sweepEverySeconds") as number | undefined,
    retentionClosedTaskSeconds: m.get("retentionClosedTaskSeconds") as number | undefined,
    retentionPruneEverySeconds: m.get("retentionPruneEverySeconds") as number | undefined,
    retentionLastPruneAt: m.get("retentionLastPruneAt") as number | undefined,
    delegationPolicyVersion: m.get("delegationPolicyVersion") as string | undefined,
    delegationPolicyChecksum: m.get("delegationPolicyChecksum") as string | undefined,
    delegationPolicyUpdatedAt: m.get("delegationPolicyUpdatedAt") as number | undefined,
    delegationPolicyUpdatedBy: m.get("delegationPolicyUpdatedBy") as string | undefined,
    updatedAt: m.get("updatedAt") as number | undefined,
    updatedBy: m.get("updatedBy") as string | undefined,
  };
}

function computeSha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function readDelegationAcks(m: any): Record<string, { version?: string; checksum?: string; at?: number }> {
  const out: Record<string, { version?: string; checksum?: string; at?: number }> = {};
  for (const [k, v] of m.entries()) {
    const key = String(k);
    if (!key.startsWith("delegationAck:")) continue;
    const parts = key.split(":");
    if (parts.length < 3) continue;
    const agentId = parts[1];
    const field = parts[2];
    out[agentId] = out[agentId] || {};
    if (field === "version") out[agentId].version = typeof v === "string" ? v : undefined;
    if (field === "checksum") out[agentId].checksum = typeof v === "string" ? v : undefined;
    if (field === "at") out[agentId].at = typeof v === "number" ? v : undefined;
  }
  return out;
}

function notifyTaskOwner(
  doc: ReturnType<typeof getDoc>,
  fromNodeId: string,
  task: Task,
  payload: { kind: "update" | "completed" | "failed"; note?: string; result?: string }
): string | null {
  if (!doc) return null;
  if (!task.createdBy_agent) return null;

  const messages = doc.getMap("messages");
  const messageId = randomUUID();
  const lines: string[] = [];
  lines.push(`[task:${task.id.slice(0, 8)}] ${task.title}`);
  lines.push(`status: ${task.status}`);
  if (payload.note) lines.push(`note: ${payload.note}`);
  const result = payload.result ?? task.result;
  if (result) lines.push(`result: ${result}`);
  lines.push(`from: ${fromNodeId}`);

  const now = Date.now();
  const message: Message = {
    id: messageId,
    from_agent: fromNodeId,
    from_node: fromNodeId,
    to_agents: [task.createdBy_agent],
    content: lines.join("\n"),
    timestamp: now,
    updatedAt: now,
    readBy_agents: [fromNodeId],
  };
  messages.set(message.id, message);
  return messageId;
}

function resolveTaskKey(
  tasks: { get: (k: string) => unknown; keys: () => IterableIterator<string>; entries?: () => IterableIterator<[string, unknown]> },
  idOrPrefix: string,
): string | { error: string } {
  const needle = String(idOrPrefix || "").trim();
  if (!needle) return { error: "Task id is required" };

  // Exact match first.
  if (tasks.get(needle) !== undefined) return needle;

  // Prefix match (common when users reference 8-char short ids).
  const matches: string[] = [];
  for (const k of tasks.keys()) {
    if (k.startsWith(needle)) matches.push(k);
  }

  // Fallback: match by value.id prefix (handles legacy/odd states where task.id != key).
  if (matches.length === 0 && typeof tasks.entries === "function") {
    for (const [k, v] of tasks.entries()) {
      const id = v && typeof v === "object" && "id" in (v as any) ? String((v as any).id || "") : "";
      if (id && id.startsWith(needle)) matches.push(k);
    }
  }

  if (matches.length === 0) return { error: "Task not found" };
  if (matches.length === 1) return matches[0];

  return {
    error: `Ambiguous task id prefix '${needle}'. Matches: ${matches.slice(0, 8).join(", ")}${matches.length > 8 ? ", ..." : ""}`,
  };
}

/**
 * Resolve the effective agent ID for task operations.
 * Internal agents use nodeId (must be authorized in the nodes map).
 * External agents provide agentId, which is verified against the agents registry.
 */
function resolveEffectiveAgent(
  doc: ReturnType<typeof getDoc>,
  nodeId: string,
  agentId: string | undefined,
  agentToken: string | undefined,
  authMode: "legacy" | "mixed" | "token-required",
): { effectiveAgent: string; error?: never } | { effectiveAgent?: never; error: string } {
  if (agentToken) {
    const byToken = resolveAgentByToken(doc, agentToken);
    if (!byToken) return { error: "Invalid agent_token." };
    return { effectiveAgent: byToken };
  }

  if (authMode === "token-required") {
    return { error: "agent_token is required for this operation." };
  }

  if (!agentId) {
    requireAuth(nodeId);
    return { effectiveAgent: nodeId };
  }
  const agents = doc!.getMap("agents");
  const record = agents.get(agentId) as { type?: string } | undefined;
  if (!record) {
    return { error: `Agent '${agentId}' is not registered. Use: openclaw ansible agent register --id ${agentId}` };
  }
  return { effectiveAgent: agentId };
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function getInternalAgentsByGateway(doc: ReturnType<typeof getDoc>, gatewayId: string): string[] {
  if (!doc) return [];
  const agents = doc.getMap("agents");
  const out: string[] = [];
  for (const [id, raw] of agents.entries()) {
    const rec = raw as { type?: string; gateway?: string | null } | undefined;
    if (!rec || rec.type !== "internal") continue;
    if (rec.gateway === gatewayId) out.push(String(id));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function resolveAssignedTargets(
  doc: ReturnType<typeof getDoc>,
  nodeId: string,
  explicitAssignedTo: string | undefined,
  requires: string[],
): { assignees: string[]; error?: never } | { assignees?: never; error: string } {
  if (!doc) return { error: "Ansible not initialized" };
  const assignedTo = explicitAssignedTo?.trim();
  const agents = doc.getMap("agents");
  const context = doc.getMap("context");
  const nodes = doc.getMap("nodes");

  if (!assignedTo && requires.length === 0) {
    return { error: "Task must include assignedTo or requires (or both)." };
  }

  if (assignedTo) {
    const direct = agents.get(assignedTo);
    if (direct) return { assignees: [assignedTo] };

    // Back-compat: caller passed a gateway/node id. Resolve to first local internal agent.
    const nodeExists = nodes.get(assignedTo) !== undefined;
    if (nodeExists) {
      const candidates = getInternalAgentsByGateway(doc, assignedTo);
      if (candidates.length > 0) return { assignees: [candidates[0]] };
      return { assignees: [assignedTo] };
    }

    return { error: `assignedTo '${assignedTo}' is not a known agent or node.` };
  }

  const skillToAgents = new Map<string, string[]>();
  for (const skill of requires) {
    const matches = new Set<string>();
    for (const [agentId, raw] of agents.entries()) {
      const rec = raw as { type?: string; gateway?: string | null } | undefined;
      if (!rec) continue;

      if (Array.isArray((context.get(String(agentId)) as NodeContext | undefined)?.skills)) {
        const agentSkills = (context.get(String(agentId)) as NodeContext | undefined)?.skills ?? [];
        if (agentSkills.includes(skill)) matches.add(String(agentId));
      }

      if (rec.type === "internal" && rec.gateway) {
        const gatewaySkills = (context.get(rec.gateway) as NodeContext | undefined)?.skills ?? [];
        if (gatewaySkills.includes(skill)) matches.add(String(agentId));
      }
    }

    const ordered = Array.from(matches).sort((a, b) => a.localeCompare(b));
    if (ordered.length === 0) return { error: `No registered agent advertises required skill '${skill}'.` };
    skillToAgents.set(skill, ordered);
  }

  if (requires.length === 1) {
    return { assignees: [skillToAgents.get(requires[0])![0]] };
  }

  const union = new Set<string>();
  for (const skill of requires) {
    for (const id of skillToAgents.get(skill) || []) union.add(id);
  }
  const assignees = Array.from(union).sort((a, b) => a.localeCompare(b));
  return assignees.length > 0
    ? { assignees }
    : { error: "No assignees resolved from requires." };
}

export function registerAnsibleTools(
  api: OpenClawPluginApi,
  config: AnsibleConfig
) {
  // === ansible_find_task ===
  api.registerTool({
    name: "ansible_find_task",
    label: "Ansible Find Task",
    description:
      "Find tasks by id prefix or title substring. Returns both the Yjs map key and the task.id (they should match).",
    parameters: {
      type: "object",
      properties: {
        idPrefix: { type: "string", description: "Task id prefix (often 8 chars from ansible_status)" },
        titleContains: { type: "string", description: "Case-insensitive substring match on task title" },
        status: { type: "string", description: "Filter by status (pending|claimed|in_progress|completed|failed)" },
        assignedTo: { type: "string", description: "Filter by assigned agent ID (e.g., 'claude-code')" },
        limit: { type: "number", description: "Max results to return (default 10)" },
      },
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });

      try {
        requireAuth(nodeId);
        const tasks = doc.getMap("tasks");
        const idPrefix = params.idPrefix ? String(params.idPrefix).trim() : "";
        const titleContains = params.titleContains ? String(params.titleContains).trim().toLowerCase() : "";
        const status = params.status ? String(params.status).trim() : "";
        const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.min(50, params.limit)) : 10;

        const assignedTo = params.assignedTo ? String(params.assignedTo).trim() : "";

        const out: any[] = [];
        for (const [k, v] of (tasks as any).entries()) {
          const t = v as Task;
          if (!t) continue;
          if (status && t.status !== status) continue;
          if (idPrefix && !(String(k).startsWith(idPrefix) || String(t.id || "").startsWith(idPrefix))) continue;
          if (titleContains && !String(t.title || "").toLowerCase().includes(titleContains)) continue;
          const assignees = Array.from(
            new Set([...(t.assignedTo_agent ? [t.assignedTo_agent] : []), ...((t.assignedTo_agents as string[]) || [])]),
          );
          if (assignedTo && !assignees.includes(assignedTo)) continue;
          out.push({
            key: k,
            id: t.id,
            title: t.title,
            status: t.status,
            assignedTo: t.assignedTo_agent,
            assignedToAll: assignees,
            createdBy: t.createdBy_agent,
            claimedBy: t.claimedBy_agent,
            updatedAt: t.updatedAt,
          });
        }

        out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return toolResult({ matches: out.slice(0, limit), total: out.length });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_lock_sweep_status ===
  api.registerTool({
    name: "ansible_lock_sweep_status",
    label: "Ansible Lock Sweep Status",
    description:
      "Get the per-gateway session lock sweeper status (last run + totals). Helps diagnose stuck 'session file locked' issues.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const enabled = config.lockSweep?.enabled ?? true;
      const everySeconds = Math.max(30, Math.floor(config.lockSweep?.everySeconds ?? 60));
      const staleSeconds = Math.max(30, Math.floor(config.lockSweep?.staleSeconds ?? 300));
      const status = getLockSweepStatus();
      return toolResult({
        enabled,
        config: { everySeconds, staleSeconds },
        lastStatus: status.lastStatus,
        totals: status.totals,
      });
    },
  });

  // === ansible_get_coordination ===
  api.registerTool({
    name: "ansible_get_coordination",
    label: "Ansible Get Coordination",
    description:
      "Get current coordinator configuration (coordinator node id, sweep cadence) and your saved preference (if any).",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });

      try {
        requireAuth(nodeId);
        const state = readCoordinationState(doc) || {};
        const m = getCoordinationMap(doc);
        const pref = (m?.get(`pref:${nodeId}`) as CoordinationPreference | undefined) || null;
        return toolResult({
          myId: nodeId,
          ...state,
          myPreference: pref,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_set_coordination_preference ===
  api.registerTool({
    name: "ansible_set_coordination_preference",
    label: "Ansible Set Coordination Preference",
    description:
      "Record your preferred coordinator and/or sweep cadence. The coordinator may use these preferences when configuring cron and routing.",
    parameters: {
      type: "object",
      properties: {
        desiredCoordinator: {
          type: "string",
          description: "Preferred coordinator node id (optional).",
        },
        desiredSweepEverySeconds: {
          type: "number",
          description: "Preferred sweep cadence in seconds (optional).",
        },
      },
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });

      try {
        requireAuth(nodeId);
        const desiredCoordinator = params.desiredCoordinator
          ? validateString(params.desiredCoordinator, 200, "desiredCoordinator")
          : undefined;
        const desiredSweepEverySeconds =
          params.desiredSweepEverySeconds !== undefined
            ? validateNumber(params.desiredSweepEverySeconds, "desiredSweepEverySeconds")
            : undefined;

        if (!desiredCoordinator && desiredSweepEverySeconds === undefined) {
          return toolResult({ error: "Provide desiredCoordinator and/or desiredSweepEverySeconds" });
        }

        const m = getCoordinationMap(doc);
        if (!m) return toolResult({ error: "Ansible not initialized" });

        const pref: CoordinationPreference = {
          desiredCoordinator,
          desiredSweepEverySeconds,
          updatedAt: Date.now(),
        };
        m.set(`pref:${nodeId}`, pref);

        return toolResult({ success: true, myId: nodeId, preference: pref });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_set_coordination ===
  api.registerTool({
    name: "ansible_set_coordination",
    label: "Ansible Set Coordination",
    description:
      "Set the coordinator node id and sweep cadence. Use for initial setup or last-resort coordinator failover.",
    parameters: {
      type: "object",
      properties: {
        coordinator: {
          type: "string",
          description: "Coordinator node id (e.g., vps-jane).",
        },
        sweepEverySeconds: {
          type: "number",
          description: "Sweep cadence in seconds (e.g., 60).",
        },
        confirmLastResort: {
          type: "boolean",
          description:
            "Required when changing an existing coordinator to a different node (failover).",
        },
      },
      required: ["coordinator", "sweepEverySeconds"],
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });

      try {
        requireAuth(nodeId);
        const coordinator = validateString(params.coordinator, 200, "coordinator");
        const sweepEverySeconds = validateNumber(params.sweepEverySeconds, "sweepEverySeconds");
        if (sweepEverySeconds < 10 || sweepEverySeconds > 3600) {
          return toolResult({ error: "sweepEverySeconds must be between 10 and 3600" });
        }

        const m = getCoordinationMap(doc);
        if (!m) return toolResult({ error: "Ansible not initialized" });

        const existing = m.get("coordinator") as string | undefined;
        if (existing && existing !== coordinator) {
          if (params.confirmLastResort !== true) {
            return toolResult({
              error:
                "Changing coordinator requires confirmLastResort=true (to avoid accidental role moves).",
            });
          }
        }

        m.set("coordinator", coordinator);
        m.set("sweepEverySeconds", sweepEverySeconds);
        m.set("updatedAt", Date.now());
        m.set("updatedBy", nodeId);

        return toolResult({
          success: true,
          coordinator,
          sweepEverySeconds,
          updatedBy: nodeId,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_set_retention ===
  api.registerTool({
    name: "ansible_set_retention",
    label: "Ansible Set Retention",
    description:
      "Configure coordinator roll-off policy: run daily (or configurable) and prune closed tasks older than a TTL. Takes effect on the coordinator backbone node.",
    parameters: {
      type: "object",
      properties: {
        closedTaskRetentionDays: {
          type: "number",
          description: "Delete completed/failed tasks older than this many days. Default 7.",
        },
        pruneEveryHours: {
          type: "number",
          description: "How often the coordinator runs the prune (hours). Default 24.",
        },
      },
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });

      try {
        requireAuth(nodeId);
        const m = getCoordinationMap(doc);
        if (!m) return toolResult({ error: "Coordination map not initialized" });

        const days =
          params.closedTaskRetentionDays === undefined
            ? 7
            : validateNumber(params.closedTaskRetentionDays, "closedTaskRetentionDays");
        const hours =
          params.pruneEveryHours === undefined ? 24 : validateNumber(params.pruneEveryHours, "pruneEveryHours");

        if (days < 1 || days > 90) return toolResult({ error: "closedTaskRetentionDays must be between 1 and 90" });
        if (hours < 1 || hours > 168) return toolResult({ error: "pruneEveryHours must be between 1 and 168" });

        const closedTaskSeconds = Math.floor(days * 24 * 60 * 60);
        const pruneEverySeconds = Math.floor(hours * 60 * 60);

        m.set("retentionClosedTaskSeconds", closedTaskSeconds);
        m.set("retentionPruneEverySeconds", pruneEverySeconds);
        m.set("retentionUpdatedAt", Date.now());
        m.set("retentionUpdatedBy", nodeId);

        return toolResult({
          success: true,
          retentionClosedTaskSeconds: closedTaskSeconds,
          retentionPruneEverySeconds: pruneEverySeconds,
          retentionUpdatedAt: m.get("retentionUpdatedAt"),
          retentionUpdatedBy: m.get("retentionUpdatedBy"),
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_get_delegation_policy ===
  api.registerTool({
    name: "ansible_get_delegation_policy",
    label: "Ansible Get Delegation Policy",
    description:
      "Read the shared delegation policy (version/checksum/markdown) and ack status by agent.",
    parameters: {
      type: "object",
      properties: {
        includeAcks: {
          type: "boolean",
          description: "Include delegation ACK records by agent (default true).",
        },
      },
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });

      try {
        requireAuth(nodeId);
        const m = getCoordinationMap(doc);
        if (!m) return toolResult({ error: "Coordination map not initialized" });

        const includeAcks = params.includeAcks !== false;
        const out: Record<string, unknown> = {
          delegationPolicyVersion: m.get("delegationPolicyVersion"),
          delegationPolicyChecksum: m.get("delegationPolicyChecksum"),
          delegationPolicyMarkdown: m.get("delegationPolicyMarkdown"),
          delegationPolicyUpdatedAt: m.get("delegationPolicyUpdatedAt"),
          delegationPolicyUpdatedBy: m.get("delegationPolicyUpdatedBy"),
        };
        if (includeAcks) out.acks = readDelegationAcks(m);
        return toolResult(out);
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_set_delegation_policy ===
  api.registerTool({
    name: "ansible_set_delegation_policy",
    label: "Ansible Set Delegation Policy",
    description:
      "Coordinator-only: publish delegation policy markdown + version/checksum and optionally send policy update messages to target agents.",
    parameters: {
      type: "object",
      properties: {
        policyMarkdown: {
          type: "string",
          description: "Canonical policy markdown (table + metadata).",
        },
        version: {
          type: "string",
          description: "Policy version string (e.g., 2026-02-12.1).",
        },
        checksum: {
          type: "string",
          description: "Optional checksum; if omitted, computed as sha256(policyMarkdown).",
        },
        notifyAgents: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of agent/node ids to notify with a policy_update message.",
        },
      },
      required: ["policyMarkdown", "version"],
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });

      try {
        requireAuth(nodeId);
        const m = getCoordinationMap(doc);
        if (!m) return toolResult({ error: "Coordination map not initialized" });

        const coordinator = m.get("coordinator") as string | undefined;
        if (!coordinator) return toolResult({ error: "Coordinator not configured. Set with ansible_set_coordination first." });
        if (coordinator !== nodeId) return toolResult({ error: `Only coordinator (${coordinator}) can publish delegation policy` });

        const policyMarkdown = validateString(params.policyMarkdown, 200_000, "policyMarkdown");
        const version = validateString(params.version, 120, "version");
        const checksum = params.checksum
          ? validateString(params.checksum, 200, "checksum")
          : computeSha256(policyMarkdown);

        m.set("delegationPolicyVersion", version);
        m.set("delegationPolicyChecksum", checksum);
        m.set("delegationPolicyMarkdown", policyMarkdown);
        m.set("delegationPolicyUpdatedAt", Date.now());
        m.set("delegationPolicyUpdatedBy", nodeId);

        const notified: string[] = [];
        const rawNotify = Array.isArray(params.notifyAgents) ? (params.notifyAgents as unknown[]) : [];
        const notifyAgents = rawNotify
          .filter((x) => typeof x === "string" && String(x).trim().length > 0)
          .map((x) => String(x).trim());

        if (notifyAgents.length > 0) {
          const messages = doc.getMap("messages");
          for (const to of notifyAgents) {
            const now = Date.now();
            const message: Message = {
              id: randomUUID(),
              from_agent: nodeId,
              from_node: nodeId,
              to_agents: [to],
              timestamp: now,
              updatedAt: now,
              readBy_agents: [nodeId],
              content:
                [
                  "kind: policy_update",
                  `policyVersion: ${version}`,
                  `policyChecksum: ${checksum}`,
                  "",
                  "Apply this Delegation Directory policy to your IDENTITY.md and ACK with ansible_ack_delegation_policy.",
                ].join("\n"),
            };
            messages.set(message.id, message);
            notified.push(to);
          }
        }

        return toolResult({
          success: true,
          delegationPolicyVersion: version,
          delegationPolicyChecksum: checksum,
          delegationPolicyUpdatedAt: m.get("delegationPolicyUpdatedAt"),
          delegationPolicyUpdatedBy: m.get("delegationPolicyUpdatedBy"),
          notifiedAgents: notified,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_ack_delegation_policy ===
  api.registerTool({
    name: "ansible_ack_delegation_policy",
    label: "Ansible Ack Delegation Policy",
    description:
      "Record this agent's acknowledgement of the current (or provided) delegation policy version/checksum.",
    parameters: {
      type: "object",
      properties: {
        version: {
          type: "string",
          description: "Acknowledged policy version. Defaults to current shared version.",
        },
        checksum: {
          type: "string",
          description: "Acknowledged policy checksum. Defaults to current shared checksum.",
        },
      },
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });

      try {
        requireAuth(nodeId);
        const m = getCoordinationMap(doc);
        if (!m) return toolResult({ error: "Coordination map not initialized" });

        const version = params.version
          ? validateString(params.version, 120, "version")
          : (m.get("delegationPolicyVersion") as string | undefined);
        const checksum = params.checksum
          ? validateString(params.checksum, 200, "checksum")
          : (m.get("delegationPolicyChecksum") as string | undefined);

        if (!version || !checksum) {
          return toolResult({ error: "No shared delegation policy is published yet" });
        }

        const now = Date.now();
        m.set(`delegationAck:${nodeId}:version`, version);
        m.set(`delegationAck:${nodeId}:checksum`, checksum);
        m.set(`delegationAck:${nodeId}:at`, now);

        return toolResult({
          success: true,
          agentId: nodeId,
          version,
          checksum,
          ackAt: now,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_delegate_task ===
  api.registerTool({
    name: "ansible_delegate_task",
    label: "Ansible Delegate",
    description:
      "Delegate a task to another hemisphere (body) of Jane. Use when you want another instance to handle work, especially for long-running tasks or tasks requiring specific capabilities.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Brief title for the task",
        },
        description: {
          type: "string",
          description: "Detailed description of what needs to be done",
        },
        context: {
          type: "string",
          description: "Relevant context from the current conversation to help the other hemisphere understand the task",
        },
        assignedTo: {
          type: "string",
          description: "Specific node to assign to (e.g., 'vps-jane'). If omitted, any capable node can claim it.",
        },
        requires: {
          type: "array",
          items: { type: "string" },
          description: "Required capabilities: 'always-on', 'local-files', 'gpu'",
        },
        intent: {
          type: "string",
          description: "Semantic type for this task (e.g., 'skill-setup', 'delegation', 'maintenance')",
        },
        skillRequired: {
          type: "string",
          description: "If set, only nodes that have advertised this skill will auto-dispatch this task.",
        },
        metadata: {
          type: "object",
          description: "Optional structured metadata (e.g., CoreMetadata fields like conversation_id, corr, kind).",
        },
      },
      required: ["title", "description"],
    },
    async execute(_id, params) {
      api.logger?.info(`Ansible: delegating task`);
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        api.logger?.warn("Ansible: delegation failed - not initialized");
        return toolResult({ error: "Ansible not initialized" });
      }

      try {
        requireAuth(nodeId);
        const title = validateString(params.title, VALIDATION_LIMITS.maxTitleLength, "title");
        const description = validateString(params.description, VALIDATION_LIMITS.maxDescriptionLength, "description");
        const context = params.context ? validateString(params.context, VALIDATION_LIMITS.maxContextLength, "context") : undefined;

        const requires = cleanStringArray(params.requires);
        const explicitAssignedTo =
          typeof params.assignedTo === "string" ? validateString(params.assignedTo, 200, "assignedTo") : undefined;
        const resolvedTargets = resolveAssignedTargets(doc, nodeId, explicitAssignedTo, requires);
        if ("error" in resolvedTargets) return toolResult({ error: resolvedTargets.error });
        const assignees = resolvedTargets.assignees;

        const task: Task = {
          id: randomUUID(),
          title,
          description,
          status: "pending",
          createdBy_agent: nodeId,
          createdBy_node: nodeId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          updates: [],
          context,
          assignedTo_agent: assignees[0],
          assignedTo_agents: assignees.length > 1 ? assignees : undefined,
          requires: requires.length > 0 ? requires : undefined,
          intent: params.intent as string | undefined,
          skillRequired: params.skillRequired as string | undefined,
          metadata: params.metadata as Record<string, unknown> | undefined,
        };

        const tasks = doc.getMap("tasks");
        tasks.set(task.id, task);
        requestDispatcherReconcile("local-task-created");

        api.logger?.info(`Ansible: task ${task.id.slice(0, 8)} delegated`);

        return toolResult({
          success: true,
          taskId: task.id,
          assignedTo: task.assignedTo_agent,
          assignedTo_all: task.assignedTo_agents ?? [task.assignedTo_agent],
          message: `Task "${task.title}" created and delegated`,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_send_message ===
  api.registerTool({
    name: "ansible_send_message",
    label: "Ansible Send Message",
    description:
      "Send a message to other hemispheres of Jane. Use for coordination, status updates, or sharing information.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The message content",
        },
        from_agent: {
          type: "string",
          description:
            "Optional sender agent id override for external-agent sends (e.g., codex). Internal sends default to this node id.",
        },
        agent_token: {
          type: "string",
          description:
            "Authentication token for caller agent. When provided, sender identity is resolved from token and from_agent is ignored.",
        },
        to: {
          type: "string",
          description: "Specific agent to send to (single agent id or comma-separated). If omitted, broadcasts to all.",
        },
        metadata: {
          type: "object",
          description: "Optional structured metadata (e.g., CoreMetadata fields like conversation_id, corr, kind).",
        },
      },
      required: ["content"],
    },
    async execute(_id, params) {
      api.logger?.info(`Ansible: sending message`);
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        api.logger?.warn("Ansible: send message failed - not initialized");
        return toolResult({ error: "Ansible not initialized" });
      }

      try {
        requireAuth(nodeId);
        const content = validateString(params.content, VALIDATION_LIMITS.maxMessageLength, "content");
        const authMode = getAuthMode(config);
        const requestedFrom =
          typeof params.from_agent === "string" && params.from_agent.trim().length > 0
            ? validateString(params.from_agent, 100, "from_agent").trim()
            : undefined;
        const agentToken =
          typeof params.agent_token === "string" && params.agent_token.trim().length > 0
            ? params.agent_token.trim()
            : undefined;

        const toAgents: string[] = params.to
          ? (Array.isArray(params.to) ? params.to : [params.to as string])
          : [];

        // Default sender is this node's id (internal agent identity).
        // Allow override only for registered external agents so operators can
        // route CLI-originated messages as codex/claude without spoofing internals.
        let effectiveFrom = nodeId;
        if (agentToken) {
          const byToken = resolveAgentByToken(doc, agentToken);
          if (!byToken) return toolResult({ error: "Invalid agent_token." });
          effectiveFrom = byToken;
        } else if (authMode === "token-required") {
          return toolResult({ error: "agent_token is required for this operation." });
        }
        if (requestedFrom && requestedFrom !== nodeId) {
          if (agentToken) {
            return toolResult({
              error: "Do not pass from_agent when agent_token is provided. Sender is derived from token.",
            });
          }
          const agents = doc.getMap("agents");
          const rec = agents.get(requestedFrom) as Record<string, unknown> | undefined;
          if (!rec) {
            return toolResult({
              error: `from_agent '${requestedFrom}' is not registered. Register first with ansible_register_agent.`,
            });
          }
          if (rec.type !== "external") {
            return toolResult({
              error: `from_agent '${requestedFrom}' must be a registered external agent when overriding sender identity.`,
            });
          }
          effectiveFrom = requestedFrom;
        }

        const now = Date.now();
        const message: Message = {
          id: randomUUID(),
          from_agent: effectiveFrom,
          from_node: nodeId,
          to_agents: toAgents.length > 0 ? toAgents : undefined,
          content,
          timestamp: now,
          updatedAt: now,
          readBy_agents: [effectiveFrom],
          metadata: params.metadata as Record<string, unknown> | undefined,
        };

        const messages = doc.getMap("messages");
        messages.set(message.id, message);
        requestDispatcherReconcile("local-message-created");

        return toolResult({
          success: true,
          messageId: message.id,
          message: toAgents.length > 0
            ? `Message sent to ${toAgents.join(", ")}`
            : "Message broadcast to all hemispheres",
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_advertise_skills ===
  api.registerTool({
    name: "ansible_advertise_skills",
    label: "Ansible Advertise Skills",
    description:
      "Publish this node's available skills to the mesh so other nodes and the coordinator know what you can handle. Also broadcasts a skill-advertised message so all agents are notified. Call this after instantiating a new skill.",
    parameters: {
      type: "object",
      properties: {
        skills: {
          type: "array",
          items: { type: "string" },
          description: "List of skill names this node now handles (e.g., ['caldav-calendar', 'ansible-executor'])",
        },
      },
      required: ["skills"],
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });

      try {
        requireAuth(nodeId);
        const skills = params.skills as string[];
        if (!Array.isArray(skills) || skills.length === 0) {
          return toolResult({ error: "skills must be a non-empty array of strings" });
        }

        // 1. Update NodeContext with skills
        const contextMap = doc.getMap("context");
        const current = contextMap.get(nodeId) as NodeContext | undefined;
        const updated: NodeContext = {
          currentFocus: current?.currentFocus ?? "",
          activeThreads: current?.activeThreads ?? [],
          recentDecisions: current?.recentDecisions ?? [],
          skills,
        };
        contextMap.set(nodeId, updated);

        // 2. Broadcast skill-advertised message
        const content = `Skill advertisement from ${nodeId}: I now handle the following skills: ${skills.join(", ")}. Route relevant tasks to me.`;
        const messagesMap = doc.getMap("messages");
        const msgId = randomUUID();
        const now = Date.now();
        messagesMap.set(msgId, {
          id: msgId,
          from_agent: nodeId,
          from_node: nodeId,
          content,
          intent: "skill-advertised",
          timestamp: now,
          updatedAt: now,
          readBy_agents: [nodeId],
        } satisfies Message);

        api.logger?.info(`Ansible: skills advertised: [${skills.join(", ")}]`);
        return toolResult({ success: true, skills, broadcastMessageId: msgId });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_create_skill_task ===
  api.registerTool({
    name: "ansible_create_skill_task",
    label: "Ansible Create Skill Task",
    description:
      "Send a skill instantiation request to a target node. The target node will receive the spec, instantiate the skill locally, and broadcast its availability to the mesh.",
    parameters: {
      type: "object",
      properties: {
        skillName: {
          type: "string",
          description: "Name of the skill to instantiate (e.g., 'caldav-calendar')",
        },
        assignedTo: {
          type: "string",
          description: "Node ID of the executor (e.g., 'vps-jane'). Required.",
        },
        spec: {
          type: "string",
          description: "Full specification for the skill: what it does, how it should be set up, any scripts or SKILL.md content to create, configuration needed.",
        },
        title: {
          type: "string",
          description: "Optional human-readable title. Defaults to 'Instantiate skill: {skillName}'",
        },
      },
      required: ["skillName", "assignedTo", "spec"],
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });

      try {
        requireAuth(nodeId);
        const skillName = validateString(params.skillName as string, 100, "skillName");
        const assignedTo = params.assignedTo as string;
        const spec = validateString(params.spec as string, VALIDATION_LIMITS.maxContextLength, "spec");
        const title = (params.title as string | undefined) ?? `Instantiate skill: ${skillName}`;

        const executorInstructions = [
          `You have been assigned a skill instantiation task.`,
          ``,
          `**Skill to instantiate**: ${skillName}`,
          ``,
          `**Your steps**:`,
          `1. Read the spec carefully (in the context field below)`,
          `2. Create the skill locally: write SKILL.md and any required scripts in your workspace/skills/${skillName}/ directory`,
          `3. Test the skill if possible`,
          `4. Call ansible_advertise_skills(["${skillName}"]) to publish your availability to the mesh`,
          `5. Complete this task with ansible_complete_task(taskId, result)`,
          ``,
          `**Spec**:`,
          spec,
        ].join("\n");

        const task: Task = {
          id: randomUUID(),
          title,
          description: `Instantiate skill '${skillName}' on node ${assignedTo} following the provided spec.`,
          status: "pending",
          createdBy_agent: nodeId,
          createdBy_node: nodeId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          updates: [],
          context: executorInstructions,
          assignedTo_agent: assignedTo,
          intent: "skill-setup",
        };

        const tasks = doc.getMap("tasks");
        tasks.set(task.id, task);

        api.logger?.info(`Ansible: skill-setup task ${task.id.slice(0, 8)} created for '${skillName}' on ${assignedTo}`);
        return toolResult({
          success: true,
          taskId: task.id,
          message: `Skill instantiation task for '${skillName}' sent to ${assignedTo}`,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_update_context ===
  api.registerTool({
    name: "ansible_update_context",
    label: "Ansible Update Context",
    description:
      "Update your current context (focus, threads, decisions) so other hemispheres know what you're working on.",
    parameters: {
      type: "object",
      properties: {
        currentFocus: {
          type: "string",
          description: "What you are currently working on",
        },
        addThread: {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
          description: "Add an active thread to track",
        },
        addDecision: {
          type: "object",
          properties: {
            decision: { type: "string" },
            reasoning: { type: "string" },
          },
          description: "Record a decision you made",
        },
      },
    },
    async execute(_id, params) {
      api.logger?.debug("Ansible: updating context");
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        return toolResult({ error: "Ansible not initialized" });
      }

      try {
        requireAuth(nodeId);

        const contextMap = doc.getMap("context");
        const existing = (contextMap.get(nodeId) as Record<string, unknown>) || {
          currentFocus: "",
          activeThreads: [],
          recentDecisions: [],
        };

        const updated = { ...existing };

        if (params.currentFocus) {
          updated.currentFocus = validateString(params.currentFocus, VALIDATION_LIMITS.maxContextLength, "currentFocus");
        }

        if (params.addThread) {
          const raw = params.addThread as { summary: string };
          const thread: Thread = {
            id: randomUUID(),
            summary: validateString(raw.summary, VALIDATION_LIMITS.maxTitleLength, "thread summary"),
            lastActivity: Date.now(),
          };
          updated.activeThreads = [thread, ...((existing.activeThreads as Thread[]) || [])].slice(0, 10);
        }

        if (params.addDecision) {
          const raw = params.addDecision as { decision: string; reasoning: string };
          const decision: Decision = {
            decision: validateString(raw.decision, VALIDATION_LIMITS.maxTitleLength, "decision"),
            reasoning: validateString(raw.reasoning, VALIDATION_LIMITS.maxDescriptionLength, "reasoning"),
            madeAt: Date.now(),
          };
          updated.recentDecisions = [decision, ...((existing.recentDecisions as Decision[]) || [])].slice(0, 10);
        }

        contextMap.set(nodeId, updated);

        return toolResult({
          success: true,
          message: "Context updated",
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_status ===
  api.registerTool({
    name: "ansible_status",
    label: "Ansible Status",
    description:
      "Get the current status of all Jane hemispheres, including who's online, what they're working on, and pending tasks.",
    parameters: {
      type: "object",
      properties: {
        /**
         * Consider a node "stale" if its lastSeen is older than this many seconds.
         * Stale nodes will never be reported as online/busy.
         */
        staleAfterSeconds: {
          type: "number",
          description: "Mark nodes stale if lastSeen is older than this many seconds (default: 300).",
        },
      },
    },
    async execute(_id, params) {
      try {
        api.logger?.debug("Ansible: checking status");
        const state = getAnsibleState();
        const myId = getNodeId();

        if (!state || !myId) {
          api.logger?.warn("Ansible: status failed - not initialized");
          return toolResult({ error: "Ansible not initialized" });
        }

        const now = Date.now();
        const staleAfterSecondsRaw = (params as any)?.staleAfterSeconds;
        const staleAfterSeconds =
          typeof staleAfterSecondsRaw === "number" && Number.isFinite(staleAfterSecondsRaw)
            ? Math.max(30, Math.floor(staleAfterSecondsRaw))
            : 300;
        const staleAfterMs = staleAfterSeconds * 1000;

        const nodes: Array<{
          id: string;
          status: string;
          lastSeen: string;
          currentFocus?: string;
          skills: string[];
          stale?: boolean;
          ageSeconds?: number;
        }> = [];

        if (state.pulse) {
          for (const [id, pulse] of state.pulse.entries()) {
            if (!pulse) continue;
            const context = state.context?.get(id);
            // Pulse entries are Y.Map instances — read fields via .get()
            const p = pulse instanceof Map || (pulse as any).get
              ? { status: (pulse as any).get("status"), lastSeen: (pulse as any).get("lastSeen"), currentTask: (pulse as any).get("currentTask") }
              : pulse as PulseData;

            const lastSeenMs = typeof p.lastSeen === "number" && Number.isFinite(p.lastSeen) ? p.lastSeen : now;
            const ageMs = Math.max(0, now - lastSeenMs);
            const stale = ageMs > staleAfterMs;

            // Never claim "online/busy" if lastSeen is stale.
            const rawStatus = (p.status || "unknown") as string;
            const normalizedStatus =
              stale && (rawStatus === "online" || rawStatus === "busy") ? "offline" : rawStatus;

            nodes.push({
              id,
              status: normalizedStatus,
              lastSeen: new Date(lastSeenMs).toISOString(),
              currentFocus: context?.currentFocus,
              skills: context?.skills ?? [],
              stale: stale ? true : undefined,
              ageSeconds: Math.floor(ageMs / 1000),
            });
          }
        }

        const pendingTasks = (state.tasks ? Array.from(state.tasks.values()) : [])
          .filter((t) => t && t.status === "pending")
          .map((t) => ({
            id: t.id ? t.id.slice(0, 8) : "unknown",
            title: t.title || "Untitled",
            assignedTo: t.assignedTo_agent || "anyone",
            assignedToAll: t.assignedTo_agents || (t.assignedTo_agent ? [t.assignedTo_agent] : []),
          }));

        const unreadCount = (state.messages ? Array.from(state.messages.values()) : [])
          .filter((m) => {
            if (!m) return false;
            if (m.from_agent === myId) return false;
            // Only count messages addressed to me or broadcast (matches ansible_read_messages).
            if (m.to_agents?.length && !m.to_agents.includes(myId)) return false;
            if (!Array.isArray(m.readBy_agents)) return false;
            return !m.readBy_agents.includes(myId);
          }).length;

        return toolResult({
          myId,
          nodes,
          pendingTasks,
          unreadMessages: unreadCount,
          staleAfterSeconds,
        });
      } catch (err: any) {
        api.logger?.error(`Ansible: status tool error: ${err.message}`);
        return toolResult({ error: `Status tool error: ${err.message}` });
      }
    },
    // Backward compatibility for OpenClaw <= 2026.1
    async handler() {
      // @ts-ignore
      return this.execute();
    },
  });

  // === ansible_dump_state ===
  api.registerTool({
    name: "ansible_dump_state",
    label: "Ansible Dump State",
    description:
      "Operator observability: dump full ansible/plugin state for this gateway, including config and all Yjs maps.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        return toolResult({ error: "Ansible not initialized" });
      }

      try {
        requireAuth(nodeId);

        const readMap = (name: string): Array<{ key: string; value: unknown }> => {
          const m = doc.getMap(name);
          const out: Array<{ key: string; value: unknown }> = [];
          for (const [k, v] of m.entries()) {
            out.push({ key: String(k), value: serializeValue(v) });
          }
          out.sort((a, b) => a.key.localeCompare(b.key));
          return out;
        };

        const maps = {
          nodes: readMap("nodes"),
          agents: readMap("agents"),
          pendingInvites: readMap("pendingInvites"),
          tasks: readMap("tasks"),
          messages: readMap("messages"),
          context: readMap("context"),
          pulse: readMap("pulse"),
          coordination: readMap("coordination"),
        };

        const counts = {
          nodes: maps.nodes.length,
          agents: maps.agents.length,
          pendingInvites: maps.pendingInvites.length,
          tasks: maps.tasks.length,
          messages: maps.messages.length,
          context: maps.context.length,
          pulse: maps.pulse.length,
          coordination: maps.coordination.length,
        };

        return toolResult({
          generatedAt: Date.now(),
          myId: nodeId,
          plugin: {
            config: serializeValue(config),
            authMode: getAuthMode(config),
            adminAgentId:
              typeof (config as any)?.adminAgentId === "string" && (config as any).adminAgentId.trim().length > 0
                ? (config as any).adminAgentId.trim()
                : "admin",
          },
          counts,
          maps,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_dump_tasks ===
  api.registerTool({
    name: "ansible_dump_tasks",
    label: "Ansible Dump Tasks",
    description: "Operator observability: dump full raw task records from shared ansible state.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Optional status filter (pending|claimed|in_progress|completed|failed).",
        },
        assignedTo: {
          type: "string",
          description: "Optional assignee filter. Matches assignedTo_agent or assignedTo_agents.",
        },
        limit: {
          type: "number",
          description: "Optional maximum records to return after filtering.",
        },
      },
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        return toolResult({ error: "Ansible not initialized" });
      }

      try {
        requireAuth(nodeId);
        const statusFilter = typeof params.status === "string" && params.status.trim() ? params.status.trim() : undefined;
        const assignedFilter =
          typeof params.assignedTo === "string" && params.assignedTo.trim() ? params.assignedTo.trim() : undefined;
        const limitRaw = typeof params.limit === "number" ? params.limit : undefined;
        const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : undefined;

        const tasks = doc.getMap("tasks");
        const rows: Array<{ key: string; id: string; value: unknown }> = [];
        for (const [key, raw] of tasks.entries()) {
          const task = raw as Task | undefined;
          if (!task) continue;
          if (statusFilter && task.status !== statusFilter) continue;
          if (assignedFilter) {
            const assignees = new Set<string>();
            if (task.assignedTo_agent) assignees.add(task.assignedTo_agent);
            if (Array.isArray(task.assignedTo_agents)) {
              for (const a of task.assignedTo_agents) assignees.add(a);
            }
            if (!assignees.has(assignedFilter)) continue;
          }
          rows.push({
            key: String(key),
            id: typeof task.id === "string" ? task.id : String(key),
            value: serializeValue(task),
          });
        }

        rows.sort((a, b) => {
          const ta = Number((a.value as any)?.createdAt || 0);
          const tb = Number((b.value as any)?.createdAt || 0);
          if (ta !== tb) return tb - ta;
          return a.key.localeCompare(b.key);
        });

        const items = limit ? rows.slice(0, limit) : rows;
        return toolResult({
          generatedAt: Date.now(),
          myId: nodeId,
          total: rows.length,
          returned: items.length,
          items,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_dump_messages ===
  api.registerTool({
    name: "ansible_dump_messages",
    label: "Ansible Dump Messages",
    description: "Operator observability: dump full raw message records from shared ansible state.",
    parameters: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Optional sender filter (from_agent).",
        },
        to: {
          type: "string",
          description: "Optional recipient filter (must appear in to_agents).",
        },
        conversation_id: {
          type: "string",
          description: "Optional conversation filter (metadata.conversation_id).",
        },
        limit: {
          type: "number",
          description: "Optional maximum records to return after filtering.",
        },
      },
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        return toolResult({ error: "Ansible not initialized" });
      }

      try {
        requireAuth(nodeId);
        const fromFilter = typeof params.from === "string" && params.from.trim() ? params.from.trim() : undefined;
        const toFilter = typeof params.to === "string" && params.to.trim() ? params.to.trim() : undefined;
        const convoFilter =
          typeof params.conversation_id === "string" && params.conversation_id.trim()
            ? params.conversation_id.trim()
            : undefined;
        const limitRaw = typeof params.limit === "number" ? params.limit : undefined;
        const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : undefined;

        const messages = doc.getMap("messages");
        const rows: Array<{ key: string; id: string; value: unknown }> = [];
        for (const [key, raw] of messages.entries()) {
          const msg = raw as Message | undefined;
          if (!msg) continue;
          if (fromFilter && msg.from_agent !== fromFilter) continue;
          if (toFilter) {
            const to = Array.isArray(msg.to_agents) ? msg.to_agents : [];
            if (!to.includes(toFilter)) continue;
          }
          if (convoFilter) {
            const cid = msg.metadata?.conversation_id;
            if (cid !== convoFilter) continue;
          }

          rows.push({
            key: String(key),
            id: typeof msg.id === "string" ? msg.id : String(key),
            value: serializeValue(msg),
          });
        }

        rows.sort((a, b) => {
          const ta = Number((a.value as any)?.updatedAt || (a.value as any)?.timestamp || 0);
          const tb = Number((b.value as any)?.updatedAt || (b.value as any)?.timestamp || 0);
          if (ta !== tb) return tb - ta;
          return a.key.localeCompare(b.key);
        });

        const items = limit ? rows.slice(0, limit) : rows;
        return toolResult({
          generatedAt: Date.now(),
          myId: nodeId,
          total: rows.length,
          returned: items.length,
          items,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_claim_task ===
  api.registerTool({
    name: "ansible_claim_task",
    label: "Ansible Claim Task",
    description: "Claim a pending task to work on it. External agents (claude-code, codex) pass agentId.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task ID to claim",
        },
        agentId: {
          type: "string",
          description: "External agent ID claiming the task (e.g., 'claude-code'). Omit for internal agents.",
        },
        agent_token: {
          type: "string",
          description: "Auth token for caller agent. Preferred over agentId.",
        },
      },
      required: ["taskId"],
    },
    async execute(_id, params) {
      api.logger?.info(`Ansible: claiming task`);
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        return toolResult({ error: "Ansible not initialized" });
      }

      try {
        const resolved = resolveEffectiveAgent(
          doc,
          nodeId,
          params.agentId as string | undefined,
          params.agent_token as string | undefined,
          getAuthMode(config),
        );
        if (resolved.error) return toolResult({ error: resolved.error });
        const effectiveAgent = resolved.effectiveAgent;

        const tasks = doc.getMap("tasks");
        const resolvedKey = resolveTaskKey(tasks as any, params.taskId as string);
        if (typeof resolvedKey !== "string") return toolResult(resolvedKey);
        const task = tasks.get(resolvedKey) as Task | undefined;

        if (!task) {
          return toolResult({ error: "Task not found" });
        }

        if (task.status !== "pending") {
          return toolResult({ error: `Task is already ${task.status}` });
        }

        tasks.set(resolvedKey, {
          ...task,
          status: "claimed",
          claimedBy_agent: effectiveAgent,
          claimedBy_node: nodeId,
          claimedAt: Date.now(),
          updatedAt: Date.now(),
          updates: [
            { at: Date.now(), by_agent: effectiveAgent, status: "claimed", note: "claimed" },
            ...((task.updates as any) || []),
          ].slice(0, 50),
        });

        return toolResult({
          success: true,
          message: `Claimed task: ${task.title}`,
          task: {
            id: task.id,
            title: task.title,
            description: task.description,
            context: task.context,
            intent: task.intent,
          },
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_update_task ===
  api.registerTool({
    name: "ansible_update_task",
    label: "Ansible Update Task",
    description:
      "Update a claimed task's status (in_progress/failed) with an optional note. Optionally notify the task creator.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID to update" },
        status: {
          type: "string",
          description: "New status: in_progress|failed",
        },
        note: {
          type: "string",
          description: "Short progress note (what changed, what's next)",
        },
        notify: {
          type: "boolean",
          description: "If true, send an update message to the task creator. Defaults to false.",
        },
        result: {
          type: "string",
          description: "Optional result text (useful when status=failed).",
        },
        agentId: {
          type: "string",
          description: "External agent ID updating the task (e.g., 'claude-code'). Omit for internal agents.",
        },
        agent_token: {
          type: "string",
          description: "Auth token for caller agent. Preferred over agentId.",
        },
      },
      required: ["taskId", "status"],
    },
    async execute(_id, params) {
      api.logger?.info(`Ansible: updating task`);
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        return toolResult({ error: "Ansible not initialized" });
      }

      try {
        const resolved = resolveEffectiveAgent(
          doc,
          nodeId,
          params.agentId as string | undefined,
          params.agent_token as string | undefined,
          getAuthMode(config),
        );
        if (resolved.error) return toolResult({ error: resolved.error });
        const effectiveAgent = resolved.effectiveAgent;

        const tasks = doc.getMap("tasks");
        const resolvedKey = resolveTaskKey(tasks as any, params.taskId as string);
        if (typeof resolvedKey !== "string") return toolResult(resolvedKey);
        const task = tasks.get(resolvedKey) as Task | undefined;
        if (!task) return toolResult({ error: "Task not found" });
        if (task.claimedBy_agent !== effectiveAgent) {
          return toolResult({ error: "You don't have this task claimed" });
        }

        const status = params.status as string;
        if (status !== "in_progress" && status !== "failed") {
          return toolResult({ error: "status must be in_progress or failed" });
        }

        const note = params.note
          ? validateString(params.note, VALIDATION_LIMITS.maxTitleLength, "note")
          : undefined;

        const result = params.result
          ? validateString(params.result, VALIDATION_LIMITS.maxResultLength, "result")
          : undefined;

        const updated: Task = {
          ...task,
          status: status as any,
          updatedAt: Date.now(),
          result: result ?? task.result,
          updates: [
            { at: Date.now(), by_agent: effectiveAgent, status: status as any, note },
            ...((task.updates as any) || []),
          ].slice(0, 50),
        };

        tasks.set(resolvedKey, updated);

        const notify = params.notify === true;
        const notifyMessageId = notify
          ? notifyTaskOwner(doc, nodeId, updated, { kind: status === "failed" ? "failed" : "update", note, result })
          : null;

        return toolResult({
          success: true,
          message: `Updated task: ${task.title}`,
          notified: notify,
          notifyMessageId,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_complete_task ===
  api.registerTool({
    name: "ansible_complete_task",
    label: "Ansible Complete Task",
    description: "Mark a task as completed with an optional result.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task ID to complete",
        },
        result: {
          type: "string",
          description: "Summary of the result or outcome",
        },
        agentId: {
          type: "string",
          description: "External agent ID completing the task (e.g., 'claude-code'). Omit for internal agents.",
        },
        agent_token: {
          type: "string",
          description: "Auth token for caller agent. Preferred over agentId.",
        },
      },
      required: ["taskId"],
    },
    async execute(_id, params) {
      api.logger?.info(`Ansible: completing task`);
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        return toolResult({ error: "Ansible not initialized" });
      }

      try {
        const resolved = resolveEffectiveAgent(
          doc,
          nodeId,
          params.agentId as string | undefined,
          params.agent_token as string | undefined,
          getAuthMode(config),
        );
        if (resolved.error) return toolResult({ error: resolved.error });
        const effectiveAgent = resolved.effectiveAgent;

        const tasks = doc.getMap("tasks");
        const resolvedKey = resolveTaskKey(tasks as any, params.taskId as string);
        if (typeof resolvedKey !== "string") return toolResult(resolvedKey);
        const task = tasks.get(resolvedKey) as Task | undefined;

        if (!task) {
          return toolResult({ error: "Task not found" });
        }

        if (task.claimedBy_agent !== effectiveAgent) {
          return toolResult({ error: "You don't have this task claimed" });
        }

        const result = params.result ? validateString(params.result, VALIDATION_LIMITS.maxResultLength, "result") : undefined;

        const completed: Task = {
          ...task,
          status: "completed",
          completedAt: Date.now(),
          result,
          updatedAt: Date.now(),
          updates: [
            { at: Date.now(), by_agent: effectiveAgent, status: "completed", note: "completed" },
            ...((task.updates as any) || []),
          ].slice(0, 50),
        };

        tasks.set(resolvedKey, completed);

        // Always notify the asker on completion.
        const notifyMessageId = notifyTaskOwner(doc, nodeId, completed, { kind: "completed", result });

        return toolResult({
          success: true,
          message: `Completed task: ${task.title}`,
          notifyMessageId,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_read_messages ===
  api.registerTool({
    name: "ansible_read_messages",
    label: "Ansible Read Messages",
    description:
      "Read messages from other hemispheres of Jane. Returns message content, sender, and timestamp. By default returns unread messages; use the 'all' flag to include read messages too.",
    parameters: {
      type: "object",
      properties: {
        all: {
          type: "boolean",
          description: "If true, return all messages (not just unread). Defaults to false.",
        },
        from: {
          type: "string",
          description: "Filter messages from a specific node ID.",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return. Defaults to 20.",
        },
      },
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        return toolResult({ error: "Ansible not initialized" });
      }

      try {
        requireAuth(nodeId);

        const messagesMap = doc.getMap("messages");
        const showAll = params.all === true;
        const fromFilter = params.from as string | undefined;
        const limit = (params.limit as number) || 20;

        const results: Array<{
          id: string;
          from: string;
          to?: string[];
          content: string;
          timestamp: string;
          updatedAt?: string;
          unread: boolean;
        }> = [];

        for (const [id, msg] of messagesMap.entries()) {
          const message = msg as Message;

          // Skip messages not addressed to us (unless broadcast)
          if (message.to_agents?.length && !message.to_agents.includes(nodeId)) continue;

          const unread = !message.readBy_agents.includes(nodeId);

          // By default only show unread
          if (!showAll && !unread) continue;

          // Apply from filter
          if (fromFilter && message.from_agent !== fromFilter) continue;

          results.push({
            id,
            from: message.from_agent,
            to: message.to_agents,
            content: message.content,
            timestamp: new Date(message.timestamp).toISOString(),
            updatedAt: Number.isFinite(message.updatedAt)
              ? new Date(message.updatedAt as number).toISOString()
              : undefined,
            unread,
          });
        }

        // Sort newest activity first (fallback to creation timestamp)
        results.sort((a, b) => {
          const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : new Date(a.timestamp).getTime();
          const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : new Date(b.timestamp).getTime();
          return tb - ta;
        });

        return toolResult({
          myId: nodeId,
          messages: results.slice(0, limit),
          total: results.length,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_mark_read ===
  api.registerTool({
    name: "ansible_mark_read",
    label: "Ansible Mark Read",
    description: "Mark messages as read.",
    parameters: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Message IDs to mark as read. If omitted, marks all unread messages as read.",
        },
      },
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        return toolResult({ error: "Ansible not initialized" });
      }

      try {
        requireAuth(nodeId);

        const messages = doc.getMap("messages");
        const messageIds = params.messageIds as string[] | undefined;
        let count = 0;

        for (const [id, msg] of messages.entries()) {
          const message = msg as Message;

          if (messageIds && !messageIds.includes(id)) continue;
          if (message.readBy_agents.includes(nodeId)) continue;
          if (message.to_agents?.length && !message.to_agents.includes(nodeId)) continue;

          messages.set(id, {
            ...message,
            readBy_agents: [...message.readBy_agents, nodeId],
            updatedAt: Date.now(),
          });
          count++;
        }

        return toolResult({
          success: true,
          message: `Marked ${count} message(s) as read`,
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_delete_messages ===
  api.registerTool({
    name: "ansible_delete_messages",
    label: "Ansible Delete Messages (Operator Only)",
    description:
      "DANGEROUS/DESTRUCTIVE. Operator-only emergency cleanup to permanently delete messages from the shared ansible document. Strongly discouraged for agent workflows.",
    parameters: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Exact message IDs to delete.",
        },
        all: {
          type: "boolean",
          description: "Delete all messages. Must be combined with confirm.",
        },
        from: {
          type: "string",
          description: "Delete messages from a specific sender agent ID.",
        },
        conversation_id: {
          type: "string",
          description: "Delete messages matching metadata.conversation_id.",
        },
        before: {
          type: "string",
          description: "Delete messages older than this ISO timestamp (inclusive).",
        },
        limit: {
          type: "number",
          description: "Maximum number of matching messages to delete (safety cap). Default 200.",
        },
        dryRun: {
          type: "boolean",
          description: "If true, returns matches without deleting.",
        },
        reason: {
          type: "string",
          description: "Required operator justification (min 15 chars).",
        },
        from_agent: {
          type: "string",
          description:
            "Required acting agent for admin deletes. Must match configured admin agent id (default: admin).",
        },
        agent_token: {
          type: "string",
          description:
            "Auth token for acting admin agent. Preferred over from_agent.",
        },
        confirm: {
          type: "string",
          description: "Required literal confirmation: DELETE_MESSAGES",
        },
      },
      required: ["reason", "confirm"],
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        return toolResult({ error: "Ansible not initialized" });
      }

      try {
        requireAuth(nodeId);
        requireAdmin(nodeId, doc);
        const adminAgentId =
          typeof (config as any)?.adminAgentId === "string" && (config as any).adminAgentId.trim().length > 0
            ? (config as any).adminAgentId.trim()
            : "admin";
        const authMode = getAuthMode(config);
        const requestedFrom = typeof params.from_agent === "string" ? String(params.from_agent) : undefined;
        const token =
          typeof params.agent_token === "string" && params.agent_token.trim().length > 0
            ? params.agent_token.trim()
            : undefined;
        if (!token) return toolResult({ error: "agent_token is required for invite." });
        const tokenActor = resolveAgentByToken(doc, token);
        if (!tokenActor) return toolResult({ error: "Invalid agent_token." });
        const effectiveFrom = tokenActor;
        if (tokenActor && requestedFrom && requestedFrom.trim() && requestedFrom.trim() !== tokenActor) {
          return toolResult({
            error: "from_agent does not match token identity. Omit from_agent when using agent_token.",
          });
        }
        requireAdminActor(doc, nodeId, adminAgentId, effectiveFrom);

        const confirm = String(params.confirm || "");
        if (confirm !== "DELETE_MESSAGES") {
          return toolResult({
            error: "Refusing delete. Set confirm to exact string: DELETE_MESSAGES",
          });
        }

        const reason = validateString(params.reason, VALIDATION_LIMITS.maxDescriptionLength, "reason");
        if (reason.trim().length < 15) {
          return toolResult({
            error: "reason must be at least 15 characters",
          });
        }

        const all = params.all === true;
        const messageIds = Array.isArray(params.messageIds)
          ? (params.messageIds.map((v) => String(v).trim()).filter(Boolean))
          : [];
        const from = typeof params.from === "string" && params.from.trim() ? params.from.trim() : undefined;
        const conversationId =
          typeof params.conversation_id === "string" && params.conversation_id.trim()
            ? params.conversation_id.trim()
            : undefined;
        const beforeRaw = typeof params.before === "string" ? params.before.trim() : "";
        const beforeMs = beforeRaw ? Date.parse(beforeRaw) : undefined;
        if (beforeRaw && !Number.isFinite(beforeMs)) {
          return toolResult({ error: "before must be a valid ISO timestamp" });
        }
        const dryRun = params.dryRun === true;
        const limit = params.limit === undefined ? 200 : validateNumber(params.limit, "limit");
        if (limit < 1 || limit > 5000) {
          return toolResult({ error: "limit must be between 1 and 5000" });
        }

        const hasFilter = all || messageIds.length > 0 || !!from || !!conversationId || beforeMs !== undefined;
        if (!hasFilter) {
          return toolResult({
            error:
              "Refusing delete without selection. Provide one of: all, messageIds, from, conversation_id, before.",
          });
        }

        const messages = doc.getMap("messages");
        const idSet = new Set(messageIds);
        const matches: string[] = [];

        for (const [id, msg] of messages.entries()) {
          const message = msg as Message;

          let matched = all;
          if (!matched && idSet.size > 0 && idSet.has(id as string)) matched = true;
          if (!matched && from && message.from_agent === from) matched = true;
          if (!matched && conversationId && message.metadata?.conversation_id === conversationId) matched = true;
          if (!matched && beforeMs !== undefined && Number.isFinite(message.timestamp) && message.timestamp <= beforeMs) {
            matched = true;
          }

          if (!matched) continue;
          matches.push(id as string);
          if (matches.length >= limit) break;
        }

        if (!dryRun) {
          for (const id of matches) messages.delete(id);
        }

        api.logger?.warn(
          `Ansible: ${dryRun ? "dry-run " : ""}deleted_messages count=${matches.length} by=${nodeId} reason=${reason}`,
        );

        return toolResult({
          success: true,
          dryRun,
          deleted: dryRun ? 0 : matches.length,
          matched: matches.length,
          truncated: matches.length >= limit,
          messageIds: matches,
          warning:
            "Permanent delete completed. This action is destructive and is intended for operator emergency cleanup only.",
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_register_agent ===
  api.registerTool({
    name: "ansible_register_agent",
    label: "Ansible Register Agent",
    description:
      "Register an agent (internal or external) in the ansible agent registry. External agents (e.g., claude, codex) use this to get an addressable inbox they can poll via the CLI.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Unique agent identifier (e.g., 'claude', 'codex')",
        },
        name: {
          type: "string",
          description: "Optional display name (e.g., 'Claude', 'Codex')",
        },
        type: {
          type: "string",
          enum: ["internal", "external"],
          description: "internal = auto-dispatch via gateway; external = CLI poll only",
        },
        gateway: {
          type: "string",
          description: "Gateway node hosting this agent (only for internal agents; omit for external)",
        },
      },
      required: ["agent_id"],
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });

      try {
        const agentId = validateString(params.agent_id, 100, "agent_id");
        const agentType = (params.type as "internal" | "external") ?? "external";
        const agents = doc.getMap("agents");
        const existing = agents.get(agentId) as Record<string, unknown> | undefined;

        if (existing) {
          return toolResult({
            error:
              `agent_id '${agentId}' already exists (type=${String(existing.type || "unknown")}, ` +
              `gateway=${String(existing.gateway ?? "null")}). ` +
              "Agent handles must be unique; use a different id.",
            existing,
          });
        }

        const newToken = mintAgentToken();
        const tokenHash = hashAgentToken(newToken);
        const record = {
          name: typeof params.name === "string" ? params.name : undefined,
          gateway: agentType === "internal" ? (typeof params.gateway === "string" ? params.gateway : nodeId) : null,
          type: agentType,
          registeredAt: Date.now(),
          registeredBy: nodeId,
          auth: {
            tokenHash,
            issuedAt: Date.now(),
            tokenHint: tokenHintFromHash(tokenHash),
          },
        };

        agents.set(agentId, record);

        return toolResult({
          success: true,
          agent_id: agentId,
          record,
          agent_token: newToken,
          warning: "Store this token securely. It will not be shown again.",
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_issue_agent_token ===
  api.registerTool({
    name: "ansible_issue_agent_token",
    label: "Ansible Issue Agent Token",
    description:
      "Issue (rotate) an auth token for a registered agent. Returns token once; store securely.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Registered agent id to issue token for.",
        },
        from_agent: {
          type: "string",
          description:
            "Acting admin agent for token issue. Must match configured admin agent id (default: admin).",
        },
        agent_token: {
          type: "string",
          description: "Auth token for acting admin agent. Required.",
        },
      },
      required: ["agent_id"],
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });
      try {
        requireAuth(nodeId);
        requireAdmin(nodeId, doc);
        const adminAgentId =
          typeof (config as any)?.adminAgentId === "string" && (config as any).adminAgentId.trim().length > 0
            ? (config as any).adminAgentId.trim()
            : "admin";
        const requestedFrom = typeof params.from_agent === "string" ? String(params.from_agent) : undefined;
        const token =
          typeof params.agent_token === "string" && params.agent_token.trim().length > 0
            ? params.agent_token.trim()
            : undefined;
        const actorResult = resolveAdminActorOrError(doc, nodeId, token, requestedFrom);
        if (actorResult.error) return toolResult({ error: actorResult.error });
        requireAdminActor(doc, nodeId, adminAgentId, actorResult.actor);

        const agentId = validateString(params.agent_id, 100, "agent_id");
        const agents = doc.getMap("agents");
        const rec = agents.get(agentId) as Record<string, unknown> | undefined;
        if (!rec) return toolResult({ error: `Agent '${agentId}' is not registered.` });
        const newToken = mintAgentToken();
        const tokenHash = hashAgentToken(newToken);
        const next = {
          ...rec,
          auth: {
            tokenHash,
            issuedAt: (rec as any)?.auth?.issuedAt ?? Date.now(),
            rotatedAt: Date.now(),
            tokenHint: tokenHintFromHash(tokenHash),
          },
        };
        agents.set(agentId, next);
        return toolResult({
          success: true,
          agent_id: agentId,
          agent_token: newToken,
          warning: "Store this token securely. It will not be shown again.",
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_invite_agent ===
  api.registerTool({
    name: "ansible_invite_agent",
    label: "Ansible Invite Agent",
    description:
      "Admin-only: issue a temporary one-time invite token for a coding agent. Agent must accept invite to receive a permanent token.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Target external agent id (e.g., codex, claude).",
        },
        ttl_minutes: {
          type: "number",
          description: "Invite TTL in minutes (default 15, range 1-1440).",
        },
        from_agent: {
          type: "string",
          description: "Acting admin agent id (must match configured admin agent).",
        },
        agent_token: {
          type: "string",
          description: "Auth token for acting admin agent. Preferred over from_agent.",
        },
      },
      required: ["agent_id"],
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });
      try {
        requireAuth(nodeId);
        requireAdmin(nodeId, doc);
        const adminAgentId =
          typeof (config as any)?.adminAgentId === "string" && (config as any).adminAgentId.trim().length > 0
            ? (config as any).adminAgentId.trim()
            : "admin";
        const requestedFrom = typeof params.from_agent === "string" ? String(params.from_agent) : undefined;
        const token =
          typeof params.agent_token === "string" && params.agent_token.trim().length > 0
            ? params.agent_token.trim()
            : undefined;
        const actorResult = resolveAdminActorOrError(doc, nodeId, token, requestedFrom);
        if (actorResult.error) return toolResult({ error: actorResult.error });
        const effectiveFrom = actorResult.actor;
        requireAdminActor(doc, nodeId, adminAgentId, effectiveFrom);

        const agentId = validateString(params.agent_id, 100, "agent_id");
        const ttlRaw = params.ttl_minutes === undefined ? 15 : validateNumber(params.ttl_minutes, "ttl_minutes");
        const ttlMinutes = Math.floor(ttlRaw);
        if (ttlMinutes < 1 || ttlMinutes > 1440) {
          return toolResult({ error: "ttl_minutes must be between 1 and 1440" });
        }

        const agents = doc.getMap("agents");
        const existing = agents.get(agentId) as Record<string, unknown> | undefined;
        if (existing && existing.type !== "external") {
          return toolResult({
            error: `Agent '${agentId}' exists as type '${String(existing.type)}'. Invite flow is only for external coding agents.`,
          });
        }

        if (!existing) {
          agents.set(agentId, {
            name: undefined,
            gateway: null,
            type: "external",
            registeredAt: Date.now(),
            registeredBy: nodeId,
          });
        }

        const invites = getAgentInvitesMap(doc);
        if (!invites) return toolResult({ error: "Ansible not initialized" });
        pruneExpiredAgentInvites(invites);

        const now = Date.now();
        const expiresAt = now + ttlMinutes * 60_000;
        const inviteToken = mintAgentInviteToken();
        const inviteId = randomUUID();
        invites.set(inviteId, {
          agent_id: agentId,
          tokenHash: hashAgentToken(inviteToken),
          createdAt: now,
          expiresAt,
          createdBy: nodeId,
          createdByAgent: effectiveFrom,
        } satisfies AgentInviteRecord);

        return toolResult({
          success: true,
          invite_id: inviteId,
          agent_id: agentId,
          invite_token: inviteToken,
          expiresAt,
          warning: "Temporary invite token: single-use, expires automatically, and cannot be retrieved again.",
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_accept_agent_invite ===
  api.registerTool({
    name: "ansible_accept_agent_invite",
    label: "Ansible Accept Agent Invite",
    description:
      "Accept a temporary invite token and receive a permanent agent token. Invite is invalidated after first successful use.",
    parameters: {
      type: "object",
      properties: {
        invite_token: {
          type: "string",
          description: "Temporary invite token issued by ansible_invite_agent.",
        },
      },
      required: ["invite_token"],
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });
      try {
        requireAuth(nodeId);
        const inviteToken = validateString(params.invite_token, 200, "invite_token").trim();
        if (!inviteToken) return toolResult({ error: "invite_token is required" });

        const invites = getAgentInvitesMap(doc);
        if (!invites) return toolResult({ error: "Ansible not initialized" });
        pruneExpiredAgentInvites(invites);

        const found = findInviteByToken(invites, inviteToken);
        if (!found) {
          return toolResult({ error: "Invalid, expired, or already-used invite_token." });
        }

        const { id: inviteId, invite } = found;
        const agentId = String(invite.agent_id || "").trim();
        if (!agentId) return toolResult({ error: "Invite record is missing agent_id." });

        const agents = doc.getMap("agents");
        const existing = agents.get(agentId) as Record<string, unknown> | undefined;
        if (existing && existing.type !== "external") {
          return toolResult({
            error: `Agent '${agentId}' exists as type '${String(existing.type)}'. Invite flow only supports external agents.`,
          });
        }

        const now = Date.now();
        const permanentToken = mintAgentToken();
        const tokenHash = hashAgentToken(permanentToken);
        const next = {
          ...(existing || {
            name: undefined,
            gateway: null,
            type: "external",
            registeredAt: now,
            registeredBy: invite.createdBy || nodeId,
          }),
          gateway: null,
          type: "external",
          auth: {
            tokenHash,
            issuedAt: (existing as any)?.auth?.issuedAt ?? now,
            rotatedAt: now,
            tokenHint: tokenHintFromHash(tokenHash),
            acceptedAt: now,
            acceptedByNode: nodeId,
            acceptedByAgent: agentId,
          },
        };
        agents.set(agentId, next);

        invites.set(inviteId, {
          ...invite,
          usedAt: now,
          usedByNode: nodeId,
          usedByAgent: agentId,
        } satisfies AgentInviteRecord);

        // Revoke any other outstanding invites for this agent after successful acceptance.
        for (const [id, raw] of invites.entries()) {
          const cur = raw as AgentInviteRecord | undefined;
          if (!cur || String(id) === inviteId) continue;
          if (cur.agent_id !== agentId) continue;
          if (cur.usedAt || cur.revokedAt) continue;
          invites.set(String(id), {
            ...cur,
            revokedAt: now,
            revokedReason: `superseded-by:${inviteId}`,
          } satisfies AgentInviteRecord);
        }

        return toolResult({
          success: true,
          agent_id: agentId,
          agent_token: permanentToken,
          warning: "Store this permanent token securely. It will not be shown again.",
        });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_list_agent_invites ===
  api.registerTool({
    name: "ansible_list_agent_invites",
    label: "Ansible List Agent Invites",
    description:
      "Admin-only: list temporary coding-agent invite records (active by default) without exposing raw invite tokens.",
    parameters: {
      type: "object",
      properties: {
        includeUsed: {
          type: "boolean",
          description: "Include already-used invites.",
        },
        includeRevoked: {
          type: "boolean",
          description: "Include revoked invites.",
        },
        includeExpired: {
          type: "boolean",
          description: "Include expired invites.",
        },
      },
    },
    async execute(_id, params) {
      const doc = getDoc();
      const nodeId = getNodeId();
      if (!doc || !nodeId) return toolResult({ error: "Ansible not initialized" });
      try {
        requireAuth(nodeId);
        requireAdmin(nodeId, doc);
        const invites = getAgentInvitesMap(doc);
        if (!invites) return toolResult({ invites: [], total: 0 });

        const includeUsed = params.includeUsed === true;
        const includeRevoked = params.includeRevoked === true;
        const includeExpired = params.includeExpired === true;
        const now = Date.now();

        const out: Array<Record<string, unknown>> = [];
        for (const [id, raw] of invites.entries()) {
          const invite = raw as AgentInviteRecord | undefined;
          if (!invite) continue;
          const expired = typeof invite.expiresAt === "number" ? invite.expiresAt < now : false;
          const used = !!invite.usedAt;
          const revoked = !!invite.revokedAt;

          if (!includeUsed && used) continue;
          if (!includeRevoked && revoked) continue;
          if (!includeExpired && expired) continue;

          out.push({
            id: String(id),
            agent_id: invite.agent_id,
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
            createdBy: invite.createdBy,
            createdByAgent: invite.createdByAgent,
            usedAt: invite.usedAt,
            usedByNode: invite.usedByNode,
            usedByAgent: invite.usedByAgent,
            revokedAt: invite.revokedAt,
            revokedReason: invite.revokedReason,
            status: used ? "used" : revoked ? "revoked" : expired ? "expired" : "active",
          });
        }

        out.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
        return toolResult({ invites: out, total: out.length });
      } catch (err: any) {
        return toolResult({ error: err.message });
      }
    },
  });

  // === ansible_list_agents ===
  api.registerTool({
    name: "ansible_list_agents",
    label: "Ansible List Agents",
    description: "List all registered agents in the ansible network (internal and external).",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const doc = getDoc();
      if (!doc) return toolResult({ error: "Ansible not initialized" });

      const agents = doc.getMap("agents");
      const result: Array<Record<string, unknown>> = [];

      for (const [id, record] of agents.entries()) {
        const r = record as Record<string, unknown>;
        const auth = (r.auth as Record<string, unknown> | undefined) || undefined;
        const safeAuth = auth
          ? {
              issuedAt: auth.issuedAt,
              rotatedAt: auth.rotatedAt,
              tokenHint:
                typeof auth.tokenHint === "string" && auth.tokenHint.length > 0
                  ? auth.tokenHint
                  : typeof auth.tokenHash === "string"
                  ? tokenHintFromHash(auth.tokenHash)
                  : undefined,
              acceptedAt: auth.acceptedAt,
              acceptedByNode: auth.acceptedByNode,
              acceptedByAgent: auth.acceptedByAgent,
            }
          : undefined;
        result.push({ ...r, id, auth: safeAuth });
      }

      return toolResult({ agents: result, total: result.length });
    },
  });
}
