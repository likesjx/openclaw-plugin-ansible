#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function run(args, expectCode = 0) {
  const p = spawnSync("node", args, { encoding: "utf8", env: process.env });
  const out = `${p.stdout || ""}${p.stderr || ""}`;
  if ((p.status ?? 1) !== expectCode) {
    throw new Error(`Unexpected exit code for node ${args.join(" ")}. expected=${expectCode} got=${p.status}\n${out}`);
  }
  return out;
}

function main() {
  const base = "scripts/integration-mvp1-industrial.mjs";

  console.log("[mvp1-industrial] Running safe fixture (expected pass)...");
  const safeOut = run([
    base,
    "--mode",
    "snapshot",
    "--tasks-dump",
    "scripts/testdata/mvp1-industrial/safe-snapshot.json",
    "--status-dump",
    "scripts/testdata/mvp1-industrial/safe-status.json",
    "--now-ms",
    "1700001000000",
    "--max-messages",
    "3",
    "--fyi",
    "architect",
  ], 0);
  if (!safeOut.includes("pass=true")) {
    throw new Error(`Safe fixture did not report pass=true\n${safeOut}`);
  }

  console.log("[mvp1-industrial] Running storm fixture (expected controlled fail)...");
  const stormOut = run([
    base,
    "--mode",
    "snapshot",
    "--tasks-dump",
    "scripts/testdata/mvp1-industrial/storm-snapshot.json",
    "--status-dump",
    "scripts/testdata/mvp1-industrial/storm-status.json",
    "--now-ms",
    "1700001000000",
    "--max-messages",
    "3",
    "--fyi",
    "architect",
  ], 1);
  if (!stormOut.includes("unknown_assignees_exceeded")) {
    throw new Error(`Storm fixture did not fail for unknown assignee hygiene\n${stormOut}`);
  }

  console.log("[mvp1-industrial] Snapshot suite checks passed.");

  if (process.env.OPENCLAW_INTEGRATION === "1") {
    console.log("[mvp1-industrial] Running live read-only analysis...");
    run([base, "--mode", "live", "--max-messages", "3", "--fyi", "architect", "--min-breaches-for-stress", "0"], 0);
    console.log("[mvp1-industrial] Live analysis passed.");
  } else {
    console.log("[mvp1-industrial] Skipping live analysis. Set OPENCLAW_INTEGRATION=1 to enable.");
  }
}

try {
  main();
} catch (err) {
  console.error(String(err?.stack || err));
  process.exit(1);
}
