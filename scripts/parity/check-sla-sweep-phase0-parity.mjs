#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { executeFixtureInput, loadJson, writeJson } from "./sla-sweep-fixture-lib.mjs";

const ROOT = process.cwd();
const FIXTURE_DIR = path.resolve(ROOT, "contracts/fixtures/sla-sweep-v1");
const RUST_OUTPUTS_DIR = process.env.ANSIBLE_RUST_OUTPUTS_DIR ? path.resolve(process.env.ANSIBLE_RUST_OUTPUTS_DIR) : null;
const SHADOW = process.env.ANSIBLE_RUST_SHADOW === "1";

function listCases() {
  const files = fs.readdirSync(FIXTURE_DIR);
  return files
    .filter((name) => name.endsWith(".input.json"))
    .map((name) => name.replace(/\.input\.json$/, ""))
    .sort();
}

let failed = 0;

for (const caseId of listCases()) {
  const inputPath = path.join(FIXTURE_DIR, `${caseId}.input.json`);
  const expectedPath = path.join(FIXTURE_DIR, `${caseId}.expected.json`);

  const input = loadJson(inputPath);
  const expected = loadJson(expectedPath);
  const actual = executeFixtureInput(input);

  if (!isDeepStrictEqual(actual, expected)) {
    failed += 1;
    const actualPath = path.join(FIXTURE_DIR, `${caseId}.actual.ts.json`);
    writeJson(actualPath, actual);
    console.error(`[phase0] TS parity mismatch for case '${caseId}'`);
    console.error(`[phase0] wrote debug output: ${actualPath}`);
    continue;
  }

  if (SHADOW && RUST_OUTPUTS_DIR) {
    const rustPath = path.join(RUST_OUTPUTS_DIR, `${caseId}.actual.rust.json`);
    if (!fs.existsSync(rustPath)) {
      failed += 1;
      console.error(`[phase0] rust shadow enabled but output missing for case '${caseId}': ${rustPath}`);
      continue;
    }
    const rustActual = loadJson(rustPath);
    if (!isDeepStrictEqual(rustActual, expected)) {
      failed += 1;
      console.error(`[phase0] Rust shadow mismatch for case '${caseId}' (${rustPath})`);
      continue;
    }
  }

  console.log(`[phase0] parity ok: ${caseId}`);
}

if (SHADOW && !RUST_OUTPUTS_DIR) {
  console.error("[phase0] ANSIBLE_RUST_SHADOW=1 but ANSIBLE_RUST_OUTPUTS_DIR is not set.");
  process.exit(1);
}

if (failed > 0) {
  console.error(`[phase0] parity failed (${failed} case(s))`);
  process.exit(1);
}

console.log("[phase0] parity passed");
