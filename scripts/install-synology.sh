#!/usr/bin/env bash
#
# install-synology.sh — Phase F V0.8.b creator install (Synology DSM 7.x).
#
# Run over SSH on the NAS (Control Panel → Terminal & SNMP → Enable SSH),
# from an administrator account:
#   sudo bash install-synology.sh
#
# Prerequisite: Container Manager (DSM 7.2+) or the Docker package (DSM 7.0/7.1)
# installed from Package Center — that's what provides the docker CLI.
#
# What it does beyond the generic Linux flow:
#   - DSM + Container Manager checks
#   - guides creation of a dedicated low-privilege bridge user (read on the
#     content share, full control ONLY on the bridge's own folders) and runs
#     the container as that uid — the Synology-ACL layer is what makes the
#     "bridge can't delete content" guarantee kernel-enforced (arch-note 14 §3)
#   - NAS-friendly default install path under /volume1/docker

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=install-common.sh
. "$HERE/install-common.sh"

[ -f /etc/synoinfo.conf ] || bridge_die "This doesn't look like a Synology NAS. Use install-linux.sh instead."
[ "$(id -u)" -eq 0 ] || bridge_die "Run with sudo on DSM (docker access requires it): sudo bash install-synology.sh"

bridge_say "Four Nations Bridge — Synology install"

DSM_VERSION="$(grep -oE 'majorversion="[0-9]+"' /etc/VERSION 2>/dev/null | grep -oE '[0-9]+' || echo 0)"
if [ "$DSM_VERSION" -lt 7 ]; then
  bridge_die "DSM 7.0 or newer is required (found major version: ${DSM_VERSION:-unknown})."
fi
bridge_require_docker "Package Center → install 'Container Manager' (DSM 7.2+) or 'Docker' (DSM 7.0/7.1)"

FN_DEVICE_PLATFORM="linux"

# A NAS is usually headless — default the no-browser options ON (the creator can
# still decline). Auto-pair (self-pair on boot) and the token-gated LAN page both
# remove the need to reach the NAS's localhost.
FN_AUTOPAIR_HINT="y"
FN_LAN_HINT="y"
# bridge_prompt_config auto-detects the bridge's run-as uid from the content
# owner (simplest correct choice; the :ro mount keeps content unwritable) and
# offers the dedicated-user hardening path (harden-account-prompt.txt). It also
# chowns the bridge-owned working folders to that uid — which on DSM means
# running this script with sudo (you already are).
bridge_prompt_config "/volume1/docker/four-nations-bridge"

bridge_pull_and_verify_image
bridge_generate_files "$FN_RUN_AS"
bridge_start

# Auto-pair or LAN: the generic next-steps handler prints the right path (logs to
# watch, or the tokenized LAN link). If the creator declined both, fall back to
# the SSH-tunnel route to reach the NAS-localhost wizard.
if [ "${FN_AUTO_PAIR:-false}" = "true" ] || [ "${FN_LAN:-false}" = "true" ]; then
  bridge_print_next_steps
else
  bridge_say "✓ Bridge is running."
  bridge_note "The setup wizard is bound to the NAS's localhost. From your computer,"
  bridge_note "open an SSH tunnel, then browse to the wizard:"
  bridge_note ""
  bridge_note "    ssh -L ${FN_BRIDGE_UI_PORT}:127.0.0.1:${FN_BRIDGE_UI_PORT} <admin>@<nas-ip>"
  bridge_note "    → then open http://localhost:${FN_BRIDGE_UI_PORT} in your browser"
  bridge_note ""
  bridge_note "The wizard pairs this bridge with your account and confirms your content"
  bridge_note "folder. Once it shows “Your account is paired with this bridge”, you can"
  bridge_note "close the window and the tunnel — the bridge keeps running."
fi
