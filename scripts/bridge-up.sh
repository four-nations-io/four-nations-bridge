#!/usr/bin/env bash
#
# bridge-up.sh — Phase F V0.6.a.
#
# Start / recreate the bridge container WITH its narrow bind mounts. Use this
# instead of a bare `docker compose up -d`: a bare up -d recreates the container
# from the base compose file ONLY and silently drops the per-root binds added by
# bridge-add-root.sh (the content root stops being mounted → source roots go
# `needs_mount` → create-project breaks).
#
# Persistence notes:
#   - `docker compose stop` / `start` keep the bind (they don't recreate) — safe.
#   - Host reboots keep the bind: `restart: unless-stopped` restarts the SAME
#     container with its existing config.
#   - Only a recreate (`up -d` / `up -d --build`) can drop the bind — so always
#     recreate via THIS script (or bridge-add-root.sh), never a bare up -d.
#
# Usage:
#   ./scripts/bridge-up.sh            # prod stack, with binds
#   ./scripts/bridge-up.sh --dev      # dev stack, with binds
#   ./scripts/bridge-up.sh --dev --build   # also rebuild the image

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DEV=0
BUILD=""
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    --build) BUILD="--build" ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [ "$DEV" -eq 1 ]; then
  BASE="docker-compose.dev.yml"
  BINDS="docker-compose.binds.dev.yml"
else
  BASE="docker-compose.yml"
  BINDS="docker-compose.binds.yml"
fi

FILES=(-f "$BASE")
if [ -f "$BINDS" ]; then
  FILES+=(-f "$BINDS")
  echo "Including narrow bind mounts from $BINDS"
else
  echo "NOTE: no $BINDS yet — run ./scripts/bridge-add-root.sh \"/your/content/path\" --writable${DEV:+ --dev} first."
fi

docker compose "${FILES[@]}" up -d $BUILD
echo "Bridge is up with its content-root binds. Reboots persist via restart: unless-stopped."
