// Tiered cache manager — Phase F V0.6.b.
//
// The bridge's RW cache mount (`/data/cache/<deviceId>/<fileKey>/`) holds
// generated thumbs (`thumb-{N}.jpg`) and 720p preview proxies (`preview.mp4`).
// Proxies are ~100-200x larger per video than thumbs AND have a totally
// different access pattern — thumbs are browsed library-wide for weeks,
// proxies are session-scoped (used only while actively scrubbing one file). So
// eviction is TIERED rather than a naive shared LRU (arch-note 14 §4):
//
//   1. Drop expired proxies   (idle > proxy_cache_ttl_minutes)
//   2. Drop expired thumbs    (idle > thumb_cache_ttl_days; usually a no-op)
//   3. If still over cache_cap_bytes → drop proxies by LRU
//   4. If still over cap (rare; >2GB of thumbs alone) → drop thumbs by LRU
//
// "Last access" is the artifact's mtime. The touch-on-read that keeps an
// actively-scrubbed proxy alive (`touchCacheArtifact`) is wired into the
// byte-range READ path in V0.6.c; this module already honors it.
//
// NO-DELETE caveat (planning doc 46, 2026-06-05): the "app never DELETEs"
// principle covers creator content + content_bridge_* DB rows. The cache is
// bridge-generated DERIVATIVE data on a separate RW volume — evicting it is the
// whole point. `assertWithinCacheRoot` guarantees every unlink stays inside
// cacheRoot and only ever touches a thumb/preview artifact, never a content
// root.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { assertWithinCacheRoot, cacheProxyTtlPath } from './paths';
import type { RuntimeCacheSettings } from '../settings/runtime';

export interface CacheEvictionStats {
  scannedFiles: number;
  bytesBefore: number;
  bytesAfter: number;
  expiredProxiesDropped: number;
  expiredThumbsDropped: number;
  lruProxiesDropped: number;
  lruThumbsDropped: number;
}

/** V0.7.d: tiered breakdown for the SaaS cache-visibility panel (arch-note 14
 *  §4 "Cache visibility in SaaS UI"). Thumbs vs proxies split + counts so the
 *  operator sees "thumbs 80MB · proxies 1.2GB / 2GB cap (proxies evict first)".
 *  Sidecars (`preview.ttl`) are tiny + not counted as artifacts. */
export interface CacheSummary {
  thumbsBytes: number;
  proxiesBytes: number;
  totalBytes: number;
  thumbsCount: number;
  proxiesCount: number;
}

/** V0.7.d: result of a manual Clear cache / Clear proxies action. */
export interface CacheClearStats {
  removed: number;
  freedBytes: number;
}

interface CacheArtifact {
  fullPath: string;
  kind: 'thumb' | 'proxy';
  sizeBytes: number;
  mtimeMs: number;
  /** V0.7.d: per-proxy TTL override (minutes) from the `preview.ttl` sidecar,
   *  if present. Only ever set for proxies. null → use the flat TTL. */
  ttlMinutesOverride: number | null;
}

/**
 * Refresh an artifact's access time to now. Called by the V0.6.c byte-range
 * READ path on every read so an actively-scrubbed proxy stays alive past its
 * TTL. Never throws (a missing file or a permissions hiccup must not break a
 * read).
 */
export async function touchCacheArtifact(fullPath: string): Promise<void> {
  try {
    const now = new Date();
    await fs.utimes(fullPath, now, now);
  } catch {
    // best-effort — a touch failure just means the file ages from its last
    // real write; not worth surfacing.
  }
}

/** List every cache artifact under <cacheRoot>/<deviceId>. Skips non-artifact
 *  files and unreadable dirs rather than throwing. */
async function listArtifacts(
  cacheRoot: string,
  deviceId: number | string
): Promise<CacheArtifact[]> {
  const deviceDir = path.posix.join(
    path.posix.normalize(cacheRoot),
    String(deviceId)
  );
  let keyDirs: import('node:fs').Dirent[];
  try {
    keyDirs = await fs.readdir(deviceDir, { withFileTypes: true });
  } catch {
    return []; // nothing cached yet
  }
  const out: CacheArtifact[] = [];
  for (const keyDir of keyDirs) {
    if (!keyDir.isDirectory()) continue;
    const fileDir = path.posix.join(deviceDir, keyDir.name);
    let files: import('node:fs').Dirent[];
    try {
      files = await fs.readdir(fileDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile()) continue;
      const kind: 'thumb' | 'proxy' | null =
        f.name === 'preview.mp4'
          ? 'proxy'
          : /^thumb-\d+\.jpg$/.test(f.name)
            ? 'thumb'
            : null;
      if (!kind) continue;
      const fullPath = path.posix.join(fileDir, f.name);
      try {
        const st = await fs.stat(fullPath);
        // V0.7.d: a proxy may carry a per-proxy TTL sidecar (preview.ttl) from
        // the gateway's frequency-adaptive hint; read it so eviction honors a
        // recurring file's longer TTL. Best-effort — absent/garbage → flat TTL.
        let ttlMinutesOverride: number | null = null;
        if (kind === 'proxy') {
          try {
            const raw = await fs.readFile(cacheProxyTtlPath(fileDir), 'utf8');
            const n = Number(raw.trim());
            if (Number.isFinite(n) && n >= 1) ttlMinutesOverride = Math.floor(n);
          } catch {
            // no sidecar — flat TTL applies
          }
        }
        out.push({ fullPath, kind, sizeBytes: st.size, mtimeMs: st.mtimeMs, ttlMinutesOverride });
      } catch {
        // raced away — ignore
      }
    }
  }
  return out;
}

async function evictOne(art: CacheArtifact, cacheRoot: string): Promise<boolean> {
  try {
    // Guard EVERY unlink: must be inside cacheRoot + a canonical artifact name.
    assertWithinCacheRoot(art.fullPath, cacheRoot);
    await fs.unlink(art.fullPath);
    // V0.7.d: a proxy's TTL sidecar is dead weight once the proxy is gone —
    // remove it too (guarded; preview.ttl is a canonical cache-artifact name).
    if (art.kind === 'proxy') {
      const ttlPath = cacheProxyTtlPath(path.posix.dirname(art.fullPath));
      try {
        assertWithinCacheRoot(ttlPath, cacheRoot);
        await fs.unlink(ttlPath);
      } catch {
        // sidecar absent or raced — fine
      }
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`cache: failed to evict ${art.fullPath}: ${(err as Error).message}`);
    return false;
  }
}

/** Remove now-empty per-file cache dirs under <cacheRoot>/<deviceId>. Cache-only
 *  (rmdir of a content folder is impossible — these live under cacheRoot). */
async function pruneEmptyDirs(
  cacheRoot: string,
  deviceId: number | string
): Promise<void> {
  const deviceDir = path.posix.join(
    path.posix.normalize(cacheRoot),
    String(deviceId)
  );
  let keyDirs: import('node:fs').Dirent[];
  try {
    keyDirs = await fs.readdir(deviceDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const keyDir of keyDirs) {
    if (!keyDir.isDirectory()) continue;
    const fileDir = path.posix.join(deviceDir, keyDir.name);
    try {
      const remaining = await fs.readdir(fileDir);
      if (remaining.length === 0) await fs.rmdir(fileDir);
    } catch {
      // non-empty or raced — leave it
    }
  }
}

/**
 * Run one tiered eviction pass for a device's cache. Safe to call on a timer;
 * a no-op when nothing is expired and the cache is under cap.
 */
export async function runCacheEviction(
  cacheRoot: string,
  deviceId: number | string,
  settings: RuntimeCacheSettings
): Promise<CacheEvictionStats> {
  const now = Date.now();
  const proxyTtlMs = settings.proxyCacheTtlMinutes * 60_000;
  const thumbTtlMs = settings.thumbCacheTtlDays * 86_400_000;

  const all = await listArtifacts(cacheRoot, deviceId);
  const stats: CacheEvictionStats = {
    scannedFiles: all.length,
    bytesBefore: all.reduce((s, a) => s + a.sizeBytes, 0),
    bytesAfter: 0,
    expiredProxiesDropped: 0,
    expiredThumbsDropped: 0,
    lruProxiesDropped: 0,
    lruThumbsDropped: 0,
  };

  // Surviving set — start with everything, remove as we evict.
  const live = new Set(all);

  // 1. Expired proxies. V0.7.d: each proxy may carry a per-proxy TTL override
  //    (preview.ttl sidecar, frequency-adaptive); fall back to the flat
  //    proxy_cache_ttl_minutes when absent. So a spread-out-but-recurring file
  //    keeps its proxy across sessions while one-offs expire on the flat TTL.
  for (const art of all) {
    if (art.kind !== 'proxy') continue;
    const ttlMs =
      art.ttlMinutesOverride !== null ? art.ttlMinutesOverride * 60_000 : proxyTtlMs;
    if (now - art.mtimeMs > ttlMs) {
      if (await evictOne(art, cacheRoot)) {
        live.delete(art);
        stats.expiredProxiesDropped += 1;
      }
    }
  }

  // 2. Expired thumbs.
  for (const art of all) {
    if (art.kind !== 'thumb') continue;
    if (now - art.mtimeMs > thumbTtlMs) {
      if (await evictOne(art, cacheRoot)) {
        live.delete(art);
        stats.expiredThumbsDropped += 1;
      }
    }
  }

  let liveBytes = [...live].reduce((s, a) => s + a.sizeBytes, 0);

  // 3. Over cap → LRU proxies (oldest first).
  if (liveBytes > settings.cacheCapBytes) {
    const proxies = [...live]
      .filter((a) => a.kind === 'proxy')
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const art of proxies) {
      if (liveBytes <= settings.cacheCapBytes) break;
      if (await evictOne(art, cacheRoot)) {
        live.delete(art);
        liveBytes -= art.sizeBytes;
        stats.lruProxiesDropped += 1;
      }
    }
  }

  // 4. Still over cap → LRU thumbs (rare; >cap of thumbs alone).
  if (liveBytes > settings.cacheCapBytes) {
    const thumbs = [...live]
      .filter((a) => a.kind === 'thumb')
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const art of thumbs) {
      if (liveBytes <= settings.cacheCapBytes) break;
      if (await evictOne(art, cacheRoot)) {
        live.delete(art);
        liveBytes -= art.sizeBytes;
        stats.lruThumbsDropped += 1;
      }
    }
  }

  stats.bytesAfter = liveBytes;

  const dropped =
    stats.expiredProxiesDropped +
    stats.expiredThumbsDropped +
    stats.lruProxiesDropped +
    stats.lruThumbsDropped;
  if (dropped > 0) {
    await pruneEmptyDirs(cacheRoot, deviceId);
    // eslint-disable-next-line no-console
    console.log(
      `cache: evicted ${dropped} artifact(s) ` +
        `(expired proxy=${stats.expiredProxiesDropped} thumb=${stats.expiredThumbsDropped}, ` +
        `lru proxy=${stats.lruProxiesDropped} thumb=${stats.lruThumbsDropped}); ` +
        `${Math.round(stats.bytesBefore / 1e6)}MB → ${Math.round(stats.bytesAfter / 1e6)}MB ` +
        `(cap ${Math.round(settings.cacheCapBytes / 1e6)}MB)`
    );
  }
  return stats;
}

/**
 * V0.7.d: tiered cache breakdown for the SaaS cache-visibility panel. Read-only
 * walk (no eviction); cheap for a per-device, capped cache. Sidecars aren't
 * counted (they're tiny + not artifacts).
 */
export async function summarizeCache(
  cacheRoot: string,
  deviceId: number | string
): Promise<CacheSummary> {
  const all = await listArtifacts(cacheRoot, deviceId);
  const summary: CacheSummary = {
    thumbsBytes: 0,
    proxiesBytes: 0,
    totalBytes: 0,
    thumbsCount: 0,
    proxiesCount: 0,
  };
  for (const art of all) {
    if (art.kind === 'proxy') {
      summary.proxiesBytes += art.sizeBytes;
      summary.proxiesCount += 1;
    } else {
      summary.thumbsBytes += art.sizeBytes;
      summary.thumbsCount += 1;
    }
  }
  summary.totalBytes = summary.thumbsBytes + summary.proxiesBytes;
  return summary;
}

/**
 * V0.7.d: operator-initiated cache clear from the SaaS UI. `scope='proxies'`
 * drops only proxies (the big, regenerable, session-scoped ones); `scope='all'`
 * also drops thumbs (which re-render on demand). Same no-DELETE caveat as
 * eviction — the cache is bridge-generated derivative data on the owned RW
 * volume; `evictOne` guards every unlink with `assertWithinCacheRoot`.
 */
export async function clearCache(
  cacheRoot: string,
  deviceId: number | string,
  scope: 'all' | 'proxies'
): Promise<CacheClearStats> {
  const all = await listArtifacts(cacheRoot, deviceId);
  const stats: CacheClearStats = { removed: 0, freedBytes: 0 };
  for (const art of all) {
    if (scope === 'proxies' && art.kind !== 'proxy') continue;
    if (await evictOne(art, cacheRoot)) {
      stats.removed += 1;
      stats.freedBytes += art.sizeBytes;
    }
  }
  if (stats.removed > 0) {
    await pruneEmptyDirs(cacheRoot, deviceId);
    // eslint-disable-next-line no-console
    console.log(
      `cache: cleared ${stats.removed} ${scope === 'proxies' ? 'proxy' : 'artifact'}(s), ` +
        `freed ${Math.round(stats.freedBytes / 1e6)}MB (operator-initiated, scope=${scope})`
    );
  }
  return stats;
}
