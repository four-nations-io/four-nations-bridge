// Tell the HOST that this bridge created content, without being able to do
// anything about it ourselves.
//
// Initiative `synology-photos-reindex`, Phase A — see
// four-nations-web/docs/initiatives/synology-photos-reindex/01-scope.md
//
// ─── WHY A FILE AND NOT A COMMAND ───────────────────────────────────────────
//
// On Synology, a folder created by `fs.mkdir` is INVISIBLE to Synology Photos
// until Photos re-indexes. DSM's indexer is notified by DSM's own file services
// (smbd, File Station), never by filesystem events — which is why the same
// folder made over SMB appears instantly and ours never does.
//
// The lever that fixes it is:
//     /usr/syno/bin/synowebapi --exec api=SYNO.FotoTeam.Index method=reindex version=1
//
// ⛔ AND THE BRIDGE MUST NOT BE ABLE TO RUN IT. `synowebapi` is mode 700
// root:root and authenticates as SYSTEM_ADMIN purely by being root on the host.
// Mounting it in would not grant "reindex Photos" — it would grant
// unauthenticated admin access to EVERY DSM Web API: users, shares, packages,
// certificates. A bridge compromise would own DSM.
//
// So this module writes a one-bit request and stops. A host-side task owns the
// privilege and decides what to do with it. ⭐ The flag is not a workaround for
// lacking a better channel — it IS the security boundary.
//
// ⚠️ AND THE BOUNDARY ONLY HOLDS BECAUSE THE ROOT CONSUMER NEVER WRITES HERE.
// This comment previously claimed "the worst a fully compromised bridge can do
// through it is cause an extra reindex", and that was FALSE: the first version
// of the host watcher cleared this flag with `rm -f` and restored it with
// `touch` on failure, and `touch` FOLLOWS a symlink and CREATES the target. A
// compromised bridge could watch for root's unlink, race a symlink into this
// path aimed anywhere on the host, and have ROOT create a file there. Found by
// /security-review before it shipped.
//
// The watcher now only ever STATS this file and keeps its own state in a
// root-owned directory outside every container-writable mount. ⛔ Do not
// "simplify" it back into clearing the flag — the claim above depends on root
// performing no symlink-following write on a path this container controls.
//
// ─── DELIBERATELY FAIL-SOFT ─────────────────────────────────────────────────
//
// Folder creation must NEVER fail because of this. A missing state dir, a
// read-only mount, a full disk — all of it is swallowed. The consequence of
// failure is "the operator re-indexes by hand", which is exactly where they
// were before this existed. The consequence of throwing would be a broken
// create-project, which is far worse.

import { promises as fs } from "fs";
import path from "path";

/** Flag filename. Platform-agnostic on purpose: it states what HAPPENED, not
 *  what any one OS should do about it, so a Windows/Linux indexer could consume
 *  the same signal without the bridge learning about Synology. */
export const CONTENT_CHANGED_FLAG = "content-changed";

export function contentChangedFlagPath(stateDir: string): string {
  return path.join(stateDir, CONTENT_CHANGED_FLAG);
}

/**
 * Record that content was created, for a host-side consumer to act on.
 *
 * Writes (or re-touches) `<stateDir>/content-changed`. Idempotent: the flag is
 * a request, not a queue — ten folders created before the host next looks still
 * need exactly one reindex, because the reindex takes no path argument and
 * reconciles the whole shared space anyway.
 *
 * Never throws. Returns whether the flag was written, for logging only — a
 * `false` is not an error worth surfacing to the caller.
 */
export async function signalContentChanged(stateDir: string): Promise<boolean> {
  if (!stateDir) return false;
  try {
    // `recursive: true` so a state dir that does not exist yet (fresh install,
    // pre-pairing) does not make this the one thing that fails.
    await fs.mkdir(stateDir, { recursive: true });
    // Content is deliberately a hint, not data the host parses — the host acts
    // on the file's EXISTENCE. Anything that needed parsing would be a contract
    // between two independently-released components, and would drift.
    await fs.writeFile(contentChangedFlagPath(stateDir), `${new Date().toISOString()}\n`, "utf8");
    return true;
  } catch {
    // Swallowed on purpose — see the header. The operator falls back to a
    // manual re-index, which is the pre-existing behaviour.
    return false;
  }
}
