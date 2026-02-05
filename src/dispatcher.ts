/**
 * Ansible Message Dispatcher
 *
 * Observes the Yjs messages map for new inbound messages and dispatches
 * them into the agent loop using the same pattern as built-in extensions
 * (Telegram, Twitch, Zalo): build a MsgContext, finalize it, record the
 * session, and call dispatchReplyWithBufferedBlockDispatcher.
 */

import { randomUUID } from "crypto";
import type { OpenClawPluginApi } from "./types.js";
import type { AnsibleConfig, Message } from "./schema.js";
import { getDoc, getNodeId } from "./service.js";

/**
 * Start observing the Yjs messages map and dispatching new inbound
 * messages into the agent loop.
 */
export function startMessageDispatcher(
  api: OpenClawPluginApi,
  config: AnsibleConfig,
): void {
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

  const messages = doc.getMap("messages");

  // Seed the "already seen" set with all current message IDs so we
  // don't re-process history on startup.
  const seen = new Set<string>();
  for (const id of messages.keys()) {
    seen.add(id as string);
  }

  api.logger?.info(
    `Ansible dispatcher: watching messages map (${seen.size} existing messages skipped)`,
  );

  // Observe new entries
  messages.observe((event) => {
    for (const [id, change] of event.changes.keys) {
      if (change.action !== "add") continue; // only new messages
      if (seen.has(id)) continue;
      seen.add(id);

      const msg = messages.get(id) as Message | undefined;
      if (!msg) continue;

      // Skip our own messages
      if (msg.from === myId) continue;

      // Skip messages addressed to a different node
      if (msg.to && msg.to !== myId) continue;

      // Skip messages we've already read (shouldn't happen for new, but guard)
      if (Array.isArray(msg.readBy) && msg.readBy.includes(myId)) continue;

      api.logger?.info(
        `Ansible dispatcher: new message ${id.slice(0, 8)} from ${msg.from}`,
      );

      // Fire-and-forget async dispatch
      void dispatchAnsibleMessage(api, reply, session, apiConfig, myId, id, msg);
    }
  });
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
  try {
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
      const storePath = session.resolveStorePath?.(cfg) ?? undefined;
      await session.recordInboundSession({
        storePath,
        sessionKey,
        ctx,
        onRecordError: (err: unknown) => {
          api.logger?.warn(`Ansible dispatcher: session record error: ${String(err)}`);
        },
      });
    }

    // 4. Dispatch into the agent loop
    await reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        deliver: async (
          payload: { text?: string },
          info: { kind: string },
        ) => {
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
          api.logger?.warn(
            `Ansible dispatcher: ${info.kind} reply error: ${String(err)}`,
          );
        },
      },
    });

    // 5. Mark the original message as read
    const doc = getDoc();
    if (doc) {
      const messagesMap = doc.getMap("messages");
      const current = messagesMap.get(messageId) as Message | undefined;
      if (current && !current.readBy.includes(myId)) {
        messagesMap.set(messageId, {
          ...current,
          readBy: [...current.readBy, myId],
        });
      }
    }

    api.logger?.info(
      `Ansible dispatcher: finished processing message ${messageId.slice(0, 8)}`,
    );
  } catch (err) {
    api.logger?.warn(
      `Ansible dispatcher: failed to dispatch message ${messageId.slice(0, 8)}: ${String(err)}`,
    );
  }
}
