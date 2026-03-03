# Dual-Track Release Runbook v1

Status: Draft  
Last updated: 2026-03-03

## Goal

Publish:

1. skill to ClawHub (`openclaw-skill-ansible`)
2. plugin to npm (`openclaw-plugin-ansible`)

without cross-wiring the two delivery channels.

## Channel Split

1. ClawHub: skill distribution (`SKILL.md`, metadata, instructions)
2. npm: gateway plugin runtime (`openclaw-plugin.json`, `dist/*`, CLI/tooling)

## A) Skill Preflight (ClawHub)

Run from plugin repo:

```bash
npm run test:skill:preflight -- --skill-dir=/Users/jaredlikes/code/openclaw-skill-ansible
```

Run the skill repo validator too:

```bash
/Users/jaredlikes/code/openclaw-skill-ansible/scripts/validate_skill.sh /Users/jaredlikes/code/openclaw-skill-ansible
```

Recommended metadata fields in skill `metadata.yaml` before publish:

1. `version`
2. `description`
3. `license`
4. `repository`

Then publish from skill repo (example):

```bash
cd /Users/jaredlikes/code/openclaw-skill-ansible
clawhub login
clawhub publish .
```

## B) Plugin Preflight (npm)

Run from plugin repo:

```bash
npm run release:preflight
```

This includes:

1. typecheck + build
2. release gate + provenance gate
3. npm preflight (`scripts/npm-publish-preflight.mjs`)

Notes:

1. package name is scoped: `@likesjx/openclaw-plugin-ansible`
2. `openclaw.plugin.json` version must match `package.json` version
3. `npm whoami` should pass before publish

Publish (example):

```bash
npm login
npm publish --access public
```

## C) Post-Publish Smoke

1. Install plugin from npm tarball/package in a clean test gateway.
2. Verify `openclaw ansible status`.
3. Run capability publish/unpublish smoke.
4. Confirm skill install/update path via ClawHub.

## Current Snapshot (2026-03-03)

1. Skill validator passes, but metadata is lean.
2. Plugin governance gates are in place and passing.
3. Bare npm name `ansible` is occupied; scoped package path is required.
