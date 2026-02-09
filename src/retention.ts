/**
 * Coordinator Retention / Roll-off
 *
 * Goal: keep shared coordination state trustworthy by pruning closed tasks
 * after a configurable TTL. This is intentionally coordinator-only to avoid
 * multi-node races and surprises.
 *
 * Defaults:
 * - Run cadence: daily
 * - Closed task retention: 7 days
 *
 * Storage: coordination Y.Map keys (shared):
 * - retentionClosedTaskSeconds: number
 * - retentionPruneEverySeconds: number
 * - retentionLastPruneAt: number (ms epoch)
 * - retentionUpdatedAt: number (ms epoch)
 * - retentionUpdatedBy: TailscaleId
 */

import type { OpenClawPluginApi, ServiceContext } from "./types.js";
import type { AnsibleConfig, Task, TailscaleId } from "./schema.js";
import { getDoc, getNodeId } from "./service.js";

const DEFAULT_PRUNE_EVERY_SECONDS = 24 * 60 * 60; // daily
const DEFAULT_CLOSED_TASK_RETENTION_SECONDS = 7 * 24 * 60 * 60; // 7 days

// We check "is it due?" on a small interval so settings can be edited live.
const CHECK_INTERVAL_MS = 5 * 60_000;

function toNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function isClosedTask(task: Task): boolean {
  return task.status === "completed" || task.status === "failed";
}

function taskClosedAtMs(task: Task): number | undefined {
  // "Closed" moment is completion time when available. Fall back to last update.
  const t = toNum(task.completedAt) ?? toNum(task.updatedAt) ?? toNum(task.createdAt);
  return t;
}

function readRetentionConfig(m: any): {
  pruneEverySeconds: number;
  closedTaskRetentionSeconds: number;
  lastPruneAt?: number;
} {
  const pruneEverySeconds =
    toNum(m?.get("retentionPruneEverySeconds")) ?? DEFAULT_PRUNE_EVERY_SECONDS;
  const closedTaskRetentionSeconds =
    toNum(m?.get("retentionClosedTaskSeconds")) ?? DEFAULT_CLOSED_TASK_RETENTION_SECONDS;
  const lastPruneAt = toNum(m?.get("retentionLastPruneAt"));
  return { pruneEverySeconds, closedTaskRetentionSeconds, lastPruneAt };
}

function isMeCoordinator(coordination: any, myId: TailscaleId): boolean {
  const coordinator = coordination?.get("coordinator");
  return typeof coordinator === "string" && coordinator === myId;
}

function pruneClosedTasks(doc: any, cutoffMs: number): { removed: number; kept: number } {
  const tasks = doc.getMap("tasks");
  let removed = 0;
  let kept = 0;

  for (const [id, raw] of tasks.entries()) {
    const task = raw as Task;
    if (!task || typeof task !== "object") continue;
    if (!isClosedTask(task)) continue;

    const closedAt = taskClosedAtMs(task);
    if (!closedAt) continue;

    if (closedAt < cutoffMs) {
      tasks.delete(id as string);
      removed++;
    } else {
      kept++;
    }
  }

  return { removed, kept };
}

export function createAnsibleRetentionService(api: OpenClawPluginApi, config: AnsibleConfig) {
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let coordination: any = null;
  let observer: (() => void) | null = null;

  return {
    id: "ansible-retention",

    async start(ctx: ServiceContext) {
      // Only backbone nodes should ever prune shared state.
      if (config.tier !== "backbone") return;

      const doc = getDoc();
      const myId = getNodeId();
      if (!doc || !myId) {
        api.logger?.warn("Ansible retention: doc or nodeId not available, skipping");
        return;
      }

      coordination = doc.getMap("coordination");

      const runOnceIfDue = (reason: string) => {
        try {
          if (!isMeCoordinator(coordination, myId)) return;

          const now = Date.now();
          const { pruneEverySeconds, closedTaskRetentionSeconds, lastPruneAt } = readRetentionConfig(coordination);

          // Due if never ran, or cadence elapsed.
          const dueAt = (lastPruneAt ?? 0) + pruneEverySeconds * 1000;
          if (lastPruneAt && now < dueAt) return;

          const cutoffMs = now - closedTaskRetentionSeconds * 1000;
          const res = pruneClosedTasks(doc, cutoffMs);

          coordination.set("retentionLastPruneAt", now);

          // Only log when something changed. Keep it quiet by default.
          if (res.removed > 0) {
            api.logger?.info(
              `Ansible retention: pruned closed tasks removed=${res.removed} kept=${res.kept} reason=${reason}`,
            );
          } else {
            api.logger?.debug?.(
              `Ansible retention: no-op (no closed tasks eligible) reason=${reason}`,
            );
          }
        } catch (err: any) {
          api.logger?.warn(`Ansible retention: run failed err=${String(err?.message || err)}`);
        }
      };

      // Kick soon after startup (covers restarts).
      startupTimer = setTimeout(() => runOnceIfDue("startup"), 5_000);

      // Periodic due-check (settings can change live).
      interval = setInterval(() => runOnceIfDue("interval"), CHECK_INTERVAL_MS);

      // If coordinator role flips to/from this node, re-check quickly.
      observer = () => runOnceIfDue("coordination-change");
      coordination.observe(observer);

      api.logger?.info(
        "Ansible retention: enabled (coordinator-only closed task roll-off)",
      );
    },

    async stop(_ctx: ServiceContext) {
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (coordination && observer) {
        try {
          coordination.unobserve(observer);
        } catch {
          // ignore
        }
      }
      coordination = null;
      observer = null;
      api.logger?.info("Ansible retention: stopped");
    },
  };
}
