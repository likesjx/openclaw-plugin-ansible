/**
 * Ansible CLI Commands
 *
 * Management commands for the Ansible coordination layer.
 *
 * Commands that read live state (status, nodes, tasks, send) call the running
 * gateway's /tools/invoke HTTP endpoint so they see the real Yjs document.
 * Setup commands (bootstrap, join, invite, revoke) still use direct Yjs access
 * because they run when the gateway IS the current process.
 */

import * as fs from "fs";
import * as path from "path";
import type { OpenClawPluginApi, CliProgram, CliCommand } from "./types.js";
import type { AnsibleConfig } from "./schema.js";
import { getNodeId } from "./service.js";
import {
  generateInviteToken,
  joinWithToken,
  bootstrapFirstNode,
  revokeNode,
} from "./auth.js";

// ---------------------------------------------------------------------------
// Gateway HTTP helper
// ---------------------------------------------------------------------------

interface GatewayConfig {
  port: number;
  token: string;
}

function readGatewayConfig(): GatewayConfig {
  // Resolve config path: $OPENCLAW_CONFIG or ~/.openclaw/openclaw.json
  const configPath =
    process.env.OPENCLAW_CONFIG ||
    path.join(process.env.HOME || process.env.USERPROFILE || ".", ".openclaw", "openclaw.json");

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`Cannot read config at ${configPath}`);
  }

  const config = JSON.parse(raw);
  const port = config?.gateway?.port ?? 18789;
  const token = config?.gateway?.auth?.token;

  if (!token) {
    throw new Error("gateway.auth.token not set in openclaw config");
  }

  return { port, token };
}

async function callGateway(
  tool: string,
  args: Record<string, unknown> = {}
): Promise<any> {
  const { port, token } = readGatewayConfig();
  const url = `http://127.0.0.1:${port}/tools/invoke`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ tool, args }),
    });
  } catch (err: any) {
    throw new Error(`Gateway not running on port ${port} (${err.cause?.code || err.message})`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error("Authentication failed — check gateway.auth.token in config");
    }
    throw new Error(`Gateway returned ${res.status}: ${body}`);
  }

  const json: any = await res.json();

  // Gateway wraps tool results in { ok, result } or { error }
  if (json.error) {
    throw new Error(json.error.message || JSON.stringify(json.error));
  }

  return json.result ?? json;
}

export function registerAnsibleCli(
  api: OpenClawPluginApi,
  config: AnsibleConfig
) {
  api.registerCli?.(
    ({ program }: { program: CliProgram }) => {
      const ansible = program.command("ansible").description("Ansible coordination layer") as CliCommand;

    // === ansible status ===
    ansible
      .command("status")
      .description("Show status of all hemispheres")
      .action(async () => {
        let result: any;
        try {
          result = await callGateway("ansible.status");
        } catch (err: any) {
          console.log(`✗ ${err.message}`);
          return;
        }

        if (result.error) {
          console.log(`✗ ${result.error}`);
          return;
        }

        console.log("\n=== Ansible Status ===\n");
        console.log(`My ID: ${result.myId}`);
        console.log(`Tier: ${config.tier}`);
        console.log();

        // Nodes
        console.log("Hemispheres:");
        const nodes = result.nodes || [];
        if (nodes.length === 0) {
          console.log("  (no nodes online)");
        }
        for (const node of nodes) {
          const isMe = node.id === result.myId ? " (me)" : "";
          const focus = node.currentFocus ? ` - ${node.currentFocus}` : "";
          const icon = node.status === "online" ? "●" : "○";
          console.log(`  ${icon} ${node.id}${isMe}${focus}`);
          console.log(`    Last seen: ${new Date(node.lastSeen).toLocaleString()}`);
        }
        console.log();

        // Tasks
        const pendingTasks = result.pendingTasks || [];
        console.log(`Pending tasks: ${pendingTasks.length}`);
        for (const task of pendingTasks.slice(0, 5)) {
          const assignee = task.assignedTo && task.assignedTo !== "anyone" ? ` → ${task.assignedTo}` : "";
          console.log(`  - [${task.id}] ${task.title}${assignee}`);
        }
        if (pendingTasks.length > 5) {
          console.log(`  ... and ${pendingTasks.length - 5} more`);
        }
        console.log();

        // Messages
        console.log(`Unread messages: ${result.unreadMessages || 0}`);
      });

    // === ansible nodes ===
    ansible
      .command("nodes")
      .description("List authorized nodes")
      .action(async () => {
        let result: any;
        try {
          result = await callGateway("ansible.status");
        } catch (err: any) {
          console.log(`✗ ${err.message}`);
          return;
        }

        if (result.error) {
          console.log(`✗ ${result.error}`);
          return;
        }

        console.log("\n=== Authorized Nodes ===\n");

        const nodes = result.nodes || [];
        if (nodes.length === 0) {
          console.log("No nodes online.");
          console.log("\nTo bootstrap the first node, run:");
          console.log("  openclaw ansible bootstrap");
          return;
        }

        for (const node of nodes) {
          const isMe = node.id === result.myId ? " (me)" : "";
          const icon = node.status === "online" ? "●" : "○";

          console.log(`${icon} ${node.id}${isMe}`);
          console.log(`  Status: ${node.status}`);
          if (node.currentFocus) {
            console.log(`  Focus: ${node.currentFocus}`);
          }
          console.log(`  Last seen: ${new Date(node.lastSeen).toLocaleString()}`);
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

        let result: any;
        try {
          result = await callGateway("ansible.status");
        } catch (err: any) {
          console.log(`✗ ${err.message}`);
          return;
        }

        if (result.error) {
          console.log(`✗ ${result.error}`);
          return;
        }

        console.log("\n=== Tasks ===\n");

        // The status tool only returns pending tasks; display what we have
        const tasks: any[] = result.pendingTasks || [];
        if (tasks.length === 0) {
          console.log("No pending tasks.");
          return;
        }

        for (const task of tasks) {
          // If caller filtered by status and this doesn't match, skip
          if (opts.status && opts.status !== "pending") continue;

          const assignee = task.assignedTo && task.assignedTo !== "anyone" ? ` → ${task.assignedTo}` : "";
          console.log(`○ [${task.id}] ${task.title}${assignee}`);
          console.log(`  Status: pending`);
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

        const toolArgs: Record<string, unknown> = { content: opts.message };
        if (opts.to) {
          toolArgs.to = opts.to;
        }

        let result: any;
        try {
          result = await callGateway("ansible.send_message", toolArgs);
        } catch (err: any) {
          console.log(`✗ ${err.message}`);
          return;
        }

        if (result.error) {
          console.log(`✗ ${result.error}`);
          return;
        }

        if (opts.to) {
          console.log(`✓ Message sent to ${opts.to}`);
        } else {
          console.log("✓ Message broadcast to all hemispheres");
        }
      });
    },
    { commands: ["ansible"] }
  );
}
