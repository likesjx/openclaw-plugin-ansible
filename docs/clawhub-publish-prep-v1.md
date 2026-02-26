# Clawhub Publish Prep v1

Status: Draft checklist  
Last updated: 2026-02-26

## Goal

Prepare the Ansible plugin/skill package for clean publication to Clawhub with minimal rework.

## 1) Package Identity and Metadata

- [ ] Confirm plugin name/id is stable and unique.
- [ ] Confirm version is semver and changelog-aligned.
- [ ] Add concise description and capability summary.
- [ ] Add maintainer/contact metadata.
- [ ] Add repository URL and docs URL.
- [ ] Verify license is explicit and compatible with publication.

## 2) Manifest and Config Surface

- [ ] `openclaw.plugin.json` includes all user-facing config with defaults.
- [ ] Config fields have descriptions and safe defaults.
- [ ] Experimental/unsafe flags are clearly labeled.
- [ ] Backward compatibility notes included for renamed fields.

## 3) Documentation Bundle

Include in publish bundle:

1. `README.md` (quickstart + security notes)
2. `docs/setup.md` (operator flow)
3. `docs/runtime-protocol-v1.md` (runtime contract)
4. `docs/skill-pair-manifest-schema-v1.md` (manifest contract)
5. `docs/skill-pair-publish-executor-v1.md` (gate behavior)
6. `docs/documentation-status-v1.md` (source-of-truth map)

Exclude from publish bundle (context only):

1. `docs/protocol.md` (historical)
2. migration-only notes unless explicitly needed by release

## 4) Security Readiness

- [ ] Auth gate defaults are safe for production profiles.
- [ ] Invite/token lifecycle documented and tested.
- [ ] No secrets/tokens in examples, tests, or docs.
- [ ] Signature/provenance checks implemented or clearly marked TODO.

## 5) Reliability Readiness

- [ ] Task lifecycle enforcement (accept ETA, update rules, completion contract) verified.
- [ ] Retry/idempotency behavior documented and tested.
- [ ] Rollback path tested for partial publish failures.
- [ ] Multi-node join/invite happy path tested.

## 6) Operator UX Readiness

- [ ] CLI examples for publish/update/unpublish are current.
- [ ] Error codes/messages are actionable.
- [ ] Troubleshooting section includes top failure cases.
- [ ] Minimal “first 15 minutes” tutorial path works end-to-end.

## 7) Quality Gate Before Submit

- [ ] `npm run typecheck`
- [ ] test suite green
- [ ] docs lint/spellcheck (if available)
- [ ] manual smoke on:
  - [ ] single-node
  - [ ] two-node invite/join
  - [ ] capability publish + task lifecycle

## 8) Release Notes Template

For each release, include:

1. What changed (user-visible)
2. Breaking changes (if any)
3. Migration steps
4. Security notes
5. Rollback guidance
