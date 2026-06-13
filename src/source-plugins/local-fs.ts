// LocalFSPlugin — Phase F V0.2.
//
// Recursively walks the configured source root using fs.promises. Skips
// non-regular-file / non-directory entries (symlinks, sockets, devices)
// rather than chasing them, to keep V0 path-traversal containment trivial.
//
// MIME inference is from filename extension only (no magic-byte sniff in
// V0 — `file(1)` isn't in the Alpine base image and stat-then-read for
// every file would dominate walk time on large trees).

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileEntry, SourcePlugin } from './types';

/** One immediate child folder in a live `listDirImmediate` result. */
export interface LiveDirEntry {
  name: string;
  /** Path relative to the root (same namespace as the file index). */
  relPath: string;
}

/** One immediate child media file in a live `listDirImmediate` result. */
export interface LiveFileEntry {
  name: string;
  relPath: string;
  size: number;
  mime: string;
}

/** Live, non-recursive listing of one directory (V0.7.a unified picker). */
export interface LiveDirListing {
  /** The (normalized, root-relative) directory that was listed; '' = root. */
  relPath: string;
  dirs: LiveDirEntry[];
  files: LiveFileEntry[];
}

/** Live, RECURSIVE listing of every media file under one subtree (V0.9b). */
export interface LiveSubtreeListing {
  /** The (normalized, root-relative) subtree that was scanned; '' = root. */
  relPath: string;
  files: LiveFileEntry[];
}

export class LocalFSPlugin implements SourcePlugin {
  readonly id = 'local-fs';
  readonly label = 'Local Filesystem';

  constructor(public readonly rootPath: string) {}

  async *walk(): AsyncIterable<FileEntry> {
    yield* this.walkDir('');
  }

  /**
   * Walk just a subtree, starting at `relStartDir` (relative to the root, POSIX
   * separators; '' = whole root). Yielded `relPath`s stay relative to the ROOT
   * (not the subtree) so type detection + thumb-path policy are identical to a
   * full walk. Used by the V0.6.b scoped project / on-demand gen paths.
   */
  async *walkFrom(relStartDir: string): AsyncIterable<FileEntry> {
    const clean = path.posix.normalize(relStartDir || '');
    // Defense-in-depth: never walk a subtree that escapes the root (absolute or
    // any `..` segment). Callers should already guard (orchestrator's
    // isUnsafeRelPath), but a bad start dir must yield nothing rather than walk
    // outside the source root.
    if (
      path.posix.isAbsolute(clean) ||
      clean.split('/').some((seg) => seg === '..')
    ) {
      // eslint-disable-next-line no-console
      console.warn(`local-fs: refusing walkFrom unsafe start dir "${relStartDir}"`);
      return;
    }
    yield* this.walkDir(clean === '.' || clean === '/' ? '' : clean);
  }

  /**
   * Live, NON-recursive listing of one directory's immediate children — the
   * V0.7.a unified-picker "live tree browse". Unlike `walk()` (which feeds the
   * index), this hits the disk on demand so folders/files dropped since the last
   * index show up immediately.
   *
   * Confinement: the resolved target must stay inside the realpath'd root
   * (defeats `..` + symlink escape — the V0.6.a security-review requirement).
   * Returns folders + MEDIA files only (the picker browses content); rel paths
   * stay relative to the ROOT, identical to the index namespace, so a browsed
   * file maps 1:1 to its `content_bridge_files` row (thumbs resolve by rel_path).
   *
   * Throws a coded Error ('invalid-path' | 'not-found' | 'escapes-root' |
   * 'not-a-directory') the caller turns into a LIST_DIR_RESPONSE error.
   */
  async listDirImmediate(relDir: string): Promise<LiveDirListing> {
    const clean = path.posix.normalize(relDir || '');
    if (
      path.posix.isAbsolute(clean) ||
      clean.split('/').some((seg) => seg === '..')
    ) {
      throw new Error('invalid-path');
    }
    const relBase = clean && clean !== '.' && clean !== '/' ? clean : '';
    const target = relBase ? path.join(this.rootPath, relBase) : this.rootPath;

    // Realpath both sides, then assert containment — a symlink inside the root
    // pointing outside it resolves to a path that fails the startsWith guard.
    let realRoot: string;
    try {
      realRoot = await fs.realpath(this.rootPath);
    } catch {
      throw new Error('not-found');
    }
    let realTarget: string;
    try {
      realTarget = await fs.realpath(target);
    } catch {
      throw new Error('not-found');
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new Error('escapes-root');
    }

    let st: import('node:fs').Stats;
    try {
      st = await fs.stat(realTarget);
    } catch {
      throw new Error('not-found');
    }
    if (!st.isDirectory()) throw new Error('not-a-directory');

    const entries = await fs.readdir(realTarget, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const dirs: LiveDirEntry[] = [];
    const files: LiveFileEntry[] = [];
    for (const entry of entries) {
      // Same skip rules as the index walk (dotfiles, Synology metadata, the
      // out-of-content cache dir) so live browse + index show the same tree.
      // V0.7.b: `Bridge Thumbnails` (in-place generated thumbs, under Pics) is
      // NO LONGER skipped — those images are indexed so the thumbnail picker can
      // browse them. Only `_cache` (proxies + staged tweet uploads, outside the
      // content tree) stays excluded.
      if (entry.name.startsWith('.') || entry.name === '@eaDir') continue;
      if (entry.isDirectory() && entry.name === '_cache') {
        continue;
      }
      const childRel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, relPath: childRel });
      } else if (entry.isFile()) {
        const mime = mimeForExtension(path.extname(entry.name));
        if (!mime) continue; // media-only: skip docs/sidecars in the picker browse
        let size = 0;
        try {
          size = (await fs.stat(path.join(realTarget, entry.name))).size;
        } catch {
          size = 0;
        }
        files.push({ name: entry.name, relPath: childRel, size, mime });
      }
      // Symlinks / sockets / devices skipped (Dirent reports them as neither).
    }
    return { relPath: relBase, dirs, files };
  }

  /**
   * Live, RECURSIVE listing of every MEDIA file under `relDir` (relative to the
   * root; '' = whole root) — the V0.9b recursive-scan analogue of
   * `listDirImmediate`. One disk walk replaces the SaaS project-sync scanners'
   * prior N sequential `listDirImmediate` (LIST_DIR) round-trips per project.
   *
   * Confinement: identical to `listDirImmediate` — the resolved START target must
   * stay inside the realpath'd root (defeats `..` + a symlinked start dir). The
   * descent then never follows symlinks (a Dirent symlink reports `isDirectory()
   * === false`, exactly as the index `walkDir` relies on), so no descendant can
   * escape the root the way a followed symlink could.
   *
   * Cruft skips match the index walk + live browse PLUS `_thumbs` (which the
   * SaaS-side recursive browse-walk dropped), so the returned set is identical to
   * what a recursive `bridgeBrowseWalk` produced: dotfiles, `@eaDir`, `_thumbs`,
   * `_cache`. Folders are traversed but not emitted; only media files (an inferred
   * image/* or video/* mime) are returned, each with a ROOT-relative relPath
   * identical to the index namespace.
   *
   * Throws the same coded Errors as `listDirImmediate` ('invalid-path' |
   * 'not-found' | 'escapes-root' | 'not-a-directory') the caller turns into a
   * RECURSIVE_SCAN_RESPONSE error.
   */
  async scanSubtreeImmediate(relDir: string): Promise<LiveSubtreeListing> {
    const clean = path.posix.normalize(relDir || '');
    if (
      path.posix.isAbsolute(clean) ||
      clean.split('/').some((seg) => seg === '..')
    ) {
      throw new Error('invalid-path');
    }
    const relBase = clean && clean !== '.' && clean !== '/' ? clean : '';
    const target = relBase ? path.join(this.rootPath, relBase) : this.rootPath;

    // Realpath both sides, then assert containment — a symlinked start dir
    // pointing outside the root resolves to a path that fails the startsWith guard.
    let realRoot: string;
    try {
      realRoot = await fs.realpath(this.rootPath);
    } catch {
      throw new Error('not-found');
    }
    let realTarget: string;
    try {
      realTarget = await fs.realpath(target);
    } catch {
      throw new Error('not-found');
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new Error('escapes-root');
    }

    let st: import('node:fs').Stats;
    try {
      st = await fs.stat(realTarget);
    } catch {
      throw new Error('not-found');
    }
    if (!st.isDirectory()) throw new Error('not-a-directory');

    const files: LiveFileEntry[] = [];
    // Iterative BFS rooted at the validated subtree; relPaths stay ROOT-relative
    // so a returned file maps 1:1 to its content_bridge_files row (same as walk).
    const queue: string[] = [relBase];
    while (queue.length) {
      const curRel = queue.shift() as string;
      const curFull = curRel ? path.join(this.rootPath, curRel) : this.rootPath;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(curFull, { withFileTypes: true });
      } catch {
        // A deeper unreadable sub-dir is skipped (the START target was already
        // validated above), so one bad dir never aborts the whole scan — same
        // tolerance the old per-folder browse walk had.
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        // Same skip set as the index walk + browse, plus `_thumbs` (which the
        // SaaS recursive walk dropped) so the result matches the prior browse-walk.
        if (entry.name.startsWith('.') || entry.name === '@eaDir' || entry.name === '_thumbs') {
          continue;
        }
        const childRel = curRel ? path.posix.join(curRel, entry.name) : entry.name;
        if (entry.isDirectory()) {
          if (entry.name === '_cache') continue; // out-of-content cache dir
          queue.push(childRel);
        } else if (entry.isFile()) {
          const mime = mimeForExtension(path.extname(entry.name));
          if (!mime) continue; // media-only: skip docs/sidecars
          let size = 0;
          try {
            size = (await fs.stat(path.join(curFull, entry.name))).size;
          } catch {
            size = 0;
          }
          files.push({ name: entry.name, relPath: childRel, size, mime });
        }
        // Symlinks / sockets / devices skipped (Dirent reports them as neither).
      }
    }
    return { relPath: relBase, files };
  }

  /**
   * V0.7.b: shallow index of ONE folder's direct children (files + dir markers)
   * as FileEntry[] — the incremental-reindex analogue of walkDir, non-recursive.
   * Mirrors walkDir's skip rules + entry shape EXACTLY (indexes ALL files, not
   * just media, so the gateway's folder reconcile stays consistent with a full
   * scan). Throws on readdir failure so the caller never ships a PARTIAL folder
   * index (which would wrongly mark files absent).
   */
  async indexFolderShallow(relPath: string): Promise<FileEntry[]> {
    const clean = relPath.replace(/^\/+|\/+$/g, '');
    const base = clean ? path.join(this.rootPath, clean) : this.rootPath;
    const entries = await fs.readdir(base, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const out: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '@eaDir') continue;
      if (entry.isDirectory() && entry.name === '_cache') continue;
      const childRel = clean ? path.posix.join(clean, entry.name) : entry.name;
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(path.join(base, entry.name));
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        out.push({ relPath: childRel, size: 0, mtime: Math.floor(stat.mtimeMs), isDir: true });
      } else if (entry.isFile()) {
        out.push({
          relPath: childRel,
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs),
          isDir: false,
          mime: mimeForExtension(path.extname(entry.name)),
        });
      }
    }
    return out;
  }

  /**
   * V0.7.b: recursive DIRECTORY-only walk yielding each dir's rel path + mtime
   * (no file stats). The mtime-diff sweep uses this to find folders whose
   * contents changed (a dir's mtime moves when an entry is added/removed in it).
   * Same skip rules as the index walk; `Bridge Thumbnails` is walked (its
   * contents are indexed), `_cache` is not. Unreadable dirs are skipped.
   */
  async *walkDirsWithMtime(relDir = ''): AsyncIterable<{ relPath: string; mtime: number }> {
    const full = relDir ? path.join(this.rootPath, relDir) : this.rootPath;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(full, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === '@eaDir' || entry.name === '_cache') {
        continue;
      }
      const childRel = relDir ? path.posix.join(relDir, entry.name) : entry.name;
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(path.join(full, entry.name));
      } catch {
        continue;
      }
      yield { relPath: childRel, mtime: Math.floor(stat.mtimeMs) };
      yield* this.walkDirsWithMtime(childRel);
    }
  }

  private async *walkDir(relDir: string): AsyncIterable<FileEntry> {
    const fullDir = relDir
      ? path.join(this.rootPath, relDir)
      : this.rootPath;

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(fullDir, { withFileTypes: true });
    } catch (err) {
      // Skip unreadable directories (permissions, races, etc.) rather than
      // crashing the whole walk. Logged so the operator can investigate.
      // eslint-disable-next-line no-console
      console.warn(
        `local-fs: cannot read ${fullDir}: ${(err as Error).message}`
      );
      return;
    }

    // Sort entries for deterministic walk order — easier to spot-check
    // INDEX_BATCH frames against the filesystem during V0 smoke.
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      // Skip dotfiles. Most NAS content trees have .DS_Store, .AppleDouble,
      // @eaDir (Synology thumbnail metadata), etc. that just create noise.
      // Operator can override via a future filter list; V0 hardcodes the skip.
      if (entry.name.startsWith('.') || entry.name === '@eaDir') continue;

      // Skip the out-of-content cache dir (`_cache` — cache_dir thumbs + proxies
      // + staged tweet uploads). V0.7.b: `Bridge Thumbnails` (in-place generated
      // thumbs under Pics) is NO LONGER skipped — the operator wants those images
      // indexed so the thumbnail picker can browse them. Generation stays
      // video-only, so indexing these image thumbs can't cause thumbs-of-thumbs.
      // Bloat is managed by limiting generation to full + teaser (orchestrator).
      if (entry.isDirectory() && entry.name === '_cache') {
        continue;
      }

      const relPath = relDir
        ? path.posix.join(relDir, entry.name)
        : entry.name;
      const fullPath = path.join(this.rootPath, relPath);

      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(fullPath);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `local-fs: cannot stat ${fullPath}: ${(err as Error).message}`
        );
        continue;
      }

      if (entry.isDirectory()) {
        yield {
          relPath,
          size: 0,
          mtime: Math.floor(stat.mtimeMs),
          isDir: true,
        };
        yield* this.walkDir(relPath);
      } else if (entry.isFile()) {
        yield {
          relPath,
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs),
          isDir: false,
          mime: mimeForExtension(path.extname(entry.name)),
        };
      }
      // Skip symlinks, sockets, FIFOs, block/char devices in V0.
    }
  }
}

function mimeForExtension(ext: string): string | undefined {
  // Small lookup. Covers the file types the SaaS app touches today (videos,
  // images, audio). Anything else gets a null mime and the SaaS handles
  // it as a generic file. Full mime database (`mime-db` or `mime-types`
  // package) is overkill for V0.
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.m4v': 'video/mp4',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
  };
  return map[ext.toLowerCase()];
}
