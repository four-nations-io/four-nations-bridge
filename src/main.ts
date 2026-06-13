// four-nations-bridge — entry point.
//
// Boots the setup UI server (localhost-only Express) and — once the bridge is
// paired — the WSS client (long-running connection to bridge-gateway). Both
// share the same runtime state (`SharedState`) so the setup UI can render
// "connected / reconnecting" without polling the WSS client.
//
// V0.8.b pairing model: the credential the bridge presents to the gateway
// comes from EITHER the legacy env var (CONTENT_BRIDGE_BEARER — the V0
// operator deployments) OR the paired-state file the setup wizard writes
// (creator installs). No bearer from either source = unpaired mode: only the
// setup UI runs, with its wizard route cluster active, until the creator
// completes pairing — at which point the WSS client starts without a restart.

import { promises as fsp, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig, DEVICE_LABEL_REGEX } from './config';
import { startSetupUiServer } from './setup-ui/server';
import { startWssClient, type SharedState, type WssClient } from './wss-client';
import { emptyRuntimeSettingsState } from './settings/runtime';
import { emptyThumbStats } from './thumb/orchestrator';
import { loadPairedState, savePairedState, type PairedState } from './pairing/state';
import { probePairing } from './pairing/probe';

/**
 * Probe that the state dir is creatable + writable BEFORE the wizard tries to
 * persist a pairing. The state dir lives under the bridge-owned managed area;
 * if that isn't writable by the run UID (e.g. a misconfigured mount), surface
 * it loudly at boot rather than failing only at the final "Finish" click.
 */
async function probeStateDirWritable(stateDir: string): Promise<void> {
  try {
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const probe = join(stateDir, '.write-probe');
    await fsp.writeFile(probe, '', { mode: 0o600 });
    await fsp.rm(probe);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `bridge: WARNING — paired-state dir "${stateDir}" is not writable by this ` +
        `container's user; pairing will fail to save. Ensure the managed folder ` +
        `is owned by the bridge's run UID (see docs/install/security.md). Cause: ` +
        `${(err as Error)?.message ?? err}`
    );
  }
}

/**
 * Coerce an arbitrary host name into a valid bridge device label (matches the
 * gateway's DEVICE_LABEL_REGEX: alphanumeric start, then alphanumerics / space /
 * `_` / `.` / `-`, ≤64). Used as the headless auto-pair fallback when the
 * install didn't set CONTENT_BRIDGE_DEVICE_LABEL. Empty → "bridge".
 */
function sanitizeDeviceLabel(raw: string): string {
  let s = raw.trim().replace(/[^A-Za-z0-9 _.-]/g, '-');
  s = s.replace(/^[^A-Za-z0-9]+/, ''); // a label must start alphanumeric
  s = s.slice(0, 64);
  return s.length > 0 ? s : 'bridge';
}

/**
 * Boot-time permission self-check. Whatever uid:gid the container ended up as
 * (the image's built-in 1031:100, or a CONTENT_BRIDGE_RUN_AS_USER override),
 * verify it can actually READ the content folder and READ+WRITE the working
 * (managed) folder. On failure, log a LOUD, specific error naming the uid and
 * the fix — a misconfigured uid otherwise produces only cryptic EACCES errors
 * deep in the indexer. Warns rather than exits: the container stays up so the
 * operator can read this log / use the wizard, and access can appear later
 * (e.g. once they run fix-perms.sh) without a restart loop.
 */
async function probeBridgePermissions(config: ReturnType<typeof loadConfig>): Promise<void> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  const checks = [
    { label: 'READ content folder', path: config.sourceRoot, mode: fsConstants.R_OK },
    {
      label: 'READ+WRITE working folder',
      path: config.managedRoot,
      mode: fsConstants.R_OK | fsConstants.W_OK,
    },
  ];
  const failures: string[] = [];
  for (const c of checks) {
    try {
      await fsp.access(c.path, c.mode);
    } catch {
      failures.push(`  - can't ${c.label}: ${c.path}`);
    }
  }
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `bridge: PERMISSION PROBLEM — the bridge runs as uid:gid ${uid}:${gid} but:\n` +
        `${failures.join('\n')}\n` +
        `Fix: set CONTENT_BRIDGE_RUN_AS_USER to a uid:gid that owns/can read your content ` +
        `(find it with: stat -c '%u:%g' <your content path>), and make sure that uid can ` +
        `write the working folder. If you installed via the script, run fix-perms.sh in your ` +
        `install folder, or paste setup-account-prompt.txt into an AI assistant. The bridge ` +
        `keeps running and will pick up access once it's granted.`
    );
  }
}

/** Build the setup-page URL to print in logs. In LAN mode this is the tokenized
 *  LAN link (so the operator can copy it straight from `docker logs` instead of
 *  reconstructing it from .env); otherwise the localhost link. Returns '' when
 *  LAN mode is on but no token is set (fail-closed — nothing usable to print). */
function setupUiUrl(config: ReturnType<typeof loadConfig>): string {
  const port = config.setupUiPort;
  if (config.setupUiLan) {
    if (!config.setupToken) return '';
    const host = config.setupUiHost || '<this-machine-LAN-IP>';
    return `http://${host}:${port}/?token=${config.setupToken}`;
  }
  return `http://localhost:${port}`;
}

/** Log where to finish setup in a browser. Called when the bridge needs the UI:
 *  no auto-pair configured, or auto-pair failed. */
function printSetupUrl(config: ReturnType<typeof loadConfig>, reason: string): void {
  const url = setupUiUrl(config);
  if (url) {
    // eslint-disable-next-line no-console
    console.log(`bridge: ${reason} — finish setup in a browser:\n    ${url}`);
    if (config.setupUiLan) {
      // eslint-disable-next-line no-console
      console.log(
        'bridge: (that link carries your one-time setup token — treat it like a password)'
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `bridge: ${reason}, but the LAN setup page is fail-closed — set CONTENT_BRIDGE_SETUP_TOKEN to use it.`
    );
  }
}

async function main() {
  const config = loadConfig();

  const pairedState = await loadPairedState(config.stateDir);

  // A pre-V0.8.b paired.json loads with an empty deviceKey. We deliberately do
  // NOT mint a fresh UUID for it — that would NOT match migration 0133's
  // `legacy:<label>` backfill and would fork a brand-new device row (orphaning
  // the bridge's already-indexed content). Instead an empty deviceKey means
  // "present no device-key header", so the gateway derives `legacy:<label>` and
  // re-attaches to the SAME device row. (New pairings get a real UUID at
  // wizard/auto-pair time → rename-safe going forward.)

  // Effective credential + identity. The wizard's paired-state file wins over
  // env (a re-pair should stick even on a host whose .env still carries the
  // legacy bearer); CONTENT_BRIDGE_FORCE_WIZARD ignores the env bearer so the
  // wizard can be exercised on the operator's dev stack.
  const envBearer = config.forceWizard ? '' : config.bearer;
  const effectiveBearer = pairedState?.bearer || envBearer;
  const effectiveLabel = pairedState?.deviceLabel || config.deviceLabel;
  config.bearer = effectiveBearer;
  config.deviceLabel = effectiveLabel;

  // V0.9d: effective content encryption key — wizard-persisted key (paired.json)
  // wins over env, same precedence as the bearer. When neither source has it the
  // bridge boots into the wizard and collects it there (web-UI-first onboarding).
  // config carries the resolved value so the thumb orchestrator (which only runs
  // after pairing) always sees a real key.
  const effectiveEncryptionKey = pairedState?.encryptionKeyHex || config.encryptionKeyHex;
  config.encryptionKeyHex = effectiveEncryptionKey;

  const paired = effectiveBearer.length > 0 && effectiveLabel.length > 0;
  if (paired && effectiveEncryptionKey === '') {
    // eslint-disable-next-line no-console
    console.warn(
      'bridge: paired but NO content encryption key (neither env nor paired.json). ' +
        'Thumbnails/previews cannot be encrypted — re-pair via the setup wizard to enter the key, ' +
        'or set CONTENT_BRIDGE_ENCRYPTION_KEY.'
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `bridge: starting (${config.appVersion}) as ${effectiveLabel || '<unpaired>'} (${config.devicePlatform})`
  );
  // eslint-disable-next-line no-console
  console.log(`bridge: SaaS URL ${config.saasUrl}`);
  // eslint-disable-next-line no-console
  console.log(`bridge: setup UI on http://127.0.0.1:${config.setupUiPort}`);
  if (config.setupUiLan && config.setupToken === '') {
    // eslint-disable-next-line no-console
    console.warn(
      'bridge: SETUP UI LAN MODE is enabled but CONTENT_BRIDGE_SETUP_TOKEN is empty — ' +
        'the LAN setup UI fails closed (every non-loopback request gets 503) until a token is set.'
    );
  } else if (config.setupUiLan) {
    // eslint-disable-next-line no-console
    console.log(
      'bridge: setup UI LAN mode ENABLED — non-loopback requests require the setup token.'
    );
  }

  // Loud, early permission self-check — runs whatever uid the container is, so a
  // wrong CONTENT_BRIDGE_RUN_AS_USER surfaces here instead of as cryptic EACCES.
  await probeBridgePermissions(config);

  if (!paired) {
    // eslint-disable-next-line no-console
    console.log('bridge: UNPAIRED — this bridge isn’t paired with an account yet.');
    // Catch an unwritable state dir now, not at "Finish". (The browse-here URL
    // is printed by printSetupUrl below, once we know whether auto-pair runs.)
    await probeStateDirWritable(config.stateDir);
  }

  const state: SharedState = {
    config,
    wssStatus: 'connecting',
    lastWssEvent: { type: 'startup', at: Date.now() },
    helloAckedAt: null,
    bridgeDeviceId: null,
    reconnectAttempts: 0,
    syncStatus: 'idle',
    syncStats: {
      startedAt: null,
      finishedAt: null,
      entriesScanned: 0,
      batchesPushed: 0,
      lastBatchAt: null,
      errorMessage: null,
    },
    thumbSyncStatus: 'idle',
    thumbSyncStats: emptyThumbStats(),
    detectedProjects: [],
    // First-run default: all projects enabled. Operator can disable in the
    // SaaS UI; gateway pushes the persisted list via SETTINGS_RESPONSE.
    enabledProjectRelPaths: new Set<string>(),
    // V0.6.b: set true on the first SETTINGS_RESPONSE so lazy gen doesn't
    // prewarm on the initial enabled-set population — only genuine false→true
    // transitions after the baseline trigger a project sync.
    enabledBaselineEstablished: false,
    runtimeSettings: emptyRuntimeSettingsState(),
    // V0.6: populated from SETTINGS_RESPONSE source_roots on each poll.
    sourceRoots: [],
    // V0.7.b: incremental mtime-diff reindex sweep state.
    dirMtimes: new Map<string, number>(),
    dirMtimesInitialized: false,
    // V0.7.d: last cache-eviction sweep time (cache-visibility panel).
    lastCacheSweepAt: null,
    // V0.8.b: pairing state — gates the setup wizard route cluster.
    pairing: {
      paired,
      source: pairedState ? 'wizard' : paired ? 'env' : 'none',
      // Stable identity sent on connect (wizard/auto-pair). null for env-bearer
      // bridges AND pre-V0.8.b keyless pairings (empty string) → no header →
      // gateway derives `legacy:<label>`, preserving their device_id.
      deviceKey: pairedState?.deviceKey || null,
      initialSourceRootHostPath: pairedState?.initialSourceRootHostPath ?? null,
      pairedAt: pairedState?.pairedAt ?? null,
    },
  };

  let wssClient: WssClient | null = null;

  // Apply a freshly-minted pairing (credential + identity) and start the WSS
  // client without a container restart. Shared by the setup wizard (source
  // 'wizard') and headless auto-pair (source 'auto').
  function applyPaired(newState: PairedState, source: 'wizard' | 'auto') {
    state.config.bearer = newState.bearer;
    state.config.deviceLabel = newState.deviceLabel;
    // V0.9d: a wizard pairing may have collected the encryption key — apply it so
    // the orchestrator encrypts thumbs with it without a container restart.
    if (newState.encryptionKeyHex) state.config.encryptionKeyHex = newState.encryptionKeyHex;
    state.pairing.paired = true;
    state.pairing.source = source;
    state.pairing.deviceKey = newState.deviceKey;
    state.pairing.initialSourceRootHostPath = newState.initialSourceRootHostPath;
    state.pairing.pairedAt = newState.pairedAt;
    if (!wssClient) {
      // eslint-disable-next-line no-console
      console.log(`bridge: paired as ${newState.deviceLabel} (${source}) — starting WSS client`);
      wssClient = startWssClient(state);
    }
  }

  /**
   * Headless auto-pair (V0.8.b "Both"). For machines with no reachable browser
   * (a NAS): verify the env pairing code against the gateway, then persist a
   * paired-state file the same way the wizard's /complete does — minting a fresh
   * device-key UUID into the managed folder so a later rebuild at the same path
   * re-attaches to the same device. Non-blocking: the setup UI is already up, so
   * this races nothing; if the wizard/LAN path pairs first we bail.
   */
  async function runAutoPair(pairingCode: string) {
    const label =
      config.deviceLabel && DEVICE_LABEL_REGEX.test(config.deviceLabel)
        ? config.deviceLabel
        : sanitizeDeviceLabel(config.deviceLabel || hostname());
    const initialRoot = config.hostContentPath || null;
    // V0.9d two-token: mint the stable identity ONCE (reused across retries) so a
    // successful claim binds the gateway device row to the key we persist + the
    // daemon reconnects with.
    const deviceKey = randomUUID();
    const MAX_ATTEMPTS = 6;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (state.pairing.paired) return; // wizard/LAN beat us to it
      const result = await probePairing({
        saasUrl: config.saasUrl,
        pairingCode,
        deviceKey,
        deviceLabel: label,
        devicePlatform: config.devicePlatform,
        appVersion: config.appVersion,
      });
      if (result.ok) {
        if (state.pairing.paired) return;
        const paired: PairedState = {
          version: 1,
          // V0.9d two-token: persist the gateway-ISSUED per-device bearer (single-
          // use code already consumed by this claim); fall back to the code only
          // if the gateway didn't issue one.
          bearer: result.deviceBearer ?? pairingCode,
          deviceKey,
          deviceLabel: label,
          // Headless auto-pair takes the key from env (it has no wizard); persist
          // it so paired.json is self-contained.
          encryptionKeyHex: config.encryptionKeyHex || undefined,
          initialSourceRootHostPath: initialRoot,
          pairedAt: Date.now(),
        };
        try {
          await savePairedState(config.stateDir, paired);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            'bridge: auto-pair could not persist paired-state — leaving unpaired. Fix the ' +
              'managed/_state writability (see docs/install/security.md), or pair via the wizard.',
            err
          );
          return;
        }
        // eslint-disable-next-line no-console
        console.log(`bridge: auto-paired headlessly as "${label}"`);
        applyPaired(paired, 'auto');
        return;
      }
      // A rejected code or name won't get better by retrying — stop and tell the
      // operator exactly what to fix. Transient gateway errors DO retry (the
      // gateway may simply not be up yet at NAS boot).
      if (result.reason === 'unauthorized' || result.reason === 'label-rejected') {
        // eslint-disable-next-line no-console
        console.error(
          `bridge: AUTO-PAIR REJECTED (${result.reason}: ${result.detail}). Fix ` +
            'CONTENT_BRIDGE_PAIRING_CODE / CONTENT_BRIDGE_DEVICE_LABEL, or pair via the setup ' +
            'wizard. Not retrying.'
        );
        printSetupUrl(config, 'auto-pair was rejected');
        return;
      }
      const backoffMs = Math.min(2_000 * attempt, 15_000);
      // eslint-disable-next-line no-console
      console.warn(
        `bridge: auto-pair attempt ${attempt}/${MAX_ATTEMPTS} failed (${result.reason}); ` +
          `retrying in ${backoffMs}ms`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
    // eslint-disable-next-line no-console
    console.error(
      `bridge: auto-pair gave up after ${MAX_ATTEMPTS} attempts (gateway unreachable). The ` +
        'setup wizard remains available, and auto-pair retries on the next restart.'
    );
    printSetupUrl(config, 'auto-pair gave up');
  }

  // Start setup UI first so the operator can see "connecting…" status (or the
  // pairing wizard) even if the gateway is unreachable.
  const uiServer = startSetupUiServer(state, {
    onPaired: (s) => applyPaired(s, 'wizard'),
  });
  if (paired) {
    wssClient = startWssClient(state);
  } else if (config.autoPair) {
    const autoPairCode = config.pairingCodePrefill;
    if (autoPairCode.length >= 32) {
      // eslint-disable-next-line no-console
      console.log(
        'bridge: AUTO-PAIR enabled — verifying the pairing code with the service (no browser needed)…'
      );
      void runAutoPair(autoPairCode);
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        'bridge: CONTENT_BRIDGE_AUTO_PAIR is set but no valid pairing code ' +
          '(CONTENT_BRIDGE_PAIRING_CODE) is present — staying unpaired.'
      );
      printSetupUrl(config, 'auto-pair needs a pairing code');
    }
  } else {
    // Not auto-pairing → the operator finishes in the browser. Print the link
    // (the tokenized LAN URL in LAN mode) so it's copy-paste-able from the logs.
    printSetupUrl(config, 'ready to pair');
  }

  function shutdown(signal: string) {
    // eslint-disable-next-line no-console
    console.log(`bridge: received ${signal}; shutting down`);
    wssClient?.stop();
    uiServer.close();
    setTimeout(() => process.exit(0), 500).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('bridge: fatal error during startup', err);
  process.exit(1);
});
