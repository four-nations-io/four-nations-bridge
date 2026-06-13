#!/usr/bin/env bash
#
# install-linux.sh — Phase F V0.8.b creator install (generic Linux + Docker).
#
# Usage (download-first-then-inspect recommended; see docs/install/security.md):
#   curl -fsSLO <release-url>/install-linux.sh
#   curl -fsSLO <release-url>/install-common.sh
#   less install-linux.sh          # inspect before running
#   bash install-linux.sh
#
# What it does: checks Docker + Compose v2, pulls + signature-verifies the
# bridge image, asks for your content folder + pairing details, generates the
# config (running the container as YOUR uid:gid so the bridge-owned folders
# need no chown gymnastics), starts the container, and hands you the
# setup-wizard URL.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=install-common.sh
. "$HERE/install-common.sh"

[ "$(uname -s)" = "Linux" ] || bridge_die "This installer is for Linux. Use install-mac.sh or install-synology.sh instead."

bridge_say "Four Nations Bridge — Linux install"
bridge_require_docker "https://docs.docker.com/engine/install/"

if [ "$(id -u)" -eq 0 ]; then
  bridge_note "Running as root. The container itself runs as a NON-root user either way,"
  bridge_note "but installing from your normal user account (in the 'docker' group) keeps"
  bridge_note "the bridge-owned folders out of root ownership."
fi

FN_DEVICE_PLATFORM="linux"

bridge_prompt_config "$HOME/four-nations-bridge"

# bridge_prompt_config auto-detected FN_RUN_AS from the content owner (the
# simplest correct uid — it can read the content; the :ro mount keeps content
# unwritable). Content stays read-only regardless of the uid.

bridge_pull_and_verify_image
bridge_generate_files "$FN_RUN_AS"
bridge_start
bridge_print_next_steps
