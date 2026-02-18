# Update Architecture

This document defines the authoritative update model for ansible plugin operations.

## Scope Split (Intentional)

`openclaw ansible setup` updates **skill + config only**:

1. installs/updates `~/.openclaw/workspace/skills/ansible`
2. patches `~/.openclaw/openclaw.json` for `plugins.entries.ansible`
3. restarts gateway (unless `--no-restart`)

It does **not** update plugin code in the plugin install directory.

Plugin code updates are explicit and separate:

- `openclaw plugins update ansible`
- or reinstall (`openclaw plugins install likesjx/openclaw-plugin-ansible`)

Then restart gateway.

## Config Write Safety Contract

`openclaw ansible setup` must provide safe config mutation:

- create timestamped backup before write: `openclaw.json.bak.<YYYYMMDDHHMMSS>`
- write via temp file + atomic rename
- support `--dry-run` for no-side-effect preview

No update step should leave partial JSON on crash/interruption.

## Defaults Canonicalization

Runtime code is the source of truth for defaults. Docs/schema/CLI help must match runtime.

Current canonical lock sweep defaults:

- `enabled=true`
- `everySeconds=60`
- `staleSeconds=300`

## Operator Runbook

1. Update plugin code (plugins update/reinstall).
2. Run `openclaw ansible setup` for skill + config alignment.
3. Restart gateway (or let setup restart).
4. Verify logs + status.
