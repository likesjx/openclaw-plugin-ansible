/**
 * Ansible Hooks
 *
 * Integrates with OpenClaw's hook system to inject shared context
 * into agent prompts via the before_agent_start hook.
 */

import type { OpenClawPluginApi } from "./types.js";
import type { AnsibleConfig, NodeContext, Task, Message, TailscaleId } from "./schema.js";
import { CONTEXT_LIMITS } from "./schema.js";
import { getAnsibleState, getNodeId } from "./service.js";

export function registerAnsibleHooks(
  api: OpenClawPluginApi,
  config: AnsibleConfig
) {
  if (config.injectContext === false) {
    api.logger?.info("Ansible: context injection disabled (injectContext=false)");
    return;
  }

  api.on("before_agent_start", async (ctx?: any) => {
    // Resolve agent ID — try all known field names across gateway versions,
    // then fall back to parsing the session key (format: "agent:<agentId>:<session>")
    const agentId: string | undefined = (() => {
      if (ctx === undefined || ctx === null) return undefined;
      const direct = ctx?.agentId ?? ctx?.AgentId ?? ctx?.agent?.id ?? ctx?.agentName ?? ctx?.name;
      if (direct) return String(direct);
      const sk = ctx?.SessionKey ?? ctx?.sessionKey ?? ctx?.session_key;
      if (typeof sk === "string") {
        const m = sk.match(/^agent:([^:]+)/);
        if (m?.[1]) return m[1];
      }
      return undefined;
    })();

    // Filter by injectContextAgents — but only when we can actually identify the agent.
    // If ctx is unavailable (agentId unresolvable), inject for all rather than block:
    // the list is best-effort filtering, not a security gate.
    if (agentId && Array.isArray(config.injectContextAgents) && config.injectContextAgents.length > 0) {
      if (!config.injectContextAgents.includes(agentId)) {
        api.logger?.debug?.(
          `Ansible: skipping context injection for agentId=${agentId}`,
        );
        return {};
      }
    }

    const state = getAnsibleState();
    const myId = getNodeId();

    if (!state || !myId) {
      api.logger?.debug("Ansible: skipping context injection (not initialized)");
      return {};
    }

    const effectiveAgentId = agentId || myId;
    const prependContext = buildContextInjection(state, myId, effectiveAgentId, config);

    if (!prependContext) {
      api.logger?.debug("Ansible: no shared context to inject");
      return {};
    }

    api.logger?.info("Ansible: injecting shared context into agent prompt");
    return { prependContext };
  });
}

function buildContextInjection(
  state: ReturnType<typeof getAnsibleState>,
  nodeId: TailscaleId,
  agentId: string,
  config: AnsibleConfig
): string | null {
  if (!state) return null;

  const sections: string[] = [];
  const now = Date.now();
  const maxAgeMs = CONTEXT_LIMITS.maxAgeHours * 60 * 60 * 1000;

  // === What Jane is Working On ===
  const focusLines: string[] = [];
  const myContext = state.context.get(agentId) || state.context.get(nodeId);
  if (myContext?.currentFocus || myContext?.skills?.length) {
    const parts: string[] = [];
    if (myContext.currentFocus) parts.push(myContext.currentFocus);
    if (myContext.skills?.length) parts.push(`[skills: ${myContext.skills.join(", ")}]`);
    focusLines.push(`- **${agentId}** (me): ${parts.join(" ")}`);
  }

  for (const [ctxNodeId, ctx] of state.context.entries()) {
    if (ctxNodeId === agentId || ctxNodeId === nodeId) continue;
    const parts: string[] = [];
    if (ctx.currentFocus) parts.push(ctx.currentFocus);
    if (ctx.skills && ctx.skills.length > 0) parts.push(`[skills: ${ctx.skills.join(", ")}]`);
    if (parts.length > 0) focusLines.push(`- **${ctxNodeId}**: ${parts.join(" ")}`);
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
  const myTasks = getMyPendingTasks(state, agentId, config.capabilities || []);
  if (myTasks.length > 0) {
    const taskLines = myTasks
      .slice(0, CONTEXT_LIMITS.pendingTasks)
      .map((t) => `- [${t.id.slice(0, 8)}] ${t.title}`);

    sections.push(`## Pending Tasks for Me\n${taskLines.join("\n")}`);
  }

  // === Unread Messages ===
  const unreadMessages = getUnreadMessages(state, agentId);
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

function getMyPendingTasks(
  state: ReturnType<typeof getAnsibleState>,
  myId: string,
  myCapabilities: string[]
): Task[] {
  if (!state) return [];

  const myContext = state.context?.get(myId);
  const tasks: Task[] = [];

  for (const task of state.tasks.values()) {
    // Include:
    // - pending tasks that match assignment/capabilities
    // - claimed/in_progress tasks that I claimed
    const isMineInFlight =
      (task.status === "claimed" || task.status === "in_progress") &&
      task.claimedBy_agent === myId;
    const isPending = task.status === "pending";
    if (!isMineInFlight && !isPending) continue;

    if (isPending) {
      // Check if explicitly assigned to me
      const assignees = new Set<string>();
      if (task.assignedTo_agent) assignees.add(task.assignedTo_agent);
      if (Array.isArray(task.assignedTo_agents)) {
        for (const a of task.assignedTo_agents) assignees.add(a);
      }
      if (assignees.size > 0 && !assignees.has(myId)) continue;

      // Check capability requirements
      if (task.requires && Array.isArray(task.requires) && task.requires.length) {
        const hasAll = task.requires.every((req) => myCapabilities.includes(req));
        if (!hasAll) continue;
      }

      // Check skill requirements
      if (task.skillRequired) {
        const mySkills = myContext?.skills ?? [];
        if (!mySkills.includes(task.skillRequired)) continue;
      }
    }

    tasks.push(task);
  }

  // Sort by creation time (oldest first)
  return tasks.sort((a, b) => a.createdAt - b.createdAt);
}

function getUnreadMessages(
  state: ReturnType<typeof getAnsibleState>,
  myId: string
): Message[] {
  if (!state) return [];

  const messages: Message[] = [];

  for (const msg of state.messages.values()) {
    // Skip messages I sent
    if (msg.from_agent === myId) continue;

    // Skip messages not for me (if targeted)
    if (msg.to_agents?.length && !msg.to_agents.includes(myId)) continue;

    // Skip messages I've read
    if (Array.isArray(msg.readBy_agents) && msg.readBy_agents.includes(myId)) continue;

    messages.push(msg);
  }

  // Sort by timestamp (newest first)
  return messages.sort((a, b) => b.timestamp - a.timestamp);
}
