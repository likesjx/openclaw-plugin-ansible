/**
 * Ansible Hooks
 *
 * Integrates with OpenClaw's hook system to inject shared context
 * into agent prompts via the before_agent_start hook.
 */
import { CONTEXT_LIMITS } from "./schema.js";
import { getAnsibleState, getNodeId } from "./service.js";
export function registerAnsibleHooks(api, config) {
    if (config.injectContext === false) {
        api.logger?.info("Ansible: context injection disabled (injectContext=false)");
        return;
    }
    api.on("before_agent_start", async (ctx) => {
        // Resolve agent ID — try all known field names across gateway versions,
        // then fall back to parsing the session key (format: "agent:<agentId>:<session>")
        const agentId = (() => {
            const direct = ctx?.agentId ?? ctx?.AgentId ?? ctx?.agent?.id ?? ctx?.agentName ?? ctx?.name;
            if (direct)
                return String(direct);
            const sk = ctx?.SessionKey ?? ctx?.sessionKey ?? ctx?.session_key;
            if (typeof sk === "string") {
                const m = sk.match(/^agent:([^:]+)/);
                if (m?.[1])
                    return m[1];
            }
            return undefined;
        })();
        // Diagnostic: log ctx shape when agentId can't be resolved so we can fix
        if (!agentId && ctx !== undefined) {
            api.logger?.info(`Ansible: ctx keys=${Object.keys(ctx || {}).join(",") || "(empty)"} vals=${JSON.stringify(ctx).slice(0, 300)}`);
        }
        if (Array.isArray(config.injectContextAgents) && config.injectContextAgents.length > 0) {
            if (!agentId || !config.injectContextAgents.includes(agentId)) {
                api.logger?.debug?.(`Ansible: skipping context injection for agentId=${agentId ?? "unknown"}`);
                return {};
            }
        }
        const state = getAnsibleState();
        const myId = getNodeId();
        if (!state || !myId) {
            api.logger?.debug("Ansible: skipping context injection (not initialized)");
            return {};
        }
        const prependContext = buildContextInjection(state, myId, config);
        if (!prependContext) {
            api.logger?.debug("Ansible: no shared context to inject");
            return {};
        }
        api.logger?.info("Ansible: injecting shared context into agent prompt");
        return { prependContext };
    });
}
function buildContextInjection(state, myId, config) {
    if (!state)
        return null;
    const sections = [];
    const now = Date.now();
    const maxAgeMs = CONTEXT_LIMITS.maxAgeHours * 60 * 60 * 1000;
    // === What Jane is Working On ===
    const focusLines = [];
    const myContext = state.context.get(myId);
    if (myContext?.currentFocus || myContext?.skills?.length) {
        const parts = [];
        if (myContext.currentFocus)
            parts.push(myContext.currentFocus);
        if (myContext.skills?.length)
            parts.push(`[skills: ${myContext.skills.join(", ")}]`);
        focusLines.push(`- **${myId}** (me): ${parts.join(" ")}`);
    }
    for (const [nodeId, ctx] of state.context.entries()) {
        if (nodeId === myId)
            continue;
        const parts = [];
        if (ctx.currentFocus)
            parts.push(ctx.currentFocus);
        if (ctx.skills && ctx.skills.length > 0)
            parts.push(`[skills: ${ctx.skills.join(", ")}]`);
        if (parts.length > 0)
            focusLines.push(`- **${nodeId}**: ${parts.join(" ")}`);
    }
    if (focusLines.length > 0) {
        sections.push(`## What Jane is Working On\n${focusLines.join("\n")}`);
    }
    // === My Active Threads ===
    if (myContext?.activeThreads && Array.isArray(myContext.activeThreads)) {
        const threads = myContext.activeThreads
            .filter((t) => t && now - t.lastActivity < maxAgeMs)
            .slice(0, CONTEXT_LIMITS.activeThreads)
            .map((t) => `- ${t.summary}`);
        if (threads.length > 0) {
            sections.push(`## My Active Threads\n${threads.join("\n")}`);
        }
    }
    // === Recent Decisions ===
    if (myContext?.recentDecisions && Array.isArray(myContext.recentDecisions)) {
        const decisions = myContext.recentDecisions
            .filter((d) => d && now - d.madeAt < maxAgeMs)
            .slice(0, CONTEXT_LIMITS.recentDecisions)
            .map((d) => `- ${d.decision} (${d.reasoning})`);
        if (decisions.length > 0) {
            sections.push(`## Recent Decisions\n${decisions.join("\n")}`);
        }
    }
    // === Pending Tasks for Me ===
    const myTasks = getMyPendingTasks(state, myId, config.capabilities || []);
    if (myTasks.length > 0) {
        const taskLines = myTasks
            .slice(0, CONTEXT_LIMITS.pendingTasks)
            .map((t) => `- [${t.id.slice(0, 8)}] ${t.title}`);
        sections.push(`## Pending Tasks for Me\n${taskLines.join("\n")}`);
    }
    // === Unread Messages ===
    const unreadMessages = getUnreadMessages(state, myId);
    if (unreadMessages.length > 0) {
        const messageLines = unreadMessages
            .filter((m) => now - m.timestamp < maxAgeMs)
            .slice(0, CONTEXT_LIMITS.unreadMessages)
            .map((m) => `- From **${m.from_agent}**: ${m.content}`);
        if (messageLines.length > 0) {
            sections.push(`## Unread Messages\n${messageLines.join("\n")}`);
        }
    }
    if (sections.length === 0) {
        return null;
    }
    return `<ansible-context>\n${sections.join("\n\n")}\n</ansible-context>`;
}
function getMyPendingTasks(state, myId, myCapabilities) {
    if (!state)
        return [];
    const myContext = state.context?.get(myId);
    const tasks = [];
    for (const task of state.tasks.values()) {
        // Include:
        // - pending tasks that match assignment/capabilities
        // - claimed/in_progress tasks that I claimed
        const isMineInFlight = (task.status === "claimed" || task.status === "in_progress") &&
            task.claimedBy_agent === myId;
        const isPending = task.status === "pending";
        if (!isMineInFlight && !isPending)
            continue;
        if (isPending) {
            // Check if explicitly assigned to me
            if (task.assignedTo_agent && task.assignedTo_agent !== myId)
                continue;
            // Check capability requirements
            if (task.requires && Array.isArray(task.requires) && task.requires.length) {
                const hasAll = task.requires.every((req) => myCapabilities.includes(req));
                if (!hasAll)
                    continue;
            }
            // Check skill requirements
            if (task.skillRequired) {
                const mySkills = myContext?.skills ?? [];
                if (!mySkills.includes(task.skillRequired))
                    continue;
            }
        }
        tasks.push(task);
    }
    // Sort by creation time (oldest first)
    return tasks.sort((a, b) => a.createdAt - b.createdAt);
}
function getUnreadMessages(state, myId) {
    if (!state)
        return [];
    const messages = [];
    for (const msg of state.messages.values()) {
        // Skip messages I sent
        if (msg.from_agent === myId)
            continue;
        // Skip messages not for me (if targeted)
        if (msg.to_agents?.length && !msg.to_agents.includes(myId))
            continue;
        // Skip messages I've read
        if (Array.isArray(msg.readBy_agents) && msg.readBy_agents.includes(myId))
            continue;
        messages.push(msg);
    }
    // Sort by timestamp (newest first)
    return messages.sort((a, b) => b.timestamp - a.timestamp);
}
//# sourceMappingURL=hooks.js.map