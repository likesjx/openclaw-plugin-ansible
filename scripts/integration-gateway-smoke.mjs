#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function resolveOpenclawBin() {
  const override = (process.env.OPENCLAW_BIN || "").trim();
  if (override) return override;

  const probe = spawnSync("which", ["-a", "openclaw"], { encoding: "utf8", env: process.env });
  const lines = `${probe.stdout || ""}${probe.stderr || ""}`
    .split("\n")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const candidates = Array.from(new Set(lines));

  const preferred = candidates.find((p) => !p.includes("/node_modules/"));
  if (preferred) return preferred;
  return candidates[0] || "openclaw";
}

const OPENCLAW_BIN = resolveOpenclawBin();

function run(cmd, args, { allowFail = false } = {}) {
  const p = spawnSync(cmd, args, { encoding: "utf8", env: process.env });
  const out = `${p.stdout || ""}${p.stderr || ""}`;
  if (p.status !== 0 && !allowFail) {
    throw new Error(`Command failed (${cmd} ${args.join(" ")}):\n${out}`);
  }
  return { status: p.status ?? 1, out };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function parseJsonFromMixedOutput(text) {
  const idx = text.indexOf("{");
  if (idx < 0) throw new Error(`No JSON object found in output:\n${text}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = idx; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  if (end < 0) throw new Error(`Failed to isolate JSON object in output:\n${text}`);
  const candidate = text.slice(idx, end);
  return JSON.parse(candidate);
}

function main() {
  if (process.env.OPENCLAW_INTEGRATION !== "1") {
    console.log("Skipping integration smoke. Set OPENCLAW_INTEGRATION=1 to run.");
    return;
  }

  const actor = process.env.OPENCLAW_ADMIN_ACTOR || "chief-of-staff";
  const mutate = process.env.OPENCLAW_ALLOW_MUTATION === "1";

  console.log("Running integration smoke checks...");
  console.log(`Using openclaw binary: ${OPENCLAW_BIN}`);

  const status = run(OPENCLAW_BIN, ["ansible", "status", "--json"]);
  const payload = parseJsonFromMixedOutput(status.out);
  assert(payload?.coordination, "status --json missing coordination block");
  assert(payload?.status?.myId, "status --json missing myId");

  const adminList = run(OPENCLAW_BIN, ["ansible", "admin", "list"]);
  assert(
    adminList.out.includes("Gateway Admins") || adminList.out.includes("No explicit gateway admin"),
    "admin list output did not match expected shape"
  );

  const agentList = run(OPENCLAW_BIN, ["ansible", "agent", "list"]);
  assert(agentList.out.includes("Registered Agents"), "agent list output missing header");

  const seedDry = run(OPENCLAW_BIN, ["ansible", "admin", "seed", "--dry-run", "--as", actor], { allowFail: true });
  assert(
    seedDry.status === 0 || seedDry.out.includes("agent_token is required"),
    "admin seed dry-run failed unexpectedly"
  );

  if (mutate) {
    const dist = run(OPENCLAW_BIN, ["ansible", "admin", "distribution", "--external-mode", "strict", "--as", actor], {
      allowFail: true,
    });
    assert(
      dist.status === 0 || dist.out.includes("agent_token is required"),
      "distribution policy mutation failed unexpectedly"
    );
  }

  console.log("Integration smoke checks passed.");
}

try {
  main();
} catch (err) {
  console.error(String(err?.stack || err));
  process.exit(1);
}
