// Pairing probe + claim — Phase F V0.8.b, two-token claim V0.9d.
//
// Opens a one-shot WSS connection presenting the pairing code as the bearer +
// this bridge's stable device_key, sends HELLO, awaits HELLO_ACK, closes.
//
// V0.9d TWO-TOKEN: the pairing code is a SINGLE-USE claim ticket. On a valid
// code the gateway consumes it and returns a gateway-minted, per-device
// `deviceBearer` in the HELLO_ACK — the durable credential the caller PERSISTS
// (paired.json) and uses for every reconnect. The claim code itself is never
// stored as the credential. Because this probe IS the claim, the caller must
// pass the SAME `deviceKey` it will persist (so the device row the gateway binds
// matches the reconnecting daemon — no orphan row), and must persist the returned
// `deviceBearer`. A failed probe (bad/used code, unreachable) consumes nothing
// recoverable and leaves a clear error — not a crash-looping daemon.

import WebSocket from 'ws';

export type ProbeFailureReason =
  | 'unauthorized' // gateway rejected the pairing code (401)
  | 'label-rejected' // gateway rejected the bridge name (403)
  | 'unreachable' // TCP/DNS/TLS failure reaching the gateway
  | 'timeout' // no HELLO_ACK within the window
  | 'protocol'; // connected but the exchange didn't complete cleanly

export type ProbeResult =
  | { ok: true; deviceId: number | null; deviceBearer: string | null }
  | { ok: false; reason: ProbeFailureReason; detail: string };

const PROBE_TIMEOUT_MS = 10_000;

export function probePairing(params: {
  saasUrl: string;
  pairingCode: string;
  /** Stable per-install identity to bind the claim to (same value the caller
   *  persists in paired.json + the daemon presents on reconnect). */
  deviceKey: string;
  deviceLabel: string;
  devicePlatform: string;
  appVersion: string;
}): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        ws.terminate();
      }
      resolve(result);
    };

    const ws = new WebSocket(params.saasUrl, {
      headers: {
        Authorization: `Bearer ${params.pairingCode}`,
        'X-Content-Bridge-Device-Label': params.deviceLabel,
        // V0.9d: bind the claim to the identity the daemon will reconnect with,
        // so the gateway's device row matches (no orphaned probe-only row) and
        // the issued bearer is scoped to this device.
        'X-Content-Bridge-Device-Key': params.deviceKey,
      },
      handshakeTimeout: PROBE_TIMEOUT_MS,
    });

    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout', detail: 'no HELLO_ACK within 10s' });
    }, PROBE_TIMEOUT_MS);

    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0;
      if (code === 401) {
        finish({ ok: false, reason: 'unauthorized', detail: 'pairing code rejected (401)' });
      } else if (code === 403) {
        finish({ ok: false, reason: 'label-rejected', detail: 'bridge name rejected (403)' });
      } else {
        finish({ ok: false, reason: 'protocol', detail: `unexpected HTTP ${code}` });
      }
    });

    ws.on('error', (err) => {
      finish({ ok: false, reason: 'unreachable', detail: err.message });
    });

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'HELLO',
          deviceLabel: params.deviceLabel,
          devicePlatform: params.devicePlatform,
          appVersion: params.appVersion,
          plugins: [],
        })
      );
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse((raw as Buffer).toString('utf8')) as {
          type?: string;
          deviceId?: number;
          deviceBearer?: string;
        };
        if (msg?.type === 'HELLO_ACK') {
          finish({
            ok: true,
            deviceId: typeof msg.deviceId === 'number' ? msg.deviceId : null,
            // V0.9d two-token: the gateway-minted per-device bearer. null when the
            // gateway didn't issue one (e.g. a shared bearer pasted into the code
            // field) — the caller then falls back to persisting the submitted code.
            deviceBearer: typeof msg.deviceBearer === 'string' ? msg.deviceBearer : null,
          });
        }
      } catch {
        finish({ ok: false, reason: 'protocol', detail: 'malformed gateway response' });
      }
    });
  });
}
