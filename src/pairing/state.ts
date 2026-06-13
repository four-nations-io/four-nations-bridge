// Paired-state persistence — Phase F V0.8.b.
//
// The setup wizard (setup-ui) writes a small JSON file once pairing succeeds;
// the daemon reads it at boot and uses it as the credential + identity source
// when the legacy env-based bearer isn't set. Pairing is between the creator's
// ACCOUNT and this bridge — the file holds the bridge side of that pairing
// (the credential the bridge presents to the gateway), never any browser- or
// device-session state.
//
// Storage: `<stateDir>/paired.json`, mode 0600, written atomically (temp file
// in the SAME directory + rename — staging in os.tmpdir() would cross
// filesystems on a bind mount and fail with EXDEV). `stateDir` defaults to
// `<managedRoot>/_state` (config.ts) so it lands in the bridge-owned, writable
// managed area — NOT a root-owned named volume the non-root container can't
// write (the EACCES trap a separate /data/state mount hit in V0.8.b smoke).
//
// Re-pairing: delete `<stateDir>/paired.json` and restart the container — the
// daemon comes back up in unpaired mode and the wizard routes reactivate.
// Documented in docs/install/security.md.

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

export interface PairedState {
  /** Schema version for forward-compat. */
  version: 1;
  /** Credential presented to the gateway as `Authorization: Bearer …`.
   *  V0.8.b: the pairing code IS the bridge bearer (V0 shared-bearer model).
   *  A future per-device pairing exchange swaps what gets stored here without
   *  changing this file's role. */
  bearer: string;
  /** Stable per-install identity (UUID). Persisted here in the managed folder
   *  (which lives with the content), presented to the gateway on connect as the
   *  device's identity key. Because it lives at the content location and NOT in
   *  the typed name, reinstalling/rebuilding at the same managed path — under
   *  ANY display name — re-attaches to the SAME device row (same indexed
   *  content). Missing in pre-V0.8.b files; main.ts generates + re-persists one. */
  deviceKey: string;
  /** Free-form bridge name chosen in the wizard (e.g. "Studio NAS"). Display
   *  only since V0.8.b — identity is `deviceKey`. */
  deviceLabel: string;
  /** V0.9d: content encryption key (64 hex). Present when the creator entered it
   *  in the setup wizard (web-UI-first onboarding) rather than the .env. Absent in
   *  older files / env-key deployments — main.ts then falls back to the env key. */
  encryptionKeyHex?: string;
  /** Initial content-root HOST path chosen in the wizard. Sent in HELLO so
   *  the gateway can register it as this device's first source root. */
  initialSourceRootHostPath: string | null;
  /** Epoch ms when the wizard completed. */
  pairedAt: number;
}

const PAIRED_FILE = 'paired.json';

export function pairedStatePath(stateDir: string): string {
  return path.join(stateDir, PAIRED_FILE);
}

/** Load the paired state, or null when absent/unreadable/malformed. Malformed
 *  content is reported but treated as unpaired — the wizard then reactivates,
 *  which is the recoverable path (vs. crash-looping the daemon). */
export async function loadPairedState(stateDir: string): Promise<PairedState | null> {
  const file = pairedStatePath(stateDir);
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return null; // not paired yet (or state volume missing) — wizard mode
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PairedState>;
    if (
      parsed?.version === 1 &&
      typeof parsed.bearer === 'string' &&
      parsed.bearer.length >= 32 &&
      typeof parsed.deviceLabel === 'string' &&
      parsed.deviceLabel.length > 0
    ) {
      return {
        version: 1,
        bearer: parsed.bearer,
        // deviceKey may be absent in a pre-V0.8.b file — '' signals the caller
        // (main.ts) to generate + re-persist one. Never empty after that.
        deviceKey: typeof parsed.deviceKey === 'string' ? parsed.deviceKey : '',
        deviceLabel: parsed.deviceLabel,
        // V0.9d: wizard-entered content encryption key (64 hex). Absent in older
        // files → undefined → main.ts uses the env key instead.
        encryptionKeyHex:
          typeof parsed.encryptionKeyHex === 'string' &&
          /^[0-9a-fA-F]{64}$/.test(parsed.encryptionKeyHex)
            ? parsed.encryptionKeyHex
            : undefined,
        initialSourceRootHostPath:
          typeof parsed.initialSourceRootHostPath === 'string'
            ? parsed.initialSourceRootHostPath
            : null,
        pairedAt: typeof parsed.pairedAt === 'number' ? parsed.pairedAt : 0,
      };
    }
    // eslint-disable-next-line no-console
    console.error(`bridge: ${file} exists but is malformed — treating as unpaired`);
    return null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`bridge: failed to parse ${file} — treating as unpaired`, err);
    return null;
  }
}

/** Persist the paired state atomically with owner-only permissions. */
export async function savePairedState(stateDir: string, state: PairedState): Promise<void> {
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = pairedStatePath(stateDir);
  const tmp = path.join(stateDir, `.${PAIRED_FILE}.tmp-${process.pid}`);
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(tmp, file);
}
