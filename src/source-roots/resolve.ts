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
//   host  /volume1/Media/Content  →  container  /sources/host/volume1/Media/Content
//
// Resolution is therefore a deterministic string-concat (no manifest), and a
// root the operator hasn't bound yet simply fails `fs.stat` → `needs_mount`
// (the SaaS shows the `bridge-add-root.sh` command to paste). The KERNEL mount
// boundary — not application code — is what limits what the container can see.

import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';

/** Prefix every narrow bind mounts under. Compose binds
 *  `<host_path>:/sources/host<host_path>:ro` (or `:rw` for writable roots). */
export const SOURCE_HOST_PREFIX = '/sources/host';

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
 * Map a host path to its mirrored container path under `/sources/host`.
 * Returns null for anything that isn't a clean absolute POSIX path — a `..`
 * segment or a relative path can't be safely mirrored, and the kernel bind
 * boundary means we never widen, only resolve within what's mounted.
 */
export function hostPathToContainerPath(hostPath: string): string | null {
  if (!hostPath || typeof hostPath !== 'string') return null;
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
      lastError: 'invalid host path (must be an absolute path with no ".." segments)',
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
