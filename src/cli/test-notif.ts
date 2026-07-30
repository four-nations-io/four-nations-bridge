// E.8a (doc 88) — content-bridge notification SMOKE CLI.
//
// The bridge is DB-less, so it can't write the outbox directly. This CLI ENQUEUES a
// `bridge_test` notification onto the bridge's local disk queue; the RUNNING daemon
// flushes it to the gateway on its next settings tick (~30s) or reconnect, the
// gateway renders server copy + writes the outbox row, and the web-app drain
// delivers it. Exercises the FULL bridge store-and-forward path.
//
//   node dist/cli/test-notif.js      # (after `npm run build`)
//
// Run it on the SAME host/container as the daemon so it writes the same state dir.

import { loadConfig } from '../config';
import { enqueueBridgeNotification } from '../notifications/queue';

async function main(): Promise<void> {
  const config = loadConfig();
  const entry = await enqueueBridgeNotification(config.stateDir, 'bridge_test');
  // eslint-disable-next-line no-console
  console.log(
    `[test-notif] enqueued bridge_test (bridgeEventId=${entry.bridgeEventId}) into ` +
      `${config.stateDir}/pending-notifications.jsonl. The running bridge will flush it ` +
      `to the gateway on its next tick (~30s); it then delivers via the outbox drain.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[test-notif] failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
