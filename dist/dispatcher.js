/**
 * Ansible Dispatcher (Messages + Assigned Tasks)
 *
 * Guarantees:
 * - Live dispatch: new inbound messages are injected into the agent loop.
 * - Reconnect reconciliation: when sync completes, scan for backlog and deliver
 *   deterministically (timestamp order) without duplicates.
 * - Retry: failed dispatches are retried with exponential backoff + jitter.
 */
import { randomUUID } from "crypto";
import { getDoc, getNodeId, getAnsibleState, onSync } from "./service.js";
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
const RETRY_JITTER = 0.2;
const MAX_DELIVERY_ATTEMPTS = 15;
let requestReconcileHook = null;
function safeErr(err) {
    if (err instanceof Error)
        return err.stack || err.message;
    return String(err);
}
function calcBackoffMs(attempts) {
    const exp = Math.max(0, attempts - 1);
    const raw = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, exp));
    const jitter = raw * RETRY_JITTER;
    const withJitter = raw + (Math.random() * 2 - 1) * jitter;
    return Math.max(250, Math.floor(withJitter));
}
function getDelivery(item, myId) {
    return item.delivery?.[myId];
}
function getTaskAssignees(task) {
    const out = new Set();
    if (typeof task.assignedTo_agent === "string" && task.assignedTo_agent.trim().length > 0) {
        out.add(task.assignedTo_agent.trim());
    }
    if (Array.isArray(task.assignedTo_agents)) {
        for (const a of task.assignedTo_agents) {
            if (typeof a === "string" && a.trim().length > 0)
                out.add(a.trim());
        }
    }
    return Array.from(out);
}
function getLocalInternalAgents(doc, nodeId) {
    if (!doc)
        return [nodeId];
    const out = new Set([nodeId]);
    const agents = doc.getMap("agents");
    for (const [agentId, raw] of agents.entries()) {
        const record = raw;
        if (!record || record.type !== "internal")
            continue;
        if (record.gateway === nodeId)
            out.add(String(agentId));
    }
    return Array.from(out).sort((a, b) => a.localeCompare(b));
}
function isDeliveredMessage(msg, myId) {
    const d = getDelivery(msg, myId);
    if (d?.state === "delivered")
        return true;
    // Back-compat: older versions used readBy_agents only.
    return Array.isArray(msg.readBy_agents) && msg.readBy_agents.includes(myId);
}
function isDeliveredTask(task, myId) {
    const d = getDelivery(task, myId);
    return d?.state === "delivered";
}
/**
 * Start observing the Yjs state and dispatching inbound work into the agent loop.
 */
export function startMessageDispatcher(api, config) {
    if (config.dispatchIncoming === false) {
        api.logger?.info("Ansible dispatcher: disabled (dispatchIncoming=false)");
        return;
    }
    const doc = getDoc();
    const myId = getNodeId();
    if (!doc || !myId) {
        api.logger?.warn("Ansible dispatcher: doc or nodeId not available, skipping");
        return;
    }
    // Access the runtime API (available on the real OpenClaw plugin API object)
    const runtime = api.runtime;
    if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
        api.logger?.warn("Ansible dispatcher: runtime.channel.reply not available — dispatch disabled");
        return;
    }
    const reply = runtime.channel.reply;
    const session = runtime.channel.session;
    const apiConfig = api.config; // OpenClaw config (not plugin config)
    const messagesMap = doc.getMap("messages");
    const tasksMap = doc.getMap("tasks");
    const inFlight = new Set();
    const scheduled = new Map();
    let reconcileQueued = false;
    const queueReconcile = (reason) => {
        if (reconcileQueued)
            return;
        reconcileQueued = true;
        setTimeout(() => {
            reconcileQueued = false;
            void reconcileNow(reason);
        }, 0);
    };
    requestReconcileHook = queueReconcile;
    const scheduleRetry = (key, attempts, reason) => {
        if (scheduled.has(key))
            return;
        const ms = calcBackoffMs(attempts);
        api.logger?.warn(`Ansible dispatcher: scheduling retry for ${key} in ${ms}ms (${reason})`);
        const t = setTimeout(() => {
            scheduled.delete(key);
            queueReconcile(`retry:${key}`);
        }, ms);
        scheduled.set(key, t);
    };
    const reconcileNow = async (reason) => {
        const doc = getDoc();
        const myId = getNodeId();
        if (!doc || !myId)
            return;
        const localAgents = getLocalInternalAgents(doc, myId);
        const contextMap = getAnsibleState()?.context;
        const msgs = doc.getMap("messages");
        const tasks = doc.getMap("tasks");
        const pendingMessages = [];
        for (const [id, value] of msgs.entries()) {
            const msg = value;
            if (!msg || typeof msg !== "object")
                continue;
            for (const targetAgent of localAgents) {
                if (msg.from_agent === targetAgent)
                    continue;
                if (msg.to_agents?.length && !msg.to_agents.includes(targetAgent))
                    continue;
                if (isDeliveredMessage(msg, targetAgent))
                    continue;
                const key = `msg:${id}:${targetAgent}`;
                const msgAttempts = msg.delivery?.[targetAgent]?.attempts ?? 0;
                if (msgAttempts >= MAX_DELIVERY_ATTEMPTS) {
                    api.logger?.warn(`Ansible dispatcher: message ${id.slice(0, 8)} from ${msg.from_agent} to ${targetAgent} exceeded ${MAX_DELIVERY_ATTEMPTS} delivery attempts — skipping.`);
                    continue;
                }
                if (scheduled.has(key))
                    continue;
                pendingMessages.push({ id: id, targetAgent, msg });
            }
        }
        pendingMessages.sort((a, b) => {
            const ta = a.msg.timestamp || 0;
            const tb = b.msg.timestamp || 0;
            if (ta !== tb)
                return ta - tb;
            return a.id.localeCompare(b.id);
        });
        const pendingTasks = [];
        for (const [id, value] of tasks.entries()) {
            const task = value;
            if (!task || typeof task !== "object")
                continue;
            const assignees = getTaskAssignees(task);
            if (assignees.length === 0)
                continue; // only explicit assignments
            if (task.status !== "pending" && task.status !== "claimed" && task.status !== "in_progress")
                continue;
            for (const targetAgent of assignees) {
                if (!localAgents.includes(targetAgent))
                    continue;
                if (task.createdBy_agent === targetAgent)
                    continue;
                if (task.claimedBy_agent && task.claimedBy_agent !== targetAgent)
                    continue;
                if (isDeliveredTask(task, targetAgent))
                    continue;
                const taskAttempts = task.delivery?.[targetAgent]?.attempts ?? 0;
                if (taskAttempts >= MAX_DELIVERY_ATTEMPTS) {
                    api.logger?.warn(`Ansible dispatcher: task ${id.slice(0, 8)} "${task.title}" for ${targetAgent} exceeded ${MAX_DELIVERY_ATTEMPTS} delivery attempts — skipping.`);
                    continue;
                }
                if (task.skillRequired) {
                    const targetSkills = contextMap?.get(targetAgent)?.skills ?? [];
                    if (!targetSkills.includes(task.skillRequired)) {
                        api.logger?.debug(`Ansible dispatcher: skipping task ${id.slice(0, 8)} for ${targetAgent} — missing skill '${task.skillRequired}'`);
                        continue;
                    }
                }
                const key = `task:${id}:${targetAgent}`;
                if (scheduled.has(key))
                    continue;
                pendingTasks.push({ id: id, targetAgent, task });
            }
        }
        pendingTasks.sort((a, b) => {
            const ta = a.task.createdAt || 0;
            const tb = b.task.createdAt || 0;
            if (ta !== tb)
                return ta - tb;
            return a.id.localeCompare(b.id);
        });
        if (pendingMessages.length || pendingTasks.length) {
            api.logger?.info(`Ansible dispatcher: reconcile (${reason}): ${pendingMessages.length} msg(s), ${pendingTasks.length} task(s)`);
        }
        for (const { id, targetAgent, msg } of pendingMessages) {
            const key = `msg:${id}:${targetAgent}`;
            if (inFlight.has(key))
                continue;
            inFlight.add(key);
            let attempts = 0;
            try {
                attempts = markAttemptedMessage(msgs, id, targetAgent);
                await dispatchAnsibleMessage(api, reply, session, apiConfig, myId, targetAgent, id, msg);
                markDeliveredMessage(msgs, id, targetAgent, attempts);
            }
            catch (err) {
                attempts = markAttemptErrorMessage(msgs, id, targetAgent, safeErr(err));
                scheduleRetry(key, attempts, "dispatch-error");
            }
            finally {
                inFlight.delete(key);
            }
        }
        for (const { id, targetAgent, task } of pendingTasks) {
            const key = `task:${id}:${targetAgent}`;
            if (inFlight.has(key))
                continue;
            inFlight.add(key);
            let attempts = 0;
            try {
                attempts = markAttemptedTask(tasks, id, targetAgent);
                await dispatchAnsibleTask(api, reply, session, apiConfig, myId, targetAgent, id, task);
                markDeliveredTask(tasks, id, targetAgent, attempts);
            }
            catch (err) {
                attempts = markAttemptErrorTask(tasks, id, targetAgent, safeErr(err));
                scheduleRetry(key, attempts, "dispatch-error");
            }
            finally {
                inFlight.delete(key);
            }
        }
    };
    // Observe changes and reconcile (debounced).
    messagesMap.observe(() => queueReconcile("messages-change"));
    tasksMap.observe(() => queueReconcile("tasks-change"));
    onSync((synced, peer) => {
        if (!synced)
            return;
        queueReconcile(`sync:${peer || "peer"}`);
    });
    api.logger?.info("Ansible dispatcher: enabled (live dispatch + reconnect reconciliation)");
    queueReconcile("startup");
}
export function requestDispatcherReconcile(reason = "manual") {
    requestReconcileHook?.(reason);
}
function markAttemptedMessage(messages, messageId, myId, lastError) {
    const current = messages.get(messageId);
    if (!current)
        return 1;
    const prev = current.delivery?.[myId];
    const attempts = (prev?.attempts ?? 0) + 1;
    const now = Date.now();
    const updated = {
        state: "attempted",
        at: now,
        by: myId,
        attempts,
        lastError,
    };
    messages.set(messageId, {
        ...current,
        updatedAt: now,
        delivery: { ...(current.delivery || {}), [myId]: updated },
    });
    return attempts;
}
function markAttemptErrorMessage(messages, messageId, myId, lastError) {
    const current = messages.get(messageId);
    if (!current)
        return 1;
    const prev = current.delivery?.[myId];
    const attempts = prev?.attempts ?? 1;
    const now = Date.now();
    const updated = {
        state: "attempted",
        at: now,
        by: myId,
        attempts,
        lastError,
    };
    messages.set(messageId, {
        ...current,
        updatedAt: now,
        delivery: { ...(current.delivery || {}), [myId]: updated },
    });
    return attempts;
}
function markDeliveredMessage(messages, messageId, myId, attempts) {
    const current = messages.get(messageId);
    if (!current)
        return;
    const now = Date.now();
    const updated = {
        state: "delivered",
        at: now,
        by: myId,
        attempts,
    };
    const readBy_agents = Array.isArray(current.readBy_agents) ? current.readBy_agents : [];
    const nextReadBy_agents = readBy_agents.includes(myId) ? readBy_agents : [...readBy_agents, myId];
    messages.set(messageId, {
        ...current,
        updatedAt: now,
        readBy_agents: nextReadBy_agents,
        delivery: { ...(current.delivery || {}), [myId]: updated },
    });
}
function markAttemptedTask(tasks, taskId, myId, lastError) {
    const current = tasks.get(taskId);
    if (!current)
        return 1;
    const prev = current.delivery?.[myId];
    const attempts = (prev?.attempts ?? 0) + 1;
    const updated = {
        state: "attempted",
        at: Date.now(),
        by: myId,
        attempts,
        lastError,
    };
    tasks.set(taskId, {
        ...current,
        delivery: { ...(current.delivery || {}), [myId]: updated },
    });
    return attempts;
}
function markAttemptErrorTask(tasks, taskId, myId, lastError) {
    const current = tasks.get(taskId);
    if (!current)
        return 1;
    const prev = current.delivery?.[myId];
    const attempts = prev?.attempts ?? 1;
    const updated = {
        state: "attempted",
        at: Date.now(),
        by: myId,
        attempts,
        lastError,
    };
    tasks.set(taskId, {
        ...current,
        delivery: { ...(current.delivery || {}), [myId]: updated },
    });
    return attempts;
}
function markDeliveredTask(tasks, taskId, myId, attempts) {
    const current = tasks.get(taskId);
    if (!current)
        return;
    const updated = {
        state: "delivered",
        at: Date.now(),
        by: myId,
        attempts,
    };
    tasks.set(taskId, {
        ...current,
        delivery: { ...(current.delivery || {}), [myId]: updated },
    });
}
async function dispatchAnsibleMessage(api, reply, session, cfg, myNodeId, targetAgent, messageId, msg) {
    const senderName = msg.from_agent;
    const rawBody = msg.content;
    // 1. Format the agent envelope
    const envelopeOptions = reply.resolveEnvelopeFormatOptions?.(cfg) ?? {};
    const body = reply.formatAgentEnvelope({
        channel: "Ansible",
        from: senderName,
        timestamp: msg.timestamp,
        envelope: envelopeOptions,
        body: rawBody,
    });
    // 2. Build and finalize the message context
    const sessionKey = `agent:${targetAgent}:ansible:msg:${messageId}`;
    const ctx = reply.finalizeInboundContext({
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: `ansible:${msg.from_agent}`,
        To: `ansible:${targetAgent}`,
        SessionKey: sessionKey,
        AgentId: targetAgent,
        Provider: "ansible",
        Surface: "ansible",
        ChatType: "direct",
        SenderName: senderName,
        SenderId: msg.from_agent,
        MessageSid: messageId,
        OriginatingChannel: "ansible",
        OriginatingTo: `ansible:${msg.from_agent}`,
    });
    // 3. Record session metadata (if available)
    if (session?.recordInboundSession) {
        const storePath = session.resolveStorePath?.() ?? undefined;
        await session.recordInboundSession({
            storePath,
            sessionKey,
            ctx,
            onRecordError: (err) => {
                api.logger?.warn(`Ansible dispatcher: session record error: ${safeErr(err)}`);
            },
        });
    }
    // 4. Dispatch into the agent loop
    await reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg,
        dispatcherOptions: {
            deliver: async (payload, info) => {
                // Only deliver the final reply, not intermediate blocks
                if (info.kind !== "final")
                    return;
                if (!payload.text)
                    return;
                const doc = getDoc();
                if (!doc)
                    return;
                const messagesMap = doc.getMap("messages");
                const replyId = randomUUID();
                const now = Date.now();
                messagesMap.set(replyId, {
                    id: replyId,
                    from_agent: targetAgent,
                    from_node: myNodeId,
                    to_agents: [msg.from_agent],
                    content: payload.text,
                    timestamp: now,
                    updatedAt: now,
                    readBy_agents: [targetAgent],
                });
                api.logger?.info(`Ansible dispatcher: reply ${replyId.slice(0, 8)} sent to ${msg.from_agent}`);
            },
            onError: (err, info) => {
                api.logger?.warn(`Ansible dispatcher: ${info.kind} reply error: ${safeErr(err)}`);
            },
        },
    });
    api.logger?.info(`Ansible dispatcher: delivered message ${messageId.slice(0, 8)} from ${msg.from_agent}`);
}
async function dispatchAnsibleTask(api, reply, session, cfg, myNodeId, targetAgent, taskId, task) {
    const senderName = task.createdBy_agent;
    const rawBody = [
        `[Ansible Task] ${task.title}`,
        `taskId: ${taskId}`,
        `status: ${task.status}`,
        `assignedTo: ${task.assignedTo_agent || ""}`,
        "",
        task.description,
        task.context ? `\n\nContext:\n${task.context}` : "",
        "",
        "Instructions:",
        "- Claim with ansible_claim_task (taskId) before doing work.",
        "- Use ansible_update_task for progress; ansible_complete_task when done.",
    ]
        .filter(Boolean)
        .join("\n");
    const envelopeOptions = reply.resolveEnvelopeFormatOptions?.(cfg) ?? {};
    const body = reply.formatAgentEnvelope({
        channel: "Ansible",
        from: senderName,
        timestamp: task.createdAt,
        envelope: envelopeOptions,
        body: rawBody,
    });
    const sessionKey = `agent:${targetAgent}:ansible:task:${taskId}`;
    const ctx = reply.finalizeInboundContext({
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: `ansible:${task.createdBy_agent}`,
        To: `ansible:${targetAgent}`,
        SessionKey: sessionKey,
        AgentId: targetAgent,
        Provider: "ansible",
        Surface: "ansible",
        ChatType: "direct",
        SenderName: senderName,
        SenderId: task.createdBy_agent,
        MessageSid: `task:${taskId}`,
        OriginatingChannel: "ansible",
        OriginatingTo: `ansible:${task.createdBy_agent}`,
    });
    if (session?.recordInboundSession) {
        const storePath = session.resolveStorePath?.() ?? undefined;
        await session.recordInboundSession({
            storePath,
            sessionKey,
            ctx,
            onRecordError: (err) => {
                api.logger?.warn(`Ansible dispatcher: session record error: ${safeErr(err)}`);
            },
        });
    }
    await reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg,
        dispatcherOptions: {
            deliver: async (payload, info) => {
                if (info.kind !== "final")
                    return;
                if (!payload.text)
                    return;
                const doc = getDoc();
                if (!doc)
                    return;
                // Send the final reply back to the task creator as an ansible message.
                const messagesMap = doc.getMap("messages");
                const replyId = randomUUID();
                const now = Date.now();
                messagesMap.set(replyId, {
                    id: replyId,
                    from_agent: targetAgent,
                    from_node: myNodeId,
                    to_agents: [task.createdBy_agent],
                    content: payload.text,
                    timestamp: now,
                    updatedAt: now,
                    readBy_agents: [targetAgent],
                });
                api.logger?.info(`Ansible dispatcher: task reply ${replyId.slice(0, 8)} sent to ${task.createdBy_agent}`);
            },
            onError: (err, info) => {
                api.logger?.warn(`Ansible dispatcher: ${info.kind} reply error: ${safeErr(err)}`);
            },
        },
    });
    api.logger?.info(`Ansible dispatcher: delivered task ${taskId.slice(0, 8)} from ${task.createdBy_agent}`);
}
//# sourceMappingURL=dispatcher.js.map