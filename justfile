set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Sync the "Available skills" block from this repo AGENTS.md
# into AGENTS.md files for all workspaces in ~/.openclaw/openclaw.json.
sync-agents-skills:
	chmod +x scripts/sync-agents-skills.sh
	./scripts/sync-agents-skills.sh

# Preview changes without writing files.
sync-agents-skills-dry-run:
	chmod +x scripts/sync-agents-skills.sh
	./scripts/sync-agents-skills.sh --dry-run

