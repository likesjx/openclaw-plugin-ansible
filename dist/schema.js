/**
 * Ansible State Schema
 *
 * Defines the Yjs document structure for distributed coordination.
 */
// ============================================================================
// Validation Limits
// ============================================================================
export const VALIDATION_LIMITS = {
    maxTitleLength: 200,
    maxDescriptionLength: 5000,
    maxMessageLength: 10000,
    maxContextLength: 5000,
    maxResultLength: 5000,
    maxStateFileBytes: 50 * 1024 * 1024, // 50MB
};
// ============================================================================
// Constants
// ============================================================================
export const CONTEXT_LIMITS = {
    activeThreads: 3,
    recentDecisions: 3,
    pendingTasks: 5,
    unreadMessages: 5,
    maxAgeHours: 24,
};
export const MESSAGE_RETENTION = {
    maxAgeHours: 24,
    maxCount: 50,
    keepUnread: true,
};
export const STANDARD_CAPABILITIES = ["always-on", "local-files", "gpu"];
export const INVITE_TTL_MS = 15 * 60 * 1000; // 15 minutes
//# sourceMappingURL=schema.js.map