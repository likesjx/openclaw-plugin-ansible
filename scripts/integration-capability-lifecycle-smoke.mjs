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

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function parseJsonFromMixedOutput(text) {
  const idx = text.indexOf("{");
  if (idx < 0) return null;
  const candidate = text.slice(idx).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function parsePipeline(linePrefix, output) {
  const plain = stripAnsi(output);
  const line = plain
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .find((s) => s.startsWith(linePrefix));
  if (!line) return [];
  return line
    .slice(linePrefix.length)
    .trim()
    .split(/\s+/g)
    .map((chunk) => {
      const idx = chunk.indexOf(":");
      if (idx < 0) return { gate: chunk, status: "" };
      return { gate: chunk.slice(0, idx), status: chunk.slice(idx + 1) };
    });
}

function expectGate(pipeline, gate, expectedStatus = "passed") {
  const found = pipeline.find((g) => g.gate === gate);
  assert(!!found, `Missing gate '${gate}' in pipeline.`);
  assert(found.status === expectedStatus, `Gate '${gate}' expected '${expectedStatus}', got '${found.status}'.`);
}

function main() {
  if (process.env.OPENCLAW_INTEGRATION !== "1") {
    console.log("Skipping capability lifecycle smoke. Set OPENCLAW_INTEGRATION=1 to run.");
    return;
  }
  if (process.env.OPENCLAW_ALLOW_MUTATION !== "1") {
    console.log("Skipping capability lifecycle smoke. Set OPENCLAW_ALLOW_MUTATION=1 (mutating test).");
    return;
  }

  const status = run("openclaw", ["ansible", "status", "--json"], { allowFail: true });
  const statusPayload = parseJsonFromMixedOutput(status.out);
  const detectedActor =
    statusPayload?.coordination?.effectiveAdminAgentId ||
    statusPayload?.effectiveAdminAgentId ||
    statusPayload?.status?.myId;
  const actor = process.env.OPENCLAW_ADMIN_ACTOR || (typeof detectedActor === "string" && detectedActor.trim() ? detectedActor : "architect");
  const owner = process.env.OPENCLAW_TEST_OWNER_AGENT || actor;
  const capabilityId = process.env.OPENCLAW_TEST_CAPABILITY_ID || "cap.smoke.lifecycle";
  const token = process.env.OPENCLAW_ANSIBLE_TOKEN;
  const suffix = Date.now();
  const v1 = `0.0.${suffix % 100000}`;
  const v2 = `0.0.${(suffix % 100000) + 1}`;

  const publishArgs = (version) => {
    const args = [
    "ansible",
    "capability",
    "publish",
    "--id",
    capabilityId,
    "--name",
    `Capability Smoke ${suffix}`,
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
    "schema://ansible/smoke/contract/1.0.0",
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

  let published = false;
  try {
    console.log(`Running capability lifecycle smoke for ${capabilityId} as ${actor}...`);

    const p1 = run("openclaw", publishArgs(v1));
    const p1out = stripAnsi(p1.out);
    assert(p1out.includes("Capability published"), "Initial publish did not report success.");
    const pp1 = parsePipeline("publishPipeline=", p1.out);
    expectGate(pp1, "G4_INSTALL_STAGE");
    expectGate(pp1, "G5_WIRE_STAGE");
    expectGate(pp1, "G8_INDEX_ACTIVATE");
    expectGate(pp1, "G9_POSTCHECK");
    published = true;

    const p2 = run("openclaw", publishArgs(v2));
    const p2out = stripAnsi(p2.out);
    assert(p2out.includes("Capability published"), "Update publish did not report success.");
    const pp2 = parsePipeline("publishPipeline=", p2.out);
    expectGate(pp2, "G4_INSTALL_STAGE");
    expectGate(pp2, "G5_WIRE_STAGE");
    expectGate(pp2, "G8_INDEX_ACTIVATE");
    expectGate(pp2, "G9_POSTCHECK");

    const listed = run("openclaw", ["ansible", "capability", "list", "--status", "active"]);
    const listedOut = stripAnsi(listed.out);
    assert(
      listedOut.includes(`${capabilityId}  [active]  v${v2}`),
      `Capability list missing updated active version (${capabilityId} v${v2}).`,
    );

    const unpublishArgs = [
      "ansible",
      "capability",
      "unpublish",
      "--id",
      capabilityId,
      "--as",
      actor,
    ];
    if (typeof token === "string" && token.trim().length > 0) {
      unpublishArgs.push("--token", token.trim());
    }
    const unpub = run("openclaw", unpublishArgs);
    const up = parsePipeline("unpublishPipeline=", unpub.out);
    expectGate(up, "U1_DISABLE_ROUTING");
    expectGate(up, "U2_UNWIRE");
    expectGate(up, "U3_ARCHIVE");
    expectGate(up, "U4_EMIT");
    published = false;

    console.log("Capability lifecycle smoke checks passed.");
  } finally {
    if (published) {
      const cleanupArgs = ["ansible", "capability", "unpublish", "--id", capabilityId, "--as", actor];
      if (typeof token === "string" && token.trim().length > 0) {
        cleanupArgs.push("--token", token.trim());
      }
      run("openclaw", cleanupArgs, { allowFail: true });
    }
  }
}

try {
  main();
} catch (err) {
  console.error(String(err?.stack || err));
  process.exit(1);
}
