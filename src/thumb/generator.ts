// Thumbnail generator — Phase F V0.3.
//
// For VIDEOS: ffmpeg extracts a frame at each requested position (default
// 5%, 25%, 50%, 75%, 95% of duration) and pipes raw PNG to sharp, which
// resizes to thumbMaxDimPx longest edge + JPEG-encodes at thumbJpegQuality.
//
// For IMAGES: sharp reads the file directly, resizes + JPEG-encodes.
// Only position 5 is generated for images (single frame; position value is
// pinned to 5 so the unique-constraint shape works without a separate
// "image" position).
//
// Concurrency: limited to `thumbConcurrency` parallel ffmpeg invocations
// (default 1). Between videos, the orchestrator pauses `thumbDelayMs` (default
// 200ms) to keep the creator's machine responsive. ffmpeg is invoked with
// `-threads 1` + the process is renice'd via `process.setpriority` at start
// of each ffmpeg run (default nice=15).

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import sharp from 'sharp';

// ─── V0.9c preview-proxy kill registry (admin-plane) ─────────────────────────
// Live preview-proxy ffmpeg children, registered via the same `onSpawn` seam the
// transcode side already uses (spawnEncode). The transcode kill targets its own
// `jobs` map (by transcodeId); proxies are anonymous background gen with no id,
// so they get their own registry here. `killAllProxies()` is the bridge half of
// the SaaS `/admin/bridges` KILL_PROXIES action (a DAEMON_CONTROL frame routes
// here). De-registration on close/error keeps the set bounded to truly-live procs.
const activeProxyChildren = new Set<ChildProcess>();

function registerProxyChild(proc: ChildProcess): void {
  activeProxyChildren.add(proc);
  const drop = () => activeProxyChildren.delete(proc);
  proc.on('close', drop);
  proc.on('error', drop);
}

/** Kill every in-flight preview-proxy ffmpeg child. Returns how many were
 *  signalled. Used by the admin-plane KILL_PROXIES control + on pause-transition
 *  (the queue gate stops NEW gen; this aborts what's already running). */
export function killAllProxies(): number {
  let killed = 0;
  for (const proc of activeProxyChildren) {
    try {
      proc.kill('SIGKILL');
      killed += 1;
    } catch {
      // already exited; the close handler will drop it from the set
    }
  }
  return killed;
}

/** How many preview-proxy encodes are running right now (per-device ffmpeg
 *  activity, surfaced in the admin bridges panel via a status frame). */
export function activeProxyCount(): number {
  return activeProxyChildren.size;
}

export interface VideoThumbJob {
  kind: 'video';
  /** Container-side absolute path to read from (under /sources/local). */
  sourceFullPath: string;
  /** Duration in seconds. Pre-probed via ffprobe so we can compute %-positions. */
  durationSec: number;
  positions: number[];
}

export interface ImageThumbJob {
  kind: 'image';
  sourceFullPath: string;
}

export interface ThumbResult {
  position: number;
  jpegBytes: Buffer;
  width: number;
  height: number;
}

export interface ThumbnailGeneratorOpts {
  ffmpegPath: string;
  ffprobePath: string;
  maxDimPx: number;
  jpegQuality: number;
  cpuNice: number;
  /** Max threads for the proxy transcode (0 = ffmpeg auto/all cores). Default
   *  comes from config.proxyThreads — deliberately low so previews stay polite. */
  proxyThreads: number;
}

export class ThumbnailGenerator {
  constructor(private readonly opts: ThumbnailGeneratorOpts) {}

  /**
   * Probe a video's duration in seconds via ffprobe. Returns null if probe
   * fails (file is not a video, codec unsupported, etc.) — caller should
   * skip thumb generation for that file.
   */
  async probeDuration(sourceFullPath: string): Promise<number | null> {
    return new Promise((resolve) => {
      const args = [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        sourceFullPath,
      ];
      const proc = spawn(this.opts.ffprobePath, args);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => {
        if (code !== 0) {
          // eslint-disable-next-line no-console
          console.warn(`ffprobe failed for ${sourceFullPath} (exit=${code}): ${stderr.trim()}`);
          return resolve(null);
        }
        const dur = Number(stdout.trim());
        if (!Number.isFinite(dur) || dur <= 0) return resolve(null);
        resolve(dur);
      });
    });
  }

  /**
   * Probe duration + native pixel dimensions in one ffprobe call. Returns null
   * if the probe fails (not a video / unsupported codec). Used by the proxy
   * pipeline to (a) compute %-positions and (b) skip proxy gen for sources that
   * are already ≤720p (proxying down would be larger than the source).
   */
  async probeVideoInfo(
    sourceFullPath: string
  ): Promise<{ durationSec: number; width: number; height: number } | null> {
    return new Promise((resolve) => {
      const args = [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height:format=duration',
        '-of',
        'json',
        sourceFullPath,
      ];
      const proc = spawn(this.opts.ffprobePath, args);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => {
        if (code !== 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `ffprobe (info) failed for ${sourceFullPath} (exit=${code}): ${stderr.trim()}`
          );
          return resolve(null);
        }
        try {
          const parsed = JSON.parse(stdout) as {
            streams?: Array<{ width?: number; height?: number }>;
            format?: { duration?: string };
          };
          const stream = parsed.streams?.[0];
          const durationSec = Number(parsed.format?.duration);
          const width = Number(stream?.width);
          const height = Number(stream?.height);
          if (
            !Number.isFinite(durationSec) ||
            durationSec <= 0 ||
            !Number.isFinite(width) ||
            width <= 0 ||
            !Number.isFinite(height) ||
            height <= 0
          ) {
            return resolve(null);
          }
          resolve({ durationSec, width, height });
        } catch {
          resolve(null);
        }
      });
    });
  }

  /**
   * Transcode a 720p H.264 preview proxy (arch-note 14 §4). H.264 main profile,
   * scaled so the larger edge fits a 1280×720 box preserving aspect (portrait
   * sources stay portrait), CRF from settings, `fastdecode` tune for smooth
   * scrubbing, `+faststart` so the moov atom is up front for byte-range play.
   * ATOMIC: encodes to a `.partial` sibling and renames onto `outPath` only on
   * success — an interrupted/killed transcode (gateway timeout, bridge restart,
   * reconnect abort) never leaves a truncated `preview.mp4` that the mtime-skip
   * would mistake for a fresh proxy. Caller must `mkdir -p` the parent first.
   * Resolves true on success, false on any failure (caller falls back to
   * streaming the source bytes).
   */
  async generateProxy(
    sourceFullPath: string,
    outPath: string,
    opts: { crf: number }
  ): Promise<boolean> {
    const tmpPath = `${outPath}.partial`;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      sourceFullPath,
      '-vf',
      // Fit inside 1280×720 preserving aspect; never upscale (min() guards);
      // then round to even dims (libx264 requires even width/height).
      "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease," +
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libx264',
      '-profile:v',
      'main',
      '-preset',
      'veryfast',
      '-tune',
      'fastdecode',
      '-crf',
      String(opts.crf),
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      // Force the MP4 muxer explicitly — the atomic temp path ends in `.partial`,
      // not `.mp4`, so ffmpeg can't infer the format from the extension.
      '-f',
      'mp4',
      // Bounded, configurable thread cap (default 2 — NOT all cores). Previews
      // are non-essential; this leaves headroom for real workloads (e.g. Hyper
      // Backup), and the renice below keeps it low-priority on top. `0` ⇒ ffmpeg
      // auto (all cores) for those who opt into speed. Single-threaded (the old
      // `-threads 1`) was the multi-minute-per-file slowness.
      '-threads',
      String(this.opts.proxyThreads),
      tmpPath,
    ];
    // V0.9c: register the live child in the proxy kill registry (same `onSpawn`
    // seam the transcode side uses) so the admin-plane KILL_PROXIES control + a
    // pause-transition can abort an in-flight preview proxy.
    const result = await this.spawnEncode(sourceFullPath, args, tmpPath, outPath, {
      onSpawn: registerProxyChild,
    });
    return result.ok;
  }

  /**
   * doc 59 Part 3 — UPLOAD-side shrink-to-fit transcode. Sibling of the
   * playback-side `generateProxy`: same spawn helper (`spawnEncode`), same
   * renice/CPU-budget gating, same atomic `.partial`→final rename, same kill
   * registry (`onSpawn`) — but a DIFFERENT objective. The proxy DOWNSCALES to
   * 720p for cheap scrubbing; the transcode PRESERVES resolution (4K stays 4K)
   * and only brings the BITRATE down so the file fits a platform's byte cap.
   *
   * Single-pass average-bitrate H.264: the video bitrate is derived from the
   * target byte budget and the probed duration (minus the audio budget), with a
   * safety factor + `-maxrate`/`-bufsize` caps so the output reliably lands UNDER
   * `targetBytes`. Single-pass (vs 2-pass) keeps it to one ffmpeg child — simpler
   * kill semantics + roughly half the wall-time — and the generous transcode_target
   * (~0.9× platform_limit) plus the safety factor below absorb single-pass size
   * variance. The caller verifies `outputBytes <= targetBytes` and fails the job
   * if the rare overshoot happens (the SaaS then falls back to a re-export prompt).
   */
  async transcodeToTarget(
    sourceFullPath: string,
    outPath: string,
    opts: {
      targetBytes: number;
      durationSec: number;
      onProgress?: (percent: number, etaSec: number | null) => void;
      onSpawn?: (proc: ChildProcess) => void;
    }
  ): Promise<{ ok: boolean; outputBytes: number | null; ffmpegArgs: string }> {
    const tmpPath = `${outPath}.partial`;
    const audioBitrateBps = 128_000; // matches `-b:a 128k` below
    // Reserve the audio budget, apply a 6% safety headroom (container overhead +
    // single-pass variance), and floor at a sane minimum so a very long video
    // doesn't drop to an unwatchable bitrate.
    const totalBudgetBps = Math.max(0, (opts.targetBytes * 8) / Math.max(1, opts.durationSec));
    const videoBitrateBps = Math.max(
      200_000,
      Math.floor((totalBudgetBps - audioBitrateBps) * 0.94)
    );
    const vk = `${Math.floor(videoBitrateBps / 1000)}k`;
    const maxrateK = `${Math.floor((videoBitrateBps * 1.45) / 1000)}k`;
    const bufsizeK = `${Math.floor((videoBitrateBps * 2) / 1000)}k`;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostats',
      // Emit machine-readable progress on stdout so spawnEncode can compute %/ETA.
      '-progress',
      'pipe:1',
      '-y',
      '-i',
      sourceFullPath,
      // NO scale filter — resolution is preserved deliberately (creators care
      // that 4K stays 4K; only the bitrate comes down). Even-dim rounding is
      // unnecessary because we don't change dimensions.
      '-c:v',
      'libx264',
      '-profile:v',
      'high',
      '-preset',
      // `medium` buys ~15-20% better size/quality vs `veryfast` — worth it on the
      // upload path (run once, cached + reposted), unlike the latency-sensitive
      // preview proxy.
      'medium',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      vk,
      '-maxrate',
      maxrateK,
      '-bufsize',
      bufsizeK,
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      '-threads',
      String(this.opts.proxyThreads),
      tmpPath,
    ];
    const result = await this.spawnEncode(sourceFullPath, args, tmpPath, outPath, {
      onSpawn: opts.onSpawn,
      progress: opts.onProgress
        ? { durationSec: opts.durationSec, onProgress: opts.onProgress }
        : undefined,
    });
    let outputBytes: number | null = null;
    if (result.ok) {
      try {
        outputBytes = (await fsp.stat(outPath)).size;
      } catch {
        outputBytes = null;
      }
    }
    return { ok: result.ok, outputBytes, ffmpegArgs: args.join(' ') };
  }

  /**
   * Extract one poster frame (mid-point) and write it as a JPEG alongside a
   * transcode output. doc 59 cluster item 3 (Hybrid thumbnails): the upload
   * transcode already decodes the video, so grabbing a poster here is a near-free
   * side-effect — managed_cache files that get transcoded get a real thumbnail
   * for free. Best-effort: a poster failure never fails the transcode.
   */
  async writePosterFrame(
    sourceFullPath: string,
    durationSec: number,
    posterPath: string
  ): Promise<boolean> {
    const thumb = await this.generateVideoThumb(sourceFullPath, durationSec / 2, 0);
    if (!thumb) return false;
    try {
      await fsp.writeFile(posterPath, thumb.jpegBytes, { flag: 'w' });
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`poster write failed (${posterPath}): ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * THE single ffmpeg-encode spawn site — shared by the preview-proxy pipeline
   * (`generateProxy`) and the doc 59 upload-transcode pipeline
   * (`transcodeToTarget`). Centralizing it keeps CPU-budget gating (renice), the
   * atomic `.partial`→final rename, and the kill hook on ONE invocation rather
   * than two divergent ones (doc 59 decision 7 — two pipelines, one safety
   * mechanism). `args` must already end with `tmpPath`; on exit 0 the temp is
   * atomically promoted to `outPath`.
   *
   * `onSpawn(proc)` exposes the live child so a caller (the transcode job map)
   * can register it for a super-admin `TRANSCODE_KILL` — `proc.kill()` aborts the
   * encode and the non-zero exit cleans up the `.partial`. `progress` parses
   * ffmpeg's `-progress pipe:1` stream into percent/ETA for the upload progress bar.
   */
  private spawnEncode(
    sourceFullPath: string,
    args: string[],
    tmpPath: string,
    outPath: string,
    opts: {
      onSpawn?: (proc: ChildProcess) => void;
      progress?: { durationSec: number; onProgress: (percent: number, etaSec: number | null) => void };
    } = {}
  ): Promise<{ ok: boolean }> {
    return new Promise<{ ok: boolean }>((resolve) => {
      void fsp
        .rm(tmpPath, { force: true })
        .catch(() => undefined)
        .then(() => {
          const useStdout = !!opts.progress;
          // V0.9c admin-plane (KILL_TRANSCODES / KILL_PROXIES): `onSpawn` below
          // hands the live child to the caller's kill registry. The transcode side
          // registers into its `jobs` map (kill by transcodeId); the preview-proxy
          // side registers into `activeProxyChildren` via `registerProxyChild`
          // (kill-all). Both flow through THIS one spawn seam — no second site.
          // TODO(doc59: orchestrator): both the preview-proxy and upload-transcode
          // pipelines run through THIS one spawn helper + CPU-budget gating (renice)
          // + kill hook — keep it that way rather than forking a second ffmpeg call.
          const proc = spawn(this.opts.ffmpegPath, args, {
            stdio: ['ignore', useStdout ? 'pipe' : 'ignore', 'pipe'],
          });
          opts.onSpawn?.(proc);
          this.tryRenice(proc.pid);

          if (opts.progress && proc.stdout) {
            const { durationSec, onProgress } = opts.progress;
            let buf = '';
            proc.stdout.on('data', (d) => {
              buf += d.toString();
              let nl: number;
              let lastOutUs: number | null = null;
              let lastSpeed: number | null = null;
              while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                const eq = line.indexOf('=');
                if (eq <= 0) continue;
                const key = line.slice(0, eq);
                const val = line.slice(eq + 1);
                if (key === 'out_time_us' || key === 'out_time_ms') {
                  const us = key === 'out_time_us' ? Number(val) : Number(val) * 1000;
                  if (Number.isFinite(us)) lastOutUs = us;
                } else if (key === 'speed') {
                  const sp = Number(val.replace('x', '').trim());
                  if (Number.isFinite(sp) && sp > 0) lastSpeed = sp;
                }
              }
              if (lastOutUs != null && durationSec > 0) {
                const outSec = lastOutUs / 1_000_000;
                const percent = Math.max(0, Math.min(99, Math.round((outSec / durationSec) * 100)));
                const remainingSec = Math.max(0, durationSec - outSec);
                const etaSec = lastSpeed && lastSpeed > 0 ? Math.round(remainingSec / lastSpeed) : null;
                onProgress(percent, etaSec);
              }
            });
          }

          let stderr = '';
          if (proc.stderr) proc.stderr.on('data', (d) => (stderr += d.toString()));
          const cleanupFail = () => {
            void fsp.rm(tmpPath, { force: true }).catch(() => undefined);
            resolve({ ok: false });
          };
          proc.on('error', cleanupFail);
          proc.on('close', (code) => {
            if (code !== 0) {
              // eslint-disable-next-line no-console
              console.warn(
                `ffmpeg encode failed for ${sourceFullPath} (exit=${code}): ${stderr.trim()}`
              );
              return cleanupFail();
            }
            fsp.rename(tmpPath, outPath).then(
              () => resolve({ ok: true }),
              (err) => {
                // eslint-disable-next-line no-console
                console.warn(
                  `encode rename failed (${tmpPath} → ${outPath}): ${(err as Error).message}`
                );
                cleanupFail();
              }
            );
          });
        });
    });
  }

  async generateVideoThumb(
    sourceFullPath: string,
    timestampSec: number,
    position: number
  ): Promise<ThumbResult | null> {
    // ffmpeg seeks via `-ss` BEFORE `-i` for fast seek + extracts ONE frame
    // via `-frames:v 1` + outputs PNG to stdout. We then pipe to sharp for
    // resize + JPEG encode.
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', String(timestampSec),
      '-i', sourceFullPath,
      '-frames:v', '1',
      '-threads', '1',
      '-f', 'image2pipe',
      '-vcodec', 'png',
      '-',
    ];
    const proc = spawn(this.opts.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.tryRenice(proc.pid);

    const pngChunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (d) => pngChunks.push(d));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    return new Promise<ThumbResult | null>((resolve) => {
      proc.on('error', () => resolve(null));
      proc.on('close', async (code) => {
        if (code !== 0 || pngChunks.length === 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `ffmpeg failed for ${sourceFullPath}@${timestampSec}s (exit=${code}): ${stderr.trim()}`
          );
          return resolve(null);
        }
        const png = Buffer.concat(pngChunks);
        try {
          const result = await this.resizeToJpeg(png);
          resolve({ position, ...result });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`sharp failed on ffmpeg output: ${(err as Error).message}`);
          resolve(null);
        }
      });
    });
  }

  async generateImageThumb(sourceFullPath: string): Promise<ThumbResult | null> {
    try {
      const result = await sharp(sourceFullPath, { failOn: 'none' })
        .rotate() // honor EXIF orientation
        .resize(this.opts.maxDimPx, this.opts.maxDimPx, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: this.opts.jpegQuality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      return {
        position: 5, // single position for images, pinned to 5
        jpegBytes: result.data,
        width: result.info.width,
        height: result.info.height,
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `sharp failed for image ${sourceFullPath}: ${(err as Error).message}`
      );
      return null;
    }
  }

  /**
   * doc 59 V0.7-A: a downscaled picker thumbnail for a LARGE source image — 800px
   * max dimension, ~80% JPEG (~50–100KB), so the picker grid loads fast instead of
   * streaming the full multi-MB original. Independent of the configured thumb size
   * (maxDimPx) on purpose: this is a picker-grid target, not the content thumb.
   */
  async generatePickerImage(sourceFullPath: string): Promise<Buffer | null> {
    try {
      const result = await sharp(sourceFullPath, { failOn: 'none' })
        .rotate() // honor EXIF orientation
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer();
      return result;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`sharp picker-thumb failed for ${sourceFullPath}: ${(err as Error).message}`);
      return null;
    }
  }

  private async resizeToJpeg(
    pngBytes: Buffer
  ): Promise<{ jpegBytes: Buffer; width: number; height: number }> {
    const result = await sharp(pngBytes)
      .resize(this.opts.maxDimPx, this.opts.maxDimPx, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: this.opts.jpegQuality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      jpegBytes: result.data,
      width: result.info.width,
      height: result.info.height,
    };
  }

  private tryRenice(pid: number | undefined) {
    if (pid == null || this.opts.cpuNice === 0) return;
    try {
      // os.setPriority delegates to setpriority(2) on Linux/macOS or the
      // Windows job-object equivalent. Niceness 15 is "low priority" without
      // being completely starved (19 is max niceness).
      os.setPriority(pid, this.opts.cpuNice);
    } catch {
      // setPriority not permitted (e.g. trying to lower priority of an
      // already-low process) — skip silently. Thumb generation still works,
      // just at default CPU priority.
    }
  }
}

/**
 * Decide whether a MIME type is video, image, or neither (skip).
 */
export function thumbKindForMime(mime: string | null | undefined): 'video' | 'image' | null {
  if (!mime) return null;
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  return null;
}
