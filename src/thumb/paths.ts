// Thumb path policy — Phase F V0.3.
//
// Output path scheme (flat):
//   <thumbWritableRoot>/<projectPath?>/<subpathWithinProject>/<typeLabel>/<filename>.thumb-{position}.jpg
//
// Where:
//   - <projectPath> = path segments before the matched type folder. Empty
//     when the type folder is at the mount root (mount root IS the project).
//   - <subpathWithinProject> = configurable (default `Pics/Bridge Thumbnails`)
//   - <typeLabel> = output type subfolder (`Clip`, `Full Video`, `Teaser`, `Trailer`)
//   - <filename> = the source file's BASENAME only — no source-folder
//     subdirectories preserved. All clips across all `Clips*`-matching
//     source folders land FLAT in the `Clip/` output. Source file
//     organization in the DB (content_bridge_thumbs.file_id →
//     content_bridge_files.rel_path) is the source of truth for "which
//     source file does this thumb belong to" — the local filesystem layout
//     is just a convenience for the operator to browse.
//
// Filename collision behavior: if two source files in different matched
// folders share the same filename (e.g. `Clips/foo.mp4` and
// `Clips - Variant/foo.mp4`), they'd write to the SAME thumb path and the
// second would overwrite the first. Operator accepted this 2026-06-04:
// filenames in practice are unique enough within a content project, and
// the DB association is the canonical mapping.
//
// Defense-in-depth: every write goes through `resolveThumbWritePath` which
// validates the resolved path is within `<thumbWritableRoot>/.../`. Path
// traversal attempts (relPath with `..`, absolute, etc.) reject before any
// fs call.

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { detectContentType, type DetectedType } from './types';

/**
 * Bridge-boundary guard for any gateway-supplied path that becomes a filesystem
 * READ or WALK root (GENERATE.relPath, SYNC_PROJECT.projectRelPath). Returns
 * true for anything that isn't a clean root-relative POSIX path — absolute, or
 * containing a `..` segment. The bridge treats the gateway as potentially
 * compromised (arch-note 14 §3), so it re-validates these the same way the
 * write paths already do (`resolveThumbWritePath`) rather than trusting that the
 * gateway only ever sends in-tree paths from its own walk. Empty string ('' =
 * mount root) is safe.
 */
export function isUnsafeRelPath(rel: string): boolean {
  if (typeof rel !== 'string') return true;
  if (rel === '') return false;
  if (path.posix.isAbsolute(rel)) return true;
  return path.posix.normalize(rel).split('/').some((seg) => seg === '..');
}

export interface ThumbPathDecision {
  ok: true;
  /** Absolute path inside the writable mount where the JPEG will be written. */
  fullPath: string;
  /** Parent directory of `fullPath` — caller mkdir's this with { recursive: true }. */
  fullDir: string;
  /** Detected type (passes through so the orchestrator can use positions). */
  detected: DetectedType;
}

export type ThumbPathResult =
  | ThumbPathDecision
  | { ok: false; reason: string };

/**
 * Compute where a thumb file should be written for a given source-relative
 * path and position. Returns the full write path or a structured rejection.
 *
 * Returns `ok: false` (skip silently) for files that don't sit inside one of
 * the canonical type folders (Clips / Final Video / Teaser). The orchestrator
 * uses the rejection reason for logging but doesn't fail the sync.
 */
export function resolveThumbWritePath(
  thumbWritableRoot: string,
  subpathWithinProject: string,
  sourceRelPath: string,
  position: number
): ThumbPathResult {
  // 1. Reject absolute paths + path-traversal.
  if (path.isAbsolute(sourceRelPath)) {
    return { ok: false, reason: 'sourceRelPath must be relative' };
  }
  const normalized = path.posix.normalize(sourceRelPath);
  if (
    normalized.startsWith('..') ||
    normalized.split('/').some((s) => s === '..')
  ) {
    return { ok: false, reason: 'sourceRelPath escapes source root via ..' };
  }

  // 2. Sanity-check the configured sub-path.
  if (path.posix.isAbsolute(subpathWithinProject)) {
    return { ok: false, reason: 'subpathWithinProject must be relative' };
  }
  if (subpathWithinProject.split('/').some((s) => s === '..')) {
    return { ok: false, reason: 'subpathWithinProject cannot contain ..' };
  }

  // 3. Detect the type from the source path.
  const detected = detectContentType(normalized);
  if (!detected) {
    return {
      ok: false,
      reason: `no canonical type folder (Clips / Final Video / Teaser) in path "${sourceRelPath}"`,
    };
  }

  // 4. Build the thumb path (flat):
  //    <writableRoot>/<project?>/<subpath>/<typeLabel>/<filename>.thumb-{N}.jpg
  //
  // Use only the source file's BASENAME — drop any directory structure
  // after the matched type folder. All `Clips*`-matching sources flatten
  // into one `Clip/` output. See header for collision rationale.
  const filename = detected.rest
    ? path.posix.basename(detected.rest)
    : null;
  if (!filename) {
    return { ok: false, reason: 'no filename in path (directory entry?)' };
  }

  const thumbFile = `${filename}.thumb-${position}.jpg`;

  // projectThumbsRoot = where the per-project Bridge Thumbnails lives.
  // If projectPath is empty (mount root IS the project), it's writableRoot
  // joined directly with the subpath. Otherwise mount root + project + subpath.
  const projectAbs = detected.projectPath
    ? path.posix.join(thumbWritableRoot, detected.projectPath)
    : thumbWritableRoot;
  const projectThumbsRoot = path.posix.join(
    projectAbs,
    subpathWithinProject,
    detected.outputLabel
  );

  const fullDir = projectThumbsRoot;
  const fullPath = path.posix.join(fullDir, thumbFile);

  // 5. Belt-and-suspenders: the resolved fullPath must start with
  //    projectThumbsRoot + '/'.
  if (!fullPath.startsWith(projectThumbsRoot + '/')) {
    return {
      ok: false,
      reason: `resolved write path ${fullPath} is outside per-project thumbs root ${projectThumbsRoot}`,
    };
  }

  return { ok: true, fullPath, fullDir, detected };
}

// ─── V0.6.b cache-dir output mode ────────────────────────────────────────────
//
// In `cache_dir` mode the orchestrator writes thumbs + 720p proxies under a
// per-file directory in the RW cache mount (never into the creator's content
// tree). Layout (arch-note 14 §4):
//
//   <cacheRoot>/<deviceId>/<fileKey>/thumb-{position}.jpg
//   <cacheRoot>/<deviceId>/<fileKey>/preview.mp4
//
// CACHE KEY (design decision, V0.6.b): `fileKey` = sha256(relPath) hex. The
// bridge cache is a LOCAL optimization — the gateway's content_bridge_thumbs
// store (keyed by the gateway-assigned file_id) is authoritative for browser
// reads, and the bridge cache is never read by the SaaS browser path. So the
// cache doesn't need the gateway file_id; a stable rel-path-derived key avoids
// a round-trip (works during the daily scan / on-enable before any INDEX ack),
// is deterministic for the mtime-aware skip on restart, and the V0.6.c /stream
// path can recompute it from the relPath the gateway already resolved.

/**
 * THE canonical relPath normalizer for cache keying. Both ends of the cache
 * MUST key through this one function so their hashes match:
 *   - GEN time: the orchestrator hashes the LocalFSPlugin walk's `relPath`
 *     (a `path.posix.join(...)` result — already forward-slash, no trailing
 *     slash). The same string is shipped verbatim in INDEX_BATCH.
 *   - READ time (V0.6.c): the gateway stores that relPath and echoes it in the
 *     READ_REQUEST; the bridge hashes the echoed string.
 * As long as both call `cacheKeyForRelPath` (which funnels through here), there
 * is a single normalization point — no trailing-slash / separator drift can
 * desync the two hashes. Unicode form is whatever the filesystem reports and is
 * preserved identically on both sides (the gateway stores the exact bytes).
 */
export function normalizeRelPathForCacheKey(relPath: string): string {
  // Strip a leading './', collapse '//', drop any trailing slash. POSIX in.
  const normalized = path.posix.normalize(relPath);
  return normalized.endsWith('/') && normalized.length > 1
    ? normalized.slice(0, -1)
    : normalized;
}

/** Stable per-file cache key — sha256(normalizeRelPathForCacheKey(relPath)),
 *  hex. POSIX relPath in. */
export function cacheKeyForRelPath(relPath: string): string {
  const normalized = normalizeRelPathForCacheKey(relPath);
  // Drift assertion (supervisor flag): the walk + the gateway-echoed relPath
  // should ALREADY be canonical, so normalization must be a no-op. If it isn't,
  // a non-canonical relPath reached the keyer and gen-time vs read-time hashes
  // could desync — surface it loudly rather than silently mis-keying the cache.
  if (normalized !== relPath) {
    // eslint-disable-next-line no-console
    console.warn(
      `cache-key: relPath was not already canonical ("${relPath}" → "${normalized}") — ` +
        `gen-time and read-time keys must share this normalizer or the cache will desync`
    );
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** The per-file cache directory: <cacheRoot>/<deviceId>/<fileKey>. */
export function resolveCacheFileDir(
  cacheRoot: string,
  deviceId: number | string,
  relPath: string
): string {
  return path.posix.join(
    path.posix.normalize(cacheRoot),
    String(deviceId),
    cacheKeyForRelPath(relPath)
  );
}

/** Thumb file path inside a per-file cache dir. */
export function cacheThumbPath(fileDir: string, position: number): string {
  return path.posix.join(fileDir, `thumb-${position}.jpg`);
}

/** 720p preview-proxy path inside a per-file cache dir. */
export function cacheProxyPath(fileDir: string): string {
  return path.posix.join(fileDir, 'preview.mp4');
}

/**
 * doc 59 V0.7-A: downscaled picker thumbnail (≤800px, ~80% JPEG) for a LARGE
 * source IMAGE, so the picker loads ~50–100KB instead of streaming the full file.
 * Lives in the same per-file cache dir as the thumbs/proxy; mtime-skip + the
 * cache-manager evict it alongside them.
 */
export function cachePickerPath(fileDir: string): string {
  return path.posix.join(fileDir, 'picker.jpg');
}

// ─── doc 59 Part 3: upload-transcode cache dir ───────────────────────────────
//
// The shrink-to-fit transcode output lives in a SEPARATE cache subtree from the
// preview proxies (arch-note 14 §4 sibling pipeline). Layout:
//   <cacheRoot>/<deviceId>/upload/<transcodeKey>/output.mp4
//   <cacheRoot>/<deviceId>/upload/<transcodeKey>/poster.jpg   (free poster frame)
//
// CACHE KEY: sha256(source_bridge_ref | platform | target_band). Deterministic
// from the cache-key tuple the SaaS sends, so the bridge derives its OWN safe
// output path rather than trusting a gateway-supplied one (same untrusted-gateway
// posture as the thumb/proxy write paths). The path is realpath-confined by
// `assertWithinCacheRoot` below before any write.

/** sha256(source_bridge_ref | platform | target_band) hex — the transcode cache key. */
export function transcodeCacheKey(
  sourceBridgeRef: string,
  platform: string,
  targetBand: number | string
): string {
  return createHash('sha256')
    .update(`${sourceBridgeRef}|${platform}|${targetBand}`, 'utf8')
    .digest('hex');
}

/** The per-transcode cache dir: <cacheRoot>/<deviceId>/upload/<transcodeKey>. */
export function resolveTranscodeOutputDir(
  cacheRoot: string,
  deviceId: number | string,
  transcodeKey: string
): string {
  return path.posix.join(
    path.posix.normalize(cacheRoot),
    String(deviceId),
    'upload',
    transcodeKey
  );
}

/** Transcode output (`output.mp4`) inside a per-transcode cache dir. */
export function cacheTranscodeOutputPath(transcodeDir: string): string {
  return path.posix.join(transcodeDir, 'output.mp4');
}

/** Free poster frame (`poster.jpg`) inside a per-transcode cache dir. */
export function cacheTranscodePosterPath(transcodeDir: string): string {
  return path.posix.join(transcodeDir, 'poster.jpg');
}

/**
 * V0.7.d: per-proxy TTL sidecar. A tiny text file (TTL in minutes) written at
 * build time from the gateway's frequency-adaptive TTL hint. The cache manager
 * reads it so a spread-out-but-recurring file's proxy survives between sessions
 * while a one-off keeps the flat `proxy_cache_ttl_minutes`. Absent → flat TTL.
 * Lives in the same per-file cache dir as `preview.mp4`; evicted with it.
 */
export function cacheProxyTtlPath(fileDir: string): string {
  return path.posix.join(fileDir, 'preview.ttl');
}

/** Canonical cache-artifact filenames the bridge is allowed to write/evict.
 *  `preview.ttl` is the V0.7.d per-proxy TTL sidecar (see cacheProxyTtlPath).
 *  `output.mp4` + `poster.jpg` are the doc 59 Part 3 upload-transcode artifacts.
 *  `picker.jpg` is the doc 59 V0.7-A downscaled picker thumbnail. */
const CACHE_FILENAME_RE =
  /^(thumb-\d+\.jpg|preview\.mp4|preview\.ttl|output\.mp4|poster\.jpg|picker\.jpg)$/;

/**
 * Defense-in-depth guard for the cache_dir write path — the cache analogue of
 * `assertWritePathSafe`. The resolved path must sit inside `cacheRoot` and the
 * basename must match the canonical cache-artifact pattern (a thumb JPEG or the
 * preview proxy). Throws before any fs call otherwise.
 */
export function assertWithinCacheRoot(fullPath: string, cacheRoot: string): void {
  const normalizedRoot = path.posix.normalize(cacheRoot);
  const rootWithSlash = normalizedRoot.endsWith('/')
    ? normalizedRoot
    : normalizedRoot + '/';
  const normalizedPath = path.posix.normalize(fullPath);
  if (!normalizedPath.startsWith(rootWithSlash)) {
    throw new Error(
      `refusing to write/evict outside cacheRoot: ${fullPath} (root=${normalizedRoot})`
    );
  }
  const base = path.posix.basename(normalizedPath);
  if (!CACHE_FILENAME_RE.test(base)) {
    throw new Error(
      `refusing to touch cache file that doesn't match the cache-artifact pattern: ${base}`
    );
  }
}
