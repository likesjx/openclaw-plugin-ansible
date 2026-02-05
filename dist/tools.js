/**
 * Ansible Agent Tools
 *
 * Tools available to the agent for inter-hemisphere coordination.
 */
import { randomUUID } from "crypto";
import { VALIDATION_LIMITS } from "./schema.js";
import { getDoc, getNodeId, getAnsibleState } from "./service.js";
import { isNodeAuthorized } from "./auth.js";
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
function requireAuth(nodeId) {
    if (!isNodeAuthorized(nodeId)) {
        throw new Error("Node not authorized. Use 'ansible join' first.");
    }
}
export function registerAnsibleTools(api, config) {
    // === ansible.delegate_task ===
    api.registerTool({
        name: "ansible.delegate_task",
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
    // === ansible.send_message ===
    api.registerTool({
        name: "ansible.send_message",
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
    // === ansible.update_context ===
    api.registerTool({
        name: "ansible.update_context",
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
    // === ansible.status ===
    api.registerTool({
        name: "ansible.status",
        label: "Ansible Status",
        description: "Get the current status of all Jane hemispheres, including who's online, what they're working on, and pending tasks.",
        parameters: {
            type: "object",
            properties: {},
        },
        async execute() {
            try {
                api.logger?.debug("Ansible: checking status");
                const state = getAnsibleState();
                const myId = getNodeId();
                if (!state || !myId) {
                    api.logger?.warn("Ansible: status failed - not initialized");
                    return toolResult({ error: "Ansible not initialized" });
                }
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
                        nodes.push({
                            id,
                            status: p.status || "unknown",
                            lastSeen: new Date(p.lastSeen || Date.now()).toISOString(),
                            currentFocus: context?.currentFocus,
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
                    .filter((m) => m && m.from !== myId && m.readBy && !m.readBy.includes(myId))
                    .length;
                return toolResult({
                    myId,
                    nodes,
                    pendingTasks,
                    unreadMessages: unreadCount,
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
    // === ansible.claim_task ===
    api.registerTool({
        name: "ansible.claim_task",
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
                const task = tasks.get(params.taskId);
                if (!task) {
                    return toolResult({ error: "Task not found" });
                }
                if (task.status !== "pending") {
                    return toolResult({ error: `Task is already ${task.status}` });
                }
                tasks.set(params.taskId, {
                    ...task,
                    status: "claimed",
                    claimedBy: nodeId,
                    claimedAt: Date.now(),
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
    // === ansible.complete_task ===
    api.registerTool({
        name: "ansible.complete_task",
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
                const task = tasks.get(params.taskId);
                if (!task) {
                    return toolResult({ error: "Task not found" });
                }
                if (task.claimedBy !== nodeId) {
                    return toolResult({ error: "You don't have this task claimed" });
                }
                const result = params.result ? validateString(params.result, VALIDATION_LIMITS.maxResultLength, "result") : undefined;
                tasks.set(params.taskId, {
                    ...task,
                    status: "completed",
                    completedAt: Date.now(),
                    result,
                });
                return toolResult({
                    success: true,
                    message: `Completed task: ${task.title}`,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible.read_messages ===
    api.registerTool({
        name: "ansible.read_messages",
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
    // === ansible.mark_read ===
    api.registerTool({
        name: "ansible.mark_read",
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