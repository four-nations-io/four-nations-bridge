// V0.7.b — bridge-side file UPLOAD + DELETE for ephemeral tweet media.
//
// The SaaS relays an UPLOAD_FILE frame (a file the creator attached to a tweet);
// the bridge stages it under the bridge-OWNED cache root in a `_twitterUploads/`
// sub-folder, then replies with a content-root-relative path the SaaS can read
// back (Twitter posting reads CONTENT_ROOT/<relPath>) plus a `stagedToken` the
// SaaS uses to DELETE the file after the tweet posts.
//
// Why the cache root: `resolveActiveCacheRoot` (thumb/orchestrator) returns a
// location the bridge fully owns — create + write + DELETE all work with no ACL
// grants, and it's skipped by the indexer (so staged uploads never pollute the
// index). It also sits under the managed/content tree in the operator's setup,
// so the staged file is readable by the SaaS as `<_cache>/_twitterUploads/...`.
//
// SECURITY: writes are contained to `<cacheRoot>/_twitterUploads/` via realpath
// + prefix check (same model as projects/create.ts). Deletes are contained to
// the same folder. Add-only on write (flag 'wx' never overwrites). Size-capped.
//
// FIRST CUT (V0.7.b): transport is a single base64 JSON frame, hard-capped at
// UPLOAD_MAX_BYTES. Large videos (Twitter allows up to 512MB) need a chunked
// binary transport — a follow-up. The SaaS enforces the per-type Twitter caps;
// this is the absolute backstop.

import { promises as fs, accessSync, constants as fsConstants } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import type { SharedState } from './wss-client';

/** Absolute backstop on a single staged upload (first-cut base64 transport). */
export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const STAGING_DIRNAME = '_twitterUploads';
const CACHE_DIRNAME = '_cache';

export interface UploadFileFrame {
  type: 'UPLOAD_FILE';
  requestId?: string;
  fileName?: string;
  contentB64?: string;
  byteLength?: number;
}

export interface DeleteFileFrame {
  type: 'DELETE_FILE';
  requestId?: string;
  stagedToken?: string;
}

function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the bridge-owned cache root (mirrors thumb/orchestrator
 * resolveActiveCacheRoot, kept self-contained to avoid coupling the upload path
 * to the orchestrator state shape). Preferred: `<managedRoot>/_cache`. Else a
 * dedicated cache mount. Else `_cache` under the active writable source root.
 */
export function resolveCacheRoot(state: SharedState): string {
  const config = state.config;
  if (config.managedEnabled && isWritableDir(config.managedRoot)) {
    return path.posix.join(config.managedRoot, CACHE_DIRNAME);
  }
  if (isWritableDir(config.cacheRoot)) {
    return config.cacheRoot;
  }
  const writable = state.sourceRoots.find(
    (r) => r.status === 'active' && r.writable && r.containerPath
  );
  if (writable && writable.containerPath) {
    return path.posix.join(writable.containerPath, CACHE_DIRNAME);
  }
  return config.cacheRoot;
}

/** The container path of the indexed content root (first active source root) —
 *  used to express the staged file as a CONTENT_ROOT-relative path the SaaS can
 *  read. Null when no active root (then the SaaS can't read it back this cut). */
export function indexedRootContainerPath(state: SharedState): string | null {
  const active = state.sourceRoots.find((r) => r.status === 'active' && r.containerPath);
  return active?.containerPath ?? null;
}

/** Keep only a safe single path segment (no separators, no dotfiles, bounded). */
export function safeBaseName(raw: unknown): string {
  const base = path.posix.basename(String(raw ?? '').trim().replace(/\\/g, '/'));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 120) || 'upload';
}

export async function handleUploadFile(
  ws: WebSocket,
  state: SharedState,
  msg: UploadFileFrame
): Promise<void> {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const reply = (payload: Record<string, unknown>): void => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'UPLOAD_FILE_RESULT', requestId, ...payload }));
    }
  };

  const contentB64 = typeof msg.contentB64 === 'string' ? msg.contentB64 : '';
  if (!contentB64) {
    reply({ ok: false, reason: 'no file content' });
    return;
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(contentB64, 'base64');
  } catch {
    reply({ ok: false, reason: 'bad file encoding' });
    return;
  }
  if (buf.length === 0) {
    reply({ ok: false, reason: 'empty file' });
    return;
  }
  if (buf.length > UPLOAD_MAX_BYTES) {
    reply({ ok: false, reason: `file exceeds the ${UPLOAD_MAX_BYTES} byte upload cap` });
    return;
  }

  const cacheRoot = resolveCacheRoot(state);
  const stagingDir = path.posix.join(cacheRoot, STAGING_DIRNAME);
  try {
    await fs.mkdir(stagingDir, { recursive: true });
  } catch (err) {
    reply({ ok: false, reason: `cannot create staging dir: ${(err as Error).message}` });
    return;
  }

  // Containment: realpath the staging dir, ensure the target stays inside it.
  let realStaging: string;
  try {
    realStaging = await fs.realpath(stagingDir);
  } catch {
    reply({ ok: false, reason: 'staging dir not reachable' });
    return;
  }
  const token = `${randomUUID()}__${safeBaseName(msg.fileName)}`;
  const target = path.join(realStaging, token);
  if (target !== path.join(realStaging, path.basename(target))) {
    reply({ ok: false, reason: 'invalid staged file name' });
    return;
  }

  try {
    await fs.writeFile(target, buf, { flag: 'wx' });
  } catch (err) {
    reply({ ok: false, reason: `failed to stage upload: ${(err as Error).message}` });
    return;
  }

  // Content-root-relative path the SaaS reads back (Twitter posting reads
  // CONTENT_ROOT/<relPath>). Derivable only when the cache root sits under the
  // indexed content root (the operator's managed==content setup).
  let relPath: string | null = null;
  const contentRoot = indexedRootContainerPath(state);
  if (contentRoot) {
    try {
      const realContentRoot = await fs.realpath(contentRoot);
      if (target === realContentRoot || target.startsWith(realContentRoot + path.sep)) {
        relPath = path.posix.normalize(
          target.slice(realContentRoot.length).replace(/\\/g, '/').replace(/^\/+/, '')
        );
      }
    } catch {
      relPath = null;
    }
  }

  reply({
    ok: true,
    relPath, // CONTENT_ROOT-relative (null if cache is outside the content tree)
    stagedToken: `${STAGING_DIRNAME}/${token}`, // relative to the cache root (for DELETE)
    byteLength: buf.length,
  });
}

export async function handleDeleteFile(
  ws: WebSocket,
  state: SharedState,
  msg: DeleteFileFrame
): Promise<void> {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const reply = (payload: Record<string, unknown>): void => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'DELETE_FILE_RESULT', requestId, ...payload }));
    }
  };

  const token = String(msg.stagedToken ?? '');
  // Only ever delete inside the staging folder; reject traversal.
  if (!token.startsWith(`${STAGING_DIRNAME}/`) || token.includes('..') || token.includes('\0')) {
    reply({ ok: false, reason: 'refused: not a staged-upload token' });
    return;
  }

  const cacheRoot = resolveCacheRoot(state);
  const stagingDir = path.posix.join(cacheRoot, STAGING_DIRNAME);
  let realStaging: string;
  try {
    realStaging = await fs.realpath(stagingDir);
  } catch {
    reply({ ok: true, alreadyGone: true }); // nothing staged → nothing to delete
    return;
  }
  const target = path.join(cacheRoot, token);
  if (target !== realStaging + path.sep + path.basename(target)) {
    // basename containment: token is `_twitterUploads/<name>`; target's parent
    // must be exactly the staging dir.
    if (path.dirname(target) !== realStaging) {
      reply({ ok: false, reason: 'refused: escapes staging dir' });
      return;
    }
  }
  try {
    await fs.unlink(target);
    reply({ ok: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      reply({ ok: true, alreadyGone: true });
      return;
    }
    reply({ ok: false, reason: `failed to delete staged upload: ${e.message}` });
  }
}
