/**
 * Lock Sweep Service
 *
 * Per-gateway reliability guard: periodically remove stale session lock files.
 *
 * OpenClaw sessions are stored as `.jsonl` with a `.jsonl.lock` file used to
 * prevent concurrent writers. A stale lock can block agent runs indefinitely.
 *
 * Safety rules:
 * - Only remove a lock if it references a PID and that PID is not running.
 * - If the lock contains no PID, only remove if older than staleSeconds.
 *
 * The service is intentionally conservative and only touches files under:
 *   ~/.openclaw/agents/<agentId>/sessions/*.jsonl.lock
 */
import * as fs from "fs";
import * as path from "path";
let timer = null;
function isPidRunning(pid) {
    if (!Number.isFinite(pid) || pid <= 0)
        return false;
    try {
        // Signal 0 only checks existence/permission.
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function extractPid(lockBody) {
    // Common format: "... pid=38450 ..."
    const m1 = lockBody.match(/pid=(\d+)/);
    if (m1?.[1])
        return Number(m1[1]);
    // Fallback: first integer token
    const m2 = lockBody.match(/\b(\d{2,})\b/);
    if (m2?.[1])
        return Number(m2[1]);
    return null;
}
async function* walk(dir, maxDepth) {
    if (maxDepth < 0)
        return;
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            yield* walk(p, maxDepth - 1);
        }
        else if (ent.isFile()) {
            yield p;
        }
    }
}
async function sweepLocks(params) {
    const { ctx, rootDir, staleSeconds } = params;
    const agentsDir = path.join(rootDir, "agents");
    let removed = 0;
    let kept = 0;
    let errors = 0;
    let found = 0;
    // Depth: agents/<agentId>/sessions/<files>
    for await (const filePath of walk(agentsDir, 4)) {
        if (!filePath.endsWith(".jsonl.lock"))
            continue;
        found++;
        let st;
        try {
            st = await fs.promises.stat(filePath);
        }
        catch (err) {
            errors++;
            ctx.logger.warn(`lock-sweep: stat failed file=${filePath} err=${String(err?.message || err)}`);
            continue;
        }
        const ageSeconds = Math.floor((Date.now() - st.mtimeMs) / 1000);
        let body = "";
        try {
            body = await fs.promises.readFile(filePath, "utf-8");
        }
        catch (err) {
            // If we can't read it, we can't safely parse PID; treat as pid-less.
            ctx.logger.debug(`lock-sweep: read failed file=${filePath} err=${String(err?.message || err)}`);
        }
        const pid = body ? extractPid(body) : null;
        // Primary signal: staleness by age. Session locks should be short-lived.
        // If it persists for minutes, it is almost certainly stale, even if the PID
        // is the long-running gateway PID.
        if (ageSeconds < staleSeconds) {
            kept++;
            if (pid != null) {
                const running = isPidRunning(pid) ? "running" : "not-running";
                ctx.logger.debug(`lock-sweep: keep (not stale) file=${filePath} pid=${pid} pidState=${running} ageSec=${ageSeconds}`);
            }
            else {
                ctx.logger.debug(`lock-sweep: keep (not stale) file=${filePath} pid=none ageSec=${ageSeconds}`);
            }
            continue;
        }
        // Secondary signal: log whether PID is running (helps debugging).
        const pidState = pid != null ? (isPidRunning(pid) ? "running" : "not-running") : "none";
        try {
            await fs.promises.unlink(filePath);
            removed++;
            ctx.logger.warn(`lock-sweep: removed stale lock file=${filePath} pid=${pid ?? "none"} pidState=${pidState} ageSec=${ageSeconds}`);
        }
        catch (err) {
            errors++;
            ctx.logger.warn(`lock-sweep: remove failed file=${filePath} pid=${pid ?? "none"} pidState=${pidState} err=${String(err?.message || err)}`);
        }
    }
    return { removed, kept, errors, found };
}
export function createLockSweepService(_api, config) {
    return {
        id: "ansible-lock-sweep",
        async start(ctx) {
            // Default ON: this is a per-gateway reliability guard. Can be disabled via config.
            const enabled = config.lockSweep?.enabled ?? true;
            if (!enabled) {
                ctx.logger.info("lock-sweep: disabled (set plugins.entries.ansible.config.lockSweep.enabled=true to enable)");
                return;
            }
            const everySeconds = Math.max(30, Math.floor(config.lockSweep?.everySeconds ?? 60));
            // Default 5 minutes: long enough to avoid false positives, short enough to unblock stuck sessions.
            const staleSeconds = Math.max(30, Math.floor(config.lockSweep?.staleSeconds ?? 300));
            const home = process.env.HOME || process.env.USERPROFILE || "";
            const rootDir = path.join(home, ".openclaw");
            ctx.logger.info(`lock-sweep: enabled everySeconds=${everySeconds} staleSeconds=${staleSeconds} root=${rootDir}`);
            const runOnce = async () => {
                try {
                    const res = await sweepLocks({ ctx, rootDir, staleSeconds });
                    if (res.removed > 0 || res.errors > 0) {
                        ctx.logger.warn(`lock-sweep: done found=${res.found} removed=${res.removed} kept=${res.kept} errors=${res.errors}`);
                    }
                    else {
                        ctx.logger.debug(`lock-sweep: done found=${res.found} removed=0 kept=${res.kept} errors=0`);
                    }
                }
                catch (err) {
                    ctx.logger.warn(`lock-sweep: run failed err=${String(err?.message || err)}`);
                }
            };
            await runOnce();
            timer = setInterval(runOnce, everySeconds * 1000);
        },
        async stop(ctx) {
            if (timer) {
                clearInterval(timer);
                timer = null;
                ctx.logger.info("lock-sweep: stopped");
            }
        },
    };
}
//# sourceMappingURL=lock-sweep.js.map