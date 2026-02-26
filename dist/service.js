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
import { createServer } from "http";
import { createHash, createPublicKey, verify as cryptoVerify } from "crypto";
import * as fs from "fs";
import * as path from "path";
// @ts-expect-error - y-websocket/bin/utils is CommonJS
import { setupWSConnection, getYDoc } from "y-websocket/bin/utils";
import { MESSAGE_RETENTION, VALIDATION_LIMITS } from "./schema.js";
import { consumeInviteForNode, consumeWsTicket, mintWsTicketFromInvite } from "./admission.js";
// Singleton state
let doc = null;
let nodeId = null;
let wsServer = null;
let authServer = null;
let providers = [];
let heartbeatInterval = null;
let cleanupInterval = null;
let isBackboneMode = false;
let docReady = false;
let docReadyCallbacks = [];
let syncCallbacks = [];
const AUTH_REPLAY_MAP = "authReplay";
const AUTH_REPLAY_PREFIX = "exchange:";
const AUTH_REPLAY_TTL_MS = 5 * 60_000;
const AUTH_RATE_WINDOW_DEFAULT_SEC = 60;
const AUTH_RATE_MAX_DEFAULT = 30;
const HEARTBEAT_INTERVAL_MS = 30_000;
const CLEANUP_INTERVAL_MS = 60_000; // Run cleanup every minute
const STATE_FILE = "ansible-state.yjs";
/**
 * Get the shared Yjs document
 * For backbone: returns the y-websocket managed doc
 * For edge: returns our local doc (synced via WebsocketProvider)
 */
export function getDoc() {
    // If backbone mode, try to get the y-websocket managed doc
    if (isBackboneMode && !doc) {
        try {
            const wsDoc = getYDoc("ansible-shared");
            return wsDoc;
        }
        catch {
            return null;
        }
    }
    return doc;
}
/**
 * Get this node's Tailscale ID
 */
export function getNodeId() {
    return nodeId;
}
/**
 * Get the current Ansible state from the Yjs document
 */
export function getAnsibleState() {
    if (!doc)
        return null;
    return {
        nodes: doc.getMap("nodes"),
        agents: doc.getMap("agents"),
        pendingInvites: doc.getMap("pendingInvites"),
        tasks: doc.getMap("tasks"),
        messages: doc.getMap("messages"),
        context: doc.getMap("context"),
        pulse: doc.getMap("pulse"),
        coordination: doc.getMap("coordination"),
    };
}
/**
 * Register a callback to run once the Yjs doc is initialized and ready.
 * If the doc is already ready, the callback fires immediately.
 */
export function onDocReady(cb) {
    if (docReady) {
        cb();
    }
    else {
        docReadyCallbacks.push(cb);
    }
}
/**
 * Register a callback for provider sync events (edge) and startup sync (backbone).
 *
 * This is used by the dispatcher to reconcile backlog on reconnect.
 */
export function onSync(cb) {
    syncCallbacks.push(cb);
}
function fireDocReady() {
    if (docReady)
        return;
    docReady = true;
    for (const cb of docReadyCallbacks) {
        try {
            cb();
        }
        catch {
            // Swallow — individual callbacks shouldn't break startup
        }
    }
    docReadyCallbacks = [];
}
function fireSync(synced, peer) {
    for (const cb of syncCallbacks) {
        try {
            cb(synced, peer);
        }
        catch {
            // Swallow — individual callbacks shouldn't break sync loop
        }
    }
}
/**
 * Create the Ansible sync service
 */
export function createAnsibleService(_api, config) {
    return {
        id: "ansible-sync",
        async start(ctx) {
            ctx.logger.info("Ansible sync service starting...");
            // Determine node id for mesh addressing.
            if (config.nodeIdOverride && typeof config.nodeIdOverride === "string") {
                nodeId = config.nodeIdOverride;
                ctx.logger.info(`Ansible node ID override: ${nodeId}`);
            }
            else {
                // Get our Tailscale node ID
                nodeId = await detectTailscaleId();
                if (!nodeId) {
                    ctx.logger.warn("Could not detect Tailscale ID, using hostname");
                    const os = await import("os");
                    nodeId = os.hostname();
                }
            }
            ctx.logger.info(`Ansible node ID: ${nodeId}`);
            if (config.tier === "backbone") {
                // Backbone mode: Start server first, then get the y-websocket managed doc
                await startBackboneMode(ctx, config);
                // Get the doc created by y-websocket utils
                doc = getYDoc("ansible-shared");
            }
            else {
                // Edge mode: Create our own doc that will be synced via WebsocketProvider
                doc = new Y.Doc();
                // Add error handler for debugging sync issues
                doc.on("update", (update, origin) => {
                    ctx.logger.debug(`Doc update received, size: ${update.length}, origin: ${origin}`);
                });
                // Initialize Yjs maps BEFORE loading state or connecting
                doc.getMap("nodes");
                doc.getMap("agents");
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
                doc.getMap("agents");
                doc.getMap("pendingInvites");
                doc.getMap("tasks");
                doc.getMap("messages");
                doc.getMap("context");
                doc.getMap("pulse");
                doc.getMap("coordination");
            }
            // Auto-register internal agents from config
            registerInternalAgents(config, nodeId, doc);
            // Sync config capabilities into the nodes CRDT map.
            // Capabilities are written to the nodes map only at bootstrap/join time, so
            // they go stale when the config is updated (e.g. adding 'admin') without
            // a fresh join. This keeps the CRDT current with the config on every startup.
            syncNodeCapabilities(config, nodeId, doc);
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
                // Treat backbone startup as "synced" for consumers that want to reconcile.
                fireSync(true, "backbone");
            }
        },
        async stop(ctx) {
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
            if (authServer) {
                authServer.close();
                authServer = null;
            }
            doc = null;
            nodeId = null;
            docReady = false;
            docReadyCallbacks = [];
            syncCallbacks = [];
            ctx.logger.info("Ansible sync service stopped");
        },
    };
}
// ============================================================================
// Tailscale Detection
// ============================================================================
async function detectTailscaleId() {
    try {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync("tailscale", ["status", "--json"]);
        const status = JSON.parse(stdout);
        return status.Self?.HostName || null;
    }
    catch {
        return null;
    }
}
async function getTailscaleIP() {
    try {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync("tailscale", ["ip", "-4"]);
        return stdout.trim() || null;
    }
    catch {
        return null;
    }
}
// ============================================================================
// Backbone Mode (Server + Peer Connections)
// ============================================================================
async function startBackboneMode(ctx, config) {
    isBackboneMode = true;
    const port = config.listenPort || 1234;
    const authGateEnabled = config.authGate?.enabled === true;
    const nodeIdParam = (config.authGate?.nodeIdParam || "nodeId").trim() || "nodeId";
    const inviteParam = (config.authGate?.inviteParam || "invite").trim() || "invite";
    const ticketParam = (config.authGate?.ticketParam || "ticket").trim() || "ticket";
    const requireTicketForUnknown = config.authGate?.requireTicketForUnknown === true;
    const exchangePath = (config.authGate?.exchangePath || "/ansible/auth/exchange").trim() || "/ansible/auth/exchange";
    const authPort = Number(config.authGate?.authPort || (port + 1));
    const ticketTtlSeconds = Number(config.authGate?.ticketTtlSeconds || 60);
    const requireNodeProof = config.authGate?.requireNodeProof === true;
    const rateLimitMax = Number(config.authGate?.rateLimitMax || AUTH_RATE_MAX_DEFAULT);
    const rateLimitWindowSeconds = Number(config.authGate?.rateLimitWindowSeconds || AUTH_RATE_WINDOW_DEFAULT_SEC);
    // Bind to Tailscale interface for security (only tailnet peers can connect)
    const host = config.listenHost || await getTailscaleIP() || "127.0.0.1";
    ctx.logger.info(`Backbone mode: starting WebSocket server on ${host}:${port}`);
    // Start WebSocket server for incoming connections
    wsServer = new WebSocketServer({ host, port });
    wsServer.on("connection", (ws, req) => {
        if (authGateEnabled) {
            const auth = authorizeBackboneConnection(req.url || "/", nodeIdParam, inviteParam, ticketParam, requireTicketForUnknown);
            if (!auth.allowed) {
                ctx.logger.warn(`Rejected websocket connection: ${auth.reason || "unauthorized"}`);
                try {
                    ws.close(1008, "Unauthorized");
                }
                catch {
                    // Best effort
                }
                return;
            }
        }
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
    if (authGateEnabled) {
        startAuthExchangeServer(ctx, host, authPort, exchangePath, ticketTtlSeconds, requireNodeProof, rateLimitMax, rateLimitWindowSeconds);
    }
    // Connect to other backbone peers
    if (config.backbonePeers?.length) {
        for (const peerUrl of config.backbonePeers) {
            // Skip self (don't connect to our own server)
            if (isSelfUrl(peerUrl, port)) {
                ctx.logger.debug(`Skipping self URL: ${peerUrl}`);
                continue;
            }
            connectToPeer(peerUrl, ctx, config);
        }
    }
}
function isSelfUrl(url, myPort) {
    try {
        const parsed = new URL(url);
        const urlPort = parseInt(parsed.port) || 1234;
        // Check if this is our own port on localhost or our tailscale IP
        if (urlPort !== myPort)
            return false;
        const host = parsed.hostname;
        if (host === "localhost" || host === "127.0.0.1")
            return true;
        // Check if it matches our tailscale hostname
        if (nodeId && host.includes(nodeId))
            return true;
        return false;
    }
    catch {
        return false;
    }
}
// ============================================================================
// Edge Mode (Client Only)
// ============================================================================
async function startEdgeMode(ctx, config) {
    ctx.logger.info("Edge mode: connecting to backbone peers");
    if (!config.backbonePeers?.length) {
        ctx.logger.warn("No backbone peers configured!");
        return;
    }
    // Connect to backbone peers (with failover logic)
    for (const peerUrl of config.backbonePeers) {
        connectToPeer(peerUrl, ctx, config);
    }
}
// ============================================================================
// Yjs Sync
// ============================================================================
function connectToPeer(url, ctx, config) {
    if (!doc)
        return;
    const authNodeIdParam = (config?.authGate?.nodeIdParam || "nodeId").trim() || "nodeId";
    const withNodeId = appendNodeIdQuery(url, authNodeIdParam, nodeId || undefined);
    ctx.logger.info(`Connecting to peer: ${withNodeId}`);
    try {
        // Use y-websocket provider for sync
        const provider = new WebsocketProvider(withNodeId, "ansible-shared", doc, {
            connect: true,
            WebSocketPolyfill: WebSocket,
        });
        provider.on("status", (event) => {
            ctx.logger.info(`Connection status for ${withNodeId}: ${event.status}`);
        });
        provider.on("sync", (synced) => {
            ctx.logger.info(`Sync event for ${withNodeId}: synced=${synced}`);
            fireSync(synced, withNodeId);
            if (synced) {
                ctx.logger.info(`Successfully synced with ${withNodeId}`);
                // Fire doc-ready on first successful sync (edge mode)
                fireDocReady();
            }
        });
        // Add error handler for debugging
        provider.on("connection-error", (event) => {
            ctx.logger.warn(`Connection error to ${withNodeId}: ${event?.message || JSON.stringify(event)}`);
        });
        // Log when connection closes
        provider.on("connection-close", (event) => {
            ctx.logger.warn(`Connection closed to ${withNodeId}: code=${event?.code}, reason=${event?.reason}`);
        });
        providers.push(provider);
    }
    catch (err) {
        ctx.logger.warn(`Failed to connect to ${withNodeId}: ${err}`);
    }
}
function appendNodeIdQuery(rawUrl, paramName, value) {
    if (!value)
        return rawUrl;
    try {
        const parsed = new URL(rawUrl);
        if (!parsed.searchParams.has(paramName)) {
            parsed.searchParams.set(paramName, value);
        }
        return parsed.toString();
    }
    catch {
        return rawUrl;
    }
}
function authorizeBackboneConnection(rawReqUrl, nodeIdParam, inviteParam, ticketParam, requireTicketForUnknown) {
    if (!doc)
        return { allowed: false, reason: "doc_unavailable" };
    let presentedNodeId = "";
    let inviteToken = "";
    let wsTicket = "";
    try {
        const parsed = new URL(rawReqUrl, "ws://ansible.local");
        presentedNodeId = String(parsed.searchParams.get(nodeIdParam) || "").trim();
        inviteToken = String(parsed.searchParams.get(inviteParam) || "").trim();
        wsTicket = String(parsed.searchParams.get(ticketParam) || "").trim();
    }
    catch {
        return { allowed: false, reason: "bad_request_url" };
    }
    if (!presentedNodeId) {
        return { allowed: false, reason: "missing_node_id" };
    }
    const nodes = doc.getMap("nodes");
    const known = nodes.get(presentedNodeId);
    if (known)
        return { allowed: true };
    if (wsTicket) {
        const ticketJoin = consumeWsTicket(doc, wsTicket, presentedNodeId);
        if (!ticketJoin.ok)
            return { allowed: false, reason: ticketJoin.error || "invalid_ticket" };
        return { allowed: true };
    }
    if (requireTicketForUnknown) {
        return { allowed: false, reason: "ticket_required_for_unknown_node" };
    }
    if (!inviteToken) {
        return { allowed: false, reason: "missing_invite_for_unknown_node" };
    }
    const inviteJoin = consumeInviteForNode(doc, inviteToken, presentedNodeId);
    if (!inviteJoin.ok) {
        return { allowed: false, reason: inviteJoin.error || "invite_rejected" };
    }
    return { allowed: true };
}
function startAuthExchangeServer(ctx, host, port, exchangePath, defaultTicketTtlSeconds, requireNodeProof, rateLimitMax, rateLimitWindowSeconds) {
    if (!doc || !nodeId)
        return;
    if (authServer)
        return;
    authServer = createServer((req, res) => {
        if (req.method !== "POST" || (req.url || "").split("?")[0] !== exchangePath) {
            respondJson(res, 404, { error: "not_found" });
            return;
        }
        readJsonBody(req, 16 * 1024)
            .then((body) => {
            const remoteIp = String(req.socket.remoteAddress || "unknown");
            const rate = consumeRateLimitToken(doc, remoteIp, rateLimitMax, rateLimitWindowSeconds);
            if (!rate.allowed) {
                ctx.logger.warn(`Ansible auth exchange denied: rate_limited ip=${remoteIp}`);
                respondJson(res, 429, {
                    error: "rate_limited",
                    retryAfterSeconds: Math.max(1, Math.floor((rate.retryAt - Date.now()) / 1000)),
                });
                return;
            }
            const inviteToken = String(body?.inviteToken || "").trim();
            const joiningNodeId = String(body?.nodeId || "").trim();
            const nonce = String(body?.nonce || "").trim();
            const clientPubKey = String(body?.clientPubKey || "").trim();
            const clientProof = String(body?.clientProof || "").trim();
            const ttlSecondsRaw = Number(body?.ttlSeconds || defaultTicketTtlSeconds);
            const ttlSeconds = Number.isFinite(ttlSecondsRaw) ? ttlSecondsRaw : defaultTicketTtlSeconds;
            if (!inviteToken) {
                respondJson(res, 400, { error: "invalid_request", reason: "inviteToken required" });
                return;
            }
            if (!joiningNodeId) {
                respondJson(res, 400, { error: "invalid_request", reason: "nodeId required" });
                return;
            }
            if (!nonce) {
                respondJson(res, 400, { error: "invalid_request", reason: "nonce required" });
                return;
            }
            const replayKey = `${AUTH_REPLAY_PREFIX}${joiningNodeId}:${nonce}`;
            if (!claimReplayKey(doc, replayKey, AUTH_REPLAY_TTL_MS)) {
                ctx.logger.warn(`Ansible auth exchange denied: replay_detected node=${joiningNodeId}`);
                respondJson(res, 409, { error: "replay_detected" });
                return;
            }
            if (requireNodeProof || (clientPubKey && clientProof)) {
                const proofOk = verifyNodeProof(inviteToken, joiningNodeId, nonce, clientPubKey, clientProof);
                if (!proofOk.ok) {
                    ctx.logger.warn(`Ansible auth exchange denied: node_proof_invalid node=${joiningNodeId}`);
                    respondJson(res, 401, { error: "node_proof_invalid", reason: proofOk.error });
                    return;
                }
            }
            const out = mintWsTicketFromInvite(doc, nodeId, inviteToken, joiningNodeId, ttlSeconds * 1000);
            if ("error" in out) {
                const code = out.error.includes("expired") ? 401 :
                    out.error.includes("bound to node") ? 403 :
                        401;
                ctx.logger.warn(`Ansible auth exchange denied: exchange_failed node=${joiningNodeId} reason=${out.error}`);
                respondJson(res, code, { error: "exchange_failed", reason: out.error });
                return;
            }
            const pubKeyFingerprint = clientPubKey ? createHash("sha256").update(clientPubKey).digest("hex").slice(0, 16) : undefined;
            ctx.logger.info(`Ansible auth exchange success node=${joiningNodeId} ip=${remoteIp} ttl=${ttlSeconds}s${pubKeyFingerprint ? ` key=${pubKeyFingerprint}` : ""}`);
            respondJson(res, 200, {
                ticket: out.ticket,
                expiresAt: out.expiresAt,
                nodeId: joiningNodeId,
                exchangePath,
                proofRequired: requireNodeProof,
            });
        })
            .catch((err) => {
            respondJson(res, 400, { error: "invalid_json", reason: String(err?.message || err) });
        });
    });
    authServer.on("error", (err) => {
        ctx.logger.warn(`Auth exchange server error: ${err?.message || String(err)}`);
    });
    authServer.listen(port, host, () => {
        ctx.logger.info(`Auth exchange server listening on ${host}:${port}${exchangePath}`);
    });
}
function respondJson(res, code, payload) {
    const body = `${JSON.stringify(payload)}\n`;
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(body);
}
async function readJsonBody(req, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buf.length;
        if (size > maxBytes) {
            throw new Error("request_too_large");
        }
        chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw)
        return {};
    return JSON.parse(raw);
}
function claimReplayKey(doc, key, ttlMs) {
    const map = doc.getMap(AUTH_REPLAY_MAP);
    pruneReplayKeys(map);
    const now = Date.now();
    const existing = map.get(key);
    if (existing && typeof existing.exp === "number" && existing.exp > now)
        return false;
    map.set(key, { exp: now + ttlMs, at: now });
    return true;
}
function pruneReplayKeys(map, now = Date.now()) {
    for (const [k, raw] of map.entries()) {
        const rec = raw;
        if (!rec || typeof rec.exp !== "number" || rec.exp <= now)
            map.delete(k);
    }
}
function consumeRateLimitToken(doc, remoteIp, maxPerWindow, windowSeconds) {
    const map = doc.getMap("authRate");
    const key = `ip:${remoteIp}`;
    const now = Date.now();
    const windowMs = Math.max(5, Math.floor(windowSeconds)) * 1000;
    const max = Math.max(1, Math.floor(maxPerWindow));
    const rec = map.get(key) || {};
    let start = typeof rec.start === "number" ? rec.start : now;
    let count = typeof rec.count === "number" ? rec.count : 0;
    if (now - start >= windowMs) {
        start = now;
        count = 0;
    }
    if (count >= max) {
        return { allowed: false, retryAt: start + windowMs };
    }
    map.set(key, { start, count: count + 1, updatedAt: now });
    return { allowed: true, retryAt: now };
}
function verifyNodeProof(inviteToken, nodeId, nonce, clientPubKey, clientProof) {
    if (!clientPubKey)
        return { ok: false, error: "clientPubKey required" };
    if (!clientProof)
        return { ok: false, error: "clientProof required" };
    let key;
    try {
        key = createPublicKey(clientPubKey);
    }
    catch {
        return { ok: false, error: "invalid clientPubKey" };
    }
    let sig;
    try {
        sig = Buffer.from(clientProof, "base64");
    }
    catch {
        return { ok: false, error: "invalid clientProof encoding" };
    }
    const data = Buffer.from(`ansible-auth-exchange|${inviteToken}|${nodeId}|${nonce}`, "utf8");
    try {
        const ok = cryptoVerify(null, data, key, sig);
        if (!ok)
            return { ok: false, error: "signature verification failed" };
    }
    catch {
        return { ok: false, error: "signature verification error" };
    }
    return { ok: true };
}
// ============================================================================
// Persistence
// ============================================================================
function validateStatePath(stateDir) {
    const statePath = path.resolve(path.join(stateDir, STATE_FILE));
    const resolvedDir = path.resolve(stateDir);
    if (!statePath.startsWith(resolvedDir)) {
        throw new Error("Invalid state path: path traversal detected");
    }
    return statePath;
}
async function loadPersistedState(ctx) {
    if (!doc)
        return;
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
    }
    catch (err) {
        ctx.logger.warn(`Failed to load persisted state: ${err}`);
    }
}
async function persistState(ctx) {
    if (!doc)
        return;
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
    }
    catch (err) {
        ctx.logger.warn(`Failed to persist state: ${err}`);
    }
}
/**
 * Auto-register internal agents from the ansible config's injectContextAgents list.
 * This seeds the Yjs agents map so all gateways know which agents are local to each node.
 * External agents (claude, codex) are registered separately via the CLI or tool.
 */
function registerInternalAgents(config, nodeId, yjsDoc) {
    const agents = yjsDoc.getMap("agents");
    const agentIds = Array.isArray(config.injectContextAgents)
        ? config.injectContextAgents
        : [];
    // Always include the node itself as an internal agent
    const allAgentIds = Array.from(new Set([nodeId, ...agentIds]));
    for (const agentId of allAgentIds) {
        // Don't overwrite external agents registered by operators
        const existing = agents.get(agentId);
        if (existing?.type === "external")
            continue;
        agents.set(agentId, {
            gateway: nodeId,
            type: "internal",
            registeredAt: existing?.registeredAt ?? Date.now(),
            registeredBy: nodeId,
        });
    }
}
function setupAutoPersist(ctx) {
    if (!doc)
        return;
    // Persist on changes (debounced)
    let persistTimeout = null;
    doc.on("update", (update) => {
        ctx.logger.debug(`Local doc update: ${update.length} bytes`);
        if (persistTimeout)
            clearTimeout(persistTimeout);
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
function isYMapLike(value) {
    return !!value && typeof value === "object" &&
        typeof value.get === "function" &&
        typeof value.set === "function";
}
function getOrCreatePulseMap(pulseRoot, id) {
    let entry = pulseRoot.get(id);
    if (!isYMapLike(entry)) {
        const m = new Y.Map();
        pulseRoot.set(id, m);
        entry = m;
    }
    return entry;
}
function syncNodeCapabilities(config, nodeId, doc) {
    const configCaps = Array.isArray(config.capabilities) ? config.capabilities : [];
    const nodes = doc.getMap("nodes");
    const existing = nodes.get(nodeId);
    if (!existing) {
        // Node not in the map — self-register. Handles cases where the nodes CRDT was
        // cleared (e.g., state wipe) or bootstrap/join was never completed. Each node
        // registers itself; CRDT merges automatically across the mesh.
        nodes.set(nodeId, {
            name: nodeId,
            tier: config.tier,
            capabilities: configCaps,
            addedBy: nodeId,
            addedAt: Date.now(),
        });
        return;
    }
    // Node exists — merge any config capabilities not yet in the CRDT entry.
    if (configCaps.length === 0)
        return;
    const crdtCaps = Array.isArray(existing.capabilities) ? existing.capabilities : [];
    const missing = configCaps.filter((c) => !crdtCaps.includes(c));
    if (missing.length === 0)
        return;
    nodes.set(nodeId, { ...existing, capabilities: [...crdtCaps, ...missing] });
}
function startPulseHeartbeat(ctx) {
    const updatePulse = () => {
        if (!doc || !nodeId)
            return;
        const pulse = doc.getMap("pulse");
        const pulseMap = getOrCreatePulseMap(pulse, nodeId);
        // Always set status online on heartbeat. We set offline on shutdown; on restart
        // we must flip back to online or presence will look "dead but ticking".
        pulseMap.set("status", "online");
        pulseMap.set("version", "0.1.0");
        // Update lastSeen — single field mutation per heartbeat
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
function startMessageCleanup(ctx) {
    const runCleanup = () => {
        if (!doc || !nodeId)
            return;
        const messages = doc.getMap("messages");
        const now = Date.now();
        const maxAgeMs = MESSAGE_RETENTION.maxAgeHours * 60 * 60 * 1000;
        const cutoff = now - maxAgeMs;
        // Collect messages to potentially delete
        const allMessages = [];
        for (const [id, msg] of messages.entries()) {
            allMessages.push({ id, msg: msg });
        }
        // Sort by timestamp (oldest first)
        allMessages.sort((a, b) => a.msg.timestamp - b.msg.timestamp);
        let deleted = 0;
        const toDelete = [];
        for (const { id, msg } of allMessages) {
            // Skip unread messages for *this node* if configured to keep them.
            //
            // Important: do NOT "protect" messages addressed to some other node
            // just because *we* haven't marked them as read. Otherwise, a backbone
            // node will accumulate phantom unread messages forever and status/sweeps
            // become untrustworthy.
            if (MESSAGE_RETENTION.keepUnread && Array.isArray(msg.readBy_agents)) {
                const addressedToMe = !msg.to_agents?.length || msg.to_agents.includes(nodeId);
                const unreadForMe = addressedToMe && !msg.readBy_agents.includes(nodeId);
                if (unreadForMe)
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
//# sourceMappingURL=service.js.map