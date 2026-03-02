#!/usr/bin/env bash
set -euo pipefail

# Safe gateway deploy helper.
# - Fails fast on dirty tracked files (prevents dist/* merge conflicts on pull).
# - Pulls fast-forward only.
# - Builds plugin output to ensure dist/ is coherent on target.

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "✗ Not a git repository: $repo_root"
  exit 2
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ Refusing deploy pull: working tree is dirty."
  echo "  Resolve or stash local changes first."
  echo ""
  echo "Dirty files:"
  git status --short
  exit 1
fi

echo "→ Pulling latest (fast-forward only)"
git pull --ff-only

echo "→ Building plugin"
npm run build

echo "✓ Safe deploy pull complete"
