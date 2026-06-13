// WSS client — Phase F V0.2.
//
// Maintains a persistent outbound WSS connection to bridge-gateway. On
// connect: sends HELLO frame, awaits HELLO_ACK. After HELLO_ACK: kicks off
// initial sync — walks the configured source root via LocalFSPlugin, ships
// INDEX_BATCH frames in 500-entry chunks, finishes with INDEX_DONE. On
// disconnect: infinite-retry-with-backoff (per arch-note 03); the next
// reconnect re-runs the initial sync (full re-walk for V0; incremental
// watch comes in V0.5/V0.6 with chokidar).
//
// Frame types implemented in V0.2: HELLO, HELLO_ACK, PING, PONG,
// INDEX_BATCH (client → server), INDEX_DONE (client → server).
// THUMB / READ frames land in V0.3 / V0.5.

import WebSocket from "ws";
import { promises as fsp, constants as fsConstants } from "node:fs";
import type { BridgeConfig } from "./config";
import { LocalFSPlugin } from "./source-plugins/local-fs";
import type { FileEntry } from "./source-plugins/types";
import {
  runThumbSync,
  runProjectSync,
  generateForFile,
  generateProxyForFile,
  resolveActiveCacheRoot,
  emptyThumbStats,
  type ThumbSyncStatus,
  type ThumbSyncStats,
} from "./thumb/orchestrator";
import {
  startRead,
  type ActiveRead,
  type ReadQuality,
  type ReadBase,
} from "./read/stream";
import {
  handleUploadFile,
  handleDeleteFile,
  type UploadFileFrame,
  type DeleteFileFrame,
} from "./file-upload";
import {
  handleBrowserUploadStart,
  handleBrowserUploadChunk,
  handleBrowserUploadDone,
  handleBrowserUploadStatus,
  handleBrowserUploadAbort,
} from "./browser-upload";
import {
  handleTranscodeStart,
  handleTranscodeStatus,
  handleTranscodeKill,
  handleTranscodeCleanup,
  handleGenerateCacheThumb,
  generateCacheThumbToDisk,
  killAllTranscodes,
  activeTranscodeCount,
} from "./transcode";
// V0.9c admin-plane: the preview-proxy kill registry lives in the generator (the
// single ffmpeg spawn site) — imported directly here for the DAEMON_CONTROL
// KILL_PROXIES handler + pause-transition abort.
import { killAllProxies, activeProxyCount } from "./thumb/generator";
import {
  runCacheEviction,
  summarizeCache,
  clearCache,
} from "./thumb/cache-manager";
import { detectProjects, type DetectedProject } from "./projects/detect";
import {
  type RuntimeSettingsState,
  applySettingsFromServer,
  effectiveCacheSettings,
  effectivePaused,
} from "./settings/runtime";
import { isUnsafeRelPath } from "./thumb/paths";
import {
  resolveSourceRoots,
  parseSourceRootsFromSettings,
  hostPathToContainerPath,
  type ResolvedSourceRoot,
} from "./source-roots/resolve";
import { createProject } from "./projects/create";

export type WssStatus = "connecting" | "connected" | "reconnecting" | "stopped";

export type SyncStatus = "idle" | "walking" | "done" | "error";

export interface SyncStats {
  startedAt: number | null;
  finishedAt: number | null;
  entriesScanned: number;
  batchesPushed: number;
  lastBatchAt: number | null;
  errorMessage: string | null;
}

export interface SharedState {
  config: BridgeConfig;
  wssStatus: WssStatus;
  lastWssEvent: { type: string; at: number; detail?: unknown };
  helloAckedAt: number | null;
  bridgeDeviceId: number | null;
  reconnectAttempts: number;
  syncStatus: SyncStatus;
  syncStats: SyncStats;
  thumbSyncStatus: ThumbSyncStatus;
  thumbSyncStats: ThumbSyncStats;
  detectedProjects: DetectedProject[];
  enabledProjectRelPaths: Set<string>;
  /** V0.6.b: false until the first SETTINGS_RESPONSE establishes the enabled
   *  baseline. Lazy gen means we must NOT prewarm on the initial population —
   *  only genuine false→true transitions AFTER the baseline trigger a gen. */
  enabledBaselineEstablished: boolean;
  runtimeSettings: RuntimeSettingsState;
  /** Last resolution of the gateway-driven source roots (V0.6). Phase F cutover
   *  (planning doc 65): `config.sourceRoot` is now the MIRROR of the registered
   *  content root (`/sources/host<host_path>`), so the index walk runs on the
   *  source-roots-registered content root — NOT a hardcoded /sources/local. These
   *  resolved roots report status (active/needs_mount/writable) + gate create-
   *  project targeting + cache placement. V3 multi-volume: index each active root
   *  directly (loop + per-root attribution + the rel_path/root_id schema reshape). */
  sourceRoots: ResolvedSourceRoot[];
  /** V0.7.b: last-seen directory mtimes (rel path → epoch ms), for the
   *  incremental mtime-diff reindex sweep. '' = the source root itself. */
  dirMtimes: Map<string, number>;
  /** False until the first sweep establishes the baseline (so the baseline pass
   *  doesn't trigger a reindex of every folder — the initial scan already did). */
  dirMtimesInitialized: boolean;
  /** V0.7.d: epoch ms of the last completed cache-eviction sweep, surfaced in the
   *  SaaS cache-visibility panel (CACHE_STATUS_RESPONSE). null until first sweep. */
  lastCacheSweepAt: number | null;
  /** V0.8.b: pairing state. `paired` gates the wizard route cluster in the
   *  setup UI (unpaired → wizard active; paired → wizard routes 404). Pairing
   *  is between the creator's ACCOUNT and this bridge; `source` records where
   *  the credential came from ('env' = legacy V0 .env bearer, 'wizard' = the
   *  paired-state file written by the setup wizard). */
  pairing: {
    paired: boolean;
    source: "env" | "wizard" | "auto" | "none";
    /** Stable per-install identity (UUID from paired.json). Sent on connect as
     *  the X-Content-Bridge-Device-Key header so the gateway keys the device
     *  row on it (not the display label). null for env-bearer bridges, which
     *  send no header → the gateway derives `legacy:<label>`. */
    deviceKey: string | null;
    /** Initial content root chosen in the wizard — sent once per HELLO so the
     *  gateway can register it as this device's first source root. */
    initialSourceRootHostPath: string | null;
    pairedAt: number | null;
  };
}

export interface WssClient {
  stop(): void;
}

const BACKOFF_MS_INITIAL = 1_000;
const BACKOFF_MS_MAX = 60_000;
const BACKOFF_JITTER = 0.2;
const PING_INTERVAL_MS = 30_000;
const SETTINGS_POLL_INTERVAL_MS = 30_000;
const INDEX_BATCH_SIZE = 500;
// V0.6.b: once-daily lazy orchestrator scan (mtime-skip makes it near-instant
// when nothing changed) so content dropped-but-not-synced gets thumbed/proxied.
const DAILY_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
// V0.6.b: cache manager sweep cadence (tiered TTL + LRU eviction). Default 5
// min; override via CONTENT_BRIDGE_CACHE_SWEEP_MINUTES (min 1) — handy for
// testing eviction without waiting, and a reasonable production tuning knob.
const CACHE_SWEEP_MINUTES = (() => {
  const n = Number(process.env.CONTENT_BRIDGE_CACHE_SWEEP_MINUTES ?? "5");
  return Number.isFinite(n) && n >= 1 ? n : 5;
})();
const CACHE_SWEEP_INTERVAL_MS = CACHE_SWEEP_MINUTES * 60 * 1000;
// V0.7.b: incremental mtime-diff reindex sweep cadence. Default 30s; override
// via CONTENT_BRIDGE_REINDEX_SCAN_SECONDS (min 5) so a creator with a very large
// tree can dial it back. The sweep is metadata-only (dir stats) + single-flight,
// so it self-throttles when a pass runs long.
const REINDEX_SCAN_SECONDS = (() => {
  const n = Number(process.env.CONTENT_BRIDGE_REINDEX_SCAN_SECONDS ?? "30");
  return Number.isFinite(n) && n >= 5 ? n : 30;
})();
const REINDEX_SCAN_INTERVAL_MS = REINDEX_SCAN_SECONDS * 1000;

export function startWssClient(state: SharedState): WssClient {
  let stopped = false;
  let currentWs: WebSocket | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let settingsPollTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let activeSyncAbort = { stopped: false };
  // V0.6.c: in-flight byte-range READs, keyed by requestId, so READ_CANCEL (or a
  // ws close) can tear down the underlying fs.createReadStream. Scoped per
  // connection — reset implicitly on reconnect (a fresh `connect()` closure).
  const activeReads = new Map<string, ActiveRead>();
  // V0.6.b: long-lived timers (started once; they no-op when the ws is down).
  let dailyScanTimer: NodeJS.Timeout | null = null;
  let cacheSweepTimer: NodeJS.Timeout | null = null;
  // V0.7.b: incremental mtime-diff reindex sweep timer + single-flight guard.
  let reindexScanTimer: NodeJS.Timeout | null = null;
  let reindexScanRunning = false;
  // Serialize all orchestrator passes (daily / on-enable / SYNC_PROJECT /
  // on-demand) — they share `state.thumbSyncStats`, so only one runs at a time.
  let syncChain: Promise<void> = Promise.resolve();

  /** Chain `fn` onto the single orchestrator queue and return its completion.
   *
   * V0.9c admin-plane: the queue scheduler is the single gate for the manual
   * "Pause bridge" action + the quiet-hours window. When effective-paused, a gen
   * pass is SKIPPED (resolves immediately, does no ffmpeg work) rather than
   * deferred — lazy-gen means the next browse / SYNC_PROJECT / daily scan
   * re-enqueues it once the window ends or the operator resumes. Byte-range READ /
   * LIST_DIR / RECURSIVE_SCAN run OUTSIDE this queue, so content viewing keeps
   * working while generation is paused. */
  function runExclusive(label: string, fn: () => Promise<void>): Promise<void> {
    if (effectivePaused(state.runtimeSettings, new Date())) {
      // eslint-disable-next-line no-console
      console.log(`bridge: ${label} skipped — generation paused (manual or quiet-hours)`);
      return Promise.resolve();
    }
    const next = syncChain.then(fn).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(
        `bridge: ${label} failed: ${(err as Error)?.message ?? err}`,
      );
    });
    // Keep the chain alive regardless of this pass's outcome.
    syncChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** V0.9c admin-plane: push current generation activity to the gateway so the
   *  SaaS admin bridges panel can show paused-state + live ffmpeg counts without
   *  round-tripping each bridge. Sent on connect + every settings-poll tick. */
  function sendDaemonHeartbeat(ws: WebSocket): void {
    try {
      ws.send(
        JSON.stringify({
          type: "DAEMON_HEARTBEAT",
          paused: effectivePaused(state.runtimeSettings, new Date()),
          manualPaused: state.runtimeSettings.paused,
          quietHoursActive:
            state.runtimeSettings.paused === false &&
            effectivePaused(state.runtimeSettings, new Date()),
          activeTranscodes: activeTranscodeCount(),
          activeProxies: activeProxyCount(),
        }),
      );
    } catch {
      // socket went away mid-send; the next tick (or reconnect) re-sends.
    }
  }

  function setStatus(s: WssStatus, event: { type: string; detail?: unknown }) {
    state.wssStatus = s;
    state.lastWssEvent = { ...event, at: Date.now() };
    // eslint-disable-next-line no-console
    console.log(`bridge: wss status → ${s} (${event.type})`);
  }

  function resetSyncState() {
    state.syncStatus = "idle";
    state.syncStats = {
      startedAt: null,
      finishedAt: null,
      entriesScanned: 0,
      batchesPushed: 0,
      lastBatchAt: null,
      errorMessage: null,
    };
  }

  function scheduleReconnect() {
    if (stopped) return;
    const base = Math.min(
      BACKOFF_MS_INITIAL * Math.pow(2, state.reconnectAttempts),
      BACKOFF_MS_MAX,
    );
    const jitterRange = base * BACKOFF_JITTER;
    const jitter =
      (((Date.now() >>> 8) % 1000) / 1000) * jitterRange * 2 - jitterRange;
    const delay = Math.max(BACKOFF_MS_INITIAL, Math.floor(base + jitter));
    state.reconnectAttempts += 1;
    setStatus("reconnecting", {
      type: "backoff",
      detail: { delayMs: delay, attempt: state.reconnectAttempts },
    });
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    setStatus("connecting", { type: "connect-start" });

    const ws = new WebSocket(state.config.saasUrl, {
      headers: {
        Authorization: `Bearer ${state.config.bearer}`,
        "X-Content-Bridge-Device-Label": state.config.deviceLabel,
        // V0.8.b: present the stable identity key when we have one (wizard /
        // auto-pair). Omitted for env-bearer bridges → gateway derives
        // `legacy:<label>`, preserving their device_id.
        ...(state.pairing.deviceKey
          ? { "X-Content-Bridge-Device-Key": state.pairing.deviceKey }
          : {}),
      },
      handshakeTimeout: 10_000,
    });
    currentWs = ws;

    ws.on("open", () => {
      setStatus("connected", { type: "open" });
      state.reconnectAttempts = 0;

      // Send HELLO frame
      const hello = {
        type: "HELLO",
        deviceLabel: state.config.deviceLabel,
        devicePlatform: state.config.devicePlatform,
        appVersion: state.config.appVersion,
        plugins: [
          {
            id: "local-fs",
            rootLabel: `Local FS — ${state.config.sourceRoot}`,
            rootPath: state.config.sourceRoot,
          },
        ],
        // V0.8.b: the wizard's chosen content root. The gateway registers it
        // as this device's first source root (INSERT … ON CONFLICT DO NOTHING
        // — idempotent across reconnects; a root the operator later disables
        // stays disabled because re-HELLO never re-arms an existing row).
        // Phase F cutover (planning doc 65): auto-register the operator's content
        // root from env (config.hostContentPath) when the wizard/paired.json didn't
        // supply one — so an env-bearer bridge registers its source root on connect
        // and Browse + the folders panel work with zero CLI. Gateway insert is
        // idempotent (ON CONFLICT DO NOTHING), so re-HELLO across reconnects is safe.
        ...(state.pairing.initialSourceRootHostPath || state.config.hostContentPath
          ? {
              initialSourceRootHostPath:
                state.pairing.initialSourceRootHostPath || state.config.hostContentPath,
            }
          : {}),
      };
      ws.send(JSON.stringify(hello));

      // Start ping loop
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "PING", ts: Date.now() }));
        }
      }, PING_INTERVAL_MS);

      // Start settings poll loop. First poll fires immediately after
      // HELLO_ACK; subsequent every SETTINGS_POLL_INTERVAL_MS. V0.9c: the same
      // tick also emits a DAEMON_HEARTBEAT so the gateway has fresh per-device
      // activity (paused + live ffmpeg counts) for the admin bridges panel
      // without a per-device round-trip.
      if (settingsPollTimer) clearInterval(settingsPollTimer);
      settingsPollTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          state.runtimeSettings.lastAttemptedAt = Date.now();
          ws.send(JSON.stringify({ type: "SETTINGS_REQUEST" }));
          sendDaemonHeartbeat(ws);
        }
      }, SETTINGS_POLL_INTERVAL_MS);
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        // doc 59 Part 2: the only gateway→bridge binary frame is a chunked
        // browser-upload payload — [u32be headerLen][JSON {token,seq}][payload].
        void handleBrowserUploadChunk(ws, raw as Buffer);
        return;
      }
      let msg: {
        type?: string;
        tenantId?: number;
        deviceId?: number;
        ts?: number;
      } | null = null;
      try {
        msg = JSON.parse((raw as Buffer).toString("utf8"));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("bridge: malformed JSON from gateway", err);
        return;
      }
      if (msg?.type === "HELLO_ACK") {
        state.helloAckedAt = Date.now();
        state.bridgeDeviceId =
          typeof msg.deviceId === "number" ? msg.deviceId : null;
        setStatus("connected", {
          type: "hello-ack",
          detail: { deviceId: state.bridgeDeviceId },
        });
        // Pull initial settings + project-enabled list before kicking off
        // the sync so the orchestrator sees overrides on the first run.
        state.runtimeSettings.lastAttemptedAt = Date.now();
        ws.send(JSON.stringify({ type: "SETTINGS_REQUEST" }));
        sendDaemonHeartbeat(ws);
        // Kick off initial sync. Use a fresh abort handle so any in-flight
        // sync from a stale earlier connection stops emitting.
        activeSyncAbort.stopped = true;
        activeSyncAbort = { stopped: false };
        startInitialSync(ws, state, activeSyncAbort);
        return;
      }
      if (msg?.type === "PONG") {
        return;
      }
      // INDEX_BATCH_ACK / INDEX_BATCH_ERR — gateway confirmations for each
      // batch we pushed during initial sync. V0.3 just acknowledges them
      // (no per-batch retry yet); V0.5 may use BATCH_ERR to trigger a
      // resend of the failed batch.
      if (msg?.type === "INDEX_BATCH_ACK") {
        return;
      }
      if (msg?.type === "INDEX_BATCH_ERR") {
        // eslint-disable-next-line no-console
        console.warn("bridge: gateway rejected INDEX_BATCH", msg);
        return;
      }
      if (msg?.type === "SETTINGS_RESPONSE") {
        // Gateway pushes the operator's settings + per-project enabled
        // flags. Live-apply (settings overlay for next sync; enabled set
        // for project filtering).
        const settings = Array.isArray((msg as { settings?: unknown }).settings)
          ? (
              msg as {
                settings: Array<{
                  setting_key: string;
                  setting_value: unknown;
                }>;
              }
            ).settings
          : [];
        applySettingsFromServer(state.runtimeSettings, settings);
        const enabledList = Array.isArray(
          (msg as { enabledProjectRelPaths?: unknown }).enabledProjectRelPaths,
        )
          ? (msg as { enabledProjectRelPaths: string[] }).enabledProjectRelPaths
          : null;
        if (enabledList !== null) {
          const nextEnabled = new Set(enabledList);
          // V0.6.b on-enable trigger: a project flipping false→true runs the
          // orchestrator for just that project (identical to SYNC_PROJECT). We
          // only fire AFTER the baseline is established — the first poll merely
          // populates the set (lazy gen: no boot prewarm).
          //
          // V0.9b prewarm decision (operator, 2026-06-11): LOCKED to
          // enqueue-on-import/browse — this on-enable trigger + the live-picker
          // browse-prewarm ARE the enqueue path; NO queue-all-on-first-setup
          // walk. Thumbnails populate as the user enables projects / browses.
          // V0.9c CONSUMED: the dismissible thumb-gen progress banner now lives on
          // the SaaS /content/overview (ThumbGenBanner + GET /api/content/
          // thumb-progress + lib/thumbGenProgress). It derives progress purely from
          // content_bridge_files (is_media, canonical full/teaser type folders) vs
          // content_bridge_thumbs — no new bridge frame, so this on-enable trigger
          // stays exactly as-is.
          if (state.enabledBaselineEstablished) {
            for (const relPath of nextEnabled) {
              if (!state.enabledProjectRelPaths.has(relPath)) {
                const projectRelPath = relPath;
                void runExclusive(
                  `on-enable ${projectRelPath || "<root>"}`,
                  () =>
                    runProjectSync(
                      ws,
                      state.config,
                      state,
                      projectRelPath,
                      activeSyncAbort,
                    ),
                );
              }
            }
          }
          state.enabledProjectRelPaths = nextEnabled;
          state.enabledBaselineEstablished = true;
        }
        // V0.6: the gateway also delivers the device's source_roots. Resolve
        // each against the narrow bind mounts (fs.stat + W_OK) and report the
        // resolution back so the SaaS UI can show active/needs_mount/writable.
        // Fire-and-forget — resolution is async fs work; the report frame is
        // sent when it completes.
        void resolveAndReportSourceRoots(
          ws,
          state,
          (msg as { sourceRoots?: unknown }).sourceRoots,
        );
        // V0.7.b: project re-detection is now folded into the mtime-diff reindex
        // sweep (runReindexScan) — it fires detectAndPushProjects only when the
        // tree actually changed, instead of an unconditional walk every poll.
        return;
      }
      if (msg?.type === "CREATE_PROJECT") {
        // Gateway relays an operator's "New Project" request. Async scaffold;
        // the result frame is correlated by requestId. See handleCreateProject
        // for the validate → mkdir (add-only) → reply flow.
        void handleCreateProject(ws, state, msg as CreateProjectFrame);
        return;
      }
      if (msg?.type === "UPLOAD_FILE") {
        // V0.7.b: SaaS relays an ephemeral tweet-media file. Stage it under the
        // bridge-owned cache root; reply with a content-root-relative path + a
        // delete token. See handleUploadFile (validate → contain → write 'wx').
        void handleUploadFile(ws, state, msg as UploadFileFrame);
        return;
      }
      if (msg?.type === "DELETE_FILE") {
        // V0.7.b: SaaS asks to remove a staged tweet-media file after the tweet
        // posted. Contained to `<cacheRoot>/_twitterUploads/` only.
        void handleDeleteFile(ws, state, msg as DeleteFileFrame);
        return;
      }
      if (msg?.type === "BROWSER_UPLOAD_START") {
        // doc 59 Part 2: begin/resume a chunked browser upload.
        void handleBrowserUploadStart(
          ws,
          state,
          msg as Parameters<typeof handleBrowserUploadStart>[2],
        );
        return;
      }
      if (msg?.type === "BROWSER_UPLOAD_DONE") {
        // doc 59 Part 2: finalize — verify + publish into _twitterUploads/.
        void handleBrowserUploadDone(
          ws,
          state,
          msg as Parameters<typeof handleBrowserUploadDone>[2],
        );
        return;
      }
      if (msg?.type === "BROWSER_UPLOAD_STATUS") {
        // doc 59 Part 2: resume probe — how many bytes does the bridge already have?
        void handleBrowserUploadStatus(
          ws,
          state,
          msg as Parameters<typeof handleBrowserUploadStatus>[2],
        );
        return;
      }
      if (msg?.type === "BROWSER_UPLOAD_ABORT") {
        // doc 59 Part 2: cancel — drop the partial temp.
        void handleBrowserUploadAbort(
          state,
          msg as Parameters<typeof handleBrowserUploadAbort>[1],
        );
        return;
      }
      if (msg?.type === "TRANSCODE_START") {
        // doc 59 Part 3: shrink an oversize video to a platform's byte cap. The
        // encode runs on the SAME orchestrator queue (runExclusive) as proxy gen
        // so only one ffmpeg runs at a time (CPU-budget gating, decision 7).
        handleTranscodeStart(
          ws,
          state,
          msg as Parameters<typeof handleTranscodeStart>[2],
          (label, fn) => {
            void runExclusive(label, fn);
          },
        );
        return;
      }
      if (msg?.type === "TRANSCODE_STATUS") {
        // doc 59 Part 3: status poll relayed from the SaaS progress bar.
        handleTranscodeStatus(
          ws,
          msg as Parameters<typeof handleTranscodeStatus>[1],
        );
        return;
      }
      if (msg?.type === "TRANSCODE_KILL") {
        // doc 59 Part 3: single-id kill-switch the upload progress bar uses. The
        // broad admin-plane "KILL_TRANSCODES" (kill ALL) arrives as DAEMON_CONTROL
        // below; this id-scoped one stays for the doc-59 upload path.
        handleTranscodeKill(
          ws,
          msg as Parameters<typeof handleTranscodeKill>[1],
        );
        return;
      }
      if (msg?.type === "DAEMON_CONTROL") {
        // V0.9c admin-plane: the SaaS `/admin/bridges` per-bridge action panel
        // (super-admin only, gateway-relayed) drives generation control here.
        //   pause   — stop new gen (runExclusive gate) + abort in-flight ffmpeg
        //   resume  — clear the manual pause
        //   kill_transcodes / kill_proxies — abort the respective ffmpeg children
        // pause/resume ALSO persist via the `daemon_paused` setting on the gateway
        // side, so the state is durable + the next settings sync re-affirms it;
        // setting it here too gives instant effect without waiting for that poll.
        const m = msg as { requestId?: string; action?: string };
        const requestId = typeof m.requestId === "string" ? m.requestId : null;
        const action = typeof m.action === "string" ? m.action : "";
        let killedTranscodes = 0;
        let killedProxies = 0;
        switch (action) {
          case "pause":
            state.runtimeSettings.paused = true;
            // Pause means "stop work now" — abort whatever's already encoding.
            killedTranscodes = killAllTranscodes();
            killedProxies = killAllProxies();
            break;
          case "resume":
            state.runtimeSettings.paused = false;
            break;
          case "kill_transcodes":
            killedTranscodes = killAllTranscodes();
            break;
          case "kill_proxies":
            killedProxies = killAllProxies();
            break;
          default:
            break;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "DAEMON_CONTROL_RESULT",
              requestId,
              ok: action !== "",
              action,
              paused: state.runtimeSettings.paused,
              killedTranscodes,
              killedProxies,
            }),
          );
        }
        return;
      }
      if (msg?.type === "TRANSCODE_CLEANUP") {
        // doc 59 Part 4: a RELEASED transcode's cache file is unlinked here (the
        // SaaS keeps the DB row; only the on-bridge file is removed). The output
        // path is re-derived on the bridge + assertWithinCacheRoot-guarded. Pure
        // fs unlink — runs outside the orchestrator queue (no ffmpeg).
        void handleTranscodeCleanup(
          ws,
          state,
          msg as Parameters<typeof handleTranscodeCleanup>[2],
        );
        return;
      }
      if (msg?.type === "SYNC_PROJECT") {
        // V0.6.b: operator clicked Sync → gateway relays this for one project.
        // V0.7.d: "Sync" now means "make this project current", not just "regen
        // thumbs". So it (1) reindexes the project subtree (FOLDER_INDEX per
        // folder → adds AND deletions reconciled on the gateway, so the SaaS
        // table's file count reflects disk immediately rather than after the ~30s
        // sweep), (2) re-detects projects (new/removed project folders + type
        // folders), THEN (3) runs the thumb/proxy orchestrator (mtime-skip makes
        // a repeat near-free). Thumb gen stays serialized via runExclusive.
        const m = msg as { requestId?: string; projectRelPath?: string };
        const requestId = typeof m.requestId === "string" ? m.requestId : null;
        const projectRelPath =
          typeof m.projectRelPath === "string" ? m.projectRelPath : "";
        void (async () => {
          await reindexProjectSubtree(ws, state, projectRelPath);
          await detectAndPushProjects(ws, state, { force: true });
          await runExclusive(`sync-project ${projectRelPath || "<root>"}`, () =>
            runProjectSync(
              ws,
              state.config,
              state,
              projectRelPath,
              activeSyncAbort,
            ),
          );
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "SYNC_PROJECT_RESULT",
                requestId,
                ok: true,
                thumbsWritten: state.thumbSyncStats.thumbsWritten,
                proxiesWritten: state.thumbSyncStats.proxiesWritten,
                skippedFresh: state.thumbSyncStats.videosSkippedAlreadyThumbed,
              }),
            );
          }
        })();
        return;
      }
      if (msg?.type === "GENERATE_CACHE_THUMB") {
        // doc 59 V0.7-A/C: on-demand thumb by relPath — the picker's 800px image
        // proxy (variant 'picker') or a thumb for a CACHE file the indexer skips
        // (variant 'thumb'). Generated on the shared orchestrator queue; the
        // gateway streams the resulting cache file back via the base=cache READ.
        handleGenerateCacheThumb(
          ws,
          state,
          msg as Parameters<typeof handleGenerateCacheThumb>[2],
          (label, fn) => {
            void runExclusive(label, fn);
          },
        );
        return;
      }
      if (msg?.type === "GENERATE") {
        // V0.6.b on-demand: the V0.6.c /stream path found a missing artifact;
        // the gateway relays GENERATE for one file (by the relPath it resolved
        // from the file_id). Generate just that file, reply with whether it's a
        // servable canonical-typed video. Serialized like the other passes.
        const m = msg as { requestId?: string; relPath?: string };
        const requestId = typeof m.requestId === "string" ? m.requestId : null;
        const relPath = typeof m.relPath === "string" ? m.relPath : "";
        let generated = false;
        void runExclusive(`on-demand ${relPath}`, async () => {
          generated = await generateForFile(ws, state.config, state, relPath);
        }).then(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "GENERATE_RESULT",
                requestId,
                ok: generated,
              }),
            );
          }
        });
        return;
      }
      if (msg?.type === "READ_REQUEST") {
        // V0.6.c: gateway /stream relays a byte-range READ. Serve the 720p proxy
        // (preview, when it exists) or the source bytes — NEVER blocking on a
        // transcode. startRead sends READ_BEGIN / binary READ_RESPONSE / READ_END
        // (or READ_ERROR) and returns a cancel handle we track for READ_CANCEL +
        // ws-close teardown. The byte-range READ runs OUTSIDE the orchestrator
        // queue (it's pure fs reads, no ffmpeg) so a long sync can't stall a
        // preview; the optional background proxy gen IS serialized onto the queue.
        const m = msg as Record<string, unknown>;
        const requestId = typeof m.requestId === "string" ? m.requestId : null;
        const relPath = typeof m.relPath === "string" ? m.relPath : "";
        if (!requestId) return;
        const quality: ReadQuality =
          m.quality === "original" ? "original" : "preview";
        // doc 59 V0.9: storage base for relPath. 'cache' reads browser-uploaded
        // media back as original bytes; default 'source' (legacy). Anything else
        // (future cloud bases) is not handled here yet → treat as 'source'.
        const base: ReadBase = m.base === "cache" ? "cache" : "source";
        const pin =
          m.pin === "proxy" || m.pin === "source"
            ? (m.pin as "proxy" | "source")
            : null;
        const prior = activeReads.get(requestId);
        if (prior) prior.cancel(); // defensive — requestId reuse shouldn't happen
        const handle = startRead(
          ws,
          state,
          {
            requestId,
            relPath,
            base,
            quality,
            requested: m.requested === true,
            start: typeof m.start === "number" ? m.start : null,
            end: typeof m.end === "number" ? m.end : null,
            pin,
            buildProxy: m.buildProxy === true,
            proxyTtlMinutes:
              typeof m.proxyTtlMinutes === "number" &&
              Number.isFinite(m.proxyTtlMinutes)
                ? m.proxyTtlMinutes
                : null,
          },
          (bgRelPath, ttlMinutes) => {
            // eslint-disable-next-line no-console
            console.log(
              `bridge: preview miss — queued background proxy for ${bgRelPath} (serving source meanwhile; runs after any in-flight gen)`,
            );
            // V0.9c admin-plane: this background proxy gen now flows through the
            // pause-aware queue scheduler (runExclusive gates on the manual-pause
            // flag + quiet-hours window; a pause-transition + KILL_PROXIES abort
            // any in-flight proxy child via the generator's kill registry).
            void runExclusive(`bg-proxy ${bgRelPath}`, async () => {
              await generateProxyForFile(
                state.config,
                state,
                bgRelPath,
                ttlMinutes,
              );
            });
          },
          () => {
            activeReads.delete(requestId);
          },
        );
        activeReads.set(requestId, handle);
        return;
      }
      if (msg?.type === "LIST_DIR") {
        // V0.7.a unified picker: gateway relays a live directory-browse request.
        // Resolve immediate children off disk and reply LIST_DIR_RESPONSE
        // correlated by requestId. Pure fs read — runs outside the orchestrator
        // queue like the byte-range READ path. doc 59 V0.9a: base='cache' live-reads
        // the bridge's own cache (e.g. the _twitterUploads browser-upload folder)
        // instead of the indexed source root.
        const m = msg as { requestId?: string; relPath?: string; base?: string };
        const requestId = typeof m.requestId === "string" ? m.requestId : null;
        if (!requestId) return;
        const relPath = typeof m.relPath === "string" ? m.relPath : "";
        const base: "source" | "cache" = m.base === "cache" ? "cache" : "source";
        void handleListDir(ws, state, requestId, relPath, base, (label, fn) => {
          void runExclusive(label, fn);
        });
        return;
      }
      if (msg?.type === "RECURSIVE_SCAN") {
        // V0.9b: gateway relays a one-shot recursive subtree scan. The SaaS
        // project-sync scanners (scanProjectMedia / scanClipsFolder) used to walk
        // a project via N sequential LIST_DIR round-trips; this collapses that to
        // one. Pure fs read (runs outside the orchestrator queue like LIST_DIR).
        // Reply RECURSIVE_SCAN_RESPONSE correlated by requestId. base='cache' is
        // supported for parity (confined to _twitterUploads) but the scanners only
        // use 'source'.
        const m = msg as { requestId?: string; relPath?: string; base?: string };
        const requestId = typeof m.requestId === "string" ? m.requestId : null;
        if (!requestId) return;
        const relPath = typeof m.relPath === "string" ? m.relPath : "";
        const base: "source" | "cache" = m.base === "cache" ? "cache" : "source";
        void handleRecursiveScan(ws, state, requestId, relPath, base);
        return;
      }
      if (msg?.type === "READ_CANCEL") {
        const m = msg as { requestId?: string };
        const requestId = typeof m.requestId === "string" ? m.requestId : null;
        if (requestId) {
          const handle = activeReads.get(requestId);
          if (handle) {
            handle.cancel();
            activeReads.delete(requestId);
          }
        }
        return;
      }
      if (msg?.type === "READ_PAUSE" || msg?.type === "READ_RESUME") {
        // V0.9b flow-control: the gateway's HTTP consumer (next-app → browser)
        // backpressured, so it asks us to pause/resume this read's fs stream.
        // No backpressure rides the shared WSS socket per-message, so these
        // explicit frames bound the gateway's buffering on a slow consumer
        // (e.g. a no-Range full-file pull of a large source). Idempotent + safe
        // for an already-settled read (handle absent → no-op).
        const m = msg as { requestId?: string };
        const requestId = typeof m.requestId === "string" ? m.requestId : null;
        if (requestId) {
          const handle = activeReads.get(requestId);
          if (handle) {
            if (msg.type === "READ_PAUSE") handle.pause();
            else handle.resume();
          }
        }
        return;
      }
      if (msg?.type === "CACHE_STATUS_REQUEST") {
        // V0.7.d: gateway round-trips a cache-visibility request (parked HTTP
        // route awaits the reply). Reply with the tiered byte/count breakdown +
        // the bridge's effective cap + the DAEMON DEFAULTS for every cache knob
        // (config.ts values, env-incorporated) so the SaaS knob UI can show
        // "daemon default" vs an operator override without guessing.
        const m = msg as { requestId?: string };
        const requestId = typeof m.requestId === "string" ? m.requestId : null;
        void handleCacheStatus(state, ws, requestId);
        return;
      }
      if (msg?.type === "CACHE_CLEAR") {
        // V0.7.d: operator clicked "Clear cache" / "Clear proxies only". Bulk
        // evict under the owned cache root (assertWithinCacheRoot guards every
        // unlink). Reply correlated by requestId.
        const m = msg as { requestId?: string; scope?: string };
        const requestId = typeof m.requestId === "string" ? m.requestId : null;
        const scope: "all" | "proxies" = m.scope === "all" ? "all" : "proxies";
        void handleCacheClear(state, ws, requestId, scope);
        return;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `bridge: unknown frame type from gateway in V0.3: "${msg?.type}"`,
      );
    });

    ws.on("close", (code, reason) => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (settingsPollTimer) {
        clearInterval(settingsPollTimer);
        settingsPollTimer = null;
      }
      activeSyncAbort.stopped = true;
      // Tear down any in-flight byte-range READs — their fs streams + the now-
      // dead ws would otherwise dangle until GC.
      for (const handle of activeReads.values()) handle.cancel();
      activeReads.clear();
      state.helloAckedAt = null;
      state.bridgeDeviceId = null;
      resetSyncState();
      const detail = { code, reason: reason ? reason.toString("utf8") : "" };
      // eslint-disable-next-line no-console
      console.log(`bridge: wss closed`, detail);
      if (stopped) {
        setStatus("stopped", { type: "close", detail });
        return;
      }
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.warn("bridge: wss error", err.message);
    });
  }

  /**
   * Once-daily lazy orchestrator scan over all enabled projects. Walks the
   * source root, then runs the mtime-gated gen pipeline — near-instant when
   * nothing changed; catches content dropped-but-never-synced. Skips while the
   * ws is down (gen pushes THUMB frames over it).
   */
  async function runDailyScan(): Promise<void> {
    const ws = currentWs;
    if (
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      state.helloAckedAt === null
    ) {
      return;
    }
    const abort = activeSyncAbort;
    const plugin = new LocalFSPlugin(state.config.sourceRoot);
    const entries: FileEntry[] = [];
    try {
      for await (const entry of plugin.walk()) {
        if (abort.stopped) return;
        entries.push(entry);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("bridge: daily scan walk failed", err);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`bridge: daily orchestrator scan (${entries.length} entries)`);
    await runThumbSync(ws, state.config, state, entries, abort);
  }

  /** One tiered cache-eviction pass. Cache-only (never touches content roots). */
  async function runCacheSweep(): Promise<void> {
    if (state.bridgeDeviceId === null) return; // cache dir namespaced by deviceId
    try {
      await runCacheEviction(
        resolveActiveCacheRoot(state, state.config),
        state.bridgeDeviceId,
        effectiveCacheSettings(state.config, state.runtimeSettings),
      );
      // V0.7.d: stamp the last-sweep time for the cache-visibility panel.
      state.lastCacheSweepAt = Date.now();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("bridge: cache sweep failed", err);
    }
  }

  /**
   * V0.7.b: incremental mtime-diff reindex sweep. Stats every directory's mtime
   * (cheap, metadata-only), and for each dir whose mtime moved since last sweep,
   * reindexes just that folder; for dirs that vanished, marks them + descendants
   * absent. Single-flight (skips if a prior sweep is still running) so it
   * self-throttles on a big tree. The FIRST sweep only establishes the baseline
   * (the connect-time full scan already indexed everything). Folds in project
   * re-detection: when anything changed, re-detect projects (replacing the old
   * unconditional every-poll detection).
   */
  async function runReindexScan(): Promise<void> {
    const ws = currentWs;
    if (!ws || ws.readyState !== WebSocket.OPEN || state.helloAckedAt === null)
      return;
    if (reindexScanRunning) return; // single-flight
    reindexScanRunning = true;
    try {
      const plugin = new LocalFSPlugin(state.config.sourceRoot);
      const seen = new Map<string, number>();
      // The source root itself ('' key) — a file dropped at the top level moves it.
      try {
        const rootStat = await fsp.stat(state.config.sourceRoot);
        seen.set("", Math.floor(rootStat.mtimeMs));
      } catch {
        return; // root unreadable — skip this sweep
      }
      for await (const d of plugin.walkDirsWithMtime()) {
        seen.set(d.relPath, d.mtime);
      }
      // First sweep: baseline only (don't reindex everything — connect scan did).
      if (!state.dirMtimesInitialized) {
        state.dirMtimes = seen;
        state.dirMtimesInitialized = true;
        return;
      }
      const prevMtimes = state.dirMtimes;
      let changed = false;
      for (const [rel, mtime] of seen) {
        if (prevMtimes.get(rel) !== mtime) {
          changed = true;
          void reindexFolder(ws, state, rel);
        }
      }
      for (const rel of prevMtimes.keys()) {
        if (!seen.has(rel)) {
          changed = true;
          sendFolderIndex(ws, rel, [], true); // folder gone → mark absent + descendants
        }
      }
      state.dirMtimes = seen;
      // Folded project re-detection — only when the tree actually changed.
      if (changed) void detectAndPushProjects(ws, state);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("bridge: reindex sweep failed", err);
    } finally {
      reindexScanRunning = false;
    }
  }

  // Start the long-lived timers once. They no-op when prerequisites aren't met
  // (ws down for the daily scan; deviceId unknown for the cache sweep).
  dailyScanTimer = setInterval(() => {
    void runExclusive("daily-scan", runDailyScan);
  }, DAILY_SCAN_INTERVAL_MS);
  cacheSweepTimer = setInterval(() => {
    void runCacheSweep();
  }, CACHE_SWEEP_INTERVAL_MS);
  reindexScanTimer = setInterval(() => {
    void runReindexScan();
  }, REINDEX_SCAN_INTERVAL_MS);

  // Kick off first connect
  connect();

  return {
    stop() {
      stopped = true;
      activeSyncAbort.stopped = true;
      if (pingTimer) clearInterval(pingTimer);
      if (settingsPollTimer) clearInterval(settingsPollTimer);
      if (dailyScanTimer) clearInterval(dailyScanTimer);
      if (cacheSweepTimer) clearInterval(cacheSweepTimer);
      if (reindexScanTimer) clearInterval(reindexScanTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (currentWs && currentWs.readyState !== WebSocket.CLOSED) {
        try {
          currentWs.close(1000, "shutdown");
        } catch {
          // ignore
        }
      }
      setStatus("stopped", { type: "shutdown" });
    },
  };
}

/**
 * Walk the source root via LocalFSPlugin and ship INDEX_BATCH frames in
 * INDEX_BATCH_SIZE-entry chunks, terminated by INDEX_DONE.
 *
 * Runs in parallel with the WSS keep-alive (PING loop). If the connection
 * drops mid-walk, the close handler flips `abort.stopped = true` and the
 * walk loop exits before the next batch send. The next reconnect kicks off
 * a fresh walk.
 *
 * V0.6 will add chokidar-based incremental WATCH_EVENT pushes for
 * post-initial-sync changes. V0.2 ships initial-walk only.
 */
async function startInitialSync(
  ws: WebSocket,
  state: SharedState,
  abort: { stopped: boolean },
): Promise<void> {
  const plugin = new LocalFSPlugin(state.config.sourceRoot);
  state.syncStatus = "walking";
  state.syncStats = {
    startedAt: Date.now(),
    finishedAt: null,
    entriesScanned: 0,
    batchesPushed: 0,
    lastBatchAt: null,
    errorMessage: null,
  };
  state.thumbSyncStatus = "idle";
  state.thumbSyncStats = emptyThumbStats();

  // Project detection runs first — gives the gateway a list of projects so
  // the SaaS UI can render its enable/disable toggles even before the file
  // index push completes. Bridge processes ALL projects on first run; the
  // operator can disable any in the UI and the orchestrator respects the
  // updated `enabledProjectRelPaths` set on next sync.
  await detectAndPushProjects(ws, state, { force: true });

  // eslint-disable-next-line no-console
  console.log(
    `bridge: initial sync starting (root=${state.config.sourceRoot})`,
  );

  let batch: FileEntry[] = [];
  let batchId = 0;

  function sendBatch(): boolean {
    if (batch.length === 0) return true;
    if (ws.readyState !== WebSocket.OPEN) return false;
    batchId += 1;
    try {
      ws.send(
        JSON.stringify({
          type: "INDEX_BATCH",
          batchId: `b${batchId}`,
          // V0.7.a: the indexed tree's HOST path lets the gateway attribute each
          // file to a source_root (root_id) by rel-path prefix. Empty when the
          // operator hasn't set CONTENT_BRIDGE_HOST_CONTENT_PATH (attribution
          // then no-ops — files keep root_id NULL).
          rootHostPath: state.config.hostContentPath,
          entries: batch,
        }),
      );
    } catch (err) {
      state.syncStatus = "error";
      state.syncStats.errorMessage =
        "ws.send failed: " + (err as Error).message;
      return false;
    }
    state.syncStats.batchesPushed = batchId;
    state.syncStats.lastBatchAt = Date.now();
    batch = [];
    return true;
  }

  try {
    for await (const entry of plugin.walk()) {
      if (abort.stopped) {
        // eslint-disable-next-line no-console
        console.log("bridge: initial sync aborted (ws closed mid-walk)");
        return;
      }
      batch.push(entry);
      state.syncStats.entriesScanned += 1;
      if (batch.length >= INDEX_BATCH_SIZE) {
        if (!sendBatch()) return;
      }
    }
    // Flush trailing partial batch
    if (!sendBatch()) return;

    // Mark done
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "INDEX_DONE",
          rootPath: state.config.sourceRoot,
          rootHostPath: state.config.hostContentPath,
          totalBatches: batchId,
          totalEntries: state.syncStats.entriesScanned,
        }),
      );
    }
    state.syncStatus = "done";
    state.syncStats.finishedAt = Date.now();
    // eslint-disable-next-line no-console
    console.log(
      `bridge: initial sync complete (${state.syncStats.entriesScanned} entries in ${batchId} batches)`,
    );

    // V0.6.b: thumb/proxy generation is now LAZY — NO automatic gen after
    // INDEX_DONE. Generation runs only on: project enable false→true, an
    // explicit SYNC_PROJECT frame, an on-demand GENERATE request, and the
    // once-daily timer (all wired above / in the message handler). The bridge
    // connects, ships its index, and idles. mtime-skip makes every trigger
    // near-free when nothing changed.
  } catch (err) {
    state.syncStatus = "error";
    state.syncStats.errorMessage = (err as Error).message;
    // eslint-disable-next-line no-console
    console.error("bridge: initial sync failed", err);
  }
}

/** True if the detected project set differs (added/removed/retyped). */
function projectsChanged(a: DetectedProject[], b: DetectedProject[]): boolean {
  if (a.length !== b.length) return true;
  const key = (p: DetectedProject) =>
    `${p.relPath}|${[...p.typeFolders].sort().join(",")}`;
  const seen = new Set(a.map(key));
  return b.some((p) => !seen.has(key(p)));
}

/**
 * Re-run project detection and push SCAN_PROJECTS when the set changed (or when
 * forced). Lightweight (directory walk only — no file index / thumb sync), so
 * it's safe to call on the 30s poll for fresh-folder pickup, and forced right
 * after a create so a new project shows up immediately.
 */
async function detectAndPushProjects(
  ws: WebSocket,
  state: SharedState,
  opts: { force?: boolean } = {},
): Promise<void> {
  // Only treat the scan as authoritative (so the gateway may PRUNE projects that
  // disappeared) when the source root is actually readable — otherwise a
  // transient fs error returns [] and would wrongly wipe every project.
  try {
    await fsp.access(state.config.sourceRoot, fsConstants.R_OK);
  } catch {
    return;
  }
  try {
    const detected = await detectProjects(state.config.sourceRoot);
    const changed = projectsChanged(state.detectedProjects, detected);
    state.detectedProjects = detected;
    if ((changed || opts.force) && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "SCAN_PROJECTS",
          // Full successful walk → gateway reconciles (adds new + removes gone).
          complete: true,
          projects: detected.map((p) => ({
            relPath: p.relPath,
            displayName: p.displayName,
            typeFolders: p.typeFolders,
          })),
        }),
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("bridge: project detection failed", err);
  }
}

/**
 * Handle a LIST_DIR relay from the gateway (V0.7.a unified picker live browse).
 * Lists the immediate children of `relPath` (relative to the source root) off
 * disk, confined to the realpath'd root. Replies LIST_DIR_RESPONSE { ok, ... }
 * correlated by requestId. Never throws — failures become ok:false with a code.
 */
async function handleListDir(
  ws: WebSocket,
  state: SharedState,
  requestId: string,
  relPath: string,
  base: "source" | "cache" = "source",
  enqueue?: (label: string, fn: () => Promise<void>) => void,
): Promise<void> {
  function reply(payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: "LIST_DIR_RESPONSE", requestId, ...payload }),
      );
    }
  }
  try {
    // doc 59 V0.9a: 'cache' lists the bridge-owned cache root (e.g. the
    // _twitterUploads browser-upload folder), confined to the realpath'd cache
    // root by LocalFSPlugin; 'source' lists the indexed content root.
    if (base === "cache") {
      // Defense in depth: the daemon confines cache browse to the `_twitterUploads`
      // upload folder itself — never the rest of the cache (proxies/transcodes) —
      // independent of the SaaS/gateway guardrail. Reject any traversal segment so
      // `_twitterUploads/../preview` (which LocalFSPlugin would normalize to a
      // sibling cache folder) can't escape the sub-scope.
      const segs = relPath
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .split("/");
      if (
        segs[0] !== "_twitterUploads" ||
        segs.some((s) => s === ".." || s === "." || s === "" || s.includes("\0"))
      ) {
        reply({ ok: false, code: "cache-scope", message: "cache-scope" });
        return;
      }
    }
    const root =
      base === "cache"
        ? resolveActiveCacheRoot(state, state.config)
        : state.config.sourceRoot;
    const plugin = new LocalFSPlugin(root);
    const listing = await plugin.listDirImmediate(relPath);
    reply({
      ok: true,
      relPath: listing.relPath,
      dirs: listing.dirs,
      files: listing.files,
    });
    // V0.7.b reindex-on-browse: the folder we just read live is also refreshed
    // in the index (fire-and-forget) so search reflects it without waiting for
    // the periodic sweep. Never blocks the browse reply. doc 59 V0.7-B: pass the
    // queue so a first-thumb pre-warm rides along. doc 59 V0.9a: cache files are
    // NOT part of the source index — only source browses reindex.
    if (base !== "cache") {
      void reindexFolder(ws, state, relPath, enqueue);
    }
  } catch (err) {
    const code = (err as Error)?.message ?? "list-dir-failed";
    reply({ ok: false, code, message: code });
  }
}

/**
 * Handle a RECURSIVE_SCAN relay from the gateway (V0.9b project-sync collapse).
 * Recursively lists every MEDIA file under `relPath` (relative to the source
 * root) off disk in ONE response — replacing the SaaS project-sync scanners'
 * prior N sequential LIST_DIR round-trips per project. Confined to the realpath'd
 * root by LocalFSPlugin.scanSubtreeImmediate (which never follows symlinks during
 * descent); same cruft skips as the index walk + browse. Replies
 * RECURSIVE_SCAN_RESPONSE { ok, ... } correlated by requestId. Never throws —
 * failures become ok:false with a code.
 */
async function handleRecursiveScan(
  ws: WebSocket,
  state: SharedState,
  requestId: string,
  relPath: string,
  base: "source" | "cache" = "source",
): Promise<void> {
  function reply(payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: "RECURSIVE_SCAN_RESPONSE", requestId, ...payload }),
      );
    }
  }
  try {
    if (base === "cache") {
      // Defense in depth (mirrors handleListDir): the daemon confines a cache
      // scan to the `_twitterUploads` upload folder itself — never proxies /
      // transcodes — independent of the gateway guardrail. Reject any traversal
      // segment so `_twitterUploads/..` can't escape the sub-scope.
      const segs = relPath
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .split("/");
      if (
        segs[0] !== "_twitterUploads" ||
        segs.some((s) => s === ".." || s === "." || s === "" || s.includes("\0"))
      ) {
        reply({ ok: false, code: "cache-scope", message: "cache-scope" });
        return;
      }
    }
    const root =
      base === "cache"
        ? resolveActiveCacheRoot(state, state.config)
        : state.config.sourceRoot;
    const plugin = new LocalFSPlugin(root);
    const listing = await plugin.scanSubtreeImmediate(relPath);
    reply({ ok: true, relPath: listing.relPath, files: listing.files });
    // The old N×LIST_DIR each fired a per-folder reindexFolder side-effect to keep
    // search fresh; preserve that as ONE subtree reindex (source only — cache is
    // not part of the source index). Fire-and-forget: never blocks the scan reply.
    if (base !== "cache") {
      void reindexProjectSubtree(ws, state, relPath);
    }
  } catch (err) {
    const code = (err as Error)?.message ?? "recursive-scan-failed";
    reply({ ok: false, code, message: code });
  }
}

// doc 59 V0.7-B: cap the per-browse first-thumb pre-warm so a huge folder can't
// flood the orchestrator queue. The rest fill in on the normal mtime-skip sweep.
const BROWSE_PREWARM_MAX = 40;
const MEDIA_EXT_RE =
  /\.(mp4|mkv|avi|mov|webm|m4v|wmv|flv|ts|m2ts|png|jpg|jpeg|gif|webp|heic|heif|tiff|tif|bmp)$/i;

function isMediaEntry(e: FileEntry): boolean {
  if (e.isDir) return false;
  if (e.mime && (e.mime.startsWith("image/") || e.mime.startsWith("video/"))) return true;
  return MEDIA_EXT_RE.test(e.relPath);
}

/** V0.7.b: ship a FOLDER_INDEX frame (incremental reindex of one folder). */
function sendFolderIndex(
  ws: WebSocket,
  relPath: string,
  entries: FileEntry[],
  removed = false,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "FOLDER_INDEX", relPath, entries, removed }));
}

/**
 * V0.7.b: incrementally reindex ONE folder — shallow-walk its direct children
 * and ship a FOLDER_INDEX frame. On a readdir failure it does NOT send (so the
 * gateway never marks files absent from a partial listing).
 */
async function reindexFolder(
  ws: WebSocket,
  state: SharedState,
  relPath: string,
  enqueue?: (label: string, fn: () => Promise<void>) => void,
): Promise<void> {
  try {
    const plugin = new LocalFSPlugin(state.config.sourceRoot);
    const entries = await plugin.indexFolderShallow(relPath);
    sendFolderIndex(ws, relPath, entries, false);
    // doc 59 V0.7-B: pre-warm the first (position-0) cache thumb for the just-
    // browsed direct-child media so a freshly-indexed folder shows thumbs within
    // seconds instead of waiting for the periodic sweep. Capped + queued (shares
    // the orchestrator's CPU-budget gating); mtime-skip makes already-thumbed
    // files no-ops. Only the live-browse path passes `enqueue` (the subtree sync
    // generates the full thumb set anyway, so a pre-warm there would be redundant).
    if (enqueue) {
      let queued = 0;
      for (const entry of entries) {
        if (queued >= BROWSE_PREWARM_MAX) break;
        if (!isMediaEntry(entry)) continue;
        queued += 1;
        enqueue(`browse-prewarm ${entry.relPath}`, async () => {
          await generateCacheThumbToDisk(state, "source", entry.relPath, "thumb");
        });
      }
    }
  } catch {
    // readdir failed (gone / unreadable) — skip; the mtime sweep handles removals.
  }
}

/**
 * V0.7.d: reindex an ENTIRE project subtree now (the project folder's direct
 * children + every descendant folder), shipping a FOLDER_INDEX per folder. Each
 * FOLDER_INDEX is reconciled direct-child-wise on the gateway, so this reflects
 * BOTH added and deleted files immediately — instead of waiting up to ~30s for
 * the periodic mtime sweep. Drives the "Sync now refreshes the table counts"
 * behavior. Bridge-boundary guard: reject an unsafe gateway-supplied projectRelPath
 * before it becomes a walk root (same posture as runProjectSync).
 */
async function reindexProjectSubtree(
  ws: WebSocket,
  state: SharedState,
  projectRelPath: string,
): Promise<void> {
  if (isUnsafeRelPath(projectRelPath)) {
    // eslint-disable-next-line no-console
    console.warn(
      `bridge: refusing subtree reindex for unsafe projectRelPath "${projectRelPath}"`,
    );
    return;
  }
  // The project folder's own direct children first…
  await reindexFolder(ws, state, projectRelPath);
  // …then every descendant folder (walkDirsWithMtime yields descendants of the
  // start dir; '' walks the whole root when the mount root IS the project).
  try {
    const plugin = new LocalFSPlugin(state.config.sourceRoot);
    for await (const d of plugin.walkDirsWithMtime(projectRelPath)) {
      await reindexFolder(ws, state, d.relPath);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `bridge: subtree reindex walk failed for "${projectRelPath}"`,
      err,
    );
  }
}

/**
 * V0.7.d: answer a gateway CACHE_STATUS_REQUEST with the tiered cache breakdown
 * (thumbs vs proxies bytes + counts), the effective cap, last sweep time, and
 * the DAEMON DEFAULTS for every cache knob (config.ts values, env-incorporated)
 * keyed by setting_key so the SaaS knob UI can render "daemon default N" beside
 * any operator override. Never throws — replies ok:false on failure so the
 * parked HTTP route resolves.
 */
async function handleCacheStatus(
  state: SharedState,
  ws: WebSocket,
  requestId: string | null,
): Promise<void> {
  function reply(payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "CACHE_STATUS_RESPONSE",
          requestId,
          ...payload,
        }),
      );
    }
  }
  try {
    const config = state.config;
    const effective = effectiveCacheSettings(config, state.runtimeSettings);
    const summary =
      state.bridgeDeviceId !== null
        ? await summarizeCache(
            resolveActiveCacheRoot(state, config),
            state.bridgeDeviceId,
          )
        : {
            thumbsBytes: 0,
            proxiesBytes: 0,
            totalBytes: 0,
            thumbsCount: 0,
            proxiesCount: 0,
          };
    reply({
      ok: true,
      summary,
      capBytes: effective.cacheCapBytes,
      lastSweepAt: state.lastCacheSweepAt,
      // Daemon defaults (config.ts, after env). The gateway/SaaS already knows
      // the operator overrides from appsec.content_bridge_settings; these let the
      // UI distinguish "override" vs "daemon default applies" per knob.
      daemonDefaults: {
        proxy_cache_ttl_minutes: config.proxyCacheTtlMinutes,
        proxy_skip_below_bytes: config.proxySkipBelowBytes,
        proxy_quality_crf: config.proxyQualityCrf,
        cache_cap_bytes: config.cacheCapBytes,
        thumb_cache_ttl_days: config.thumbCacheTtlDays,
        thumb_max_dim_px: config.thumbMaxDimPx,
        thumb_concurrency: config.thumbConcurrency,
        thumb_delay_ms: config.thumbDelayMs,
      },
    });
  } catch (err) {
    reply({
      ok: false,
      reason: (err as Error)?.message ?? "cache-status-failed",
    });
  }
}

/**
 * V0.7.d: operator-initiated cache clear (CACHE_CLEAR frame). Bulk-evicts under
 * the owned cache root via clearCache (assertWithinCacheRoot guards every
 * unlink). Replies CACHE_CLEAR_RESULT correlated by requestId.
 */
async function handleCacheClear(
  state: SharedState,
  ws: WebSocket,
  requestId: string | null,
  scope: "all" | "proxies",
): Promise<void> {
  function reply(payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: "CACHE_CLEAR_RESULT", requestId, ...payload }),
      );
    }
  }
  if (state.bridgeDeviceId === null) {
    reply({ ok: false, reason: "device not yet identified" });
    return;
  }
  try {
    const stats = await clearCache(
      resolveActiveCacheRoot(state, state.config),
      state.bridgeDeviceId,
      scope,
    );
    reply({
      ok: true,
      scope,
      removed: stats.removed,
      freedBytes: stats.freedBytes,
    });
  } catch (err) {
    reply({
      ok: false,
      reason: (err as Error)?.message ?? "cache-clear-failed",
    });
  }
}

interface CreateProjectFrame {
  type: "CREATE_PROJECT";
  requestId?: string;
  rootId?: number;
  destSubPath?: string;
  recordingDate?: string;
  workingTitle?: string;
  /** false = create a plain named folder (no template copy). */
  useTemplate?: boolean;
  /** Optional per-create HOST-path template override; falls back to the
   *  operator's live/env default when omitted. */
  templatePath?: string;
}

/**
 * Resolve the gateway-delivered source roots against the narrow bind mounts
 * and report the resolution back via SOURCE_ROOTS_RESOLVED. Each root mirrors
 * to `/sources/host<host_path>`; `fs.stat` decides active vs needs_mount and
 * `fs.access(W_OK)` sets the writable flag. Never throws.
 */
async function resolveAndReportSourceRoots(
  ws: WebSocket,
  state: SharedState,
  rawSourceRoots: unknown,
): Promise<void> {
  try {
    const inputs = parseSourceRootsFromSettings(rawSourceRoots);
    const resolved = await resolveSourceRoots(inputs);
    state.sourceRoots = resolved;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "SOURCE_ROOTS_RESOLVED",
          roots: resolved.map((r) => ({
            id: r.id,
            status: r.status,
            containerPath: r.containerPath,
            writable: r.writable,
            lastError: r.lastError,
          })),
        }),
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("bridge: source-root resolution failed", err);
  }
}

/**
 * Handle a CREATE_PROJECT relay from the gateway. SECURITY: validate the target
 * is one of THIS bridge's own resolved active + writable roots (look up by
 * rootId; use the bridge's own containerPath, never a gateway-supplied path) —
 * so even a compromised gateway can't make the bridge scaffold into an
 * arbitrary location. Then delegate to the add-only `createProject` (which does
 * its own sanitize + path-guard + rate-limit). Reply correlated by requestId.
 */
async function handleCreateProject(
  ws: WebSocket,
  state: SharedState,
  msg: CreateProjectFrame,
): Promise<void> {
  const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
  function reply(payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "CREATE_PROJECT_RESULT",
          requestId,
          ...payload,
        }),
      );
    }
  }

  const rootId = Number(msg.rootId);
  const root = state.sourceRoots.find((r) => r.id === rootId);
  if (
    !root ||
    root.status !== "active" ||
    !root.writable ||
    !root.containerPath
  ) {
    reply({
      ok: false,
      reason: "target root is not an active, writable root on this bridge",
    });
    return;
  }

  // Resolve the template (when requested): per-create override → live setting →
  // env default. Mirror the HOST path to a container path; the kernel bind
  // boundary means an unmounted/unbound template simply won't resolve.
  const useTemplate = msg.useTemplate !== false;
  let templateContainerPath: string | null = null;
  if (useTemplate) {
    const templateHostPath =
      (typeof msg.templatePath === "string" && msg.templatePath.trim()) ||
      state.runtimeSettings.defaultTemplatePath ||
      state.config.defaultTemplatePath ||
      "";
    if (!templateHostPath) {
      reply({
        ok: false,
        reason:
          "no project template is configured — set a default template on the bridge, or create a plain folder",
      });
      return;
    }
    templateContainerPath = hostPathToContainerPath(templateHostPath);
    if (!templateContainerPath) {
      reply({ ok: false, reason: "configured template path is invalid" });
      return;
    }
  }

  // V0.9b hardening: hand createProject the container paths of all of this
  // bridge's ACTIVE roots so it can confine the template copy-source to one of
  // them (a compromised gateway must not fs.cp from an arbitrary mounted dir).
  const activeRootContainerPaths = state.sourceRoots
    .filter((r) => r.status === "active" && !!r.containerPath)
    .map((r) => r.containerPath as string);

  const result = await createProject({
    rootContainerPath: root.containerPath,
    destSubPath: String(msg.destSubPath ?? ""),
    templateContainerPath,
    activeRootContainerPaths,
    recordingDate: String(msg.recordingDate ?? ""),
    workingTitle: String(msg.workingTitle ?? ""),
  });

  if (result.ok) {
    // eslint-disable-next-line no-console
    console.log(
      `bridge: created project "${result.folderName}" in root ${rootId} (alreadyExisted=${result.alreadyExisted})`,
    );
    reply({
      ok: true,
      folderName: result.folderName,
      relPath: result.relPath,
      alreadyExisted: result.alreadyExisted,
    });
    // Force an immediate re-detect + SCAN_PROJECTS so the new folder shows up
    // in the SaaS projects list right away (not on the next 30s poll).
    void detectAndPushProjects(ws, state, { force: true });
  } else {
    // eslint-disable-next-line no-console
    console.warn(`bridge: create-project rejected: ${result.reason}`);
    reply({
      ok: false,
      reason: result.reason,
      rateLimited: result.rateLimited === true,
    });
  }
}
