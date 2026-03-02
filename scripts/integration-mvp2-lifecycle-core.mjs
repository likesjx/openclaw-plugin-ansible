#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";

function run(cmd, args, { allowFail = false } = {}) {
  const p = spawnSync(cmd, args, { encoding: "utf8", env: process.env });
  const out = `${p.stdout || ""}${p.stderr || ""}`;
  if ((p.status ?? 1) !== 0 && !allowFail) {
    throw new Error(`Command failed (${cmd} ${args.join(" ")}):\n${out}`);
  }
  return { status: p.status ?? 1, out };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function parseJsonFromMixedOutput(text) {
  const plain = stripAnsi(text);
  const start = plain.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < plain.length; i += 1) {
    const ch = plain[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) {
      try {
        return JSON.parse(plain.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parsePipeline(output, prefix = "publishPipeline=") {
  const plain = stripAnsi(output);
  const line = plain
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .find((s) => s.startsWith(prefix));
  if (!line) return [];
  return line
    .slice(prefix.length)
    .trim()
    .split(/\s+/g)
    .map((chunk) => {
      const idx = chunk.indexOf(":");
      return idx < 0 ? { gate: chunk, status: "" } : { gate: chunk.slice(0, idx), status: chunk.slice(idx + 1) };
    });
}

function gateStatus(pipeline, gate) {
  const hit = pipeline.find((g) => g.gate === gate);
  return hit ? hit.status : "";
}

function main() {
  if (process.env.OPENCLAW_INTEGRATION !== "1") {
    console.log("Skipping MVP-2 lifecycle core integration. Set OPENCLAW_INTEGRATION=1 to run.");
    return;
  }
  if (process.env.OPENCLAW_ALLOW_MUTATION !== "1") {
    console.log("Skipping MVP-2 lifecycle core integration. Set OPENCLAW_ALLOW_MUTATION=1 (mutating test).");
    return;
  }

  const status = run(OPENCLAW_BIN, ["ansible", "status", "--json"], { allowFail: true });
  const statusPayload = parseJsonFromMixedOutput(status.out);
  const actor =
    process.env.OPENCLAW_ADMIN_ACTOR ||
    statusPayload?.coordination?.effectiveAdminAgentId ||
    statusPayload?.effectiveAdminAgentId ||
    statusPayload?.status?.myId ||
    "architect";
  const owner = process.env.OPENCLAW_TEST_OWNER_AGENT || actor;
  const suffix = Date.now();
  const capabilityId = process.env.OPENCLAW_TEST_CAPABILITY_ID || `cap.mvp2.lifecycle.core.${suffix}`;
  const version = process.env.OPENCLAW_TEST_CAP_VERSION || `0.2.${suffix % 100000}`;
  const token = process.env.OPENCLAW_ANSIBLE_TOKEN;

  const publishArgs = () => {
    const args = [
      "ansible",
      "capability",
      "publish",
      "--id",
      capabilityId,
      "--name",
      "MVP2 Lifecycle Core",
      "--cap-version",
      version,
      "--owner",
      owner,
      "--delegation-skill-name",
      "ansible-delegation-smoke",
      "--delegation-skill-version",
      "1.0.0",
      "--executor-skill-name",
      "ansible-executor-smoke",
      "--executor-skill-version",
      "1.0.0",
      "--contract",
      "schema://ansible/mvp2/lifecycle-core/1.0.0",
      "--eta",
      "900",
      "--status",
      "active",
      "--as",
      actor,
    ];
    if (typeof token === "string" && token.trim().length > 0) {
      args.push("--token", token.trim());
    }
    return args;
  };

  const unpublishArgs = () => {
    const args = ["ansible", "capability", "unpublish", "--id", capabilityId, "--as", actor];
    if (typeof token === "string" && token.trim().length > 0) {
      args.push("--token", token.trim());
    }
    return args;
  };

  let published = false;
  try {
    const first = run(OPENCLAW_BIN, publishArgs());
    assert(stripAnsi(first.out).includes("Capability published"), "Initial publish did not succeed.");
    const firstPipeline = parsePipeline(first.out);
    assert(gateStatus(firstPipeline, "G4_INSTALL_STAGE") === "passed", "First publish expected G4 passed.");
    assert(gateStatus(firstPipeline, "G5_WIRE_STAGE") === "passed", "First publish expected G5 passed.");
    published = true;

    const second = run(OPENCLAW_BIN, publishArgs());
    assert(stripAnsi(second.out).includes("Capability published"), "Second publish did not succeed.");
    const secondPipeline = parsePipeline(second.out);
    assert(gateStatus(secondPipeline, "G4_INSTALL_STAGE") === "skipped", "Second publish expected G4 skipped (idempotent).");
    assert(gateStatus(secondPipeline, "G5_WIRE_STAGE") === "skipped", "Second publish expected G5 skipped (idempotent).");

    const evidence = run(OPENCLAW_BIN, [
      "ansible",
      "capability",
      "evidence",
      "--id",
      capabilityId,
      "--cap-version",
      version,
      "--format",
      "json",
    ]);
    const evidenceJson = parseJsonFromMixedOutput(evidence.out);
    assert(evidenceJson && evidenceJson.manifestKey, "Evidence JSON missing manifestKey.");
    assert(evidenceJson.installStage && evidenceJson.installStage.status === "wired", "Evidence installStage should be wired.");
    assert(evidenceJson.wiring && evidenceJson.wiring.active === true, "Evidence wiring should be active.");

    const report = {
      capabilityId,
      version,
      actor,
      owner,
      firstPipeline,
      secondPipeline,
      evidence: evidenceJson,
      generatedAt: new Date().toISOString(),
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (published) {
      run(OPENCLAW_BIN, unpublishArgs(), { allowFail: true });
    }
  }
}

try {
  main();
} catch (err) {
  console.error(String(err?.stack || err));
  process.exit(1);
}
