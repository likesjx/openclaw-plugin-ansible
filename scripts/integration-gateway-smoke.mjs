#!/usr/bin/env node
import { spawnSync } from "node:child_process";

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
  const candidate = text.slice(idx).trim();
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

  const status = run("openclaw", ["ansible", "status", "--json"]);
  const payload = parseJsonFromMixedOutput(status.out);
  assert(payload?.coordination, "status --json missing coordination block");
  assert(payload?.status?.myId, "status --json missing myId");

  const adminList = run("openclaw", ["ansible", "admin", "list"]);
  assert(
    adminList.out.includes("Gateway Admins") || adminList.out.includes("No explicit gateway admin"),
    "admin list output did not match expected shape"
  );

  const agentList = run("openclaw", ["ansible", "agent", "list"]);
  assert(agentList.out.includes("Registered Agents"), "agent list output missing header");

  const seedDry = run("openclaw", ["ansible", "admin", "seed", "--dry-run", "--as", actor], { allowFail: true });
  assert(
    seedDry.status === 0 || seedDry.out.includes("agent_token is required"),
    "admin seed dry-run failed unexpectedly"
  );

  if (mutate) {
    const dist = run("openclaw", ["ansible", "admin", "distribution", "--external-mode", "strict", "--as", actor], {
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
