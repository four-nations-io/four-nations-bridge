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

# ─── Synology Photos reindex service ────────────────────────────────────────
#
# A folder the bridge creates is INVISIBLE in Synology Photos until Photos
# re-indexes: DSM's indexer is notified by DSM's own file services (smbd, File
# Station), never by filesystem events. The bridge writes a flag; this service
# holds the privilege and triggers Photos' reindex.
#
# ⛔ The container deliberately cannot do this itself — `synowebapi` is mode 700
# root:root and authenticates as SYSTEM_ADMIN by being root on the host, so
# mounting it in would hand a container admin access to every DSM Web API.
#
# systemd, not cron: DSM has NO `crontab` binary and rewrites /etc/crontab
# (measured 2026-10-27), while /etc/systemd/system is root-writable and systemd
# is PID 1. `Restart=always` also makes systemd the watchdog, so the watch loop
# self-heals without a second scheduled task babysitting it.
FN_REINDEX_SERVICE="fn-photos-reindex"
FN_REINDEX_UNIT="/etc/systemd/system/${FN_REINDEX_SERVICE}.service"

bridge_install_photos_reindex_service() {
  local state_dir="$1"
  local script_dest="$2"
  local interval="${FN_REINDEX_INTERVAL:-2}"

  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /etc/systemd/system ]; then
    # A warning, never a die: the bridge itself is fine without this. The
    # creator just re-indexes Photos by hand, which is the pre-existing state.
    bridge_note "⚠ systemd not available — skipping the Synology Photos reindex service."
    bridge_note "  New folders will not appear in Photos until you re-index by hand:"
    bridge_note "    sudo /usr/syno/bin/synowebapi --exec api=SYNO.FotoTeam.Index method=reindex version=1"
    return 0
  fi
  if [ ! -x /usr/syno/bin/synowebapi ]; then
    bridge_note "⚠ /usr/syno/bin/synowebapi not found — skipping the Photos reindex service."
    return 0
  fi

  # Written from the heredoc in install-common.sh — NOT copied from a third file
  # beside this one. Creators download exactly two files, so a sibling script
  # would simply be absent at install time.
  bridge_write_photos_reindex_script "$script_dest" || {
    bridge_note "⚠ could not write $script_dest — skipping the Photos reindex service."
    return 0
  }

  cat > "$FN_REINDEX_UNIT" <<UNIT
[Unit]
Description=Four Nations — reindex Synology Photos when the bridge creates content
After=network.target

[Service]
Type=simple
Environment=STATE_DIR=${state_dir}
ExecStart=${script_dest} --watch ${interval}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
  chmod 0644 "$FN_REINDEX_UNIT"

  systemctl daemon-reload >/dev/null 2>&1 || true
  # Re-runs are the documented update path, so restart rather than assume a
  # fresh enable — otherwise an updated script keeps running the old copy.
  systemctl enable "${FN_REINDEX_SERVICE}.service" >/dev/null 2>&1 || true
  systemctl restart "${FN_REINDEX_SERVICE}.service" >/dev/null 2>&1 || true

  # ⚠️ ASSERT, don't assume. Everything in this problem space returns success
  # while doing nothing; an unstarted service would look identical to a working
  # one if we simply printed a tick here.
  if systemctl is-active --quiet "${FN_REINDEX_SERVICE}.service"; then
    bridge_note "✓ Synology Photos reindex service active (watching ${state_dir}, every ${interval}s)"
  else
    bridge_note "⚠ ${FN_REINDEX_SERVICE}.service did not start. New folders will not appear"
    bridge_note "  in Photos automatically. Check: systemctl status ${FN_REINDEX_SERVICE}"
  fi
}

# Standalone mode: install ONLY the Photos reindex service, for a bridge that is
# already running (including hand-rolled installs that never used this script).
if [ "${1:-}" = "--photos-reindex-only" ]; then
  bridge_say "Four Nations Bridge — Synology Photos reindex service"
  _state_dir="${FN_STATE_DIR:-}"
  if [ -z "$_state_dir" ]; then
    _default_state="${2:-/volume1/docker/four-nations-bridge/managed/_state}"
    read -r -p "  Bridge state folder [${_default_state}]: " _state_dir
    _state_dir="${_state_dir:-$_default_state}"
  fi
  _state_dir="${_state_dir%/}"
  [ -d "$_state_dir" ] || bridge_note "⚠ $_state_dir does not exist yet — the bridge creates it; the service will wait."
  bridge_install_photos_reindex_service "$_state_dir" "/usr/local/bin/${FN_REINDEX_SERVICE}.sh"
  exit 0
fi

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

# Synology-only: make bridge-created folders visible in Synology Photos. Runs on
# every install AND every re-run, because "re-run the install script" is the
# documented update path — so an existing bridge picks this up by updating,
# with no extra step. Idempotent: rewrites the unit and restarts.
bridge_install_photos_reindex_service \
  "${FN_INSTALL_DIR}/managed/_state" \
  "/usr/local/bin/${FN_REINDEX_SERVICE}.sh"

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
