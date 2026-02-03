/**
 * Ansible Sync Service
 *
 * Manages Yjs document synchronization between OpenClaw instances.
 * - Backbone nodes: Run WebSocket server + connect to peers
 * - Edge nodes: Connect to backbone peers as client
 */

import * as Y from "yjs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AnsibleConfig, AnsibleState, TailscaleId } from "./schema.js";

// Re-export for convenience
export type { AnsibleState };

interface ServiceContext {
  config: AnsibleConfig;
  workspaceDir: string;
  stateDir: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; debug: (msg: string) => void };
}

// Singleton state
let doc: Y.Doc | null = null;
let nodeId: TailscaleId | null = null;

/**
 * Get the shared Yjs document
 */
export function getDoc(): Y.Doc | null {
  return doc;
}

/**
 * Get this node's Tailscale ID
 */
export function getNodeId(): TailscaleId | null {
  return nodeId;
}

/**
 * Get the current Ansible state from the Yjs document
 */
export function getAnsibleState(): AnsibleState | null {
  if (!doc) return null;

  return {
    nodes: doc.getMap("nodes") as unknown as Map<TailscaleId, AnsibleState["nodes"] extends Map<any, infer V> ? V : never>,
    pendingInvites: doc.getMap("pendingInvites") as unknown as AnsibleState["pendingInvites"],
    tasks: doc.getMap("tasks") as unknown as AnsibleState["tasks"],
    messages: doc.getMap("messages") as unknown as AnsibleState["messages"],
    context: doc.getMap("context") as unknown as AnsibleState["context"],
    pulse: doc.getMap("pulse") as unknown as AnsibleState["pulse"],
  };
}

/**
 * Create the Ansible sync service
 */
export function createAnsibleService(
  api: OpenClawPluginApi<AnsibleConfig>,
  config: AnsibleConfig
) {
  return {
    id: "ansible-sync",

    async start(ctx: ServiceContext) {
      ctx.logger.info("Ansible sync service starting...");

      // Initialize Yjs document
      doc = new Y.Doc();

      // Get our Tailscale node ID
      nodeId = await detectTailscaleId();
      if (!nodeId) {
        ctx.logger.warn("Could not detect Tailscale ID, using hostname");
        nodeId = (await import("os")).hostname();
      }

      ctx.logger.info(`Ansible node ID: ${nodeId}`);

      // Initialize Yjs maps
      doc.getMap("nodes");
      doc.getMap("pendingInvites");
      doc.getMap("tasks");
      doc.getMap("messages");
      doc.getMap("context");
      doc.getMap("pulse");

      // Load persisted state if available
      await loadPersistedState(ctx.stateDir);

      if (config.tier === "backbone") {
        await startBackboneMode(ctx, config);
      } else {
        await startEdgeMode(ctx, config);
      }

      // Start pulse heartbeat
      startPulseHeartbeat(ctx);

      ctx.logger.info("Ansible sync service started");
    },

    async stop(ctx: ServiceContext) {
      ctx.logger.info("Ansible sync service stopping...");

      // Persist state before shutdown
      await persistState(ctx.stateDir);

      // Update pulse to offline
      if (doc && nodeId) {
        const pulse = doc.getMap("pulse");
        const existing = pulse.get(nodeId) as Record<string, unknown> | undefined;
        pulse.set(nodeId, {
          ...existing,
          status: "offline",
          lastSeen: Date.now(),
        });
      }

      // TODO: Close WebSocket connections

      doc = null;
      nodeId = null;

      ctx.logger.info("Ansible sync service stopped");
    },
  };
}

// ============================================================================
// Private Implementation
// ============================================================================

async function detectTailscaleId(): Promise<string | null> {
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    const { stdout } = await execAsync("tailscale status --json");
    const status = JSON.parse(stdout);
    return status.Self?.HostName || null;
  } catch {
    return null;
  }
}

async function startBackboneMode(ctx: ServiceContext, config: AnsibleConfig) {
  const port = config.listenPort || 1234;
  ctx.logger.info(`Backbone mode: starting WebSocket server on port ${port}`);

  // TODO: Start y-websocket server
  // TODO: Connect to other backbone peers

  ctx.logger.debug(`Backbone peers to connect: ${config.backbonePeers?.join(", ") || "none"}`);
}

async function startEdgeMode(ctx: ServiceContext, config: AnsibleConfig) {
  ctx.logger.info("Edge mode: connecting to backbone peers");

  if (!config.backbonePeers?.length) {
    ctx.logger.warn("No backbone peers configured!");
    return;
  }

  // TODO: Connect to backbone peers with failover
  ctx.logger.debug(`Backbone peers: ${config.backbonePeers.join(", ")}`);
}

async function loadPersistedState(stateDir: string) {
  // TODO: Load Yjs state from stateDir
}

async function persistState(stateDir: string) {
  // TODO: Save Yjs state to stateDir
}

function startPulseHeartbeat(ctx: ServiceContext) {
  const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

  const updatePulse = () => {
    if (!doc || !nodeId) return;

    const pulse = doc.getMap("pulse");
    pulse.set(nodeId, {
      lastSeen: Date.now(),
      status: "online",
      version: "0.1.0",
    });
  };

  // Initial pulse
  updatePulse();

  // Periodic heartbeat
  setInterval(updatePulse, HEARTBEAT_INTERVAL_MS);
}
