// AUDIT-2026-08-13 #8 — TOMBSTONE BARREL (nothing imports '../transport'
// itself; the live files are imported directly). B-152 already deleted
// relayClient/senderCertClient/certCache from here for the same reason.
// The two LIVE local modules keep their direct import paths:
//   keysClient.ts — vault/vaultOps.ts imports it directly;
//   ackQueue.ts   — productionRuntime imports it directly.
// Everything else this barrel used to export was an orphaned fork of
// @bravo/messenger-core (TransportClient, UsersHttpClient, the stale
// protocol mirror) — resolve there. No orphan exports may return here
// (deadForkLock.test.ts).
export {KeysHttpClient, KeysHttpError, type KeysHttpClientOptions} from './keysClient';
export {enqueueAck, flushAckQueue, disposeAckQueue} from './ackQueue';
