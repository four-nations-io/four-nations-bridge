#!/usr/bin/env bash
#
# install-common.sh — Phase F V0.8.b shared install logic.
#
# Sourced by install-mac.sh / install-linux.sh / install-synology.sh. Owns
# everything platform-independent: image pull, cosign signature verification
# (HARD STOP on failure), .env + docker-compose.yml generation, container
# start, and the pairing-URL handoff. Per-platform wrappers only do their
# platform checks + defaults, then call these functions in order.
#
# Supply-chain model (see docs/install/security.md):
#   pull image → resolve its immutable digest → cosign-verify THAT digest
#   against the publisher public key embedded below → generate compose pinned
#   to the digest → start. The tag is only used to discover the digest; what
#   runs is exactly what was verified (no verify-then-repush TOCTOU).
#
# curl-pipe-sh note: these scripts are safe to download-first-then-inspect,
# and the docs recommend exactly that. Nothing here requires piping.

set -euo pipefail

# ─── Tunables (env-overridable) ─────────────────────────────────────────────

# Published bridge image. The version tag is what releases advertise;
# override FN_BRIDGE_IMAGE to pin a specific version.
FN_BRIDGE_IMAGE="${FN_BRIDGE_IMAGE:-ghcr.io/REPLACE-GHCR-OWNER/four-nations-bridge:latest}"

# Setup wizard port on the creator's machine (always bound to 127.0.0.1).
FN_BRIDGE_UI_PORT="${FN_BRIDGE_UI_PORT:-8124}"

# DANGEROUS — dev/test only, before the first signed publish exists. Skips
# signature verification. Never use this for a real install.
FN_BRIDGE_ALLOW_UNSIGNED="${FN_BRIDGE_ALLOW_UNSIGNED:-0}"

# Publisher cosign public key. Embedded (not fetched) so the script's own
# integrity covers the key — replace the placeholder when the release key is
# generated (cosign generate-key-pair; private half lives ONLY in CI secrets).
FN_BRIDGE_COSIGN_PUBKEY='-----BEGIN PUBLIC KEY-----
REPLACE-WITH-PUBLISHER-COSIGN-PUBLIC-KEY
-----END PUBLIC KEY-----'

# ─── Helpers ────────────────────────────────────────────────────────────────

bridge_say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
bridge_note() { printf '  %s\n' "$*"; }
bridge_die()  { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

bridge_require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    bridge_die "Docker is not installed. Install it first: ${1:-https://docs.docker.com/engine/install/}"
  fi
  if ! docker info >/dev/null 2>&1; then
    bridge_die "Docker is installed but not running (or this user can't reach it). Start Docker and re-run."
  fi
  if ! docker compose version >/dev/null 2>&1; then
    bridge_die "Docker Compose v2 is required ('docker compose' subcommand not found)."
  fi
}

# Prompt for everything the install needs. Sets:
#   FN_CONTENT_ROOT   — absolute host path of the creator's content folder (read-only)
#   FN_RUN_AS         — uid:gid the container runs as (auto-detected content owner;
#                       '' on macOS = image default, Docker Desktop translates)
#   FN_INSTALL_DIR    — where .env / compose / managed / cache / state live
#   FN_SAAS_WSS_URL   — the bridge gateway WSS endpoint
#   FN_PAIRING_CODE   — pairing code from the account (optional here; the wizard
#                       accepts a manual paste too)
#   FN_ENC_KEY        — 64-hex shared content encryption key from the install
#                       instructions (V0 stub key; a future release derives this
#                       at pair time and drops the prompt)
#   FN_DEVICE_LABEL   — bridge display name (defaults to this machine's hostname)
#   FN_AUTO_PAIR      — "true"/"false": pair headlessly on boot (no browser)
#   FN_LAN            — "true"/"false": expose the setup UI on the LAN (token-gated)
#   FN_SETUP_TOKEN    — generated LAN access token (empty unless FN_LAN=true)
#   FN_LAN_HOST       — LAN IP/hostname used to build the setup link (FN_LAN=true)
#   FN_BRIDGE_UI_BIND — host bind address for the UI port (127.0.0.1 or 0.0.0.0)
#
# Platform wrappers may pre-seed FN_AUTOPAIR_HINT / FN_LAN_HINT to "y" to make
# the headless options default-on (Synology does; desktop installers leave the
# defaults "n").
bridge_prompt_config() {
  local default_install_dir="$1"

  bridge_say "Where is your content?"
  bridge_note "The bridge indexes this folder READ-ONLY. Nothing is uploaded, moved, or changed."
  read -r -p "  Content folder (absolute path): " FN_CONTENT_ROOT
  FN_CONTENT_ROOT="${FN_CONTENT_ROOT%/}"
  [ -d "$FN_CONTENT_ROOT" ] || bridge_die "Not a directory: $FN_CONTENT_ROOT"
  case "$FN_CONTENT_ROOT" in
    /*) : ;;
    *) bridge_die "Path must be absolute (start with /): $FN_CONTENT_ROOT" ;;
  esac

  # ── Which user the bridge runs as ─────────────────────────────────────────
  # The installer gets the bridge RUNNING as the simplest correct uid — the
  # content owner (it can read content; the :ro mount keeps content unwritable).
  # The richer "harden with a dedicated low-privilege user" flow lives in the
  # browser setup page (choose-your-adventure: auto-create / guided / keep).
  # On macOS, Docker Desktop translates ownership, so we run as the image default.
  if [ "${FN_DEVICE_PLATFORM:-linux}" = "darwin" ]; then
    FN_RUN_AS=""
  else
    local _owner
    _owner="$(stat -c '%u:%g' "$FN_CONTENT_ROOT" 2>/dev/null \
      || stat -f '%u:%g' "$FN_CONTENT_ROOT" 2>/dev/null || echo '')"
    local _default_run_as="${_owner:-1031:100}"
    bridge_say "Which user should the bridge run as?"
    bridge_note "Detected owner of your content: ${_owner:-unknown}. Press Enter to run as"
    bridge_note "that user — it can read your content, and the read-only mount keeps your"
    bridge_note "content unwritable regardless. You can harden this to a dedicated"
    bridge_note "low-privilege user afterward in the setup page (recommended for sensitive"
    bridge_note "content)."
    read -r -p "  Run as uid:gid [${_default_run_as}]: " FN_RUN_AS
    FN_RUN_AS="${FN_RUN_AS:-$_default_run_as}"
    case "$FN_RUN_AS" in
      *:*) : ;;
      *) bridge_die "Expected uid:gid (e.g. 1027:100), got: $FN_RUN_AS" ;;
    esac
  fi

  bridge_say "Where should the bridge keep its own files?"
  bridge_note "Holds the generated config plus the bridge-owned managed/cache/state folders."
  read -r -p "  Install folder [${default_install_dir}]: " FN_INSTALL_DIR
  FN_INSTALL_DIR="${FN_INSTALL_DIR:-$default_install_dir}"
  FN_INSTALL_DIR="${FN_INSTALL_DIR%/}"

  bridge_say "Service connection"
  read -r -p "  Bridge service URL (wss://…, from your install instructions) [${FN_BRIDGE_SAAS_URL:-}]: " _saas
  FN_SAAS_WSS_URL="${_saas:-${FN_BRIDGE_SAAS_URL:-}}"
  [ -n "$FN_SAAS_WSS_URL" ] || bridge_die "A service URL is required."
  case "$FN_SAAS_WSS_URL" in
    ws://*|wss://*) : ;;
    *) bridge_die "Service URL must start with ws:// or wss://" ;;
  esac

  bridge_note "Your web app address (https://…, from your install instructions). Used for"
  bridge_note "the 'browse your content' link after pairing. Optional — press Enter to skip."
  read -r -p "  Web app URL [${FN_BRIDGE_APP_URL:-}]: " _app
  FN_APP_URL="${_app:-${FN_BRIDGE_APP_URL:-}}"
  case "$FN_APP_URL" in
    ''|http://*|https://*) : ;;
    *) bridge_die "Web app URL must start with http:// or https:// (or be left blank)." ;;
  esac

  bridge_say "Account pairing"
  bridge_note "The pairing code connects this bridge to YOUR ACCOUNT (any device you"
  bridge_note "sign in on can then browse your content). Paste it now to pre-fill the"
  bridge_note "setup wizard, or leave blank and paste it in the wizard instead."
  read -r -s -p "  Pairing code (hidden; optional): " FN_PAIRING_CODE; echo

  bridge_note ""
  bridge_note "Your install instructions also include a content encryption key (64 hex"
  bridge_note "characters). Thumbnails + previews are encrypted with it before leaving"
  bridge_note "this machine."
  read -r -s -p "  Content encryption key (hidden): " FN_ENC_KEY; echo
  case "$FN_ENC_KEY" in
    *[!0-9a-fA-F]*) bridge_die "Encryption key must be hex characters only." ;;
  esac
  [ "${#FN_ENC_KEY}" -eq 64 ] || bridge_die "Encryption key must be exactly 64 hex characters."

  # ── Bridge name (defaults to this machine's hostname) ─────────────────────
  # Used as the display name in the account's bridge list, and — for headless
  # auto-pair — as the bridge's identity name.
  local _default_name
  _default_name="$(hostname 2>/dev/null || uname -n 2>/dev/null || echo bridge)"
  # Keep only label-legal chars, ensure an alphanumeric start, cap at 64.
  _default_name="$(printf '%s' "$_default_name" \
    | tr -c 'A-Za-z0-9 _.-' '-' \
    | sed -E 's/^[^A-Za-z0-9]+//' \
    | cut -c1-64)"
  [ -n "$_default_name" ] || _default_name="bridge"
  bridge_say "Bridge name"
  bridge_note "Shown in your account's bridge list. Press Enter to use this machine's name."
  read -r -p "  Bridge name [${_default_name}]: " FN_DEVICE_LABEL
  FN_DEVICE_LABEL="${FN_DEVICE_LABEL:-$_default_name}"

  # ── Headless auto-pair (optional) ─────────────────────────────────────────
  # For a machine with no reachable browser (a NAS), the bridge can verify the
  # pairing code above and pair itself on boot — no wizard.
  bridge_say "Headless pairing (optional)"
  bridge_note "If this machine has no desktop/browser (e.g. a NAS), the bridge can pair"
  bridge_note "itself on boot using the pairing code above — no wizard needed."
  local _ap_def="${FN_AUTOPAIR_HINT:-n}"
  read -r -p "  Pair automatically on boot? [y/N] (default ${_ap_def}): " _ap
  _ap="${_ap:-$_ap_def}"
  case "$_ap" in
    y|Y|yes|YES) FN_AUTO_PAIR="true" ;;
    *) FN_AUTO_PAIR="false" ;;
  esac
  if [ "$FN_AUTO_PAIR" = "true" ] && [ -z "$FN_PAIRING_CODE" ]; then
    bridge_die "Auto-pair needs the pairing code. Re-run and paste it at the 'Pairing code' prompt."
  fi

  # ── LAN setup page (optional) — only relevant when NOT auto-pairing ───────
  # Exposes the setup wizard on the LAN, protected by a generated one-time token,
  # so the creator can finish setup from a laptop instead of this machine.
  FN_SETUP_TOKEN=""
  FN_LAN_HOST=""
  if [ "$FN_AUTO_PAIR" = "true" ]; then
    FN_LAN="false"
    FN_BRIDGE_UI_BIND="127.0.0.1"
  else
    bridge_say "Finish setup from another computer (optional)"
    bridge_note "Exposes the setup page on your LAN, protected by a one-time token, so you"
    bridge_note "can open it from your laptop instead of this machine. Leave off if you can"
    bridge_note "open a browser here."
    local _lan_def="${FN_LAN_HINT:-n}"
    read -r -p "  Enable LAN setup page? [y/N] (default ${_lan_def}): " _lan
    _lan="${_lan:-$_lan_def}"
    case "$_lan" in
      y|Y|yes|YES) FN_LAN="true" ;;
      *) FN_LAN="false" ;;
    esac
    if [ "$FN_LAN" = "true" ]; then
      FN_SETUP_TOKEN="$(openssl rand -hex 24 2>/dev/null \
        || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      [ -n "$FN_SETUP_TOKEN" ] || bridge_die "Couldn't generate a setup token (need openssl or /dev/urandom)."
      FN_BRIDGE_UI_BIND="0.0.0.0"
      bridge_say "LAN address"
      bridge_note "How will you reach this machine from your laptop? Enter its LAN IP or"
      bridge_note "hostname (e.g. 192.168.1.50 or nas.local) — used to build your setup link."
      read -r -p "  This machine's LAN address: " FN_LAN_HOST
      FN_LAN_HOST="${FN_LAN_HOST%/}"
    else
      FN_BRIDGE_UI_BIND="127.0.0.1"
    fi
  fi
}

# Pull the image, resolve its digest, verify the signature against the digest.
# Sets FN_IMAGE_PINNED to the digest-pinned ref the compose file will run.
bridge_pull_and_verify_image() {
  bridge_say "Pulling bridge image: ${FN_BRIDGE_IMAGE}"
  docker pull "$FN_BRIDGE_IMAGE"

  local digest_ref
  digest_ref="$(docker image inspect --format '{{index .RepoDigests 0}}' "$FN_BRIDGE_IMAGE" 2>/dev/null || true)"
  [ -n "$digest_ref" ] || bridge_die "Could not resolve the image digest after pull."
  FN_IMAGE_PINNED="$digest_ref"
  bridge_note "Resolved digest: ${FN_IMAGE_PINNED}"

  if [ "$FN_BRIDGE_ALLOW_UNSIGNED" = "1" ]; then
    bridge_say "⚠️  SIGNATURE VERIFICATION SKIPPED (FN_BRIDGE_ALLOW_UNSIGNED=1)"
    bridge_note "This is a dev/test escape hatch. Do NOT use it for a real install."
    return 0
  fi

  if printf '%s' "$FN_BRIDGE_COSIGN_PUBKEY" | grep -q 'REPLACE-WITH-PUBLISHER'; then
    bridge_die "This copy of the install script has no publisher key embedded — it can't verify the image. Download the script from the official release (or, for dev only, re-run with FN_BRIDGE_ALLOW_UNSIGNED=1)."
  fi
  if ! command -v cosign >/dev/null 2>&1; then
    bridge_die "cosign is required to verify the image signature. Install: https://docs.sigstore.dev/cosign/system_config/installation/"
  fi

  bridge_say "Verifying image signature (cosign)…"
  local keyfile
  keyfile="$(mktemp)"
  printf '%s\n' "$FN_BRIDGE_COSIGN_PUBKEY" > "$keyfile"
  # HARD STOP on any verification failure — never warn-and-continue.
  if ! cosign verify --key "$keyfile" "$FN_IMAGE_PINNED" >/dev/null; then
    rm -f "$keyfile"
    bridge_die "IMAGE SIGNATURE VERIFICATION FAILED for ${FN_IMAGE_PINNED}. Refusing to install. This can mean a compromised registry or a tampered image — do not proceed; report it."
  fi
  rm -f "$keyfile"
  bridge_note "Signature OK."
}

# Generate <install>/.env + <install>/docker-compose.yml + the bridge-owned
# managed/cache/state dirs. $1 = uid:gid the container runs as ('' = image
# default 1031:100).
bridge_generate_files() {
  local run_as="${1:-}"
  local user_line=""
  if [ -n "$run_as" ]; then
    user_line="    user: \"${run_as}\""
  fi

  # Paired-state lives at managed/_state (bridge-owned, writable) — no separate dir.
  mkdir -p "$FN_INSTALL_DIR" "$FN_INSTALL_DIR/managed" "$FN_INSTALL_DIR/cache"

  # The bridge runs as $run_as and must read+write its working folders. chown
  # them to that uid (needs root if it differs from the installing user). If it
  # fails, point the user at fix-perms.sh, which runs with sudo.
  if [ -n "$run_as" ]; then
    if ! chown -R "$run_as" "$FN_INSTALL_DIR/managed" "$FN_INSTALL_DIR/cache" 2>/dev/null; then
      bridge_note "Note: couldn't set ownership of the working folders to ${run_as} (needs root)."
      bridge_note "      Run ${FN_INSTALL_DIR}/fix-perms.sh with sudo to finish, then re-check."
    fi
  fi

  umask 077
  cat > "$FN_INSTALL_DIR/.env" <<ENV
# four-nations-bridge — generated by the install script $(date -u +%Y-%m-%dT%H:%M:%SZ).
# This file holds secrets — keep it private (mode 600).

# Bridge service WSS endpoint.
CONTENT_BRIDGE_SAAS_URL=${FN_SAAS_WSS_URL}

# Web app base URL — for the "browse your content" link after pairing (optional).
CONTENT_BRIDGE_APP_URL=${FN_APP_URL:-}

# Pairing-code prefill for the setup wizard (optional). The wizard uses it
# server-side to verify with the service and saves the pairing in
# ./state/paired.json — the wizard NEVER sends this value to the browser. It's
# only a convenience prefill and is redundant once paired.json exists, so you
# may blank it (and re-run 'docker compose up -d') after pairing completes.
CONTENT_BRIDGE_PAIRING_CODE=${FN_PAIRING_CODE}

# Content encryption key (64 hex chars) — thumbnails + previews are encrypted
# with this before leaving this machine.
CONTENT_BRIDGE_ENCRYPTION_KEY=${FN_ENC_KEY}

# Informational platform tag shown in your account's bridge list.
CONTENT_BRIDGE_DEVICE_PLATFORM=${FN_DEVICE_PLATFORM:-linux}

# Your content folder (read-only inside the container).
CONTENT_BRIDGE_HOST_CONTENT_PATH=${FN_CONTENT_ROOT}

# Fresh installs keep ALL generated files (thumbnails, preview proxies) in the
# bridge-owned cache folder — never inside your content tree.
CONTENT_BRIDGE_THUMB_OUTPUT_MODE=cache_dir

# Bridge-owned managed folder (template + optional drop-folder).
CONTENT_BRIDGE_MANAGED_HOST_PATH=${FN_INSTALL_DIR}/managed

# Setup wizard / status page port.
CONTENT_BRIDGE_SETUP_UI_PORT=${FN_BRIDGE_UI_PORT}

# Bridge display name (and headless-pairing identity name).
CONTENT_BRIDGE_DEVICE_LABEL=${FN_DEVICE_LABEL}

# Headless auto-pair on boot (no browser). When true the bridge verifies the
# pairing code above with the service and pairs itself at startup.
CONTENT_BRIDGE_AUTO_PAIR=${FN_AUTO_PAIR:-false}

# LAN setup page (token-gated). When true the setup UI accepts LAN requests that
# carry the token below, and the port is bound to 0.0.0.0 (see the compose
# ports: section). Empty token + LAN=true makes the UI fail closed (503).
CONTENT_BRIDGE_SETUP_UI_LAN=${FN_LAN:-false}
CONTENT_BRIDGE_SETUP_TOKEN=${FN_SETUP_TOKEN:-}
CONTENT_BRIDGE_SETUP_UI_HOST=${FN_LAN_HOST:-}
# Host bind address for the setup-UI port. 127.0.0.1 = localhost only (default);
# 0.0.0.0 = LAN (only set together with CONTENT_BRIDGE_SETUP_UI_LAN + a token).
CONTENT_BRIDGE_SETUP_UI_BIND=${FN_BRIDGE_UI_BIND:-127.0.0.1}
ENV
  umask 022

  cat > "$FN_INSTALL_DIR/docker-compose.yml" <<COMPOSE
# four-nations-bridge — generated by the install script. Regenerate by
# re-running the installer; hand-edits survive until then.
#
# Mount model (docs/install/security.md):
#   content  → READ-ONLY  (the bridge can never modify or delete your content)
#   cache    → read-write (bridge-owned thumbnails/previews, evictable)
#   managed  → read-write (bridge-owned folder; project creation is add-only)
#   state    → read-write (pairing state; delete state/paired.json to re-pair)

services:
  four-nations-bridge:
    image: ${FN_IMAGE_PINNED}
    container_name: four-nations-bridge
${user_line}

    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true

    env_file: .env
    environment:
      NODE_ENV: production

    volumes:
      # Content — READ-ONLY at its MIRRORED container path. The bridge indexes +
      # serves from here and auto-registers it as the source root on connect
      # (Phase F cutover, planning doc 65; the legacy /sources/local mount is gone).
      - "${FN_CONTENT_ROOT}:/sources/host${FN_CONTENT_ROOT}:ro"
      # Bridge-owned read-write surfaces — never your content tree. Paired-state
      # lives at managed/_state (the bridge creates it; no separate mount).
      - "${FN_INSTALL_DIR}/managed:/data/managed:rw"
      - "${FN_INSTALL_DIR}/cache:/data/cache:rw"
      - type: tmpfs
        target: /tmp
        tmpfs:
          size: 256M

    ports:
      # Setup wizard / status page. Bind address is ${FN_BRIDGE_UI_BIND:-127.0.0.1}
      # — 127.0.0.1 keeps it localhost-only; 0.0.0.0 (LAN mode) is paired with a
      # required token + fail-closed enforcement inside the bridge.
      - "${FN_BRIDGE_UI_BIND:-127.0.0.1}:${FN_BRIDGE_UI_PORT}:${FN_BRIDGE_UI_PORT}"

    restart: unless-stopped

    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "require('http').get('http://127.0.0.1:' + (process.env.CONTENT_BRIDGE_SETUP_UI_PORT || ${FN_BRIDGE_UI_PORT}) + '/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 3
COMPOSE

  bridge_note "Wrote ${FN_INSTALL_DIR}/.env (mode 600) and docker-compose.yml"

  bridge_emit_perms_helpers "$run_as"
}

# Emit two host-side permission helpers into the install dir (Option A + B):
#   fix-perms.sh            — a reviewable script that grants the bridge's uid
#                             READ on content + READ-WRITE on the working folders
#   setup-account-prompt.txt — a copy-paste prompt for an AI assistant, for any
#                             NAS/OS the script can't handle natively
# $1 = uid:gid the container runs as ('' = image default 1031:100).
bridge_emit_perms_helpers() {
  local run_as="${1:-}"
  local uid="${run_as%%:*}" gid="${run_as##*:}"
  [ -n "$uid" ] && [ "$uid" != "$run_as" ] || uid="1031"
  [ -n "$gid" ] && [ "$gid" != "$run_as" ] || gid="100"

  # fix-perms.sh — header (values expanded now) + body (literal).
  {
    cat <<HEADER
#!/usr/bin/env bash
# fix-perms.sh — generated by the four-nations-bridge installer.
#
# Grants the bridge's user the access it needs and NOTHING else:
#   - READ on your content folder
#   - READ + WRITE on the bridge's own working folders (managed + cache)
# Review this before running. Run with sudo. It never weakens other permissions.
set -euo pipefail

BRIDGE_UID="${uid}"
BRIDGE_GID="${gid}"
CONTENT="${FN_CONTENT_ROOT}"
MANAGED="${FN_INSTALL_DIR}/managed"
CACHE="${FN_INSTALL_DIR}/cache"
HEADER
    cat <<'BODY'

echo "Bridge user: ${BRIDGE_UID}:${BRIDGE_GID}"

# 1) The bridge OWNS its working folders (so it can read + write them).
echo "→ Setting ownership of the working folders to ${BRIDGE_UID}:${BRIDGE_GID}…"
chown -R "${BRIDGE_UID}:${BRIDGE_GID}" "$MANAGED" "$CACHE"

# 2) The bridge needs READ-ONLY on your content (never write). Prefer an ACL
#    grant — it adds read for just this uid and leaves your existing perms intact.
echo "→ Granting read on your content folder to uid ${BRIDGE_UID}…"
if command -v setfacl >/dev/null 2>&1; then
  setfacl -R -m "u:${BRIDGE_UID}:rX" "$CONTENT"
  setfacl -R -d -m "u:${BRIDGE_UID}:rX" "$CONTENT"   # default ACL for new files
  echo "  granted via setfacl (least privilege, read-only) ✓"
else
  echo "  setfacl isn't available here — grant uid ${BRIDGE_UID} READ on:"
  echo "    $CONTENT"
  echo "  using your NAS/OS tools, or paste setup-account-prompt.txt into an AI assistant."
fi

# 3) Verify as the bridge's uid.
echo "→ Verifying…"
if sudo -u "#${BRIDGE_UID}" test -r "$CONTENT"; then echo "  content readable ✓"; else echo "  content NOT readable ✗"; fi
if sudo -u "#${BRIDGE_UID}" test -w "$MANAGED"; then echo "  working folder writable ✓"; else echo "  working folder NOT writable ✗"; fi

echo "Done — re-check in the setup wizard."
BODY
  } > "$FN_INSTALL_DIR/fix-perms.sh"
  chmod +x "$FN_INSTALL_DIR/fix-perms.sh"

  # setup-account-prompt.txt — mirrors the wizard's AI prompt (Option A).
  cat > "$FN_INSTALL_DIR/setup-account-prompt.txt" <<PROMPT
I'm setting up a self-hosted "content bridge" app that runs in Docker as a
non-root user and needs file permissions on two folders. Give me the exact,
safe, least-privilege commands for MY system, explain each step, and do NOT
use a recursive "chmod 777" or anything that weakens security.

My system: ${FN_DEVICE_PLATFORM:-Linux / a NAS (tell me the exact brand + version)}.
The bridge container runs as uid:gid = ${uid}:${gid}.
1) CONTENT folder — the app must only READ it, never write:
   ${FN_CONTENT_ROOT}
2) WORKING folder — the app must READ and WRITE it (thumbnails, cache, state):
   ${FN_INSTALL_DIR}/managed

Please walk me through, step by step:
- identifying or creating the user/uid the bridge should run as (if needed),
- granting uid ${uid} READ-only on the content folder and READ+WRITE on the
  working folder, using my OS's native tools (prefer ACLs over broad chmod),
- how to verify it worked,
- anything specific to my NAS/OS I should watch out for.
PROMPT

  # harden-account-prompt.txt — optional defense-in-depth: move from "run as the
  # content owner" to a dedicated low-privilege user with read-only content.
  cat > "$FN_INSTALL_DIR/harden-account-prompt.txt" <<HARDEN
I run a self-hosted "content bridge" Docker app. It currently runs as uid:gid
${FN_RUN_AS:-the image default (1031:100)} (the owner of my content). For extra
defense-in-depth I want to run it as a DEDICATED low-privilege user instead, with
READ-ONLY access to my content. (My content is already mounted read-only, so this
is a second layer, not a fix.)

My system: ${FN_DEVICE_PLATFORM:-Linux / a NAS (tell me the exact brand + version)}.
Content folder (must stay read-only): ${FN_CONTENT_ROOT}
Bridge working folder (needs read+write): ${FN_INSTALL_DIR}/managed

Please walk me through, step by step:
- creating a dedicated low-privilege user (no login shell, minimal groups),
- granting that user READ-ONLY on the content folder (prefer an ACL) and
  READ+WRITE on the working folder,
- finding the new user's uid:gid,
- reconfiguring the bridge to use it: set CONTENT_BRIDGE_RUN_AS_USER=<new uid:gid>
  in ${FN_INSTALL_DIR}/.env, chown ${FN_INSTALL_DIR}/managed and
  ${FN_INSTALL_DIR}/cache to the new uid, then restart with:
    cd ${FN_INSTALL_DIR} && docker compose up -d
- and how to verify it all worked (the bridge logs a clear permission error at
  startup if the new uid can't read content or write the working folder).
HARDEN

  bridge_note "Wrote ${FN_INSTALL_DIR}/fix-perms.sh, setup-account-prompt.txt, harden-account-prompt.txt"
}

bridge_start() {
  bridge_say "Starting the bridge…"
  (cd "$FN_INSTALL_DIR" && docker compose up -d)
}

bridge_print_next_steps() {
  # Headless auto-pair: nothing for the creator to open — the bridge pairs itself.
  if [ "${FN_AUTO_PAIR:-false}" = "true" ]; then
    bridge_say "✓ Bridge is running and pairing itself."
    bridge_note "No browser needed. Watch it connect:"
    bridge_note ""
    bridge_note "    (cd ${FN_INSTALL_DIR} && docker compose logs -f)"
    bridge_note ""
    bridge_note "Look for: 'auto-paired headlessly as \"${FN_DEVICE_LABEL}\"' then a HELLO ack."
    bridge_note "Your content then appears in your account."
    return
  fi
  # LAN setup page: hand out the tokenized link to open from any LAN computer.
  if [ "${FN_LAN:-false}" = "true" ]; then
    bridge_say "✓ Bridge is running. Finish setup from any computer on your network:"
    bridge_note ""
    bridge_note "    http://${FN_LAN_HOST:-<this-machine-ip>}:${FN_BRIDGE_UI_PORT}/?token=${FN_SETUP_TOKEN}"
    bridge_note ""
    bridge_note "That link includes a one-time access token — treat it like a password and"
    bridge_note "don't share it. The page pairs this bridge with your account and confirms"
    bridge_note "your content folder. Once it shows “Your account is paired with this"
    bridge_note "bridge”, you're done. (The token also lives in ${FN_INSTALL_DIR}/.env as"
    bridge_note "CONTENT_BRIDGE_SETUP_TOKEN if you need it again.)"
    return
  fi
  # Default: localhost wizard on this machine.
  bridge_say "✓ Bridge is running."
  bridge_note "Finish setup in your browser ON THIS MACHINE:"
  bridge_note ""
  bridge_note "    http://localhost:${FN_BRIDGE_UI_PORT}"
  bridge_note ""
  bridge_note "The wizard pairs this bridge with your account and confirms your content"
  bridge_note "folder. Once it shows “Your account is paired with this bridge”, you can"
  bridge_note "close the window — the bridge keeps running in the background."
}
