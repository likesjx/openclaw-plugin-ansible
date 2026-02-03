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
  api.on("before_agent_start", async () => {
    const state = getAnsibleState();
    const myId = getNodeId();

    if (!state || !myId) {
      return {};
    }

    const prependContext = buildContextInjection(state, myId, config);

    if (!prependContext) {
      return {};
    }

    return { prependContext };
  });
}

function buildContextInjection(
  state: ReturnType<typeof getAnsibleState>,
  myId: TailscaleId,
  config: AnsibleConfig
): string | null {
  if (!state) return null;

  const sections: string[] = [];
  const now = Date.now();
  const maxAgeMs = CONTEXT_LIMITS.maxAgeHours * 60 * 60 * 1000;

  // === What Jane is Working On ===
  const focusLines: string[] = [];
  const myContext = state.context.get(myId);
  if (myContext?.currentFocus) {
    focusLines.push(`- **${myId}** (me): ${myContext.currentFocus}`);
  }

  for (const [nodeId, ctx] of state.context.entries()) {
    if (nodeId === myId) continue;
    if (ctx.currentFocus) {
      focusLines.push(`- **${nodeId}**: ${ctx.currentFocus}`);
    }
  }

  if (focusLines.length > 0) {
    sections.push(`## What Jane is Working On\n${focusLines.join("\n")}`);
  }

  // === My Active Threads ===
  if (myContext?.activeThreads?.length) {
    const threads = myContext.activeThreads
      .filter((t) => now - t.lastActivity < maxAgeMs)
      .slice(0, CONTEXT_LIMITS.activeThreads)
      .map((t) => `- ${t.summary}`);

    if (threads.length > 0) {
      sections.push(`## My Active Threads\n${threads.join("\n")}`);
    }
  }

  // === Recent Decisions ===
  if (myContext?.recentDecisions?.length) {
    const decisions = myContext.recentDecisions
      .filter((d) => now - d.madeAt < maxAgeMs)
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
      .map((m) => `- From **${m.from}**: ${m.content}`);

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
  myId: TailscaleId,
  myCapabilities: string[]
): Task[] {
  if (!state) return [];

  const tasks: Task[] = [];

  for (const task of state.tasks.values()) {
    // Skip non-pending tasks
    if (task.status !== "pending") continue;

    // Check if explicitly assigned to me
    if (task.assignedTo && task.assignedTo !== myId) continue;

    // Check capability requirements
    if (task.requires?.length) {
      const hasAll = task.requires.every((req) => myCapabilities.includes(req));
      if (!hasAll) continue;
    }

    tasks.push(task);
  }

  // Sort by creation time (oldest first)
  return tasks.sort((a, b) => a.createdAt - b.createdAt);
}

function getUnreadMessages(
  state: ReturnType<typeof getAnsibleState>,
  myId: TailscaleId
): Message[] {
  if (!state) return [];

  const messages: Message[] = [];

  for (const msg of state.messages.values()) {
    // Skip messages I sent
    if (msg.from === myId) continue;

    // Skip messages not for me (if targeted)
    if (msg.to && msg.to !== myId) continue;

    // Skip messages I've read
    if (msg.readBy.includes(myId)) continue;

    messages.push(msg);
  }

  // Sort by timestamp (newest first)
  return messages.sort((a, b) => b.timestamp - a.timestamp);
}
