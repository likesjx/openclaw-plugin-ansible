#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function run(cmd, args) {
  const p = spawnSync(cmd, args, { encoding: "utf8", env: process.env });
  const out = `${p.stdout || ""}${p.stderr || ""}`;
  if ((p.status ?? 1) !== 0) {
    throw new Error(`Command failed (${cmd} ${args.join(" ")}):\n${out}`);
  }
  return out;
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
      if (escaped) {
        escaped = false;
      } else if (ch === "\\\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) {
      const candidate = plain.slice(start, i + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function getArgValue(argv, name, fallback = undefined) {
  const idx = argv.indexOf(name);
  if (idx < 0) return fallback;
  const next = argv[idx + 1];
  if (!next || next.startsWith("--")) return fallback;
  return next;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readJsonFile(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  return JSON.parse(raw);
}

function normalizeTasks(payload) {
  const items = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload)
      ? payload
      : [];
  return items
    .map((entry) => (entry && typeof entry === "object" && "value" in entry ? entry.value : entry))
    .filter((v) => v && typeof v === "object" && typeof v.id === "string");
}

function collectKnownAgents(statusPayload) {
  const out = new Set();
  const nodes = Array.isArray(statusPayload?.status?.nodes) ? statusPayload.status.nodes : [];
  for (const n of nodes) {
    if (n && typeof n.id === "string") out.add(n.id);
  }
  const agents = Array.isArray(statusPayload?.agents?.agents) ? statusPayload.agents.agents : [];
  for (const a of agents) {
    if (a && typeof a.id === "string") out.add(a.id);
  }
  return out;
}

function evalSlaOverdue(task, nowMs) {
  const status = String(task.status || "");
  const sla = task?.metadata?.ansible?.sla;
  if (!sla || typeof sla !== "object") return [];

  const escalations = (sla.escalations && typeof sla.escalations === "object") ? sla.escalations : {};
  const acceptByAt = typeof sla.acceptByAt === "number" ? sla.acceptByAt : null;
  const progressByAt = typeof sla.progressByAt === "number" ? sla.progressByAt : null;
  const completeByAt = typeof sla.completeByAt === "number" ? sla.completeByAt : null;

  const breaches = [];
  if (status === "pending" && acceptByAt && nowMs > acceptByAt && typeof escalations.acceptAt !== "number") {
    breaches.push({ breachType: "accept", dueAt: acceptByAt });
  }
  if ((status === "claimed" || status === "in_progress") && progressByAt && nowMs > progressByAt && typeof escalations.progressAt !== "number") {
    breaches.push({ breachType: "progress", dueAt: progressByAt });
  }
  if ((status === "claimed" || status === "in_progress") && completeByAt && nowMs > completeByAt && typeof escalations.completeAt !== "number") {
    breaches.push({ breachType: "complete", dueAt: completeByAt });
  }
  return breaches;
}

function simulateFanout({ tasks, nowMs, maxMessagesPerSweep, fyiAgents }) {
  let breachCount = 0;
  const perAgentBreachCount = {};
  const breachSamples = [];
  let potentialMessagesUnbounded = 0;

  for (const task of tasks) {
    const breaches = evalSlaOverdue(task, nowMs);
    if (breaches.length === 0) continue;

    const target = typeof task.assignedTo_agent === "string" && task.assignedTo_agent.length > 0
      ? task.assignedTo_agent
      : "(unassigned)";
    breachCount += breaches.length;
    perAgentBreachCount[target] = (perAgentBreachCount[target] || 0) + breaches.length;

    for (const b of breaches) {
      potentialMessagesUnbounded += 1 + fyiAgents.length;
      if (breachSamples.length < 20) {
        breachSamples.push({
          taskId: task.id,
          title: String(task.title || "(untitled)"),
          assignedTo: target,
          breachType: b.breachType,
          dueAt: b.dueAt,
        });
      }
    }
  }

  const boundedMessages = Math.min(maxMessagesPerSweep, breachCount) * (1 + fyiAgents.length);
  const preventedByBudget = Math.max(0, potentialMessagesUnbounded - boundedMessages);

  return {
    breachCount,
    perAgentBreachCount,
    breachSamples,
    potentialMessagesUnbounded,
    boundedMessages,
    preventedByBudget,
  };
}

function printSummary(result) {
  console.log("MVP-1 industrial stress summary");
  console.log(`mode=${result.mode}`);
  console.log(`source=${result.source}`);
  console.log(`tasks_scanned=${result.tasksScanned}`);
  console.log(`breaches=${result.fanout.breachCount}`);
  console.log(`messages_unbounded=${result.fanout.potentialMessagesUnbounded}`);
  console.log(`messages_bounded=${result.fanout.boundedMessages}`);
  console.log(`messages_prevented_by_budget=${result.fanout.preventedByBudget}`);
  console.log(`max_messages_per_sweep=${result.config.maxMessagesPerSweep}`);
  console.log(`fyi_agents=${result.config.fyiAgents.join(",") || "(none)"}`);
  console.log(`known_agent_gaps=${result.unknownAssignees.length}`);
  if (result.unknownAssignees.length > 0) {
    console.log(`unknown_assignees=${result.unknownAssignees.join(",")}`);
  }

  if (result.fanout.breachSamples.length > 0) {
    console.log("breach_samples=");
    for (const s of result.fanout.breachSamples.slice(0, 10)) {
      console.log(`  - ${s.taskId.slice(0, 8)} ${s.breachType} -> ${s.assignedTo} (${s.title})`);
    }
  }

  console.log(`pass=${result.pass}`);
  if (!result.pass) {
    for (const reason of result.failReasons) {
      console.log(`fail_reason=${reason}`);
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const mode = getArgValue(argv, "--mode", "snapshot");
  const nowMs = toNum(getArgValue(argv, "--now-ms", `${Date.now()}`), Date.now());
  const maxMessagesPerSweep = toNum(getArgValue(argv, "--max-messages", "3"), 3);
  const limit = toNum(getArgValue(argv, "--limit", "500"), 500);
  const fyiAgentsCsv = getArgValue(argv, "--fyi", "architect");
  const fyiAgents = String(fyiAgentsCsv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxUnknownAssignees = toNum(getArgValue(argv, "--max-unknown-assignees", "0"), 0);
  const minBreachesForStress = toNum(getArgValue(argv, "--min-breaches-for-stress", "1"), 1);

  let tasksPayload;
  let statusPayload;
  let source;

  if (mode === "live") {
    tasksPayload = parseJsonFromMixedOutput(run("openclaw", ["ansible", "tasks-dump", "--compact", "-n", String(limit)]));
    statusPayload = parseJsonFromMixedOutput(run("openclaw", ["ansible", "status", "--json"]));
    if (!tasksPayload) throw new Error("Failed to parse JSON from live tasks-dump output");
    if (!statusPayload) throw new Error("Failed to parse JSON from live status output");
    source = "gateway-live";
  } else if (mode === "snapshot") {
    const tasksPath = getArgValue(argv, "--tasks-dump", null);
    if (!tasksPath) {
      throw new Error("snapshot mode requires --tasks-dump <path>");
    }
    const statusPath = getArgValue(argv, "--status-dump", null);
    tasksPayload = readJsonFile(path.resolve(tasksPath));
    statusPayload = statusPath ? readJsonFile(path.resolve(statusPath)) : {};
    source = path.resolve(tasksPath);
  } else {
    throw new Error(`Unsupported --mode '${mode}'. Use 'snapshot' or 'live'.`);
  }

  const tasks = normalizeTasks(tasksPayload);
  const knownAgents = collectKnownAgents(statusPayload);
  const unknownAssignees = new Set();
  for (const t of tasks) {
    const a = typeof t.assignedTo_agent === "string" ? t.assignedTo_agent : "";
    if (a && knownAgents.size > 0 && !knownAgents.has(a)) unknownAssignees.add(a);
  }

  const fanout = simulateFanout({ tasks, nowMs, maxMessagesPerSweep, fyiAgents });

  const failReasons = [];
  if (fanout.breachCount < minBreachesForStress) {
    failReasons.push(`insufficient_breach_volume: breaches=${fanout.breachCount} min=${minBreachesForStress}`);
  }
  if (fanout.boundedMessages > maxMessagesPerSweep * (1 + fyiAgents.length)) {
    failReasons.push("message_budget_not_bounded");
  }
  if (unknownAssignees.size > maxUnknownAssignees) {
    failReasons.push(`unknown_assignees_exceeded: count=${unknownAssignees.size} max=${maxUnknownAssignees}`);
  }

  const result = {
    mode,
    source,
    generatedAt: new Date(nowMs).toISOString(),
    tasksScanned: tasks.length,
    config: {
      maxMessagesPerSweep,
      fyiAgents,
      maxUnknownAssignees,
      minBreachesForStress,
    },
    fanout,
    unknownAssignees: Array.from(unknownAssignees).sort(),
    pass: failReasons.length === 0,
    failReasons,
  };

  if (hasFlag(argv, "--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
  }

  if (!result.pass) {
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error(String(err?.stack || err));
  process.exit(1);
}
