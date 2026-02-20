#!/usr/bin/env bash
set -euo pipefail

# Sync the "### Available skills" block from a canonical AGENTS.md
# into target AGENTS.md files.
#
# Default behavior:
# - source: ./AGENTS.md (repo root)
# - targets: every <workspace>/AGENTS.md from ~/.openclaw/openclaw.json
#
# Usage:
#   scripts/sync-agents-skills.sh
#   scripts/sync-agents-skills.sh --dry-run
#   scripts/sync-agents-skills.sh --source /path/to/AGENTS.md /path/to/target1/AGENTS.md /path/to/target2/AGENTS.md
#   scripts/sync-agents-skills.sh --config /path/to/openclaw.json

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_FILE="${ROOT_DIR}/AGENTS.md"
CONFIG_FILE="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
DRY_RUN=0

TARGETS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_FILE="$2"
      shift 2
      ;;
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      TARGETS+=("$1")
      shift
      ;;
  esac
done

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "error: source AGENTS.md not found: $SOURCE_FILE" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

BLOCK_TMP="$(mktemp)"
OUT_TMP="$(mktemp)"
cleanup() {
  rm -f "$BLOCK_TMP" "$OUT_TMP"
}
trap cleanup EXIT

awk '
  /^### Available skills$/ { in_block=1 }
  /^### How to use skills$/ { in_block=0 }
  in_block { print }
' "$SOURCE_FILE" > "$BLOCK_TMP"

if [[ ! -s "$BLOCK_TMP" ]]; then
  echo "error: could not extract \"### Available skills\" block from $SOURCE_FILE" >&2
  exit 1
fi

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "error: config not found and no explicit targets provided: $CONFIG_FILE" >&2
    exit 1
  fi
  while IFS= read -r ws; do
    [[ -n "$ws" ]] || continue
    TARGETS+=("${ws%/}/AGENTS.md")
  done < <(jq -r '.agents.list[]?.workspace // empty' "$CONFIG_FILE")
fi

# Deduplicate targets while preserving order.
DEDUPED=()
for t in "${TARGETS[@]}"; do
  seen=0
  for d in "${DEDUPED[@]:-}"; do
    if [[ "$d" == "$t" ]]; then
      seen=1
      break
    fi
  done
  if [[ "$seen" -eq 0 ]]; then
    DEDUPED+=("$t")
  fi
done
TARGETS=("${DEDUPED[@]}")

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  echo "error: no targets resolved" >&2
  exit 1
fi

echo "source: $SOURCE_FILE"
echo "targets: ${#TARGETS[@]}"

for target in "${TARGETS[@]}"; do
  dir="$(dirname "$target")"
  if [[ ! -d "$dir" ]]; then
    echo "skip (workspace missing): $target"
    continue
  fi

  if [[ ! -f "$target" ]]; then
    echo "skip (AGENTS.md missing): $target"
    continue
  fi

  awk -v block_file="$BLOCK_TMP" '
    function print_block(line) {
      while ((getline line < block_file) > 0) print line
      close(block_file)
    }
    BEGIN { in_block=0; replaced=0 }
    /^### Available skills$/ {
      print_block()
      in_block=1
      replaced=1
      next
    }
    /^### How to use skills$/ {
      in_block=0
      print
      next
    }
    !in_block { print }
  ' "$target" > "$OUT_TMP"

  if cmp -s "$target" "$OUT_TMP"; then
    echo "ok (no change): $target"
    continue
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "would-update: $target"
  else
    cp "$target" "${target}.bak.$(date +%Y%m%d%H%M%S)"
    cp "$OUT_TMP" "$target"
    echo "updated: $target"
  fi
done

