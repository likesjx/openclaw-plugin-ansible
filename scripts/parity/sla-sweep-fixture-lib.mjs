import fs from "node:fs";
import path from "node:path";
import * as Y from "yjs";
import { runSlaSweep } from "../../dist/sla.js";

export const CONTRACT_SCHEMA_REF = "schema://ansible/rust-core/sla-sweep/1.0.0";

function withFixedNow(nowMs, fn) {
  const original = Date.now;
  Date.now = () => nowMs;
  try {
    return fn();
  } finally {
    Date.now = original;
  }
}

function toTaskList(entries) {
  return entries
    .map(([id, value]) => ({ id, value }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => entry.value);
}

function toMessageList(entries) {
  return entries
    .map(([id, value]) => ({ id, value }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => entry.value);
}

export function loadJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, "utf8"));
}

export function writeJson(absPath, value) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function executeFixtureInput(input) {
  const doc = new Y.Doc();
  const tasks = doc.getMap("tasks");
  const messages = doc.getMap("messages");

  for (const task of input.tasks || []) {
    if (!task || typeof task !== "object" || typeof task.id !== "string") continue;
    tasks.set(task.id, task);
  }

  const result = withFixedNow(Number(input.nowMs), () => runSlaSweep(doc, String(input.nodeId), {
    dryRun: Boolean(input.options?.dryRun),
    recordOnly: Boolean(input.options?.recordOnly),
    maxMessages: Number(input.options?.maxMessages),
    fyiAgents: Array.isArray(input.options?.fyiAgents) ? input.options.fyiAgents : [],
  }));

  return {
    contractSchemaRef: CONTRACT_SCHEMA_REF,
    caseId: String(input.caseId),
    result,
    tasksAfter: toTaskList(Array.from(tasks.entries())),
    messagesAfter: toMessageList(Array.from(messages.entries())),
  };
}

export function normalizeSnapshotTasks(snapshotPayload) {
  const items = Array.isArray(snapshotPayload?.items) ? snapshotPayload.items : [];
  return items
    .filter((item) => item && typeof item === "object" && typeof item.id === "string")
    .map((item) => ({ ...item }));
}
