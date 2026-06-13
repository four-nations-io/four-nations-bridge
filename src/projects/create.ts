// Create-project scaffolding — Phase F V0.6.a.
//
// Builds a new project folder by COPYING the operator's template folder into a
// chosen destination (within a WRITABLE source root) and naming the copy
// `YYYY-MM-DD Title`. The template folder already holds the right subfolder
// layout (Clips / Final Video / …), so we never hardcode a structure — whatever
// the operator puts in their template is what every new project starts with.
// This is the bridge side of the "Create Project Folder" button in the
// add-video folder picker. Triggered by a CREATE_PROJECT WSS frame.
//
// CLOSED-DOWN WRITE MODEL (arch-note 14 §3, planning doc 46 Decisions 2026-06-04):
// this module is the ENTIRE bridge write surface for creator content, and it is
// deliberately ADD-ONLY. It uses `fs.cp` (recursive copy — creates only) + `fs.mkdir`
// and read-only probes (`fs.stat`/`fs.access`/`fs.realpath`); there is NO `fs.rm`
// / `fs.unlink` / `fs.rmdir` / rename-over anywhere in the bridge. Copy writes
// bytes (the template's own files) but ONLY inside the chosen RW root, ONLY from
// the operator-designated template, and NEVER over an existing folder
// (errorOnExist). Three defense layers (see arch-note): (1) the host user the
// container runs as has write-but-no-delete (kernel-enforced); (2) this
// no-delete-code-path layer; (3) the create rate-limit below. Worst case for a
// full SaaS+bridge compromise: a bounded number of template copies inside one
// RW root — no deletes, no overwrites, no escape, no reach into read-only roots.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const MAX_TITLE_LEN = 120;

/** Characters illegal in a folder name on Windows + path separators + the
 *  control range. Folded to spaces in the working title. Built via char codes
 *  to avoid backslash-escaping ambiguity in the source. */
const ILLEGAL_NAME_CHARS = new Set([
  '<', '>', ':', '"', '/', String.fromCharCode(92), '|', '?', '*',
]);

/** Windows device names that can't be a folder even with an extension. */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export interface CreateProjectRequest {
  /** Container path of the resolved, ACTIVE + WRITABLE root. The caller
   *  (wss-client) must have already verified this is one of the bridge's own
   *  resolved writable roots — never trust a gateway-supplied path blindly. */
  rootContainerPath: string;
  /** Browsed sub-location WITHIN the root where the project folder lands
   *  (relative; '' = the root itself). Validated to stay inside the root. */
  destSubPath: string;
  /** Container path of the template folder to copy (already mirror-resolved by
   *  the caller). When omitted/empty, a plain named folder is created instead
   *  (same naming) — the operator opted out of the template for this one. */
  templateContainerPath?: string | null;
  /** Container paths of THIS bridge's active source roots. The template (when
   *  used) must realpath INSIDE one of them, so a compromised gateway can't
   *  point `fs.cp` at an arbitrary mounted dir (V0.6.a hardening). When
   *  omitted/empty, falls back to confining within `rootContainerPath`. */
  activeRootContainerPaths?: string[];
  /** Operator-entered recording date; validated to YYYY-MM-DD. */
  recordingDate: string;
  /** Operator-entered working title; sanitized to a safe single segment. */
  workingTitle: string;
}

export type CreateProjectResult =
  | {
      ok: true;
      folderName: string;
      /** Path of the new folder relative to the root (for the SaaS to link). */
      relPath: string;
      createdPath: string;
      alreadyExisted: boolean;
    }
  | { ok: false; reason: string; rateLimited?: boolean };

/**
 * Validate a `YYYY-MM-DD` string and confirm it's a real calendar date.
 * Returns the canonical `YYYY-MM-DD` string or null.
 */
export function validateRecordingDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-trip through a UTC Date to reject impossible dates (e.g. 2026-02-30).
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${y}-${mo}-${d}`;
}

/**
 * Sanitize a working title into a safe single path segment: fold illegal +
 * control chars + separators to spaces, collapse whitespace, trim leading/
 * trailing spaces and dots (Windows trap), length-cap. Returns null if nothing
 * safe remains or the result is a reserved/dot name.
 */
export function sanitizeWorkingTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += ' '; // control char
      continue;
    }
    out += ILLEGAL_NAME_CHARS.has(ch) ? ' ' : ch;
  }
  let s = out.replace(/\s+/g, ' ').trim();
  // Strip leading/trailing dots and spaces (Windows can't end a name with them).
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (s.length === 0) return null;
  if (s.length > MAX_TITLE_LEN) s = s.slice(0, MAX_TITLE_LEN).trim();
  if (s === '.' || s === '..') return null;
  if (WINDOWS_RESERVED.has(s.toUpperCase())) return null;
  return s;
}

/** `YYYY-MM-DD Title` — the project folder name (matches the operator's
 *  existing convention, e.g. `2026-01-01 Winter Sweater Photo Shoot`). */
export function buildFolderName(recordingDate: string, title: string): string {
  return `${recordingDate} ${title}`;
}

/** Validate a destination sub-path: relative, no `..`, normalized. Returns the
 *  normalized sub-path ('' for root) or null if unsafe. */
export function sanitizeDestSubPath(raw: unknown): string | null {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned === '') return '';
  if (path.posix.isAbsolute(cleaned)) return null;
  const normalized = path.posix.normalize(cleaned);
  if (normalized.startsWith('..') || normalized.split('/').some((s) => s === '..')) {
    return null;
  }
  return normalized.replace(/\/+$/, '');
}

// ─── create rate-limit (bridge-side, authoritative) ─────────────────────────
//
// A compromised SaaS/gateway can't bypass a limit the BRIDGE owns. In-memory
// sliding window; resets on restart (fine — it's an abuse backstop, not an
// audit ledger). The gateway also rate-limits as a first line (defense-in-depth).

export interface CreateRateLimiter {
  /** Record an attempt; returns false if over the limit (attempt NOT recorded). */
  tryConsume(nowMs: number): boolean;
}

export function createRateLimiter(
  maxPerWindow = 20,
  windowMs = 60 * 60 * 1000
): CreateRateLimiter {
  const hits: number[] = [];
  return {
    tryConsume(nowMs: number): boolean {
      const cutoff = nowMs - windowMs;
      while (hits.length > 0 && hits[0] <= cutoff) hits.shift();
      if (hits.length >= maxPerWindow) return false;
      hits.push(nowMs);
      return true;
    },
  };
}

/** Process-wide default limiter used by the bridge's CREATE_PROJECT handler. */
export const defaultCreateRateLimiter = createRateLimiter();

/**
 * Copy the template folder into the chosen destination as `YYYY-MM-DD Title`.
 * ADD-ONLY: validates everything, then `fs.cp` the template tree to the new
 * folder with `errorOnExist` (never overwrites). Returns a structured result;
 * never throws on validation failure.
 */
export async function createProject(
  req: CreateProjectRequest,
  opts: { nowMs?: number; rateLimiter?: CreateRateLimiter } = {}
): Promise<CreateProjectResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const rateLimiter = opts.rateLimiter ?? defaultCreateRateLimiter;

  const recordingDate = validateRecordingDate(req.recordingDate);
  if (!recordingDate) {
    return { ok: false, reason: 'recording date must be a valid YYYY-MM-DD date' };
  }
  const title = sanitizeWorkingTitle(req.workingTitle);
  if (!title) {
    return {
      ok: false,
      reason: 'working title is empty or unusable after removing illegal characters',
    };
  }
  const destSubPath = sanitizeDestSubPath(req.destSubPath);
  if (destSubPath === null) {
    return { ok: false, reason: 'destination sub-path is invalid' };
  }

  const folderName = buildFolderName(recordingDate, title);
  if (
    folderName.includes('/') ||
    folderName.includes('\\') ||
    folderName.includes(path.sep) ||
    path.basename(folderName) !== folderName
  ) {
    return { ok: false, reason: 'computed folder name is not a single path segment' };
  }

  // Rate-limit AFTER validation so a malformed request doesn't burn a token.
  if (!rateLimiter.tryConsume(nowMs)) {
    return {
      ok: false,
      rateLimited: true,
      reason: 'create-project rate limit reached; try again later',
    };
  }

  // Resolve the root via realpath (active root → exists) to defeat symlink
  // games, then resolve + contain the destination directory.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(req.rootContainerPath);
  } catch {
    return { ok: false, reason: 'writable root is not reachable in the container' };
  }
  let destDir = destSubPath ? path.join(realRoot, destSubPath) : realRoot;
  if (destDir !== realRoot && !destDir.startsWith(realRoot + path.sep)) {
    return { ok: false, reason: 'destination escapes the writable root' };
  }
  try {
    const st = await fs.stat(destDir);
    if (!st.isDirectory()) {
      return { ok: false, reason: 'destination is not a directory' };
    }
    // Realpath-confine the DESTINATION, not just the root (V0.9b — consumes the
    // V0.6.a hardening accepted-risk). The lexical check above (destDir string
    // under realRoot) doesn't bind fs.stat/fs.cp/mkdir, which FOLLOW OS symlinks
    // — a pre-existing in-tree symlink at destSubPath could redirect the create
    // outside the lexical root. Resolve the real destination and re-assert
    // containment BEFORE the existence-stat + write, then derive `target` from
    // it. Makes arch-note 14 §3's "defeats symlink-escape" claim literally true.
    const realDest = await fs.realpath(destDir);
    if (realDest !== realRoot && !realDest.startsWith(realRoot + path.sep)) {
      return { ok: false, reason: 'destination escapes the writable root' };
    }
    destDir = realDest;
  } catch {
    return { ok: false, reason: 'destination directory does not exist' };
  }

  // Validate the template folder (when one was chosen). A blank template means
  // "regular folder" — we mkdir the named folder with no subfolder structure.
  const useTemplate = !!req.templateContainerPath;
  let resolvedTemplate: string | null = null;
  if (useTemplate) {
    // Confine the template to a resolved ACTIVE root (V0.9b — consumes the V0.6.a
    // hardening item). The caller mirror-resolves the template (rejects
    // ../absolute) but didn't require it to live inside an active root, so a
    // compromised gateway could otherwise fs.cp FROM any mounted dir INTO the
    // (contained) destination. Resolve via realpath + require the result to sit
    // inside one of THIS bridge's active roots before the copy. Falls back to the
    // destination root when the caller supplies no active-roots list.
    let realTemplate: string;
    try {
      realTemplate = await fs.realpath(req.templateContainerPath as string);
    } catch {
      return {
        ok: false,
        reason: 'template folder is not reachable — set a default template on the bridge',
      };
    }
    const confineRoots =
      req.activeRootContainerPaths && req.activeRootContainerPaths.length > 0
        ? req.activeRootContainerPaths
        : [req.rootContainerPath];
    let contained = false;
    for (const candidate of confineRoots) {
      let realCandidate: string;
      try {
        realCandidate = await fs.realpath(candidate);
      } catch {
        continue; // an unresolvable root can't contain anything — skip it
      }
      if (
        realTemplate === realCandidate ||
        realTemplate.startsWith(realCandidate + path.sep)
      ) {
        contained = true;
        break;
      }
    }
    if (!contained) {
      return {
        ok: false,
        reason: 'template folder must live inside an active source root on this bridge',
      };
    }
    let tst: import('node:fs').Stats;
    try {
      tst = await fs.stat(realTemplate);
    } catch {
      return {
        ok: false,
        reason: 'template folder is not reachable — set a default template on the bridge',
      };
    }
    if (!tst.isDirectory()) {
      return { ok: false, reason: 'template path is not a directory' };
    }
    resolvedTemplate = realTemplate;
  }

  const target = path.join(destDir, folderName);
  if (!target.startsWith(destDir + path.sep)) {
    return { ok: false, reason: 'computed project path escapes the destination' };
  }
  const relPath = destSubPath ? `${destSubPath}/${folderName}` : folderName;

  // Never overwrite an existing project — idempotent "already there" result.
  try {
    const st = await fs.stat(target);
    if (st.isDirectory()) {
      return {
        ok: true,
        folderName,
        relPath,
        createdPath: target,
        alreadyExisted: true,
      };
    }
    return { ok: false, reason: 'a file already exists at the project path' };
  } catch {
    // Doesn't exist — good, proceed to copy.
  }

  try {
    if (useTemplate) {
      // ADD-ONLY: recursive copy creates; errorOnExist guarantees no overwrite;
      // force:false never clobbers. No delete/rename anywhere. Source is the
      // realpath-confined template resolved above (never the raw request path).
      await fs.cp(resolvedTemplate as string, target, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    } else {
      // Regular folder: just the named directory, no template structure.
      await fs.mkdir(target, { recursive: true });
    }
  } catch (err) {
    return {
      ok: false,
      reason: `failed to create the project folder: ${(err as Error).message}`,
    };
  }

  return { ok: true, folderName, relPath, createdPath: target, alreadyExisted: false };
}
