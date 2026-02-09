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
// @ts-expect-error - y-websocket/bin/utils is CommonJS
import { setupWSConnection, getYDoc } from "y-websocket/bin/utils";
import type { OpenClawPluginApi, ServiceContext } from "./types.js";
import type { AnsibleConfig, AnsibleState, TailscaleId, PulseData, NodeContext, Message } from "./schema.js";
import { MESSAGE_RETENTION, VALIDATION_LIMITS } from "./schema.js";

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
let docReady = false;
let docReadyCallbacks: Array<() => void> = [];

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
    coordination: doc.getMap("coordination") as unknown as AnsibleState["coordination"],
  };
}

/**
 * Register a callback to run once the Yjs doc is initialized and ready.
 * If the doc is already ready, the callback fires immediately.
 */
export function onDocReady(cb: () => void): void {
  if (docReady) {
    cb();
  } else {
    docReadyCallbacks.push(cb);
  }
}

function fireDocReady(): void {
  if (docReady) return;
  docReady = true;
  for (const cb of docReadyCallbacks) {
    try {
      cb();
    } catch {
      // Swallow — individual callbacks shouldn't break startup
    }
  }
  docReadyCallbacks = [];
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

        // Add error handler for debugging sync issues
        doc.on("update", (update: Uint8Array, origin: unknown) => {
          ctx.logger.debug(`Doc update received, size: ${update.length}, origin: ${origin}`);
        });

        // Initialize Yjs maps BEFORE loading state or connecting
        doc.getMap("nodes");
        doc.getMap("pendingInvites");
        doc.getMap("tasks");
        doc.getMap("messages");
        doc.getMap("context");
        doc.getMap("pulse");
        doc.getMap("coordination");

        // Load persisted state BEFORE starting sync
        await loadPersistedState(ctx);

        // Now connect to peers
        await startEdgeMode(ctx, config);
      }

      if (!doc) {
        ctx.logger.warn("Failed to initialize Yjs document");
        return;
      }

      // Initialize Yjs maps for backbone mode (edge already did this above)
      if (config.tier === "backbone") {
        doc.getMap("nodes");
        doc.getMap("pendingInvites");
        doc.getMap("tasks");
        doc.getMap("messages");
        doc.getMap("context");
        doc.getMap("pulse");
        doc.getMap("coordination");
      }

      // Start pulse heartbeat
      startPulseHeartbeat(ctx);

      // Start message cleanup
      startMessageCleanup(ctx);

      // Set up auto-persistence
      setupAutoPersist(ctx);

      ctx.logger.info("Ansible sync service started");

      // For backbone mode, the doc is ready immediately.
      // For edge mode, wait until the first sync completes (see connectToPeer).
      if (config.tier === "backbone") {
        fireDocReady();
      }
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
      await persistState(ctx);

      // Update pulse to offline
      if (doc && nodeId) {
        const pulse = doc.getMap("pulse");
        const entry = getOrCreatePulseMap(pulse, nodeId);
        entry.set("status", "offline");
        entry.set("lastSeen", Date.now());
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
      docReady = false;
      docReadyCallbacks = [];

      ctx.logger.info("Ansible sync service stopped");
    },
  };
}

// ============================================================================
// Tailscale Detection
// ============================================================================

async function detectTailscaleId(): Promise<string | null> {
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync("tailscale", ["status", "--json"]);
    const status = JSON.parse(stdout);
    return status.Self?.HostName || null;
  } catch {
    return null;
  }
}

async function getTailscaleIP(): Promise<string | null> {
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync("tailscale", ["ip", "-4"]);
    return stdout.trim() || null;
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

  // Bind to Tailscale interface for security (only tailnet peers can connect)
  const host = config.listenHost || await getTailscaleIP() || "127.0.0.1";
  ctx.logger.info(`Backbone mode: starting WebSocket server on ${host}:${port}`);

  // Start WebSocket server for incoming connections
  wsServer = new WebSocketServer({ host, port });

  wsServer.on("connection", (ws: WebSocket, req) => {
    const clientIp = req.socket.remoteAddress;
    const userAgent = req.headers["user-agent"];
    ctx.logger.info(`New incoming connection from ${clientIp} (${userAgent || "no user-agent"})`);

    ws.on("error", (err) => {
      ctx.logger.warn(`WebSocket error for client ${clientIp}: ${err.message}`);
    });

    ws.on("close", (code, reason) => {
      ctx.logger.info(`WebSocket closed for client ${clientIp}: code=${code}, reason=${reason}`);
    });

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
      ctx.logger.info(`Connection status for ${url}: ${event.status}`);
    });

    provider.on("sync", (synced: boolean) => {
      ctx.logger.info(`Sync event for ${url}: synced=${synced}`);
      if (synced) {
        ctx.logger.info(`Successfully synced with ${url}`);
        // Fire doc-ready on first successful sync (edge mode)
        fireDocReady();
      }
    });

    // Add error handler for debugging
    provider.on("connection-error", (event: any) => {
      ctx.logger.warn(`Connection error to ${url}: ${event?.message || JSON.stringify(event)}`);
    });

    // Log when connection closes
    provider.on("connection-close", (event: any) => {
      ctx.logger.warn(`Connection closed to ${url}: code=${event?.code}, reason=${event?.reason}`);
    });

    providers.push(provider);
  } catch (err) {
    ctx.logger.warn(`Failed to connect to ${url}: ${err}`);
  }
}

// ============================================================================
// Persistence
// ============================================================================

function validateStatePath(stateDir: string): string {
  const statePath = path.resolve(path.join(stateDir, STATE_FILE));
  const resolvedDir = path.resolve(stateDir);
  if (!statePath.startsWith(resolvedDir)) {
    throw new Error("Invalid state path: path traversal detected");
  }
  return statePath;
}

async function loadPersistedState(ctx: ServiceContext) {
  if (!doc) return;

  const statePath = validateStatePath(ctx.stateDir);

  try {
    if (fs.existsSync(statePath)) {
      const stats = fs.statSync(statePath);
      if (stats.size > VALIDATION_LIMITS.maxStateFileBytes) {
        ctx.logger.warn(`State file too large (${stats.size} bytes), skipping load`);
        return;
      }
      const data = fs.readFileSync(statePath);
      Y.applyUpdate(doc, new Uint8Array(data));
      ctx.logger.info(`Loaded Ansible state from ${statePath} (${data.length} bytes)`);
    }
  } catch (err) {
    ctx.logger.warn(`Failed to load persisted state: ${err}`);
  }
}

async function persistState(ctx: ServiceContext) {
  if (!doc) return;

  const statePath = validateStatePath(ctx.stateDir);

  try {
    // Ensure directory exists
    fs.mkdirSync(ctx.stateDir, { recursive: true });

    // Compact: create a fresh doc from current state to shed tombstones
    const snapshot = Y.encodeStateAsUpdate(doc);
    const compactDoc = new Y.Doc();
    Y.applyUpdate(compactDoc, snapshot);
    const compacted = Y.encodeStateAsUpdate(compactDoc);
    compactDoc.destroy();

    if (compacted.length > VALIDATION_LIMITS.maxStateFileBytes) {
      ctx.logger.warn(`State too large to persist (${compacted.length} bytes)`);
      return;
    }
    fs.writeFileSync(statePath, Buffer.from(compacted));
    ctx.logger.info(`Persisted Ansible state to ${statePath} (${compacted.length} bytes)`);
  } catch (err) {
    ctx.logger.warn(`Failed to persist state: ${err}`);
  }
}

function setupAutoPersist(ctx: ServiceContext) {
  if (!doc) return;

  // Persist on changes (debounced)
  let persistTimeout: ReturnType<typeof setTimeout> | null = null;

  doc.on("update", (update: Uint8Array) => {
    ctx.logger.debug(`Local doc update: ${update.length} bytes`);
    if (persistTimeout) clearTimeout(persistTimeout);
    persistTimeout = setTimeout(() => {
      persistState(ctx);
    }, 5000); // Persist 5 seconds after last change
  });
}

// ============================================================================
// Heartbeat
// ============================================================================

/**
 * Get or create a nested Y.Map for a node's pulse entry.
 * Using nested Y.Maps means field updates (e.g. lastSeen) are in-place
 * mutations rather than full replacements, avoiding CRDT tombstone buildup.
 */
function getOrCreatePulseMap(pulseRoot: Y.Map<unknown>, id: string): Y.Map<unknown> {
  let entry = pulseRoot.get(id);
  if (!(entry instanceof Y.Map)) {
    const m = new Y.Map<unknown>();
    pulseRoot.set(id, m);
    entry = m;
  }
  return entry as Y.Map<unknown>;
}

function startPulseHeartbeat(ctx: ServiceContext) {
  let pulseMap: Y.Map<unknown> | null = null;

  const updatePulse = () => {
    if (!doc || !nodeId) return;

    // Create the nested Y.Map once, then reuse it
    if (!pulseMap) {
      const pulse = doc.getMap("pulse");
      const existing = pulse.get(nodeId);
      if (existing instanceof Y.Map) {
        pulseMap = existing as Y.Map<unknown>;
      } else {
        pulseMap = new Y.Map<unknown>();
        pulseMap.set("status", "online");
        pulseMap.set("version", "0.1.0");
        pulse.set(nodeId, pulseMap);
      }
    }

    // Only update lastSeen — single field mutation per heartbeat
    pulseMap.set("lastSeen", Date.now());
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
      if (MESSAGE_RETENTION.keepUnread && Array.isArray(msg.readBy) && !msg.readBy.includes(nodeId)) {
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
