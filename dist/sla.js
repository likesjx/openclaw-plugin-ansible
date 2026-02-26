import { randomUUID } from "crypto";
import { getDoc, getNodeId } from "./service.js";
const DEFAULT_SLA_SWEEP_EVERY_SECONDS = 300;
const DEFAULT_MAX_MESSAGES_PER_SWEEP = 20;
const CHECK_INTERVAL_MS = 60_000;
function toNum(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function readSweepEverySeconds(coordination, config) {
    const fromCoordination = toNum(coordination.get("slaSweepEverySeconds"));
    const fromConfig = toNum(config.slaSweep?.everySeconds);
    const raw = fromCoordination ?? fromConfig ?? DEFAULT_SLA_SWEEP_EVERY_SECONDS;
    return Math.max(30, Math.floor(raw));
}
function isSweepEnabled(coordination, config) {
    const fromCoordination = coordination.get("slaSweepEnabled");
    if (typeof fromCoordination === "boolean")
        return fromCoordination;
    if (typeof config.slaSweep?.enabled === "boolean")
        return config.slaSweep.enabled;
    return true;
}
function isMeCoordinator(coordination, myId) {
    const coordinator = coordination.get("coordinator");
    return typeof coordinator === "string" && coordinator === myId;
}
function emitSlaBreachMessages(doc, fromNodeId, task, breachType, dueAt, fyiAgents = []) {
    const messages = doc.getMap("messages");
    const targets = new Set();
    if (typeof task.createdBy_agent === "string" && task.createdBy_agent)
        targets.add(task.createdBy_agent);
    if (typeof task.claimedBy_agent === "string" && task.claimedBy_agent)
        targets.add(task.claimedBy_agent);
    if (targets.size === 0) {
        for (const a of fyiAgents) {
            if (typeof a === "string" && a.trim().length > 0)
                targets.add(a.trim());
        }
    }
    if (targets.size === 0)
        return { emitted: 0, targets: [], reason: "no_targets" };
    let emitted = 0;
    const targetList = Array.from(targets);
    for (const target of targetList) {
        const now = Date.now();
        const message = {
            id: randomUUID(),
            from_agent: fromNodeId,
            from_node: fromNodeId,
            intent: "task_sla_breached",
            to_agents: [target],
            content: `[task:${task.id}] SLA breach (${breachType}) due=${new Date(dueAt).toISOString()} status=${task.status}`,
            timestamp: now,
            updatedAt: now,
            readBy_agents: [fromNodeId],
            metadata: {
                kind: "task_sla_breached",
                taskId: task.id,
                breachType,
                dueAt,
                status: task.status,
                corr: task.id,
            },
        };
        messages.set(message.id, message);
        emitted += 1;
    }
    return { emitted, targets: targetList };
}
export function runSlaSweep(doc, nodeId, options = {}) {
    const dryRun = options.dryRun === true;
    const recordOnly = options.recordOnly === true;
    const maxMessages = typeof options.maxMessages === "number" && Number.isFinite(options.maxMessages)
        ? Math.max(0, Math.floor(options.maxMessages))
        : DEFAULT_MAX_MESSAGES_PER_SWEEP;
    const fyiAgents = Array.isArray(options.fyiAgents)
        ? options.fyiAgents.filter((a) => typeof a === "string" && a.trim().length > 0)
        : [];
    const limit = typeof options.limit === "number" && Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : undefined;
    const now = Date.now();
    const tasks = doc.getMap("tasks");
    const breaches = [];
    let scanned = 0;
    let escalationsWritten = 0;
    let remainingMessageBudget = maxMessages;
    for (const [key, raw] of tasks.entries()) {
        if (limit && scanned >= limit)
            break;
        scanned += 1;
        const task = raw;
        if (!task)
            continue;
        const metadata = (task.metadata || {}) || {};
        const ansible = (metadata.ansible || {}) || {};
        const sla = (ansible.sla || {}) || {};
        if (Object.keys(sla).length === 0)
            continue;
        const escalations = (sla.escalations || {}) || {};
        const breachTypes = [];
        const acceptByAt = typeof sla.acceptByAt === "number" ? sla.acceptByAt : undefined;
        const progressByAt = typeof sla.progressByAt === "number" ? sla.progressByAt : undefined;
        const completeByAt = typeof sla.completeByAt === "number" ? sla.completeByAt : undefined;
        if (task.status === "pending" && acceptByAt && now > acceptByAt && typeof escalations.acceptAt !== "number") {
            breachTypes.push({ breachType: "accept", dueAt: acceptByAt });
        }
        if ((task.status === "claimed" || task.status === "in_progress") && progressByAt && now > progressByAt && typeof escalations.progressAt !== "number") {
            breachTypes.push({ breachType: "progress", dueAt: progressByAt });
        }
        if ((task.status === "claimed" || task.status === "in_progress") && completeByAt && now > completeByAt && typeof escalations.completeAt !== "number") {
            breachTypes.push({ breachType: "complete", dueAt: completeByAt });
        }
        if (breachTypes.length === 0)
            continue;
        for (const breach of breachTypes) {
            breaches.push({
                taskId: task.id || String(key),
                title: task.title,
                breachType: breach.breachType,
                dueAt: breach.dueAt,
                status: task.status,
            });
        }
        if (dryRun)
            continue;
        const nextEscalations = { ...escalations };
        for (const breach of breachTypes) {
            let reason = "record_only";
            let notifiedAgents = [];
            if (!recordOnly && remainingMessageBudget > 0) {
                const sent = emitSlaBreachMessages(doc, nodeId, task, breach.breachType, breach.dueAt, fyiAgents);
                if (sent.emitted > 0) {
                    escalationsWritten += sent.emitted;
                    remainingMessageBudget = Math.max(0, remainingMessageBudget - sent.emitted);
                    notifiedAgents = sent.targets;
                    reason = sent.reason || "notified";
                }
                else {
                    reason = sent.reason || "record_only";
                }
            }
            else if (!recordOnly && remainingMessageBudget <= 0) {
                reason = "message_budget_exhausted";
            }
            const outcomes = (sla.escalationOutcomes || {}) || {};
            outcomes[breach.breachType] = {
                at: now,
                reason,
                notifiedAgents,
            };
            sla.escalationOutcomes = outcomes;
            if (breach.breachType === "accept")
                nextEscalations.acceptAt = now;
            if (breach.breachType === "progress")
                nextEscalations.progressAt = now;
            if (breach.breachType === "complete")
                nextEscalations.completeAt = now;
        }
        const updatedTask = {
            ...task,
            updatedAt: now,
            metadata: {
                ...metadata,
                ansible: {
                    ...ansible,
                    sla: {
                        ...sla,
                        escalations: nextEscalations,
                    },
                },
            },
        };
        tasks.set(String(key), updatedTask);
    }
    return {
        success: true,
        dryRun,
        scanned,
        breaches,
        breachCount: breaches.length,
        escalationsWritten,
    };
}
export function createAnsibleSlaSweepService(api, config) {
    let startupTimer = null;
    let interval = null;
    let coordination = null;
    let observer = null;
    return {
        id: "ansible-sla-sweep",
        async start(_ctx) {
            if (config.tier !== "backbone")
                return;
            const doc = getDoc();
            const myId = getNodeId();
            if (!doc || !myId) {
                api.logger?.warn("Ansible SLA sweep: doc or nodeId not available, skipping");
                return;
            }
            coordination = doc.getMap("coordination");
            const runOnceIfDue = (reason) => {
                try {
                    if (!coordination)
                        return;
                    if (!isMeCoordinator(coordination, myId))
                        return;
                    if (!isSweepEnabled(coordination, config))
                        return;
                    const now = Date.now();
                    const everySeconds = readSweepEverySeconds(coordination, config);
                    const last = toNum(coordination.get("slaSweepLastAt"));
                    if (last && now < last + everySeconds * 1000)
                        return;
                    const fromCoordRecordOnly = coordination.get("slaSweepRecordOnly");
                    const fromCoordMax = toNum(coordination.get("slaSweepMaxMessagesPerSweep"));
                    const fromCfgMax = toNum(config.slaSweep?.maxMessagesPerSweep);
                    const maxMessages = Math.max(0, Math.floor(fromCoordMax ?? fromCfgMax ?? DEFAULT_MAX_MESSAGES_PER_SWEEP));
                    const fyiFromCoord = coordination.get("slaSweepFyiAgents");
                    const fyiAgents = Array.isArray(fyiFromCoord)
                        ? fyiFromCoord.filter((a) => typeof a === "string")
                        : Array.isArray(config.slaSweep?.fyiAgents)
                            ? config.slaSweep.fyiAgents.filter((a) => typeof a === "string")
                            : [];
                    const result = runSlaSweep(doc, myId, {
                        dryRun: false,
                        recordOnly: fromCoordRecordOnly === true || config.slaSweep?.recordOnly === true,
                        maxMessages,
                        fyiAgents,
                    });
                    coordination.set("slaSweepLastAt", now);
                    coordination.set("slaSweepLastReason", reason);
                    coordination.set("slaSweepLastBreachCount", result.breachCount);
                    coordination.set("slaSweepLastEscalationsWritten", result.escalationsWritten);
                    if (result.breachCount > 0) {
                        api.logger?.warn(`Ansible SLA sweep: breaches=${result.breachCount} escalationsWritten=${result.escalationsWritten} reason=${reason}`);
                    }
                    else {
                        api.logger?.debug?.(`Ansible SLA sweep: no breaches reason=${reason}`);
                    }
                }
                catch (err) {
                    api.logger?.warn(`Ansible SLA sweep: run failed err=${String(err?.message || err)}`);
                }
            };
            startupTimer = setTimeout(() => runOnceIfDue("startup"), 10_000);
            interval = setInterval(() => runOnceIfDue("interval"), CHECK_INTERVAL_MS);
            observer = () => runOnceIfDue("coordination-change");
            coordination.observe(observer);
            api.logger?.info("Ansible SLA sweep: enabled (coordinator-only)");
        },
        async stop(_ctx) {
            if (startupTimer)
                clearTimeout(startupTimer);
            if (interval)
                clearInterval(interval);
            if (coordination && observer) {
                try {
                    coordination.unobserve(observer);
                }
                catch {
                    // ignore
                }
            }
            startupTimer = null;
            interval = null;
            coordination = null;
            observer = null;
            api.logger?.info("Ansible SLA sweep: stopped");
        },
    };
}
//# sourceMappingURL=sla.js.map