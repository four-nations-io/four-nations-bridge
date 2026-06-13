// Setup UI — Phase F V0.1, extended V0.8.b with the pairing wizard.
//
// Tiny Express server bound to all interfaces inside the container (the
// host-side port binding `127.0.0.1:<port>:<port>` in the compose template is
// what enforces localhost-only access — see arch-note 03 §Container
// hardening; binding 127.0.0.1 *inside* the container would break Docker's
// port forward, which connects from the container's bridge interface).
// Defense in depth on top of the host binding:
//   - every request's Host header must be a localhost form (DNS-rebinding
//     guard — a malicious page can't reach us via an attacker-controlled
//     hostname that resolves to 127.0.0.1),
//   - pairing attempts are rate-limited (5/min) + failures logged,
//   - the wizard route cluster only exists while UNPAIRED — once paired,
//     every /api/setup/* route returns 404.
//
// V0.8.b wizard flow (all copy is ACCOUNT-level per the Q2 pairing-language
// lock: pairing is between the creator's account and this bridge — never
// "your browser is paired"):
//   1. POST /api/setup/pair        — pairing code + bridge name; verified live
//                                    against the gateway via a one-shot WSS
//                                    HELLO probe before anything persists.
//   2. POST /api/setup/validate-root — initial content-folder host path;
//                                    resolved against the narrow bind mounts.
//   3. POST /api/setup/complete    — writes the paired-state file (0600) and
//                                    starts the WSS client without a restart.

import { existsSync, promises as fsp, constants as fsConstants } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { SharedState } from '../wss-client';
import { DEVICE_LABEL_REGEX } from '../config';
import { probePairing } from '../pairing/probe';
import { savePairedState, type PairedState } from '../pairing/state';
import { resolveSourceRoot, SOURCE_HOST_PREFIX } from '../source-roots/resolve';

const PUBLIC_DIR_CANDIDATES = [
  join(__dirname, 'public'),       // dist/setup-ui/public (production)
  join(__dirname, '..', '..', 'src', 'setup-ui', 'public'), // src/setup-ui/public (dev fallback)
];

// Host-header allowlist — localhost forms only (with or without a port).
const LOCALHOST_HOST_REGEX = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

// Private-network Host forms additionally allowed ONLY in LAN setup mode (which
// is itself token-gated). RFC1918 + link-local IPv4 literals. Public hostnames
// stay rejected: a malicious page on a public domain that resolves to the NAS
// IP would carry its own Host header — neither a localhost form, a private-IP
// literal, nor the configured CONTENT_BRIDGE_SETUP_UI_HOST — so it can't load
// the UI even before the token check (anti-DNS-rebinding, defence in depth on
// top of the token).
const PRIVATE_HOST_REGEX =
  /^(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2})(:\d{1,5})?$/;

// LAN setup token transport: a request header (preferred — keeps it out of the
// address bar after the first load) or a ?token= query param (the install hands
// out a URL with it so the first GET can authenticate).
const SETUP_TOKEN_HEADER = 'x-content-bridge-setup-token';

/** Constant-time token comparison via fixed-length SHA-256 digests. Hashing
 *  first means timingSafeEqual always gets equal-length buffers (it throws on a
 *  length mismatch) and the comparison leaks neither the token nor its length —
 *  same pattern the gateway uses for the bearer hash. */
function setupTokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function presentedSetupToken(req: express.Request): string {
  const header = req.headers[SETUP_TOKEN_HEADER];
  if (typeof header === 'string' && header.length > 0) return header;
  const q = req.query?.token;
  if (typeof q === 'string' && q.length > 0) return q;
  return '';
}

/** True if `p` is accessible with the given fs mode (R_OK / W_OK / both).
 *  Used by the wizard's folder-permission checks; never throws. */
async function checkAccess(p: string, mode: number): Promise<boolean> {
  try {
    await fsp.access(p, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a copy-paste prompt the creator can hand to an AI assistant (ChatGPT /
 * Claude) to get safe, least-privilege, OS-specific commands for granting the
 * bridge's user the access it needs. Surfaced in the wizard when a permission
 * check fails — it handles the long tail of NAS brands without us shipping a
 * playbook per platform. Deliberately steers AWAY from `chmod -R 777`.
 */
function buildSetupPrompt(opts: {
  platform: string;
  uid: number;
  gid: number;
  contentHostPath: string;
  managedHostPath: string;
  contentReadable: boolean;
  managedWritable: boolean;
}): string {
  const failing =
    !opts.contentReadable && !opts.managedWritable
      ? 'both the content folder (needs read) and the working folder (needs read+write)'
      : !opts.contentReadable
        ? 'the content folder (needs read)'
        : 'the working folder (needs read+write)';
  const platformName =
    opts.platform === 'darwin'
      ? 'macOS'
      : opts.platform === 'win32'
        ? 'Windows'
        : 'Linux / a NAS (tell me the exact brand + version)';
  return [
    `I'm setting up a self-hosted "content bridge" app that runs in Docker as a`,
    `non-root user and needs file permissions on two folders. Give me the exact,`,
    `safe, least-privilege commands for MY system, explain each step, and do NOT`,
    `use a recursive "chmod 777" or anything that weakens security.`,
    ``,
    `My system: ${platformName}.`,
    `The bridge container runs as uid:gid = ${opts.uid}:${opts.gid}.`,
    `1) CONTENT folder — the app must only READ it, never write:`,
    `   ${opts.contentHostPath || '(the folder I pointed the bridge at)'}`,
    `2) WORKING folder — the app must READ and WRITE it (thumbnails, cache, state):`,
    `   ${opts.managedHostPath || '(the bridge working folder)'}`,
    ``,
    `Right now the bridge can't access ${failing}.`,
    ``,
    `Please walk me through, step by step:`,
    `- identifying or creating the user/uid the bridge should run as (if needed),`,
    `- granting uid ${opts.uid} READ-only on the content folder and READ+WRITE on`,
    `  the working folder, using my OS's native tools (prefer ACLs over broad chmod),`,
    `- how to verify it worked,`,
    `- anything specific to my NAS/OS I should watch out for.`,
  ].join('\n');
}

interface HardenBlock {
  title: string;
  /** Shell to copy + run on the host (empty for an info-only block). */
  body: string;
  note?: string;
}

/**
 * Build the copy-paste command blocks for the post-pairing "harden the bridge
 * account" panel (run as a dedicated low-privilege user). The browser can only
 * GUIDE + generate commands — the uid is fixed at container creation, so the
 * user runs these on the host and the container restarts as the new uid.
 *
 * SECURITY: `targetUid` is the only user-supplied value interpolated into a
 * shell command (which is then run with sudo), so the caller MUST validate it
 * against /^\d+:\d+$/ before passing it here. Paths come from trusted env.
 */
function buildHardenPlan(opts: {
  route: 'info' | 'auto' | 'guided';
  platform: string;
  contentHostPath: string;
  installDir: string;
  targetUid: string | null;
}): HardenBlock[] {
  const { route, platform, contentHostPath, installDir } = opts;
  if (route === 'info') return [];
  if (platform === 'darwin' || platform === 'win32') {
    return [
      {
        title: 'Nothing to harden on this platform',
        body: '',
        note:
          'On macOS/Windows, Docker Desktop runs the bridge in a managed VM and translates file ownership — there is no host uid to lock down, so the dedicated-user hardening does not apply here.',
      },
    ];
  }
  const cd = `cd "${installDir}"`;
  if (route === 'auto') {
    return [
      {
        title: 'Run once on this machine (needs sudo)',
        body: [
          cd,
          'sudo useradd -r -M -s /usr/sbin/nologin fournations-bridge 2>/dev/null || true',
          'NEWID="$(id -u fournations-bridge):$(id -g fournations-bridge)"',
          `sudo setfacl -R -m u:fournations-bridge:rX "${contentHostPath}"`,
          'sudo chown -R "$NEWID" managed cache',
          "grep -q '^CONTENT_BRIDGE_RUN_AS_USER=' .env \\",
          '  && sudo sed -i "s|^CONTENT_BRIDGE_RUN_AS_USER=.*|CONTENT_BRIDGE_RUN_AS_USER=$NEWID|" .env \\',
          '  || echo "CONTENT_BRIDGE_RUN_AS_USER=$NEWID" | sudo tee -a .env',
          'docker compose up -d',
        ].join('\n'),
        note: 'Creates a no-login user, gives it read-only on your content, makes it the bridge’s user, and restarts. The bridge reconnects as the new user — reload this page to verify. (If setfacl fails — e.g. on a DSM share — use the Guided route and grant read via your NAS UI.)',
      },
    ];
  }
  // guided
  const blocks: HardenBlock[] = [
    {
      title: 'Step 1 — create a dedicated low-privilege user',
      body: 'sudo useradd -r -M -s /usr/sbin/nologin fournations-bridge',
      note: 'Synology DSM: Control Panel → User & Group → Create — group “users” only; give your content shared folder Read-only and everything else No access.',
    },
    {
      title: 'Step 2 — give it read on your content',
      body: `sudo setfacl -R -m u:fournations-bridge:rX "${contentHostPath}"`,
      note: 'On DSM the Read-only share permission from step 1 already does this — skip this command.',
    },
    {
      title: 'Step 3 — find its uid:gid, then paste it below',
      body: 'echo "$(id -u fournations-bridge):$(id -g fournations-bridge)"',
    },
  ];
  if (opts.targetUid) {
    blocks.push({
      title: 'Step 4 — apply it and restart',
      body: [
        cd,
        `sudo chown -R "${opts.targetUid}" managed cache`,
        "grep -q '^CONTENT_BRIDGE_RUN_AS_USER=' .env \\",
        `  && sudo sed -i "s|^CONTENT_BRIDGE_RUN_AS_USER=.*|CONTENT_BRIDGE_RUN_AS_USER=${opts.targetUid}|" .env \\`,
        `  || echo "CONTENT_BRIDGE_RUN_AS_USER=${opts.targetUid}" | sudo tee -a .env`,
        'docker compose up -d',
      ].join('\n'),
      note: 'The bridge restarts as the new user — reload this page to verify.',
    });
  }
  return blocks;
}

// Pairing-attempt rate limit: 5 per rolling 60s window, across all callers
// (the surface is localhost-only, so a per-IP split adds nothing).
const PAIR_RATE_LIMIT = 5;
const PAIR_RATE_WINDOW_MS = 60_000;

export interface SetupUiHooks {
  /** Invoked after the paired-state file is on disk — main.ts applies the new
   *  credential and starts the WSS client without a container restart. */
  onPaired: (state: PairedState) => void;
}

export function startSetupUiServer(state: SharedState, hooks: SetupUiHooks) {
  const app = express();
  app.disable('x-powered-by');
  // Case-sensitive routing so a case-variant path (e.g. /API/...) can't both
  // dodge the lowercase /api/ token-gate check below AND still match a lowercase
  // route handler — Express routes case-insensitively by default, which would
  // otherwise bypass the LAN setup token. Defense in depth on top of the
  // lowercased check in the access gate.
  app.set('case sensitive routing', true);
  app.use(express.json({ limit: '16kb' }));

  // LAN-mode knobs (V0.8.b "Both"). When LAN mode is OFF this collapses to the
  // original localhost-only posture; the host port binding (127.0.0.1) + the
  // localhost Host-header allowlist are the only boundary and no token is asked.
  const lanMode = state.config.setupUiLan;
  const setupToken = state.config.setupToken;
  const extraHost = state.config.setupUiHost; // already lower-cased in config

  // The uid:gid the container actually runs as — referenced in the folder
  // permission checks + the AI setup prompt. (Linux container; getuid/getgid
  // are always present, but guard for the type checker.)
  const runUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const runGid = typeof process.getgid === 'function' ? process.getgid() : 0;

  // ── Access gate (all routes): Host-header guard + LAN token ──────────────
  app.use((req, res, next) => {
    const ra = req.socket.remoteAddress ?? '';
    // In-container loopback = the Docker healthcheck (and any local probe). It
    // can't be spoofed from off-box: everything else arrives via the host
    // port-map, so its remoteAddress is the Docker bridge gateway, not 127.x.
    // Loopback is therefore always trusted + token-exempt (keeps /healthz green
    // even when LAN mode is mis-set or fail-closed below).
    const loopback =
      ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';

    if (!loopback) {
      const host = String(req.headers.host ?? '').toLowerCase();
      // Tolerate an optional :port when matching the configured extra host, so
      // CONTENT_BRIDGE_SETUP_UI_HOST=nas.local also matches a "nas.local:8124"
      // Host header (and an explicit host:port config still matches exactly).
      const hostNoPort = host.replace(/:\d{1,5}$/, '');
      const extraHostOk =
        extraHost !== '' && (host === extraHost || hostNoPort === extraHost);
      const hostOk =
        LOCALHOST_HOST_REGEX.test(host) ||
        (lanMode && (PRIVATE_HOST_REGEX.test(host) || extraHostOk));
      if (!hostOk) {
        // eslint-disable-next-line no-console
        console.warn(`bridge: setup UI rejected Host header "${host}"`);
        return res.status(403).json({ error: 'forbidden-host' });
      }
    }

    // Token gate. Loopback (healthcheck) and non-LAN mode (localhost-only host
    // binding) need no token. LAN mode requires a valid token on every
    // non-loopback API request; LAN mode with NO token configured fails closed
    // (503) rather than serving the API unauthenticated to the network.
    if (loopback || !lanMode) return next();
    // The token protects the API surface only (/api/*). The static SPA shell
    // (index.html / app.js / styles.css) holds no secrets, and a browser can't
    // attach the token to its OWN sub-resource requests — a `<script src>` /
    // `<link href>` GET carries no query string and no custom header — so
    // token-gating those would 401 the page's own JS/CSS and render a blank
    // page. An unauthenticated LAN client can fetch the inert shell, but every
    // /api/* call (pairing actions + status/config data) still requires the
    // token, so it can neither pair the bridge nor read its state. (This same
    // exemption keeps the fail-closed 503 below scoped to the API too.)
    // Lowercase the comparison: Express's route matching is case-insensitive by
    // default, so a path like /API/harden-plan would otherwise dodge this
    // case-sensitive prefix check (treated as a static asset → token skipped)
    // yet still match the lowercase route handler — bypassing the gate. We also
    // set `case sensitive routing` above so such a path 404s rather than running.
    if (!req.path.toLowerCase().startsWith('/api/')) return next();
    if (setupToken === '') {
      return res.status(503).json({
        error: 'setup-ui-misconfigured',
        message:
          'LAN setup UI is enabled but no setup token is configured. Set CONTENT_BRIDGE_SETUP_TOKEN and restart the bridge.',
      });
    }
    const presented = presentedSetupToken(req);
    if (presented === '' || !setupTokensMatch(presented, setupToken)) {
      // eslint-disable-next-line no-console
      console.warn(`bridge: setup UI rejected bad/missing setup token from ${ra}`);
      return res.status(401).json({ error: 'bad-setup-token', message: 'A valid setup token is required.' });
    }
    return next();
  });

  // Status JSON — consumed by the static page's vanilla-JS poller every 2s
  app.get('/api/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      phase: 'V0.8',
      appVersion: state.config.appVersion,
      deviceLabel: state.config.deviceLabel,
      devicePlatform: state.config.devicePlatform,
      saasUrl: state.config.saasUrl,
      sourceRoot: state.config.sourceRoot,
      thumbWritableRoot: state.config.thumbWritableRoot,
      thumbSubpathWithinProject: state.config.thumbSubpathWithinProject,
      thumbPositions: state.config.thumbPositions,
      paired: state.pairing.paired,
      pairingSource: state.pairing.source,
      pairedAt: state.pairing.pairedAt,
      wssStatus: state.wssStatus,
      lastWssEvent: state.lastWssEvent,
      helloAckedAt: state.helloAckedAt,
      bridgeDeviceId: state.bridgeDeviceId,
      reconnectAttempts: state.reconnectAttempts,
      syncStatus: state.syncStatus,
      syncStats: state.syncStats,
      thumbSyncStatus: state.thumbSyncStatus,
      thumbSyncStats: state.thumbSyncStats,
      now: Date.now(),
    });
  });

  app.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // Healthy if the setup UI server is up. WSS-connectedness is reported
    // separately in /api/status so a flapping gateway doesn't restart the
    // container. Unpaired is also healthy — the wizard is the intended state.
    res.json({ ok: true, phase: 'V0.8', paired: state.pairing.paired, wssStatus: state.wssStatus });
  });

  // "Harden the bridge account" — generate copy-paste commands for running the
  // bridge as a dedicated low-privilege user. Lives OUTSIDE the requireUnpaired
  // cluster (the panel is on the paired status page). No state change: it only
  // returns the current run-as + perms + tailored commands the user runs on the
  // host. Still behind the access gate (token required in LAN mode).
  app.post('/api/harden-plan', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const reqRoute = req.body?.route;
    const route: 'info' | 'auto' | 'guided' =
      reqRoute === 'auto' || reqRoute === 'guided' ? reqRoute : 'info';
    // targetUid is user-pasted and gets interpolated into a sudo command, so
    // accept ONLY a strict uid:gid — anything else is dropped (no injection).
    let targetUid: string | null = null;
    const rawUid = typeof req.body?.targetUid === 'string' ? req.body.targetUid.trim() : '';
    if (/^\d{1,7}:\d{1,7}$/.test(rawUid)) targetUid = rawUid;

    const contentReadable = await checkAccess(state.config.sourceRoot, fsConstants.R_OK);
    const managedWritable = await checkAccess(
      state.config.managedRoot,
      fsConstants.R_OK | fsConstants.W_OK
    );
    const managedHostPath = state.config.managedHostPath || state.config.managedRoot;
    // The host folder the .env + compose live in — best-effort: the parent of
    // the managed bind (install-script layout is <install>/managed).
    const installDir = managedHostPath ? dirname(managedHostPath) : '';
    const blocks = buildHardenPlan({
      route,
      platform: state.config.devicePlatform,
      contentHostPath: state.config.hostContentPath,
      installDir,
      targetUid,
    });
    res.json({
      runAs: `${runUid}:${runGid}`,
      platform: state.config.devicePlatform,
      contentReadable,
      managedWritable,
      contentHostPath: state.config.hostContentPath,
      managedHostPath,
      installDir,
      route,
      blocks,
    });
  });

  // ── V0.8.b pairing wizard route cluster — UNPAIRED ONLY ─────────────────
  // Once paired, every route below 404s (same body as the catch-all so a
  // paired bridge doesn't even reveal the wizard exists).

  /** In-progress wizard state — memory-only until /complete persists it. */
  const wizard: {
    // V0.9d two-token: after a successful claim we hold the gateway-ISSUED
    // per-device bearer + the stable device_key the claim was bound to (NOT the
    // single-use code, which the gateway has already consumed). /complete persists
    // these into paired.json.
    candidate: {
      deviceKey: string;
      issuedBearer: string;
      encryptionKeyHex: string;
      label: string;
      deviceId: number | null;
    } | null;
    chosenRoot: { hostPath: string; writable: boolean } | null;
    /** Set by /validate-root once the bridge's managed (working) folder is
     *  confirmed read-write. /complete refuses to finish without it — saving
     *  the pairing writes there, so a non-writable managed folder would fail. */
    managedReady: boolean;
  } = { candidate: null, chosenRoot: null, managedReady: false };

  const pairAttempts: number[] = [];
  let pairInFlight = false;

  function requireUnpaired(
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) {
    if (state.pairing.paired) return res.status(404).json({ error: 'not-found' });
    next();
  }

  app.get('/api/setup/state', requireUnpaired, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // Pre-flight the bridge's working (managed) folder so the wizard can show
    // its read-write status on load, before the user clicks Check.
    const managedWritable = await checkAccess(
      state.config.managedRoot,
      fsConstants.R_OK | fsConstants.W_OK
    );
    // If the working folder isn't writable on load, ship the remediation prompt
    // (managed-focused) so the wizard can offer "copy a setup prompt" up front.
    const setupPrompt = managedWritable
      ? null
      : buildSetupPrompt({
          platform: state.config.devicePlatform,
          uid: runUid,
          gid: runGid,
          contentHostPath: state.config.hostContentPath,
          managedHostPath: state.config.managedHostPath || state.config.managedRoot,
          contentReadable: true,
          managedWritable,
        });
    res.json({
      paired: false,
      saasUrl: state.config.saasUrl,
      // V0.8.b hardening: report only WHETHER the install wrote a pairing-code
      // prefill — NEVER the code itself. The wizard submits an empty code to
      // use it and the server fills it in from env during the verify probe
      // (POST /api/setup/pair below), so the convenience survives without
      // serving the credential over the localhost socket to other local uids.
      hasPrefillPairingCode: state.config.pairingCodePrefill.length > 0,
      // V0.9d: whether the wizard must collect the content encryption key (not in
      // env / paired.json yet). When true the wizard shows the encryption-key field
      // on step 1; when false it's already configured and the field stays hidden.
      needsEncryptionKey: state.config.encryptionKeyHex === '',
      // V0.9d: pre-fill the wizard's bridge-name field from the .env the container
      // already loaded (CONTENT_BRIDGE_DEVICE_LABEL) — no re-typing what was entered
      // on the web app's Install Bridge page. Empty when not set in the .env.
      deviceLabel: state.config.deviceLabel,
      defaultRootSuggestion: state.config.hostContentPath || '',
      // Web-app base URL for the success-screen "browse your content" link.
      appUrl: state.config.appUrl,
      // The bridge's own working folder (host path for display; it's fixed by
      // the install mount). The UI confirms it and shows its read-write status.
      managedHostPath: state.config.managedHostPath || state.config.managedRoot,
      managedWritable,
      // The uid:gid the bridge runs as — shown so the user knows which user the
      // permission fixes (and the AI setup prompt) refer to.
      runAs: `${runUid}:${runGid}`,
      // Present only when the working folder isn't writable on load (else null).
      setupPrompt,
      wssStatus: state.wssStatus,
      candidate: wizard.candidate
        ? { label: wizard.candidate.label, deviceId: wizard.candidate.deviceId }
        : null,
      chosenRoot: wizard.chosenRoot,
      now: Date.now(),
    });
  });

  // Step 1 — verify the pairing code + bridge name against the gateway.
  app.post('/api/setup/pair', requireUnpaired, async (req, res) => {
    const now = Date.now();
    while (pairAttempts.length > 0 && now - pairAttempts[0] > PAIR_RATE_WINDOW_MS) {
      pairAttempts.shift();
    }
    if (pairAttempts.length >= PAIR_RATE_LIMIT) {
      // eslint-disable-next-line no-console
      console.warn(
        `bridge: pairing rate limit hit (${PAIR_RATE_LIMIT}/min) from ${req.socket.remoteAddress ?? 'unknown'}`
      );
      return res.status(429).json({ error: 'rate-limited', retryAfterSeconds: 60 });
    }
    if (pairInFlight) {
      return res.status(409).json({ error: 'pairing-in-progress' });
    }
    pairAttempts.push(now);

    const submitted = typeof req.body?.pairingCode === 'string' ? req.body.pairingCode.trim() : '';
    // Empty submission + an install-provided prefill → use the prefill,
    // resolved server-side (it's never sent to the browser; see
    // /api/setup/state). A pasted code always overrides the prefill.
    const code = submitted || state.config.pairingCodePrefill;
    const label = typeof req.body?.deviceLabel === 'string' ? req.body.deviceLabel.trim() : '';
    if (code.length < 32) {
      return res.status(400).json({
        error: 'bad-pairing-code',
        message: 'Pairing codes are at least 32 characters — paste the full code.',
      });
    }
    if (!DEVICE_LABEL_REGEX.test(label)) {
      return res.status(400).json({
        error: 'bad-device-label',
        message:
          'Bridge name must be 1-64 characters: letters/numbers, then letters, numbers, spaces, “_”, “.” or “-”.',
      });
    }

    // V0.9d: collect the content encryption key here when it isn't already
    // configured (env or a prior pairing). When it IS configured, reuse it and
    // ignore any submitted value. Validated 64-hex (server-side; the wizard also
    // checks client-side). Stored in paired.json on /complete — never logged.
    const needsKey = state.config.encryptionKeyHex === '';
    const submittedKey =
      typeof req.body?.encryptionKeyHex === 'string' ? req.body.encryptionKeyHex.trim() : '';
    if (needsKey && !/^[0-9a-fA-F]{64}$/.test(submittedKey)) {
      return res.status(400).json({
        error: 'bad-encryption-key',
        message:
          'Enter your content encryption key — the 64-character code (letters a–f and numbers 0–9) from your install instructions.',
      });
    }
    const encryptionKeyHex = needsKey ? submittedKey : state.config.encryptionKeyHex;

    pairInFlight = true;
    try {
      // V0.9d two-token: mint the stable identity NOW, before the claim, so the
      // gateway binds the device row to the same key the daemon reconnects with
      // (no orphaned probe-only row), and persist the gateway-ISSUED bearer rather
      // than the single-use code.
      const deviceKey = randomUUID();
      const result = await probePairing({
        saasUrl: state.config.saasUrl,
        pairingCode: code,
        deviceKey,
        deviceLabel: label,
        devicePlatform: state.config.devicePlatform,
        appVersion: state.config.appVersion,
      });
      if (!result.ok) {
        // Log the failure (never the code itself) — the bridge-side access
        // trail lives in the container log; the gateway logs the 401 on its
        // side as well.
        // eslint-disable-next-line no-console
        console.warn(
          `bridge: pairing attempt FAILED (${result.reason}) label="${label}" from ${req.socket.remoteAddress ?? 'unknown'} — ${result.detail}`
        );
        const messages: Record<string, string> = {
          unauthorized: 'That pairing code wasn’t accepted. Check it and try again.',
          'label-rejected':
            'The bridge name was rejected. Use letters, numbers, spaces, “_”, “.” or “-” (or the account may already have its maximum number of bridges).',
          unreachable:
            'Couldn’t reach the service. Check this machine’s internet connection and that CONTENT_BRIDGE_SAAS_URL is correct.',
          timeout: 'The service didn’t answer in time. Try again in a moment.',
          protocol: 'Unexpected response from the service. Try again in a moment.',
        };
        return res
          .status(result.reason === 'unauthorized' ? 401 : 502)
          .json({ error: result.reason, message: messages[result.reason] });
      }
      wizard.candidate = {
        deviceKey,
        // Persist the gateway-issued per-device bearer; fall back to the submitted
        // value only if the gateway didn't issue one (e.g. a legacy shared bearer
        // pasted into the code field).
        issuedBearer: result.deviceBearer ?? code,
        encryptionKeyHex,
        label,
        deviceId: result.deviceId,
      };
      // eslint-disable-next-line no-console
      console.log(`bridge: pairing claimed for "${label}" (deviceId=${result.deviceId})`);
      return res.json({ ok: true, deviceId: result.deviceId });
    } finally {
      pairInFlight = false;
    }
  });

  // Step 2 — confirm the folders + check permissions. The content folder must
  // be reachable AND readable (the bridge lists + reads files there); the
  // bridge's working (managed) folder must be read-write (it stores the pairing
  // state, thumbnails and previews). The managed folder is fixed by the install
  // mount — we only verify it. Both checks must pass before /complete.
  app.post('/api/setup/validate-root', requireUnpaired, async (req, res) => {
    const hostPath =
      typeof req.body?.hostPath === 'string' ? req.body.hostPath.trim().replace(/\/+$/, '') : '';
    if (!hostPath) {
      return res.status(400).json({ error: 'bad-host-path', message: 'Enter a folder path.' });
    }

    const resolved = await resolveSourceRoot({ id: 0, hostPath, enabled: true, isManaged: false });
    let contentPath: string | null = resolved.status === 'active' ? resolved.containerPath : null;
    // Legacy single-root deploys bind the content at config.sourceRoot
    // (/sources/local) instead of the /sources/host mirror — accept that path
    // too when the operator confirms the configured content root.
    if (
      !contentPath &&
      state.config.hostContentPath &&
      hostPath === state.config.hostContentPath &&
      (await checkAccess(state.config.sourceRoot, fsConstants.R_OK))
    ) {
      contentPath = state.config.sourceRoot;
    }
    const contentReadable =
      contentPath != null && (await checkAccess(contentPath, fsConstants.R_OK));

    const managedWritable = await checkAccess(
      state.config.managedRoot,
      fsConstants.R_OK | fsConstants.W_OK
    );

    const content = {
      hostPath,
      readable: contentReadable,
      message: contentReadable
        ? null
        : resolved.status !== 'active'
          ? (resolved.lastError ??
            'That folder isn’t reachable from the bridge. Check the path matches the folder you chose during install.')
          : 'The bridge can reach that folder but can’t read it — check the folder’s read permission for the bridge’s user (see the install docs).',
    };
    const managed = {
      hostPath: state.config.managedHostPath || state.config.managedRoot,
      writable: managedWritable,
      message: managedWritable
        ? null
        : 'The bridge’s working folder isn’t writable — it can’t save thumbnails or the pairing here. Fix its ownership (see the install docs) and try again.',
    };

    wizard.managedReady = managedWritable;
    if (contentReadable && managedWritable) {
      wizard.chosenRoot = { hostPath, writable: resolved.writable };
      return res.json({ ok: true, content, managed });
    }
    wizard.chosenRoot = null;
    // A failed check ships the AI setup prompt + the run-as uid so the wizard
    // can offer the "copy a setup prompt" remediation (Option A).
    const setupPrompt = buildSetupPrompt({
      platform: state.config.devicePlatform,
      uid: runUid,
      gid: runGid,
      contentHostPath: hostPath,
      managedHostPath: state.config.managedHostPath || state.config.managedRoot,
      contentReadable,
      managedWritable,
    });
    return res
      .status(422)
      .json({ ok: false, content, managed, setupPrompt, runAs: `${runUid}:${runGid}` });
  });

  // Step 2 helper — enumerate what's actually mounted under /sources/host so
  // the wizard can suggest candidates instead of making the creator re-type
  // the path they already gave the install script.
  app.get('/api/setup/mounts', requireUnpaired, async (_req, res) => {
    let mounts: string[] = [];
    try {
      const raw = await fsp.readFile('/proc/self/mounts', 'utf8');
      mounts = raw
        .split('\n')
        .map((line) => line.split(' ')[1] ?? '')
        // /proc/self/mounts octal-escapes spaces (\040) etc.
        .map((p) => p.replace(/\\(\d{3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8))))
        .filter((p) => p.startsWith(SOURCE_HOST_PREFIX + '/'))
        .map((p) => p.slice(SOURCE_HOST_PREFIX.length));
    } catch {
      // Non-linux dev runs have no /proc — suggestions are a convenience only.
      mounts = [];
    }
    res.json({ hostPaths: mounts });
  });

  // Step 3 — persist + go live.
  app.post('/api/setup/complete', requireUnpaired, async (_req, res) => {
    if (!wizard.candidate) {
      return res.status(409).json({ error: 'not-verified', message: 'Pair with your account first.' });
    }
    if (!wizard.chosenRoot) {
      return res
        .status(409)
        .json({ error: 'no-root', message: 'Confirm your content folder first.' });
    }
    if (!wizard.managedReady) {
      return res.status(409).json({
        error: 'managed-not-writable',
        message:
          'The bridge’s working folder isn’t writable yet — re-check your folders (step 2) before finishing.',
      });
    }
    const paired: PairedState = {
      version: 1,
      // V0.9d two-token: the durable credential is the gateway-ISSUED per-device
      // bearer captured during the claim — NOT the (now single-use-consumed) code.
      bearer: wizard.candidate.issuedBearer,
      // The SAME stable identity the claim was bound to (minted before the probe),
      // so the daemon reconnects onto the exact device row the gateway created and
      // a later rebuild/rename at the same managed path re-attaches to it.
      deviceKey: wizard.candidate.deviceKey,
      deviceLabel: wizard.candidate.label,
      // V0.9d: the content encryption key (wizard-entered, or the existing env key
      // when one was already configured). Persisted owner-only in paired.json.
      encryptionKeyHex: wizard.candidate.encryptionKeyHex,
      initialSourceRootHostPath: wizard.chosenRoot.hostPath,
      pairedAt: Date.now(),
    };
    try {
      await savePairedState(state.config.stateDir, paired);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('bridge: failed to write paired-state file', err);
      return res.status(500).json({
        error: 'persist-failed',
        message:
          'Couldn’t save the pairing. Check the bridge’s state folder is writable (see install docs), then try again.',
      });
    }
    wizard.candidate = null;
    // eslint-disable-next-line no-console
    console.log(`bridge: pairing complete — "${paired.deviceLabel}" is paired with the account`);
    hooks.onPaired(paired);
    return res.json({ ok: true });
  });

  // Static assets — index.html + styles.css + app.js. Use whichever public
  // dir actually exists (dist in container, src in local dev).
  const publicDir = PUBLIC_DIR_CANDIDATES.find((d) => existsSync(d));
  if (publicDir) {
    app.use(express.static(publicDir, { extensions: ['html'] }));
  } else {
    // eslint-disable-next-line no-console
    console.warn(`bridge: no setup-ui public dir found; tried ${PUBLIC_DIR_CANDIDATES.join(', ')}`);
  }

  // 404 catch-all — keep responses small to avoid info leak
  app.use((_req, res) => {
    res.status(404).json({ error: 'not-found' });
  });

  const server = app.listen(state.config.setupUiPort, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`bridge: setup UI listening on :${state.config.setupUiPort}`);
  });

  return server;
}
