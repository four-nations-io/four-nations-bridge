#!/usr/bin/env bash
#
# install-mac.sh — Phase F V0.8.b creator install (macOS + Docker Desktop).
#
# Usage (download-first-then-inspect recommended; see docs/install/security.md):
#   curl -fsSLO <release-url>/install-mac.sh
#   curl -fsSLO <release-url>/install-common.sh
#   less install-mac.sh            # inspect before running
#   bash install-mac.sh
#
# What it does: checks Docker Desktop, pulls + signature-verifies the bridge
# image, asks for your content folder + pairing details, generates the config,
# starts the container, and hands you the setup-wizard URL.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=install-common.sh
. "$HERE/install-common.sh"

[ "$(uname -s)" = "Darwin" ] || bridge_die "This installer is for macOS. Use install-linux.sh or install-synology.sh instead."

bridge_say "Four Nations Bridge — macOS install"
bridge_require_docker "https://docs.docker.com/desktop/setup/install/mac-install/"

# Docker Desktop note: the content folder must be inside Docker Desktop's
# file-sharing scope (Settings → Resources → File sharing). /Users is shared
# by default; SMB-mounted NAS shares under /Volumes usually need adding.
FN_DEVICE_PLATFORM="darwin"

bridge_prompt_config "$HOME/four-nations-bridge"

case "$FN_CONTENT_ROOT" in
  /Users/*) : ;;
  *)
    bridge_note ""
    bridge_note "NOTE: '$FN_CONTENT_ROOT' is outside /Users — make sure it's listed in"
    bridge_note "Docker Desktop → Settings → Resources → File sharing, or the container"
    bridge_note "won't see it."
    ;;
esac

bridge_pull_and_verify_image
# Docker Desktop's VM handles file ownership translation — bridge_prompt_config
# leaves FN_RUN_AS empty on macOS, so the container runs as the image default.
bridge_generate_files "$FN_RUN_AS"
bridge_start
bridge_print_next_steps
