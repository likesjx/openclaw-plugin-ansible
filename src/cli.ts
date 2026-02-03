/**
 * Ansible CLI Commands
 *
 * Management commands for the Ansible coordination layer.
 */

import type { OpenClawPluginApi, CliProgram, CliCommand } from "./types.js";
import type { AnsibleConfig } from "./schema.js";
import { getAnsibleState, getNodeId } from "./service.js";

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
        console.log();

        // Nodes
        console.log("Hemispheres:");
        for (const [id, pulse] of state.pulse.entries()) {
          const context = state.context.get(id);
          const isMe = id === myId ? " (me)" : "";
          const focus = context?.currentFocus ? ` - ${context.currentFocus}` : "";
          console.log(`  ${pulse.status === "online" ? "●" : "○"} ${id}${isMe}${focus}`);
          console.log(`    Last seen: ${new Date(pulse.lastSeen).toLocaleString()}`);
        }
        console.log();

        // Tasks
        const pendingTasks = Array.from(state.tasks.values()).filter(
          (t) => t.status === "pending"
        );
        console.log(`Pending tasks: ${pendingTasks.length}`);
        for (const task of pendingTasks.slice(0, 5)) {
          console.log(`  - [${task.id.slice(0, 8)}] ${task.title}`);
        }
        console.log();

        // Messages
        const unread = Array.from(state.messages.values()).filter(
          (m) => myId && m.from !== myId && !m.readBy.includes(myId)
        );
        console.log(`Unread messages: ${unread.length}`);
        for (const msg of unread.slice(0, 3)) {
          console.log(`  - From ${msg.from}: ${msg.content.slice(0, 50)}...`);
        }
      });

    // === ansible nodes ===
    ansible
      .command("nodes")
      .description("List authorized nodes")
      .action(async () => {
        const state = getAnsibleState();

        if (!state) {
          console.log("Ansible not initialized");
          return;
        }

        console.log("\n=== Authorized Nodes ===\n");
        for (const [id, info] of state.nodes.entries()) {
          console.log(`${id}`);
          console.log(`  Tier: ${info.tier}`);
          console.log(`  Capabilities: ${info.capabilities.join(", ") || "none"}`);
          console.log(`  Added by: ${info.addedBy}`);
          console.log(`  Added at: ${new Date(info.addedAt).toLocaleString()}`);
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
        for (const task of state.tasks.values()) {
          if (opts.status && task.status !== opts.status) continue;

          const statusIcon =
            task.status === "completed"
              ? "✓"
              : task.status === "in_progress"
                ? "▶"
                : task.status === "claimed"
                  ? "◎"
                  : "○";

          console.log(`${statusIcon} [${task.id.slice(0, 8)}] ${task.title}`);
          console.log(`  Status: ${task.status}`);
          console.log(`  Created by: ${task.createdBy}`);
          if (task.claimedBy) {
            console.log(`  Claimed by: ${task.claimedBy}`);
          }
          console.log();
        }
      });

    // === ansible invite ===
    ansible
      .command("invite <nodeId>")
      .description("Invite a new node to join")
      .option("-t, --tier <tier>", "Node tier: backbone or edge", "edge")
      .action(async (...args: unknown[]) => {
        const nodeId = args[0] as string;
        const opts = (args[1] || { tier: "edge" }) as { tier: string };
        // TODO: Implement invite flow
        console.log(`Inviting ${nodeId} as ${opts.tier} node...`);
        console.log("TODO: Generate bootstrap token");
      });

    // === ansible revoke ===
    ansible
      .command("revoke <nodeId>")
      .description("Revoke a node's access")
      .action(async (...args: unknown[]) => {
        const nodeId = args[0] as string;
        // TODO: Implement revoke
        console.log(`Revoking ${nodeId}...`);
        console.log("TODO: Remove from authorized nodes");
      });

    // === ansible send ===
    ansible
      .command("send <message>")
      .description("Send a message to other hemispheres")
      .option("-t, --to <nodeId>", "Send to specific node")
      .action(async (...args: unknown[]) => {
        const message = args[0] as string;
        const opts = (args[1] || {}) as { to?: string };
        // TODO: Implement send via doc
        console.log(`Sending message: ${message}`);
        if (opts.to) {
          console.log(`To: ${opts.to}`);
        } else {
          console.log("Broadcasting to all");
        }
      });
  });
}
