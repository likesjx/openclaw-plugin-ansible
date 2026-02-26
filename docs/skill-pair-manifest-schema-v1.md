# Skill Pair Manifest Schema v1

Status: Draft  
Last updated: 2026-02-26

## Purpose

Define the canonical manifest exchanged between:

1. `ansible-meta` (author/generator)
2. `ansible-main` (enforcer/executor)

`ansible-main` must treat this manifest as the source of truth for lifecycle gates.

## JSON Schema (Draft 2020-12)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "schema://ansible/skill-pair-manifest/1.0.0",
  "title": "SkillPairManifestV1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "manifestVersion",
    "capabilityId",
    "version",
    "ownerAgentId",
    "compatibilityMode",
    "delegationSkillRef",
    "executorSkillRef",
    "contract",
    "sla",
    "riskClass",
    "rollout",
    "governance",
    "provenance"
  ],
  "properties": {
    "manifestVersion": {
      "type": "string",
      "const": "1.0.0"
    },
    "capabilityId": {
      "type": "string",
      "minLength": 3,
      "maxLength": 160,
      "pattern": "^cap\\.[a-z0-9][a-z0-9._-]*$"
    },
    "version": {
      "type": "string",
      "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$"
    },
    "ownerAgentId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "standbyOwnerAgentIds": {
      "type": "array",
      "items": { "type": "string", "minLength": 1, "maxLength": 100 },
      "uniqueItems": true,
      "default": []
    },
    "compatibilityMode": {
      "type": "string",
      "enum": ["strict", "backward", "legacy-window"],
      "default": "strict"
    },
    "delegationSkillRef": { "$ref": "#/$defs/skillRef" },
    "executorSkillRef": { "$ref": "#/$defs/skillRef" },
    "contract": {
      "type": "object",
      "additionalProperties": false,
      "required": ["inputSchemaRef", "outputSchemaRef", "ackSchemaRef"],
      "properties": {
        "inputSchemaRef": { "type": "string", "minLength": 1, "maxLength": 400 },
        "outputSchemaRef": { "type": "string", "minLength": 1, "maxLength": 400 },
        "ackSchemaRef": { "type": "string", "minLength": 1, "maxLength": 400 }
      }
    },
    "sla": {
      "type": "object",
      "additionalProperties": false,
      "required": ["acceptSlaSeconds", "progressSlaSeconds", "completeSlaSeconds"],
      "properties": {
        "acceptSlaSeconds": { "type": "integer", "minimum": 10, "maximum": 3600, "default": 120 },
        "progressSlaSeconds": { "type": "integer", "minimum": 30, "maximum": 86400, "default": 900 },
        "completeSlaSeconds": { "type": "integer", "minimum": 60, "maximum": 604800, "default": 3600 }
      }
    },
    "riskClass": {
      "type": "string",
      "enum": ["low", "medium", "high"],
      "default": "medium"
    },
    "rollout": {
      "type": "object",
      "additionalProperties": false,
      "required": ["mode"],
      "properties": {
        "mode": { "type": "string", "enum": ["canary", "full"], "default": "canary" },
        "canaryTargets": {
          "type": "array",
          "items": { "type": "string", "minLength": 1, "maxLength": 100 },
          "uniqueItems": true,
          "default": []
        }
      }
    },
    "governance": {
      "type": "object",
      "additionalProperties": false,
      "required": ["requiresHumanApprovalForHighRisk", "signedManifestRequired"],
      "properties": {
        "requiresHumanApprovalForHighRisk": { "type": "boolean", "default": true },
        "signedManifestRequired": { "type": "boolean", "default": true }
      }
    },
    "provenance": {
      "type": "object",
      "additionalProperties": false,
      "required": ["publishedByAgentId", "manifestChecksum", "manifestSignature", "publishedAt"],
      "properties": {
        "publishedByAgentId": { "type": "string", "minLength": 1, "maxLength": 100 },
        "manifestChecksum": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
        "manifestSignature": { "type": "string", "minLength": 32, "maxLength": 8192 },
        "publishedAt": { "type": "string", "format": "date-time" }
      }
    }
  },
  "$defs": {
    "skillRef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "version"],
      "properties": {
        "name": { "type": "string", "minLength": 1, "maxLength": 200 },
        "version": { "type": "string", "minLength": 1, "maxLength": 120 },
        "path": { "type": "string", "maxLength": 400 },
        "source": { "type": "string", "maxLength": 400 }
      }
    }
  }
}
```

## Validation Rules

1. `ownerAgentId` must exist in `agents` map and be active.
2. `standbyOwnerAgentIds` may not contain `ownerAgentId`.
3. `rollout.mode=canary` should include at least one target unless environment has one eligible node.
4. `riskClass=high` requires `governance.requiresHumanApprovalForHighRisk=true`.
5. `manifestChecksum` must match canonicalized manifest payload.

## Canonicalization

Before computing checksum/signature:

1. sort object keys lexicographically
2. remove insignificant whitespace
3. UTF-8 encode
4. hash with SHA-256

## Storage Mapping

1. `capabilities.catalog.<capabilityId>`: materialized active fields.
2. `capabilities.manifests.<capabilityId>:<version>`: full immutable manifest.
3. `capabilities.revisions.<capabilityId>`: active/pending/archived pointers.
