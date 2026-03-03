#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function run(name, cmd, args, env = {}) {
  const startedAt = Date.now();
  const p = spawnSync(cmd, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const durationMs = Date.now() - startedAt;
  const out = `${p.stdout || ""}${p.stderr || ""}`;
  return {
    name,
    ok: (p.status ?? 1) === 0,
    code: p.status ?? 1,
    durationMs,
    out,
    command: `${cmd} ${args.join(" ")}`,
  };
}

function checkDistArtifacts() {
  const distIndex = path.resolve("dist/index.js");
  const pluginManifest = path.resolve("openclaw.plugin.json");
  const missing = [];
  if (!fs.existsSync(distIndex)) missing.push("dist/index.js");
  if (!fs.existsSync(pluginManifest)) missing.push("openclaw.plugin.json");
  if (missing.length > 0) {
    return {
      name: "artifact-check",
      ok: false,
      code: 1,
      durationMs: 0,
      out: `Missing required artifacts: ${missing.join(", ")}`,
      command: "filesystem check",
    };
  }
  return {
    name: "artifact-check",
    ok: true,
    code: 0,
    durationMs: 0,
    out: "Required deploy artifacts present.",
    command: "filesystem check",
  };
}

const steps = [];
steps.push(run("build", "npm", ["run", "build"]));
if (steps.at(-1).ok) {
  steps.push(run("phase0-parity", "npm", ["run", "test:parity:mvp6"]));
}
if (steps.at(-1)?.ok) {
  steps.push(run("mvp1-snapshot-suite", "npm", ["run", "test:integration:mvp1-industrial"]));
}
if (steps.at(-1)?.ok) {
  steps.push(run("dist-import", "node", ["-e", "import('./dist/index.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"]));
}
steps.push(checkDistArtifacts());

const failed = steps.filter((s) => !s.ok);

console.log("nonprod deploy harness summary");
for (const s of steps) {
  const status = s.ok ? "PASS" : "FAIL";
  console.log(`${status} ${s.name} (${s.durationMs}ms) :: ${s.command}`);
  if (!s.ok) {
    console.log("--- output ---");
    console.log(s.out.trim() || "(no output)");
    console.log("--------------");
  }
}

if (failed.length > 0) {
  console.error(`nonprod deploy harness failed (${failed.length} step(s))`);
  process.exit(1);
}

console.log("nonprod deploy harness passed");
