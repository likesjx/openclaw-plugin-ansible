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
function makeTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function writeJsonFileAtomicWithBackup(filePath, obj) {
    const backupPath = `${filePath}.bak.${makeTimestamp()}`;
    const out = JSON.stringify(obj, null, 2) + "\n";
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tempPath = path.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}`);
    fs.copyFileSync(filePath, backupPath);
    try {
        fs.writeFileSync(tempPath, out, "utf-8");
        fs.renameSync(tempPath, filePath);
    }
    catch (err) {
        try {
            if (fs.existsSync(tempPath))
                fs.unlinkSync(tempPath);
        }
        catch {
            // best effort cleanup
        }
        throw err;
    }
    return { backupPath };
}
function splitCsv(value) {
    return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
function parseCsvOrRepeat(value) {
    if (typeof value === "string")
        return splitCsv(value);
    if (Array.isArray(value)) {
        return value
            .flatMap((v) => (typeof v === "string" ? splitCsv(v) : []))
            .filter(Boolean);
    }
    return [];
}
function parseRepeatedFlagFromArgv(flag) {
    const out = [];
    const argv = process.argv;
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === flag) {
            const next = argv[i + 1];
            if (typeof next === "string" && !next.startsWith("-"))
                out.push(next);
            continue;
        }
        if (token.startsWith(`${flag}=`)) {
            out.push(token.slice(flag.length + 1));
        }
    }
    return out;
}
function parseRepeatableOption(value, flag) {
    const merged = [
        ...parseCsvOrRepeat(value),
        ...parseRepeatedFlagFromArgv(flag).flatMap(splitCsv),
    ];
    return Array.from(new Set(merged));
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
function parseTier(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    if (typeof value !== "string")
        return undefined;
    const v = value.trim();
    if (v === "backbone" || v === "edge")
        return v;
    return undefined;
}
function parseSkillSourceMappings(value, flag = "--source") {
    const specs = parseRepeatableOption(value, flag);
    const out = {};
    for (const specRaw of specs) {
        const spec = specRaw.trim();
        const idx = spec.indexOf("=");
        if (idx <= 0 || idx === spec.length - 1)
            continue;
        const name = spec.slice(0, idx).trim();
        const src = spec.slice(idx + 1).trim();
        if (!name || !src)
            continue;
        out[name] = src;
    }
    return out;
}
function parseSkillNames(value, flag = "--skill", fallback = ["ansible"]) {
    const parsed = parseRepeatableOption(value, flag).map((s) => s.trim()).filter(Boolean);
    return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}
function readOpenClawConfig(configPath) {
    return readJsonFile(configPath);
}
function getAgentWorkspaces(configPath, explicitWorkspaces) {
    const conf = readOpenClawConfig(configPath);
    const fromAgents = Array.isArray(conf?.agents?.list)
        ? conf.agents.list
            .map((a) => (typeof a?.workspace === "string" ? a.workspace : ""))
            .filter(Boolean)
        : [];
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    const defaultWorkspace = path.join(home, ".openclaw", "workspace");
    const merged = Array.from(new Set([...explicitWorkspaces, ...fromAgents, defaultWorkspace]));
    return merged.filter((p) => typeof p === "string" && p.trim().length > 0);
}
function isLikelyGitSource(value) {
    if (!value)
        return false;
    if (/^[a-z]+:\/\//i.test(value))
        return true;
    if (value.startsWith("git@"))
        return true;
    if (/^[^/\s]+\/[^/\s]+$/.test(value))
        return true; // owner/repo shorthand
    return false;
}
function normalizeGitSource(value) {
    if (/^[a-z]+:\/\//i.test(value) || value.startsWith("git@"))
        return value;
    if (/^[^/\s]+\/[^/\s]+$/.test(value))
        return `https://github.com/${value}.git`;
    return value;
}
const DEFAULT_SKILL_GIT_SOURCES = {
    ansible: "https://github.com/likesjx/openclaw-skill-ansible.git",
};
function ensureLocalSkillSource(params) {
    const { skill, requestedSource, sharedRoot, updateSource, dryRun } = params;
    const sourceCandidate = requestedSource?.trim();
    const localPathIfCloned = path.join(sharedRoot, skill);
    if (sourceCandidate && !isLikelyGitSource(sourceCandidate)) {
        const abs = path.resolve(sourceCandidate);
        if (!fs.existsSync(abs)) {
            throw new Error(`Skill source path does not exist for '${skill}': ${abs}`);
        }
        if (!fs.statSync(abs).isDirectory()) {
            throw new Error(`Skill source path is not a directory for '${skill}': ${abs}`);
        }
        if (updateSource && fs.existsSync(path.join(abs, ".git")) && !dryRun) {
            runCmd("git", ["-C", abs, "fetch", "origin"]);
            runCmd("git", ["-C", abs, "pull", "--ff-only"]);
            return { sourcePath: abs, note: "updated local git source" };
        }
        return { sourcePath: abs, note: "using local path source" };
    }
    const gitSource = normalizeGitSource(sourceCandidate || DEFAULT_SKILL_GIT_SOURCES[skill] || "");
    if (!gitSource) {
        throw new Error(`No source provided for skill '${skill}'. Pass --source ${skill}=/path/to/repo or ${skill}=owner/repo`);
    }
    if (!dryRun) {
        ensureGitRepo({
            dir: localPathIfCloned,
            url: gitSource,
            name: `${skill} skill`,
        });
    }
    return {
        sourcePath: localPathIfCloned,
        note: dryRun ? `would clone/update from ${gitSource}` : `synced from ${gitSource}`,
    };
}
function symlinkSkillIntoWorkspace(params) {
    const { workspace, skill, sourcePath, forceReplace, dryRun } = params;
    const skillsDir = path.join(workspace, "skills");
    const target = path.join(skillsDir, skill);
    const sourceReal = path.resolve(sourcePath);
    if (!fs.existsSync(workspace)) {
        return { action: "skipped", detail: `workspace missing: ${workspace}` };
    }
    if (!dryRun)
        mkdirp(skillsDir);
    if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) {
            const current = fs.readlinkSync(target);
            const currentResolved = path.resolve(path.dirname(target), current);
            if (currentResolved === sourceReal) {
                return { action: "already-linked", detail: `${target} -> ${current}` };
            }
            if (!forceReplace) {
                return {
                    action: "skipped",
                    detail: `existing symlink points elsewhere: ${target} -> ${current} (use --force-replace)`,
                };
            }
            if (!dryRun)
                fs.unlinkSync(target);
        }
        else {
            if (!forceReplace) {
                return {
                    action: "skipped",
                    detail: `existing non-symlink at ${target} (use --force-replace)`,
                };
            }
            if (!dryRun) {
                const backup = `${target}.bak.${makeTimestamp()}`;
                fs.renameSync(target, backup);
            }
        }
    }
    if (dryRun) {
        return { action: "would-link", detail: `${target} -> ${sourceReal}` };
    }
    fs.symlinkSync(sourceReal, target, "dir");
    return { action: "linked", detail: `${target} -> ${sourceReal}` };
}
function verifySkillInWorkspace(workspace, skill) {
    const target = path.join(workspace, "skills", skill);
    const skillMd = path.join(target, "SKILL.md");
    if (!fs.existsSync(workspace))
        return { ok: false, detail: `workspace missing: ${workspace}` };
    if (!fs.existsSync(target))
        return { ok: false, detail: `missing path: ${target}` };
    if (!fs.existsSync(skillMd))
        return { ok: false, detail: `missing SKILL.md: ${skillMd}` };
    return { ok: true, detail: `ok: ${skillMd}` };
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
            .option("--lock-sweep-every <seconds>", "Lock sweep interval seconds (default 60)")
            .option("--lock-sweep-stale <seconds>", "Treat stale lock files older than this many seconds as removable (default 300)")
            .option("--no-skill", "Skip installing/updating the companion skill repo")
            .option("--no-restart", "Do not restart the gateway service after changes")
            .option("--dry-run", "Preview setup changes without writing config, updating skill repo, or restarting")
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
            const requestedTier = parseTier(opts.tier);
            if (opts.tier && !requestedTier) {
                console.log(`✗ Invalid tier '${opts.tier}'. Use: backbone or edge.`);
                return;
            }
            const backbonePeers = parseRepeatableOption(opts.backbone, "--backbone");
            const nodeIdOverride = typeof opts.nodeId === "string" && opts.nodeId.trim() ? opts.nodeId.trim() : undefined;
            const capabilities = parseRepeatableOption(opts.capability, "--capability");
            const injectContext = parseBool(opts.injectContext);
            const dispatchIncoming = parseBool(opts.dispatchIncoming);
            const injectAgents = parseRepeatableOption(opts.injectAgent, "--inject-agent");
            const lockSweepEnabled = parseBool(opts.lockSweep);
            const lockSweepEverySeconds = opts.lockSweepEvery ? Number(opts.lockSweepEvery) : undefined;
            const lockSweepStaleSeconds = opts.lockSweepStale ? Number(opts.lockSweepStale) : undefined;
            const dryRun = opts.dryRun === true;
            if (!fs.existsSync(configPath)) {
                console.log(`✗ Config not found at ${configPath}`);
                console.log("  Run `openclaw gateway --dev` (dev) or create ~/.openclaw/openclaw.json first.");
                return;
            }
            console.log("\n=== Ansible Setup ===\n");
            // 1) Ensure companion skill installed
            if (opts.skill !== false && !dryRun) {
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
                if (dryRun && opts.skill !== false) {
                    console.log("- Dry run: would install/update ansible skill repo");
                }
                else {
                    console.log("- Skipping skill install/update (--no-skill)");
                }
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
            const tierRaw = requestedTier || parseTier(pluginCfg.tier) || parseTier(config.tier);
            if (!tierRaw) {
                console.log("✗ tier not set. Use: openclaw ansible setup --tier edge|backbone");
                return;
            }
            const tier = tierRaw;
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
            // Lock sweeper defaults (default-on reliability guard; can still be disabled explicitly)
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
            let backupPath = "";
            if (!dryRun) {
                try {
                    const out = writeJsonFileAtomicWithBackup(configPath, conf);
                    backupPath = out.backupPath;
                }
                catch (err) {
                    console.log(`✗ Failed to write config: ${String(err?.message || err)}`);
                    return;
                }
            }
            if (dryRun) {
                console.log(`✓ Dry run preview for config: ${configPath}`);
            }
            else {
                console.log(`✓ Updated config: ${configPath}`);
                console.log(`  backup=${backupPath}`);
            }
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
            if (opts.restart !== false && !dryRun) {
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
                if (dryRun) {
                    console.log("\n- Dry run: would restart gateway");
                }
                else {
                    console.log("\n- Skipping gateway restart (--no-restart)");
                }
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
        const skillsCmd = ansible.command("skills").description("Manage base ansible skill distribution");
        skillsCmd
            .command("sync")
            .description("Ensure required skills are present in every configured agent workspace")
            .option("--skill <name>", "Skill name (repeatable or comma-separated). Default: ansible")
            .option("--source <spec>", "Skill source mapping (repeatable): <skill>=</path|owner/repo|git-url>")
            .option("--shared-root <dir>", "Directory used for cloned shared skills (default ~/.openclaw/shared-skills)")
            .option("--workspace <path>", "Explicit workspace(s) to include (repeatable or comma-separated)")
            .option("--force-replace", "Replace existing non-symlink or mismatched symlink targets (backs up existing dirs/files)")
            .option("--update-source", "If source is a local git repo, run fetch + pull --ff-only before linking")
            .option("--dry-run", "Preview actions without cloning/updating or writing symlinks")
            .action(async (...args) => {
            const opts = (args[0] || {});
            const home = process.env.HOME || process.env.USERPROFILE;
            if (!home) {
                console.log("✗ Cannot resolve HOME; set $HOME and retry.");
                return;
            }
            const configPath = process.env.OPENCLAW_CONFIG || path.join(home, ".openclaw", "openclaw.json");
            if (!fs.existsSync(configPath)) {
                console.log(`✗ Config not found at ${configPath}`);
                return;
            }
            const dryRun = opts.dryRun === true;
            const forceReplace = opts.forceReplace === true;
            const updateSource = opts.updateSource === true;
            const sharedRoot = path.resolve(typeof opts.sharedRoot === "string" && opts.sharedRoot.trim().length > 0
                ? opts.sharedRoot
                : path.join(home, ".openclaw", "shared-skills"));
            const skills = parseSkillNames(opts.skill, "--skill", ["ansible"]);
            const sourceMap = parseSkillSourceMappings(opts.source, "--source");
            const explicitWorkspaces = parseRepeatableOption(opts.workspace, "--workspace").map((w) => path.resolve(w));
            let workspaces;
            try {
                workspaces = getAgentWorkspaces(configPath, explicitWorkspaces);
            }
            catch (err) {
                console.log(`✗ Failed to read workspaces from config: ${String(err?.message || err)}`);
                return;
            }
            if (workspaces.length === 0) {
                console.log("✗ No workspaces found.");
                return;
            }
            if (dryRun) {
                console.log("=== Dry Run: ansible skills sync ===");
            }
            else {
                console.log("=== ansible skills sync ===");
            }
            console.log(`skills=${JSON.stringify(skills)}`);
            console.log(`workspaces=${workspaces.length}`);
            console.log(`sharedRoot=${sharedRoot}`);
            if (!dryRun)
                mkdirp(sharedRoot);
            const resolvedSources = {};
            let sourceErrors = 0;
            for (const skill of skills) {
                try {
                    const resolved = ensureLocalSkillSource({
                        skill,
                        requestedSource: sourceMap[skill],
                        sharedRoot,
                        updateSource,
                        dryRun,
                    });
                    resolvedSources[skill] = resolved.sourcePath;
                    console.log(`- source ${skill}: ${resolved.note} (${resolved.sourcePath})`);
                }
                catch (err) {
                    sourceErrors += 1;
                    console.log(`✗ source ${skill}: ${String(err?.message || err)}`);
                }
            }
            if (sourceErrors > 0) {
                console.log(`\n✗ Aborting: ${sourceErrors} skill source error(s).`);
                return;
            }
            let linked = 0;
            let already = 0;
            let would = 0;
            let skipped = 0;
            for (const workspace of workspaces) {
                for (const skill of skills) {
                    const out = symlinkSkillIntoWorkspace({
                        workspace,
                        skill,
                        sourcePath: resolvedSources[skill],
                        forceReplace,
                        dryRun,
                    });
                    if (out.action === "linked")
                        linked += 1;
                    if (out.action === "already-linked")
                        already += 1;
                    if (out.action === "would-link")
                        would += 1;
                    if (out.action === "skipped")
                        skipped += 1;
                    const prefix = out.action === "skipped"
                        ? "!"
                        : out.action === "already-linked"
                            ? "="
                            : out.action === "would-link"
                                ? "~"
                                : "+";
                    console.log(`${prefix} [${skill}] ${workspace}: ${out.detail}`);
                }
            }
            console.log("\nSummary:");
            if (dryRun) {
                console.log(`  would-link=${would} already-linked=${already} skipped=${skipped}`);
            }
            else {
                console.log(`  linked=${linked} already-linked=${already} skipped=${skipped}`);
            }
        });
        skillsCmd
            .command("verify")
            .description("Verify required skills are present in each configured agent workspace")
            .option("--skill <name>", "Skill name (repeatable or comma-separated). Default: ansible")
            .option("--workspace <path>", "Explicit workspace(s) to include (repeatable or comma-separated)")
            .action(async (...args) => {
            const opts = (args[0] || {});
            const home = process.env.HOME || process.env.USERPROFILE;
            if (!home) {
                console.log("✗ Cannot resolve HOME; set $HOME and retry.");
                return;
            }
            const configPath = process.env.OPENCLAW_CONFIG || path.join(home, ".openclaw", "openclaw.json");
            if (!fs.existsSync(configPath)) {
                console.log(`✗ Config not found at ${configPath}`);
                return;
            }
            const skills = parseSkillNames(opts.skill, "--skill", ["ansible"]);
            const explicitWorkspaces = parseRepeatableOption(opts.workspace, "--workspace").map((w) => path.resolve(w));
            let workspaces;
            try {
                workspaces = getAgentWorkspaces(configPath, explicitWorkspaces);
            }
            catch (err) {
                console.log(`✗ Failed to read workspaces from config: ${String(err?.message || err)}`);
                return;
            }
            let okCount = 0;
            let failCount = 0;
            console.log("=== ansible skills verify ===");
            for (const workspace of workspaces) {
                for (const skill of skills) {
                    const res = verifySkillInWorkspace(workspace, skill);
                    if (res.ok) {
                        okCount += 1;
                        console.log(`✓ [${skill}] ${workspace}`);
                    }
                    else {
                        failCount += 1;
                        console.log(`✗ [${skill}] ${workspace}: ${res.detail}`);
                    }
                }
            }
            console.log("\nSummary:");
            console.log(`  ok=${okCount} failed=${failCount}`);
            if (failCount > 0) {
                console.log("\nFix with:");
                console.log("  openclaw ansible skills sync --skill ansible --force-replace");
            }
        });
        // === ansible status ===
        ansible
            .command("status")
            .description("Show status of all hemispheres")
            .option("--json", "Output machine-readable JSON")
            .option("--full", "Include lock sweep, agent registry, and unread message preview")
            .option("--stale-after <seconds>", "Override stale node threshold in seconds (default 300)")
            .action(async (...args) => {
            const opts = (args[0] || {});
            const staleAfterSeconds = typeof opts.staleAfter === "string" && Number.isFinite(Number(opts.staleAfter))
                ? Math.max(30, Math.floor(Number(opts.staleAfter)))
                : undefined;
            let result;
            try {
                const statusArgs = {};
                if (typeof staleAfterSeconds === "number")
                    statusArgs.staleAfterSeconds = staleAfterSeconds;
                result = await callGateway("ansible_status", statusArgs);
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (result.error) {
                console.log(`✗ ${result.error}`);
                return;
            }
            // Best-effort: fetch additional status detail.
            let coordination = null;
            try {
                coordination = await callGateway("ansible_get_coordination");
            }
            catch {
                coordination = null;
            }
            let lockSweep = null;
            try {
                lockSweep = await callGateway("ansible_lock_sweep_status");
            }
            catch {
                lockSweep = null;
            }
            let agents = null;
            try {
                agents = await callGateway("ansible_list_agents");
            }
            catch {
                agents = null;
            }
            let unreadPreview = null;
            try {
                unreadPreview = await callGateway("ansible_read_messages", { limit: 10 });
            }
            catch {
                unreadPreview = null;
            }
            if (opts.json) {
                const payload = {
                    status: result,
                    coordination,
                    lockSweep,
                    agents,
                    unreadPreview,
                };
                console.log(JSON.stringify(payload, null, 2));
                return;
            }
            console.log("\n=== Ansible Status ===\n");
            console.log(`My ID: ${result.myId}`);
            console.log(`Tier: ${config.tier}`);
            if (typeof result.staleAfterSeconds === "number") {
                console.log(`Stale threshold: ${result.staleAfterSeconds}s`);
            }
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
            const onlineCount = nodes.filter((n) => n.status === "online").length;
            const busyCount = nodes.filter((n) => n.status === "busy").length;
            const offlineCount = nodes.filter((n) => n.status === "offline").length;
            const staleCount = nodes.filter((n) => n.stale === true).length;
            console.log(`  Summary: online=${onlineCount} busy=${busyCount} offline=${offlineCount} stale=${staleCount}`);
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
            const previewMessages = unreadPreview?.messages || [];
            if (previewMessages.length > 0) {
                console.log("Recent unread:");
                for (const msg of previewMessages.slice(0, 3)) {
                    const to = Array.isArray(msg.to) && msg.to.length > 0 ? ` -> ${msg.to.join(",")}` : " (broadcast)";
                    const snippet = typeof msg.content === "string" ? msg.content.slice(0, 100) : "";
                    console.log(`  - ${msg.from}${to}: ${snippet}`);
                }
                if (previewMessages.length > 3) {
                    console.log(`  ... and ${previewMessages.length - 3} more`);
                }
            }
            if (opts.full) {
                console.log();
                console.log("Lock sweep:");
                if (lockSweep && !lockSweep.error) {
                    console.log(`  enabled=${String(lockSweep.enabled)}`);
                    console.log(`  everySeconds=${String(lockSweep.config?.everySeconds ?? "?")} staleSeconds=${String(lockSweep.config?.staleSeconds ?? "?")}`);
                    const lastAt = typeof lockSweep.lastStatus?.at === "number"
                        ? new Date(lockSweep.lastStatus.at).toLocaleString()
                        : "(never)";
                    console.log(`  lastRun=${lastAt}`);
                    if (lockSweep.lastStatus) {
                        console.log(`  lastCounts found=${lockSweep.lastStatus.found} removed=${lockSweep.lastStatus.removed} kept=${lockSweep.lastStatus.kept} errors=${lockSweep.lastStatus.errors}`);
                    }
                    if (lockSweep.totals) {
                        console.log(`  totals runs=${lockSweep.totals.runs} removed=${lockSweep.totals.removed} errors=${lockSweep.totals.errors}`);
                    }
                }
                else {
                    console.log("  unavailable");
                }
                console.log();
                console.log("Agents:");
                const agentList = agents?.agents || [];
                if (!Array.isArray(agentList) || agentList.length === 0) {
                    console.log("  (none registered)");
                }
                else {
                    const internal = agentList.filter((a) => a.type === "internal");
                    const external = agentList.filter((a) => a.type === "external");
                    console.log(`  total=${agentList.length} internal=${internal.length} external=${external.length}`);
                    for (const a of agentList.slice(0, 8)) {
                        const location = a.gateway ? `gateway:${a.gateway}` : "external/cli";
                        console.log(`  - ${a.id} [${a.type}] (${location})`);
                    }
                    if (agentList.length > 8) {
                        console.log(`  ... and ${agentList.length - 8} more`);
                    }
                }
            }
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
        const tasksCmd = ansible.command("tasks").description("List and manage tasks");
        tasksCmd
            .command("list")
            .description("List tasks (default: all non-completed)")
            .option("-s, --status <status>", "Filter by status (pending|claimed|in_progress|completed|failed)")
            .option("--assigned-to <agentId>", "Filter by assigned agent (e.g., claude-code)")
            .option("--title <text>", "Filter by title substring")
            .option("-n, --limit <count>", "Max results (default 20)", "20")
            .option("--format <fmt>", "Output format: text (default) or json")
            .action(async (...args) => {
            const opts = (args[0] || {});
            const toolArgs = { limit: parseInt(opts.limit || "20", 10) };
            if (opts.status)
                toolArgs.status = opts.status;
            if (opts.assignedTo)
                toolArgs.assignedTo = opts.assignedTo;
            if (opts.title)
                toolArgs.titleContains = opts.title;
            let result;
            try {
                result = await callGateway("ansible_find_task", toolArgs);
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
            const tasks = result.matches || [];
            console.log(`\n=== Tasks (${tasks.length} of ${result.total}) ===\n`);
            if (tasks.length === 0) {
                console.log("No tasks found.");
                return;
            }
            for (const t of tasks) {
                const icon = t.status === "completed" ? "✓" : t.status === "failed" ? "✗" : t.status === "in_progress" ? "▶" : t.status === "claimed" ? "◉" : "○";
                const assignee = t.assignedTo ? ` → ${t.assignedTo}` : "";
                const claimer = t.claimedBy ? ` (${t.claimedBy})` : "";
                const intent = t.intent ? ` [${t.intent}]` : "";
                console.log(`${icon} [${t.id ? t.id.slice(0, 8) : t.key}] ${t.title}${intent}`);
                console.log(`  Status: ${t.status}${assignee}${claimer}`);
                console.log();
            }
        });
        tasksCmd
            .command("claim <taskId>")
            .description("Claim a pending task to work on it")
            .option("--as <agentId>", "Claim as this external agent (e.g., claude-code)")
            .action(async (...args) => {
            const taskId = args[0];
            const opts = (args[1] || {});
            const toolArgs = { taskId };
            if (opts.as)
                toolArgs.agentId = opts.as;
            let result;
            try {
                result = await callGateway("ansible_claim_task", toolArgs);
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (result.error) {
                console.log(`✗ ${result.error}`);
                return;
            }
            console.log(`✓ Claimed: ${result.task?.title}`);
            if (result.task?.description)
                console.log(`\nDescription:\n${result.task.description}`);
            if (result.task?.context)
                console.log(`\nContext:\n${result.task.context}`);
            if (result.task?.intent)
                console.log(`\nIntent: ${result.task.intent}`);
            console.log(`\nNext steps:`);
            console.log(`  openclaw ansible tasks update ${taskId} --status in_progress --note "starting work"${opts.as ? ` --as ${opts.as}` : ""}`);
            console.log(`  openclaw ansible tasks complete ${taskId} --result "..."${opts.as ? ` --as ${opts.as}` : ""}`);
        });
        tasksCmd
            .command("update <taskId>")
            .description("Update a claimed task status or add a progress note")
            .option("--status <status>", "New status: in_progress|failed")
            .option("--note <note>", "Progress note")
            .option("--result <result>", "Result text (useful when status=failed)")
            .option("--notify", "Send update message to task creator")
            .option("--as <agentId>", "Update as this external agent (e.g., claude-code)")
            .action(async (...args) => {
            const taskId = args[0];
            const opts = (args[1] || {});
            if (!opts.status) {
                console.log("✗ --status required (in_progress|failed)");
                return;
            }
            const toolArgs = { taskId, status: opts.status };
            if (opts.note)
                toolArgs.note = opts.note;
            if (opts.result)
                toolArgs.result = opts.result;
            if (opts.notify)
                toolArgs.notify = true;
            if (opts.as)
                toolArgs.agentId = opts.as;
            let result;
            try {
                result = await callGateway("ansible_update_task", toolArgs);
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (result.error) {
                console.log(`✗ ${result.error}`);
                return;
            }
            console.log(`✓ Task updated: status=${opts.status}`);
            if (result.notified)
                console.log(`  Creator notified (messageId: ${result.notifyMessageId})`);
        });
        tasksCmd
            .command("complete <taskId>")
            .description("Mark a claimed task as completed")
            .option("--result <result>", "Result summary (what was done, output, links)")
            .option("--as <agentId>", "Complete as this external agent (e.g., claude-code)")
            .action(async (...args) => {
            const taskId = args[0];
            const opts = (args[1] || {});
            const toolArgs = { taskId };
            if (opts.result)
                toolArgs.result = opts.result;
            if (opts.as)
                toolArgs.agentId = opts.as;
            let result;
            try {
                result = await callGateway("ansible_complete_task", toolArgs);
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (result.error) {
                console.log(`✗ ${result.error}`);
                return;
            }
            console.log(`✓ Task completed.`);
            if (result.notifyMessageId)
                console.log(`  Creator notified (messageId: ${result.notifyMessageId})`);
        });
        // Bare `tasks` (no subcommand) → list pending
        tasksCmd.action(async () => {
            let result;
            try {
                result = await callGateway("ansible_find_task", { status: "pending", limit: 20 });
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (result.error) {
                console.log(`✗ ${result.error}`);
                return;
            }
            const tasks = result.matches || [];
            console.log(`\n=== Pending Tasks (${tasks.length}) ===\n`);
            if (tasks.length === 0) {
                console.log("No pending tasks.");
                return;
            }
            for (const t of tasks) {
                const assignee = t.assignedTo ? ` → ${t.assignedTo}` : "";
                const intent = t.intent ? ` [${t.intent}]` : "";
                console.log(`○ [${t.id ? t.id.slice(0, 8) : t.key}] ${t.title}${intent}${assignee}`);
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
                if (msg.updatedAt) {
                    console.log(`  updated: ${new Date(msg.updatedAt).toLocaleString()}`);
                }
                console.log(`  ${msg.content}`);
                if (msg.metadata && Object.keys(msg.metadata).length > 0) {
                    console.log(`  metadata: ${JSON.stringify(msg.metadata)}`);
                }
                console.log();
            }
        });
        // === ansible messages-delete ===
        ansible
            .command("messages-delete")
            .description("Operator-only emergency message purge (destructive)")
            .option("--id <messageId>", "Message ID to delete (repeatable)")
            .option("--all", "Delete all messages (dangerous)")
            .option("-f, --from <agentId>", "Delete messages from sender agent")
            .option("--conversation-id <id>", "Delete messages matching metadata.conversation_id")
            .option("--before <iso>", "Delete messages older than/equal to ISO timestamp")
            .option("-n, --limit <count>", "Max matches to delete", "200")
            .option("--dry-run", "Preview matches without deleting")
            .option("--reason <text>", "Required operator justification (min 15 chars)")
            .option("--yes", "Required for destructive delete (non-dry-run)")
            .action(async (...args) => {
            const opts = (args[0] || {});
            const messageIds = parseRepeatableOption(opts.id, "--id");
            const hasSelector = opts.all === true ||
                messageIds.length > 0 ||
                !!opts.from ||
                !!opts.conversationId ||
                !!opts.before;
            if (!hasSelector) {
                console.log("✗ Refusing delete without selector. Use --id/--all/--from/--conversation-id/--before.");
                return;
            }
            if (!opts.reason || opts.reason.trim().length < 15) {
                console.log("✗ --reason is required and must be at least 15 characters.");
                return;
            }
            if (opts.dryRun !== true && opts.yes !== true) {
                console.log("✗ Destructive delete requires --yes (or run with --dry-run first).");
                return;
            }
            const toolArgs = {
                confirm: "DELETE_MESSAGES",
                reason: opts.reason.trim(),
            };
            if (messageIds.length > 0)
                toolArgs.messageIds = messageIds;
            if (opts.all)
                toolArgs.all = true;
            if (opts.from)
                toolArgs.from = opts.from;
            if (opts.conversationId)
                toolArgs.conversation_id = opts.conversationId;
            if (opts.before)
                toolArgs.before = opts.before;
            if (opts.limit)
                toolArgs.limit = parseInt(opts.limit, 10);
            if (opts.dryRun)
                toolArgs.dryRun = true;
            let result;
            try {
                result = await callGateway("ansible_delete_messages", toolArgs);
            }
            catch (err) {
                console.log(`✗ ${err.message}`);
                return;
            }
            if (result.error) {
                console.log(`✗ ${result.error}`);
                return;
            }
            if (opts.dryRun) {
                console.log(`✓ Dry run: matched ${result.matched || 0} message(s)`);
            }
            else {
                console.log(`✓ Deleted ${result.deleted || 0} message(s)`);
            }
            if (result.truncated) {
                console.log("! Result truncated by limit");
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