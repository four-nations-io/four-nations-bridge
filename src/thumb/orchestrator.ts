// Thumb-sync orchestrator — Phase F V0.3 → V0.6.b.
//
// For each indexed VIDEO whose path matches a canonical type folder (Clips /
// Final Video / Teaser / Trailer):
//   - Resolves the per-position thumb write paths via thumb/paths.ts
//   - For each position: extracts the frame, resizes + encodes JPEG
//   - Writes the JPEG locally (mode below) AND encrypts + ships a THUMB frame
//     to the gateway (the gateway store is authoritative for browser reads).
//
// V0.6.b additions:
//   - LAZY generation. No automatic walk on boot/reconnect — the orchestrator
//     runs only on: project enable false→true, an explicit SYNC_PROJECT frame,
//     an on-demand single-file GENERATE request, and a once-daily timer
//     (all wired in wss-client.ts). The post-INDEX_DONE auto-run is removed.
//   - MTIME-AWARE SKIP. An artifact is "fresh" (skipped) only if it exists AND
//     source.mtime <= artifact.mtime — re-exported files (mtime bump) regen,
//     so Sync is safe to spam.
//   - OUTPUT MODE. `in_place` (operator backward-compat) keeps the V0.3
//     in-project thumb layout and generates NO proxies. `cache_dir` writes
//     thumbs + 720p proxies under <cacheRoot>/<deviceId>/<fileKey>/ (arch-note
//     14 §3/§4).
//   - 720p PREVIEW PROXIES (cache_dir mode only). One H.264 main-profile proxy
//     per qualifying video; skipped for sources that fit a 1280×720 box or are
//     under proxy_skip_below_bytes (clips stream fine as-is).
//
// Files NOT in a canonical type folder are skipped silently (V1.9 mapping work
// surfaces a UI for them). Files inside Bridge Thumbnails are never walked in
// the first place — LocalFSPlugin's skip list catches them.
//
// Per-type position count:
//   - Clips     → 1 thumb at position 0 (first frame; matches Twitter cover)
//   - Final Video → 5 thumbs at 5/25/50/75/95
//   - Teaser    → 5 thumbs at 5/25/50/75/95
//   - Trailer   → 5 thumbs at 0/25/50/75/95
//
// Throttling: serial by default (concurrency=1) with thumbDelayMs pause
// between videos so the creator's machine stays responsive.

import { promises as fs, accessSync, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import type WebSocket from 'ws';
import type { BridgeConfig } from '../config';
import { LocalFSPlugin } from '../source-plugins/local-fs';
import type { FileEntry } from '../source-plugins/types';
import type { ResolvedSourceRoot } from '../source-roots/resolve';
import { encryptAesGcm } from './crypto';
import {
  resolveThumbWritePath,
  resolveCacheFileDir,
  cacheThumbPath,
  cacheProxyPath,
  cacheProxyTtlPath,
  assertWithinCacheRoot,
  isUnsafeRelPath,
} from './paths';
import { detectContentType, shouldGenerateThumbs } from './types';
import { ThumbnailGenerator, thumbKindForMime } from './generator';
import {
  effectiveThumbSettings,
  effectiveCacheSettings,
  type RuntimeSettingsState,
  type RuntimeThumbSettings,
  type RuntimeCacheSettings,
} from '../settings/runtime';
import type { DetectedProject } from '../projects/detect';

/**
 * Defense-in-depth write-path validator. The bridge's host filesystem
 * permissions (granted via ACL to the `fournations` user on Synology) are
 * the primary defense — fournations has read + create + write, no delete,
 * on the content tree. This code-side check is the second layer: even if
 * something in the orchestrator pipeline produced a path that escaped the
 * intended thumb-write region, we throw before touching the disk.
 *
 * Two checks:
 *   1. The resolved write path must be inside `thumbWritableRoot`
 *      (e.g. /writable/source). Catches any path that escaped via
 *      symlinks, normalization bugs, or future refactors.
 *   2. The filename must match the canonical thumb naming pattern.
 *      Prevents the bridge from ever writing arbitrarily-named files
 *      even if path policy somewhere upstream had a bug.
 */
function assertWritePathSafe(
  fullPath: string,
  thumbWritableRoot: string
): void {
  const normalizedRoot = path.posix.normalize(thumbWritableRoot);
  const rootWithSlash = normalizedRoot.endsWith('/')
    ? normalizedRoot
    : normalizedRoot + '/';
  if (!fullPath.startsWith(rootWithSlash)) {
    throw new Error(
      `refusing to write outside thumbWritableRoot: ${fullPath} (root=${normalizedRoot})`
    );
  }
  // Canonical thumb filename shape: <whatever>.thumb-{N}.jpg
  const base = path.posix.basename(fullPath);
  if (!/^.+\.thumb-\d+\.jpg$/.test(base)) {
    throw new Error(
      `refusing to write file that doesn't match thumb naming pattern: ${base}`
    );
  }
}

const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH ?? 'ffprobe';

export type ThumbSyncStatus = 'idle' | 'running' | 'done' | 'error';

export interface ThumbSyncStats {
  startedAt: number | null;
  finishedAt: number | null;
  videosProcessed: number;
  videosSkippedUntyped: number;
  videosSkippedAlreadyThumbed: number;
  videosFailed: number;
  imagesProcessed: number;
  imagesFailed: number;
  thumbsWritten: number;
  thumbsPushed: number;
  proxiesWritten: number;
  proxiesSkipped: number;
  proxiesFailed: number;
  lastFilePath: string | null;
  errorMessage: string | null;
}

export function emptyThumbStats(): ThumbSyncStats {
  return {
    startedAt: null,
    finishedAt: null,
    videosProcessed: 0,
    videosSkippedUntyped: 0,
    videosSkippedAlreadyThumbed: 0,
    videosFailed: 0,
    imagesProcessed: 0,
    imagesFailed: 0,
    thumbsWritten: 0,
    thumbsPushed: 0,
    proxiesWritten: 0,
    proxiesSkipped: 0,
    proxiesFailed: 0,
    lastFilePath: null,
    errorMessage: null,
  };
}

/**
 * Everything the per-file gen pipeline needs, resolved once per run so an
 * in-flight sync uses a consistent setting set. Built by `buildGenContext`.
 */
interface GenContext {
  generator: ThumbnailGenerator;
  effective: RuntimeThumbSettings;
  cache: RuntimeCacheSettings;
  outputMode: 'in_place' | 'cache_dir';
  cacheRoot: string;
  /** Per-device cache namespace. Known post-HELLO_ACK; 'device' as a fallback. */
  deviceId: number | string;
  thumbWritableRoot: string;
  /** Whether THIS run generates 720p proxies. Proxies are 100-200x the size of
   *  thumbs and only teaser/full-video ones get watched, so batch flows
   *  (SYNC_PROJECT / on-enable / daily) generate THUMBS ONLY; proxies are made
   *  ON-DEMAND (preview request → GENERATE) — see arch-note 14 §4. */
  generateProxies: boolean;
}

function buildGenContext(
  config: BridgeConfig,
  state: ThumbOrchestratorState,
  opts: { proxies: boolean }
): GenContext {
  const effective = effectiveThumbSettings(config, state.runtimeSettings);
  const cache = effectiveCacheSettings(config, state.runtimeSettings);
  return {
    generator: new ThumbnailGenerator({
      ffmpegPath: FFMPEG_PATH,
      ffprobePath: FFPROBE_PATH,
      maxDimPx: effective.maxDimPx,
      jpegQuality: effective.jpegQuality,
      cpuNice: effective.cpuNice,
      proxyThreads: config.proxyThreads,
    }),
    effective,
    cache,
    outputMode: config.thumbOutputMode,
    cacheRoot: resolveActiveCacheRoot(state, config),
    deviceId:
      typeof state.bridgeDeviceId === 'number' ? state.bridgeDeviceId : 'device',
    thumbWritableRoot: config.thumbWritableRoot,
    generateProxies: opts.proxies,
  };
}

/** Hidden cache folder name, placed at the root of the active writable source
 *  root. LocalFSPlugin + project detection skip it so it's never indexed or
 *  thumbnailed. */
export const CACHE_DIRNAME = '_cache';

/**
 * Resolve where the bridge cache lives (operator decision 2026-06-05, revised).
 *
 * PREFERRED: a dedicated cache mount (`config.cacheRoot`, default `/data/cache`)
 * that the bridge can WRITE to — meaning the operator bind-mounted a host dir
 * they `chown`ed to the bridge UID. The bridge then fully OWNS the cache, so
 * create + write + DELETE (eviction) all work with no ACL grants, and the cache
 * sits OUTSIDE the content tree (cleaner — matches the arch-note's separate-RW-
 * cache boundary). We probe write access at resolve time (cheap, once per run);
 * a root-owned named volume fails the probe and we fall back.
 *
 * FALLBACK: a hidden `_cache/` at the root of the active writable source root.
 * Works for create+write under the content ACL, but eviction needs an explicit
 * delete grant there (the content tree is otherwise no-delete) — which Synology
 * makes awkward, hence the preferred path above.
 *
 * The sha256 cache key maps each artifact back to its source file in either
 * location.
 */
export function resolveActiveCacheRoot(
  state: ThumbOrchestratorState,
  config: BridgeConfig
): string {
  // 1. PREFERRED — the managed folder (`/data/managed`): a single RW bind the
  //    operator points anywhere (NAS path, or local disk via Docker Desktop file
  //    sharing) and the bridge fully OWNS. The cache lives at `<managed>/_cache`
  //    alongside the template + the creator's projects — so create/write/DELETE
  //    all work with no ACL grants, the cache is on the same volume as the
  //    content it serves, and the install exposes ONE useful folder.
  if (config.managedEnabled && isWritableDir(config.managedRoot)) {
    return path.posix.join(config.managedRoot, CACHE_DIRNAME);
  }
  // 2. A dedicated cache mount the bridge can write to (owned bind at cacheRoot).
  if (isWritableDir(config.cacheRoot)) {
    return config.cacheRoot;
  }
  // 3. FALLBACK — hidden `_cache` at the active writable source root (works for
  //    create+write; eviction there needs a delete grant on `_cache`).
  const writable = state.sourceRoots.find(
    (r) => r.status === 'active' && r.writable && r.containerPath
  );
  if (writable && writable.containerPath) {
    return path.posix.join(writable.containerPath, CACHE_DIRNAME);
  }
  return config.cacheRoot;
}

/** Sync probe: is `dir` writable by the bridge UID? (cheap; once per run). */
function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ThumbOrchestratorState {
  thumbSyncStatus: ThumbSyncStatus;
  thumbSyncStats: ThumbSyncStats;
  detectedProjects: DetectedProject[];
  enabledProjectRelPaths: Set<string>;
  runtimeSettings: RuntimeSettingsState;
  /** Gateway-assigned device id (HELLO_ACK). Namespaces the cache dir. */
  bridgeDeviceId: number | null;
  /** Resolved narrow-bind source roots (from SETTINGS_RESPONSE). The cache lands
   *  under the active writable one (see resolveActiveCacheRoot). */
  sourceRoots: ResolvedSourceRoot[];
  /** The source root the orchestrator walks (== SharedState.config.sourceRoot;
   *  carried here so project/on-demand walks can scope a subtree). */
  config: BridgeConfig;
}

/**
 * Full-walk lazy sync over a list of already-walked entries, filtered to the
 * operator's enabled projects. Used by the once-daily timer (wss-client.ts)
 * with a fresh walk of the source root. mtime-skip makes it near-instant when
 * nothing changed.
 */
export async function runThumbSync(
  ws: WebSocket,
  config: BridgeConfig,
  state: ThumbOrchestratorState,
  entries: FileEntry[],
  abort: { stopped: boolean }
): Promise<void> {
  state.thumbSyncStatus = 'running';
  state.thumbSyncStats = emptyThumbStats();
  state.thumbSyncStats.startedAt = Date.now();

  // Daily batch walk → thumbs only (proxies are on-demand; see GenContext).
  const ctx = buildGenContext(config, state, { proxies: false });

  // Build a project-enabled predicate from the operator's SaaS-UI toggles.
  // If `enabledProjectRelPaths` is non-empty, only files whose detected
  // project relPath is in the set get processed. If empty (default first-
  // run), ALL detected projects are processed.
  const enabledSet = state.enabledProjectRelPaths;
  const filterByEnabled = enabledSet.size > 0;
  const projectFilter = (projectRelPath: string): boolean =>
    !filterByEnabled || enabledSet.has(projectRelPath);

  await processEntries(ws, config, state, ctx, entries, abort, projectFilter);

  state.thumbSyncStatus = 'done';
  state.thumbSyncStats.finishedAt = Date.now();
  // eslint-disable-next-line no-console
  console.log(
    `thumb: sync complete (videos=${state.thumbSyncStats.videosProcessed}, skipped-untyped=${state.thumbSyncStats.videosSkippedUntyped}, skipped-done=${state.thumbSyncStats.videosSkippedAlreadyThumbed}, written=${state.thumbSyncStats.thumbsWritten}, pushed=${state.thumbSyncStats.thumbsPushed}, proxies=${state.thumbSyncStats.proxiesWritten}/${state.thumbSyncStats.proxiesSkipped}skip)`
  );
}

/**
 * Run the orchestrator for ONE project — walks just that project's subtree and
 * runs the per-file pipeline. Used by the explicit SYNC_PROJECT frame AND by
 * on-enable (false→true). Identical pipeline to the daily walk, scoped to one
 * project relPath (relative to the source root; '' = mount root is the project).
 */
export async function runProjectSync(
  ws: WebSocket,
  config: BridgeConfig,
  state: ThumbOrchestratorState,
  projectRelPath: string,
  abort: { stopped: boolean }
): Promise<void> {
  // Bridge boundary: never walk a gateway-supplied path that escapes the source
  // root (the gateway is treated as potentially compromised — arch-note 14 §3).
  if (isUnsafeRelPath(projectRelPath)) {
    // eslint-disable-next-line no-console
    console.warn(`thumb: refusing SYNC_PROJECT for unsafe projectRelPath "${projectRelPath}"`);
    return;
  }
  state.thumbSyncStatus = 'running';
  state.thumbSyncStats = emptyThumbStats();
  state.thumbSyncStats.startedAt = Date.now();

  // SYNC_PROJECT / on-enable → thumbs only (proxies are on-demand; see GenContext).
  const ctx = buildGenContext(config, state, { proxies: false });
  const entries = await walkSubtree(config.sourceRoot, projectRelPath);

  // eslint-disable-next-line no-console
  console.log(
    `thumb: project sync [${projectRelPath || '<mount root>'}] — ${entries.length} entries`
  );
  // No project filter — the caller already scoped to one project's subtree.
  await processEntries(ws, config, state, ctx, entries, abort, () => true);

  state.thumbSyncStatus = 'done';
  state.thumbSyncStats.finishedAt = Date.now();
  // eslint-disable-next-line no-console
  console.log(
    `thumb: project sync complete [${projectRelPath || '<mount root>'}] (written=${state.thumbSyncStats.thumbsWritten}, proxies=${state.thumbSyncStats.proxiesWritten}, skipped-done=${state.thumbSyncStats.videosSkippedAlreadyThumbed})`
  );
}

/**
 * On-demand single-file generation. The gateway relays a GENERATE request when
 * the V0.6.c /stream path finds a missing artifact; the bridge generates that
 * one file's thumbs (+ proxy in cache_dir mode) and replies. Returns true if
 * the file is a canonical-typed video the bridge can serve, false otherwise.
 */
export async function generateForFile(
  ws: WebSocket,
  config: BridgeConfig,
  state: ThumbOrchestratorState,
  relPath: string
): Promise<boolean> {
  // Bridge boundary: reject a gateway-supplied relPath that escapes the source
  // root before it reaches fs.stat / ffmpeg (gateway treated as untrusted).
  if (isUnsafeRelPath(relPath)) {
    // eslint-disable-next-line no-console
    console.warn(`thumb: refusing on-demand GENERATE for unsafe relPath "${relPath}"`);
    return false;
  }
  const detected = detectContentType(relPath);
  if (!detected) return false;
  // On-demand (preview request) → the ONE flow that generates a 720p proxy.
  const ctx = buildGenContext(config, state, { proxies: true });
  const sourceFullPath = path.join(config.sourceRoot, relPath);
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(sourceFullPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const entry: FileEntry = {
    relPath,
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    isDir: false,
    mime: undefined,
  };
  try {
    await processVideo(ws, config, state, ctx, entry, detected.positions);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`thumb: on-demand gen failed for ${relPath}: ${(err as Error).message}`);
    return false;
  }
  // "ok" means the PROXY is ready (follow-up 2026-06-05): the gateway GENERATE
  // relay can then trust the artifact exists. A proxy-skipped source (image /
  // ≤720p / under threshold) returns false — there's nothing to serve but the
  // source, which the /stream path falls back to on its own.
  const proxyPath = cacheProxyPath(
    resolveCacheFileDir(ctx.cacheRoot, ctx.deviceId, relPath)
  );
  return isFresh(proxyPath, stat.mtimeMs);
}

/**
 * Generate JUST the 720p proxy for one video — no thumbs, NO canonical-type-
 * folder requirement. Used by the V0.6.c /stream preview path to build a proxy
 * in the background for an eligible-but-unproxied source (incl. UNTYPED loose
 * masters — the operator's whole 2023 library is untyped, and previews shouldn't
 * require a type folder; only thumb-positioning does). Applies the same skip
 * rules (size threshold / ≤720p) + mtime-aware skip as the batch proxy path, and
 * the same `assertWithinCacheRoot` write guard. Returns true iff a fresh proxy
 * exists afterwards. Never throws.
 */
export async function generateProxyForFile(
  config: BridgeConfig,
  state: ThumbOrchestratorState,
  relPath: string,
  // V0.7.d: optional frequency-adaptive TTL (minutes) from the gateway. When set,
  // a per-proxy `preview.ttl` sidecar is written so the cache manager keeps a
  // recurring file's proxy across sessions. null → flat proxy_cache_ttl_minutes.
  proxyTtlMinutes: number | null = null
): Promise<boolean> {
  if (isUnsafeRelPath(relPath)) {
    // eslint-disable-next-line no-console
    console.warn(`thumb: refusing background proxy for unsafe relPath "${relPath}"`);
    return false;
  }
  const ctx = buildGenContext(config, state, { proxies: true });
  const sourceFullPath = path.join(config.sourceRoot, relPath);
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(sourceFullPath);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`thumb: background proxy — source not found for ${relPath}`);
    return false;
  }
  if (!stat.isFile()) return false;
  // Under the threshold → clips stream fine; no proxy (permanent source-serve).
  if (stat.size < ctx.cache.proxySkipBelowBytes) {
    // eslint-disable-next-line no-console
    console.log(
      `thumb: background proxy — ${relPath} is ${Math.round(stat.size / 1e6)}MB (< ${Math.round(ctx.cache.proxySkipBelowBytes / 1e6)}MB skip threshold); source streams fine, no proxy`
    );
    return false;
  }

  const proxyDir = resolveCacheFileDir(ctx.cacheRoot, ctx.deviceId, relPath);
  const proxyPath = cacheProxyPath(proxyDir);
  if (await isFresh(proxyPath, stat.mtimeMs)) {
    // eslint-disable-next-line no-console
    console.log(`thumb: background proxy — ${relPath} already has a fresh proxy; nothing to build`);
    return true; // someone else made it
  }

  const info = await ctx.generator.probeVideoInfo(sourceFullPath);
  if (info == null) {
    // eslint-disable-next-line no-console
    console.warn(
      `thumb: background proxy — ffprobe could not read ${relPath} (unsupported container/codec?); serving source only`
    );
    return false;
  }
  // Source already fits a 1280×720 box → proxying down would be larger; serve
  // the source. (No proxy ever appears for these, so no mid-session flip risk.)
  if (info.width <= 1280 && info.height <= 720) {
    // eslint-disable-next-line no-console
    console.log(
      `thumb: background proxy — ${relPath} is ${info.width}x${info.height} (≤720p); source already small enough, no proxy`
    );
    return false;
  }

  assertWithinCacheRoot(proxyPath, ctx.cacheRoot);
  await fs.mkdir(proxyDir, { recursive: true });
  // eslint-disable-next-line no-console
  console.log(
    `thumb: background 720p proxy for ${relPath} (${Math.round(stat.size / 1e6)}MB source, ${info.width}x${info.height}, crf${ctx.cache.proxyQualityCrf}) — preview will use the source until it lands`
  );
  const startedAt = Date.now();
  // TODO(doc59: orchestrator): extension point for the upload-transcode consumer
  // (doc 59 Part 3). This background-proxy path is the PLAYBACK-side consumer of
  // the shared ffmpeg orchestrator (generateProxy); the UPLOAD-side consumer
  // (resolution-preserved shrink-to-fit for platform compliance) plugs in here,
  // sharing generator.generateProxy's spawn helper + CPU-budget gating + the
  // future TRANSCODE_KILL control frame. Keep both consumers on this one API.
  const ok = await ctx.generator.generateProxy(sourceFullPath, proxyPath, {
    crf: ctx.cache.proxyQualityCrf,
  });
  if (ok) {
    state.thumbSyncStats.proxiesWritten += 1;
    // V0.7.d frequency-adaptive TTL: persist the gateway's per-proxy TTL hint as
    // a sidecar so a recurring file's proxy outlives the flat TTL between
    // sessions. Best-effort; an absent sidecar just means the flat TTL applies.
    if (proxyTtlMinutes != null && Number.isFinite(proxyTtlMinutes) && proxyTtlMinutes >= 1) {
      const ttlPath = cacheProxyTtlPath(proxyDir);
      try {
        assertWithinCacheRoot(ttlPath, ctx.cacheRoot);
        await fs.writeFile(ttlPath, String(Math.floor(proxyTtlMinutes)), 'utf8');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`thumb: failed to write proxy TTL sidecar for ${relPath}: ${(err as Error).message}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `thumb: background proxy ready for ${relPath} in ${Math.round((Date.now() - startedAt) / 1000)}s` +
        (proxyTtlMinutes != null ? ` (ttl ${Math.floor(proxyTtlMinutes)}m)` : '')
    );
  } else {
    state.thumbSyncStats.proxiesFailed += 1;
  }
  return ok;
}

/** Walk just a subtree of the source root, yielding entries with relPaths that
 *  stay relative to the source root (so detection + path policy are unchanged).
 *  projectRelPath '' walks the whole root. */
async function walkSubtree(
  sourceRoot: string,
  projectRelPath: string
): Promise<FileEntry[]> {
  const plugin = new LocalFSPlugin(sourceRoot);
  const out: FileEntry[] = [];
  for await (const entry of plugin.walkFrom(projectRelPath)) {
    out.push(entry);
  }
  return out;
}

/**
 * Shared per-run engine: group entries by detected project, process each video
 * with the configured concurrency + delay. `projectFilter` decides whether a
 * detected project's files are processed (the enabled-set filter for the daily
 * walk; always-true for a scoped project sync).
 */
async function processEntries(
  ws: WebSocket,
  config: BridgeConfig,
  state: ThumbOrchestratorState,
  ctx: GenContext,
  entries: FileEntry[],
  abort: { stopped: boolean },
  projectFilter: (projectRelPath: string) => boolean
): Promise<void> {
  // Group entries by their detected project. Files NOT in a canonical type
  // folder are counted as skipped-untyped and skipped during processing.
  const projects = new Map<
    string,
    { entries: FileEntry[]; matchedFolders: Set<string> }
  >();
  for (const entry of entries) {
    if (entry.isDir) continue;
    const kind = thumbKindForMime(entry.mime);
    if (kind !== 'video') continue;
    const detected = detectContentType(entry.relPath);
    if (!detected) {
      state.thumbSyncStats.videosSkippedUntyped += 1;
      continue;
    }
    // V0.7.b: only full videos + teasers get generated thumbs (operator decision
    // to cap the Bridge Thumbnails footprint now that those images are indexed).
    if (!shouldGenerateThumbs(detected)) continue;
    if (!projectFilter(detected.projectPath)) continue;
    const key = detected.projectPath;
    let group = projects.get(key);
    if (!group) {
      group = { entries: [], matchedFolders: new Set() };
      projects.set(key, group);
    }
    group.entries.push(entry);
    group.matchedFolders.add(detected.matchedFolderName);
  }

  // Helpful display label for log lines — show the host-side path when the
  // operator passed CONTENT_BRIDGE_HOST_CONTENT_PATH through to the container.
  const projectLogLabel = (projectPath: string): string => {
    if (config.hostContentPath) {
      return projectPath
        ? `${config.hostContentPath}/${projectPath}`
        : config.hostContentPath;
    }
    return projectPath || '<mount root>';
  };

  for (const [projectPath, group] of projects) {
    if (abort.stopped) {
      // eslint-disable-next-line no-console
      console.log('thumb: aborted (ws closed mid-sync)');
      return;
    }
    const projectLabel = projectLogLabel(projectPath);
    const folderList = [...group.matchedFolders].sort().join(', ');
    // eslint-disable-next-line no-console
    console.log(
      `thumb: starting [${projectLabel}] — reading [${folderList}] (${group.entries.length} videos, mode=${ctx.outputMode}, concurrency=${ctx.effective.concurrency})`
    );

    const projectStartedAt = Date.now();
    const startCount = state.thumbSyncStats.thumbsWritten;

    await runWithConcurrency(group.entries, ctx.effective.concurrency, async (entry) => {
      if (abort.stopped) return;
      state.thumbSyncStats.lastFilePath = entry.relPath;
      const detected = detectContentType(entry.relPath);
      if (!detected) return; // can't happen — we grouped on this — guard anyway
      try {
        await processVideo(ws, config, state, ctx, entry, detected.positions);
      } catch (err) {
        state.thumbSyncStats.videosFailed += 1;
        // eslint-disable-next-line no-console
        console.warn(`thumb: failed for ${entry.relPath}: ${(err as Error).message}`);
      }
      if (ctx.effective.delayMs > 0 && !abort.stopped) {
        await sleep(ctx.effective.delayMs);
      }
    });

    const projectThumbsWritten = state.thumbSyncStats.thumbsWritten - startCount;
    const projectElapsedSec = Math.round((Date.now() - projectStartedAt) / 1000);
    // eslint-disable-next-line no-console
    console.log(
      `thumb: finished [${projectLabel}] — ${projectThumbsWritten} thumbs in ${projectElapsedSec}s`
    );
  }
}

/** True if `artifactPath` exists AND is at least as new as the source (mtime
 *  gate). A missing artifact, or one older than the source (re-export), is
 *  stale → returns false so the caller regenerates. */
async function isFresh(artifactPath: string, sourceMtimeMs: number): Promise<boolean> {
  try {
    const st = await fs.stat(artifactPath);
    return sourceMtimeMs <= st.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Process one video: generate any missing/stale thumbs (written per output mode
 * — in_place in-project, or cache_dir under `_cache`) plus, on the on-demand
 * flow only, a 720p proxy (always in the evictable `_cache`, for qualifying
 * sources). Push every thumb to the gateway regardless of mode (the gateway
 * store is authoritative for browser reads). mtime-aware skip per artifact makes
 * re-runs near-free.
 */
async function processVideo(
  ws: WebSocket,
  config: BridgeConfig,
  state: ThumbOrchestratorState,
  ctx: GenContext,
  entry: FileEntry,
  positions: number[]
): Promise<void> {
  const sourceFullPath = path.join(config.sourceRoot, entry.relPath);
  const sourceMtimeMs = entry.mtime;

  // Resolve the per-position thumb write paths for the active output mode.
  // in_place → the V0.3 in-project thumb tree; cache_dir → the cache dir.
  const writePaths: Array<{ position: number; fullPath: string }> = [];
  let writeDir: string;
  let assertSafe: (p: string) => void;

  if (ctx.outputMode === 'cache_dir') {
    writeDir = resolveCacheFileDir(ctx.cacheRoot, ctx.deviceId, entry.relPath);
    assertSafe = (p) => assertWithinCacheRoot(p, ctx.cacheRoot);
    for (const position of positions) {
      writePaths.push({ position, fullPath: cacheThumbPath(writeDir, position) });
    }
  } else {
    // in_place — every position must resolve to the project's thumb tree.
    let resolvedDir: string | null = null;
    for (const position of positions) {
      const decision = resolveThumbWritePath(
        ctx.thumbWritableRoot,
        ctx.effective.subpathWithinProject,
        entry.relPath,
        position
      );
      if (!decision.ok) {
        // eslint-disable-next-line no-console
        console.warn(
          `thumb: path policy rejected ${entry.relPath} pos=${position}: ${decision.reason}`
        );
        return;
      }
      resolvedDir = decision.fullDir;
      writePaths.push({ position, fullPath: decision.fullPath });
    }
    writeDir = resolvedDir as string;
    assertSafe = (p) => assertWritePathSafe(p, ctx.thumbWritableRoot);
  }

  // Decide proxy need up front. The proxy ALWAYS lives in the evictable cache
  // (`_cache`), independent of the thumb output mode — so `in_place` thumbs
  // (readable, in-project) coexist with on-demand `_cache` proxies. Gated by
  // `ctx.generateProxies` (true only on the on-demand flow; batch Sync/daily
  // make thumbs only — proxies are 100-200x larger and only watched ones matter).
  const proxyDir = ctx.generateProxies
    ? resolveCacheFileDir(ctx.cacheRoot, ctx.deviceId, entry.relPath)
    : null;
  const proxyPath = proxyDir !== null ? cacheProxyPath(proxyDir) : null;
  const proxySizeQualifies =
    proxyPath !== null && entry.size >= ctx.cache.proxySkipBelowBytes;

  // mtime-aware short-circuit: if every thumb is fresh AND (no proxy wanted OR
  // proxy fresh / size-skipped), nothing to do.
  const thumbFreshness = await Promise.all(
    writePaths.map((p) => isFresh(p.fullPath, sourceMtimeMs))
  );
  const allThumbsFresh = thumbFreshness.every(Boolean);
  const proxyFreshOrSkipped =
    proxyPath === null ||
    !proxySizeQualifies ||
    (await isFresh(proxyPath, sourceMtimeMs));
  if (allThumbsFresh && proxyFreshOrSkipped) {
    state.thumbSyncStats.videosSkippedAlreadyThumbed += 1;
    return;
  }

  // Probe duration + dimensions once (needed for %-positions + the ≤720p
  // proxy-skip rule). Unreadable / zero-duration → skip the file.
  const info = await ctx.generator.probeVideoInfo(sourceFullPath);
  if (info == null) {
    state.thumbSyncStats.videosFailed += 1;
    return;
  }

  // Defense-in-depth: validate every write path before mkdir + before each
  // write. Throws on any path outside the mode's root or any non-canonical
  // filename.
  for (const { fullPath } of writePaths) assertSafe(fullPath);
  await fs.mkdir(writeDir, { recursive: true });

  for (let i = 0; i < writePaths.length; i++) {
    const { position, fullPath } = writePaths[i];
    if (thumbFreshness[i]) continue; // already fresh — skip
    // Position 0 = exact first frame; otherwise scale by duration.
    const ts = position === 0 ? 0 : (info.durationSec * position) / 100;
    const result = await ctx.generator.generateVideoThumb(sourceFullPath, ts, position);
    if (!result) {
      state.thumbSyncStats.videosFailed += 1;
      continue;
    }
    assertSafe(fullPath); // re-assert on every write (cheap, catches in-loop bugs)
    await fs.writeFile(fullPath, result.jpegBytes);
    state.thumbSyncStats.thumbsWritten += 1;
    if (sendThumbFrame(ws, entry.relPath, position, result, config.encryptionKeyHex)) {
      state.thumbSyncStats.thumbsPushed += 1;
    }
  }

  // 720p preview proxy → always the evictable `_cache` (independent of thumb
  // mode). Skip rules (arch-note 14 §4): size under threshold (clips stream
  // fine) OR source already fits a 1280×720 box (proxying down would be larger).
  // Otherwise transcode if missing/stale.
  if (proxyPath !== null && proxyDir !== null) {
    const fitsBox = info.width <= 1280 && info.height <= 720;
    if (!proxySizeQualifies || fitsBox) {
      state.thumbSyncStats.proxiesSkipped += 1;
    } else if (await isFresh(proxyPath, sourceMtimeMs)) {
      // already fresh — nothing to do
    } else {
      assertWithinCacheRoot(proxyPath, ctx.cacheRoot);
      await fs.mkdir(proxyDir, { recursive: true });
      // eslint-disable-next-line no-console
      console.log(
        `thumb: generating 720p proxy for ${entry.relPath} (${Math.round(entry.size / 1e6)}MB source, ${info.width}x${info.height}, crf${ctx.cache.proxyQualityCrf}) — this can take a while`
      );
      const startedAt = Date.now();
      const ok = await ctx.generator.generateProxy(sourceFullPath, proxyPath, {
        crf: ctx.cache.proxyQualityCrf,
      });
      if (ok) {
        state.thumbSyncStats.proxiesWritten += 1;
        // eslint-disable-next-line no-console
        console.log(
          `thumb: proxy ready for ${entry.relPath} in ${Math.round((Date.now() - startedAt) / 1000)}s`
        );
      } else {
        state.thumbSyncStats.proxiesFailed += 1;
      }
    }
  }

  state.thumbSyncStats.videosProcessed += 1;
}

function sendThumbFrame(
  ws: WebSocket,
  relPath: string,
  position: number,
  result: { jpegBytes: Buffer; width: number; height: number },
  encryptionKeyHex: string
): boolean {
  if (ws.readyState !== 1 /* WebSocket.OPEN */) return false;
  const { nonce, ciphertext } = encryptAesGcm(encryptionKeyHex, result.jpegBytes);
  const frame = {
    type: 'THUMB',
    relPath,
    position,
    mime: 'image/jpeg',
    width: result.width,
    height: result.height,
    nonceHex: nonce.toString('hex'),
    ciphertextB64: ciphertext.toString('base64'),
  };
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run `worker` over `items` with at most `concurrency` in-flight at once.
 * Slot opens as soon as any worker finishes (vs chunking, which would
 * stall until every slot in the chunk is done). Each worker error is
 * caught + swallowed here so one bad video doesn't drop the whole batch —
 * processVideo already does its own try/catch + stats accounting.
 *
 * Simple semaphore via Set<Promise> + Promise.race. No external dep.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const safeConcurrency = Math.max(1, Math.floor(concurrency));
  if (safeConcurrency === 1 || items.length <= 1) {
    for (const item of items) {
      await worker(item).catch(() => undefined);
    }
    return;
  }
  const inFlight = new Set<Promise<void>>();
  for (const item of items) {
    if (inFlight.size >= safeConcurrency) {
      await Promise.race(inFlight);
    }
    const p = worker(item)
      .catch(() => undefined)
      .finally(() => {
        inFlight.delete(p);
      });
    inFlight.add(p);
  }
  await Promise.all(inFlight);
}
