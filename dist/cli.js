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
import { getNodeId } from "./service.js";
import { generateInviteToken, joinWithToken, bootstrapFirstNode, revokeNode, } from "./auth.js";
function readGatewayConfig() {
    // Resolve config path: $OPENCLAW_CONFIG or ~/.openclaw/openclaw.json
    const configPath = process.env.OPENCLAW_CONFIG ||
        path.join(process.env.HOME || process.env.USERPROFILE || ".", ".openclaw", "openclaw.json");
    let raw;
    try {
        raw = fs.readFileSync(configPath, "utf-8");
    }
    catch {
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
async function callGateway(tool, args = {}) {
    const { port, token } = readGatewayConfig();
    const url = `http://127.0.0.1:${port}/tools/invoke`;
    let res;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ tool, args }),
        });
    }
    catch (err) {
        throw new Error(`Gateway not running on port ${port} (${err.cause?.code || err.message})`);
    }
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (res.status === 401 || res.status === 403) {
            throw new Error("Authentication failed — check gateway.auth.token in config");
        }
        throw new Error(`Gateway returned ${res.status}: ${body}`);
    }
    const json = await res.json();
    // Gateway wraps tool results in { ok, result } or { error }
    if (json.error) {
        throw new Error(json.error.message || JSON.stringify(json.error));
    }
    // Newer gateways wrap tool results as an AgentToolResult:
    //   { content: [...], details: {...} }
    // Older gateways may return the raw object directly.
    const result = json.result ?? json;
    if (result && typeof result === "object" && "details" in result) {
        return result.details;
    }
    return result;
}
// ---------------------------------------------------------------------------
// Setup helpers (idempotent local provisioning)
// ---------------------------------------------------------------------------
function mkdirp(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
function runCmd(bin, args, opts) {
    execFileSync(bin, args, {
        cwd: opts?.cwd,
        stdio: "inherit",
        env: process.env,
    });
}
function ensureGitRepo(params) {
    const { dir, url, name } = params;
    if (!fs.existsSync(dir)) {
        mkdirp(path.dirname(dir));
        console.log(`- Cloning ${name}: ${url} -> ${dir}`);
        runCmd("git", ["clone", url, dir]);
        return;
    }
    const gitDir = path.join(dir, ".git");
    if (!fs.existsSync(gitDir)) {
        throw new Error(`${name} exists at ${dir} but is not a git repo (missing .git). Move it aside or remove it.`);
    }
    console.log(`- Updating ${name}: ${dir}`);
    runCmd("git", ["-C", dir, "fetch", "origin"]);
    runCmd("git", ["-C", dir, "pull", "--ff-only"]);
}
function readJsonFile(filePath) {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
}
function writeJsonFile(filePath, obj) {
    const out = JSON.stringify(obj, null, 2) + "\n";
    fs.writeFileSync(filePath, out, "utf-8");
}
function parseCsvOrRepeat(value) {
    if (typeof value !== "string")
        return [];
    return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
function parseBool(value) {
    if (typeof value !== "string")
        return undefined;
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return undefined;
}
export function registerAnsibleCli(api, config) {
    api.registerCli?.(({ program }) => {
        const ansible = program.command("ansible").description("Ansible coordination layer");
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
            .action(async (...args) => {
            const opts = (args[0] || {});
            const home = process.env.HOME || process.env.USERPROFILE;
            if (!home) {
                console.log("✗ Cannot resolve HOME; set $HOME and retry.");
                return;
            }
            const openclawDir = path.join(home, ".openclaw");
            const workspaceDir = path.join(openclawDir, "workspace");
            const skillsDir = path.join(workspaceDir, "skills");
            const configPath = process.env.OPENCLAW_CONFIG || path.join(openclawDir, "openclaw.json");
            const requestedTier = opts.tier;
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
                }
                catch (err) {
                    console.log(`✗ Skill setup failed: ${String(err?.message || err)}`);
                    return;
                }
            }
            else {
                console.log("- Skipping skill install/update (--no-skill)");
            }
            // 2) Patch config
            let conf;
            try {
                conf = readJsonFile(configPath);
            }
            catch (err) {
                console.log(`✗ Failed to read config: ${String(err?.message || err)}`);
                return;
            }
            conf.plugins = conf.plugins || {};
            conf.plugins.entries = conf.plugins.entries || {};
            conf.plugins.entries.ansible = conf.plugins.entries.ansible || { enabled: true, config: {} };
            conf.plugins.entries.ansible.enabled = true;
            const pluginCfg = conf.plugins.entries.ansible.config || {};
            // Tier + backbone peers
            const tier = requestedTier || pluginCfg.tier || config.tier;
            if (!tier) {
                console.log("✗ tier not set. Use: openclaw ansible setup --tier edge|backbone");
                return;
            }
            pluginCfg.tier = tier;
            if (nodeIdOverride)
                pluginCfg.nodeIdOverride = nodeIdOverride;
            if (tier === "edge") {
                if (backbonePeers.length > 0) {
                    pluginCfg.backbonePeers = backbonePeers;
                }
                else if (!Array.isArray(pluginCfg.backbonePeers) || pluginCfg.backbonePeers.length === 0) {
                    console.log("✗ edge nodes require --backbone ws://<host>:1235 (or backbonePeers already set in config).");
                    return;
                }
            }
            if (capabilities.length > 0) {
                // Merge + de-dupe
                const merged = new Set([...(pluginCfg.capabilities || []), ...capabilities].map(String));
                pluginCfg.capabilities = Array.from(merged);
            }
            if (injectContext !== undefined)
                pluginCfg.injectContext = injectContext;
            if (dispatchIncoming !== undefined)
                pluginCfg.dispatchIncoming = dispatchIncoming;
            if (injectAgents.length > 0) {
                const merged = new Set([...(pluginCfg.injectContextAgents || []), ...injectAgents].map(String));
                pluginCfg.injectContextAgents = Array.from(merged);
            }
            // Lock sweeper defaults (opt-in via setup; can still be disabled explicitly)
            pluginCfg.lockSweep = pluginCfg.lockSweep || {};
            if (lockSweepEnabled !== undefined)
                pluginCfg.lockSweep.enabled = lockSweepEnabled;
            else if (pluginCfg.lockSweep.enabled === undefined)
                pluginCfg.lockSweep.enabled = true;
            if (Number.isFinite(lockSweepEverySeconds))
                pluginCfg.lockSweep.everySeconds = lockSweepEverySeconds;
            if (Number.isFinite(lockSweepStaleSeconds))
                pluginCfg.lockSweep.staleSeconds = lockSweepStaleSeconds;
            conf.plugins.entries.ansible.config = pluginCfg;
            try {
                writeJsonFile(configPath, conf);
            }
            catch (err) {
                console.log(`✗ Failed to write config: ${String(err?.message || err)}`);
                return;
            }
            console.log(`✓ Updated config: ${configPath}`);
            console.log(`  tier=${pluginCfg.tier}`);
            if (pluginCfg.nodeIdOverride)
                console.log(`  nodeIdOverride=${String(pluginCfg.nodeIdOverride)}`);
            if (pluginCfg.backbonePeers)
                console.log(`  backbonePeers=${JSON.stringify(pluginCfg.backbonePeers)}`);
            if (pluginCfg.capabilities)
                console.log(`  capabilities=${JSON.stringify(pluginCfg.capabilities)}`);
            if (pluginCfg.injectContext !== undefined)
                console.log(`  injectContext=${String(pluginCfg.injectContext)}`);
            if (pluginCfg.injectContextAgents)
                console.log(`  injectContextAgents=${JSON.stringify(pluginCfg.injectContextAgents)}`);
            if (pluginCfg.dispatchIncoming !== undefined)
                console.log(`  dispatchIncoming=${String(pluginCfg.dispatchIncoming)}`);
            if (pluginCfg.lockSweep?.enabled !== undefined)
                console.log(`  lockSweep.enabled=${String(pluginCfg.lockSweep.enabled)}`);
            if (pluginCfg.lockSweep?.everySeconds !== undefined)
                console.log(`  lockSweep.everySeconds=${String(pluginCfg.lockSweep.everySeconds)}`);
            if (pluginCfg.lockSweep?.staleSeconds !== undefined)
                console.log(`  lockSweep.staleSeconds=${String(pluginCfg.lockSweep.staleSeconds)}`);
            // 3) Restart gateway to pick up skill/config changes
            if (opts.restart !== false) {
                try {
                    console.log("\n- Restarting gateway...");
                    runCmd("openclaw", ["gateway", "restart"]);
                    console.log("✓ Gateway restarted");
                }
                catch (err) {
                    console.log(`✗ Gateway restart failed: ${String(err?.message || err)}`);
                    console.log("  You can restart manually: openclaw gateway restart");
                    return;
                }
            }
            else {
                console.log("\n- Skipping gateway restart (--no-restart)");
            }
            console.log("\nNext steps:");
            if (pluginCfg.tier === "backbone") {
                console.log("  openclaw ansible bootstrap");
                console.log("  openclaw ansible invite --tier edge");
            }
            else {
                console.log("  openclaw ansible join --token <token-from-backbone>");
            }
        });
        // === ansible status ===
        ansible
            .command("status")
            .description("Show status of all hemispheres")
            .action(async () => {
            let result;
            try {
                result = await callGateway("ansible_status");
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (result.error) {
                console.log(`✗ ${result.error}`);
                return;
            }
            // Best-effort: fetch coordination config (includes retention knobs).
            let coordination = null;
            try {
                coordination = await callGateway("ansible_get_coordination");
            }
            catch {
                coordination = null;
            }
            console.log("\n=== Ansible Status ===\n");
            console.log(`My ID: ${result.myId}`);
            console.log(`Tier: ${config.tier}`);
            console.log();
            if (coordination && !coordination.error) {
                const coordinator = coordination.coordinator ? String(coordination.coordinator) : "(unset)";
                const sweepEvery = coordination.sweepEverySeconds ? String(coordination.sweepEverySeconds) : "(unset)";
                const retentionDays = typeof coordination.retentionClosedTaskSeconds === "number"
                    ? String(Math.round(coordination.retentionClosedTaskSeconds / 86400))
                    : "(default 7)";
                const pruneHours = typeof coordination.retentionPruneEverySeconds === "number"
                    ? String(Math.round(coordination.retentionPruneEverySeconds / 3600))
                    : "(default 24)";
                const lastPrune = typeof coordination.retentionLastPruneAt === "number"
                    ? new Date(coordination.retentionLastPruneAt).toLocaleString()
                    : "(never)";
                const delegationVersion = typeof coordination.delegationPolicyVersion === "string"
                    ? coordination.delegationPolicyVersion
                    : "(unset)";
                const delegationChecksum = typeof coordination.delegationPolicyChecksum === "string"
                    ? coordination.delegationPolicyChecksum
                    : "(unset)";
                console.log("Coordinator:");
                console.log(`  id: ${coordinator}`);
                console.log(`  sweepEverySeconds: ${sweepEvery}`);
                console.log("Delegation Policy:");
                console.log(`  version: ${delegationVersion}`);
                console.log(`  checksum: ${delegationChecksum}`);
                console.log("Retention (coordinator-only roll-off):");
                console.log(`  closedTaskRetentionDays: ${retentionDays}`);
                console.log(`  pruneEveryHours: ${pruneHours}`);
                console.log(`  lastPruneAt: ${lastPrune}`);
                console.log();
            }
            // Nodes
            console.log("Hemispheres:");
            const nodes = result.nodes || [];
            if (nodes.length === 0) {
                console.log("  (no nodes online)");
            }
            for (const node of nodes) {
                const isMe = node.id === result.myId ? " (me)" : "";
                const focus = node.currentFocus ? ` - ${node.currentFocus}` : "";
                const stale = node.stale === true;
                const icon = node.status === "online" ? "●" : "○";
                const staleTag = stale ? " [STALE]" : "";
                const age = typeof node.ageSeconds === "number" ? ` (${node.ageSeconds}s ago)` : "";
                console.log(`  ${icon} ${node.id}${isMe}${focus}${staleTag}`);
                console.log(`    Status: ${node.status}${age}`);
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
        // === ansible retention ===
        const retention = ansible.command("retention").description("Coordinator retention / roll-off");
        retention
            .command("set")
            .description("Set closed task roll-off policy (coordinator-only)")
            .option("--closed-days <days>", "Delete completed/failed tasks older than N days (default 7)")
            .option("--every-hours <hours>", "Run prune every N hours (default 24)")
            .action(async (...args) => {
            const opts = (args[0] || {});
            const toolArgs = {};
            if (opts.closedDays)
                toolArgs.closedTaskRetentionDays = Number(opts.closedDays);
            if (opts.everyHours)
                toolArgs.pruneEveryHours = Number(opts.everyHours);
            let out;
            try {
                out = await callGateway("ansible_set_retention", toolArgs);
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (out.error) {
                console.log(`✗ ${out.error}`);
                return;
            }
            const days = typeof out.retentionClosedTaskSeconds === "number" ? Math.round(out.retentionClosedTaskSeconds / 86400) : "?";
            const hours = typeof out.retentionPruneEverySeconds === "number" ? Math.round(out.retentionPruneEverySeconds / 3600) : "?";
            console.log("✓ Updated retention policy");
            console.log(`  closedTaskRetentionDays=${days}`);
            console.log(`  pruneEveryHours=${hours}`);
        });
        // === ansible delegation ===
        const delegation = ansible.command("delegation").description("Delegation policy distribution + ACK");
        delegation
            .command("show")
            .description("Show current shared delegation policy and ACK status")
            .action(async () => {
            let out;
            try {
                out = await callGateway("ansible_get_delegation_policy");
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (out.error) {
                console.log(`✗ ${out.error}`);
                return;
            }
            console.log("\n=== Delegation Policy ===\n");
            console.log(`Version: ${out.delegationPolicyVersion || "(unset)"}`);
            console.log(`Checksum: ${out.delegationPolicyChecksum || "(unset)"}`);
            if (out.delegationPolicyUpdatedAt) {
                console.log(`Updated: ${new Date(out.delegationPolicyUpdatedAt).toLocaleString()} by ${out.delegationPolicyUpdatedBy || "unknown"}`);
            }
            const acks = out.acks || {};
            const ids = Object.keys(acks);
            console.log(`ACKs: ${ids.length}`);
            for (const id of ids.sort()) {
                const r = acks[id] || {};
                const at = typeof r.at === "number" ? new Date(r.at).toLocaleString() : "unknown";
                console.log(`  - ${id}: ${r.version || "?"} ${r.checksum || "?"} @ ${at}`);
            }
        });
        delegation
            .command("set")
            .description("Publish delegation policy markdown (coordinator-only)")
            .option("--file <path>", "Path to policy markdown file")
            .option("--version <ver>", "Policy version, e.g. 2026-02-12.1")
            .option("--checksum <sum>", "Optional checksum (otherwise computed)")
            .option("--notify <agents>", "Comma-separated target agent ids to notify")
            .action(async (...args) => {
            const opts = (args[0] || {});
            if (!opts.file || !opts.version) {
                console.log("✗ --file and --version are required");
                return;
            }
            let policyMarkdown;
            try {
                policyMarkdown = fs.readFileSync(String(opts.file), "utf-8");
            }
            catch (err) {
                console.log(`✗ Failed to read file: ${String(err?.message || err)}`);
                return;
            }
            const toolArgs = {
                policyMarkdown,
                version: opts.version,
            };
            if (opts.checksum)
                toolArgs.checksum = opts.checksum;
            if (opts.notify)
                toolArgs.notifyAgents = parseCsvOrRepeat(opts.notify);
            let out;
            try {
                out = await callGateway("ansible_set_delegation_policy", toolArgs);
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (out.error) {
                console.log(`✗ ${out.error}`);
                return;
            }
            console.log("✓ Delegation policy published");
            console.log(`  version=${out.delegationPolicyVersion}`);
            console.log(`  checksum=${out.delegationPolicyChecksum}`);
            const notified = Array.isArray(out.notifiedAgents) ? out.notifiedAgents : [];
            if (notified.length > 0)
                console.log(`  notified=${notified.join(",")}`);
        });
        delegation
            .command("ack")
            .description("Acknowledge the current (or provided) delegation policy")
            .option("--version <ver>", "Optional version override")
            .option("--checksum <sum>", "Optional checksum override")
            .action(async (...args) => {
            const opts = (args[0] || {});
            const toolArgs = {};
            if (opts.version)
                toolArgs.version = opts.version;
            if (opts.checksum)
                toolArgs.checksum = opts.checksum;
            let out;
            try {
                out = await callGateway("ansible_ack_delegation_policy", toolArgs);
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (out.error) {
                console.log(`✗ ${out.error}`);
                return;
            }
            console.log("✓ Delegation policy acknowledged");
            console.log(`  agent=${out.agentId}`);
            console.log(`  version=${out.version}`);
            console.log(`  checksum=${out.checksum}`);
        });
        // === ansible nodes ===
        ansible
            .command("nodes")
            .description("List authorized nodes")
            .action(async () => {
            let result;
            try {
                result = await callGateway("ansible_status");
            }
            catch (err) {
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
            .action(async (...args) => {
            const opts = (args[0] || {});
            let result;
            try {
                result = await callGateway("ansible_status");
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (result.error) {
                console.log(`✗ ${result.error}`);
                return;
            }
            console.log("\n=== Tasks ===\n");
            // The status tool only returns pending tasks; display what we have
            const tasks = result.pendingTasks || [];
            if (tasks.length === 0) {
                console.log("No pending tasks.");
                return;
            }
            for (const task of tasks) {
                // If caller filtered by status and this doesn't match, skip
                if (opts.status && opts.status !== "pending")
                    continue;
                const assignee = task.assignedTo && task.assignedTo !== "anyone" ? ` → ${task.assignedTo}` : "";
                console.log(`○ [${task.id}] ${task.title}${assignee}`);
                console.log(`  Status: pending`);
                console.log();
            }
        });
        // === ansible messages ===
        ansible
            .command("messages")
            .description("Read messages from other agents")
            .option("-a, --all", "Show all messages (not just unread)")
            .option("-f, --from <agentId>", "Filter by sender agent")
            .option("--agent <agentId>", "Read as this agent (for external agents polling their inbox)")
            .option("--conversation-id <id>", "Filter by conversation ID")
            .option("-n, --limit <count>", "Max messages to show", "20")
            .option("--format <fmt>", "Output format: text (default) or json")
            .action(async (...args) => {
            const opts = (args[0] || {});
            const toolArgs = {};
            if (opts.all)
                toolArgs.all = true;
            if (opts.from)
                toolArgs.from = opts.from;
            if (opts.agent)
                toolArgs.agent = opts.agent;
            if (opts.conversationId)
                toolArgs.conversation_id = opts.conversationId;
            if (opts.limit)
                toolArgs.limit = parseInt(opts.limit, 10);
            let result;
            try {
                result = await callGateway("ansible_read_messages", toolArgs);
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (result.error) {
                console.log(`✗ ${result.error}`);
                return;
            }
            if (opts.format === "json") {
                console.log(JSON.stringify(result, null, 2));
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
                const to = msg.to?.length ? ` → ${msg.to.join(", ")}` : " (broadcast)";
                const meta = msg.metadata ? ` [${msg.metadata.kind || ""}${msg.metadata.conversation_id ? ` conv:${msg.metadata.conversation_id}` : ""}]` : "";
                console.log(`${msg.from}${to}${unread}${meta}`);
                console.log(`  ${new Date(msg.timestamp).toLocaleString()}`);
                console.log(`  ${msg.content}`);
                if (msg.metadata && Object.keys(msg.metadata).length > 0) {
                    console.log(`  metadata: ${JSON.stringify(msg.metadata)}`);
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
            }
            else {
                console.log(`✗ Bootstrap failed: ${result.error}`);
            }
        });
        // === ansible invite ===
        ansible
            .command("invite")
            .description("Generate an invite token for a new node")
            .option("-t, --tier <tier>", "Node tier: backbone or edge", "edge")
            .action(async (...args) => {
            const opts = (args[0] || { tier: "edge" });
            const tier = opts.tier;
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
            .action(async (...args) => {
            const opts = (args[0] || {});
            if (!opts.token) {
                console.log("✗ Token required. Use: openclaw ansible join --token <token>");
                return;
            }
            const result = joinWithToken(opts.token, config.capabilities);
            if (result.success) {
                console.log("✓ Successfully joined the Ansible network");
                console.log(`  Node ID: ${getNodeId()}`);
                console.log(`  Tier: ${config.tier}`);
            }
            else {
                console.log(`✗ Failed to join: ${result.error}`);
            }
        });
        // === ansible revoke ===
        ansible
            .command("revoke")
            .description("Revoke a node's access")
            .option("-n, --node <nodeId>", "Node ID to revoke")
            .action(async (...args) => {
            const opts = (args[0] || {});
            if (!opts.node) {
                console.log("✗ Node ID required. Use: openclaw ansible revoke --node <nodeId>");
                return;
            }
            const result = revokeNode(opts.node);
            if (result.success) {
                console.log(`✓ Revoked access for ${opts.node}`);
            }
            else {
                console.log(`✗ Failed to revoke: ${result.error}`);
            }
        });
        // === ansible send ===
        ansible
            .command("send")
            .description("Send a message to one or more agents (broadcast if no --to given)")
            .option("-m, --message <message>", "Message content")
            .option("-t, --to <agentId>", "Target agent (repeatable for multiple recipients)")
            .option("--from <agentId>", "Send as this agent (required for external agents)")
            .option("--conversation-id <id>", "Conversation thread ID (required for threading)")
            .option("--kind <kind>", "Message kind: proposal, status, result, alert, decision")
            .option("--metadata <json>", "Additional metadata as JSON object")
            .option("--broadcast", "Explicitly broadcast to all agents (same as omitting --to)")
            .action(async (...args) => {
            const opts = (args[0] || {});
            if (!opts.message) {
                console.log("✗ Message required. Use: openclaw ansible send --message 'your message'");
                return;
            }
            // Build to_agents array (--to is repeatable)
            const toAgents = opts.broadcast
                ? []
                : Array.isArray(opts.to)
                    ? opts.to
                    : opts.to
                        ? [opts.to]
                        : [];
            // Build metadata
            let extraMeta = {};
            if (opts.metadata) {
                try {
                    extraMeta = JSON.parse(opts.metadata);
                }
                catch {
                    console.log("✗ --metadata must be valid JSON");
                    return;
                }
            }
            const metadata = {
                ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
                ...(opts.kind ? { kind: opts.kind } : {}),
                ...extraMeta,
            };
            const toolArgs = { content: opts.message };
            if (toAgents.length > 0)
                toolArgs.to = toAgents.join(",");
            if (opts.from)
                toolArgs.from_agent = opts.from;
            if (Object.keys(metadata).length > 0)
                toolArgs.metadata = metadata;
            let result;
            try {
                result = await callGateway("ansible_send_message", toolArgs);
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (result.error) {
                console.log(`✗ ${result.error}`);
                return;
            }
            if (toAgents.length > 0) {
                console.log(`✓ Message sent to ${toAgents.join(", ")}`);
            }
            else {
                console.log("✓ Message broadcast to all agents");
            }
        });
        // === ansible agent ===
        const agentCmd = ansible.command("agent").description("Manage agent registry");
        agentCmd
            .command("register")
            .description("Register an external agent in the ansible network")
            .option("--id <agentId>", "Agent ID (e.g., claude, codex)")
            .option("--name <name>", "Display name (e.g., Claude)")
            .action(async (...args) => {
            const opts = (args[0] || {});
            if (!opts.id) {
                console.log("✗ Agent ID required. Use: openclaw ansible agent register --id claude");
                return;
            }
            const result = await callGateway("ansible_register_agent", {
                agent_id: opts.id,
                name: opts.name,
                type: "external",
            });
            if (result.error) {
                console.log(`✗ ${result.error}`);
                return;
            }
            console.log(`✓ Agent "${opts.id}" registered as external${opts.name ? ` (${opts.name})` : ""}`);
            console.log(`  Pull inbox: openclaw ansible messages --agent ${opts.id} --unread`);
            console.log(`  Send:       openclaw ansible send --from ${opts.id} --to <target> --message "..."`);
        });
        agentCmd
            .command("list")
            .description("List all registered agents")
            .action(async () => {
            const result = await callGateway("ansible_list_agents", {});
            if (result.error) {
                console.log(`✗ ${result.error}`);
                return;
            }
            const agents = result.agents || [];
            console.log(`\n=== Registered Agents (${agents.length}) ===\n`);
            if (agents.length === 0) {
                console.log("No agents registered.");
                return;
            }
            for (const a of agents) {
                const location = a.gateway ? `gateway:${a.gateway}` : "external/cli";
                console.log(`  ${a.id} [${a.type}] — ${a.name || a.id} (${location})`);
            }
        });
    }, { commands: ["ansible"] });
}
//# sourceMappingURL=cli.js.map