// doc 59 Part 3 — bridge-side upload-transcode pipeline.
//
// Sibling of the thumb/preview-proxy pipeline (thumb/orchestrator.ts). The SaaS
// asks the bridge to shrink an oversize-but-under-hard_cap video DOWN to a
// platform's byte cap (resolution preserved — only bitrate comes down) so the
// creator never has to re-export. ffmpeg already lives here for proxies; this
// reuses the SAME spawn helper (generator.spawnEncode via transcodeToTarget),
// the SAME CPU-budget gating (renice + the single orchestrator queue), and the
// SAME kill hook (doc 59 decision 7 — two pipelines, one safety mechanism).
//
// Frames (gateway↔bridge):
//   TRANSCODE_START   (gateway→bridge) { requestId, transcodeId, sourceBridgeRef, base, relPath, platform, targetBytes }
//     → validate + register a 'queued' job, reply START_RESULT { ok, status }, then
//       run the encode on the shared orchestrator queue.
//   TRANSCODE_PROGRESS(bridge→gateway) { transcodeId, percent, etaSeconds }   (periodic push)
//   TRANSCODE_DONE    (bridge→gateway) { transcodeId, bridgeCachePath, outputBytes, ffmpegArgs }
//   TRANSCODE_FAILED  (bridge→gateway) { transcodeId, error }
//   TRANSCODE_STATUS  (gateway→bridge) { requestId, transcodeId }
//     → reply TRANSCODE_STATUS_RESULT { ok, status, percent, etaSeconds, bridgeCachePath, outputBytes, ffmpegArgs, error }
//   TRANSCODE_KILL    (gateway→bridge) { requestId, transcodeId }  (super-admin kill-switch)
//     → kill the in-flight ffmpeg child (or cancel a still-queued job), reply KILL_RESULT.
//
// SECURITY (arch-note 14 §3): the gateway is treated as untrusted. `relPath` is
// re-validated with `isUnsafeRelPath`, the cache base is realpath-confined, and
// the OUTPUT path is derived ON THE BRIDGE from the cache-key tuple (never a
// gateway-supplied path) and run through `assertWithinCacheRoot` before any write.

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type WebSocket from 'ws';
import type { ChildProcess } from 'node:child_process';
import type { SharedState } from '../wss-client';
import { ThumbnailGenerator } from '../thumb/generator';
import {
  resolveActiveCacheRoot,
  type ThumbOrchestratorState,
} from '../thumb/orchestrator';
import {
  isUnsafeRelPath,
  transcodeCacheKey,
  resolveTranscodeOutputDir,
  cacheTranscodeOutputPath,
  cacheTranscodePosterPath,
  resolveCacheFileDir,
  cacheThumbPath,
  cachePickerPath,
  assertWithinCacheRoot,
} from '../thumb/paths';
import { effectiveThumbSettings } from '../settings/runtime';

const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH ?? 'ffprobe';

export type TranscodeStatus = 'queued' | 'transcoding' | 'ready' | 'failed';

interface TranscodeJob {
  id: string;
  status: TranscodeStatus;
  percent: number;
  etaSeconds: number | null;
  /** cacheRoot-relative output path (the bridge:// cache relPath for readback). */
  bridgeCachePath: string | null;
  outputBytes: number | null;
  ffmpegArgs: string | null;
  error: string | null;
  /** Live ffmpeg child (set while transcoding) — killTranscode terminates it. */
  child: ChildProcess | null;
  /** Set true by a kill before/while running so the job bails. */
  cancelled: boolean;
}

interface StartFrame {
  type: 'TRANSCODE_START';
  requestId?: string;
  transcodeId?: string;
  sourceBridgeRef?: string;
  base?: string;
  relPath?: string;
  platform?: string;
  targetBytes?: number;
}
interface StatusFrame {
  type: 'TRANSCODE_STATUS';
  requestId?: string;
  transcodeId?: string;
}
interface KillFrame {
  type: 'TRANSCODE_KILL';
  requestId?: string;
  transcodeId?: string;
}
interface CleanupFrame {
  type: 'TRANSCODE_CLEANUP';
  requestId?: string;
  transcodeId?: string;
  bridgeCachePath?: string;
}

// transcodeId → job. Lives for the process lifetime (a handful of entries; the
// SaaS DB is the durable record). A reconnect doesn't clear it, so an in-flight
// transcode survives a gateway blip and its status is still queryable.
const jobs = new Map<string, TranscodeJob>();

const TRANSCODE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // socket went away; the SaaS re-polls TRANSCODE_STATUS on reconnect.
    }
  }
}

/** Resolve a bridge:// (base, relPath) to a real, confined absolute source path. */
async function resolveSourcePath(
  state: SharedState,
  base: string,
  relPath: string
): Promise<{ ok: true; absPath: string } | { ok: false; reason: string }> {
  if (isUnsafeRelPath(relPath)) {
    return { ok: false, reason: 'relPath escapes root' };
  }
  if (base === 'cache') {
    const cacheRoot = resolveActiveCacheRoot(state as ThumbOrchestratorState, state.config);
    const cacheAbs = path.join(cacheRoot, relPath);
    try {
      const realCacheRoot = await fsp.realpath(cacheRoot);
      const realTarget = await fsp.realpath(cacheAbs);
      if (realTarget !== realCacheRoot && !realTarget.startsWith(realCacheRoot + path.sep)) {
        return { ok: false, reason: 'cache path escapes cache root' };
      }
      const st = await fsp.stat(realTarget);
      if (!st.isFile()) return { ok: false, reason: 'not a file' };
      return { ok: true, absPath: realTarget };
    } catch {
      return { ok: false, reason: 'cache file not found' };
    }
  }
  if (base === 'source') {
    const absPath = path.join(state.config.sourceRoot, relPath);
    try {
      const st = await fsp.stat(absPath);
      if (!st.isFile()) return { ok: false, reason: 'not a file' };
      return { ok: true, absPath };
    } catch {
      return { ok: false, reason: 'source file not found' };
    }
  }
  return { ok: false, reason: `unsupported base "${base}"` };
}

function buildGenerator(state: SharedState): ThumbnailGenerator {
  const effective = effectiveThumbSettings(state.config, state.runtimeSettings);
  return new ThumbnailGenerator({
    ffmpegPath: FFMPEG_PATH,
    ffprobePath: FFPROBE_PATH,
    maxDimPx: effective.maxDimPx,
    jpegQuality: effective.jpegQuality,
    cpuNice: effective.cpuNice,
    proxyThreads: state.config.proxyThreads,
  });
}

/**
 * Validate + register a TRANSCODE_START, ack it, then enqueue the encode onto the
 * shared orchestrator queue (so a transcode and a proxy gen never run two ffmpegs
 * at once — the CPU-budget guarantee). `enqueue` is wss-client's `runExclusive`.
 */
export function handleTranscodeStart(
  ws: WebSocket,
  state: SharedState,
  msg: StartFrame,
  enqueue: (label: string, fn: () => Promise<void>) => void
): void {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const transcodeId = String(msg.transcodeId ?? '');
  const reply = (payload: Record<string, unknown>): void =>
    sendJson(ws, { type: 'TRANSCODE_START_RESULT', requestId, transcodeId, ...payload });

  if (!TRANSCODE_ID_RE.test(transcodeId)) {
    return reply({ ok: false, reason: 'bad transcodeId' });
  }
  const base = String(msg.base ?? '');
  const relPath = String(msg.relPath ?? '');
  const sourceBridgeRef = String(msg.sourceBridgeRef ?? '');
  const platform = String(msg.platform ?? '');
  const targetBytes = Number(msg.targetBytes);
  if (!sourceBridgeRef || !platform) {
    return reply({ ok: false, reason: 'sourceBridgeRef + platform required' });
  }
  if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
    return reply({ ok: false, reason: 'bad targetBytes' });
  }

  // Idempotent: a re-sent START for a job already known just re-acks its state
  // (the SaaS retries on a dropped ack). Don't kick a second encode.
  const existing = jobs.get(transcodeId);
  if (existing && existing.status !== 'failed') {
    return reply({ ok: true, status: existing.status });
  }

  const job: TranscodeJob = {
    id: transcodeId,
    status: 'queued',
    percent: 0,
    etaSeconds: null,
    bridgeCachePath: null,
    outputBytes: null,
    ffmpegArgs: null,
    error: null,
    child: null,
    cancelled: false,
  };
  jobs.set(transcodeId, job);
  reply({ ok: true, status: 'queued' });

  enqueue(`transcode ${transcodeId}`, () =>
    runTranscode(ws, state, job, { sourceBridgeRef, base, relPath, platform, targetBytes })
  );
}

async function runTranscode(
  ws: WebSocket,
  state: SharedState,
  job: TranscodeJob,
  input: {
    sourceBridgeRef: string;
    base: string;
    relPath: string;
    platform: string;
    targetBytes: number;
  }
): Promise<void> {
  const fail = (error: string): void => {
    job.status = 'failed';
    job.error = error;
    job.child = null;
    sendJson(ws, { type: 'TRANSCODE_FAILED', transcodeId: job.id, error });
  };

  if (job.cancelled) return fail('cancelled');

  const resolved = await resolveSourcePath(state, input.base, input.relPath);
  if (!resolved.ok) return fail(`source unresolved: ${resolved.reason}`);

  const cacheRoot = resolveActiveCacheRoot(state as ThumbOrchestratorState, state.config);
  const deviceId = typeof state.bridgeDeviceId === 'number' ? state.bridgeDeviceId : 'device';
  const key = transcodeCacheKey(input.sourceBridgeRef, input.platform, input.targetBytes);
  const outDir = resolveTranscodeOutputDir(cacheRoot, deviceId, key);
  const outPath = cacheTranscodeOutputPath(outDir);
  const posterPath = cacheTranscodePosterPath(outDir);
  // cacheRoot-relative readback path (the bridge:// cache relPath).
  const bridgeCachePath = path.posix.join(String(deviceId), 'upload', key, 'output.mp4');

  // Write-path guards (untrusted-gateway posture) BEFORE any fs op.
  try {
    assertWithinCacheRoot(outPath, cacheRoot);
    assertWithinCacheRoot(posterPath, cacheRoot);
  } catch (err) {
    return fail(`unsafe output path: ${(err as Error).message}`);
  }

  const generator = buildGenerator(state);

  // Probe duration (needed to derive the bitrate + the progress %). Also a cheap
  // "is this really a decodable video" gate.
  const info = await generator.probeVideoInfo(resolved.absPath);
  if (!info || info.durationSec <= 0) {
    return fail('could not probe source video');
  }

  // Bridge-side cache hit: a fresh output already exists (output newer than the
  // source). Skip the re-encode and report ready immediately. mtime-fresh mirrors
  // the proxy pipeline's isFresh rule.
  try {
    const [srcStat, outStat] = await Promise.all([
      fsp.stat(resolved.absPath),
      fsp.stat(outPath),
    ]);
    if (outStat.isFile() && outStat.mtimeMs >= srcStat.mtimeMs && outStat.size > 0) {
      job.status = 'ready';
      job.percent = 100;
      job.etaSeconds = 0;
      job.bridgeCachePath = bridgeCachePath;
      job.outputBytes = outStat.size;
      job.ffmpegArgs = 'cache-hit (bridge)';
      sendJson(ws, {
        type: 'TRANSCODE_DONE',
        transcodeId: job.id,
        bridgeCachePath,
        outputBytes: outStat.size,
        ffmpegArgs: job.ffmpegArgs,
      });
      return;
    }
  } catch {
    // no existing output — fall through to encode
  }

  if (job.cancelled) return fail('cancelled');

  try {
    await fsp.mkdir(outDir, { recursive: true });
  } catch (err) {
    return fail(`cannot create output dir: ${(err as Error).message}`);
  }

  job.status = 'transcoding';
  let lastPushedPercent = -1;

  const result = await generator.transcodeToTarget(resolved.absPath, outPath, {
    targetBytes: input.targetBytes,
    durationSec: info.durationSec,
    onSpawn: (proc) => {
      job.child = proc;
      // A kill that landed between 'queued' and spawn: terminate immediately.
      if (job.cancelled) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    },
    onProgress: (percent, etaSec) => {
      job.percent = percent;
      job.etaSeconds = etaSec;
      // Only push a frame when the integer percent advances (avoid frame spam).
      if (percent !== lastPushedPercent) {
        lastPushedPercent = percent;
        sendJson(ws, {
          type: 'TRANSCODE_PROGRESS',
          transcodeId: job.id,
          percent,
          etaSeconds: etaSec,
        });
      }
    },
  });
  job.child = null;

  if (job.cancelled) {
    void fsp.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    return fail('cancelled');
  }
  if (!result.ok) {
    return fail('ffmpeg transcode failed');
  }
  // Reliability check: the output MUST be under the target band (the cache-hit +
  // platform-accept logic both assume it). A rare single-pass overshoot fails the
  // job (the SaaS falls back to a re-export prompt) rather than shipping an
  // over-cap file that Twitter would reject anyway.
  if (result.outputBytes != null && result.outputBytes > input.targetBytes) {
    void fsp.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    return fail(
      `transcode overshot target (${result.outputBytes} > ${input.targetBytes} bytes)`
    );
  }

  // Free poster frame (cluster item 3 hybrid): the decode already happened, so a
  // mid-point still is near-free. Best-effort — never fails the transcode.
  await generator.writePosterFrame(resolved.absPath, info.durationSec, posterPath).catch(() => false);

  job.status = 'ready';
  job.percent = 100;
  job.etaSeconds = 0;
  job.bridgeCachePath = bridgeCachePath;
  job.outputBytes = result.outputBytes;
  job.ffmpegArgs = result.ffmpegArgs;
  sendJson(ws, {
    type: 'TRANSCODE_DONE',
    transcodeId: job.id,
    bridgeCachePath,
    outputBytes: result.outputBytes,
    ffmpegArgs: result.ffmpegArgs,
  });
}

/** Answer a TRANSCODE_STATUS poll with the job's current state (authoritative). */
export function handleTranscodeStatus(ws: WebSocket, msg: StatusFrame): void {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const transcodeId = String(msg.transcodeId ?? '');
  const job = jobs.get(transcodeId);
  if (!job) {
    return sendJson(ws, {
      type: 'TRANSCODE_STATUS_RESULT',
      requestId,
      transcodeId,
      ok: true,
      found: false,
    });
  }
  sendJson(ws, {
    type: 'TRANSCODE_STATUS_RESULT',
    requestId,
    transcodeId,
    ok: true,
    found: true,
    status: job.status,
    percent: job.percent,
    etaSeconds: job.etaSeconds,
    bridgeCachePath: job.bridgeCachePath,
    outputBytes: job.outputBytes,
    ffmpegArgs: job.ffmpegArgs,
    error: job.error,
  });
}

/**
 * Super-admin kill-switch. Marks the job cancelled and terminates the in-flight
 * ffmpeg child (if any). A job still queued is cancelled before it spawns; the
 * DB row is flipped to failed by the SaaS on its next status poll. Shared with
 * the preview-proxy KILL_PROXIES path at V1 admin-plane finalization (same job
 * map shape + onSpawn child registry — see TODO(V1-block: admin-plane)).
 */
export function handleTranscodeKill(ws: WebSocket, msg: KillFrame): void {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const transcodeId = String(msg.transcodeId ?? '');
  const job = jobs.get(transcodeId);
  if (!job) {
    return sendJson(ws, {
      type: 'TRANSCODE_KILL_RESULT',
      requestId,
      transcodeId,
      ok: true,
      found: false,
    });
  }
  job.cancelled = true;
  if (job.child) {
    try {
      job.child.kill('SIGKILL');
    } catch {
      // already exited
    }
  }
  sendJson(ws, {
    type: 'TRANSCODE_KILL_RESULT',
    requestId,
    transcodeId,
    ok: true,
    found: true,
    wasRunning: job.status === 'transcoding',
  });
}

/**
 * V0.9c admin-plane: kill EVERY in-flight / queued transcode on this bridge (the
 * broad "KILL_TRANSCODES" control, vs `handleTranscodeKill`'s single-id kill the
 * doc-59 upload bar uses). Each job is marked cancelled (so a queued one never
 * spawns) and its live ffmpeg child SIGKILLed. The SaaS flips the corresponding
 * `app.upload_transcodes` rows to failed on its next status poll. Returns how many
 * were signalled — surfaced in the admin action result. Also fired on a
 * pause-transition (stop new gen + abort what's running).
 */
export function killAllTranscodes(): number {
  let killed = 0;
  for (const job of jobs.values()) {
    if (job.status === 'ready' || job.status === 'failed') continue;
    job.cancelled = true;
    if (job.child) {
      try {
        job.child.kill('SIGKILL');
        killed += 1;
      } catch {
        // already exited
      }
    }
  }
  return killed;
}

/** How many transcodes are actively encoding right now — per-device ffmpeg
 *  activity for the admin bridges panel. */
export function activeTranscodeCount(): number {
  let n = 0;
  for (const job of jobs.values()) {
    if (job.status === 'transcoding') n += 1;
  }
  return n;
}

// doc 59 Part 4 (Chat 3): a RELEASED transcode's on-bridge cache file is unlinked
// here (the SaaS keeps the DB row — no-DELETE invariant — and only the file is
// removed). The output path is RE-DERIVED on the bridge from its own cacheRoot +
// deviceId + the cache key parsed out of the (round-tripped, re-validated)
// bridgeCachePath — never trusting a gateway-supplied absolute path — and run
// through assertWithinCacheRoot before any unlink (untrusted-gateway posture).
const TRANSCODE_KEY_RE = /^[a-f0-9]{16,128}$/i;

export async function handleTranscodeCleanup(
  ws: WebSocket,
  state: SharedState,
  msg: CleanupFrame
): Promise<void> {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const transcodeId = String(msg.transcodeId ?? '');
  const reply = (payload: Record<string, unknown>): void =>
    sendJson(ws, { type: 'TRANSCODE_CLEANUP_RESULT', requestId, transcodeId, ...payload });

  // Forget the in-memory job so a later STATUS poll reports not-found (consistent
  // with the DB row now being 'released').
  jobs.delete(transcodeId);

  const bridgeCachePath = String(msg.bridgeCachePath ?? '');
  if (!bridgeCachePath) {
    return reply({ ok: true, removed: false, reason: 'no cache path — nothing to unlink' });
  }

  // Expected shape: <deviceId>/upload/<sha256key>/output.mp4.
  const deviceId = typeof state.bridgeDeviceId === 'number' ? String(state.bridgeDeviceId) : 'device';
  const parts = bridgeCachePath.split('/');
  if (
    parts.length !== 4 ||
    parts[0] !== deviceId ||
    parts[1] !== 'upload' ||
    parts[3] !== 'output.mp4' ||
    !TRANSCODE_KEY_RE.test(parts[2])
  ) {
    return reply({ ok: false, reason: 'cache path shape rejected' });
  }

  const cacheRoot = resolveActiveCacheRoot(state as ThumbOrchestratorState, state.config);
  const outDir = resolveTranscodeOutputDir(cacheRoot, deviceId, parts[2]);
  const outPath = cacheTranscodeOutputPath(outDir);
  const posterPath = cacheTranscodePosterPath(outDir);
  try {
    assertWithinCacheRoot(outPath, cacheRoot);
    assertWithinCacheRoot(posterPath, cacheRoot);
  } catch (err) {
    return reply({ ok: false, reason: `unsafe path: ${(err as Error).message}` });
  }

  try {
    await fsp.rm(outPath, { force: true });
    await fsp.rm(posterPath, { force: true });
    // Remove the now-empty per-transcode dir (best-effort).
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    return reply({ ok: true, removed: true });
  } catch (err) {
    return reply({ ok: false, reason: `unlink failed: ${(err as Error).message}` });
  }
}

// doc 59 V0.7-A + V0.7-C: on-demand thumbnail generation for a bridge file by REL
// PATH (not an indexed file_id) — the picker's downscaled image proxy (variant
// 'picker', 800px) and the on-demand thumb for a CACHE file the indexer skips
// (variant 'thumb', a poster for video / downscale for image). The output is
// written to the per-file cache dir (mtime-skip + the cache-manager evict it like
// any thumb), so a repeat request is near-free. The gateway streams the resulting
// file back to the SaaS via the existing base=cache READ path — so this only needs
// to RETURN the cache-relative thumb path, not the bytes.
interface GenCacheThumbFrame {
  type: 'GENERATE_CACHE_THUMB';
  requestId?: string;
  base?: string;
  relPath?: string;
  variant?: string;
}

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|mkv|avi|wmv|flv|ts|m2ts)$/i;

type CacheThumbResult =
  | { ok: true; thumbRelPath: string }
  | { ok: false; reason: string };

/**
 * Generate (or mtime-skip-reuse) an on-demand cache thumb for a bridge file by rel
 * path, write it to the per-file cache dir, and return its cache-relative path.
 * Shared by the GENERATE_CACHE_THUMB frame (V0.7-A/C) AND the browse first-thumb
 * pre-warm (V0.7-B). Pure work — no WSS reply — so the frame handler wraps it with
 * a reply and the browse path fires it and-forgets.
 */
export async function generateCacheThumbToDisk(
  state: SharedState,
  base: string,
  relPath: string,
  variant: 'thumb' | 'picker'
): Promise<CacheThumbResult> {
  if (!relPath || isUnsafeRelPath(relPath)) return { ok: false, reason: 'bad relPath' };

  const resolved = await resolveSourcePath(state, base, relPath);
  if (!resolved.ok) return { ok: false, reason: `source unresolved: ${resolved.reason}` };

  const cacheRoot = resolveActiveCacheRoot(state as ThumbOrchestratorState, state.config);
  const deviceId = typeof state.bridgeDeviceId === 'number' ? String(state.bridgeDeviceId) : 'device';
  const dir = resolveCacheFileDir(cacheRoot, deviceId, relPath);
  const isVideo = VIDEO_EXT_RE.test(relPath);
  // picker variant is image-only; a video always uses the poster thumb.
  const usePicker = variant === 'picker' && !isVideo;
  const outPath = usePicker ? cachePickerPath(dir) : cacheThumbPath(dir, 0);
  const outName = usePicker ? 'picker.jpg' : 'thumb-0.jpg';
  const thumbRelPath = path.posix.join(deviceId, path.posix.basename(dir), outName);

  try {
    assertWithinCacheRoot(outPath, cacheRoot);
  } catch (err) {
    return { ok: false, reason: `unsafe path: ${(err as Error).message}` };
  }

  // mtime-skip: a fresh existing artifact is reused as-is.
  try {
    const [src, art] = await Promise.all([fsp.stat(resolved.absPath), fsp.stat(outPath)]);
    if (art.isFile() && art.mtimeMs >= src.mtimeMs && art.size > 0) {
      return { ok: true, thumbRelPath };
    }
  } catch {
    // no existing artifact — generate below.
  }

  const generator = buildGenerator(state);
  let bytes: Buffer | null = null;
  if (isVideo) {
    const info = await generator.probeVideoInfo(resolved.absPath);
    const ts = info && info.durationSec > 0 ? Math.min(1, info.durationSec * 0.1) : 0;
    const result = await generator.generateVideoThumb(resolved.absPath, ts, 0);
    bytes = result?.jpegBytes ?? null;
  } else if (usePicker) {
    bytes = await generator.generatePickerImage(resolved.absPath);
  } else {
    const result = await generator.generateImageThumb(resolved.absPath);
    bytes = result?.jpegBytes ?? null;
  }
  if (!bytes) return { ok: false, reason: 'thumb generation failed' };

  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(outPath, bytes);
  } catch (err) {
    return { ok: false, reason: `write failed: ${(err as Error).message}` };
  }
  return { ok: true, thumbRelPath };
}

export function handleGenerateCacheThumb(
  ws: WebSocket,
  state: SharedState,
  msg: GenCacheThumbFrame,
  enqueue: (label: string, fn: () => Promise<void>) => void
): void {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const base = String(msg.base ?? 'cache');
  const relPath = String(msg.relPath ?? '');
  const variant = msg.variant === 'picker' ? 'picker' : 'thumb';
  const reply = (payload: Record<string, unknown>): void =>
    sendJson(ws, { type: 'GENERATE_CACHE_THUMB_RESULT', requestId, ...payload });

  if (!relPath || isUnsafeRelPath(relPath)) {
    return reply({ ok: false, reason: 'bad relPath' });
  }

  enqueue(`cache-thumb ${variant} ${relPath}`, async () => {
    const result = await generateCacheThumbToDisk(state, base, relPath, variant);
    reply(result);
  });
}
