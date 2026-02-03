# Project Ansible: Unified Coordination Layer & Second Brain Roadmap

This document outlines the plan to standardize, integrate, and secure the real-time coordination link between the Mac and VPS instances of Jane.

## 1. Architectural Vision
The goal is to transition from a collection of experimental scripts to a formal **Ansible Layer** that allows multiple OpenClaw instances to function as a single, distributed intelligence.

### Current State
- **Transport:** Tailscale WireGuard Mesh.
- **Relay:** `jane-shared-brain` (y-websocket server).
- **Rooms:** `jane-shared` (files) and `jane-coordination` (tasks/messages).
- **Interface:** Separate `.mjs` listener scripts using `openclaw system event` for injection.

### Target State
- **Transport:** Hardened Tailscale + ACLs.
- **Relay:** Authenticated Yjs Relay with Token-based Auth.
- **Integration:** Native OpenClaw Plugin managing the lifecycle and context injection.
- **Configuration:** Centralized settings in `openclaw.json`.

---

## 2. Standardization & Packaging
We will unify the communication protocols to ensure any new "hemisphere" can join the collective seamlessly.

### Unified Schema
- **Tasks (`tasks` map):**
  - `id`: Unique UUID.
  - `from` / `to`: Instance identifiers (e.g., `mac-jane`, `vps-jane`).
  - `description`: The natural language directive.
  - `status`: `pending` | `in-progress` | `completed` | `failed`.
  - `result`: JSON object containing execution output.
- **Messages (`messages` array):**
  - `content`: Text of the message.
  - `metadata`: Context like `urgent: true` or `replyTo`.
- **Pulse (`pulse` map):**
  - Real-time telemetry (uptime, platform, battery, sync status).

### The Ansible Core Library
Encapsulate all Yjs and file-watching logic into a single class-based Node.js module that can be imported by both the CLI and the Gateway plugin.

---

## 3. Deep OpenClaw Integration
Move away from "shelling out" to the CLI and integrate directly into the OpenClaw event loop.

### The Ansible Plugin (`openclaw-plugin-ansible`)
- **Lifecycle Management:** The plugin starts with the Gateway and maintains the persistent WebSocket.
- **Direct Injection:** Uses internal Gateway APIs to dispatch system events without the overhead of `openclaw system event`.
- **Context Providing:** Injects the current "Global State" (e.g., what the other hemisphere is doing) into the agent's system prompt.

### The Ansible Skill
- Tools for the agent to use:
  - `ansible.send_message(target, content)`
  - `ansible.delegate_task(target, task_description)`
  - `ansible.check_status()`

---

## 4. Security Hardening (Zero-Trust)
Security is non-negotiable for a system that allows remote execution and file synchronization.

### Immediate Fixes
- **Relay Authorization:** Implement a `?token=` requirement in the `jane-shared-brain` WebSocket server.
- **Credential Isolation:** Ensure `openclaw.json` and `auth-profiles.json` are strictly excluded from Yjs sync.
- **Network Restriction:** Configure Tailscale ACLs to only allow Jane instances to talk to the Relay port (1234).

### Long-term Safety
- **Origin Signing:** Every task in the Brain must be signed with a private key unique to the sending instance.
- **Sensitive Action Filtering:** Define a "Safe List" of tools. Any task requiring tools outside this list (e.g., `exec`, `write_file`) requires manual user approval via Telegram.

---

## 5. Implementation Roadmap

### Phase 1: Hardening (Immediate)
- [ ] Implement Token Auth in `server.mjs`.
- [ ] Update `sync-shared.mjs` and listeners to use the new Auth token.
- [ ] Sanitize `workspace/` to ensure no keys are being synced via Yjs.

### Phase 2: Standardization (Short-term)
- [ ] Consolidate `sync-shared.mjs` and `listener.mjs` into a unified `ansible-core.mjs`.
- [ ] Migrate all scripts to use the unified `tasks` and `messages` schemas.
- [ ] Implement `PM2` or `launchd` for robust process management on Mac.

### Phase 3: Native Integration (Long-term)
- [ ] Scaffold the official OpenClaw Ansible Plugin.
- [ ] Implement Heartbeat Hooks for automated status reporting.
- [ ] Enable "Human-in-the-loop" confirmations for remote tasks.

---
*Created: 2026-02-02*
*Status: Approved for implementation*
