/**
 * Ansible CLI Commands
 *
 * Management commands for the Ansible coordination layer.
 */

import type { OpenClawPluginApi, CliProgram, CliCommand } from "./types.js";
import type { AnsibleConfig } from "./schema.js";
import { getAnsibleState, getNodeId } from "./service.js";
import {
  generateInviteToken,
  joinWithToken,
  bootstrapFirstNode,
  revokeNode,
  isNodeAuthorized,
} from "./auth.js";

export function registerAnsibleCli(
  api: OpenClawPluginApi,
  config: AnsibleConfig
) {
  api.registerCli?.((program: CliProgram) => {
    const ansible = program.command("ansible").description("Ansible coordination layer") as CliCommand;

    // === ansible status ===
    ansible
      .command("status")
      .description("Show status of all hemispheres")
      .action(async () => {
        const state = getAnsibleState();
        const myId = getNodeId();

        if (!state) {
          console.log("Ansible not initialized");
          return;
        }

        console.log("\n=== Ansible Status ===\n");
        console.log(`My ID: ${myId}`);
        console.log(`Tier: ${config.tier}`);
        console.log(`Authorized: ${myId ? isNodeAuthorized(myId) : false}`);
        console.log();

        // Nodes
        console.log("Hemispheres:");
        if (state.pulse.size === 0) {
          console.log("  (no nodes online)");
        }
        for (const [id, pulse] of state.pulse.entries()) {
          const context = state.context.get(id);
          const nodeInfo = state.nodes.get(id);
          const isMe = id === myId ? " (me)" : "";
          const tier = nodeInfo?.tier ? ` [${nodeInfo.tier}]` : "";
          const focus = context?.currentFocus ? ` - ${context.currentFocus}` : "";
          const icon = pulse.status === "online" ? "●" : "○";
          console.log(`  ${icon} ${id}${isMe}${tier}${focus}`);
          console.log(`    Last seen: ${new Date(pulse.lastSeen).toLocaleString()}`);
        }
        console.log();

        // Tasks
        const pendingTasks = Array.from(state.tasks.values()).filter(
          (t) => t.status === "pending"
        );
        console.log(`Pending tasks: ${pendingTasks.length}`);
        for (const task of pendingTasks.slice(0, 5)) {
          const assignee = task.assignedTo ? ` → ${task.assignedTo}` : "";
          console.log(`  - [${task.id.slice(0, 8)}] ${task.title}${assignee}`);
        }
        if (pendingTasks.length > 5) {
          console.log(`  ... and ${pendingTasks.length - 5} more`);
        }
        console.log();

        // Messages
        const unread = Array.from(state.messages.values()).filter(
          (m) => myId && m.from !== myId && !m.readBy.includes(myId)
        );
        console.log(`Unread messages: ${unread.length}`);
        for (const msg of unread.slice(0, 3)) {
          const preview = msg.content.length > 50 ? msg.content.slice(0, 50) + "..." : msg.content;
          console.log(`  - From ${msg.from}: ${preview}`);
        }
        if (unread.length > 3) {
          console.log(`  ... and ${unread.length - 3} more`);
        }
      });

    // === ansible nodes ===
    ansible
      .command("nodes")
      .description("List authorized nodes")
      .action(async () => {
        const state = getAnsibleState();
        const myId = getNodeId();

        if (!state) {
          console.log("Ansible not initialized");
          return;
        }

        console.log("\n=== Authorized Nodes ===\n");

        if (state.nodes.size === 0) {
          console.log("No nodes authorized yet.");
          console.log("\nTo bootstrap the first node, run:");
          console.log("  openclaw ansible bootstrap");
          return;
        }

        for (const [id, info] of state.nodes.entries()) {
          const isMe = id === myId ? " (me)" : "";
          const pulse = state.pulse.get(id);
          const status = pulse?.status === "online" ? "●" : "○";

          console.log(`${status} ${id}${isMe}`);
          console.log(`  Tier: ${info.tier}`);
          console.log(`  Capabilities: ${info.capabilities?.join(", ") || "none"}`);
          console.log(`  Added by: ${info.addedBy}`);
          console.log(`  Added: ${new Date(info.addedAt).toLocaleString()}`);
          console.log();
        }
      });

    // === ansible tasks ===
    ansible
      .command("tasks")
      .description("List all tasks")
      .option("-s, --status <status>", "Filter by status")
      .action(async (...args: unknown[]) => {
        const opts = (args[0] || {}) as { status?: string };
        const state = getAnsibleState();

        if (!state) {
          console.log("Ansible not initialized");
          return;
        }

        console.log("\n=== Tasks ===\n");

        const tasks = Array.from(state.tasks.values());
        if (tasks.length === 0) {
          console.log("No tasks.");
          return;
        }

        for (const task of tasks) {
          if (opts.status && task.status !== opts.status) continue;

          const statusIcon =
            task.status === "completed"
              ? "✓"
              : task.status === "in_progress"
                ? "▶"
                : task.status === "claimed"
                  ? "◎"
                  : task.status === "failed"
                    ? "✗"
                    : "○";

          console.log(`${statusIcon} [${task.id.slice(0, 8)}] ${task.title}`);
          console.log(`  Status: ${task.status}`);
          console.log(`  Created by: ${task.createdBy}`);
          if (task.assignedTo) {
            console.log(`  Assigned to: ${task.assignedTo}`);
          }
          if (task.claimedBy) {
            console.log(`  Claimed by: ${task.claimedBy}`);
          }
          if (task.result) {
            console.log(`  Result: ${task.result.slice(0, 100)}...`);
          }
          console.log();
        }
      });

    // === ansible bootstrap ===
    ansible
      .command("bootstrap")
      .description("Bootstrap as the first node in the network")
      .action(async () => {
        const result = bootstrapFirstNode(config.tier, config.capabilities);

        if (result.success) {
          console.log("✓ Successfully bootstrapped as first node");
          console.log(`  Tier: ${config.tier}`);
          console.log(`  Node ID: ${getNodeId()}`);
          console.log("\nTo invite other nodes, run:");
          console.log("  openclaw ansible invite --tier <backbone|edge>");
        } else {
          console.log(`✗ Bootstrap failed: ${result.error}`);
        }
      });

    // === ansible invite ===
    ansible
      .command("invite")
      .description("Generate an invite token for a new node")
      .option("-t, --tier <tier>", "Node tier: backbone or edge", "edge")
      .action(async (...args: unknown[]) => {
        const opts = (args[0] || { tier: "edge" }) as { tier: string };
        const tier = opts.tier as "backbone" | "edge";

        const result = generateInviteToken(tier);

        if ("error" in result) {
          console.log(`✗ Failed to generate invite: ${result.error}`);
          return;
        }

        console.log("\n=== Invite Token Generated ===\n");
        console.log(`Token: ${result.token}`);
        console.log(`Tier: ${tier}`);
        console.log(`Expires: ${new Date(result.expiresAt).toLocaleString()}`);
        console.log("\nOn the new node, run:");
        console.log(`  openclaw ansible join --token ${result.token}`);
      });

    // === ansible join ===
    ansible
      .command("join")
      .description("Join the network using an invite token")
      .option("-t, --token <token>", "Invite token")
      .action(async (...args: unknown[]) => {
        const opts = (args[0] || {}) as { token?: string };

        if (!opts.token) {
          console.log("✗ Token required. Use: openclaw ansible join --token <token>");
          return;
        }

        const result = joinWithToken(opts.token, config.capabilities);

        if (result.success) {
          console.log("✓ Successfully joined the Ansible network");
          console.log(`  Node ID: ${getNodeId()}`);
          console.log(`  Tier: ${config.tier}`);
        } else {
          console.log(`✗ Failed to join: ${result.error}`);
        }
      });

    // === ansible revoke ===
    ansible
      .command("revoke")
      .description("Revoke a node's access")
      .option("-n, --node <nodeId>", "Node ID to revoke")
      .action(async (...args: unknown[]) => {
        const opts = (args[0] || {}) as { node?: string };

        if (!opts.node) {
          console.log("✗ Node ID required. Use: openclaw ansible revoke --node <nodeId>");
          return;
        }

        const result = revokeNode(opts.node);

        if (result.success) {
          console.log(`✓ Revoked access for ${opts.node}`);
        } else {
          console.log(`✗ Failed to revoke: ${result.error}`);
        }
      });

    // === ansible send ===
    ansible
      .command("send")
      .description("Send a message to other hemispheres")
      .option("-m, --message <message>", "Message content")
      .option("-t, --to <nodeId>", "Send to specific node (broadcast if omitted)")
      .action(async (...args: unknown[]) => {
        const opts = (args[0] || {}) as { message?: string; to?: string };

        if (!opts.message) {
          console.log("✗ Message required. Use: openclaw ansible send --message 'your message'");
          return;
        }

        const doc = (await import("./service.js")).getDoc();
        const nodeId = (await import("./service.js")).getNodeId();

        if (!doc || !nodeId) {
          console.log("✗ Ansible not initialized");
          return;
        }

        const { randomUUID } = await import("crypto");
        const messages = doc.getMap("messages");

        const message = {
          id: randomUUID(),
          from: nodeId,
          to: opts.to,
          content: opts.message,
          timestamp: Date.now(),
          readBy: [nodeId],
        };

        messages.set(message.id, message);

        if (opts.to) {
          console.log(`✓ Message sent to ${opts.to}`);
        } else {
          console.log("✓ Message broadcast to all hemispheres");
        }
      });
  });
}
