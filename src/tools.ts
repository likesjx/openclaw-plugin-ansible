/**
 * Ansible Agent Tools
 *
 * Tools available to the agent for inter-hemisphere coordination.
 */

import { randomUUID } from "crypto";
import type { OpenClawPluginApi } from "./types.js";
import type { AnsibleConfig, Task, Message, Decision, Thread } from "./schema.js";
import { getDoc, getNodeId, getAnsibleState } from "./service.js";

export function registerAnsibleTools(
  api: OpenClawPluginApi,
  config: AnsibleConfig
) {
  // === ansible.delegate_task ===
  api.registerTool({
    name: "ansible.delegate_task",
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
      },
      required: ["title", "description"],
    },
    async execute(_id, params) {
      api.logger?.info(`Ansible: delegating task "${params.title}"`);
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        api.logger?.warn("Ansible: delegation failed - not initialized");
        return { error: "Ansible not initialized" };
      }

      const task: Task = {
        id: randomUUID(),
        title: params.title as string,
        description: params.description as string,
        status: "pending",
        createdBy: nodeId,
        createdAt: Date.now(),
        context: params.context as string | undefined,
        assignedTo: params.assignedTo as string | undefined,
        requires: params.requires as string[] | undefined,
      };

      const tasks = doc.getMap("tasks");
      tasks.set(task.id, task);

      api.logger?.info(`Ansible: task ${task.id.slice(0, 8)} delegated to ${params.assignedTo || "anyone"}`);

      return {
        success: true,
        taskId: task.id,
        message: `Task "${task.title}" created and delegated`,
      };
    },
  });

  // === ansible.send_message ===
  api.registerTool({
    name: "ansible.send_message",
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
          description: "Specific node to send to. If omitted, broadcasts to all hemispheres.",
        },
      },
      required: ["content"],
    },
    async execute(_id, params) {
      api.logger?.info(`Ansible: sending message to ${params.to || "all"}`);
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        api.logger?.warn("Ansible: send message failed - not initialized");
        return { error: "Ansible not initialized" };
      }

      const message: Message = {
        id: randomUUID(),
        from: nodeId,
        to: params.to as string | undefined,
        content: params.content as string,
        timestamp: Date.now(),
        readBy: [nodeId], // Sender has implicitly read it
      };

      const messages = doc.getMap("messages");
      messages.set(message.id, message);

      return {
        success: true,
        messageId: message.id,
        message: params.to
          ? `Message sent to ${params.to}`
          : "Message broadcast to all hemispheres",
      };
    },
  });

  // === ansible.update_context ===
  api.registerTool({
    name: "ansible.update_context",
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
        return { error: "Ansible not initialized" };
      }

      const contextMap = doc.getMap("context");
      const existing = (contextMap.get(nodeId) as Record<string, unknown>) || {
        currentFocus: "",
        activeThreads: [],
        recentDecisions: [],
      };

      const updated = { ...existing };

      if (params.currentFocus) {
        api.logger?.info(`Ansible: focus updated to "${params.currentFocus}"`);
        updated.currentFocus = params.currentFocus;
      }

      if (params.addThread) {
        const thread: Thread = {
          id: randomUUID(),
          summary: (params.addThread as { summary: string }).summary,
          lastActivity: Date.now(),
        };
        api.logger?.info(`Ansible: thread added "${thread.summary}"`);
        updated.activeThreads = [thread, ...((existing.activeThreads as Thread[]) || [])].slice(0, 10);
      }

      if (params.addDecision) {
        const decision: Decision = {
          decision: (params.addDecision as { decision: string; reasoning: string }).decision,
          reasoning: (params.addDecision as { decision: string; reasoning: string }).reasoning,
          madeAt: Date.now(),
        };
        api.logger?.info(`Ansible: decision recorded "${decision.decision}"`);
        updated.recentDecisions = [decision, ...((existing.recentDecisions as Decision[]) || [])].slice(0, 10);
      }

      contextMap.set(nodeId, updated);

      return {
        success: true,
        message: "Context updated",
      };
    },
  });

  // === ansible.status ===
  api.registerTool({
    name: "ansible.status",
    label: "Ansible Status",
    description:
      "Get the current status of all Jane hemispheres, including who's online, what they're working on, and pending tasks.",
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
          return { error: "Ansible not initialized" };
        }

        const nodes: Array<{
          id: string;
          status: string;
          lastSeen: string;
          currentFocus?: string;
        }> = [];

        if (state.pulse) {
          for (const [id, pulse] of state.pulse.entries()) {
            if (!pulse) continue;
            const context = state.context?.get(id);
            nodes.push({
              id,
              status: pulse.status || "unknown",
              lastSeen: new Date(pulse.lastSeen || Date.now()).toISOString(),
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

        return {
          myId,
          nodes,
          pendingTasks,
          unreadMessages: unreadCount,
        };
      } catch (err: any) {
        api.logger?.error(`Ansible: status tool error: ${err.message}`);
        return { error: `Status tool error: ${err.message}` };
      }
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
      api.logger?.info(`Ansible: claiming task ${params.taskId}`);
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        return { error: "Ansible not initialized" };
      }

      const tasks = doc.getMap("tasks");
      const task = tasks.get(params.taskId as string) as Task | undefined;

      if (!task) {
        api.logger?.warn(`Ansible: task ${params.taskId} not found`);
        return { error: "Task not found" };
      }

      if (task.status !== "pending") {
        api.logger?.warn(`Ansible: task ${params.taskId} is already ${task.status}`);
        return { error: `Task is already ${task.status}` };
      }

      tasks.set(params.taskId as string, {
        ...task,
        status: "claimed",
        claimedBy: nodeId,
        claimedAt: Date.now(),
      });

      api.logger?.info(`Ansible: task "${task.title}" claimed by ${nodeId}`);

      return {
        success: true,
        message: `Claimed task: ${task.title}`,
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          context: task.context,
        },
      };
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
      api.logger?.info(`Ansible: completing task ${params.taskId}`);
      const doc = getDoc();
      const nodeId = getNodeId();

      if (!doc || !nodeId) {
        return { error: "Ansible not initialized" };
      }

      const tasks = doc.getMap("tasks");
      const task = tasks.get(params.taskId as string) as Task | undefined;

      if (!task) {
        return { error: "Task not found" };
      }

      if (task.claimedBy !== nodeId) {
        api.logger?.warn(`Ansible: complete_task failed - task ${params.taskId} claimed by ${task.claimedBy}, not ${nodeId}`);
        return { error: "You don't have this task claimed" };
      }

      tasks.set(params.taskId as string, {
        ...task,
        status: "completed",
        completedAt: Date.now(),
        result: params.result as string | undefined,
      });

      api.logger?.info(`Ansible: task "${task.title}" completed`);

      return {
        success: true,
        message: `Completed task: ${task.title}`,
      };
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
        return { error: "Ansible not initialized" };
      }

      const messages = doc.getMap("messages");
      const messageIds = params.messageIds as string[] | undefined;
      let count = 0;

      for (const [id, msg] of messages.entries()) {
        const message = msg as Message;

        // Skip if specific IDs provided and this isn't one
        if (messageIds && !messageIds.includes(id)) continue;

        // Skip if already read
        if (message.readBy.includes(nodeId)) continue;

        // Skip if not for me
        if (message.to && message.to !== nodeId) continue;

        messages.set(id, {
          ...message,
          readBy: [...message.readBy, nodeId],
        });
        count++;
      }

      return {
        success: true,
        message: `Marked ${count} message(s) as read`,
      };
    },
  });
}
