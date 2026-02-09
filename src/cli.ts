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
import { execFileSync } from "child_process";
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

  // Newer gateways wrap tool results as an AgentToolResult:
  //   { content: [...], details: {...} }
  // Older gateways may return the raw object directly.
  const result = json.result ?? json;
  if (result && typeof result === "object" && "details" in result) {
    return (result as any).details;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Setup helpers (idempotent local provisioning)
// ---------------------------------------------------------------------------

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function runCmd(bin: string, args: string[], opts?: { cwd?: string }): void {
  execFileSync(bin, args, {
    cwd: opts?.cwd,
    stdio: "inherit",
    env: process.env,
  });
}

function ensureGitRepo(params: { dir: string; url: string; name: string }): void {
  const { dir, url, name } = params;

  if (!fs.existsSync(dir)) {
    mkdirp(path.dirname(dir));
    console.log(`- Cloning ${name}: ${url} -> ${dir}`);
    runCmd("git", ["clone", url, dir]);
    return;
  }

  const gitDir = path.join(dir, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error(
      `${name} exists at ${dir} but is not a git repo (missing .git). Move it aside or remove it.`,
    );
  }

  console.log(`- Updating ${name}: ${dir}`);
  runCmd("git", ["-C", dir, "fetch", "origin"]);
  runCmd("git", ["-C", dir, "pull", "--ff-only"]);
}

function readJsonFile(filePath: string): any {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function writeJsonFile(filePath: string, obj: any): void {
  const out = JSON.stringify(obj, null, 2) + "\n";
  fs.writeFileSync(filePath, out, "utf-8");
}

function parseCsvOrRepeat(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function registerAnsibleCli(
  api: OpenClawPluginApi,
  config: AnsibleConfig
) {
  api.registerCli?.(
    ({ program }: { program: CliProgram }) => {
      const ansible = program.command("ansible").description("Ansible coordination layer") as CliCommand;

    // === ansible setup ===
    ansible
      .command("setup")
      .description("Provision ansible plugin config + companion skill on this machine (idempotent)")
      .option("--tier <tier>", "Node tier: backbone or edge")
      .option("--backbone <wsUrl>", "Backbone peer WebSocket URL(s). Repeat or comma-separate.")
      .option("--node-id <id>", "Override this node id for addressing (recommended in Docker; e.g., vps-jane)")
      .option("--capability <cap>", "Capability to advertise (repeatable). Example: local-files, always-on")
      .option("--inject-context <true|false>", "Enable/disable context injection")
      .option("--inject-agent <id>", "Agent id to allow context injection for (repeatable).")
      .option("--dispatch-incoming <true|false>", "Enable/disable auto-dispatch of inbound messages")
      .option("--lock-sweep <true|false>", "Enable/disable per-gateway stale session lock sweeper (recommended)")
      .option("--lock-sweep-every <seconds>", "Lock sweep interval seconds (default 300)")
      .option("--lock-sweep-stale <seconds>", "Treat pid-less locks as stale after seconds (default 1800)")
      .option("--no-skill", "Skip installing/updating the companion skill repo")
      .option("--no-restart", "Do not restart the gateway service after changes")
      .action(async (...args: unknown[]) => {
        const opts = (args[0] || {}) as {
          tier?: string;
          backbone?: string;
          nodeId?: string;
          capability?: string;
          injectContext?: string;
          injectAgent?: string;
          dispatchIncoming?: string;
          lockSweep?: string;
          lockSweepEvery?: string;
          lockSweepStale?: string;
          skill?: boolean;
          restart?: boolean;
        };

        const home = process.env.HOME || process.env.USERPROFILE;
        if (!home) {
          console.log("✗ Cannot resolve HOME; set $HOME and retry.");
          return;
        }

        const openclawDir = path.join(home, ".openclaw");
        const workspaceDir = path.join(openclawDir, "workspace");
        const skillsDir = path.join(workspaceDir, "skills");
        const configPath = process.env.OPENCLAW_CONFIG || path.join(openclawDir, "openclaw.json");

        const requestedTier = opts.tier as "backbone" | "edge" | undefined;
        const backbonePeers = parseCsvOrRepeat(opts.backbone);
        const nodeIdOverride = typeof opts.nodeId === "string" && opts.nodeId.trim() ? opts.nodeId.trim() : undefined;
        const capabilities = parseCsvOrRepeat(opts.capability);
        const injectContext = parseBool(opts.injectContext);
        const dispatchIncoming = parseBool(opts.dispatchIncoming);
        const injectAgents = parseCsvOrRepeat(opts.injectAgent);
        const lockSweepEnabled = parseBool(opts.lockSweep);
        const lockSweepEverySeconds = opts.lockSweepEvery ? Number(opts.lockSweepEvery) : undefined;
        const lockSweepStaleSeconds = opts.lockSweepStale ? Number(opts.lockSweepStale) : undefined;

        if (!fs.existsSync(configPath)) {
          console.log(`✗ Config not found at ${configPath}`);
          console.log("  Run `openclaw gateway --dev` (dev) or create ~/.openclaw/openclaw.json first.");
          return;
        }

        console.log("\n=== Ansible Setup ===\n");

        // 1) Ensure companion skill installed
        if (opts.skill !== false) {
          try {
            ensureGitRepo({
              dir: path.join(skillsDir, "ansible"),
              url: "https://github.com/likesjx/openclaw-skill-ansible.git",
              name: "ansible skill",
            });
          } catch (err: any) {
            console.log(`✗ Skill setup failed: ${String(err?.message || err)}`);
            return;
          }
        } else {
          console.log("- Skipping skill install/update (--no-skill)");
        }

        // 2) Patch config
        let conf: any;
        try {
          conf = readJsonFile(configPath);
        } catch (err: any) {
          console.log(`✗ Failed to read config: ${String(err?.message || err)}`);
          return;
        }

        conf.plugins = conf.plugins || {};
        conf.plugins.entries = conf.plugins.entries || {};
        conf.plugins.entries.ansible = conf.plugins.entries.ansible || { enabled: true, config: {} };
        conf.plugins.entries.ansible.enabled = true;

        const pluginCfg: any = conf.plugins.entries.ansible.config || {};

        // Tier + backbone peers
        const tier = requestedTier || pluginCfg.tier || config.tier;
        if (!tier) {
          console.log("✗ tier not set. Use: openclaw ansible setup --tier edge|backbone");
          return;
        }
        pluginCfg.tier = tier;
        if (nodeIdOverride) pluginCfg.nodeIdOverride = nodeIdOverride;

        if (tier === "edge") {
          if (backbonePeers.length > 0) {
            pluginCfg.backbonePeers = backbonePeers;
          } else if (!Array.isArray(pluginCfg.backbonePeers) || pluginCfg.backbonePeers.length === 0) {
            console.log("✗ edge nodes require --backbone ws://<host>:1235 (or backbonePeers already set in config).");
            return;
          }
        }

        if (capabilities.length > 0) {
          // Merge + de-dupe
          const merged = new Set<string>([...(pluginCfg.capabilities || []), ...capabilities].map(String));
          pluginCfg.capabilities = Array.from(merged);
        }

        if (injectContext !== undefined) pluginCfg.injectContext = injectContext;
        if (dispatchIncoming !== undefined) pluginCfg.dispatchIncoming = dispatchIncoming;

        if (injectAgents.length > 0) {
          const merged = new Set<string>([...(pluginCfg.injectContextAgents || []), ...injectAgents].map(String));
          pluginCfg.injectContextAgents = Array.from(merged);
        }

        // Lock sweeper defaults (opt-in via setup; can still be disabled explicitly)
        pluginCfg.lockSweep = pluginCfg.lockSweep || {};
        if (lockSweepEnabled !== undefined) pluginCfg.lockSweep.enabled = lockSweepEnabled;
        else if (pluginCfg.lockSweep.enabled === undefined) pluginCfg.lockSweep.enabled = true;
        if (Number.isFinite(lockSweepEverySeconds)) pluginCfg.lockSweep.everySeconds = lockSweepEverySeconds;
        if (Number.isFinite(lockSweepStaleSeconds)) pluginCfg.lockSweep.staleSeconds = lockSweepStaleSeconds;

        conf.plugins.entries.ansible.config = pluginCfg;

        try {
          writeJsonFile(configPath, conf);
        } catch (err: any) {
          console.log(`✗ Failed to write config: ${String(err?.message || err)}`);
          return;
        }

        console.log(`✓ Updated config: ${configPath}`);
        console.log(`  tier=${pluginCfg.tier}`);
        if (pluginCfg.nodeIdOverride) console.log(`  nodeIdOverride=${String(pluginCfg.nodeIdOverride)}`);
        if (pluginCfg.backbonePeers) console.log(`  backbonePeers=${JSON.stringify(pluginCfg.backbonePeers)}`);
        if (pluginCfg.capabilities) console.log(`  capabilities=${JSON.stringify(pluginCfg.capabilities)}`);
        if (pluginCfg.injectContext !== undefined) console.log(`  injectContext=${String(pluginCfg.injectContext)}`);
        if (pluginCfg.injectContextAgents) console.log(`  injectContextAgents=${JSON.stringify(pluginCfg.injectContextAgents)}`);
        if (pluginCfg.dispatchIncoming !== undefined) console.log(`  dispatchIncoming=${String(pluginCfg.dispatchIncoming)}`);
        if (pluginCfg.lockSweep?.enabled !== undefined) console.log(`  lockSweep.enabled=${String(pluginCfg.lockSweep.enabled)}`);
        if (pluginCfg.lockSweep?.everySeconds !== undefined) console.log(`  lockSweep.everySeconds=${String(pluginCfg.lockSweep.everySeconds)}`);
        if (pluginCfg.lockSweep?.staleSeconds !== undefined) console.log(`  lockSweep.staleSeconds=${String(pluginCfg.lockSweep.staleSeconds)}`);

        // 3) Restart gateway to pick up skill/config changes
        if (opts.restart !== false) {
          try {
            console.log("\n- Restarting gateway...");
            runCmd("openclaw", ["gateway", "restart"]);
            console.log("✓ Gateway restarted");
          } catch (err: any) {
            console.log(`✗ Gateway restart failed: ${String(err?.message || err)}`);
            console.log("  You can restart manually: openclaw gateway restart");
            return;
          }
        } else {
          console.log("\n- Skipping gateway restart (--no-restart)");
        }

        console.log("\nNext steps:");
        if (pluginCfg.tier === "backbone") {
          console.log("  openclaw ansible bootstrap");
          console.log("  openclaw ansible invite --tier edge");
        } else {
          console.log("  openclaw ansible join --token <token-from-backbone>");
        }
      });

    // === ansible status ===
    ansible
      .command("status")
      .description("Show status of all hemispheres")
      .action(async () => {
        let result: any;
        try {
          result = await callGateway("ansible_status");
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
          result = await callGateway("ansible_status");
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
          result = await callGateway("ansible_status");
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

    // === ansible messages ===
    ansible
      .command("messages")
      .description("Read messages from other hemispheres")
      .option("-a, --all", "Show all messages (not just unread)")
      .option("-f, --from <nodeId>", "Filter by sender")
      .option("-n, --limit <count>", "Max messages to show", "20")
      .action(async (...args: unknown[]) => {
        const opts = (args[0] || {}) as { all?: boolean; from?: string; limit?: string };

        const toolArgs: Record<string, unknown> = {};
        if (opts.all) toolArgs.all = true;
        if (opts.from) toolArgs.from = opts.from;
        if (opts.limit) toolArgs.limit = parseInt(opts.limit, 10);

        let result: any;
        try {
          result = await callGateway("ansible_read_messages", toolArgs);
        } catch (err: any) {
          console.log(`✗ ${err.message}`);
          return;
        }

        if (result.error) {
          console.log(`✗ ${result.error}`);
          return;
        }

        const messages = result.messages || [];
        console.log(`\n=== Messages (${messages.length} of ${result.total}) ===\n`);

        if (messages.length === 0) {
          console.log("No messages.");
          return;
        }

        for (const msg of messages) {
          const unread = msg.unread ? " [UNREAD]" : "";
          const to = msg.to ? ` → ${msg.to}` : " (broadcast)";
          console.log(`${msg.from}${to}${unread}`);
          console.log(`  ${new Date(msg.timestamp).toLocaleString()}`);
          console.log(`  ${msg.content}`);
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
          result = await callGateway("ansible_send_message", toolArgs);
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
