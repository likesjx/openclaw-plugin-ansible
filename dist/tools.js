/**
 * Ansible Agent Tools
 *
 * Tools available to the agent for inter-hemisphere coordination.
 */
import { createHash, randomUUID } from "crypto";
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
function toolResult(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        details: data,
    };
}
function validateString(value, maxLength, fieldName) {
    if (typeof value !== "string") {
        throw new Error(`${fieldName} must be a string`);
    }
    if (value.length > maxLength) {
        throw new Error(`${fieldName} exceeds max length of ${maxLength}`);
    }
    return value;
}
function validateNumber(value, fieldName) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${fieldName} must be a finite number`);
    }
    return value;
}
function requireAuth(nodeId) {
    if (!isNodeAuthorized(nodeId)) {
        throw new Error("Node not authorized. Use 'ansible join' first.");
    }
}
function getCoordinationMap(doc) {
    return doc?.getMap("coordination");
}
function readCoordinationState(doc) {
    const m = getCoordinationMap(doc);
    if (!m)
        return null;
    return {
        coordinator: m.get("coordinator"),
        sweepEverySeconds: m.get("sweepEverySeconds"),
        retentionClosedTaskSeconds: m.get("retentionClosedTaskSeconds"),
        retentionPruneEverySeconds: m.get("retentionPruneEverySeconds"),
        retentionLastPruneAt: m.get("retentionLastPruneAt"),
        delegationPolicyVersion: m.get("delegationPolicyVersion"),
        delegationPolicyChecksum: m.get("delegationPolicyChecksum"),
        delegationPolicyUpdatedAt: m.get("delegationPolicyUpdatedAt"),
        delegationPolicyUpdatedBy: m.get("delegationPolicyUpdatedBy"),
        updatedAt: m.get("updatedAt"),
        updatedBy: m.get("updatedBy"),
    };
}
function computeSha256(text) {
    return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
function readDelegationAcks(m) {
    const out = {};
    for (const [k, v] of m.entries()) {
        const key = String(k);
        if (!key.startsWith("delegationAck:"))
            continue;
        const parts = key.split(":");
        if (parts.length < 3)
            continue;
        const agentId = parts[1];
        const field = parts[2];
        out[agentId] = out[agentId] || {};
        if (field === "version")
            out[agentId].version = typeof v === "string" ? v : undefined;
        if (field === "checksum")
            out[agentId].checksum = typeof v === "string" ? v : undefined;
        if (field === "at")
            out[agentId].at = typeof v === "number" ? v : undefined;
    }
    return out;
}
function notifyTaskOwner(doc, fromNodeId, task, payload) {
    if (!doc)
        return null;
    if (!task.createdBy)
        return null;
    const messages = doc.getMap("messages");
    const messageId = randomUUID();
    const lines = [];
    lines.push(`[task:${task.id.slice(0, 8)}] ${task.title}`);
    lines.push(`status: ${task.status}`);
    if (payload.note)
        lines.push(`note: ${payload.note}`);
    const result = payload.result ?? task.result;
    if (result)
        lines.push(`result: ${result}`);
    lines.push(`from: ${fromNodeId}`);
    const message = {
        id: messageId,
        from: fromNodeId,
        to: task.createdBy,
        content: lines.join("\n"),
        timestamp: Date.now(),
        readBy: [fromNodeId],
    };
    messages.set(message.id, message);
    return messageId;
}
function resolveTaskKey(tasks, idOrPrefix) {
    const needle = String(idOrPrefix || "").trim();
    if (!needle)
        return { error: "Task id is required" };
    // Exact match first.
    if (tasks.get(needle) !== undefined)
        return needle;
    // Prefix match (common when users reference 8-char short ids).
    const matches = [];
    for (const k of tasks.keys()) {
        if (k.startsWith(needle))
            matches.push(k);
    }
    // Fallback: match by value.id prefix (handles legacy/odd states where task.id != key).
    if (matches.length === 0 && typeof tasks.entries === "function") {
        for (const [k, v] of tasks.entries()) {
            const id = v && typeof v === "object" && "id" in v ? String(v.id || "") : "";
            if (id && id.startsWith(needle))
                matches.push(k);
        }
    }
    if (matches.length === 0)
        return { error: "Task not found" };
    if (matches.length === 1)
        return matches[0];
    return {
        error: `Ambiguous task id prefix '${needle}'. Matches: ${matches.slice(0, 8).join(", ")}${matches.length > 8 ? ", ..." : ""}`,
    };
}
export function registerAnsibleTools(api, config) {
    // === ansible_find_task ===
    api.registerTool({
        name: "ansible_find_task",
        label: "Ansible Find Task",
        description: "Find tasks by id prefix or title substring. Returns both the Yjs map key and the task.id (they should match).",
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
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const tasks = doc.getMap("tasks");
                const idPrefix = params.idPrefix ? String(params.idPrefix).trim() : "";
                const titleContains = params.titleContains ? String(params.titleContains).trim().toLowerCase() : "";
                const status = params.status ? String(params.status).trim() : "";
                const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.min(50, params.limit)) : 10;
                const out = [];
                for (const [k, v] of tasks.entries()) {
                    const t = v;
                    if (!t)
                        continue;
                    if (status && t.status !== status)
                        continue;
                    if (idPrefix && !(String(k).startsWith(idPrefix) || String(t.id || "").startsWith(idPrefix)))
                        continue;
                    if (titleContains && !String(t.title || "").toLowerCase().includes(titleContains))
                        continue;
                    out.push({
                        key: k,
                        id: t.id,
                        title: t.title,
                        status: t.status,
                        assignedTo: t.assignedTo,
                        createdBy: t.createdBy,
                        claimedBy: t.claimedBy,
                        updatedAt: t.updatedAt,
                    });
                }
                out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                return toolResult({ matches: out.slice(0, limit), total: out.length });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_lock_sweep_status ===
    api.registerTool({
        name: "ansible_lock_sweep_status",
        label: "Ansible Lock Sweep Status",
        description: "Get the per-gateway session lock sweeper status (last run + totals). Helps diagnose stuck 'session file locked' issues.",
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
        description: "Get current coordinator configuration (coordinator node id, sweep cadence) and your saved preference (if any).",
        parameters: {
            type: "object",
            properties: {},
        },
        async execute() {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const state = readCoordinationState(doc) || {};
                const m = getCoordinationMap(doc);
                const pref = m?.get(`pref:${nodeId}`) || null;
                return toolResult({
                    myId: nodeId,
                    ...state,
                    myPreference: pref,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_set_coordination_preference ===
    api.registerTool({
        name: "ansible_set_coordination_preference",
        label: "Ansible Set Coordination Preference",
        description: "Record your preferred coordinator and/or sweep cadence. The coordinator may use these preferences when configuring cron and routing.",
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
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const desiredCoordinator = params.desiredCoordinator
                    ? validateString(params.desiredCoordinator, 200, "desiredCoordinator")
                    : undefined;
                const desiredSweepEverySeconds = params.desiredSweepEverySeconds !== undefined
                    ? validateNumber(params.desiredSweepEverySeconds, "desiredSweepEverySeconds")
                    : undefined;
                if (!desiredCoordinator && desiredSweepEverySeconds === undefined) {
                    return toolResult({ error: "Provide desiredCoordinator and/or desiredSweepEverySeconds" });
                }
                const m = getCoordinationMap(doc);
                if (!m)
                    return toolResult({ error: "Ansible not initialized" });
                const pref = {
                    desiredCoordinator,
                    desiredSweepEverySeconds,
                    updatedAt: Date.now(),
                };
                m.set(`pref:${nodeId}`, pref);
                return toolResult({ success: true, myId: nodeId, preference: pref });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_set_coordination ===
    api.registerTool({
        name: "ansible_set_coordination",
        label: "Ansible Set Coordination",
        description: "Set the coordinator node id and sweep cadence. Use for initial setup or last-resort coordinator failover.",
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
                    description: "Required when changing an existing coordinator to a different node (failover).",
                },
            },
            required: ["coordinator", "sweepEverySeconds"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const coordinator = validateString(params.coordinator, 200, "coordinator");
                const sweepEverySeconds = validateNumber(params.sweepEverySeconds, "sweepEverySeconds");
                if (sweepEverySeconds < 10 || sweepEverySeconds > 3600) {
                    return toolResult({ error: "sweepEverySeconds must be between 10 and 3600" });
                }
                const m = getCoordinationMap(doc);
                if (!m)
                    return toolResult({ error: "Ansible not initialized" });
                const existing = m.get("coordinator");
                if (existing && existing !== coordinator) {
                    if (params.confirmLastResort !== true) {
                        return toolResult({
                            error: "Changing coordinator requires confirmLastResort=true (to avoid accidental role moves).",
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
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_set_retention ===
    api.registerTool({
        name: "ansible_set_retention",
        label: "Ansible Set Retention",
        description: "Configure coordinator roll-off policy: run daily (or configurable) and prune closed tasks older than a TTL. Takes effect on the coordinator backbone node.",
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
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const m = getCoordinationMap(doc);
                if (!m)
                    return toolResult({ error: "Coordination map not initialized" });
                const days = params.closedTaskRetentionDays === undefined
                    ? 7
                    : validateNumber(params.closedTaskRetentionDays, "closedTaskRetentionDays");
                const hours = params.pruneEveryHours === undefined ? 24 : validateNumber(params.pruneEveryHours, "pruneEveryHours");
                if (days < 1 || days > 90)
                    return toolResult({ error: "closedTaskRetentionDays must be between 1 and 90" });
                if (hours < 1 || hours > 168)
                    return toolResult({ error: "pruneEveryHours must be between 1 and 168" });
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
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_get_delegation_policy ===
    api.registerTool({
        name: "ansible_get_delegation_policy",
        label: "Ansible Get Delegation Policy",
        description: "Read the shared delegation policy (version/checksum/markdown) and ack status by agent.",
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
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const m = getCoordinationMap(doc);
                if (!m)
                    return toolResult({ error: "Coordination map not initialized" });
                const includeAcks = params.includeAcks !== false;
                const out = {
                    delegationPolicyVersion: m.get("delegationPolicyVersion"),
                    delegationPolicyChecksum: m.get("delegationPolicyChecksum"),
                    delegationPolicyMarkdown: m.get("delegationPolicyMarkdown"),
                    delegationPolicyUpdatedAt: m.get("delegationPolicyUpdatedAt"),
                    delegationPolicyUpdatedBy: m.get("delegationPolicyUpdatedBy"),
                };
                if (includeAcks)
                    out.acks = readDelegationAcks(m);
                return toolResult(out);
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_set_delegation_policy ===
    api.registerTool({
        name: "ansible_set_delegation_policy",
        label: "Ansible Set Delegation Policy",
        description: "Coordinator-only: publish delegation policy markdown + version/checksum and optionally send policy update messages to target agents.",
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
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const m = getCoordinationMap(doc);
                if (!m)
                    return toolResult({ error: "Coordination map not initialized" });
                const coordinator = m.get("coordinator");
                if (!coordinator)
                    return toolResult({ error: "Coordinator not configured. Set with ansible_set_coordination first." });
                if (coordinator !== nodeId)
                    return toolResult({ error: `Only coordinator (${coordinator}) can publish delegation policy` });
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
                const notified = [];
                const rawNotify = Array.isArray(params.notifyAgents) ? params.notifyAgents : [];
                const notifyAgents = rawNotify
                    .filter((x) => typeof x === "string" && String(x).trim().length > 0)
                    .map((x) => String(x).trim());
                if (notifyAgents.length > 0) {
                    const messages = doc.getMap("messages");
                    for (const to of notifyAgents) {
                        const message = {
                            id: randomUUID(),
                            from: nodeId,
                            to,
                            timestamp: Date.now(),
                            readBy: [nodeId],
                            content: [
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
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_ack_delegation_policy ===
    api.registerTool({
        name: "ansible_ack_delegation_policy",
        label: "Ansible Ack Delegation Policy",
        description: "Record this agent's acknowledgement of the current (or provided) delegation policy version/checksum.",
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
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const m = getCoordinationMap(doc);
                if (!m)
                    return toolResult({ error: "Coordination map not initialized" });
                const version = params.version
                    ? validateString(params.version, 120, "version")
                    : m.get("delegationPolicyVersion");
                const checksum = params.checksum
                    ? validateString(params.checksum, 200, "checksum")
                    : m.get("delegationPolicyChecksum");
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
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_delegate_task ===
    api.registerTool({
        name: "ansible_delegate_task",
        label: "Ansible Delegate",
        description: "Delegate a task to another hemisphere (body) of Jane. Use when you want another instance to handle work, especially for long-running tasks or tasks requiring specific capabilities.",
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
                const task = {
                    id: randomUUID(),
                    title,
                    description,
                    status: "pending",
                    createdBy: nodeId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    updates: [],
                    context,
                    assignedTo: params.assignedTo,
                    requires: params.requires,
                };
                const tasks = doc.getMap("tasks");
                tasks.set(task.id, task);
                api.logger?.info(`Ansible: task ${task.id.slice(0, 8)} delegated`);
                return toolResult({
                    success: true,
                    taskId: task.id,
                    message: `Task "${task.title}" created and delegated`,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_send_message ===
    api.registerTool({
        name: "ansible_send_message",
        label: "Ansible Send Message",
        description: "Send a message to other hemispheres of Jane. Use for coordination, status updates, or sharing information.",
        parameters: {
            type: "object",
            properties: {
                content: {
                    type: "string",
                    description: "The message content",
                },
                to: {
                    type: "string",
                    description: "Specific node to send to. If omitted, broadcasts to all hemispheres.",
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
                const message = {
                    id: randomUUID(),
                    from: nodeId,
                    to: params.to,
                    content,
                    timestamp: Date.now(),
                    readBy: [nodeId],
                };
                const messages = doc.getMap("messages");
                messages.set(message.id, message);
                return toolResult({
                    success: true,
                    messageId: message.id,
                    message: params.to
                        ? `Message sent to ${params.to}`
                        : "Message broadcast to all hemispheres",
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_update_context ===
    api.registerTool({
        name: "ansible_update_context",
        label: "Ansible Update Context",
        description: "Update your current context (focus, threads, decisions) so other hemispheres know what you're working on.",
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
                const existing = contextMap.get(nodeId) || {
                    currentFocus: "",
                    activeThreads: [],
                    recentDecisions: [],
                };
                const updated = { ...existing };
                if (params.currentFocus) {
                    updated.currentFocus = validateString(params.currentFocus, VALIDATION_LIMITS.maxContextLength, "currentFocus");
                }
                if (params.addThread) {
                    const raw = params.addThread;
                    const thread = {
                        id: randomUUID(),
                        summary: validateString(raw.summary, VALIDATION_LIMITS.maxTitleLength, "thread summary"),
                        lastActivity: Date.now(),
                    };
                    updated.activeThreads = [thread, ...(existing.activeThreads || [])].slice(0, 10);
                }
                if (params.addDecision) {
                    const raw = params.addDecision;
                    const decision = {
                        decision: validateString(raw.decision, VALIDATION_LIMITS.maxTitleLength, "decision"),
                        reasoning: validateString(raw.reasoning, VALIDATION_LIMITS.maxDescriptionLength, "reasoning"),
                        madeAt: Date.now(),
                    };
                    updated.recentDecisions = [decision, ...(existing.recentDecisions || [])].slice(0, 10);
                }
                contextMap.set(nodeId, updated);
                return toolResult({
                    success: true,
                    message: "Context updated",
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_status ===
    api.registerTool({
        name: "ansible_status",
        label: "Ansible Status",
        description: "Get the current status of all Jane hemispheres, including who's online, what they're working on, and pending tasks.",
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
                const staleAfterSecondsRaw = params?.staleAfterSeconds;
                const staleAfterSeconds = typeof staleAfterSecondsRaw === "number" && Number.isFinite(staleAfterSecondsRaw)
                    ? Math.max(30, Math.floor(staleAfterSecondsRaw))
                    : 300;
                const staleAfterMs = staleAfterSeconds * 1000;
                const nodes = [];
                if (state.pulse) {
                    for (const [id, pulse] of state.pulse.entries()) {
                        if (!pulse)
                            continue;
                        const context = state.context?.get(id);
                        // Pulse entries are Y.Map instances — read fields via .get()
                        const p = pulse instanceof Map || pulse.get
                            ? { status: pulse.get("status"), lastSeen: pulse.get("lastSeen"), currentTask: pulse.get("currentTask") }
                            : pulse;
                        const lastSeenMs = typeof p.lastSeen === "number" && Number.isFinite(p.lastSeen) ? p.lastSeen : now;
                        const ageMs = Math.max(0, now - lastSeenMs);
                        const stale = ageMs > staleAfterMs;
                        // Never claim "online/busy" if lastSeen is stale.
                        const rawStatus = (p.status || "unknown");
                        const normalizedStatus = stale && (rawStatus === "online" || rawStatus === "busy") ? "offline" : rawStatus;
                        nodes.push({
                            id,
                            status: normalizedStatus,
                            lastSeen: new Date(lastSeenMs).toISOString(),
                            currentFocus: context?.currentFocus,
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
                    assignedTo: t.assignedTo || "anyone",
                }));
                const unreadCount = (state.messages ? Array.from(state.messages.values()) : [])
                    .filter((m) => {
                    if (!m)
                        return false;
                    if (m.from === myId)
                        return false;
                    // Only count messages addressed to me or broadcast (matches ansible_read_messages).
                    if (m.to && m.to !== myId)
                        return false;
                    if (!Array.isArray(m.readBy))
                        return false;
                    return !m.readBy.includes(myId);
                }).length;
                return toolResult({
                    myId,
                    nodes,
                    pendingTasks,
                    unreadMessages: unreadCount,
                    staleAfterSeconds,
                });
            }
            catch (err) {
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
                const resolvedKey = resolveTaskKey(tasks, params.taskId);
                if (typeof resolvedKey !== "string")
                    return toolResult(resolvedKey);
                const task = tasks.get(resolvedKey);
                if (!task) {
                    return toolResult({ error: "Task not found" });
                }
                if (task.status !== "pending") {
                    return toolResult({ error: `Task is already ${task.status}` });
                }
                tasks.set(resolvedKey, {
                    ...task,
                    status: "claimed",
                    claimedBy: nodeId,
                    claimedAt: Date.now(),
                    updatedAt: Date.now(),
                    updates: [
                        { at: Date.now(), by: nodeId, status: "claimed", note: "claimed" },
                        ...(task.updates || []),
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
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_update_task ===
    api.registerTool({
        name: "ansible_update_task",
        label: "Ansible Update Task",
        description: "Update a claimed task's status (in_progress/failed) with an optional note. Optionally notify the task creator.",
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
                const resolvedKey = resolveTaskKey(tasks, params.taskId);
                if (typeof resolvedKey !== "string")
                    return toolResult(resolvedKey);
                const task = tasks.get(resolvedKey);
                if (!task)
                    return toolResult({ error: "Task not found" });
                if (task.claimedBy !== nodeId) {
                    return toolResult({ error: "You don't have this task claimed" });
                }
                const status = params.status;
                if (status !== "in_progress" && status !== "failed") {
                    return toolResult({ error: "status must be in_progress or failed" });
                }
                const note = params.note
                    ? validateString(params.note, VALIDATION_LIMITS.maxTitleLength, "note")
                    : undefined;
                const result = params.result
                    ? validateString(params.result, VALIDATION_LIMITS.maxResultLength, "result")
                    : undefined;
                const updated = {
                    ...task,
                    status: status,
                    updatedAt: Date.now(),
                    result: result ?? task.result,
                    updates: [
                        { at: Date.now(), by: nodeId, status: status, note },
                        ...(task.updates || []),
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
            }
            catch (err) {
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
                const resolvedKey = resolveTaskKey(tasks, params.taskId);
                if (typeof resolvedKey !== "string")
                    return toolResult(resolvedKey);
                const task = tasks.get(resolvedKey);
                if (!task) {
                    return toolResult({ error: "Task not found" });
                }
                if (task.claimedBy !== nodeId) {
                    return toolResult({ error: "You don't have this task claimed" });
                }
                const result = params.result ? validateString(params.result, VALIDATION_LIMITS.maxResultLength, "result") : undefined;
                const completed = {
                    ...task,
                    status: "completed",
                    completedAt: Date.now(),
                    result,
                    updatedAt: Date.now(),
                    updates: [
                        { at: Date.now(), by: nodeId, status: "completed", note: "completed" },
                        ...(task.updates || []),
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
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_read_messages ===
    api.registerTool({
        name: "ansible_read_messages",
        label: "Ansible Read Messages",
        description: "Read messages from other hemispheres of Jane. Returns message content, sender, and timestamp. By default returns unread messages; use the 'all' flag to include read messages too.",
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
                const fromFilter = params.from;
                const limit = params.limit || 20;
                const results = [];
                for (const [id, msg] of messagesMap.entries()) {
                    const message = msg;
                    // Skip messages not addressed to us (unless broadcast)
                    if (message.to && message.to !== nodeId)
                        continue;
                    const unread = !message.readBy.includes(nodeId);
                    // By default only show unread
                    if (!showAll && !unread)
                        continue;
                    // Apply from filter
                    if (fromFilter && message.from !== fromFilter)
                        continue;
                    results.push({
                        id,
                        from: message.from,
                        to: message.to,
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
            }
            catch (err) {
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
                const messageIds = params.messageIds;
                let count = 0;
                for (const [id, msg] of messages.entries()) {
                    const message = msg;
                    if (messageIds && !messageIds.includes(id))
                        continue;
                    if (message.readBy.includes(nodeId))
                        continue;
                    if (message.to && message.to !== nodeId)
                        continue;
                    messages.set(id, {
                        ...message,
                        readBy: [...message.readBy, nodeId],
                    });
                    count++;
                }
                return toolResult({
                    success: true,
                    message: `Marked ${count} message(s) as read`,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
}
//# sourceMappingURL=tools.js.map