/**
 * Ansible Sync Service
 *
 * Manages Yjs document synchronization between OpenClaw instances.
 * - Backbone nodes: Run WebSocket server + connect to peers
 * - Edge nodes: Connect to backbone peers as client
 */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// y-websocket utils are not exported, so we need to use require
const { setupWSConnection, getYDoc } = require("y-websocket/bin/utils.cjs");
import type { OpenClawPluginApi, ServiceContext } from "./types.js";
import type { AnsibleConfig, AnsibleState, TailscaleId, PulseData, NodeContext, Message } from "./schema.js";
import { MESSAGE_RETENTION } from "./schema.js";

// Re-export for convenience
export type { AnsibleState };

// Singleton state
let doc: Y.Doc | null = null;
let nodeId: TailscaleId | null = null;
let wsServer: WebSocketServer | null = null;
let providers: WebsocketProvider[] = [];
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let isBackboneMode = false;

const HEARTBEAT_INTERVAL_MS = 30_000;
const CLEANUP_INTERVAL_MS = 60_000; // Run cleanup every minute
const STATE_FILE = "ansible-state.yjs";

/**
 * Get the shared Yjs document
 * For backbone: returns the y-websocket managed doc
 * For edge: returns our local doc (synced via WebsocketProvider)
 */
export function getDoc(): Y.Doc | null {
  // If backbone mode, try to get the y-websocket managed doc
  if (isBackboneMode && !doc) {
    try {
      const wsDoc = getYDoc("ansible-shared");
      return wsDoc;
    } catch {
      return null;
    }
  }
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
    nodes: doc.getMap("nodes") as unknown as Map<TailscaleId, AnsibleState["nodes"] extends Map<string, infer V> ? V : never>,
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
  _api: OpenClawPluginApi,
  config: AnsibleConfig
) {
  return {
    id: "ansible-sync",

    async start(ctx: ServiceContext) {
      ctx.logger.info("Ansible sync service starting...");

      // Get our Tailscale node ID
      nodeId = await detectTailscaleId();
      if (!nodeId) {
        ctx.logger.warn("Could not detect Tailscale ID, using hostname");
        const os = await import("os");
        nodeId = os.hostname();
      }

      ctx.logger.info(`Ansible node ID: ${nodeId}`);

      if (config.tier === "backbone") {
        // Backbone mode: Start server first, then get the y-websocket managed doc
        await startBackboneMode(ctx, config);
        // Get the doc created by y-websocket utils
        doc = getYDoc("ansible-shared");
      } else {
        // Edge mode: Create our own doc that will be synced via WebsocketProvider
        doc = new Y.Doc();
        await startEdgeMode(ctx, config);
      }

      if (!doc) {
        ctx.logger.warn("Failed to initialize Yjs document");
        return;
      }

      // Initialize Yjs maps (creates them if they don't exist)
      doc.getMap("nodes");
      doc.getMap("pendingInvites");
      doc.getMap("tasks");
      doc.getMap("messages");
      doc.getMap("context");
      doc.getMap("pulse");

      // Load persisted state if available (for edge mode primarily)
      if (config.tier !== "backbone") {
        await loadPersistedState(ctx.stateDir);
      }

      // Start pulse heartbeat
      startPulseHeartbeat(ctx);

      // Start message cleanup
      startMessageCleanup(ctx);

      // Set up auto-persistence
      setupAutoPersist(ctx.stateDir);

      ctx.logger.info("Ansible sync service started");
    },

    async stop(ctx: ServiceContext) {
      ctx.logger.info("Ansible sync service stopping...");

      // Stop heartbeat
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }

      // Stop cleanup
      if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
      }

      // Persist state before shutdown
      await persistState(ctx.stateDir);

      // Update pulse to offline
      if (doc && nodeId) {
        const pulse = doc.getMap("pulse");
        const existing = pulse.get(nodeId) as PulseData | undefined;
        pulse.set(nodeId, {
          ...existing,
          status: "offline",
          lastSeen: Date.now(),
        } as PulseData);
      }

      // Close WebSocket providers
      for (const provider of providers) {
        provider.destroy();
      }
      providers = [];

      // Close WebSocket server
      if (wsServer) {
        wsServer.close();
        wsServer = null;
      }

      doc = null;
      nodeId = null;

      ctx.logger.info("Ansible sync service stopped");
    },
  };
}

// ============================================================================
// Tailscale Detection
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

// ============================================================================
// Backbone Mode (Server + Peer Connections)
// ============================================================================

async function startBackboneMode(ctx: ServiceContext, config: AnsibleConfig) {
  isBackboneMode = true;
  const port = config.listenPort || 1234;
  ctx.logger.info(`Backbone mode: starting WebSocket server on port ${port}`);

  // Start WebSocket server for incoming connections
  wsServer = new WebSocketServer({ port });

  wsServer.on("connection", (ws: WebSocket, req) => {
    const clientIp = req.socket.remoteAddress;
    ctx.logger.info(`New connection from ${clientIp}`);

    // Use y-websocket utility for proper sync protocol
    // All clients connect to "ansible-shared" room
    setupWSConnection(ws, req, { docName: "ansible-shared" });
  });

  wsServer.on("error", (err) => {
    ctx.logger.warn(`WebSocket server error: ${err.message}`);
  });

  ctx.logger.info(`WebSocket server listening on port ${port}`);

  // Connect to other backbone peers
  if (config.backbonePeers?.length) {
    for (const peerUrl of config.backbonePeers) {
      // Skip self (don't connect to our own server)
      if (isSelfUrl(peerUrl, port)) {
        ctx.logger.debug(`Skipping self URL: ${peerUrl}`);
        continue;
      }

      connectToPeer(peerUrl, ctx);
    }
  }
}

function isSelfUrl(url: string, myPort: number): boolean {
  try {
    const parsed = new URL(url);
    const urlPort = parseInt(parsed.port) || 1234;

    // Check if this is our own port on localhost or our tailscale IP
    if (urlPort !== myPort) return false;

    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1") return true;

    // Check if it matches our tailscale hostname
    if (nodeId && host.includes(nodeId)) return true;

    return false;
  } catch {
    return false;
  }
}

// ============================================================================
// Edge Mode (Client Only)
// ============================================================================

async function startEdgeMode(ctx: ServiceContext, config: AnsibleConfig) {
  ctx.logger.info("Edge mode: connecting to backbone peers");

  if (!config.backbonePeers?.length) {
    ctx.logger.warn("No backbone peers configured!");
    return;
  }

  // Connect to backbone peers (with failover logic)
  for (const peerUrl of config.backbonePeers) {
    connectToPeer(peerUrl, ctx);
  }
}

// ============================================================================
// Yjs Sync
// ============================================================================

function connectToPeer(url: string, ctx: ServiceContext) {
  if (!doc) return;

  ctx.logger.info(`Connecting to peer: ${url}`);

  try {
    // Use y-websocket provider for sync
    const provider = new WebsocketProvider(url, "ansible-shared", doc, {
      connect: true,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    });

    provider.on("status", (event: { status: string }) => {
      ctx.logger.debug(`Connection to ${url}: ${event.status}`);
    });

    provider.on("sync", (synced: boolean) => {
      if (synced) {
        ctx.logger.info(`Synced with ${url}`);
      }
    });

    providers.push(provider);
  } catch (err) {
    ctx.logger.warn(`Failed to connect to ${url}: ${err}`);
  }
}

// ============================================================================
// Persistence
// ============================================================================

async function loadPersistedState(stateDir: string) {
  if (!doc) return;

  const statePath = path.join(stateDir, STATE_FILE);

  try {
    if (fs.existsSync(statePath)) {
      const data = fs.readFileSync(statePath);
      Y.applyUpdate(doc, new Uint8Array(data));
      console.log(`Loaded Ansible state from ${statePath}`);
    }
  } catch (err) {
    console.warn(`Failed to load persisted state: ${err}`);
  }
}

async function persistState(stateDir: string) {
  if (!doc) return;

  const statePath = path.join(stateDir, STATE_FILE);

  try {
    // Ensure directory exists
    fs.mkdirSync(stateDir, { recursive: true });

    const state = Y.encodeStateAsUpdate(doc);
    fs.writeFileSync(statePath, Buffer.from(state));
    console.log(`Persisted Ansible state to ${statePath}`);
  } catch (err) {
    console.warn(`Failed to persist state: ${err}`);
  }
}

function setupAutoPersist(stateDir: string) {
  if (!doc) return;

  // Persist on changes (debounced)
  let persistTimeout: ReturnType<typeof setTimeout> | null = null;

  doc.on("update", () => {
    if (persistTimeout) clearTimeout(persistTimeout);
    persistTimeout = setTimeout(() => {
      persistState(stateDir);
    }, 5000); // Persist 5 seconds after last change
  });
}

// ============================================================================
// Heartbeat
// ============================================================================

function startPulseHeartbeat(ctx: ServiceContext) {
  const updatePulse = () => {
    if (!doc || !nodeId) return;

    const pulse = doc.getMap("pulse");
    const existing = pulse.get(nodeId) as PulseData | undefined;

    pulse.set(nodeId, {
      lastSeen: Date.now(),
      status: "online",
      version: "0.1.0",
      currentTask: existing?.currentTask,
    } as PulseData);
  };

  // Initial pulse
  updatePulse();

  // Periodic heartbeat
  heartbeatInterval = setInterval(updatePulse, HEARTBEAT_INTERVAL_MS);
}

// ============================================================================
// Message Cleanup
// ============================================================================

function startMessageCleanup(ctx: ServiceContext) {
  const runCleanup = () => {
    if (!doc || !nodeId) return;

    const messages = doc.getMap("messages");
    const now = Date.now();
    const maxAgeMs = MESSAGE_RETENTION.maxAgeHours * 60 * 60 * 1000;
    const cutoff = now - maxAgeMs;

    // Collect messages to potentially delete
    const allMessages: Array<{ id: string; msg: Message }> = [];
    for (const [id, msg] of messages.entries()) {
      allMessages.push({ id, msg: msg as Message });
    }

    // Sort by timestamp (oldest first)
    allMessages.sort((a, b) => a.msg.timestamp - b.msg.timestamp);

    let deleted = 0;
    const toDelete: string[] = [];

    for (const { id, msg } of allMessages) {
      // Skip unread messages if configured to keep them
      if (MESSAGE_RETENTION.keepUnread && !msg.readBy.includes(nodeId)) {
        continue;
      }

      // Delete if too old
      if (msg.timestamp < cutoff) {
        toDelete.push(id);
        continue;
      }

      // Delete if over count limit (keeping newest)
      const remaining = allMessages.length - toDelete.length;
      if (remaining > MESSAGE_RETENTION.maxCount) {
        toDelete.push(id);
      }
    }

    // Perform deletions
    for (const id of toDelete) {
      messages.delete(id);
      deleted++;
    }

    if (deleted > 0) {
      ctx.logger.debug(`Cleaned up ${deleted} old messages`);
    }
  };

  // Run cleanup periodically
  cleanupInterval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);

  // Run once at startup (after a short delay to allow sync)
  setTimeout(runCleanup, 5000);
}
