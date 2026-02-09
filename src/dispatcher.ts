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
import type { AnsibleConfig, DeliveryRecord, Message, Task, TailscaleId } from "./schema.js";
import { getDoc, getNodeId, onSync } from "./service.js";

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
const RETRY_JITTER = 0.2;

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

function getDelivery(item: { delivery?: Record<string, DeliveryRecord> }, myId: string): DeliveryRecord | undefined {
  return item.delivery?.[myId];
}

function isDeliveredMessage(msg: Message, myId: string): boolean {
  const d = getDelivery(msg, myId);
  if (d?.state === "delivered") return true;
  // Back-compat: older versions used readBy only.
  return Array.isArray(msg.readBy) && msg.readBy.includes(myId);
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

    const msgs = doc.getMap("messages");
    const tasks = doc.getMap("tasks");

    const pendingMessages: Array<{ id: string; msg: Message }> = [];
    for (const [id, value] of msgs.entries()) {
      const msg = value as Message;
      if (!msg || typeof msg !== "object") continue;
      if (msg.from === myId) continue;
      if (msg.to && msg.to !== myId) continue;
      if (isDeliveredMessage(msg, myId)) continue;
      // If a retry is already scheduled for this message, wait for the timer.
      if (scheduled.has(`msg:${id}`)) continue;
      pendingMessages.push({ id: id as string, msg });
    }

    pendingMessages.sort((a, b) => {
      const ta = a.msg.timestamp || 0;
      const tb = b.msg.timestamp || 0;
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    });

    const pendingTasks: Array<{ id: string; task: Task }> = [];
    for (const [id, value] of tasks.entries()) {
      const task = value as Task;
      if (!task || typeof task !== "object") continue;
      if (task.createdBy === myId) continue;
      if (task.assignedTo !== myId) continue; // only explicit assignments
      if (task.status !== "pending" && task.status !== "claimed" && task.status !== "in_progress") continue;
      if (task.claimedBy && task.claimedBy !== myId) continue;
      if (isDeliveredTask(task, myId)) continue;
      if (scheduled.has(`task:${id}`)) continue;
      pendingTasks.push({ id: id as string, task });
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

    for (const { id, msg } of pendingMessages) {
      const key = `msg:${id}`;
      if (inFlight.has(key)) continue;
      inFlight.add(key);
      let attempts = 0;
      try {
        attempts = markAttemptedMessage(msgs, id, myId);
        await dispatchAnsibleMessage(api, reply, session, apiConfig, myId, id, msg);
        markDeliveredMessage(msgs, id, myId, attempts);
      } catch (err) {
        attempts = markAttemptErrorMessage(msgs, id, myId, safeErr(err));
        scheduleRetry(key, attempts, "dispatch-error");
      } finally {
        inFlight.delete(key);
      }
    }

    for (const { id, task } of pendingTasks) {
      const key = `task:${id}`;
      if (inFlight.has(key)) continue;
      inFlight.add(key);
      let attempts = 0;
      try {
        attempts = markAttemptedTask(tasks, id, myId);
        await dispatchAnsibleTask(api, reply, session, apiConfig, myId, id, task);
        markDeliveredTask(tasks, id, myId, attempts);
      } catch (err) {
        attempts = markAttemptErrorTask(tasks, id, myId, safeErr(err));
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

function markAttemptedMessage(
  messages: any,
  messageId: string,
  myId: TailscaleId,
  lastError?: string,
): number {
  const current = messages.get(messageId) as Message | undefined;
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

  messages.set(messageId, {
    ...current,
    delivery: { ...(current.delivery || {}), [myId]: updated },
  } satisfies Message);

  return attempts;
}

function markAttemptErrorMessage(messages: any, messageId: string, myId: TailscaleId, lastError: string): number {
  const current = messages.get(messageId) as Message | undefined;
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

  messages.set(messageId, {
    ...current,
    delivery: { ...(current.delivery || {}), [myId]: updated },
  } satisfies Message);

  return attempts;
}

function markDeliveredMessage(messages: any, messageId: string, myId: TailscaleId, attempts: number): void {
  const current = messages.get(messageId) as Message | undefined;
  if (!current) return;

  const updated: DeliveryRecord = {
    state: "delivered",
    at: Date.now(),
    by: myId,
    attempts,
  };

  const readBy = Array.isArray(current.readBy) ? current.readBy : [];
  const nextReadBy = readBy.includes(myId) ? readBy : [...readBy, myId];

  messages.set(messageId, {
    ...current,
    readBy: nextReadBy,
    delivery: { ...(current.delivery || {}), [myId]: updated },
  } satisfies Message);
}

function markAttemptedTask(tasks: any, taskId: string, myId: TailscaleId, lastError?: string): number {
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

function markAttemptErrorTask(tasks: any, taskId: string, myId: TailscaleId, lastError: string): number {
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

function markDeliveredTask(tasks: any, taskId: string, myId: TailscaleId, attempts: number): void {
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
  myId: string,
  messageId: string,
  msg: Message,
): Promise<void> {
  const senderName = msg.from;
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
  const sessionKey = `ansible:${msg.from}`;
  const ctx = reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `ansible:${msg.from}`,
    To: `ansible:${myId}`,
    SessionKey: sessionKey,
    Provider: "ansible",
    Surface: "ansible",
    ChatType: "direct",
    SenderName: senderName,
    SenderId: msg.from,
    MessageSid: messageId,
    OriginatingChannel: "ansible",
    OriginatingTo: `ansible:${msg.from}`,
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

        const doc = getDoc();
        if (!doc) return;

        const messagesMap = doc.getMap("messages");
        const replyId = randomUUID();
        messagesMap.set(replyId, {
          id: replyId,
          from: myId,
          to: msg.from,
          content: payload.text,
          timestamp: Date.now(),
          readBy: [myId],
        } satisfies Message);

        api.logger?.info(
          `Ansible dispatcher: reply ${replyId.slice(0, 8)} sent to ${msg.from}`,
        );
      },
      onError: (err: unknown, info: { kind: string }) => {
        api.logger?.warn(`Ansible dispatcher: ${info.kind} reply error: ${safeErr(err)}`);
      },
    },
  });

  api.logger?.info(`Ansible dispatcher: delivered message ${messageId.slice(0, 8)} from ${msg.from}`);
}

async function dispatchAnsibleTask(
  api: OpenClawPluginApi,
  reply: any,
  session: any,
  cfg: any,
  myId: string,
  taskId: string,
  task: Task,
): Promise<void> {
  const senderName = task.createdBy;
  const rawBody = [
    `[Ansible Task] ${task.title}`,
    `taskId: ${taskId}`,
    `status: ${task.status}`,
    `assignedTo: ${task.assignedTo || ""}`,
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

  const sessionKey = `ansible:task:${taskId}`;
  const ctx = reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `ansible:${task.createdBy}`,
    To: `ansible:${myId}`,
    SessionKey: sessionKey,
    Provider: "ansible",
    Surface: "ansible",
    ChatType: "direct",
    SenderName: senderName,
    SenderId: task.createdBy,
    MessageSid: `task:${taskId}`,
    OriginatingChannel: "ansible",
    OriginatingTo: `ansible:${task.createdBy}`,
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

        const doc = getDoc();
        if (!doc) return;

        // Send the final reply back to the task creator as an ansible message.
        const messagesMap = doc.getMap("messages");
        const replyId = randomUUID();
        messagesMap.set(replyId, {
          id: replyId,
          from: myId,
          to: task.createdBy,
          content: payload.text,
          timestamp: Date.now(),
          readBy: [myId],
        } satisfies Message);

        api.logger?.info(
          `Ansible dispatcher: task reply ${replyId.slice(0, 8)} sent to ${task.createdBy}`,
        );
      },
      onError: (err: unknown, info: { kind: string }) => {
        api.logger?.warn(`Ansible dispatcher: ${info.kind} reply error: ${safeErr(err)}`);
      },
    },
  });

  api.logger?.info(`Ansible dispatcher: delivered task ${taskId.slice(0, 8)} from ${task.createdBy}`);
}
