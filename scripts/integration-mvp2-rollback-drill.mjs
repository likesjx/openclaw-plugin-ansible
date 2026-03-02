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

function parsePipeline(output, prefix) {
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

function publish(capabilityId, version, actor, owner, token) {
  const args = [
    "ansible",
    "capability",
    "publish",
    "--id",
    capabilityId,
    "--name",
    "MVP2 Rollback Drill",
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
    "schema://ansible/mvp2/rollback-drill/1.0.0",
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
  const out = run(OPENCLAW_BIN, args);
  const pipeline = parsePipeline(out.out, "publishPipeline=");
  assert(gateStatus(pipeline, "G8_INDEX_ACTIVATE") === "passed", `Publish ${version} missing G8 pass.`);
  assert(gateStatus(pipeline, "G9_POSTCHECK") === "passed", `Publish ${version} missing G9 pass.`);
  return { out: out.out, pipeline };
}

function evidence(capabilityId, version) {
  const out = run(OPENCLAW_BIN, [
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
  const json = parseJsonFromMixedOutput(out.out);
  assert(json && json.lifecycleFingerprint, "Evidence missing lifecycleFingerprint.");
  return json;
}

function unpublish(capabilityId, actor, token) {
  const args = ["ansible", "capability", "unpublish", "--id", capabilityId, "--as", actor];
  if (typeof token === "string" && token.trim().length > 0) {
    args.push("--token", token.trim());
  }
  const out = run(OPENCLAW_BIN, args);
  const pipeline = parsePipeline(out.out, "unpublishPipeline=");
  assert(gateStatus(pipeline, "U2_UNWIRE") === "passed", "Unpublish missing U2 pass.");
  assert(gateStatus(pipeline, "U3_ARCHIVE") === "passed", "Unpublish missing U3 pass.");
  return { out: out.out, pipeline };
}

function main() {
  if (process.env.OPENCLAW_INTEGRATION !== "1") {
    console.log("Skipping MVP-2 rollback drill. Set OPENCLAW_INTEGRATION=1 to run.");
    return;
  }
  if (process.env.OPENCLAW_ALLOW_MUTATION !== "1") {
    console.log("Skipping MVP-2 rollback drill. Set OPENCLAW_ALLOW_MUTATION=1 (mutating test).");
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
  const token = process.env.OPENCLAW_ANSIBLE_TOKEN;

  const suffix = Date.now();
  const capabilityId = process.env.OPENCLAW_TEST_CAPABILITY_ID || `cap.mvp2.rollback.drill.${suffix}`;
  const v1 = process.env.OPENCLAW_TEST_V1 || `0.2.${suffix % 100000}`;
  const v2 = process.env.OPENCLAW_TEST_V2 || `0.2.${(suffix % 100000) + 1}`;

  let published = false;
  try {
    const p1 = publish(capabilityId, v1, actor, owner, token);
    const ev1Before = evidence(capabilityId, v1);

    const p2 = publish(capabilityId, v2, actor, owner, token);
    const ev2 = evidence(capabilityId, v2);

    const rollback = publish(capabilityId, v1, actor, owner, token);
    const ev1After = evidence(capabilityId, v1);

    assert(
      ev1Before.lifecycleFingerprint === ev1After.lifecycleFingerprint,
      "Rollback parity failed: v1 fingerprint changed after rollback.",
    );

    published = true;
    const unpub = unpublish(capabilityId, actor, token);

    const report = {
      capabilityId,
      versions: { v1, v2 },
      actor,
      owner,
      publishV1: p1.pipeline,
      publishV2: p2.pipeline,
      rollbackToV1: rollback.pipeline,
      unpublish: unpub.pipeline,
      fingerprintParity: {
        beforeV1: ev1Before.lifecycleFingerprint,
        afterRollbackV1: ev1After.lifecycleFingerprint,
        matched: ev1Before.lifecycleFingerprint === ev1After.lifecycleFingerprint,
      },
      evidence: {
        v1Before: ev1Before,
        v2: ev2,
        v1AfterRollback: ev1After,
      },
      generatedAt: new Date().toISOString(),
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (published) {
      run(OPENCLAW_BIN, ["ansible", "capability", "unpublish", "--id", capabilityId, "--as", actor], {
        allowFail: true,
      });
    }
  }
}

try {
  main();
} catch (err) {
  console.error(String(err?.stack || err));
  process.exit(1);
}
