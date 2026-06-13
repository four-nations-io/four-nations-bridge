// Byte-range READ over WSS — Phase F V0.6.c.
//
// The browser preview path (BridgePageClient.togglePreview) used to bypass the
// bridge by hitting next-app's `/api/media/<rel_path>` proxy — which only worked
// because next-app shared the operator's bind mount. V0.6.c replaces that with
// READ-over-WSS so a creator whose bridge runs on their own machine can stream
// their content through the gateway (arch-note 14 §9 read flow).
//
// Frames (this module SENDS bridge→gateway; wss-client.ts receives the requests):
//   READ_REQUEST  (gateway→bridge, JSON)   { requestId, relPath, quality, start, end, requested, pin }
//   READ_BEGIN    (bridge→gateway, JSON)   { requestId, ok:true, totalSize, contentType, served, partial, start, end }
//   READ_RESPONSE (bridge→gateway, BINARY) [u32be headerLen][JSON {r,s}][payload]
//   READ_END      (bridge→gateway, JSON)   { requestId }
//   READ_ERROR    (bridge→gateway, JSON)   { requestId, ok:false, code, reason, totalSize? }
//   READ_CANCEL   (gateway→bridge, JSON)   { requestId }  → cancelRead()
//
// SECURITY (arch-note 14 §3): the gateway is treated as potentially compromised.
// `relPath` is re-validated with `isUnsafeRelPath` before it becomes a filesystem
// path, exactly like the GENERATE / SYNC_PROJECT write paths. The READ root is
// always `path.join(config.sourceRoot, relPath)` (source bytes) or the cache
// `preview.mp4` for the resolved key — never a gateway-supplied absolute path.

import { createReadStream, promises as fsp } from 'node:fs';
import type { ReadStream } from 'node:fs';
import * as path from 'node:path';
import type WebSocket from 'ws';
import {
  resolveActiveCacheRoot,
  type ThumbOrchestratorState,
} from '../thumb/orchestrator';
import {
  resolveCacheFileDir,
  cacheProxyPath,
  isUnsafeRelPath,
} from '../thumb/paths';
import { touchCacheArtifact } from '../thumb/cache-manager';
import { effectiveCacheSettings } from '../settings/runtime';

export type ReadQuality = 'preview' | 'original';

// doc 59 V0.9: source-agnostic READ base. The bridge:// scheme names which
// storage base a relPath is rooted at; the gateway passes it through on
// READ_REQUEST. V1 supports:
//   'source' — the indexed content root (config.sourceRoot) — default + legacy.
//   'cache'  — the bridge-owned cache root (browser-uploaded media staged under
//              _twitterUploads/, read back at post time). Always served as
//              original bytes (no preview-proxy logic).
// V2 cloud bases (gdrive:/dropbox:) are not handled here yet.
export type ReadBase = 'source' | 'cache';

/** Pause the fs read while the ws send buffer exceeds this, resume under LOW.
 *  Bounds bridge memory when the consumer (gateway → next-app → browser) is
 *  slower than disk. Byte-range requests are already bounded, so this only
 *  bites on a no-Range full-file pull. */
const WS_HIGH_WATER = 4 * 1024 * 1024;
const WS_LOW_WATER = 1 * 1024 * 1024;

/** Extension → MIME for the source-bytes path. Mirrors next-app's /api/media
 *  MIME_MAP + BridgePageClient.mimeForFilename so the served Content-Type
 *  matches what the browser would otherwise have inferred. */
const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

export function mimeFromExt(relPath: string): string {
  const ext = relPath.toLowerCase().split('.').pop() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function isVideoMime(mime: string): boolean {
  return mime.startsWith('video/');
}

export interface ReadRequest {
  requestId: string;
  relPath: string;
  /** doc 59 V0.9 storage base for relPath. Default 'source' (legacy behavior). */
  base: ReadBase;
  quality: ReadQuality;
  /** Raw range bounds (null = open end / unspecified). `requested` false = no
   *  Range header → serve the whole file (200). */
  requested: boolean;
  start: number | null;
  end: number | null;
  /** Gateway-side stickiness hint (preview only): if 'source', the gateway has
   *  already committed this session to source bytes — don't flip to a proxy that
   *  landed mid-session (different size would break the player). */
  pin: 'proxy' | 'source' | null;
  /** Gateway-side build-on-2nd-access gate: only build a background proxy when
   *  the file has earned it (opened in ≥ N distinct sessions). False on a first
   *  open / spot-check so we never transcode something that's never reopened. */
  buildProxy: boolean;
  /** V0.7.d frequency-adaptive TTL: the gateway derives a per-proxy TTL (minutes)
   *  from this file's access density and passes it here, so a spread-out-but-
   *  recurring file's proxy survives between sessions. null → flat TTL. Only
   *  meaningful when `buildProxy` is true. */
  proxyTtlMinutes: number | null;
}

interface ResolvedTarget {
  absPath: string;
  totalSize: number;
  mtimeMs: number;
  contentType: string;
  served: 'proxy' | 'source';
  /** preview + eligible-but-missing proxy → caller kicks a background gen so a
   *  later open gets the proxy (we never block the preview on a transcode). */
  triggerBackgroundProxy: boolean;
}

type Resolution =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; code: 'not-found' | 'unsafe' | 'read-error'; reason: string };

/**
 * Decide which bytes back a READ: the 720p proxy (preview, when it exists +
 * fresh) or the source file. NEVER blocks on a transcode — for a preview of an
 * eligible-but-unproxied source it returns the source + flags a background gen.
 */
async function resolveTarget(
  state: ThumbOrchestratorState,
  req: ReadRequest
): Promise<Resolution> {
  const config = state.config;
  if (isUnsafeRelPath(req.relPath)) {
    return { ok: false, code: 'unsafe', reason: 'relPath escapes source root' };
  }

  // doc 59 V0.9 — 'cache' base: read browser-uploaded media (staged under the
  // bridge-owned cache root) back as original bytes. No preview-proxy logic; the
  // cache root is realpath-confined the same way the upload write path is.
  if (req.base === 'cache') {
    const cacheRoot = resolveActiveCacheRoot(state, config);
    const cacheAbs = path.join(cacheRoot, req.relPath);
    let realCacheRoot: string;
    let realTarget: string;
    try {
      realCacheRoot = await fsp.realpath(cacheRoot);
      realTarget = await fsp.realpath(cacheAbs);
    } catch {
      return { ok: false, code: 'not-found', reason: 'cache file not found' };
    }
    // Containment: the resolved target must stay inside the cache root (defends
    // against symlink escapes that the lexical isUnsafeRelPath check can't catch).
    if (realTarget !== realCacheRoot && !realTarget.startsWith(realCacheRoot + path.sep)) {
      return { ok: false, code: 'unsafe', reason: 'cache path escapes cache root' };
    }
    let cacheStat: import('node:fs').Stats;
    try {
      cacheStat = await fsp.stat(realTarget);
    } catch {
      return { ok: false, code: 'not-found', reason: 'cache file not found' };
    }
    if (!cacheStat.isFile()) {
      return { ok: false, code: 'not-found', reason: 'not a file' };
    }
    return {
      ok: true,
      target: {
        absPath: realTarget,
        totalSize: cacheStat.size,
        mtimeMs: cacheStat.mtimeMs,
        contentType: mimeFromExt(req.relPath),
        served: 'source',
        triggerBackgroundProxy: false,
      },
    };
  }

  const sourceAbs = path.join(config.sourceRoot, req.relPath);
  let sourceStat: import('node:fs').Stats;
  try {
    sourceStat = await fsp.stat(sourceAbs);
  } catch {
    return { ok: false, code: 'not-found', reason: 'source file not found' };
  }
  if (!sourceStat.isFile()) {
    return { ok: false, code: 'not-found', reason: 'not a file' };
  }

  const sourceMime = mimeFromExt(req.relPath);
  const serveSource = (triggerBackgroundProxy: boolean): Resolution => ({
    ok: true,
    target: {
      absPath: sourceAbs,
      totalSize: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
      contentType: sourceMime,
      served: 'source',
      triggerBackgroundProxy,
    },
  });

  // original → always source bytes. preview pinned to source → honor the pin
  // (the gateway already committed this session to source; a proxy that lands
  // mid-session has a different size and would break the player).
  if (req.quality === 'original' || req.pin === 'source') {
    return serveSource(false);
  }

  // preview: serve the proxy if it exists AND is at least as new as the source
  // (a re-exported source makes a stale proxy — fall back to source + regen).
  const cacheRoot = resolveActiveCacheRoot(state, config);
  const proxyAbs = cacheProxyPath(
    resolveCacheFileDir(cacheRoot, state.bridgeDeviceId ?? 'device', req.relPath)
  );
  try {
    const proxyStat = await fsp.stat(proxyAbs);
    if (proxyStat.isFile() && proxyStat.mtimeMs >= sourceStat.mtimeMs) {
      // Bump the proxy's last-access so the tiered cache manager keeps it alive
      // while it's being actively scrubbed (arch-note 14 §4 — proxies are a
      // session cache; every byte-range read touches them, idle ones expire).
      // Fire-and-forget; a touch failure just lets it age from its last write.
      void touchCacheArtifact(proxyAbs);
      return {
        ok: true,
        target: {
          absPath: proxyAbs,
          totalSize: proxyStat.size,
          mtimeMs: proxyStat.mtimeMs,
          contentType: 'video/mp4',
          served: 'proxy',
          triggerBackgroundProxy: false,
        },
      };
    }
  } catch {
    // no proxy yet — fall through to source + maybe background gen
  }

  // No (fresh) proxy. Serve source now. Kick a background gen only when the
  // gateway says this file has EARNED a proxy (build-on-2nd-access) AND the
  // source would qualify: a video at/over the skip threshold. generateProxyForFile
  // re-probes dimensions and skips ≤720p sources, so an already-small / low-res
  // file never gets one (and the served-source decision is therefore permanent —
  // no mid-session flip risk for those). Without `buildProxy`, a first open /
  // spot-check just streams source and transcodes nothing.
  const { proxySkipBelowBytes } = effectiveCacheSettings(
    config,
    state.runtimeSettings
  );
  const eligible =
    req.buildProxy && isVideoMime(sourceMime) && sourceStat.size >= proxySkipBelowBytes;
  return serveSource(eligible);
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState !== 1 /* OPEN */) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // socket went away mid-send — the close handler cancels in-flight reads.
  }
}

/** READ_RESPONSE binary frame: [u32be headerLen][JSON {r,s}][payload]. */
function sendChunk(
  ws: WebSocket,
  requestId: string,
  seq: number,
  payload: Buffer
): void {
  if (ws.readyState !== 1 /* OPEN */) return;
  const header = Buffer.from(JSON.stringify({ r: requestId, s: seq }), 'utf8');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(header.length, 0);
  try {
    ws.send(Buffer.concat([prefix, header, payload]), { binary: true });
  } catch {
    // best-effort; cancellation/close cleans up the stream
  }
}

export interface ActiveRead {
  cancel(): void;
  /** Gateway flow-control (V0.9b). The gateway PAUSEs this read when its own
   *  HTTP consumer (gateway → next-app → browser) backpressures — that
   *  backpressure can't ride the shared WSS socket per-message, so the gateway
   *  signals it with READ_PAUSE / READ_RESUME control frames. Composes with the
   *  local ws.bufferedAmount throttle: the fs read resumes only when the gateway
   *  has un-paused AND our send buffer has drained below the low-water mark. */
  pause(): void;
  resume(): void;
}

/**
 * Resolve the target, send READ_BEGIN (or READ_ERROR), then stream the requested
 * byte range as binary READ_RESPONSE frames terminated by READ_END. Returns an
 * ActiveRead handle so the caller can cancel on READ_CANCEL / ws close.
 *
 * `onBackgroundProxy` is invoked (fire-and-forget by the caller, serialized
 * through the orchestrator queue) when a preview fell back to source bytes for
 * an eligible-but-unproxied video — so a later open gets the proxy. The TTL hint
 * (V0.7.d frequency-adaptive) is passed through so the build can persist it.
 */
export function startRead(
  ws: WebSocket,
  state: ThumbOrchestratorState,
  req: ReadRequest,
  onBackgroundProxy: (relPath: string, proxyTtlMinutes: number | null) => void,
  onSettled: () => void
): ActiveRead {
  let cancelled = false;
  let settled = false;
  let stream: ReadStream | null = null;
  // Flow-control state (V0.9b). `pausedByGateway` is set by the gateway's
  // READ_PAUSE control frame (its HTTP consumer is backpressured); cleared by
  // READ_RESUME. `resumePending` guards against stacking duplicate resume polls
  // for the local ws.bufferedAmount drain.
  let pausedByGateway = false;
  let resumePending = false;
  // Fire onSettled exactly once on any terminal outcome (error / end / cancel)
  // so the caller can drop this read from its in-flight map (no leak on a
  // long-lived connection).
  const settle = (): void => {
    if (settled) return;
    settled = true;
    onSettled();
  };
  // Single resume authority shared by the gateway READ_RESUME path and the local
  // bufferedAmount throttle. Resumes ONLY when the gateway has un-paused AND our
  // own send buffer has drained — otherwise re-polls (once) until both hold.
  const tryResume = (): void => {
    if (cancelled || !stream) return;
    if (pausedByGateway) return; // gateway still wants us paused
    if (ws.bufferedAmount > WS_LOW_WATER) {
      if (!resumePending) {
        resumePending = true;
        setTimeout(() => {
          resumePending = false;
          tryResume();
        }, 50);
      }
      return;
    }
    stream.resume();
  };
  const handle: ActiveRead = {
    cancel() {
      cancelled = true;
      if (stream) stream.destroy();
      settle();
    },
    pause() {
      pausedByGateway = true;
      if (stream) stream.pause();
    },
    resume() {
      pausedByGateway = false;
      tryResume();
    },
  };

  void (async () => {
    const resolution = await resolveTarget(state, req);
    if (cancelled) return;
    if (!resolution.ok) {
      sendJson(ws, {
        type: 'READ_ERROR',
        requestId: req.requestId,
        ok: false,
        code: resolution.code,
        reason: resolution.reason,
      });
      settle();
      return;
    }
    const target = resolution.target;
    const total = target.totalSize;

    // Resolve the byte range against the served file's size (mirrors
    // next-app/api/media). Suffix (`bytes=-N`) + open-ended (`bytes=N-`) handled.
    let start: number;
    let end: number;
    let partial: boolean;
    if (!req.requested) {
      start = 0;
      end = total > 0 ? total - 1 : 0;
      partial = false;
    } else {
      let s = req.start;
      let e = req.end;
      if (s === null && e !== null) {
        // suffix range: last `e` bytes
        s = Math.max(total - e, 0);
        e = total - 1;
      } else if (s !== null && e === null) {
        e = total - 1;
      }
      if (
        s === null ||
        e === null ||
        !Number.isFinite(s) ||
        !Number.isFinite(e) ||
        s < 0 ||
        total === 0 ||
        e >= total ||
        s > e
      ) {
        sendJson(ws, {
          type: 'READ_ERROR',
          requestId: req.requestId,
          ok: false,
          code: 'range',
          reason: 'unsatisfiable range',
          totalSize: total,
        });
        settle();
        return;
      }
      start = s;
      end = e;
      partial = true;
    }

    // Fire the background proxy gen now (before streaming) so it starts while
    // the source streams. Only for the eligible-but-unproxied preview case.
    // Pass the gateway's frequency-adaptive TTL hint through to the build.
    if (target.triggerBackgroundProxy) {
      onBackgroundProxy(req.relPath, req.proxyTtlMinutes);
    }

    sendJson(ws, {
      type: 'READ_BEGIN',
      requestId: req.requestId,
      ok: true,
      totalSize: total,
      contentType: target.contentType,
      served: target.served,
      partial,
      start,
      end,
    });
    if (cancelled) return;

    // Empty file or zero-length range → no body, end immediately.
    if (total === 0) {
      sendJson(ws, { type: 'READ_END', requestId: req.requestId });
      settle();
      return;
    }

    stream = createReadStream(target.absPath, { start, end });
    let seq = 0;
    stream.on('data', (chunk: string | Buffer) => {
      if (cancelled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sendChunk(ws, req.requestId, seq++, buf);
      // Local backpressure: pause while our ws send buffer is high. tryResume
      // (shared with the gateway READ_RESUME path) un-pauses once it drains.
      if (stream && ws.bufferedAmount > WS_HIGH_WATER) {
        stream.pause();
        if (!resumePending) {
          resumePending = true;
          setTimeout(() => {
            resumePending = false;
            tryResume();
          }, 50);
        }
      }
    });
    // Honor a gateway PAUSE that landed before the stream was opened (rare — the
    // gateway only backpressures after bytes flow — but keeps the contract tight).
    if (pausedByGateway) stream.pause();
    stream.on('error', (err: Error) => {
      if (!cancelled) {
        sendJson(ws, {
          type: 'READ_ERROR',
          requestId: req.requestId,
          ok: false,
          code: 'read-error',
          reason: err.message,
        });
      }
      settle();
    });
    // 'end' fires only on a fully-consumed range — not on destroy (cancel) or
    // 'error' — so READ_END can't double up with READ_ERROR or a cancel.
    stream.on('end', () => {
      if (!cancelled) sendJson(ws, { type: 'READ_END', requestId: req.requestId });
      settle();
    });
  })();

  return handle;
}
