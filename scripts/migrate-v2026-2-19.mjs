import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const targetArg = args.find((a) => !a.startsWith('--'));
const stateFile = targetArg || process.env.ANSIBLE_STATE || path.join(os.homedir(), '.openclaw', 'ansible-state.yjs');

if (!fs.existsSync(stateFile)) {
  console.error(`State file not found: ${stateFile}`);
  process.exit(1);
}

const bytes = fs.readFileSync(stateFile);
const doc = new Y.Doc();
Y.applyUpdate(doc, new Uint8Array(bytes));

const now = Date.now();
let changedMessages = 0;
let changedTasks = 0;

const messages = doc.getMap('messages');
for (const [id, raw] of messages.entries()) {
  if (!raw || typeof raw !== 'object') continue;
  const msg = raw;
  const hasUpdatedAt = Number.isFinite(msg.updatedAt);
  if (hasUpdatedAt) continue;

  const fallback = Number.isFinite(msg.timestamp) ? msg.timestamp : now;
  messages.set(id, { ...msg, updatedAt: fallback });
  changedMessages += 1;
}

const tasks = doc.getMap('tasks');
for (const [id, raw] of tasks.entries()) {
  if (!raw || typeof raw !== 'object') continue;
  const task = raw;
  const hasUpdatedAt = Number.isFinite(task.updatedAt);
  if (hasUpdatedAt) continue;

  const fallback = Number.isFinite(task.completedAt)
    ? task.completedAt
    : Number.isFinite(task.createdAt)
      ? task.createdAt
      : now;

  tasks.set(id, { ...task, updatedAt: fallback });
  changedTasks += 1;
}

const summary = {
  file: stateFile,
  dryRun,
  changedMessages,
  changedTasks,
};

if (dryRun) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (changedMessages === 0 && changedTasks === 0) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const backup = `${stateFile}.bak-migrate-v2026-2-19-${stamp()}`;
fs.copyFileSync(stateFile, backup);
fs.writeFileSync(stateFile, Buffer.from(Y.encodeStateAsUpdate(doc)));

console.log(JSON.stringify({ ...summary, backup }, null, 2));
