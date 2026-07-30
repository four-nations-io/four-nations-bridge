// Bridge notification disk queue — Phase F E.8a (doc 88, decision 7).
//
// The desktop bridge is DB-LESS — it only speaks WSS to the gateway. Several of the
// events a creator should hear about (needs-re-pair, content-folder-unreadable)
// happen EXACTLY when the gateway link may be down. So the bridge gets its OWN local
// store-and-forward buffer: it appends outgoing notifications to a durable file in
// its writable state dir, flushes them to the gateway over WSS on (re)connect (and
// on the periodic settings tick), and clears an entry ONLY when the gateway ACKs it.
// This survives a bridge restart, so no single link being down loses a notification
// (bridge-disk → gateway → Postgres outbox → in-app feed).
//
// Storage: `<stateDir>/pending-notifications.jsonl` (one JSON entry per line),
// mode 0600, written atomically (temp file in the SAME dir + rename — mirrors
// pairing/state.ts; staging in os.tmpdir() would cross filesystems on a bind mount).
//
// BOUNDED + COALESCED: these are STATE alerts, so the queue coalesces to the LATEST
// entry per eventCode (a folder that's been unreadable for an hour needs one alert,
// not 120), and caps total entries so a long gateway outage can't grow it unbounded.
//
// IDEMPOTENT: each entry carries a stable bridge-generated `bridgeEventId`. A
// re-flush after a lost ACK reuses the same id, so the gateway's outbox dedupe
// (`bridge:<deviceId>:<bridgeEventId>`) collapses it to ONE row — exactly-once
// delivery despite at-least-once flushing.

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface BridgeNotificationEntry {
  /** Stable idempotency key (UUID). Reused across re-flushes of the same entry. */
  bridgeEventId: string;
  /** An allow-listed event code the gateway maps to server-controlled copy. */
  eventCode: string;
  /** Epoch ms when first enqueued. */
  enqueuedAt: number;
}

const QUEUE_FILE = 'pending-notifications.jsonl';
const MAX_ENTRIES = 50;

// Serialize all read-modify-write ops so a concurrent enqueue + remove can't clobber
// each other's file write (the bridge is single-process but these are async).
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = opChain.then(fn, fn);
  opChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function queuePath(stateDir: string): string {
  return path.join(stateDir, QUEUE_FILE);
}

/** Load all pending entries (skips malformed lines; returns [] when absent). */
export async function loadBridgeNotificationQueue(
  stateDir: string
): Promise<BridgeNotificationEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(queuePath(stateDir), 'utf8');
  } catch {
    return [];
  }
  const out: BridgeNotificationEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as Partial<BridgeNotificationEntry>;
      if (typeof e.bridgeEventId === 'string' && typeof e.eventCode === 'string') {
        out.push({
          bridgeEventId: e.bridgeEventId,
          eventCode: e.eventCode,
          enqueuedAt: typeof e.enqueuedAt === 'number' ? e.enqueuedAt : 0,
        });
      }
    } catch {
      // skip a malformed line rather than dropping the whole queue
    }
  }
  return out;
}

async function writeQueue(stateDir: string, entries: BridgeNotificationEntry[]): Promise<void> {
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = queuePath(stateDir);
  const tmp = path.join(stateDir, `.${QUEUE_FILE}.tmp-${process.pid}`);
  const body = entries.length ? entries.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
  await fsp.writeFile(tmp, body, { mode: 0o600 });
  await fsp.rename(tmp, file);
}

/**
 * Enqueue an outgoing notification, COALESCING to the latest entry per eventCode and
 * bounding the queue. Returns the new entry (with its stable bridgeEventId). Safe to
 * call when the gateway is down — it just persists for the next flush.
 */
export async function enqueueBridgeNotification(
  stateDir: string,
  eventCode: string
): Promise<BridgeNotificationEntry> {
  return serialize(async () => {
    const entries = await loadBridgeNotificationQueue(stateDir);
    // coalesce: drop any prior entry for the same eventCode (latest wins)
    const kept = entries.filter((e) => e.eventCode !== eventCode);
    const entry: BridgeNotificationEntry = {
      bridgeEventId: randomUUID(),
      eventCode,
      enqueuedAt: Date.now(),
    };
    kept.push(entry);
    // bound: keep the most-recent MAX_ENTRIES
    const bounded = kept.length > MAX_ENTRIES ? kept.slice(kept.length - MAX_ENTRIES) : kept;
    await writeQueue(stateDir, bounded);
    return entry;
  });
}

/** Remove an entry by bridgeEventId (clear-on-ack). No-op if already gone. */
export async function removeBridgeNotification(
  stateDir: string,
  bridgeEventId: string
): Promise<void> {
  return serialize(async () => {
    const entries = await loadBridgeNotificationQueue(stateDir);
    const kept = entries.filter((e) => e.bridgeEventId !== bridgeEventId);
    if (kept.length !== entries.length) await writeQueue(stateDir, kept);
  });
}
