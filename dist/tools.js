/**
 * Ansible Agent Tools
 *
 * Tools available to the agent for inter-hemisphere coordination.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { VALIDATION_LIMITS } from "./schema.js";
import { getDoc, getNodeId, getAnsibleState } from "./service.js";
import { requestDispatcherReconcile } from "./dispatcher.js";
import { isNodeAuthorized } from "./auth.js";
import { getLockSweepStatus } from "./lock-sweep.js";
import { runSlaSweep } from "./sla.js";
/**
 * Wrap a tool result in the AgentToolResult format expected by pi-agent-core.
 * Tools must return { content: [{type: "text", text: "..."}], details: T }
 * or the toolResult message will be missing its content field, causing
 * pi-ai providers to crash with "Cannot read properties of undefined (reading 'filter')".
 */
function toolResult(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        details: data,
    };
}
function isMapLike(value) {
    return (!!value &&
        typeof value === "object" &&
        typeof value.entries === "function" &&
        typeof value.get === "function" &&
        typeof value.set === "function");
}
function serializeValue(value, seen = new WeakSet()) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        return value;
    if (typeof value === "bigint")
        return value.toString();
    if (value instanceof Date)
        return value.toISOString();
    if (Array.isArray(value))
        return value.map((v) => serializeValue(v, seen));
    if (typeof value === "object") {
        if (seen.has(value))
            return "[Circular]";
        seen.add(value);
        if (isMapLike(value)) {
            const out = {};
            for (const [k, v] of value.entries()) {
                out[String(k)] = serializeValue(v, seen);
            }
            return out;
        }
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = serializeValue(v, seen);
        }
        return out;
    }
    return String(value);
}
function validateString(value, maxLength, fieldName) {
    if (typeof value !== "string") {
        throw new Error(`${fieldName} must be a string`);
    }
    if (value.length > maxLength) {
        throw new Error(`${fieldName} exceeds max length of ${maxLength}`);
    }
    return value;
}
function validateNumber(value, fieldName) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${fieldName} must be a finite number`);
    }
    return value;
}
function requireAuth(nodeId) {
    if (!isNodeAuthorized(nodeId)) {
        throw new Error("Node not authorized. Use 'ansible join' first.");
    }
}
function getAuthMode(config) {
    const mode = config?.authMode;
    if (mode === "legacy" || mode === "token-required")
        return mode;
    return "mixed";
}
function hashAgentToken(token) {
    return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}
function tokenHintFromHash(hash) {
    const normalized = String(hash || "");
    const hex = normalized.startsWith("sha256:") ? normalized.slice("sha256:".length) : normalized;
    if (!hex)
        return "";
    return `sha256:${hex.slice(0, 12)}`;
}
function mintAgentToken() {
    return `at_${randomBytes(24).toString("hex")}`;
}
function mintAgentInviteToken() {
    return `ait_${randomBytes(20).toString("hex")}`;
}
function safeEqual(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length)
        return false;
    return timingSafeEqual(ab, bb);
}
function resolveAgentByToken(doc, token) {
    if (!doc)
        return null;
    const agents = doc.getMap("agents");
    const want = hashAgentToken(token);
    for (const [id, raw] of agents.entries()) {
        const rec = raw;
        if (rec && typeof rec.disabledAt === "number")
            continue;
        const auth = rec?.auth || undefined;
        const tokenHash = typeof auth?.tokenHash === "string" ? auth.tokenHash : "";
        if (!tokenHash)
            continue;
        if (safeEqual(tokenHash, want))
            return String(id);
    }
    return null;
}
function getAgentInvitesMap(doc) {
    if (!doc)
        return null;
    return doc.getMap("agentInvites");
}
function pruneExpiredAgentInvites(invites) {
    if (!invites)
        return 0;
    let removed = 0;
    const now = Date.now();
    for (const [id, raw] of invites.entries()) {
        const invite = raw;
        if (!invite)
            continue;
        if (invite.usedAt || invite.revokedAt)
            continue;
        if (typeof invite.expiresAt === "number" && invite.expiresAt < now) {
            invites.delete(String(id));
            removed += 1;
        }
    }
    return removed;
}
function findInviteByToken(invites, inviteToken) {
    if (!invites)
        return null;
    const want = hashAgentToken(inviteToken);
    const now = Date.now();
    for (const [id, raw] of invites.entries()) {
        const invite = raw;
        if (!invite || typeof invite.tokenHash !== "string")
            continue;
        if (invite.usedAt || invite.revokedAt)
            continue;
        if (typeof invite.expiresAt === "number" && invite.expiresAt < now)
            continue;
        if (safeEqual(invite.tokenHash, want)) {
            return { id: String(id), invite };
        }
    }
    return null;
}
function requireAdmin(nodeId, doc) {
    const nodes = doc?.getMap("nodes");
    const me = nodes?.get(nodeId);
    const caps = Array.isArray(me?.capabilities) ? me.capabilities : [];
    if (!caps.includes("admin")) {
        throw new Error("Admin capability required for this destructive operation. Add capability 'admin' to this node configuration.");
    }
}
function canonicalGatewayId(input) {
    const raw = String(input || "").trim().toLowerCase();
    if (!raw)
        return "";
    const dashed = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!dashed)
        return "";
    return dashed.endsWith("-host") ? dashed.slice(0, -5) : dashed;
}
function gatewayMatchesNode(recordGateway, nodeId) {
    if (typeof recordGateway !== "string")
        return false;
    if (recordGateway === nodeId)
        return true;
    return canonicalGatewayId(recordGateway) === canonicalGatewayId(nodeId);
}
/**
 * Resolve the effective admin actor for a privileged operation.
 *
 * Secure path (always allowed): agent_token present → resolve via token hash.
 * Bootstrap path (internal agents only): no token, but from_agent is an internal
 * agent running on this node. Gateway-level auth is sufficient — internal agents
 * cannot be impersonated by external callers.
 * External agents must always supply agent_token.
 */
function resolveAdminActorOrError(doc, nodeId, token, requestedFrom) {
    if (token) {
        const tokenActor = resolveAgentByToken(doc, token);
        if (!tokenActor)
            return { error: "Invalid agent_token." };
        if (requestedFrom && requestedFrom.trim() && requestedFrom.trim() !== tokenActor) {
            return { error: "from_agent does not match token identity. Omit from_agent when using agent_token." };
        }
        return { actor: tokenActor };
    }
    // No token: only permit internal agents running on this node (bootstrap path).
    const from = (requestedFrom || "").trim();
    if (!from) {
        return { error: "agent_token is required, or provide from_agent if acting as an internal agent on this node." };
    }
    const agents = doc?.getMap("agents");
    const rec = agents?.get(from);
    if (!rec) {
        return { error: `Agent '${from}' is not registered. Use agent_token or register the agent first.` };
    }
    if (typeof rec.disabledAt === "number") {
        return { error: `Agent '${from}' is disabled.` };
    }
    if (rec.type !== "internal" || !gatewayMatchesNode(rec.gateway, nodeId)) {
        return { error: `agent_token is required for '${from}' (external agents or agents on other nodes must provide a token).` };
    }
    return { actor: from };
}
function requireAdminActor(doc, nodeId, adminAgentId, requestedFrom) {
    const from = (requestedFrom || "").trim();
    if (!from) {
        throw new Error(`from_agent is required for this operation and must be '${adminAgentId}'.`);
    }
    if (from !== adminAgentId) {
        throw new Error(`from_agent must be '${adminAgentId}' for this operation (got '${from}').`);
    }
    const agents = doc?.getMap("agents");
    const rec = agents?.get(from);
    if (!rec) {
        throw new Error(`Admin agent '${adminAgentId}' is not registered. Register it with ansible_register_agent first.`);
    }
    const t = String(rec.type || "");
    if (typeof rec.disabledAt === "number") {
        throw new Error(`Admin agent '${adminAgentId}' is disabled.`);
    }
    if (t === "external")
        return;
    if (t === "internal") {
        // Token-authenticated internal admin agents are allowed even if their recorded
        // gateway id lags behind a node-rename event (e.g., vps-jane-host -> vps-jane).
        // This keeps bootstrap/admin continuity during topology migrations.
        return;
    }
    throw new Error(`Admin agent '${adminAgentId}' has unsupported type '${t}'.`);
}
function requireInternalCapabilityPublisher(doc, _nodeId, actorAgentId) {
    const agents = doc?.getMap("agents");
    const rec = agents?.get(actorAgentId);
    if (!rec) {
        throw new Error(`Actor agent '${actorAgentId}' is not registered.`);
    }
    if (rec.type !== "internal") {
        throw new Error("Capability publish/unpublish requires an internal agent identity. External tokens are not allowed.");
    }
}
function getCoordinationMap(doc) {
    return doc?.getMap("coordination");
}
function readCoordinationState(doc) {
    const m = getCoordinationMap(doc);
    if (!m)
        return null;
    return {
        coordinator: m.get("coordinator"),
        sweepEverySeconds: m.get("sweepEverySeconds"),
        retentionClosedTaskSeconds: m.get("retentionClosedTaskSeconds"),
        retentionPruneEverySeconds: m.get("retentionPruneEverySeconds"),
        retentionLastPruneAt: m.get("retentionLastPruneAt"),
        delegationPolicyVersion: m.get("delegationPolicyVersion"),
        delegationPolicyChecksum: m.get("delegationPolicyChecksum"),
        delegationPolicyUpdatedAt: m.get("delegationPolicyUpdatedAt"),
        delegationPolicyUpdatedBy: m.get("delegationPolicyUpdatedBy"),
        updatedAt: m.get("updatedAt"),
        updatedBy: m.get("updatedBy"),
    };
}
function computeSha256(text) {
    return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
function readDelegationAcks(m) {
    const out = {};
    for (const [k, v] of m.entries()) {
        const key = String(k);
        if (!key.startsWith("delegationAck:"))
            continue;
        const parts = key.split(":");
        if (parts.length < 3)
            continue;
        const agentId = parts[1];
        const field = parts[2];
        out[agentId] = out[agentId] || {};
        if (field === "version")
            out[agentId].version = typeof v === "string" ? v : undefined;
        if (field === "checksum")
            out[agentId].checksum = typeof v === "string" ? v : undefined;
        if (field === "at")
            out[agentId].at = typeof v === "number" ? v : undefined;
    }
    return out;
}
const OWNER_LEASE_STALE_MS = 90_000;
function getCapabilityCatalogMap(doc) {
    return doc?.getMap("capabilitiesCatalog");
}
function getCapabilityIndexMap(doc) {
    return doc?.getMap("capabilitiesIndex");
}
function getCapabilityManifestMap(doc) {
    return doc?.getMap("capabilitiesManifests");
}
function getCapabilityRevisionMap(doc) {
    return doc?.getMap("capabilitiesRevisions");
}
function validateSkillRef(value, fieldName) {
    const v = (value || {});
    const name = validateString(v.name, 200, `${fieldName}.name`).trim();
    const version = validateString(v.version, 120, `${fieldName}.version`).trim();
    const out = { name, version };
    if (typeof v.path === "string" && v.path.trim().length > 0)
        out.path = v.path.trim();
    return out;
}
function deepSortObject(value) {
    if (Array.isArray(value))
        return value.map((v) => deepSortObject(v));
    if (!value || typeof value !== "object")
        return value;
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    const out = {};
    for (const [k, v] of entries)
        out[k] = deepSortObject(v);
    return out;
}
function checksumPayloadForManifest(manifest) {
    const payload = JSON.parse(JSON.stringify(manifest));
    payload.provenance = {
        ...payload.provenance,
        manifestChecksum: "",
        manifestSignature: "",
    };
    const canonical = JSON.stringify(deepSortObject(payload));
    return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
function validateSkillPairManifest(value) {
    const v = (value || {});
    const manifestVersion = validateString(v.manifestVersion, 32, "manifestVersion");
    if (manifestVersion !== "1.0.0")
        throw new Error("manifestVersion must be '1.0.0'");
    const capabilityId = validateString(v.capabilityId, 160, "capabilityId").trim();
    if (!/^cap\.[a-z0-9][a-z0-9._-]*$/.test(capabilityId)) {
        throw new Error("capabilityId must match ^cap\\.[a-z0-9][a-z0-9._-]*$");
    }
    const version = validateString(v.version, 120, "version").trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
        throw new Error("version must be semver-like (x.y.z)");
    }
    const ownerAgentId = validateString(v.ownerAgentId, 100, "ownerAgentId").trim();
    const standbyOwnerAgentIds = cleanStringArray(v.standbyOwnerAgentIds);
    if (standbyOwnerAgentIds.includes(ownerAgentId)) {
        throw new Error("standbyOwnerAgentIds cannot include ownerAgentId");
    }
    const compatibilityMode = validateString(v.compatibilityMode, 40, "compatibilityMode").trim();
    if (!["strict", "backward", "legacy-window"].includes(compatibilityMode)) {
        throw new Error("compatibilityMode must be strict|backward|legacy-window");
    }
    const delegationSkillRef = validateSkillRef(v.delegationSkillRef, "delegationSkillRef");
    const executorSkillRef = validateSkillRef(v.executorSkillRef, "executorSkillRef");
    if (v.delegationSkillRef && typeof v.delegationSkillRef.source === "string") {
        delegationSkillRef.source = validateString(v.delegationSkillRef.source, 400, "delegationSkillRef.source").trim();
    }
    if (v.executorSkillRef && typeof v.executorSkillRef.source === "string") {
        executorSkillRef.source = validateString(v.executorSkillRef.source, 400, "executorSkillRef.source").trim();
    }
    const contractRaw = (v.contract || {});
    const contract = {
        inputSchemaRef: validateString(contractRaw.inputSchemaRef, 400, "contract.inputSchemaRef").trim(),
        outputSchemaRef: validateString(contractRaw.outputSchemaRef, 400, "contract.outputSchemaRef").trim(),
        ackSchemaRef: validateString(contractRaw.ackSchemaRef, 400, "contract.ackSchemaRef").trim(),
    };
    const slaRaw = (v.sla || {});
    const sla = {
        acceptSlaSeconds: Math.floor(validateNumber(slaRaw.acceptSlaSeconds, "sla.acceptSlaSeconds")),
        progressSlaSeconds: Math.floor(validateNumber(slaRaw.progressSlaSeconds, "sla.progressSlaSeconds")),
        completeSlaSeconds: Math.floor(validateNumber(slaRaw.completeSlaSeconds, "sla.completeSlaSeconds")),
    };
    if (sla.acceptSlaSeconds < 10 || sla.acceptSlaSeconds > 3600)
        throw new Error("sla.acceptSlaSeconds out of range (10..3600)");
    if (sla.progressSlaSeconds < 30 || sla.progressSlaSeconds > 86400)
        throw new Error("sla.progressSlaSeconds out of range (30..86400)");
    if (sla.completeSlaSeconds < 60 || sla.completeSlaSeconds > 604800)
        throw new Error("sla.completeSlaSeconds out of range (60..604800)");
    const riskClass = validateString(v.riskClass, 20, "riskClass").trim();
    if (!["low", "medium", "high"].includes(riskClass))
        throw new Error("riskClass must be low|medium|high");
    const rolloutRaw = (v.rollout || {});
    const rolloutMode = validateString(rolloutRaw.mode, 20, "rollout.mode").trim();
    if (!["canary", "full"].includes(rolloutMode))
        throw new Error("rollout.mode must be canary|full");
    const rollout = {
        mode: rolloutMode,
        canaryTargets: cleanStringArray(rolloutRaw.canaryTargets),
    };
    const governanceRaw = (v.governance || {});
    if (typeof governanceRaw.requiresHumanApprovalForHighRisk !== "boolean") {
        throw new Error("governance.requiresHumanApprovalForHighRisk must be boolean");
    }
    if (typeof governanceRaw.signedManifestRequired !== "boolean") {
        throw new Error("governance.signedManifestRequired must be boolean");
    }
    const governance = {
        requiresHumanApprovalForHighRisk: governanceRaw.requiresHumanApprovalForHighRisk,
        signedManifestRequired: governanceRaw.signedManifestRequired,
    };
    if (riskClass === "high" && !governance.requiresHumanApprovalForHighRisk) {
        throw new Error("riskClass=high requires governance.requiresHumanApprovalForHighRisk=true");
    }
    const provRaw = (v.provenance || {});
    const provenance = {
        publishedByAgentId: validateString(provRaw.publishedByAgentId, 100, "provenance.publishedByAgentId").trim(),
        manifestChecksum: validateString(provRaw.manifestChecksum, 100, "provenance.manifestChecksum").trim(),
        manifestSignature: validateString(provRaw.manifestSignature, 8192, "provenance.manifestSignature").trim(),
        publishedAt: validateString(provRaw.publishedAt, 64, "provenance.publishedAt").trim(),
    };
    if (!/^sha256:[a-f0-9]{64}$/.test(provenance.manifestChecksum)) {
        throw new Error("provenance.manifestChecksum must match sha256:<64-hex>");
    }
    if (Date.parse(provenance.publishedAt) !== Date.parse(provenance.publishedAt)) {
        throw new Error("provenance.publishedAt must be ISO-8601 datetime");
    }
    if (governance.signedManifestRequired && provenance.manifestSignature.length < 32) {
        throw new Error("provenance.manifestSignature too short for signed manifest");
    }
    const manifest = {
        manifestVersion: "1.0.0",
        capabilityId,
        version,
        ownerAgentId,
        standbyOwnerAgentIds,
        compatibilityMode,
        delegationSkillRef,
        executorSkillRef,
        contract,
        sla,
        riskClass,
        rollout,
        governance,
        provenance,
    };
    const expectedChecksum = checksumPayloadForManifest(manifest);
    if (provenance.manifestChecksum !== expectedChecksum) {
        throw new Error("provenance.manifestChecksum does not match canonicalized manifest payload");
    }
    return manifest;
}
function buildManifestFromLegacyParams(params, publishedByAgentId, nowIso) {
    const capabilityId = validateString(params.capability_id, 160, "capability_id").trim();
    const version = validateString(params.version, 120, "version").trim();
    const ownerAgentId = validateString(params.owner_agent_id, 100, "owner_agent_id").trim();
    const delegationSkillRef = validateSkillRef(params.delegation_skill_ref, "delegation_skill_ref");
    const executorSkillRef = validateSkillRef(params.executor_skill_ref, "executor_skill_ref");
    const contractSchemaRef = validateString(params.contract_schema_ref, 400, "contract_schema_ref").trim();
    const etaRaw = params.default_eta_seconds === undefined ? 900 : validateNumber(params.default_eta_seconds, "default_eta_seconds");
    const defaultEtaSeconds = Math.floor(etaRaw);
    if (defaultEtaSeconds < 30 || defaultEtaSeconds > 86400) {
        throw new Error("default_eta_seconds must be between 30 and 86400");
    }
    const manifest = {
        manifestVersion: "1.0.0",
        capabilityId,
        version,
        ownerAgentId,
        standbyOwnerAgentIds: [],
        compatibilityMode: "strict",
        delegationSkillRef,
        executorSkillRef,
        contract: {
            inputSchemaRef: contractSchemaRef,
            outputSchemaRef: contractSchemaRef,
            ackSchemaRef: "schema://ansible/ack/1.0.0",
        },
        sla: {
            acceptSlaSeconds: 120,
            progressSlaSeconds: Math.max(300, Math.min(86400, defaultEtaSeconds)),
            completeSlaSeconds: Math.max(900, Math.min(604800, defaultEtaSeconds * 2)),
        },
        riskClass: "medium",
        rollout: {
            mode: "full",
            canaryTargets: [],
        },
        governance: {
            requiresHumanApprovalForHighRisk: true,
            signedManifestRequired: false,
        },
        provenance: {
            publishedByAgentId,
            manifestChecksum: "",
            manifestSignature: `unsigned:${publishedByAgentId}:${nowIso}`,
            publishedAt: nowIso,
        },
    };
    manifest.provenance.manifestChecksum = checksumPayloadForManifest(manifest);
    return manifest;
}
function makePolicyVersion() {
    return `cpv_${new Date().toISOString()}`;
}
function listCanonicalNodeIds(doc) {
    const out = new Set();
    if (!doc)
        return out;
    const nodes = doc.getMap("nodes");
    for (const nodeId of nodes.keys()) {
        const id = String(nodeId || "").trim();
        if (!id)
            continue;
        out.add(id);
        out.add(canonicalGatewayId(id));
    }
    return out;
}
function isDistributionEligibleAgent(doc, agentId, ownerAgentId) {
    if (!doc)
        return false;
    if (!agentId || agentId === ownerAgentId)
        return false;
    const agents = doc.getMap("agents");
    const rec = agents.get(agentId);
    if (!rec)
        return false;
    if (typeof rec.disabledAt === "number")
        return false;
    const type = String(rec.type || "");
    if (type === "external")
        return true;
    if (type !== "internal")
        return false;
    const gateway = typeof rec.gateway === "string" ? rec.gateway.trim() : "";
    if (!gateway)
        return false;
    const canonicalAgent = canonicalGatewayId(agentId);
    const canonicalGateway = canonicalGatewayId(gateway);
    // Exclude alias-style internal identities (e.g., vps-jane-host) once a
    // canonical gateway id exists (e.g., vps-jane). They are migration residue.
    if (canonicalAgent && canonicalGateway && canonicalAgent === canonicalGateway && agentId !== gateway) {
        return false;
    }
    // Strict for fanout hygiene: only target internal agents bound to active node IDs.
    const activeNodes = listCanonicalNodeIds(doc);
    return activeNodes.has(gateway);
}
function createSkillDistributionTask(doc, nodeId, createdByAgentId, capabilityId, ownerAgentId, delegationSkillRef) {
    if (!doc)
        return { created: false, taskIds: [], targets: [] };
    const agents = doc.getMap("agents");
    const targets = Array.from(agents.keys())
        .map((k) => String(k))
        .filter((id) => isDistributionEligibleAgent(doc, id, ownerAgentId));
    if (targets.length === 0)
        return { created: false, taskIds: [], targets: [] };
    const tasks = doc.getMap("tasks");
    const taskIds = [];
    for (const target of targets) {
        const now = Date.now();
        const task = {
            id: randomUUID(),
            title: `Skill distribution: ${capabilityId}`,
            description: `Install/update delegation skill '${delegationSkillRef.name}@${delegationSkillRef.version}' for capability '${capabilityId}'.`,
            status: "pending",
            createdBy_agent: createdByAgentId,
            createdBy_node: nodeId,
            createdAt: now,
            updatedAt: now,
            updates: [],
            assignedTo_agent: target,
            intent: "skill_distribution",
            metadata: {
                kind: "skill_distribution",
                capabilityId,
                delegationSkillRef,
                requiredResponse: "install_status_with_timestamp",
            },
        };
        tasks.set(task.id, task);
        taskIds.push(task.id);
    }
    return { created: taskIds.length > 0, taskIds, targets };
}
function notifyTaskOwner(doc, fromNodeId, task, payload) {
    if (!doc)
        return null;
    if (!task.createdBy_agent)
        return null;
    const messages = doc.getMap("messages");
    const messageId = randomUUID();
    const lines = [];
    lines.push(`[task:${task.id.slice(0, 8)}] ${task.title}`);
    lines.push(`status: ${task.status}`);
    if (payload.note)
        lines.push(`note: ${payload.note}`);
    if (payload.etaAt)
        lines.push(`etaAt: ${payload.etaAt}`);
    if (payload.planSummary)
        lines.push(`plan: ${payload.planSummary}`);
    const result = payload.result ?? task.result;
    if (result)
        lines.push(`result: ${result}`);
    lines.push(`from: ${fromNodeId}`);
    const now = Date.now();
    const intent = payload.kind === "accepted"
        ? "task_accept"
        : payload.kind === "completed"
            ? "task_complete"
            : payload.kind === "failed"
                ? "task_failed"
                : "task_update";
    const message = {
        id: messageId,
        from_agent: fromNodeId,
        from_node: fromNodeId,
        intent,
        to_agents: [task.createdBy_agent],
        content: lines.join("\n"),
        timestamp: now,
        updatedAt: now,
        readBy_agents: [fromNodeId],
        metadata: {
            kind: intent,
            taskId: task.id,
            taskStatus: task.status,
            corr: task.id,
            etaAt: payload.etaAt,
        },
    };
    messages.set(message.id, message);
    return messageId;
}
function emitLifecycleEvent(doc, fromNodeId, intent, content, metadata) {
    if (!doc)
        return null;
    const messages = doc.getMap("messages");
    const now = Date.now();
    const id = randomUUID();
    const msg = {
        id,
        from_agent: fromNodeId,
        from_node: fromNodeId,
        intent,
        content,
        timestamp: now,
        updatedAt: now,
        readBy_agents: [fromNodeId],
        metadata: {
            kind: intent,
            ...(metadata || {}),
        },
    };
    messages.set(id, msg);
    return id;
}
function runPublishGate(gateResults, gate, fn) {
    const at = Date.now();
    try {
        fn();
        gateResults.push({ gate, status: "passed", at });
        return { ok: true };
    }
    catch (err) {
        const error = err?.message || String(err);
        gateResults.push({ gate, status: "failed", at, error });
        return { ok: false, error };
    }
}
function runPublishGateNoop(gateResults, gate, detail) {
    gateResults.push({
        gate,
        status: "skipped",
        at: Date.now(),
        detail,
    });
}
function executeCapabilityPublishPipeline(args) {
    const gateResults = [];
    const { doc, nodeId, publishedByAgentId, capabilityId, manifest, catalogRec, indexRec } = args;
    if (!doc)
        return { ok: false, failedGate: "G8_INDEX_ACTIVATE", rollbackRequired: false, gateResults };
    // Skeleton placeholders; these gates are intentionally no-op until installers/validators land.
    runPublishGateNoop(gateResults, "G4_INSTALL_STAGE", "skeleton: install stage not yet implemented");
    runPublishGateNoop(gateResults, "G5_WIRE_STAGE", "skeleton: wire stage not yet implemented");
    runPublishGateNoop(gateResults, "G6_SMOKE_TEST", "skeleton: smoke gate not yet implemented");
    runPublishGateNoop(gateResults, "G7_ROLLOUT", "skeleton: rollout gate not yet implemented");
    const catalogMap = getCapabilityCatalogMap(doc);
    const indexMap = getCapabilityIndexMap(doc);
    const manifestMap = getCapabilityManifestMap(doc);
    const revisionMap = getCapabilityRevisionMap(doc);
    if (!catalogMap || !indexMap || !manifestMap || !revisionMap) {
        gateResults.push({
            gate: "G8_INDEX_ACTIVATE",
            status: "failed",
            at: Date.now(),
            error: "Capability maps unavailable",
        });
        return { ok: false, failedGate: "G8_INDEX_ACTIVATE", rollbackRequired: true, gateResults };
    }
    // Snapshot predecessor state for update safety + rollback.
    const previousCatalog = catalogMap.get(capabilityId);
    const previousIndex = indexMap.get(capabilityId);
    const previousRevision = revisionMap.get(capabilityId);
    const previousActiveVersion = previousRevision?.activeVersion || previousCatalog?.version;
    const manifestKey = `${capabilityId}:${manifest.version}`;
    const previousManifestAtKey = manifestMap.get(manifestKey);
    const hadManifestAtKey = previousManifestAtKey !== undefined;
    let rollbackPerformed = false;
    const activation = runPublishGate(gateResults, "G8_INDEX_ACTIVATE", () => {
        const now = Date.now();
        const existingRevision = revisionMap.get(capabilityId) || undefined;
        const versions = Array.from(new Set([...(existingRevision?.versions || []), manifest.version]));
        const archivedVersions = new Set(existingRevision?.archivedVersions || []);
        if (previousActiveVersion && previousActiveVersion !== manifest.version)
            archivedVersions.add(previousActiveVersion);
        const nextRevision = {
            capabilityId,
            versions,
            activeVersion: catalogRec.status === "active" ? manifest.version : existingRevision?.activeVersion,
            pendingVersion: undefined,
            archivedVersions: Array.from(archivedVersions),
            currentOwnerAgentId: manifest.ownerAgentId,
            updatedAt: now,
            updatedByAgentId: publishedByAgentId,
            lastAction: "published",
        };
        catalogMap.set(capabilityId, catalogRec);
        indexMap.set(capabilityId, indexRec);
        manifestMap.set(manifestKey, manifest);
        revisionMap.set(capabilityId, nextRevision);
    });
    if (!activation.ok) {
        return { ok: false, failedGate: "G8_INDEX_ACTIVATE", rollbackRequired: true, rollbackPerformed: false, gateResults };
    }
    const distribution = createSkillDistributionTask(doc, nodeId, publishedByAgentId, capabilityId, manifest.ownerAgentId, manifest.delegationSkillRef);
    if (distribution.created)
        requestDispatcherReconcile("capability-skill-distribution");
    const lifecycleMessageId = emitLifecycleEvent(doc, nodeId, "capability_published", `Capability '${capabilityId}' published (${manifest.version}, status=${catalogRec.status}) by ${publishedByAgentId}.`, {
        capabilityId,
        version: manifest.version,
        status: catalogRec.status,
        ownerAgentId: manifest.ownerAgentId,
        policyVersion: indexRec.policyVersion,
        contractSchemaRef: catalogRec.contractSchemaRef,
        delegationSkillRef: manifest.delegationSkillRef,
        executorSkillRef: manifest.executorSkillRef,
        manifestKey,
        previousActiveVersion,
        skillDistributionTaskIds: distribution.taskIds,
        skillDistributionTaskId: distribution.taskIds[0],
    });
    const postcheck = runPublishGate(gateResults, "G9_POSTCHECK", () => {
        const readCatalog = catalogMap.get(capabilityId);
        const readIndex = indexMap.get(capabilityId);
        if (!readCatalog || !readIndex)
            throw new Error("Postcheck failed: missing catalog/index record");
        if (readCatalog.version !== manifest.version)
            throw new Error("Postcheck failed: catalog version mismatch");
        if (readIndex.capabilityId !== capabilityId)
            throw new Error("Postcheck failed: index capabilityId mismatch");
    });
    if (!postcheck.ok) {
        // Roll back activation to predecessor snapshot.
        try {
            if (previousCatalog)
                catalogMap.set(capabilityId, previousCatalog);
            else
                catalogMap.delete(capabilityId);
            if (previousIndex)
                indexMap.set(capabilityId, previousIndex);
            else
                indexMap.delete(capabilityId);
            if (previousRevision)
                revisionMap.set(capabilityId, previousRevision);
            else
                revisionMap.delete(capabilityId);
            if (hadManifestAtKey)
                manifestMap.set(manifestKey, previousManifestAtKey);
            else
                manifestMap.delete(manifestKey);
            rollbackPerformed = true;
        }
        catch {
            rollbackPerformed = false;
        }
        return { ok: false, failedGate: "G9_POSTCHECK", rollbackRequired: true, rollbackPerformed, gateResults };
    }
    const revision = revisionMap.get(capabilityId);
    return {
        ok: true,
        rollbackRequired: false,
        gateResults,
        activation: {
            capability: catalogRec,
            index: indexRec,
            manifest,
            manifestKey,
            revision,
            previousActiveVersion,
            rollbackPerformed,
            distribution,
            lifecycleMessageId,
        },
    };
}
function runUnpublishGate(gateResults, gate, fn) {
    const at = Date.now();
    try {
        fn();
        gateResults.push({ gate, status: "passed", at });
        return { ok: true };
    }
    catch (err) {
        const error = err?.message || String(err);
        gateResults.push({ gate, status: "failed", at, error });
        return { ok: false, error };
    }
}
function runUnpublishGateNoop(gateResults, gate, detail) {
    gateResults.push({ gate, status: "skipped", at: Date.now(), detail });
}
function executeCapabilityUnpublishPipeline(args) {
    const { doc, nodeId, actingAdmin, capabilityId, existing } = args;
    const gateResults = [];
    if (!doc)
        return { ok: false, failedGate: "U1_DISABLE_ROUTING", gateResults };
    const catalogMap = getCapabilityCatalogMap(doc);
    const indexMap = getCapabilityIndexMap(doc);
    const revisionMap = getCapabilityRevisionMap(doc);
    if (!catalogMap || !indexMap || !revisionMap) {
        gateResults.push({
            gate: "U1_DISABLE_ROUTING",
            status: "failed",
            at: Date.now(),
            error: "Capability maps unavailable",
        });
        return { ok: false, failedGate: "U1_DISABLE_ROUTING", gateResults };
    }
    const now = Date.now();
    const next = {
        ...existing,
        status: "disabled",
        publishedAt: now,
        publishedByAgentId: actingAdmin,
    };
    const policyVersion = makePolicyVersion();
    const disable = runUnpublishGate(gateResults, "U1_DISABLE_ROUTING", () => {
        catalogMap.set(capabilityId, next);
        indexMap.set(capabilityId, {
            capabilityId,
            eligibleAgentIds: [],
            policyVersion,
            updatedAt: now,
        });
    });
    if (!disable.ok)
        return { ok: false, failedGate: "U1_DISABLE_ROUTING", gateResults };
    runUnpublishGateNoop(gateResults, "U2_UNWIRE", "skeleton: workspace unwire not yet implemented");
    const archive = runUnpublishGate(gateResults, "U3_ARCHIVE", () => {
        const existingRevision = revisionMap.get(capabilityId) || undefined;
        const nextRevision = {
            capabilityId,
            versions: existingRevision?.versions || [existing.version],
            activeVersion: existingRevision?.activeVersion && existingRevision.activeVersion === existing.version
                ? undefined
                : existingRevision?.activeVersion,
            pendingVersion: undefined,
            archivedVersions: Array.from(new Set([...(existingRevision?.archivedVersions || []), existing.version])),
            currentOwnerAgentId: undefined,
            updatedAt: now,
            updatedByAgentId: actingAdmin,
            lastAction: "unpublished",
        };
        revisionMap.set(capabilityId, nextRevision);
    });
    if (!archive.ok)
        return { ok: false, failedGate: "U3_ARCHIVE", gateResults };
    let lifecycleMessageId = null;
    const emit = runUnpublishGate(gateResults, "U4_EMIT", () => {
        lifecycleMessageId = emitLifecycleEvent(doc, nodeId, "capability_unpublished", `Capability '${capabilityId}' unpublished by ${actingAdmin}.`, {
            capabilityId,
            status: "disabled",
            ownerAgentId: existing.ownerAgentId,
            version: existing.version,
            policyVersion,
        });
    });
    if (!emit.ok)
        return { ok: false, failedGate: "U4_EMIT", gateResults };
    const revision = revisionMap.get(capabilityId);
    return {
        ok: true,
        gateResults,
        capability: next,
        revision,
        lifecycleMessageId,
    };
}
function readTaskIdempotency(task) {
    const ansible = (task.metadata || {}).ansible;
    const idempotency = (ansible?.idempotency || {});
    return idempotency && typeof idempotency === "object" ? idempotency : {};
}
function attachTaskIdempotency(task, key, action, byAgent, at) {
    const metadata = (task.metadata || {}) || {};
    const ansible = (metadata.ansible || {}) || {};
    const idempotency = readTaskIdempotency(task);
    const nextIdempotency = {
        ...idempotency,
        [key]: { at, action, byAgent },
    };
    return {
        ...task,
        metadata: {
            ...metadata,
            ansible: {
                ...ansible,
                idempotency: nextIdempotency,
            },
        },
    };
}
function resolveTaskIdempotencyKey(params, taskId, action, agentId) {
    if (typeof params.idempotency_key === "string" && params.idempotency_key.trim().length > 0) {
        return validateString(params.idempotency_key, 200, "idempotency_key").trim();
    }
    return `${taskId}:${action}:${agentId}`;
}
function computeTaskSlaMetadata(task, acceptedAt) {
    const ansible = (task.metadata || {}).ansible;
    if (!ansible)
        return undefined;
    const contractCaps = (ansible.contract || {}).capabilities || [];
    if (!Array.isArray(contractCaps) || contractCaps.length === 0)
        return undefined;
    const now = acceptedAt || Date.now();
    // Defaults until manifest-level SLA wiring is expanded per capability.
    return {
        acceptByAt: task.createdAt + 120 * 1000,
        progressByAt: now + 900 * 1000,
        completeByAt: now + Math.max(1800 * 1000, (ansible.defaultEtaSeconds || 1800) * 1000),
        escalations: {},
    };
}
function resolveTaskKey(tasks, idOrPrefix) {
    const needle = String(idOrPrefix || "").trim();
    if (!needle)
        return { error: "Task id is required" };
    // Exact match first.
    if (tasks.get(needle) !== undefined)
        return needle;
    // Prefix match (common when users reference 8-char short ids).
    const matches = [];
    for (const k of tasks.keys()) {
        if (k.startsWith(needle))
            matches.push(k);
    }
    // Fallback: match by value.id prefix (handles legacy/odd states where task.id != key).
    if (matches.length === 0 && typeof tasks.entries === "function") {
        for (const [k, v] of tasks.entries()) {
            const id = v && typeof v === "object" && "id" in v ? String(v.id || "") : "";
            if (id && id.startsWith(needle))
                matches.push(k);
        }
    }
    if (matches.length === 0)
        return { error: "Task not found" };
    if (matches.length === 1)
        return matches[0];
    return {
        error: `Ambiguous task id prefix '${needle}'. Matches: ${matches.slice(0, 8).join(", ")}${matches.length > 8 ? ", ..." : ""}`,
    };
}
/**
 * Resolve the effective agent ID for task operations.
 * Internal agents use nodeId (must be authorized in the nodes map).
 * External agents provide agentId, which is verified against the agents registry.
 */
function resolveEffectiveAgent(doc, nodeId, agentId, agentToken, authMode) {
    if (agentToken) {
        const byToken = resolveAgentByToken(doc, agentToken);
        if (!byToken)
            return { error: "Invalid agent_token." };
        return { effectiveAgent: byToken };
    }
    if (authMode === "token-required") {
        return { error: "agent_token is required for this operation." };
    }
    if (!agentId) {
        requireAuth(nodeId);
        return { effectiveAgent: nodeId };
    }
    const agents = doc.getMap("agents");
    const record = agents.get(agentId);
    if (!record) {
        return { error: `Agent '${agentId}' is not registered. Use: openclaw ansible agent register --id ${agentId}` };
    }
    if (record?.disabledAt) {
        return { error: `Agent '${agentId}' is disabled.` };
    }
    return { effectiveAgent: agentId };
}
function cleanStringArray(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    const seen = new Set();
    for (const v of value) {
        if (typeof v !== "string")
            continue;
        const s = v.trim();
        if (!s || seen.has(s))
            continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}
function getInternalAgentsByGateway(doc, gatewayId) {
    if (!doc)
        return [];
    const agents = doc.getMap("agents");
    const out = [];
    for (const [id, raw] of agents.entries()) {
        const rec = raw;
        if (!rec || rec.type !== "internal")
            continue;
        if (rec.gateway === gatewayId)
            out.push(String(id));
    }
    return out.sort((a, b) => a.localeCompare(b));
}
function resolveAssignedTargets(doc, nodeId, explicitAssignedTo, requires) {
    if (!doc)
        return { error: "Ansible not initialized" };
    const assignedTo = explicitAssignedTo?.trim();
    const agents = doc.getMap("agents");
    const context = doc.getMap("context");
    const nodes = doc.getMap("nodes");
    const capabilityIndex = getCapabilityIndexMap(doc);
    if (!assignedTo && requires.length === 0) {
        return { error: "Task must include assignedTo or requires (or both)." };
    }
    if (assignedTo) {
        const direct = agents.get(assignedTo);
        if (direct)
            return { assignees: [assignedTo], capabilityMatches: [], skillMatches: [] };
        // Back-compat: caller passed a gateway/node id. Resolve to first local internal agent.
        const nodeExists = nodes.get(assignedTo) !== undefined;
        if (nodeExists) {
            const candidates = getInternalAgentsByGateway(doc, assignedTo);
            if (candidates.length > 0)
                return { assignees: [candidates[0]], capabilityMatches: [], skillMatches: [] };
            return { assignees: [assignedTo], capabilityMatches: [], skillMatches: [] };
        }
        return { error: `assignedTo '${assignedTo}' is not a known agent or node.` };
    }
    const skillToAgents = new Map();
    const capabilityToAgents = new Map();
    const capabilityMatches = new Set();
    const skillMatches = new Set();
    for (const skill of requires) {
        if (capabilityIndex?.has(skill)) {
            const idx = capabilityIndex.get(skill);
            const eligible = cleanStringArray(idx?.eligibleAgentIds).filter((agentId) => agents.get(agentId) !== undefined);
            if (eligible.length === 0) {
                return { error: `No eligible agent in capability index for '${skill}'.` };
            }
            const ownerResolution = resolveCapabilityOwnerWithFailover(doc, nodeId, skill, eligible);
            if (!ownerResolution.selectedOwner) {
                return { error: `No live owner/standby available for capability '${skill}'.` };
            }
            capabilityToAgents.set(skill, [ownerResolution.selectedOwner, ...eligible.filter((id) => id !== ownerResolution.selectedOwner)]);
            capabilityMatches.add(skill);
            continue;
        }
        const matches = new Set();
        for (const [agentId, raw] of agents.entries()) {
            const rec = raw;
            if (!rec)
                continue;
            if (Array.isArray(context.get(String(agentId))?.skills)) {
                const agentSkills = context.get(String(agentId))?.skills ?? [];
                if (agentSkills.includes(skill))
                    matches.add(String(agentId));
            }
            if (rec.type === "internal" && rec.gateway) {
                const gatewaySkills = context.get(rec.gateway)?.skills ?? [];
                if (gatewaySkills.includes(skill))
                    matches.add(String(agentId));
            }
        }
        const ordered = Array.from(matches).sort((a, b) => a.localeCompare(b));
        if (ordered.length === 0)
            return { error: `No registered agent advertises required skill '${skill}'.` };
        skillToAgents.set(skill, ordered);
        skillMatches.add(skill);
    }
    if (requires.length === 1) {
        const k = requires[0];
        const byCapability = capabilityToAgents.get(k);
        if (byCapability && byCapability.length > 0) {
            return { assignees: [byCapability[0]], capabilityMatches: Array.from(capabilityMatches), skillMatches: Array.from(skillMatches) };
        }
        const bySkill = skillToAgents.get(k);
        if (bySkill && bySkill.length > 0) {
            return { assignees: [bySkill[0]], capabilityMatches: Array.from(capabilityMatches), skillMatches: Array.from(skillMatches) };
        }
        return { error: `No assignees resolved for '${k}'.` };
    }
    const union = new Set();
    for (const skill of requires) {
        for (const id of capabilityToAgents.get(skill) || [])
            union.add(id);
        for (const id of skillToAgents.get(skill) || [])
            union.add(id);
    }
    const assignees = Array.from(union).sort((a, b) => a.localeCompare(b));
    return assignees.length > 0
        ? { assignees, capabilityMatches: Array.from(capabilityMatches), skillMatches: Array.from(skillMatches) }
        : { error: "No assignees resolved from requires." };
}
function parseEtaAtFromClaim(params, fallbackSeconds) {
    const now = Date.now();
    const etaAtRaw = typeof params.etaAt === "string" ? params.etaAt.trim() : "";
    const etaSecondsRaw = params.etaSeconds;
    if (etaAtRaw) {
        const parsed = Date.parse(etaAtRaw);
        if (!Number.isFinite(parsed))
            return { error: "etaAt must be an ISO-8601 datetime" };
        if (parsed <= now)
            return { error: "etaAt must be in the future" };
        return { etaAtIso: new Date(parsed).toISOString() };
    }
    if (typeof etaSecondsRaw === "number") {
        if (!Number.isFinite(etaSecondsRaw))
            return { error: "etaSeconds must be a finite number" };
        const etaSeconds = Math.floor(etaSecondsRaw);
        if (etaSeconds < 1 || etaSeconds > 86400 * 14)
            return { error: "etaSeconds must be between 1 and 1209600" };
        return { etaAtIso: new Date(now + etaSeconds * 1000).toISOString() };
    }
    if (fallbackSeconds > 0) {
        return { etaAtIso: new Date(now + fallbackSeconds * 1000).toISOString() };
    }
    return {};
}
function taskNeedsContractEta(task) {
    const ansible = (task.metadata || {}).ansible;
    if (!ansible || typeof ansible !== "object")
        return false;
    if (ansible.responseRequired === true)
        return true;
    const contract = ansible.contract;
    if (!contract || typeof contract !== "object")
        return false;
    const capabilities = contract.capabilities;
    return Array.isArray(capabilities) && capabilities.length > 0;
}
function getPulseSnapshot(doc, gatewayId) {
    if (!doc)
        return null;
    const pulse = doc.getMap("pulse");
    const raw = pulse.get(gatewayId);
    if (!raw)
        return null;
    if (raw instanceof Map || typeof raw?.get === "function") {
        const status = String(raw.get("status") || "offline");
        const lastSeen = typeof raw.get("lastSeen") === "number" ? Number(raw.get("lastSeen")) : 0;
        return { status, lastSeen };
    }
    const status = typeof raw.status === "string" ? raw.status : "offline";
    const lastSeen = typeof raw.lastSeen === "number" ? raw.lastSeen : 0;
    return { status, lastSeen };
}
function isAgentLive(doc, agentId, nowMs) {
    if (!doc)
        return false;
    const agents = doc.getMap("agents");
    const rec = agents.get(agentId);
    if (!rec)
        return false;
    if (rec.type === "external")
        return true;
    if (rec.type !== "internal")
        return false;
    const gateway = typeof rec.gateway === "string" ? rec.gateway : "";
    if (!gateway)
        return false;
    const p = getPulseSnapshot(doc, gateway);
    if (!p)
        return false;
    if (p.status === "offline")
        return false;
    const age = Math.max(0, nowMs - p.lastSeen);
    return age <= OWNER_LEASE_STALE_MS;
}
function resolveCapabilityOwnerWithFailover(doc, nodeId, capabilityId, baseEligible) {
    if (!doc)
        return { selectedOwner: null, primaryOwner: null, failoverApplied: false };
    const now = Date.now();
    const catalogMap = getCapabilityCatalogMap(doc);
    const manifestMap = getCapabilityManifestMap(doc);
    const indexMap = getCapabilityIndexMap(doc);
    const revisionMap = getCapabilityRevisionMap(doc);
    const catalog = catalogMap?.get(capabilityId);
    const primaryOwner = catalog?.ownerAgentId || (baseEligible[0] || null);
    const candidates = new Set();
    if (primaryOwner)
        candidates.add(primaryOwner);
    if (catalog) {
        const manifestKey = `${capabilityId}:${catalog.version}`;
        const manifest = manifestMap?.get(manifestKey);
        for (const standby of cleanStringArray(manifest?.standbyOwnerAgentIds))
            candidates.add(standby);
    }
    for (const id of baseEligible)
        candidates.add(id);
    let selectedOwner = null;
    for (const agentId of candidates) {
        if (!agentId)
            continue;
        if (isAgentLive(doc, agentId, now)) {
            selectedOwner = agentId;
            break;
        }
    }
    if (!selectedOwner && primaryOwner)
        selectedOwner = primaryOwner;
    if (!selectedOwner)
        return { selectedOwner: null, primaryOwner, failoverApplied: false };
    const failoverApplied = !!primaryOwner && selectedOwner !== primaryOwner;
    if (failoverApplied && indexMap) {
        const existingRevision = revisionMap?.get(capabilityId) || undefined;
        const alreadyFailedOver = existingRevision?.currentOwnerAgentId === selectedOwner &&
            existingRevision?.lastFailoverFromAgentId === primaryOwner;
        if (alreadyFailedOver) {
            return { selectedOwner, primaryOwner, failoverApplied: true };
        }
        const existingIndex = indexMap.get(capabilityId);
        if (existingIndex) {
            const nextEligible = Array.from(new Set([selectedOwner, ...cleanStringArray(existingIndex.eligibleAgentIds)]));
            indexMap.set(capabilityId, {
                ...existingIndex,
                eligibleAgentIds: nextEligible,
                policyVersion: makePolicyVersion(),
                updatedAt: now,
            });
        }
        if (revisionMap) {
            const r = existingRevision;
            if (r) {
                revisionMap.set(capabilityId, {
                    ...r,
                    currentOwnerAgentId: selectedOwner,
                    lastFailoverFromAgentId: primaryOwner || undefined,
                    lastFailoverAt: now,
                    updatedAt: now,
                    updatedByAgentId: nodeId,
                });
            }
        }
        emitLifecycleEvent(doc, nodeId, "capability_owner_failover", `Capability '${capabilityId}' failover from '${primaryOwner}' to '${selectedOwner}'.`, {
            capabilityId,
            primaryOwner,
            selectedOwner,
            staleMsThreshold: OWNER_LEASE_STALE_MS,
        });
    }
    return { selectedOwner, primaryOwner, failoverApplied };
}
export function registerAnsibleTools(api, config) {
    // === ansible_find_task ===
    api.registerTool({
        name: "ansible_find_task",
        label: "Ansible Find Task",
        description: "Find tasks by id prefix or title substring. Returns both the Yjs map key and the task.id (they should match).",
        parameters: {
            type: "object",
            properties: {
                idPrefix: { type: "string", description: "Task id prefix (often 8 chars from ansible_status)" },
                titleContains: { type: "string", description: "Case-insensitive substring match on task title" },
                status: { type: "string", description: "Filter by status (pending|claimed|in_progress|completed|failed)" },
                assignedTo: { type: "string", description: "Filter by assigned agent ID (e.g., 'claude-code')" },
                limit: { type: "number", description: "Max results to return (default 10)" },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const tasks = doc.getMap("tasks");
                const idPrefix = params.idPrefix ? String(params.idPrefix).trim() : "";
                const titleContains = params.titleContains ? String(params.titleContains).trim().toLowerCase() : "";
                const status = params.status ? String(params.status).trim() : "";
                const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.min(50, params.limit)) : 10;
                const assignedTo = params.assignedTo ? String(params.assignedTo).trim() : "";
                const out = [];
                for (const [k, v] of tasks.entries()) {
                    const t = v;
                    if (!t)
                        continue;
                    if (status && t.status !== status)
                        continue;
                    if (idPrefix && !(String(k).startsWith(idPrefix) || String(t.id || "").startsWith(idPrefix)))
                        continue;
                    if (titleContains && !String(t.title || "").toLowerCase().includes(titleContains))
                        continue;
                    const assignees = Array.from(new Set([...(t.assignedTo_agent ? [t.assignedTo_agent] : []), ...(t.assignedTo_agents || [])]));
                    if (assignedTo && !assignees.includes(assignedTo))
                        continue;
                    out.push({
                        key: k,
                        id: t.id,
                        title: t.title,
                        status: t.status,
                        assignedTo: t.assignedTo_agent,
                        assignedToAll: assignees,
                        createdBy: t.createdBy_agent,
                        claimedBy: t.claimedBy_agent,
                        updatedAt: t.updatedAt,
                    });
                }
                out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                return toolResult({ matches: out.slice(0, limit), total: out.length });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_lock_sweep_status ===
    api.registerTool({
        name: "ansible_lock_sweep_status",
        label: "Ansible Lock Sweep Status",
        description: "Get the per-gateway session lock sweeper status (last run + totals). Helps diagnose stuck 'session file locked' issues.",
        parameters: {
            type: "object",
            properties: {},
        },
        async execute() {
            const enabled = config.lockSweep?.enabled ?? true;
            const everySeconds = Math.max(30, Math.floor(config.lockSweep?.everySeconds ?? 60));
            const staleSeconds = Math.max(30, Math.floor(config.lockSweep?.staleSeconds ?? 300));
            const status = getLockSweepStatus();
            return toolResult({
                enabled,
                config: { everySeconds, staleSeconds },
                lastStatus: status.lastStatus,
                totals: status.totals,
            });
        },
    });
    // === ansible_get_coordination ===
    api.registerTool({
        name: "ansible_get_coordination",
        label: "Ansible Get Coordination",
        description: "Get current coordinator configuration (coordinator node id, sweep cadence) and your saved preference (if any).",
        parameters: {
            type: "object",
            properties: {},
        },
        async execute() {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const state = readCoordinationState(doc) || {};
                const m = getCoordinationMap(doc);
                const pref = m?.get(`pref:${nodeId}`) || null;
                return toolResult({
                    myId: nodeId,
                    ...state,
                    myPreference: pref,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_set_coordination_preference ===
    api.registerTool({
        name: "ansible_set_coordination_preference",
        label: "Ansible Set Coordination Preference",
        description: "Record your preferred coordinator and/or sweep cadence. The coordinator may use these preferences when configuring cron and routing.",
        parameters: {
            type: "object",
            properties: {
                desiredCoordinator: {
                    type: "string",
                    description: "Preferred coordinator node id (optional).",
                },
                desiredSweepEverySeconds: {
                    type: "number",
                    description: "Preferred sweep cadence in seconds (optional).",
                },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const desiredCoordinator = params.desiredCoordinator
                    ? validateString(params.desiredCoordinator, 200, "desiredCoordinator")
                    : undefined;
                const desiredSweepEverySeconds = params.desiredSweepEverySeconds !== undefined
                    ? validateNumber(params.desiredSweepEverySeconds, "desiredSweepEverySeconds")
                    : undefined;
                if (!desiredCoordinator && desiredSweepEverySeconds === undefined) {
                    return toolResult({ error: "Provide desiredCoordinator and/or desiredSweepEverySeconds" });
                }
                const m = getCoordinationMap(doc);
                if (!m)
                    return toolResult({ error: "Ansible not initialized" });
                const pref = {
                    desiredCoordinator,
                    desiredSweepEverySeconds,
                    updatedAt: Date.now(),
                };
                m.set(`pref:${nodeId}`, pref);
                return toolResult({ success: true, myId: nodeId, preference: pref });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_set_coordination ===
    api.registerTool({
        name: "ansible_set_coordination",
        label: "Ansible Set Coordination",
        description: "Set the coordinator node id and sweep cadence. Use for initial setup or last-resort coordinator failover.",
        parameters: {
            type: "object",
            properties: {
                coordinator: {
                    type: "string",
                    description: "Coordinator node id (e.g., vps-jane).",
                },
                sweepEverySeconds: {
                    type: "number",
                    description: "Sweep cadence in seconds (e.g., 60).",
                },
                confirmLastResort: {
                    type: "boolean",
                    description: "Required when changing an existing coordinator to a different node (failover).",
                },
            },
            required: ["coordinator", "sweepEverySeconds"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const coordinator = validateString(params.coordinator, 200, "coordinator");
                const sweepEverySeconds = validateNumber(params.sweepEverySeconds, "sweepEverySeconds");
                if (sweepEverySeconds < 10 || sweepEverySeconds > 3600) {
                    return toolResult({ error: "sweepEverySeconds must be between 10 and 3600" });
                }
                const m = getCoordinationMap(doc);
                if (!m)
                    return toolResult({ error: "Ansible not initialized" });
                const existing = m.get("coordinator");
                if (existing && existing !== coordinator) {
                    if (params.confirmLastResort !== true) {
                        return toolResult({
                            error: "Changing coordinator requires confirmLastResort=true (to avoid accidental role moves).",
                        });
                    }
                }
                m.set("coordinator", coordinator);
                m.set("sweepEverySeconds", sweepEverySeconds);
                m.set("updatedAt", Date.now());
                m.set("updatedBy", nodeId);
                return toolResult({
                    success: true,
                    coordinator,
                    sweepEverySeconds,
                    updatedBy: nodeId,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_set_retention ===
    api.registerTool({
        name: "ansible_set_retention",
        label: "Ansible Set Retention",
        description: "Configure coordinator roll-off policy: run daily (or configurable) and prune closed tasks older than a TTL. Takes effect on the coordinator backbone node.",
        parameters: {
            type: "object",
            properties: {
                closedTaskRetentionDays: {
                    type: "number",
                    description: "Delete completed/failed tasks older than this many days. Default 7.",
                },
                pruneEveryHours: {
                    type: "number",
                    description: "How often the coordinator runs the prune (hours). Default 24.",
                },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const m = getCoordinationMap(doc);
                if (!m)
                    return toolResult({ error: "Coordination map not initialized" });
                const days = params.closedTaskRetentionDays === undefined
                    ? 7
                    : validateNumber(params.closedTaskRetentionDays, "closedTaskRetentionDays");
                const hours = params.pruneEveryHours === undefined ? 24 : validateNumber(params.pruneEveryHours, "pruneEveryHours");
                if (days < 1 || days > 90)
                    return toolResult({ error: "closedTaskRetentionDays must be between 1 and 90" });
                if (hours < 1 || hours > 168)
                    return toolResult({ error: "pruneEveryHours must be between 1 and 168" });
                const closedTaskSeconds = Math.floor(days * 24 * 60 * 60);
                const pruneEverySeconds = Math.floor(hours * 60 * 60);
                m.set("retentionClosedTaskSeconds", closedTaskSeconds);
                m.set("retentionPruneEverySeconds", pruneEverySeconds);
                m.set("retentionUpdatedAt", Date.now());
                m.set("retentionUpdatedBy", nodeId);
                return toolResult({
                    success: true,
                    retentionClosedTaskSeconds: closedTaskSeconds,
                    retentionPruneEverySeconds: pruneEverySeconds,
                    retentionUpdatedAt: m.get("retentionUpdatedAt"),
                    retentionUpdatedBy: m.get("retentionUpdatedBy"),
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_get_delegation_policy ===
    api.registerTool({
        name: "ansible_get_delegation_policy",
        label: "Ansible Get Delegation Policy",
        description: "Read the shared delegation policy (version/checksum/markdown) and ack status by agent.",
        parameters: {
            type: "object",
            properties: {
                includeAcks: {
                    type: "boolean",
                    description: "Include delegation ACK records by agent (default true).",
                },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const m = getCoordinationMap(doc);
                if (!m)
                    return toolResult({ error: "Coordination map not initialized" });
                const includeAcks = params.includeAcks !== false;
                const out = {
                    delegationPolicyVersion: m.get("delegationPolicyVersion"),
                    delegationPolicyChecksum: m.get("delegationPolicyChecksum"),
                    delegationPolicyMarkdown: m.get("delegationPolicyMarkdown"),
                    delegationPolicyUpdatedAt: m.get("delegationPolicyUpdatedAt"),
                    delegationPolicyUpdatedBy: m.get("delegationPolicyUpdatedBy"),
                };
                if (includeAcks)
                    out.acks = readDelegationAcks(m);
                return toolResult(out);
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_set_delegation_policy ===
    api.registerTool({
        name: "ansible_set_delegation_policy",
        label: "Ansible Set Delegation Policy",
        description: "Coordinator-only: publish delegation policy markdown + version/checksum and optionally send policy update messages to target agents.",
        parameters: {
            type: "object",
            properties: {
                policyMarkdown: {
                    type: "string",
                    description: "Canonical policy markdown (table + metadata).",
                },
                version: {
                    type: "string",
                    description: "Policy version string (e.g., 2026-02-12.1).",
                },
                checksum: {
                    type: "string",
                    description: "Optional checksum; if omitted, computed as sha256(policyMarkdown).",
                },
                notifyAgents: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional list of agent/node ids to notify with a policy_update message.",
                },
            },
            required: ["policyMarkdown", "version"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const m = getCoordinationMap(doc);
                if (!m)
                    return toolResult({ error: "Coordination map not initialized" });
                const coordinator = m.get("coordinator");
                if (!coordinator)
                    return toolResult({ error: "Coordinator not configured. Set with ansible_set_coordination first." });
                if (coordinator !== nodeId)
                    return toolResult({ error: `Only coordinator (${coordinator}) can publish delegation policy` });
                const policyMarkdown = validateString(params.policyMarkdown, 200_000, "policyMarkdown");
                const version = validateString(params.version, 120, "version");
                const checksum = params.checksum
                    ? validateString(params.checksum, 200, "checksum")
                    : computeSha256(policyMarkdown);
                m.set("delegationPolicyVersion", version);
                m.set("delegationPolicyChecksum", checksum);
                m.set("delegationPolicyMarkdown", policyMarkdown);
                m.set("delegationPolicyUpdatedAt", Date.now());
                m.set("delegationPolicyUpdatedBy", nodeId);
                const notified = [];
                const rawNotify = Array.isArray(params.notifyAgents) ? params.notifyAgents : [];
                const notifyAgents = rawNotify
                    .filter((x) => typeof x === "string" && String(x).trim().length > 0)
                    .map((x) => String(x).trim());
                if (notifyAgents.length > 0) {
                    const messages = doc.getMap("messages");
                    for (const to of notifyAgents) {
                        const now = Date.now();
                        const message = {
                            id: randomUUID(),
                            from_agent: nodeId,
                            from_node: nodeId,
                            to_agents: [to],
                            timestamp: now,
                            updatedAt: now,
                            readBy_agents: [nodeId],
                            content: [
                                "kind: policy_update",
                                `policyVersion: ${version}`,
                                `policyChecksum: ${checksum}`,
                                "",
                                "Apply this Delegation Directory policy to your IDENTITY.md and ACK with ansible_ack_delegation_policy.",
                            ].join("\n"),
                        };
                        messages.set(message.id, message);
                        notified.push(to);
                    }
                }
                return toolResult({
                    success: true,
                    delegationPolicyVersion: version,
                    delegationPolicyChecksum: checksum,
                    delegationPolicyUpdatedAt: m.get("delegationPolicyUpdatedAt"),
                    delegationPolicyUpdatedBy: m.get("delegationPolicyUpdatedBy"),
                    notifiedAgents: notified,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_ack_delegation_policy ===
    api.registerTool({
        name: "ansible_ack_delegation_policy",
        label: "Ansible Ack Delegation Policy",
        description: "Record this agent's acknowledgement of the current (or provided) delegation policy version/checksum.",
        parameters: {
            type: "object",
            properties: {
                version: {
                    type: "string",
                    description: "Acknowledged policy version. Defaults to current shared version.",
                },
                checksum: {
                    type: "string",
                    description: "Acknowledged policy checksum. Defaults to current shared checksum.",
                },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const m = getCoordinationMap(doc);
                if (!m)
                    return toolResult({ error: "Coordination map not initialized" });
                const version = params.version
                    ? validateString(params.version, 120, "version")
                    : m.get("delegationPolicyVersion");
                const checksum = params.checksum
                    ? validateString(params.checksum, 200, "checksum")
                    : m.get("delegationPolicyChecksum");
                if (!version || !checksum) {
                    return toolResult({ error: "No shared delegation policy is published yet" });
                }
                const now = Date.now();
                m.set(`delegationAck:${nodeId}:version`, version);
                m.set(`delegationAck:${nodeId}:checksum`, checksum);
                m.set(`delegationAck:${nodeId}:at`, now);
                return toolResult({
                    success: true,
                    agentId: nodeId,
                    version,
                    checksum,
                    ackAt: now,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_capability_publish ===
    api.registerTool({
        name: "ansible_capability_publish",
        label: "Ansible Capability Publish",
        description: "Publish or update a capability contract and activate routing. Also creates a skill-distribution task for all non-owner agents.",
        parameters: {
            type: "object",
            properties: {
                manifest: {
                    type: "object",
                    description: "Optional SkillPairManifest v1 payload. When provided, schema/provenance validation is enforced and legacy flat fields are optional.",
                },
                capability_id: { type: "string", description: "Stable capability id (e.g., cap.fs.diff-apply)" },
                name: { type: "string", description: "Human-readable capability name" },
                version: { type: "string", description: "Capability contract version" },
                owner_agent_id: { type: "string", description: "Executor owner agent id (must exist)" },
                delegation_skill_ref: {
                    type: "object",
                    description: "Delegation skill reference",
                    properties: {
                        name: { type: "string" },
                        version: { type: "string" },
                        path: { type: "string" },
                    },
                },
                executor_skill_ref: {
                    type: "object",
                    description: "Executor skill reference",
                    properties: {
                        name: { type: "string" },
                        version: { type: "string" },
                        path: { type: "string" },
                    },
                },
                contract_schema_ref: { type: "string", description: "Schema reference for request/result contract" },
                default_eta_seconds: { type: "number", description: "Default expected completion time (seconds)" },
                status: { type: "string", enum: ["active", "deprecated", "disabled"] },
                from_agent: { type: "string", description: "Acting internal agent id on this gateway" },
                agent_token: { type: "string", description: "Auth token for acting internal agent" },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            let gate = "G0_AUTHZ";
            let capabilityIdHint = "";
            try {
                gate = "G0_AUTHZ";
                requireAuth(nodeId);
                const requestedFrom = typeof params.from_agent === "string" ? String(params.from_agent) : undefined;
                const token = typeof params.agent_token === "string" && params.agent_token.trim().length > 0
                    ? params.agent_token.trim()
                    : undefined;
                const actorResult = resolveAdminActorOrError(doc, nodeId, token, requestedFrom);
                if (actorResult.error)
                    return toolResult({ error: actorResult.error });
                const publishedByAgentId = actorResult.actor;
                if (!publishedByAgentId)
                    return toolResult({ error: "Failed to resolve publishing actor." });
                requireInternalCapabilityPublisher(doc, nodeId, publishedByAgentId);
                gate = "G1_SCHEMA";
                const nowIso = new Date().toISOString();
                const manifest = params.manifest
                    ? validateSkillPairManifest(params.manifest)
                    : buildManifestFromLegacyParams(params, publishedByAgentId, nowIso);
                if (manifest.provenance.publishedByAgentId !== publishedByAgentId) {
                    return toolResult({
                        error: `manifest provenance publisher '${manifest.provenance.publishedByAgentId}' does not match acting agent '${publishedByAgentId}'`,
                    });
                }
                gate = "G2_PROVENANCE";
                const capabilityId = manifest.capabilityId;
                capabilityIdHint = capabilityId;
                const version = manifest.version;
                const ownerAgentId = manifest.ownerAgentId;
                const delegationSkillRef = manifest.delegationSkillRef;
                const executorSkillRef = manifest.executorSkillRef;
                const contractSchemaRef = manifest.contract.inputSchemaRef;
                const defaultEtaSeconds = manifest.sla.completeSlaSeconds;
                const name = typeof params.name === "string" && params.name.trim().length > 0
                    ? validateString(params.name, 200, "name").trim()
                    : capabilityId;
                const status = (typeof params.status === "string" ? params.status : "active");
                gate = "G3_OWNER_LIVENESS";
                const agents = doc.getMap("agents");
                if (!agents.has(ownerAgentId)) {
                    return toolResult({ error: `owner_agent_id '${ownerAgentId}' is not registered` });
                }
                const policyVersion = makePolicyVersion();
                const now = Date.now();
                const catalogRec = {
                    capabilityId,
                    name,
                    version,
                    status,
                    ownerAgentId,
                    ownerNodeId: nodeId,
                    delegationSkillRef,
                    executorSkillRef,
                    contractSchemaRef,
                    defaultEtaSeconds,
                    publishedAt: now,
                    publishedByAgentId,
                };
                const indexRec = {
                    capabilityId,
                    eligibleAgentIds: status === "active" ? [ownerAgentId] : [],
                    policyVersion,
                    updatedAt: now,
                };
                gate = "G4_INSTALL_STAGE";
                const pipeline = executeCapabilityPublishPipeline({
                    doc,
                    nodeId,
                    publishedByAgentId,
                    capabilityId,
                    manifest,
                    catalogRec,
                    indexRec,
                });
                const gateFailed = pipeline.gateResults.find((g) => g.status === "failed");
                if (gateFailed)
                    gate = gateFailed.gate;
                if (!pipeline.ok || !pipeline.activation) {
                    const failedGate = pipeline.failedGate || gate;
                    emitLifecycleEvent(doc, nodeId, "capability_publish_gate_failed", `Capability publish failed at ${failedGate}${capabilityId ? ` (${capabilityId})` : ""}.`, {
                        gate: failedGate,
                        capabilityId: capabilityId || undefined,
                        publishPipeline: pipeline.gateResults,
                    });
                    if (pipeline.rollbackRequired) {
                        emitLifecycleEvent(doc, nodeId, "capability_publish_rollback", `Rollback required after publish failure at ${failedGate}${capabilityId ? ` (${capabilityId})` : ""}.`, {
                            gate: failedGate,
                            capabilityId: capabilityId || undefined,
                            rollbackState: "required",
                            rollbackPerformed: pipeline.rollbackPerformed === true,
                            publishPipeline: pipeline.gateResults,
                        });
                    }
                    return toolResult({
                        error: `Publish pipeline failed at ${failedGate}`,
                        publishPipeline: pipeline.gateResults,
                        rollbackRequired: pipeline.rollbackRequired,
                        rollbackPerformed: pipeline.rollbackPerformed === true,
                    });
                }
                const { activation } = pipeline;
                return toolResult({
                    success: true,
                    manifest: activation.manifest,
                    manifestKey: activation.manifestKey,
                    capability: activation.capability,
                    index: activation.index,
                    revision: activation.revision,
                    previousActiveVersion: activation.previousActiveVersion,
                    lifecycleMessageId: activation.lifecycleMessageId,
                    publishPipeline: pipeline.gateResults,
                    skillDistributionTask: activation.distribution.created
                        ? { taskId: activation.distribution.taskId, targets: activation.distribution.targets }
                        : null,
                });
            }
            catch (err) {
                const errorMessage = err?.message || String(err);
                emitLifecycleEvent(doc, nodeId, "capability_publish_gate_failed", `Capability publish failed at ${gate}${capabilityIdHint ? ` (${capabilityIdHint})` : ""}: ${errorMessage}`, {
                    gate,
                    capabilityId: capabilityIdHint || undefined,
                    error: errorMessage,
                });
                if (["G4_INDEX_STAGE", "G5_DISTRIBUTION", "G8_INDEX_ACTIVATE"].includes(gate)) {
                    emitLifecycleEvent(doc, nodeId, "capability_publish_rollback", `Rollback required after publish failure at ${gate}${capabilityIdHint ? ` (${capabilityIdHint})` : ""}.`, {
                        gate,
                        capabilityId: capabilityIdHint || undefined,
                        error: errorMessage,
                        rollbackState: "required",
                    });
                }
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_capability_unpublish ===
    api.registerTool({
        name: "ansible_capability_unpublish",
        label: "Ansible Capability Unpublish",
        description: "Disable a capability and remove routing eligibility from the capability index.",
        parameters: {
            type: "object",
            properties: {
                capability_id: { type: "string", description: "Capability id to disable" },
                from_agent: { type: "string", description: "Acting internal agent id on this gateway" },
                agent_token: { type: "string", description: "Auth token for acting internal agent" },
            },
            required: ["capability_id"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const requestedFrom = typeof params.from_agent === "string" ? String(params.from_agent) : undefined;
                const token = typeof params.agent_token === "string" && params.agent_token.trim().length > 0
                    ? params.agent_token.trim()
                    : undefined;
                const actorResult = resolveAdminActorOrError(doc, nodeId, token, requestedFrom);
                if (actorResult.error)
                    return toolResult({ error: actorResult.error });
                const actingAgent = actorResult.actor;
                if (!actingAgent)
                    return toolResult({ error: "Failed to resolve acting agent." });
                requireInternalCapabilityPublisher(doc, nodeId, actingAgent);
                const capabilityId = validateString(params.capability_id, 160, "capability_id").trim();
                const catalogMap = getCapabilityCatalogMap(doc);
                const indexMap = getCapabilityIndexMap(doc);
                const revisionMap = getCapabilityRevisionMap(doc);
                if (!catalogMap || !indexMap || !revisionMap)
                    return toolResult({ error: "Capability maps unavailable" });
                const existing = catalogMap.get(capabilityId);
                if (!existing)
                    return toolResult({ error: `Capability '${capabilityId}' not found` });
                const pipeline = executeCapabilityUnpublishPipeline({
                    doc,
                    nodeId,
                    actingAdmin: actingAgent,
                    capabilityId,
                    existing,
                });
                if (!pipeline.ok || !pipeline.capability || !pipeline.revision) {
                    return toolResult({
                        error: `Unpublish pipeline failed at ${pipeline.failedGate || "unknown"}`,
                        unpublishPipeline: pipeline.gateResults,
                    });
                }
                return toolResult({
                    success: true,
                    capability: pipeline.capability,
                    revision: pipeline.revision,
                    lifecycleMessageId: pipeline.lifecycleMessageId,
                    unpublishPipeline: pipeline.gateResults,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_list_capabilities ===
    api.registerTool({
        name: "ansible_list_capabilities",
        label: "Ansible List Capabilities",
        description: "List published capability contracts and their current routing eligibility.",
        parameters: {
            type: "object",
            properties: {
                status: { type: "string", enum: ["active", "deprecated", "disabled"], description: "Optional status filter" },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const statusFilter = typeof params.status === "string" ? params.status : undefined;
                const catalogMap = getCapabilityCatalogMap(doc);
                const indexMap = getCapabilityIndexMap(doc);
                if (!catalogMap || !indexMap)
                    return toolResult({ capabilities: [], total: 0 });
                const capabilities = [];
                for (const [id, raw] of catalogMap.entries()) {
                    const catalog = raw;
                    if (!catalog)
                        continue;
                    if (statusFilter && catalog.status !== statusFilter)
                        continue;
                    const index = indexMap.get(String(id));
                    capabilities.push({ catalog, index });
                }
                capabilities.sort((a, b) => a.catalog.capabilityId.localeCompare(b.catalog.capabilityId));
                return toolResult({ capabilities, total: capabilities.length });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_delegate_task ===
    api.registerTool({
        name: "ansible_delegate_task",
        label: "Ansible Delegate",
        description: "Delegate a task to another hemisphere (body) of Jane. Use when you want another instance to handle work, especially for long-running tasks or tasks requiring specific capabilities.",
        parameters: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description: "Brief title for the task",
                },
                description: {
                    type: "string",
                    description: "Detailed description of what needs to be done",
                },
                context: {
                    type: "string",
                    description: "Relevant context from the current conversation to help the other hemisphere understand the task",
                },
                assignedTo: {
                    type: "string",
                    description: "Specific node to assign to (e.g., 'vps-jane'). If omitted, any capable node can claim it.",
                },
                requires: {
                    type: "array",
                    items: { type: "string" },
                    description: "Required capabilities: 'always-on', 'local-files', 'gpu'",
                },
                intent: {
                    type: "string",
                    description: "Semantic type for this task (e.g., 'skill-setup', 'delegation', 'maintenance')",
                },
                skillRequired: {
                    type: "string",
                    description: "If set, only nodes that have advertised this skill will auto-dispatch this task.",
                },
                metadata: {
                    type: "object",
                    description: "Optional structured metadata (e.g., CoreMetadata fields like conversation_id, corr, kind).",
                },
            },
            required: ["title", "description"],
        },
        async execute(_id, params) {
            api.logger?.info(`Ansible: delegating task`);
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId) {
                api.logger?.warn("Ansible: delegation failed - not initialized");
                return toolResult({ error: "Ansible not initialized" });
            }
            try {
                requireAuth(nodeId);
                const title = validateString(params.title, VALIDATION_LIMITS.maxTitleLength, "title");
                const description = validateString(params.description, VALIDATION_LIMITS.maxDescriptionLength, "description");
                const context = params.context ? validateString(params.context, VALIDATION_LIMITS.maxContextLength, "context") : undefined;
                const requires = cleanStringArray(params.requires);
                const explicitAssignedTo = typeof params.assignedTo === "string" ? validateString(params.assignedTo, 200, "assignedTo") : undefined;
                const resolvedTargets = resolveAssignedTargets(doc, nodeId, explicitAssignedTo, requires);
                if ("error" in resolvedTargets)
                    return toolResult({ error: resolvedTargets.error });
                const assignees = resolvedTargets.assignees;
                const catalogMap = getCapabilityCatalogMap(doc);
                const manifestMap = getCapabilityManifestMap(doc);
                const capabilityContracts = resolvedTargets.capabilityMatches
                    .map((capabilityId) => {
                    const rec = catalogMap?.get(capabilityId);
                    if (!rec)
                        return null;
                    const manifestKey = `${capabilityId}:${rec.version}`;
                    const manifest = manifestMap?.get(manifestKey);
                    return {
                        capabilityId: rec.capabilityId,
                        version: rec.version,
                        contractSchemaRef: rec.contractSchemaRef,
                        defaultEtaSeconds: rec.defaultEtaSeconds,
                        compatibilityMode: manifest?.compatibilityMode || "strict",
                    };
                })
                    .filter(Boolean);
                const defaultEtaSeconds = capabilityContracts.length > 0
                    ? Math.min(...capabilityContracts.map((c) => c.defaultEtaSeconds))
                    : 0;
                const existingMetadata = (params.metadata || {});
                const mergedMetadata = {
                    ...existingMetadata,
                    ansible: {
                        responseRequired: true,
                        routingMode: explicitAssignedTo ? "explicit" : resolvedTargets.capabilityMatches.length > 0 ? "capability" : "skill",
                        requiredCapabilities: resolvedTargets.capabilityMatches,
                        requiredSkills: resolvedTargets.skillMatches,
                        defaultEtaSeconds,
                        ack: {
                            state: "pending",
                            required: true,
                            requireEta: true,
                        },
                        contract: {
                            capabilities: capabilityContracts,
                        },
                    },
                };
                const task = {
                    id: randomUUID(),
                    title,
                    description,
                    status: "pending",
                    createdBy_agent: nodeId,
                    createdBy_node: nodeId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    updates: [],
                    context,
                    assignedTo_agent: assignees[0],
                    assignedTo_agents: assignees.length > 1 ? assignees : undefined,
                    requires: requires.length > 0 ? requires : undefined,
                    intent: params.intent,
                    skillRequired: params.skillRequired,
                    metadata: mergedMetadata,
                };
                const tasks = doc.getMap("tasks");
                tasks.set(task.id, task);
                requestDispatcherReconcile("local-task-created");
                api.logger?.info(`Ansible: task ${task.id.slice(0, 8)} delegated`);
                return toolResult({
                    success: true,
                    taskId: task.id,
                    assignedTo: task.assignedTo_agent,
                    assignedTo_all: task.assignedTo_agents ?? [task.assignedTo_agent],
                    message: `Task "${task.title}" created and delegated`,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_send_message ===
    api.registerTool({
        name: "ansible_send_message",
        label: "Ansible Send Message",
        description: "Send a message to other hemispheres of Jane. Use for coordination, status updates, or sharing information.",
        parameters: {
            type: "object",
            properties: {
                content: {
                    type: "string",
                    description: "The message content",
                },
                from_agent: {
                    type: "string",
                    description: "Optional sender agent id override for external-agent sends (e.g., codex). Internal sends default to this node id.",
                },
                agent_token: {
                    type: "string",
                    description: "Authentication token for caller agent. When provided, sender identity is resolved from token and from_agent is ignored.",
                },
                to: {
                    type: "string",
                    description: "Specific agent to send to (single agent id or comma-separated). If omitted, broadcasts to all.",
                },
                metadata: {
                    type: "object",
                    description: "Optional structured metadata (e.g., CoreMetadata fields like conversation_id, corr, kind).",
                },
            },
            required: ["content"],
        },
        async execute(_id, params) {
            api.logger?.info(`Ansible: sending message`);
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId) {
                api.logger?.warn("Ansible: send message failed - not initialized");
                return toolResult({ error: "Ansible not initialized" });
            }
            try {
                requireAuth(nodeId);
                const content = validateString(params.content, VALIDATION_LIMITS.maxMessageLength, "content");
                const authMode = getAuthMode(config);
                const requestedFrom = typeof params.from_agent === "string" && params.from_agent.trim().length > 0
                    ? validateString(params.from_agent, 100, "from_agent").trim()
                    : undefined;
                const agentToken = typeof params.agent_token === "string" && params.agent_token.trim().length > 0
                    ? params.agent_token.trim()
                    : undefined;
                const toAgents = params.to
                    ? (Array.isArray(params.to) ? params.to : [params.to])
                    : [];
                // Default sender is this node's id (internal agent identity).
                // Allow override only for registered external agents so operators can
                // route CLI-originated messages as codex/claude without spoofing internals.
                let effectiveFrom = nodeId;
                if (agentToken) {
                    const byToken = resolveAgentByToken(doc, agentToken);
                    if (!byToken)
                        return toolResult({ error: "Invalid agent_token." });
                    effectiveFrom = byToken;
                }
                else if (authMode === "token-required") {
                    return toolResult({ error: "agent_token is required for this operation." });
                }
                if (requestedFrom && requestedFrom !== nodeId) {
                    if (agentToken) {
                        return toolResult({
                            error: "Do not pass from_agent when agent_token is provided. Sender is derived from token.",
                        });
                    }
                    const agents = doc.getMap("agents");
                    const rec = agents.get(requestedFrom);
                    if (!rec) {
                        return toolResult({
                            error: `from_agent '${requestedFrom}' is not registered. Register first with ansible_register_agent.`,
                        });
                    }
                    if (rec.type !== "external") {
                        return toolResult({
                            error: `from_agent '${requestedFrom}' must be a registered external agent when overriding sender identity.`,
                        });
                    }
                    effectiveFrom = requestedFrom;
                }
                const now = Date.now();
                const message = {
                    id: randomUUID(),
                    from_agent: effectiveFrom,
                    from_node: nodeId,
                    to_agents: toAgents.length > 0 ? toAgents : undefined,
                    content,
                    timestamp: now,
                    updatedAt: now,
                    readBy_agents: [effectiveFrom],
                    metadata: params.metadata,
                };
                const messages = doc.getMap("messages");
                messages.set(message.id, message);
                requestDispatcherReconcile("local-message-created");
                return toolResult({
                    success: true,
                    messageId: message.id,
                    message: toAgents.length > 0
                        ? `Message sent to ${toAgents.join(", ")}`
                        : "Message broadcast to all hemispheres",
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_advertise_skills ===
    api.registerTool({
        name: "ansible_advertise_skills",
        label: "Ansible Advertise Skills",
        description: "Publish this node's available skills to the mesh so other nodes and the coordinator know what you can handle. Also broadcasts a skill-advertised message so all agents are notified. Call this after instantiating a new skill.",
        parameters: {
            type: "object",
            properties: {
                skills: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of skill names this node now handles (e.g., ['caldav-calendar', 'ansible-executor'])",
                },
            },
            required: ["skills"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const skills = params.skills;
                if (!Array.isArray(skills) || skills.length === 0) {
                    return toolResult({ error: "skills must be a non-empty array of strings" });
                }
                // 1. Update NodeContext with skills
                const contextMap = doc.getMap("context");
                const current = contextMap.get(nodeId);
                const updated = {
                    currentFocus: current?.currentFocus ?? "",
                    activeThreads: current?.activeThreads ?? [],
                    recentDecisions: current?.recentDecisions ?? [],
                    skills,
                };
                contextMap.set(nodeId, updated);
                // 2. Broadcast skill-advertised message
                const content = `Skill advertisement from ${nodeId}: I now handle the following skills: ${skills.join(", ")}. Route relevant tasks to me.`;
                const messagesMap = doc.getMap("messages");
                const msgId = randomUUID();
                const now = Date.now();
                messagesMap.set(msgId, {
                    id: msgId,
                    from_agent: nodeId,
                    from_node: nodeId,
                    content,
                    intent: "skill-advertised",
                    timestamp: now,
                    updatedAt: now,
                    readBy_agents: [nodeId],
                });
                api.logger?.info(`Ansible: skills advertised: [${skills.join(", ")}]`);
                return toolResult({ success: true, skills, broadcastMessageId: msgId });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_create_skill_task ===
    api.registerTool({
        name: "ansible_create_skill_task",
        label: "Ansible Create Skill Task",
        description: "Send a skill instantiation request to a target node. The target node will receive the spec, instantiate the skill locally, and broadcast its availability to the mesh.",
        parameters: {
            type: "object",
            properties: {
                skillName: {
                    type: "string",
                    description: "Name of the skill to instantiate (e.g., 'caldav-calendar')",
                },
                assignedTo: {
                    type: "string",
                    description: "Node ID of the executor (e.g., 'vps-jane'). Required.",
                },
                spec: {
                    type: "string",
                    description: "Full specification for the skill: what it does, how it should be set up, any scripts or SKILL.md content to create, configuration needed.",
                },
                title: {
                    type: "string",
                    description: "Optional human-readable title. Defaults to 'Instantiate skill: {skillName}'",
                },
            },
            required: ["skillName", "assignedTo", "spec"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const skillName = validateString(params.skillName, 100, "skillName");
                const assignedTo = params.assignedTo;
                const spec = validateString(params.spec, VALIDATION_LIMITS.maxContextLength, "spec");
                const title = params.title ?? `Instantiate skill: ${skillName}`;
                const executorInstructions = [
                    `You have been assigned a skill instantiation task.`,
                    ``,
                    `**Skill to instantiate**: ${skillName}`,
                    ``,
                    `**Your steps**:`,
                    `1. Read the spec carefully (in the context field below)`,
                    `2. Create the skill locally: write SKILL.md and any required scripts in your workspace/skills/${skillName}/ directory`,
                    `3. Test the skill if possible`,
                    `4. Call ansible_advertise_skills(["${skillName}"]) to publish your availability to the mesh`,
                    `5. Complete this task with ansible_complete_task(taskId, result)`,
                    ``,
                    `**Spec**:`,
                    spec,
                ].join("\n");
                const task = {
                    id: randomUUID(),
                    title,
                    description: `Instantiate skill '${skillName}' on node ${assignedTo} following the provided spec.`,
                    status: "pending",
                    createdBy_agent: nodeId,
                    createdBy_node: nodeId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    updates: [],
                    context: executorInstructions,
                    assignedTo_agent: assignedTo,
                    intent: "skill-setup",
                };
                const tasks = doc.getMap("tasks");
                tasks.set(task.id, task);
                api.logger?.info(`Ansible: skill-setup task ${task.id.slice(0, 8)} created for '${skillName}' on ${assignedTo}`);
                return toolResult({
                    success: true,
                    taskId: task.id,
                    message: `Skill instantiation task for '${skillName}' sent to ${assignedTo}`,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_update_context ===
    api.registerTool({
        name: "ansible_update_context",
        label: "Ansible Update Context",
        description: "Update your current context (focus, threads, decisions) so other hemispheres know what you're working on.",
        parameters: {
            type: "object",
            properties: {
                currentFocus: {
                    type: "string",
                    description: "What you are currently working on",
                },
                addThread: {
                    type: "object",
                    properties: {
                        summary: { type: "string" },
                    },
                    description: "Add an active thread to track",
                },
                addDecision: {
                    type: "object",
                    properties: {
                        decision: { type: "string" },
                        reasoning: { type: "string" },
                    },
                    description: "Record a decision you made",
                },
            },
        },
        async execute(_id, params) {
            api.logger?.debug("Ansible: updating context");
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId) {
                return toolResult({ error: "Ansible not initialized" });
            }
            try {
                requireAuth(nodeId);
                const contextMap = doc.getMap("context");
                const existing = contextMap.get(nodeId) || {
                    currentFocus: "",
                    activeThreads: [],
                    recentDecisions: [],
                };
                const updated = { ...existing };
                if (params.currentFocus) {
                    updated.currentFocus = validateString(params.currentFocus, VALIDATION_LIMITS.maxContextLength, "currentFocus");
                }
                if (params.addThread) {
                    const raw = params.addThread;
                    const thread = {
                        id: randomUUID(),
                        summary: validateString(raw.summary, VALIDATION_LIMITS.maxTitleLength, "thread summary"),
                        lastActivity: Date.now(),
                    };
                    updated.activeThreads = [thread, ...(existing.activeThreads || [])].slice(0, 10);
                }
                if (params.addDecision) {
                    const raw = params.addDecision;
                    const decision = {
                        decision: validateString(raw.decision, VALIDATION_LIMITS.maxTitleLength, "decision"),
                        reasoning: validateString(raw.reasoning, VALIDATION_LIMITS.maxDescriptionLength, "reasoning"),
                        madeAt: Date.now(),
                    };
                    updated.recentDecisions = [decision, ...(existing.recentDecisions || [])].slice(0, 10);
                }
                contextMap.set(nodeId, updated);
                return toolResult({
                    success: true,
                    message: "Context updated",
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_status ===
    api.registerTool({
        name: "ansible_status",
        label: "Ansible Status",
        description: "Get the current status of all Jane hemispheres, including who's online, what they're working on, and pending tasks.",
        parameters: {
            type: "object",
            properties: {
                /**
                 * Consider a node "stale" if its lastSeen is older than this many seconds.
                 * Stale nodes will never be reported as online/busy.
                 */
                staleAfterSeconds: {
                    type: "number",
                    description: "Mark nodes stale if lastSeen is older than this many seconds (default: 300).",
                },
            },
        },
        async execute(_id, params) {
            try {
                api.logger?.debug("Ansible: checking status");
                const state = getAnsibleState();
                const myId = getNodeId();
                if (!state || !myId) {
                    api.logger?.warn("Ansible: status failed - not initialized");
                    return toolResult({ error: "Ansible not initialized" });
                }
                const now = Date.now();
                const staleAfterSecondsRaw = params?.staleAfterSeconds;
                const staleAfterSeconds = typeof staleAfterSecondsRaw === "number" && Number.isFinite(staleAfterSecondsRaw)
                    ? Math.max(30, Math.floor(staleAfterSecondsRaw))
                    : 300;
                const staleAfterMs = staleAfterSeconds * 1000;
                const nodes = [];
                if (state.pulse) {
                    for (const [id, pulse] of state.pulse.entries()) {
                        if (!pulse)
                            continue;
                        const context = state.context?.get(id);
                        // Pulse entries are Y.Map instances — read fields via .get()
                        const p = pulse instanceof Map || pulse.get
                            ? { status: pulse.get("status"), lastSeen: pulse.get("lastSeen"), currentTask: pulse.get("currentTask") }
                            : pulse;
                        const lastSeenMs = typeof p.lastSeen === "number" && Number.isFinite(p.lastSeen) ? p.lastSeen : now;
                        const ageMs = Math.max(0, now - lastSeenMs);
                        const stale = ageMs > staleAfterMs;
                        // Never claim "online/busy" if lastSeen is stale.
                        const rawStatus = (p.status || "unknown");
                        const normalizedStatus = stale && (rawStatus === "online" || rawStatus === "busy") ? "offline" : rawStatus;
                        nodes.push({
                            id,
                            status: normalizedStatus,
                            lastSeen: new Date(lastSeenMs).toISOString(),
                            currentFocus: context?.currentFocus,
                            skills: context?.skills ?? [],
                            stale: stale ? true : undefined,
                            ageSeconds: Math.floor(ageMs / 1000),
                        });
                    }
                }
                const pendingTasks = (state.tasks ? Array.from(state.tasks.values()) : [])
                    .filter((t) => t && t.status === "pending")
                    .map((t) => ({
                    id: t.id ? t.id.slice(0, 8) : "unknown",
                    title: t.title || "Untitled",
                    assignedTo: t.assignedTo_agent || "anyone",
                    assignedToAll: t.assignedTo_agents || (t.assignedTo_agent ? [t.assignedTo_agent] : []),
                }));
                const unreadCount = (state.messages ? Array.from(state.messages.values()) : [])
                    .filter((m) => {
                    if (!m)
                        return false;
                    if (m.from_agent === myId)
                        return false;
                    // Only count messages addressed to me or broadcast (matches ansible_read_messages).
                    if (m.to_agents?.length && !m.to_agents.includes(myId))
                        return false;
                    if (!Array.isArray(m.readBy_agents))
                        return false;
                    return !m.readBy_agents.includes(myId);
                }).length;
                return toolResult({
                    myId,
                    nodes,
                    pendingTasks,
                    unreadMessages: unreadCount,
                    staleAfterSeconds,
                });
            }
            catch (err) {
                api.logger?.error(`Ansible: status tool error: ${err.message}`);
                return toolResult({ error: `Status tool error: ${err.message}` });
            }
        },
        // Backward compatibility for OpenClaw <= 2026.1
        async handler() {
            // @ts-ignore
            return this.execute();
        },
    });
    // === ansible_revoke_node ===
    api.registerTool({
        name: "ansible_revoke_node",
        label: "Ansible Revoke Node",
        description: "Backbone-only: revoke a node's access and remove its context/pulse state.",
        parameters: {
            type: "object",
            properties: {
                node_id: {
                    type: "string",
                    description: "Node ID to revoke.",
                },
            },
            required: ["node_id"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const target = validateString(params.node_id, 200, "node_id").trim();
                if (!target)
                    return toolResult({ error: "node_id is required" });
                const nodes = doc.getMap("nodes");
                const me = nodes.get(nodeId);
                const isBackbone = (config?.tier === "backbone") || ((me?.tier || "") === "backbone");
                if (!isBackbone) {
                    return toolResult({ error: "Only backbone nodes can revoke access." });
                }
                if (target === nodeId)
                    return toolResult({ error: "Cannot revoke your own access." });
                if (!nodes.has(target))
                    return toolResult({ error: "Node not found." });
                nodes.delete(target);
                doc.getMap("context").delete(target);
                doc.getMap("pulse").delete(target);
                return toolResult({ success: true, revoked: target });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_dump_state ===
    api.registerTool({
        name: "ansible_dump_state",
        label: "Ansible Dump State",
        description: "Operator observability: dump full ansible/plugin state for this gateway, including config and all Yjs maps.",
        parameters: {
            type: "object",
            properties: {},
        },
        async execute() {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId) {
                return toolResult({ error: "Ansible not initialized" });
            }
            try {
                requireAuth(nodeId);
                const readMap = (name) => {
                    const m = doc.getMap(name);
                    const out = [];
                    for (const [k, v] of m.entries()) {
                        out.push({ key: String(k), value: serializeValue(v) });
                    }
                    out.sort((a, b) => a.key.localeCompare(b.key));
                    return out;
                };
                const maps = {
                    nodes: readMap("nodes"),
                    agents: readMap("agents"),
                    pendingInvites: readMap("pendingInvites"),
                    tasks: readMap("tasks"),
                    messages: readMap("messages"),
                    context: readMap("context"),
                    pulse: readMap("pulse"),
                    coordination: readMap("coordination"),
                };
                const counts = {
                    nodes: maps.nodes.length,
                    agents: maps.agents.length,
                    pendingInvites: maps.pendingInvites.length,
                    tasks: maps.tasks.length,
                    messages: maps.messages.length,
                    context: maps.context.length,
                    pulse: maps.pulse.length,
                    coordination: maps.coordination.length,
                };
                return toolResult({
                    generatedAt: Date.now(),
                    myId: nodeId,
                    plugin: {
                        config: serializeValue(config),
                        authMode: getAuthMode(config),
                        adminAgentId: typeof config?.adminAgentId === "string" && config.adminAgentId.trim().length > 0
                            ? config.adminAgentId.trim()
                            : "admin",
                    },
                    counts,
                    maps,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_dump_tasks ===
    api.registerTool({
        name: "ansible_dump_tasks",
        label: "Ansible Dump Tasks",
        description: "Operator observability: dump full raw task records from shared ansible state.",
        parameters: {
            type: "object",
            properties: {
                status: {
                    type: "string",
                    description: "Optional status filter (pending|claimed|in_progress|completed|failed).",
                },
                assignedTo: {
                    type: "string",
                    description: "Optional assignee filter. Matches assignedTo_agent or assignedTo_agents.",
                },
                limit: {
                    type: "number",
                    description: "Optional maximum records to return after filtering.",
                },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId) {
                return toolResult({ error: "Ansible not initialized" });
            }
            try {
                requireAuth(nodeId);
                const statusFilter = typeof params.status === "string" && params.status.trim() ? params.status.trim() : undefined;
                const assignedFilter = typeof params.assignedTo === "string" && params.assignedTo.trim() ? params.assignedTo.trim() : undefined;
                const limitRaw = typeof params.limit === "number" ? params.limit : undefined;
                const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : undefined;
                const tasks = doc.getMap("tasks");
                const rows = [];
                for (const [key, raw] of tasks.entries()) {
                    const task = raw;
                    if (!task)
                        continue;
                    if (statusFilter && task.status !== statusFilter)
                        continue;
                    if (assignedFilter) {
                        const assignees = new Set();
                        if (task.assignedTo_agent)
                            assignees.add(task.assignedTo_agent);
                        if (Array.isArray(task.assignedTo_agents)) {
                            for (const a of task.assignedTo_agents)
                                assignees.add(a);
                        }
                        if (!assignees.has(assignedFilter))
                            continue;
                    }
                    rows.push({
                        key: String(key),
                        id: typeof task.id === "string" ? task.id : String(key),
                        value: serializeValue(task),
                    });
                }
                rows.sort((a, b) => {
                    const ta = Number(a.value?.createdAt || 0);
                    const tb = Number(b.value?.createdAt || 0);
                    if (ta !== tb)
                        return tb - ta;
                    return a.key.localeCompare(b.key);
                });
                const items = limit ? rows.slice(0, limit) : rows;
                return toolResult({
                    generatedAt: Date.now(),
                    myId: nodeId,
                    total: rows.length,
                    returned: items.length,
                    items,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_dump_messages ===
    api.registerTool({
        name: "ansible_dump_messages",
        label: "Ansible Dump Messages",
        description: "Operator observability: dump full raw message records from shared ansible state.",
        parameters: {
            type: "object",
            properties: {
                from: {
                    type: "string",
                    description: "Optional sender filter (from_agent).",
                },
                to: {
                    type: "string",
                    description: "Optional recipient filter (must appear in to_agents).",
                },
                conversation_id: {
                    type: "string",
                    description: "Optional conversation filter (metadata.conversation_id).",
                },
                limit: {
                    type: "number",
                    description: "Optional maximum records to return after filtering.",
                },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId) {
                return toolResult({ error: "Ansible not initialized" });
            }
            try {
                requireAuth(nodeId);
                const fromFilter = typeof params.from === "string" && params.from.trim() ? params.from.trim() : undefined;
                const toFilter = typeof params.to === "string" && params.to.trim() ? params.to.trim() : undefined;
                const convoFilter = typeof params.conversation_id === "string" && params.conversation_id.trim()
                    ? params.conversation_id.trim()
                    : undefined;
                const limitRaw = typeof params.limit === "number" ? params.limit : undefined;
                const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : undefined;
                const messages = doc.getMap("messages");
                const rows = [];
                for (const [key, raw] of messages.entries()) {
                    const msg = raw;
                    if (!msg)
                        continue;
                    if (fromFilter && msg.from_agent !== fromFilter)
                        continue;
                    if (toFilter) {
                        const to = Array.isArray(msg.to_agents) ? msg.to_agents : [];
                        if (!to.includes(toFilter))
                            continue;
                    }
                    if (convoFilter) {
                        const cid = msg.metadata?.conversation_id;
                        if (cid !== convoFilter)
                            continue;
                    }
                    rows.push({
                        key: String(key),
                        id: typeof msg.id === "string" ? msg.id : String(key),
                        value: serializeValue(msg),
                    });
                }
                rows.sort((a, b) => {
                    const ta = Number(a.value?.updatedAt || a.value?.timestamp || 0);
                    const tb = Number(b.value?.updatedAt || b.value?.timestamp || 0);
                    if (ta !== tb)
                        return tb - ta;
                    return a.key.localeCompare(b.key);
                });
                const items = limit ? rows.slice(0, limit) : rows;
                return toolResult({
                    generatedAt: Date.now(),
                    myId: nodeId,
                    total: rows.length,
                    returned: items.length,
                    items,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_claim_task ===
    api.registerTool({
        name: "ansible_claim_task",
        label: "Ansible Claim Task",
        description: "Claim a pending task to work on it. External agents (claude-code, codex) pass agentId.",
        parameters: {
            type: "object",
            properties: {
                taskId: {
                    type: "string",
                    description: "The task ID to claim",
                },
                agentId: {
                    type: "string",
                    description: "External agent ID claiming the task (e.g., 'claude-code'). Omit for internal agents.",
                },
                agent_token: {
                    type: "string",
                    description: "Auth token for caller agent. Preferred over agentId.",
                },
                etaAt: {
                    type: "string",
                    description: "Expected completion timestamp (ISO-8601). Required for contract-bound tasks unless default ETA exists.",
                },
                etaSeconds: {
                    type: "number",
                    description: "Expected completion in seconds from now. Alternative to etaAt.",
                },
                planSummary: {
                    type: "string",
                    description: "Optional short execution plan for requester visibility.",
                },
                idempotency_key: {
                    type: "string",
                    description: "Optional idempotency key. Reusing the same key prevents duplicate claim transitions.",
                },
                requested_version: {
                    type: "string",
                    description: "Optional requested capability version for negotiation (currently supported for single-capability contract tasks).",
                },
            },
            required: ["taskId"],
        },
        async execute(_id, params) {
            api.logger?.info(`Ansible: claiming task`);
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId) {
                return toolResult({ error: "Ansible not initialized" });
            }
            try {
                const resolved = resolveEffectiveAgent(doc, nodeId, params.agentId, params.agent_token, getAuthMode(config));
                if (resolved.error)
                    return toolResult({ error: resolved.error });
                const effectiveAgent = resolved.effectiveAgent;
                if (!effectiveAgent)
                    return toolResult({ error: "Failed to resolve effective agent." });
                const tasks = doc.getMap("tasks");
                const resolvedKey = resolveTaskKey(tasks, params.taskId);
                if (typeof resolvedKey !== "string")
                    return toolResult(resolvedKey);
                const task = tasks.get(resolvedKey);
                if (!task) {
                    return toolResult({ error: "Task not found" });
                }
                const explicitAssignees = new Set();
                if (typeof task.assignedTo_agent === "string" && task.assignedTo_agent.trim().length > 0) {
                    explicitAssignees.add(task.assignedTo_agent.trim());
                }
                if (Array.isArray(task.assignedTo_agents)) {
                    for (const a of task.assignedTo_agents) {
                        if (typeof a === "string" && a.trim().length > 0)
                            explicitAssignees.add(a.trim());
                    }
                }
                if (explicitAssignees.size > 0 && !explicitAssignees.has(effectiveAgent)) {
                    return toolResult({ error: `Task is assigned to ${Array.from(explicitAssignees).join(", ")}; ${effectiveAgent} cannot claim it.` });
                }
                const idempotencyKey = resolveTaskIdempotencyKey(params, task.id, "claim", effectiveAgent);
                const seenIdempotency = readTaskIdempotency(task);
                if (seenIdempotency[idempotencyKey]) {
                    return toolResult({
                        success: true,
                        idempotent: true,
                        message: `Idempotent replay ignored for claim: ${task.title}`,
                        task: { id: task.id, title: task.title, status: task.status },
                    });
                }
                if (task.status !== "pending") {
                    const hasExplicitIdempotencyKey = typeof params.idempotency_key === "string" &&
                        String(params.idempotency_key || "").trim().length > 0;
                    if (hasExplicitIdempotencyKey && task.status === "claimed" && task.claimedBy_agent === effectiveAgent) {
                        return toolResult({
                            success: true,
                            idempotent: true,
                            message: `Idempotent replay treated as already-claimed by ${effectiveAgent}.`,
                            task: { id: task.id, title: task.title, status: task.status },
                        });
                    }
                    return toolResult({ error: `Task is already ${task.status}` });
                }
                const ansibleMeta = ((task.metadata || {}).ansible || {});
                const defaultEtaSeconds = typeof ansibleMeta.defaultEtaSeconds === "number" && Number.isFinite(ansibleMeta.defaultEtaSeconds)
                    ? Math.floor(ansibleMeta.defaultEtaSeconds)
                    : 0;
                const needsEta = taskNeedsContractEta(task);
                const eta = parseEtaAtFromClaim(params, defaultEtaSeconds);
                if (eta.error)
                    return toolResult({ error: eta.error });
                if (needsEta && !eta.etaAtIso) {
                    return toolResult({ error: "This task requires etaAt or etaSeconds on claim (ACK accepted contract)." });
                }
                const planSummary = typeof params.planSummary === "string" && params.planSummary.trim().length > 0
                    ? validateString(params.planSummary, VALIDATION_LIMITS.maxDescriptionLength, "planSummary").trim()
                    : undefined;
                const requestedVersion = typeof params.requested_version === "string" && params.requested_version.trim().length > 0
                    ? validateString(params.requested_version, 120, "requested_version").trim()
                    : undefined;
                const contractCapabilitiesRaw = ansibleMeta.contract?.capabilities || [];
                const contractCapabilities = contractCapabilitiesRaw.filter((c) => !!c && typeof c === "object");
                let versionNegotiation;
                if (requestedVersion) {
                    if (contractCapabilities.length === 0) {
                        return toolResult({ error: "requested_version supplied but task has no capability contract metadata." });
                    }
                    if (contractCapabilities.length > 1) {
                        return toolResult({
                            error: "requested_version for multi-capability tasks is not supported yet. Use explicit to-agent routing or single capability contract.",
                        });
                    }
                    const c = contractCapabilities[0];
                    const capabilityId = typeof c.capabilityId === "string" ? c.capabilityId : "unknown";
                    const resolvedVersion = typeof c.version === "string" ? c.version : requestedVersion;
                    const compatibilityMode = c.compatibilityMode || "strict";
                    if (requestedVersion !== resolvedVersion && compatibilityMode === "strict") {
                        return toolResult({
                            error: `requested_version '${requestedVersion}' is incompatible with published version '${resolvedVersion}' for '${capabilityId}' (strict mode).`,
                        });
                    }
                    versionNegotiation = {
                        capabilityId,
                        requestedVersion,
                        resolvedVersion,
                        compatibilityMode,
                    };
                }
                const now = Date.now();
                const nextMetadata = {
                    ...(task.metadata || {}),
                    ansible: {
                        ...ansibleMeta,
                        ack: {
                            state: "accepted",
                            required: true,
                            requireEta: true,
                            acceptedAt: now,
                            acceptedByAgentId: effectiveAgent,
                            acceptedByNodeId: nodeId,
                            etaAt: eta.etaAtIso,
                            planSummary,
                            versionNegotiation,
                        },
                    },
                };
                const claimedBase = {
                    ...task,
                    status: "claimed",
                    claimedBy_agent: effectiveAgent,
                    claimedBy_node: nodeId,
                    claimedAt: now,
                    metadata: nextMetadata,
                    updatedAt: now,
                    updates: [
                        { at: now, by_agent: effectiveAgent, status: "claimed", note: "claimed" },
                        ...(task.updates || []),
                    ].slice(0, 50),
                };
                const claimed = attachTaskIdempotency(claimedBase, idempotencyKey, "claim", effectiveAgent, now);
                const slaMeta = computeTaskSlaMetadata(claimed, now);
                const claimedWithSla = slaMeta
                    ? {
                        ...claimed,
                        metadata: {
                            ...(claimed.metadata || {}),
                            ansible: {
                                ...((claimed.metadata || {}).ansible || {}),
                                sla: slaMeta,
                            },
                        },
                    }
                    : claimed;
                tasks.set(resolvedKey, claimedWithSla);
                const notifyMessageId = notifyTaskOwner(doc, nodeId, claimedWithSla, {
                    kind: "accepted",
                    note: "task accepted",
                    etaAt: eta.etaAtIso,
                    planSummary,
                });
                return toolResult({
                    success: true,
                    message: `Claimed task: ${task.title}`,
                    notifyMessageId,
                    accepted: {
                        byAgentId: effectiveAgent,
                        byNodeId: nodeId,
                        etaAt: eta.etaAtIso,
                        planSummary,
                        versionNegotiation,
                    },
                    task: {
                        id: task.id,
                        title: task.title,
                        description: task.description,
                        context: task.context,
                        intent: task.intent,
                    },
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_update_task ===
    api.registerTool({
        name: "ansible_update_task",
        label: "Ansible Update Task",
        description: "Update a claimed task's status (in_progress/failed) with an optional note. Optionally notify the task creator.",
        parameters: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "The task ID to update" },
                status: {
                    type: "string",
                    description: "New status: in_progress|failed",
                },
                note: {
                    type: "string",
                    description: "Short progress note (what changed, what's next)",
                },
                notify: {
                    type: "boolean",
                    description: "If true, send an update message to the task creator. Defaults to false.",
                },
                result: {
                    type: "string",
                    description: "Optional result text (useful when status=failed).",
                },
                agentId: {
                    type: "string",
                    description: "External agent ID updating the task (e.g., 'claude-code'). Omit for internal agents.",
                },
                agent_token: {
                    type: "string",
                    description: "Auth token for caller agent. Preferred over agentId.",
                },
                idempotency_key: {
                    type: "string",
                    description: "Optional idempotency key. Reusing the same key prevents duplicate update transitions.",
                },
            },
            required: ["taskId", "status"],
        },
        async execute(_id, params) {
            api.logger?.info(`Ansible: updating task`);
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId) {
                return toolResult({ error: "Ansible not initialized" });
            }
            try {
                const resolved = resolveEffectiveAgent(doc, nodeId, params.agentId, params.agent_token, getAuthMode(config));
                if (resolved.error)
                    return toolResult({ error: resolved.error });
                const effectiveAgent = resolved.effectiveAgent;
                if (!effectiveAgent)
                    return toolResult({ error: "Failed to resolve effective agent." });
                const tasks = doc.getMap("tasks");
                const resolvedKey = resolveTaskKey(tasks, params.taskId);
                if (typeof resolvedKey !== "string")
                    return toolResult(resolvedKey);
                const task = tasks.get(resolvedKey);
                if (!task)
                    return toolResult({ error: "Task not found" });
                const idempotencyKey = resolveTaskIdempotencyKey(params, task.id, "update", effectiveAgent);
                const seenIdempotency = readTaskIdempotency(task);
                if (seenIdempotency[idempotencyKey]) {
                    return toolResult({
                        success: true,
                        idempotent: true,
                        message: `Idempotent replay ignored for update: ${task.title}`,
                        task: { id: task.id, title: task.title, status: task.status },
                    });
                }
                if (task.claimedBy_agent !== effectiveAgent) {
                    return toolResult({ error: "You don't have this task claimed" });
                }
                const status = params.status;
                if (status !== "in_progress" && status !== "failed") {
                    return toolResult({ error: "status must be in_progress or failed" });
                }
                const ansibleMeta = ((task.metadata || {}).ansible || {});
                const ackMeta = (ansibleMeta.ack || {});
                if (taskNeedsContractEta(task) && status === "in_progress" && ackMeta.state !== "accepted") {
                    return toolResult({ error: "Task contract requires accepted ACK before in_progress updates." });
                }
                const note = params.note
                    ? validateString(params.note, VALIDATION_LIMITS.maxTitleLength, "note")
                    : undefined;
                const result = params.result
                    ? validateString(params.result, VALIDATION_LIMITS.maxResultLength, "result")
                    : undefined;
                if (status === "failed" && !note && !result) {
                    return toolResult({ error: "failed status requires note or result for diagnostics" });
                }
                const updatedBase = {
                    ...task,
                    status: status,
                    updatedAt: Date.now(),
                    result: result ?? task.result,
                    updates: [
                        { at: Date.now(), by_agent: effectiveAgent, status: status, note },
                        ...(task.updates || []),
                    ].slice(0, 50),
                };
                const now = Date.now();
                let updated = attachTaskIdempotency(updatedBase, idempotencyKey, "update", effectiveAgent, now);
                const ansible = ((updated.metadata || {}).ansible || {});
                const sla = (ansible.sla || {}) || {};
                if (status === "in_progress") {
                    updated = {
                        ...updated,
                        metadata: {
                            ...(updated.metadata || {}),
                            ansible: {
                                ...ansible,
                                sla: {
                                    ...sla,
                                    lastProgressAt: now,
                                    progressByAt: typeof sla.progressByAt === "number" ? Math.max(sla.progressByAt, now + 900 * 1000) : now + 900 * 1000,
                                },
                            },
                        },
                    };
                }
                tasks.set(resolvedKey, updated);
                const notify = params.notify === true;
                const notifyMessageId = notify
                    ? notifyTaskOwner(doc, nodeId, updated, { kind: status === "failed" ? "failed" : "update", note, result })
                    : null;
                return toolResult({
                    success: true,
                    message: `Updated task: ${task.title}`,
                    notified: notify,
                    notifyMessageId,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_complete_task ===
    api.registerTool({
        name: "ansible_complete_task",
        label: "Ansible Complete Task",
        description: "Mark a task as completed with an optional result.",
        parameters: {
            type: "object",
            properties: {
                taskId: {
                    type: "string",
                    description: "The task ID to complete",
                },
                result: {
                    type: "string",
                    description: "Summary of the result or outcome",
                },
                agentId: {
                    type: "string",
                    description: "External agent ID completing the task (e.g., 'claude-code'). Omit for internal agents.",
                },
                agent_token: {
                    type: "string",
                    description: "Auth token for caller agent. Preferred over agentId.",
                },
                idempotency_key: {
                    type: "string",
                    description: "Optional idempotency key. Reusing the same key prevents duplicate complete transitions.",
                },
            },
            required: ["taskId"],
        },
        async execute(_id, params) {
            api.logger?.info(`Ansible: completing task`);
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId) {
                return toolResult({ error: "Ansible not initialized" });
            }
            try {
                const resolved = resolveEffectiveAgent(doc, nodeId, params.agentId, params.agent_token, getAuthMode(config));
                if (resolved.error)
                    return toolResult({ error: resolved.error });
                const effectiveAgent = resolved.effectiveAgent;
                if (!effectiveAgent)
                    return toolResult({ error: "Failed to resolve effective agent." });
                const tasks = doc.getMap("tasks");
                const resolvedKey = resolveTaskKey(tasks, params.taskId);
                if (typeof resolvedKey !== "string")
                    return toolResult(resolvedKey);
                const task = tasks.get(resolvedKey);
                if (!task) {
                    return toolResult({ error: "Task not found" });
                }
                const idempotencyKey = resolveTaskIdempotencyKey(params, task.id, "complete", effectiveAgent);
                const seenIdempotency = readTaskIdempotency(task);
                if (seenIdempotency[idempotencyKey]) {
                    return toolResult({
                        success: true,
                        idempotent: true,
                        message: `Idempotent replay ignored for complete: ${task.title}`,
                        task: { id: task.id, title: task.title, status: task.status },
                    });
                }
                if (task.claimedBy_agent !== effectiveAgent) {
                    return toolResult({ error: "You don't have this task claimed" });
                }
                const result = params.result ? validateString(params.result, VALIDATION_LIMITS.maxResultLength, "result") : undefined;
                if (taskNeedsContractEta(task) && !result) {
                    return toolResult({ error: "Contract-bound task completion requires --result" });
                }
                const completedBase = {
                    ...task,
                    status: "completed",
                    completedAt: Date.now(),
                    result,
                    updatedAt: Date.now(),
                    updates: [
                        { at: Date.now(), by_agent: effectiveAgent, status: "completed", note: "completed" },
                        ...(task.updates || []),
                    ].slice(0, 50),
                };
                const completed = attachTaskIdempotency(completedBase, idempotencyKey, "complete", effectiveAgent, Date.now());
                tasks.set(resolvedKey, completed);
                // Always notify the asker on completion.
                const notifyMessageId = notifyTaskOwner(doc, nodeId, completed, { kind: "completed", result });
                return toolResult({
                    success: true,
                    message: `Completed task: ${task.title}`,
                    notifyMessageId,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_sla_sweep ===
    api.registerTool({
        name: "ansible_sla_sweep",
        label: "Ansible SLA Sweep",
        description: "Evaluate task SLA windows (accept/progress/complete) and emit escalation events for overdue tasks.",
        parameters: {
            type: "object",
            properties: {
                dry_run: {
                    type: "boolean",
                    description: "If true, report breaches without writing escalations.",
                },
                limit: {
                    type: "number",
                    description: "Optional max task records to inspect.",
                },
                record_only: {
                    type: "boolean",
                    description: "If true, record escalation outcomes without sending escalation messages.",
                },
                max_messages: {
                    type: "number",
                    description: "Optional cap for escalation messages this run.",
                },
                fyi_agents: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional fallback FYI agents when requester/claimer are unavailable.",
                },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const dryRun = params.dry_run === true;
                const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.floor(params.limit) : undefined;
                const recordOnly = params.record_only === true;
                const maxMessages = typeof params.max_messages === "number" && Number.isFinite(params.max_messages)
                    ? Math.floor(params.max_messages)
                    : undefined;
                const fyiAgents = Array.isArray(params.fyi_agents)
                    ? params.fyi_agents.filter((a) => typeof a === "string").map((a) => String(a))
                    : undefined;
                return toolResult(runSlaSweep(doc, nodeId, { dryRun, limit, recordOnly, maxMessages, fyiAgents }));
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_read_messages ===
    api.registerTool({
        name: "ansible_read_messages",
        label: "Ansible Read Messages",
        description: "Read messages from other hemispheres of Jane. Returns message content, sender, and timestamp. By default returns unread messages; use the 'all' flag to include read messages too.",
        parameters: {
            type: "object",
            properties: {
                all: {
                    type: "boolean",
                    description: "If true, return all messages (not just unread). Defaults to false.",
                },
                from: {
                    type: "string",
                    description: "Filter messages from a specific node ID.",
                },
                limit: {
                    type: "number",
                    description: "Maximum number of messages to return. Defaults to 20.",
                },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId) {
                return toolResult({ error: "Ansible not initialized" });
            }
            try {
                requireAuth(nodeId);
                const messagesMap = doc.getMap("messages");
                const showAll = params.all === true;
                const fromFilter = params.from;
                const limit = params.limit || 20;
                const results = [];
                for (const [id, msg] of messagesMap.entries()) {
                    const message = msg;
                    // Skip messages not addressed to us (unless broadcast)
                    if (message.to_agents?.length && !message.to_agents.includes(nodeId))
                        continue;
                    const unread = !message.readBy_agents.includes(nodeId);
                    // By default only show unread
                    if (!showAll && !unread)
                        continue;
                    // Apply from filter
                    if (fromFilter && message.from_agent !== fromFilter)
                        continue;
                    results.push({
                        id,
                        from: message.from_agent,
                        to: message.to_agents,
                        content: message.content,
                        timestamp: new Date(message.timestamp).toISOString(),
                        updatedAt: Number.isFinite(message.updatedAt)
                            ? new Date(message.updatedAt).toISOString()
                            : undefined,
                        unread,
                    });
                }
                // Sort newest activity first (fallback to creation timestamp)
                results.sort((a, b) => {
                    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : new Date(a.timestamp).getTime();
                    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : new Date(b.timestamp).getTime();
                    return tb - ta;
                });
                return toolResult({
                    myId: nodeId,
                    messages: results.slice(0, limit),
                    total: results.length,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_mark_read ===
    api.registerTool({
        name: "ansible_mark_read",
        label: "Ansible Mark Read",
        description: "Mark messages as read.",
        parameters: {
            type: "object",
            properties: {
                messageIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "Message IDs to mark as read. If omitted, marks all unread messages as read.",
                },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId) {
                return toolResult({ error: "Ansible not initialized" });
            }
            try {
                requireAuth(nodeId);
                const messages = doc.getMap("messages");
                const messageIds = params.messageIds;
                let count = 0;
                for (const [id, msg] of messages.entries()) {
                    const message = msg;
                    if (messageIds && !messageIds.includes(id))
                        continue;
                    if (message.readBy_agents.includes(nodeId))
                        continue;
                    if (message.to_agents?.length && !message.to_agents.includes(nodeId))
                        continue;
                    messages.set(id, {
                        ...message,
                        readBy_agents: [...message.readBy_agents, nodeId],
                        updatedAt: Date.now(),
                    });
                    count++;
                }
                return toolResult({
                    success: true,
                    message: `Marked ${count} message(s) as read`,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_delete_messages ===
    api.registerTool({
        name: "ansible_delete_messages",
        label: "Ansible Delete Messages (Operator Only)",
        description: "DANGEROUS/DESTRUCTIVE. Operator-only emergency cleanup to permanently delete messages from the shared ansible document. Strongly discouraged for agent workflows.",
        parameters: {
            type: "object",
            properties: {
                messageIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "Exact message IDs to delete.",
                },
                all: {
                    type: "boolean",
                    description: "Delete all messages. Must be combined with confirm.",
                },
                from: {
                    type: "string",
                    description: "Delete messages from a specific sender agent ID.",
                },
                conversation_id: {
                    type: "string",
                    description: "Delete messages matching metadata.conversation_id.",
                },
                before: {
                    type: "string",
                    description: "Delete messages older than this ISO timestamp (inclusive).",
                },
                limit: {
                    type: "number",
                    description: "Maximum number of matching messages to delete (safety cap). Default 200.",
                },
                dryRun: {
                    type: "boolean",
                    description: "If true, returns matches without deleting.",
                },
                reason: {
                    type: "string",
                    description: "Required operator justification (min 15 chars).",
                },
                from_agent: {
                    type: "string",
                    description: "Required acting agent for admin deletes. Must match configured admin agent id (default: admin).",
                },
                agent_token: {
                    type: "string",
                    description: "Auth token for acting admin agent. Preferred over from_agent.",
                },
                confirm: {
                    type: "string",
                    description: "Required literal confirmation: DELETE_MESSAGES",
                },
            },
            required: ["reason", "confirm"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId) {
                return toolResult({ error: "Ansible not initialized" });
            }
            try {
                requireAuth(nodeId);
                requireAdmin(nodeId, doc);
                const adminAgentId = typeof config?.adminAgentId === "string" && config.adminAgentId.trim().length > 0
                    ? config.adminAgentId.trim()
                    : "admin";
                const authMode = getAuthMode(config);
                const requestedFrom = typeof params.from_agent === "string" ? String(params.from_agent) : undefined;
                const token = typeof params.agent_token === "string" && params.agent_token.trim().length > 0
                    ? params.agent_token.trim()
                    : undefined;
                if (!token)
                    return toolResult({ error: "agent_token is required for invite." });
                const tokenActor = resolveAgentByToken(doc, token);
                if (!tokenActor)
                    return toolResult({ error: "Invalid agent_token." });
                const effectiveFrom = tokenActor;
                if (tokenActor && requestedFrom && requestedFrom.trim() && requestedFrom.trim() !== tokenActor) {
                    return toolResult({
                        error: "from_agent does not match token identity. Omit from_agent when using agent_token.",
                    });
                }
                requireAdminActor(doc, nodeId, adminAgentId, effectiveFrom);
                const confirm = String(params.confirm || "");
                if (confirm !== "DELETE_MESSAGES") {
                    return toolResult({
                        error: "Refusing delete. Set confirm to exact string: DELETE_MESSAGES",
                    });
                }
                const reason = validateString(params.reason, VALIDATION_LIMITS.maxDescriptionLength, "reason");
                if (reason.trim().length < 15) {
                    return toolResult({
                        error: "reason must be at least 15 characters",
                    });
                }
                const all = params.all === true;
                const messageIds = Array.isArray(params.messageIds)
                    ? (params.messageIds.map((v) => String(v).trim()).filter(Boolean))
                    : [];
                const from = typeof params.from === "string" && params.from.trim() ? params.from.trim() : undefined;
                const conversationId = typeof params.conversation_id === "string" && params.conversation_id.trim()
                    ? params.conversation_id.trim()
                    : undefined;
                const beforeRaw = typeof params.before === "string" ? params.before.trim() : "";
                const beforeMs = beforeRaw ? Date.parse(beforeRaw) : undefined;
                if (beforeRaw && !Number.isFinite(beforeMs)) {
                    return toolResult({ error: "before must be a valid ISO timestamp" });
                }
                const dryRun = params.dryRun === true;
                const limit = params.limit === undefined ? 200 : validateNumber(params.limit, "limit");
                if (limit < 1 || limit > 5000) {
                    return toolResult({ error: "limit must be between 1 and 5000" });
                }
                const hasFilter = all || messageIds.length > 0 || !!from || !!conversationId || beforeMs !== undefined;
                if (!hasFilter) {
                    return toolResult({
                        error: "Refusing delete without selection. Provide one of: all, messageIds, from, conversation_id, before.",
                    });
                }
                const messages = doc.getMap("messages");
                const idSet = new Set(messageIds);
                const matches = [];
                for (const [id, msg] of messages.entries()) {
                    const message = msg;
                    let matched = all;
                    if (!matched && idSet.size > 0 && idSet.has(id))
                        matched = true;
                    if (!matched && from && message.from_agent === from)
                        matched = true;
                    if (!matched && conversationId && message.metadata?.conversation_id === conversationId)
                        matched = true;
                    if (!matched && beforeMs !== undefined && Number.isFinite(message.timestamp) && message.timestamp <= beforeMs) {
                        matched = true;
                    }
                    if (!matched)
                        continue;
                    matches.push(id);
                    if (matches.length >= limit)
                        break;
                }
                if (!dryRun) {
                    for (const id of matches)
                        messages.delete(id);
                }
                api.logger?.warn(`Ansible: ${dryRun ? "dry-run " : ""}deleted_messages count=${matches.length} by=${nodeId} reason=${reason}`);
                return toolResult({
                    success: true,
                    dryRun,
                    deleted: dryRun ? 0 : matches.length,
                    matched: matches.length,
                    truncated: matches.length >= limit,
                    messageIds: matches,
                    warning: "Permanent delete completed. This action is destructive and is intended for operator emergency cleanup only.",
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_register_agent ===
    api.registerTool({
        name: "ansible_register_agent",
        label: "Ansible Register Agent",
        description: "Register an agent (internal or external) in the ansible agent registry. External agents (e.g., claude, codex) use this to get an addressable inbox they can poll via the CLI.",
        parameters: {
            type: "object",
            properties: {
                agent_id: {
                    type: "string",
                    description: "Unique agent identifier (e.g., 'claude', 'codex')",
                },
                name: {
                    type: "string",
                    description: "Optional display name (e.g., 'Claude', 'Codex')",
                },
                type: {
                    type: "string",
                    enum: ["internal", "external"],
                    description: "internal = auto-dispatch via gateway; external = CLI poll only",
                },
                gateway: {
                    type: "string",
                    description: "Gateway node hosting this agent (only for internal agents; omit for external)",
                },
            },
            required: ["agent_id"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                const agentId = validateString(params.agent_id, 100, "agent_id");
                const agentType = params.type ?? "external";
                const agents = doc.getMap("agents");
                const existing = agents.get(agentId);
                if (existing) {
                    return toolResult({
                        error: `agent_id '${agentId}' already exists (type=${String(existing.type || "unknown")}, ` +
                            `gateway=${String(existing.gateway ?? "null")}). ` +
                            "Agent handles must be unique; use a different id.",
                        existing,
                    });
                }
                const newToken = mintAgentToken();
                const tokenHash = hashAgentToken(newToken);
                const record = {
                    name: typeof params.name === "string" ? params.name : undefined,
                    gateway: agentType === "internal" ? (typeof params.gateway === "string" ? params.gateway : nodeId) : null,
                    type: agentType,
                    registeredAt: Date.now(),
                    registeredBy: nodeId,
                    auth: {
                        tokenHash,
                        issuedAt: Date.now(),
                        tokenHint: tokenHintFromHash(tokenHash),
                    },
                };
                agents.set(agentId, record);
                return toolResult({
                    success: true,
                    agent_id: agentId,
                    record,
                    agent_token: newToken,
                    warning: "Store this token securely. It will not be shown again.",
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_issue_agent_token ===
    api.registerTool({
        name: "ansible_issue_agent_token",
        label: "Ansible Issue Agent Token",
        description: "Issue (rotate) an auth token for a registered agent. Returns token once; store securely.",
        parameters: {
            type: "object",
            properties: {
                agent_id: {
                    type: "string",
                    description: "Registered agent id to issue token for.",
                },
                from_agent: {
                    type: "string",
                    description: "Acting admin agent for token issue. Must match configured admin agent id (default: admin).",
                },
                agent_token: {
                    type: "string",
                    description: "Auth token for acting admin agent. Required.",
                },
            },
            required: ["agent_id"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                requireAdmin(nodeId, doc);
                const adminAgentId = typeof config?.adminAgentId === "string" && config.adminAgentId.trim().length > 0
                    ? config.adminAgentId.trim()
                    : "admin";
                const requestedFrom = typeof params.from_agent === "string" ? String(params.from_agent) : undefined;
                const token = typeof params.agent_token === "string" && params.agent_token.trim().length > 0
                    ? params.agent_token.trim()
                    : undefined;
                const actorResult = resolveAdminActorOrError(doc, nodeId, token, requestedFrom);
                if (actorResult.error)
                    return toolResult({ error: actorResult.error });
                requireAdminActor(doc, nodeId, adminAgentId, actorResult.actor);
                const agentId = validateString(params.agent_id, 100, "agent_id");
                const agents = doc.getMap("agents");
                const rec = agents.get(agentId);
                if (!rec)
                    return toolResult({ error: `Agent '${agentId}' is not registered.` });
                const newToken = mintAgentToken();
                const tokenHash = hashAgentToken(newToken);
                const next = {
                    ...rec,
                    auth: {
                        tokenHash,
                        issuedAt: rec?.auth?.issuedAt ?? Date.now(),
                        rotatedAt: Date.now(),
                        tokenHint: tokenHintFromHash(tokenHash),
                    },
                };
                agents.set(agentId, next);
                return toolResult({
                    success: true,
                    agent_id: agentId,
                    agent_token: newToken,
                    warning: "Store this token securely. It will not be shown again.",
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_rebind_agent ===
    api.registerTool({
        name: "ansible_rebind_agent",
        label: "Ansible Rebind Agent",
        description: "Admin-only: update an internal agent's gateway binding (used for node rename/migration cleanup).",
        parameters: {
            type: "object",
            properties: {
                agent_id: {
                    type: "string",
                    description: "Internal agent id to rebind.",
                },
                gateway: {
                    type: "string",
                    description: "Canonical gateway/node id to bind the internal agent to.",
                },
                from_agent: {
                    type: "string",
                    description: "Acting admin agent id (must match configured admin agent).",
                },
                agent_token: {
                    type: "string",
                    description: "Auth token for acting admin agent. Preferred over from_agent.",
                },
            },
            required: ["agent_id", "gateway"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                requireAdmin(nodeId, doc);
                const adminAgentId = typeof config?.adminAgentId === "string" && config.adminAgentId.trim().length > 0
                    ? config.adminAgentId.trim()
                    : "admin";
                const requestedFrom = typeof params.from_agent === "string" ? String(params.from_agent) : undefined;
                const token = typeof params.agent_token === "string" && params.agent_token.trim().length > 0
                    ? params.agent_token.trim()
                    : undefined;
                const actorResult = resolveAdminActorOrError(doc, nodeId, token, requestedFrom);
                if (actorResult.error)
                    return toolResult({ error: actorResult.error });
                requireAdminActor(doc, nodeId, adminAgentId, actorResult.actor);
                const agentId = validateString(params.agent_id, 100, "agent_id").trim();
                const gateway = validateString(params.gateway, 120, "gateway").trim();
                const agents = doc.getMap("agents");
                const nodes = doc.getMap("nodes");
                const rec = agents.get(agentId);
                if (!rec)
                    return toolResult({ error: `Agent '${agentId}' is not registered.` });
                if (rec.type !== "internal") {
                    return toolResult({ error: `Agent '${agentId}' is type '${String(rec.type)}'; only internal agents can be rebound.` });
                }
                if (!nodes.has(gateway)) {
                    return toolResult({ error: `Gateway '${gateway}' is not an authorized node.` });
                }
                const previousGateway = typeof rec.gateway === "string" ? rec.gateway : null;
                if (previousGateway === gateway) {
                    return toolResult({
                        success: true,
                        changed: false,
                        agent_id: agentId,
                        gateway,
                        previous_gateway: previousGateway,
                    });
                }
                agents.set(agentId, {
                    ...rec,
                    gateway,
                    reboundAt: Date.now(),
                    reboundBy: actorResult.actor,
                });
                return toolResult({
                    success: true,
                    changed: true,
                    agent_id: agentId,
                    gateway,
                    previous_gateway: previousGateway,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_normalize_internal_gateways ===
    api.registerTool({
        name: "ansible_normalize_internal_gateways",
        label: "Ansible Normalize Internal Gateways",
        description: "Admin-only: normalize legacy internal agent gateway ids to canonical authorized node ids where mapping is unambiguous.",
        parameters: {
            type: "object",
            properties: {
                dry_run: {
                    type: "boolean",
                    description: "If true, report candidate changes without mutating state.",
                },
                from_agent: {
                    type: "string",
                    description: "Acting admin agent id (must match configured admin agent).",
                },
                agent_token: {
                    type: "string",
                    description: "Auth token for acting admin agent. Preferred over from_agent.",
                },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                requireAdmin(nodeId, doc);
                const adminAgentId = typeof config?.adminAgentId === "string" && config.adminAgentId.trim().length > 0
                    ? config.adminAgentId.trim()
                    : "admin";
                const requestedFrom = typeof params.from_agent === "string" ? String(params.from_agent) : undefined;
                const token = typeof params.agent_token === "string" && params.agent_token.trim().length > 0
                    ? params.agent_token.trim()
                    : undefined;
                const actorResult = resolveAdminActorOrError(doc, nodeId, token, requestedFrom);
                if (actorResult.error)
                    return toolResult({ error: actorResult.error });
                requireAdminActor(doc, nodeId, adminAgentId, actorResult.actor);
                const dryRun = params.dry_run === true;
                const agents = doc.getMap("agents");
                const nodes = doc.getMap("nodes");
                const nodeIds = Array.from(nodes.keys()).map((k) => String(k));
                const canonicalToNodeIds = new Map();
                for (const nid of nodeIds) {
                    const c = canonicalGatewayId(nid);
                    if (!c)
                        continue;
                    const arr = canonicalToNodeIds.get(c) || [];
                    arr.push(nid);
                    canonicalToNodeIds.set(c, arr);
                }
                const changes = [];
                for (const [agentId, raw] of agents.entries()) {
                    const rec = raw;
                    if (!rec || rec.type !== "internal")
                        continue;
                    const currentGateway = typeof rec.gateway === "string" ? rec.gateway.trim() : "";
                    if (!currentGateway)
                        continue;
                    if (nodes.has(currentGateway))
                        continue;
                    const canonical = canonicalGatewayId(currentGateway);
                    if (!canonical)
                        continue;
                    const candidates = canonicalToNodeIds.get(canonical) || [];
                    if (candidates.length !== 1)
                        continue;
                    const nextGateway = candidates[0];
                    if (!nextGateway || nextGateway === currentGateway)
                        continue;
                    changes.push({ agent_id: String(agentId), from_gateway: currentGateway, to_gateway: nextGateway });
                }
                if (!dryRun) {
                    const now = Date.now();
                    for (const c of changes) {
                        const rec = agents.get(c.agent_id);
                        if (!rec || rec.type !== "internal")
                            continue;
                        agents.set(c.agent_id, {
                            ...rec,
                            gateway: c.to_gateway,
                            reboundAt: now,
                            reboundBy: actorResult.actor,
                            reboundReason: "normalize_internal_gateways",
                        });
                    }
                }
                return toolResult({
                    success: true,
                    dryRun,
                    scannedInternalAgents: Array.from(agents.values()).filter((v) => v?.type === "internal").length,
                    changed: dryRun ? 0 : changes.length,
                    candidates: changes.length,
                    changes,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_disable_agent ===
    api.registerTool({
        name: "ansible_disable_agent",
        label: "Ansible Disable Agent",
        description: "Admin-only: disable an agent identity without deleting history. Disabled agents cannot authenticate or receive new distribution tasks.",
        parameters: {
            type: "object",
            properties: {
                agent_id: {
                    type: "string",
                    description: "Agent id to disable.",
                },
                reason: {
                    type: "string",
                    description: "Optional reason for audit trail.",
                },
                from_agent: {
                    type: "string",
                    description: "Acting admin agent id (must match configured admin agent).",
                },
                agent_token: {
                    type: "string",
                    description: "Auth token for acting admin agent. Preferred over from_agent.",
                },
            },
            required: ["agent_id"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                requireAdmin(nodeId, doc);
                const adminAgentId = typeof config?.adminAgentId === "string" && config.adminAgentId.trim().length > 0
                    ? config.adminAgentId.trim()
                    : "admin";
                const requestedFrom = typeof params.from_agent === "string" ? String(params.from_agent) : undefined;
                const token = typeof params.agent_token === "string" && params.agent_token.trim().length > 0
                    ? params.agent_token.trim()
                    : undefined;
                const actorResult = resolveAdminActorOrError(doc, nodeId, token, requestedFrom);
                if (actorResult.error)
                    return toolResult({ error: actorResult.error });
                requireAdminActor(doc, nodeId, adminAgentId, actorResult.actor);
                const agentId = validateString(params.agent_id, 100, "agent_id").trim();
                if (agentId === adminAgentId) {
                    return toolResult({ error: `Refusing to disable configured admin agent '${adminAgentId}'.` });
                }
                const reason = typeof params.reason === "string" && params.reason.trim().length > 0
                    ? validateString(params.reason, 500, "reason").trim()
                    : undefined;
                const agents = doc.getMap("agents");
                const rec = agents.get(agentId);
                if (!rec)
                    return toolResult({ error: `Agent '${agentId}' is not registered.` });
                if (typeof rec.disabledAt === "number") {
                    return toolResult({
                        success: true,
                        changed: false,
                        agent_id: agentId,
                        disabledAt: rec.disabledAt,
                        disableReason: rec.disableReason,
                    });
                }
                const now = Date.now();
                agents.set(agentId, {
                    ...rec,
                    disabledAt: now,
                    disabledBy: actorResult.actor,
                    disableReason: reason,
                });
                return toolResult({
                    success: true,
                    changed: true,
                    agent_id: agentId,
                    disabledAt: now,
                    disableReason: reason,
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_invite_agent ===
    api.registerTool({
        name: "ansible_invite_agent",
        label: "Ansible Invite Agent",
        description: "Admin-only: issue a temporary one-time invite token for a coding agent. Agent must accept invite to receive a permanent token.",
        parameters: {
            type: "object",
            properties: {
                agent_id: {
                    type: "string",
                    description: "Target external agent id (e.g., codex, claude).",
                },
                ttl_minutes: {
                    type: "number",
                    description: "Invite TTL in minutes (default 15, range 1-1440).",
                },
                from_agent: {
                    type: "string",
                    description: "Acting admin agent id (must match configured admin agent).",
                },
                agent_token: {
                    type: "string",
                    description: "Auth token for acting admin agent. Preferred over from_agent.",
                },
            },
            required: ["agent_id"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                requireAdmin(nodeId, doc);
                const adminAgentId = typeof config?.adminAgentId === "string" && config.adminAgentId.trim().length > 0
                    ? config.adminAgentId.trim()
                    : "admin";
                const requestedFrom = typeof params.from_agent === "string" ? String(params.from_agent) : undefined;
                const token = typeof params.agent_token === "string" && params.agent_token.trim().length > 0
                    ? params.agent_token.trim()
                    : undefined;
                const actorResult = resolveAdminActorOrError(doc, nodeId, token, requestedFrom);
                if (actorResult.error)
                    return toolResult({ error: actorResult.error });
                const effectiveFrom = actorResult.actor;
                requireAdminActor(doc, nodeId, adminAgentId, effectiveFrom);
                const agentId = validateString(params.agent_id, 100, "agent_id");
                const ttlRaw = params.ttl_minutes === undefined ? 15 : validateNumber(params.ttl_minutes, "ttl_minutes");
                const ttlMinutes = Math.floor(ttlRaw);
                if (ttlMinutes < 1 || ttlMinutes > 1440) {
                    return toolResult({ error: "ttl_minutes must be between 1 and 1440" });
                }
                const agents = doc.getMap("agents");
                const existing = agents.get(agentId);
                if (existing && existing.type !== "external") {
                    return toolResult({
                        error: `Agent '${agentId}' exists as type '${String(existing.type)}'. Invite flow is only for external coding agents.`,
                    });
                }
                if (!existing) {
                    agents.set(agentId, {
                        name: undefined,
                        gateway: null,
                        type: "external",
                        registeredAt: Date.now(),
                        registeredBy: nodeId,
                    });
                }
                const invites = getAgentInvitesMap(doc);
                if (!invites)
                    return toolResult({ error: "Ansible not initialized" });
                pruneExpiredAgentInvites(invites);
                const now = Date.now();
                const expiresAt = now + ttlMinutes * 60_000;
                const inviteToken = mintAgentInviteToken();
                const inviteId = randomUUID();
                invites.set(inviteId, {
                    agent_id: agentId,
                    tokenHash: hashAgentToken(inviteToken),
                    createdAt: now,
                    expiresAt,
                    createdBy: nodeId,
                    createdByAgent: effectiveFrom,
                });
                return toolResult({
                    success: true,
                    invite_id: inviteId,
                    agent_id: agentId,
                    invite_token: inviteToken,
                    expiresAt,
                    warning: "Temporary invite token: single-use, expires automatically, and cannot be retrieved again.",
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_accept_agent_invite ===
    api.registerTool({
        name: "ansible_accept_agent_invite",
        label: "Ansible Accept Agent Invite",
        description: "Accept a temporary invite token and receive a permanent agent token. Invite is invalidated after first successful use.",
        parameters: {
            type: "object",
            properties: {
                invite_token: {
                    type: "string",
                    description: "Temporary invite token issued by ansible_invite_agent.",
                },
            },
            required: ["invite_token"],
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                const inviteToken = validateString(params.invite_token, 200, "invite_token").trim();
                if (!inviteToken)
                    return toolResult({ error: "invite_token is required" });
                const invites = getAgentInvitesMap(doc);
                if (!invites)
                    return toolResult({ error: "Ansible not initialized" });
                pruneExpiredAgentInvites(invites);
                const found = findInviteByToken(invites, inviteToken);
                if (!found) {
                    return toolResult({ error: "Invalid, expired, or already-used invite_token." });
                }
                const { id: inviteId, invite } = found;
                const agentId = String(invite.agent_id || "").trim();
                if (!agentId)
                    return toolResult({ error: "Invite record is missing agent_id." });
                const agents = doc.getMap("agents");
                const existing = agents.get(agentId);
                if (existing && existing.type !== "external") {
                    return toolResult({
                        error: `Agent '${agentId}' exists as type '${String(existing.type)}'. Invite flow only supports external agents.`,
                    });
                }
                const now = Date.now();
                const permanentToken = mintAgentToken();
                const tokenHash = hashAgentToken(permanentToken);
                const next = {
                    ...(existing || {
                        name: undefined,
                        gateway: null,
                        type: "external",
                        registeredAt: now,
                        registeredBy: invite.createdBy || nodeId,
                    }),
                    gateway: null,
                    type: "external",
                    auth: {
                        tokenHash,
                        issuedAt: existing?.auth?.issuedAt ?? now,
                        rotatedAt: now,
                        tokenHint: tokenHintFromHash(tokenHash),
                        acceptedAt: now,
                        acceptedByNode: nodeId,
                        acceptedByAgent: agentId,
                    },
                };
                agents.set(agentId, next);
                invites.set(inviteId, {
                    ...invite,
                    usedAt: now,
                    usedByNode: nodeId,
                    usedByAgent: agentId,
                });
                // Revoke any other outstanding invites for this agent after successful acceptance.
                for (const [id, raw] of invites.entries()) {
                    const cur = raw;
                    if (!cur || String(id) === inviteId)
                        continue;
                    if (cur.agent_id !== agentId)
                        continue;
                    if (cur.usedAt || cur.revokedAt)
                        continue;
                    invites.set(String(id), {
                        ...cur,
                        revokedAt: now,
                        revokedReason: `superseded-by:${inviteId}`,
                    });
                }
                return toolResult({
                    success: true,
                    agent_id: agentId,
                    agent_token: permanentToken,
                    warning: "Store this permanent token securely. It will not be shown again.",
                });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_list_agent_invites ===
    api.registerTool({
        name: "ansible_list_agent_invites",
        label: "Ansible List Agent Invites",
        description: "Admin-only: list temporary coding-agent invite records (active by default) without exposing raw invite tokens.",
        parameters: {
            type: "object",
            properties: {
                includeUsed: {
                    type: "boolean",
                    description: "Include already-used invites.",
                },
                includeRevoked: {
                    type: "boolean",
                    description: "Include revoked invites.",
                },
                includeExpired: {
                    type: "boolean",
                    description: "Include expired invites.",
                },
            },
        },
        async execute(_id, params) {
            const doc = getDoc();
            const nodeId = getNodeId();
            if (!doc || !nodeId)
                return toolResult({ error: "Ansible not initialized" });
            try {
                requireAuth(nodeId);
                requireAdmin(nodeId, doc);
                const invites = getAgentInvitesMap(doc);
                if (!invites)
                    return toolResult({ invites: [], total: 0 });
                const includeUsed = params.includeUsed === true;
                const includeRevoked = params.includeRevoked === true;
                const includeExpired = params.includeExpired === true;
                const now = Date.now();
                const out = [];
                for (const [id, raw] of invites.entries()) {
                    const invite = raw;
                    if (!invite)
                        continue;
                    const expired = typeof invite.expiresAt === "number" ? invite.expiresAt < now : false;
                    const used = !!invite.usedAt;
                    const revoked = !!invite.revokedAt;
                    if (!includeUsed && used)
                        continue;
                    if (!includeRevoked && revoked)
                        continue;
                    if (!includeExpired && expired)
                        continue;
                    out.push({
                        id: String(id),
                        agent_id: invite.agent_id,
                        createdAt: invite.createdAt,
                        expiresAt: invite.expiresAt,
                        createdBy: invite.createdBy,
                        createdByAgent: invite.createdByAgent,
                        usedAt: invite.usedAt,
                        usedByNode: invite.usedByNode,
                        usedByAgent: invite.usedByAgent,
                        revokedAt: invite.revokedAt,
                        revokedReason: invite.revokedReason,
                        status: used ? "used" : revoked ? "revoked" : expired ? "expired" : "active",
                    });
                }
                out.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
                return toolResult({ invites: out, total: out.length });
            }
            catch (err) {
                return toolResult({ error: err.message });
            }
        },
    });
    // === ansible_list_agents ===
    api.registerTool({
        name: "ansible_list_agents",
        label: "Ansible List Agents",
        description: "List all registered agents in the ansible network (internal and external).",
        parameters: {
            type: "object",
            properties: {},
        },
        async execute() {
            const doc = getDoc();
            if (!doc)
                return toolResult({ error: "Ansible not initialized" });
            const agents = doc.getMap("agents");
            const result = [];
            for (const [id, record] of agents.entries()) {
                const r = record;
                const auth = r.auth || undefined;
                const safeAuth = auth
                    ? {
                        issuedAt: auth.issuedAt,
                        rotatedAt: auth.rotatedAt,
                        tokenHint: typeof auth.tokenHint === "string" && auth.tokenHint.length > 0
                            ? auth.tokenHint
                            : typeof auth.tokenHash === "string"
                                ? tokenHintFromHash(auth.tokenHash)
                                : undefined,
                        acceptedAt: auth.acceptedAt,
                        acceptedByNode: auth.acceptedByNode,
                        acceptedByAgent: auth.acceptedByAgent,
                    }
                    : undefined;
                result.push({
                    ...r,
                    id,
                    auth: safeAuth,
                    disabledAt: typeof r.disabledAt === "number" ? r.disabledAt : undefined,
                    disabledBy: typeof r.disabledBy === "string" ? r.disabledBy : undefined,
                    disableReason: typeof r.disableReason === "string" ? r.disableReason : undefined,
                });
            }
            return toolResult({ agents: result, total: result.length });
        },
    });
}
//# sourceMappingURL=tools.js.map