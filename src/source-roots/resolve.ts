// Source-root resolution — Phase F V0.6.a.
//
// V0.4 ran against a single env-configured mount (`config.sourceRoot`, host
// path bound at `/sources/local`). V0.6 generalizes to a per-device list of
// allowed roots driven from the SaaS UI (appsec.content_bridge_source_roots),
// delivered to the bridge in the SETTINGS_RESPONSE poll.
//
// NARROW-BIND MODEL (arch-note 14 §3, 2026-06-04 revert of the broad-bind
// design): the install binds ONE narrow mount per operator-chosen root, and
// the container path MIRRORS the host path under a `/sources/host` prefix:
//
//   host  /volume1/photo/Content  →  container  /sources/host/volume1/photo/Content
//   host  C:\Users\you\Vids       →  container  /sources/host/c/Users/you/Vids
//
// Resolution is therefore a deterministic string-concat (no manifest), and a
// root the operator hasn't bound yet simply fails `fs.stat` → `needs_mount`
// (the SaaS shows the `bridge-add-root.sh` command to paste). The KERNEL mount
// boundary — not application code — is what limits what the container can see.
//
// WINDOWS (planning doc 119): the model assumed a POSIX-absolute host path
// everywhere, which is neither what Windows has nor what Docker Desktop mounts.
// `hostPathToContainerPath` is now drive-letter aware, and the creator-facing
// compose carries the mirror as its own env var (CONTENT_BRIDGE_CONTAINER_MOUNT_PATH)
// because compose interpolation cannot compute it. ⚠️ The web wizard holds a
// byte-identical copy of both functions in `next-app/src/lib/bridgeMirrorPath.ts`
// (separate npm projects — the bridge's Docker build context contains only the
// bridge, so a shared module is impossible). They are pinned to each other by
// `bridgeMirrorPath.test.ts`, which runs BOTH implementations over one vector
// table. If you change a rule here, change it there in the same commit — a
// divergence mounts one path and indexes another, and surfaces as the misleading
// "PERMISSION PROBLEM — can't READ content folder".

import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';

/** Prefix every narrow bind mounts under. Compose binds the operator's content
 *  folder to its mirror under this prefix (long `type: bind` syntax, so a Windows
 *  drive letter's colon can never be mistaken for a mount-spec separator). */
export const SOURCE_HOST_PREFIX = '/sources/host';

/** A Windows drive-letter absolute path, either slash style: `C:\…` or `C:/…`. */
const WINDOWS_ABS_RE = /^([A-Za-z]):[\\/]/;
/** UNC / network share (`\\server\share`). Rejected for v1 — planning doc 119. */
const UNC_RE = /^\\\\/;

/** A source root as delivered by the gateway in SETTINGS_RESPONSE. */
export interface SourceRootInput {
  id: number;
  hostPath: string;
  enabled: boolean;
  isManaged: boolean;
}

/** The bridge's resolution of one root, reported back via SOURCE_ROOTS_RESOLVED. */
export interface ResolvedSourceRoot {
  id: number;
  hostPath: string;
  /** Mirror container path, or null when hostPath itself is unsafe/invalid. */
  containerPath: string | null;
  /** `active` = mounted + reachable; `needs_mount` = not bound in the container. */
  status: 'active' | 'needs_mount';
  /** Bridge can create folders here (fs.access W_OK). Gates create-project. */
  writable: boolean;
  isManaged: boolean;
  enabled: boolean;
  /** Human-readable reason when status === 'needs_mount' (or null). */
  lastError: string | null;
}

/**
 * Canonicalize a host path as a PERSON typed or pasted it (planning doc 119).
 *
 * This is the input-canonicalization half: it is what the setup wizard applies to
 * whatever lands in the "where your content lives" box, and what `loadConfig`
 * applies to `CONTENT_BRIDGE_HOST_CONTENT_PATH`, so exactly ONE spelling of a
 * folder is ever written to `bridge.env`, sent on HELLO, or stored as a source
 * root's `host_path`. Two spellings of one folder would create two root rows and
 * break the gateway's rel-prefix math.
 *
 * Canonical form: forward slashes, no trailing slash, UPPERCASE drive letter
 * (`C:/Users/you/Videos`) — the shape Windows itself shows. POSIX paths pass
 * through `path.posix.normalize` and are otherwise untouched.
 *
 * Deliberately STRICTER than `hostPathToContainerPath` on `..`: this canonicalizes
 * human input, and silently resolving somebody's typo into a *different* folder is
 * worse than telling them it's invalid.
 *
 * Returns null for: UNC / network shares (v1 — doc 119 §Out of Scope), any `..`
 * segment, a relative path, a bare drive with no separator, or an empty value.
 *
 * NOT SUPPORTED, deliberately: a folder whose name begins or ends with whitespace.
 * The leading `.trim()` exists to absorb a sloppy paste, and it cannot tell " Vids "
 * (a real folder) from " Vids " (a clean paste with stray spaces) — the paste case is
 * overwhelmingly more common, so it wins. One consequence: for such a path this is
 * not idempotent (`/a/ /` → `/a/ ` → `/a`). The result is a mount/index mismatch the
 * bridge reports as `needs_mount`; it never widens what is bound.
 */
export function normalizeHostPath(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // Windows Explorer's Shift+right-click → "Copy as path" hands back a QUOTED
  // value. Accept it verbatim so nobody has to hand-edit a pasted path.
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }
  if (!s || UNC_RE.test(s)) return null;

  const win = WINDOWS_ABS_RE.exec(s);
  // Check `..` against the RAW segments, before any resolution.
  const rawSegments = (win ? s.slice(2) : s).replace(/\\/g, '/').split('/');
  if (rawSegments.some((seg) => seg === '..')) return null;

  if (win) {
    const rest = path.posix.normalize(s.slice(2).replace(/\\/g, '/'));
    // A colon past the drive letter can't be a real Windows path component.
    if (rest.includes(':')) return null;
    return `${win[1].toUpperCase()}:${stripTrailingSlash(rest)}`;
  }

  if (!path.posix.isAbsolute(s)) return null;
  return stripTrailingSlash(path.posix.normalize(s));
}

/** Drop a trailing separator for the canonical form (never bare root). */
function stripTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * Map a host path to its mirrored container path under `/sources/host`.
 *
 * POSIX (unchanged, and pinned by test vectors — every installed Mac / Linux /
 * NAS bridge derives its index root through here, so a change to this branch
 * would silently re-map the whole installed base):
 *
 *   /volume1/photo/Content  ->  /sources/host/volume1/photo/Content
 *
 * WINDOWS (planning doc 119) — the drive letter becomes a LOWERCASE first
 * segment, mirroring the `/mnt/c` convention WSL and Docker Desktop already use:
 *
 *   C:\Users\you\Network Share\Vids  ->  /sources/host/c/Users/you/Network Share/Vids
 *
 * Folding the drive's case is load-bearing, not cosmetic: Windows treats `C:` and
 * `c:` as one drive, so without it a creator who typed `c:` would get a container
 * path that differs from the one compose bound, and the bridge would report
 * `needs_mount` with everything apparently configured correctly.
 *
 * Returns null for anything that can't be safely mirrored — a relative path, a
 * `..` that survives normalization, a bare drive. The mirror is a pure string
 * transform under a fixed prefix, so it can never address anything outside
 * `/sources/host`; the KERNEL bind boundary — not this function — is what limits
 * what the container can actually see (arch-note 14 §3).
 */
export function hostPathToContainerPath(hostPath: string): string | null {
  if (!hostPath || typeof hostPath !== 'string') return null;

  const win = WINDOWS_ABS_RE.exec(hostPath);
  if (win) {
    const rest = path.posix.normalize(hostPath.slice(2).replace(/\\/g, '/'));
    if (rest.includes(':')) return null;
    if (rest.split('/').some((seg) => seg === '..')) return null;
    // join() normalizes the result, so a doubled separator collapses here.
    return path.posix.join(SOURCE_HOST_PREFIX, win[1].toLowerCase(), rest);
  }

  if (!path.posix.isAbsolute(hostPath)) return null;
  const normalized = path.posix.normalize(hostPath);
  if (normalized.split('/').some((seg) => seg === '..')) return null;
  // join() collapses the joining slash; mirror keeps the full host path.
  return path.posix.join(SOURCE_HOST_PREFIX, normalized);
}

/**
 * Resolve one root: compute the mirror path, `fs.stat` to confirm it's mounted
 * and a directory, then probe `fs.access(W_OK)` to set the writable flag. Never
 * throws — any failure becomes a `needs_mount` result with a `lastError`.
 */
export async function resolveSourceRoot(
  input: SourceRootInput
): Promise<ResolvedSourceRoot> {
  const containerPath = hostPathToContainerPath(input.hostPath);
  const base: ResolvedSourceRoot = {
    id: input.id,
    hostPath: input.hostPath,
    containerPath,
    status: 'needs_mount',
    writable: false,
    isManaged: input.isManaged,
    enabled: input.enabled,
    lastError: null,
  };

  if (!containerPath) {
    return {
      ...base,
      lastError:
        'invalid host path (must be an absolute path — /volume1/photo/Content or ' +
        'C:/Users/you/Videos — with no ".." segments; network shares (\\\\server\\share) ' +
        'are not supported yet)',
    };
  }

  try {
    const st = await fs.stat(containerPath);
    if (!st.isDirectory()) {
      return { ...base, lastError: 'path exists in container but is not a directory' };
    }
  } catch {
    return {
      ...base,
      lastError: `not mounted in the bridge container — run: ./bridge-add-root.sh "${input.hostPath}"`,
    };
  }

  // Mounted + a directory → active. Probe write access (W_OK) for create-project.
  let writable = false;
  try {
    await fs.access(containerPath, fsConstants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }

  return {
    ...base,
    status: 'active',
    writable,
    lastError: null,
  };
}

/** Resolve all roots concurrently. Order preserved. */
export async function resolveSourceRoots(
  inputs: SourceRootInput[]
): Promise<ResolvedSourceRoot[]> {
  return Promise.all(inputs.map((i) => resolveSourceRoot(i)));
}

/** Parse the raw `sourceRoots` array from a SETTINGS_RESPONSE payload into
 *  typed inputs, ignoring malformed rows (forward-compat). */
export function parseSourceRootsFromSettings(raw: unknown): SourceRootInput[] {
  if (!Array.isArray(raw)) return [];
  const out: SourceRootInput[] = [];
  for (const r of raw) {
    const row = r as Record<string, unknown>;
    const id = Number(row?.id);
    const hostPath = typeof row?.hostPath === 'string' ? row.hostPath : null;
    if (!Number.isFinite(id) || !hostPath) continue;
    out.push({
      id,
      hostPath,
      enabled: row?.enabled !== false,
      isManaged: row?.isManaged === true,
    });
  }
  return out;
}
