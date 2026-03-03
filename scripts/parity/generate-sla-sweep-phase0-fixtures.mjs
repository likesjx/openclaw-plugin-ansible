#!/usr/bin/env node
import path from "node:path";
import { CONTRACT_SCHEMA_REF, executeFixtureInput, loadJson, normalizeSnapshotTasks, writeJson } from "./sla-sweep-fixture-lib.mjs";

const ROOT = process.cwd();
const FIXTURE_DIR = path.resolve(ROOT, "contracts/fixtures/sla-sweep-v1");

const CASES = [
  {
    caseId: "safe",
    nowMs: 1700001000000,
    nodeId: "backbone-alpha",
    options: {
      dryRun: false,
      recordOnly: true,
      maxMessages: 3,
      fyiAgents: ["architect"],
    },
    snapshotPath: "scripts/testdata/mvp1-industrial/safe-snapshot.json",
  },
  {
    caseId: "storm",
    nowMs: 1700001000000,
    nodeId: "backbone-alpha",
    options: {
      dryRun: false,
      recordOnly: true,
      maxMessages: 3,
      fyiAgents: ["architect"],
    },
    snapshotPath: "scripts/testdata/mvp1-industrial/storm-snapshot.json",
  },
];

for (const c of CASES) {
  const snapshot = loadJson(path.resolve(ROOT, c.snapshotPath));
  const input = {
    contractSchemaRef: CONTRACT_SCHEMA_REF,
    caseId: c.caseId,
    nowMs: c.nowMs,
    nodeId: c.nodeId,
    options: c.options,
    tasks: normalizeSnapshotTasks(snapshot),
  };

  const expected = executeFixtureInput(input);

  writeJson(path.join(FIXTURE_DIR, `${c.caseId}.input.json`), input);
  writeJson(path.join(FIXTURE_DIR, `${c.caseId}.expected.json`), expected);
  console.log(`[phase0] refreshed fixture: ${c.caseId}`);
}

console.log(`[phase0] fixture refresh complete: ${FIXTURE_DIR}`);
