/**
 * Ansible Agent Tools
 *
 * Tools available to the agent for inter-hemisphere coordination.
 */

import { createHash, randomUUID } from "crypto";
import type { OpenClawPluginApi } from "./types.js";
import type { AnsibleConfig, Task, Message, NodeContext, Decision, Thread, PulseData, CoordinationPreference } from "./schema.js";
import { VALIDATION_LIMITS } from "./schema.js";
import { getDoc, getNodeId, getAnsibleState } from "./service.js";
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

  const message: Message = {
    id: messageId,
    from_agent: fromNodeId,
    from_node: fromNodeId,
    to_agents: [task.createdBy_agent],
    content: lines.join("\n"),
    timestamp: Date.now(),
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

        const out: any[] = [];
        for (const [k, v] of (tasks as any).entries()) {
          const t = v as Task;
          if (!t) continue;
          if (status && t.status !== status) continue;
          if (idPrefix && !(String(k).startsWith(idPrefix) || String(t.id || "").startsWith(idPrefix))) continue;
          if (titleContains && !String(t.title || "").toLowerCase().includes(titleContains)) continue;
          out.push({
            key: k,
            id: t.id,
            title: t.title,
            status: t.status,
            assignedTo: t.assignedTo_agent,
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
            const message: Message = {
              id: randomUUID(),
              from_agent: nodeId,
              from_node: nodeId,
              to_agents: [to],
              timestamp: Date.now(),
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
          assignedTo_agent: params.assignedTo as string | undefined,
          requires: params.requires as string[] | undefined,
          intent: params.intent as string | undefined,
          skillRequired: params.skillRequired as string | undefined,
          metadata: params.metadata as Record<string, unknown> | undefined,
        };

        const tasks = doc.getMap("tasks");
        tasks.set(task.id, task);

        api.logger?.info(`Ansible: task ${task.id.slice(0, 8)} delegated`);

        return toolResult({
          success: true,
          taskId: task.id,
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

        const toAgents: string[] = params.to
          ? (Array.isArray(params.to) ? params.to : [params.to as string])
          : [];

        const message: Message = {
          id: randomUUID(),
          from_agent: nodeId,
          from_node: nodeId,
          to_agents: toAgents.length > 0 ? toAgents : undefined,
          content,
          timestamp: Date.now(),
          readBy_agents: [nodeId],
          metadata: params.metadata as Record<string, unknown> | undefined,
        };

        const messages = doc.getMap("messages");
        messages.set(message.id, message);

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
        messagesMap.set(msgId, {
          id: msgId,
          from_agent: nodeId,
          from_node: nodeId,
          content,
          intent: "skill-advertised",
          timestamp: Date.now(),
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

  // === ansible_claim_task ===
  api.registerTool({
    name: "ansible_claim_task",
    label: "Ansible Claim Task",
    description: "Claim a pending task to work on it.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task ID to claim",
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
        requireAuth(nodeId);

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
          claimedBy_agent: nodeId,
          claimedBy_node: nodeId,
          claimedAt: Date.now(),
          updatedAt: Date.now(),
          updates: [
            { at: Date.now(), by_agent: nodeId, status: "claimed", note: "claimed" },
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
        requireAuth(nodeId);

        const tasks = doc.getMap("tasks");
        const resolvedKey = resolveTaskKey(tasks as any, params.taskId as string);
        if (typeof resolvedKey !== "string") return toolResult(resolvedKey);
        const task = tasks.get(resolvedKey) as Task | undefined;
        if (!task) return toolResult({ error: "Task not found" });
        if (task.claimedBy_agent !== nodeId) {
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
            { at: Date.now(), by_agent: nodeId, status: status as any, note },
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
        requireAuth(nodeId);

        const tasks = doc.getMap("tasks");
        const resolvedKey = resolveTaskKey(tasks as any, params.taskId as string);
        if (typeof resolvedKey !== "string") return toolResult(resolvedKey);
        const task = tasks.get(resolvedKey) as Task | undefined;

        if (!task) {
          return toolResult({ error: "Task not found" });
        }

        if (task.claimedBy_agent !== nodeId) {
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
            { at: Date.now(), by_agent: nodeId, status: "completed", note: "completed" },
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
            unread,
          });
        }

        // Sort newest first
        results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

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

        const record = {
          name: typeof params.name === "string" ? params.name : undefined,
          gateway: agentType === "internal" ? (typeof params.gateway === "string" ? params.gateway : nodeId) : null,
          type: agentType,
          registeredAt: Date.now(),
          registeredBy: nodeId,
        };

        agents.set(agentId, record);

        return toolResult({ success: true, agent_id: agentId, record });
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
        result.push({ id, ...r });
      }

      return toolResult({ agents: result, total: result.length });
    },
  });
}
