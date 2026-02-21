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
import type { OpenClawPluginApi } from "./types.js";
import type { AnsibleConfig, DeliveryRecord, Message, Task, TailscaleId, AgentId } from "./schema.js";
import { getDoc, getNodeId, getAnsibleState, onSync } from "./service.js";

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
const RETRY_JITTER = 0.2;
const MAX_DELIVERY_ATTEMPTS = 15;
let requestReconcileHook: ((reason: string) => void) | null = null;

function safeErr(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

function calcBackoffMs(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  const raw = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, exp));
  const jitter = raw * RETRY_JITTER;
  const withJitter = raw + (Math.random() * 2 - 1) * jitter;
  return Math.max(250, Math.floor(withJitter));
}

const SUPPRESSED_REPLY_PATTERNS: RegExp[] = [
  /\bHTTP\s*(400|401|403|404|408|409|422|429|500|502|503|504)\b/i,
  /\b(status|code)\s*(400|401|403|404|408|409|422|429|500|502|503|504)\b/i,
  /\b(model|provider|gateway)\b.{0,24}\b(error|failed|failure|unavailable|timeout)\b/i,
  /\brate[_\s-]?limit(ed|ing)?\b/i,
  /\bunauthorized\b|\bforbidden\b|\binvalid api key\b/i,
  /Invalid\s+['"]?input/i,
  /\bcontext length\b|\btoken limit\b/i,
];

function shouldSuppressReplyText(text: string): boolean {
  const normalized = String(text || "").trim();
  if (!normalized) return false;

  // Keep normal conversational/error discussion intact; only suppress
  // replies that look like raw model/runtime transport failures.
  let hits = 0;
  for (const p of SUPPRESSED_REPLY_PATTERNS) {
    if (p.test(normalized)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function getDelivery(item: { delivery?: Record<string, DeliveryRecord> }, myId: string): DeliveryRecord | undefined {
  return item.delivery?.[myId];
}

function getTaskAssignees(task: Task): string[] {
  const out = new Set<string>();
  if (typeof task.assignedTo_agent === "string" && task.assignedTo_agent.trim().length > 0) {
    out.add(task.assignedTo_agent.trim());
  }
  if (Array.isArray(task.assignedTo_agents)) {
    for (const a of task.assignedTo_agents) {
      if (typeof a === "string" && a.trim().length > 0) out.add(a.trim());
    }
  }
  return Array.from(out);
}

function getLocalInternalAgents(doc: ReturnType<typeof getDoc>, nodeId: string): string[] {
  if (!doc) return [nodeId];
  const out = new Set<string>([nodeId]);
  const agents = doc.getMap("agents");
  for (const [agentId, raw] of agents.entries()) {
    const record = raw as { type?: string; gateway?: string | null } | undefined;
    if (!record || record.type !== "internal") continue;
    if (record.gateway === nodeId) out.add(String(agentId));
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function isDeliveredMessage(msg: Message, myId: string): boolean {
  const d = getDelivery(msg, myId);
  if (d?.state === "delivered") return true;
  // Back-compat: older versions used readBy_agents only.
  return Array.isArray(msg.readBy_agents) && msg.readBy_agents.includes(myId);
}

function isDeliveredTask(task: Task, myId: string): boolean {
  const d = getDelivery(task, myId);
  return d?.state === "delivered";
}

/**
 * Start observing the Yjs state and dispatching inbound work into the agent loop.
 */
export function startMessageDispatcher(api: OpenClawPluginApi, config: AnsibleConfig): void {
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
  const runtime = (api as any).runtime as any;
  if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    api.logger?.warn(
      "Ansible dispatcher: runtime.channel.reply not available — dispatch disabled",
    );
    return;
  }

  const reply = runtime.channel.reply;
  const session = runtime.channel.session;
  const apiConfig = (api as any).config; // OpenClaw config (not plugin config)

  const messagesMap = doc.getMap("messages");
  const tasksMap = doc.getMap("tasks");

  const inFlight = new Set<string>();
  const scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  let reconcileQueued = false;

  const queueReconcile = (reason: string) => {
    if (reconcileQueued) return;
    reconcileQueued = true;
    setTimeout(() => {
      reconcileQueued = false;
      void reconcileNow(reason);
    }, 0);
  };
  requestReconcileHook = queueReconcile;

  const scheduleRetry = (key: string, attempts: number, reason: string) => {
    if (scheduled.has(key)) return;
    const ms = calcBackoffMs(attempts);
    api.logger?.warn(`Ansible dispatcher: scheduling retry for ${key} in ${ms}ms (${reason})`);
    const t = setTimeout(() => {
      scheduled.delete(key);
      queueReconcile(`retry:${key}`);
    }, ms);
    scheduled.set(key, t);
  };

  const reconcileNow = async (reason: string) => {
    const doc = getDoc();
    const myId = getNodeId();
    if (!doc || !myId) return;

    const localAgents = getLocalInternalAgents(doc, myId);
    const contextMap = getAnsibleState()?.context;

    const msgs = doc.getMap("messages");
    const tasks = doc.getMap("tasks");

    const pendingMessages: Array<{ id: string; targetAgent: string; msg: Message }> = [];
    for (const [id, value] of msgs.entries()) {
      const msg = value as Message;
      if (!msg || typeof msg !== "object") continue;
      for (const targetAgent of localAgents) {
        if (msg.from_agent === targetAgent) continue;
        if (msg.to_agents?.length && !msg.to_agents.includes(targetAgent)) continue;
        if (isDeliveredMessage(msg, targetAgent)) continue;
        const key = `msg:${id}:${targetAgent}`;
        const msgAttempts = msg.delivery?.[targetAgent]?.attempts ?? 0;
        if (msgAttempts >= MAX_DELIVERY_ATTEMPTS) {
          api.logger?.warn(
            `Ansible dispatcher: message ${id.slice(0, 8)} from ${msg.from_agent} to ${targetAgent} exceeded ${MAX_DELIVERY_ATTEMPTS} delivery attempts — skipping.`
          );
          continue;
        }
        if (scheduled.has(key)) continue;
        pendingMessages.push({ id: id as string, targetAgent, msg });
      }
    }

    pendingMessages.sort((a, b) => {
      const ta = a.msg.timestamp || 0;
      const tb = b.msg.timestamp || 0;
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    });

    const pendingTasks: Array<{ id: string; targetAgent: string; task: Task }> = [];
    for (const [id, value] of tasks.entries()) {
      const task = value as Task;
      if (!task || typeof task !== "object") continue;
      const assignees = getTaskAssignees(task);
      if (assignees.length === 0) continue; // only explicit assignments
      if (task.status !== "pending" && task.status !== "claimed" && task.status !== "in_progress") continue;
      for (const targetAgent of assignees) {
        if (!localAgents.includes(targetAgent)) continue;
        if (task.createdBy_agent === targetAgent) continue;
        if (task.claimedBy_agent && task.claimedBy_agent !== targetAgent) continue;
        if (isDeliveredTask(task, targetAgent)) continue;
        const taskAttempts = task.delivery?.[targetAgent]?.attempts ?? 0;
        if (taskAttempts >= MAX_DELIVERY_ATTEMPTS) {
          api.logger?.warn(
            `Ansible dispatcher: task ${id.slice(0, 8)} "${task.title}" for ${targetAgent} exceeded ${MAX_DELIVERY_ATTEMPTS} delivery attempts — skipping.`
          );
          continue;
        }
        if (task.skillRequired) {
          const targetSkills: string[] = contextMap?.get(targetAgent)?.skills ?? [];
          if (!targetSkills.includes(task.skillRequired)) {
            api.logger?.debug(
              `Ansible dispatcher: skipping task ${id.slice(0, 8)} for ${targetAgent} — missing skill '${task.skillRequired}'`
            );
            continue;
          }
        }
        const key = `task:${id}:${targetAgent}`;
        if (scheduled.has(key)) continue;
        pendingTasks.push({ id: id as string, targetAgent, task });
      }
    }

    pendingTasks.sort((a, b) => {
      const ta = a.task.createdAt || 0;
      const tb = b.task.createdAt || 0;
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    });

    if (pendingMessages.length || pendingTasks.length) {
      api.logger?.info(
        `Ansible dispatcher: reconcile (${reason}): ${pendingMessages.length} msg(s), ${pendingTasks.length} task(s)`,
      );
    }

    for (const { id, targetAgent, msg } of pendingMessages) {
      const key = `msg:${id}:${targetAgent}`;
      if (inFlight.has(key)) continue;
      inFlight.add(key);
      let attempts = 0;
      try {
        attempts = markAttemptedMessage(msgs, id, targetAgent);
        await dispatchAnsibleMessage(api, reply, session, apiConfig, myId, targetAgent, id, msg);
        markDeliveredMessage(msgs, id, targetAgent, attempts);
      } catch (err) {
        attempts = markAttemptErrorMessage(msgs, id, targetAgent, safeErr(err));
        scheduleRetry(key, attempts, "dispatch-error");
      } finally {
        inFlight.delete(key);
      }
    }

    for (const { id, targetAgent, task } of pendingTasks) {
      const key = `task:${id}:${targetAgent}`;
      if (inFlight.has(key)) continue;
      inFlight.add(key);
      let attempts = 0;
      try {
        attempts = markAttemptedTask(tasks, id, targetAgent);
        await dispatchAnsibleTask(api, reply, session, apiConfig, myId, targetAgent, id, task);
        markDeliveredTask(tasks, id, targetAgent, attempts);
      } catch (err) {
        attempts = markAttemptErrorTask(tasks, id, targetAgent, safeErr(err));
        scheduleRetry(key, attempts, "dispatch-error");
      } finally {
        inFlight.delete(key);
      }
    }
  };

  // Observe changes and reconcile (debounced).
  messagesMap.observe(() => queueReconcile("messages-change"));
  tasksMap.observe(() => queueReconcile("tasks-change"));
  onSync((synced, peer) => {
    if (!synced) return;
    queueReconcile(`sync:${peer || "peer"}`);
  });

  api.logger?.info("Ansible dispatcher: enabled (live dispatch + reconnect reconciliation)");
  queueReconcile("startup");
}

export function requestDispatcherReconcile(reason = "manual"): void {
  requestReconcileHook?.(reason);
}

function markAttemptedMessage(
  messages: any,
  messageId: string,
  myId: AgentId,
  lastError?: string,
): number {
  const current = messages.get(messageId) as Message | undefined;
  if (!current) return 1;

  const prev = current.delivery?.[myId];
  const attempts = (prev?.attempts ?? 0) + 1;
  const now = Date.now();
  const updated: DeliveryRecord = {
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
  } satisfies Message);

  return attempts;
}

function markAttemptErrorMessage(messages: any, messageId: string, myId: AgentId, lastError: string): number {
  const current = messages.get(messageId) as Message | undefined;
  if (!current) return 1;

  const prev = current.delivery?.[myId];
  const attempts = prev?.attempts ?? 1;
  const now = Date.now();
  const updated: DeliveryRecord = {
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
  } satisfies Message);

  return attempts;
}

function markDeliveredMessage(messages: any, messageId: string, myId: AgentId, attempts: number): void {
  const current = messages.get(messageId) as Message | undefined;
  if (!current) return;

  const now = Date.now();
  const updated: DeliveryRecord = {
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
  } satisfies Message);
}

function markAttemptedTask(tasks: any, taskId: string, myId: AgentId, lastError?: string): number {
  const current = tasks.get(taskId) as Task | undefined;
  if (!current) return 1;

  const prev = current.delivery?.[myId];
  const attempts = (prev?.attempts ?? 0) + 1;
  const updated: DeliveryRecord = {
    state: "attempted",
    at: Date.now(),
    by: myId,
    attempts,
    lastError,
  };

  tasks.set(taskId, {
    ...current,
    delivery: { ...(current.delivery || {}), [myId]: updated },
  } satisfies Task);

  return attempts;
}

function markAttemptErrorTask(tasks: any, taskId: string, myId: AgentId, lastError: string): number {
  const current = tasks.get(taskId) as Task | undefined;
  if (!current) return 1;

  const prev = current.delivery?.[myId];
  const attempts = prev?.attempts ?? 1;
  const updated: DeliveryRecord = {
    state: "attempted",
    at: Date.now(),
    by: myId,
    attempts,
    lastError,
  };

  tasks.set(taskId, {
    ...current,
    delivery: { ...(current.delivery || {}), [myId]: updated },
  } satisfies Task);

  return attempts;
}

function markDeliveredTask(tasks: any, taskId: string, myId: AgentId, attempts: number): void {
  const current = tasks.get(taskId) as Task | undefined;
  if (!current) return;

  const updated: DeliveryRecord = {
    state: "delivered",
    at: Date.now(),
    by: myId,
    attempts,
  };

  tasks.set(taskId, {
    ...current,
    delivery: { ...(current.delivery || {}), [myId]: updated },
  } satisfies Task);
}

async function dispatchAnsibleMessage(
  api: OpenClawPluginApi,
  reply: any,
  session: any,
  cfg: any,
  myNodeId: string,
  targetAgent: string,
  messageId: string,
  msg: Message,
): Promise<void> {
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
      onRecordError: (err: unknown) => {
        api.logger?.warn(`Ansible dispatcher: session record error: ${safeErr(err)}`);
      },
    });
  }

  // 4. Dispatch into the agent loop
  await reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string }, info: { kind: string }) => {
        // Only deliver the final reply, not intermediate blocks
        if (info.kind !== "final") return;
        if (!payload.text) return;
        if (shouldSuppressReplyText(payload.text)) {
          api.logger?.warn(
            `Ansible dispatcher: suppressed model/runtime error reply for msg ${messageId.slice(0, 8)} (${targetAgent} -> ${msg.from_agent})`,
          );
          return;
        }

        const doc = getDoc();
        if (!doc) return;

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
        } satisfies Message);

        api.logger?.info(
          `Ansible dispatcher: reply ${replyId.slice(0, 8)} sent to ${msg.from_agent}`,
        );
      },
      onError: (err: unknown, info: { kind: string }) => {
        api.logger?.warn(`Ansible dispatcher: ${info.kind} reply error: ${safeErr(err)}`);
      },
    },
  });

  api.logger?.info(`Ansible dispatcher: delivered message ${messageId.slice(0, 8)} from ${msg.from_agent}`);
}

async function dispatchAnsibleTask(
  api: OpenClawPluginApi,
  reply: any,
  session: any,
  cfg: any,
  myNodeId: string,
  targetAgent: string,
  taskId: string,
  task: Task,
): Promise<void> {
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
      onRecordError: (err: unknown) => {
        api.logger?.warn(`Ansible dispatcher: session record error: ${safeErr(err)}`);
      },
    });
  }

  await reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string }, info: { kind: string }) => {
        if (info.kind !== "final") return;
        if (!payload.text) return;
        if (shouldSuppressReplyText(payload.text)) {
          api.logger?.warn(
            `Ansible dispatcher: suppressed model/runtime error task reply for task ${taskId.slice(0, 8)} (${targetAgent} -> ${task.createdBy_agent})`,
          );
          return;
        }

        const doc = getDoc();
        if (!doc) return;

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
        } satisfies Message);

        api.logger?.info(
          `Ansible dispatcher: task reply ${replyId.slice(0, 8)} sent to ${task.createdBy_agent}`,
        );
      },
      onError: (err: unknown, info: { kind: string }) => {
        api.logger?.warn(`Ansible dispatcher: ${info.kind} reply error: ${safeErr(err)}`);
      },
    },
  });

  api.logger?.info(`Ansible dispatcher: delivered task ${taskId.slice(0, 8)} from ${task.createdBy_agent}`);
}
