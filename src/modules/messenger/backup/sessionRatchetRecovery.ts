/**
 * Session-ratchet recovery — Phase 2.
 *
 * Background:
 *   The other 4 fixes in the restore-after-reinstall round close the
 *   biggest holes (hydrate cap, master-key persistence, server-side
 *   sealed-envelope archive, bootstrap pull). Together they recover
 *   ~95%+ of typical histories on a clean reinstall.
 *
 *   The remaining ~5% is structurally hard. After a fresh install:
 *     • The user's IDENTITY key is restored from the backup bundle.
 *     • The user's SESSION RATCHETS (per-peer Double Ratchet state)
 *       are NOT restored — they live in SQLCipher only, and the
 *       SQLCipher DB itself was wiped by the OS on uninstall.
 *
 *   So old relay envelopes that were Signal-encrypted under the OLD
 *   ratchet state can't be opened — even though the identity key is
 *   correct, the chain key + counter advanced beyond what the new
 *   client can derive. handleIncoming detects this (DecryptError),
 *   nudges the peer to rebuild, and ack-and-drops the unreadable
 *   bytes.
 *
 *   For a true 100% recovery, the design space is:
 *
 *   (A) Sender Keys (Signal's group protocol, repurposed for 1:1)
 *       — messages encrypted to the recipient's identity key alone,
 *       no ratchet state required. Perfect-forward-secrecy is weaker
 *       than the Double Ratchet but the gap closes for restore.
 *       Adopting requires a new wire format and is a Phase-2 project.
 *
 *   (B) Encrypted ratchet snapshot in the backup bundle
 *       — periodically serialize the SessionStore to bytes, AES-GCM
 *       wrap with the master key, upload alongside identity backup.
 *       On restore, deserialize before processing any inbound. Cheap
 *       to implement; downside is the snapshot ages, so messages
 *       sent in the gap between snapshot and reinstall still drop.
 *
 *   (C) Hybrid — (B) by default, (A) for new conversations only.
 *
 *   We are NOT shipping (A) or (B) in this round. This file exists so
 *   the rest of the codebase has a stable hook + symbol to call when
 *   we DO ship; it lets us count + telemetry the gap today and lights
 *   up the placeholder logging users have been asking for ("how many
 *   messages couldn't be restored?").
 */

let undecryptableSinceRestore = 0;

/**
 * Bump the counter every time handleIncoming or restoreMessages drops
 * an undecryptable row that is plausibly attributable to a missing
 * ratchet (DecryptError, Bad MAC, GCM auth-tag fail).
 */
export function noteUndecryptable(reason: string): void {
  undecryptableSinceRestore += 1;
  // Console-only — wire this into Crashlytics/Sentry if you want
  // breadcrumb-level visibility into the restore gap.
  console.warn(`[bravo.ratchet-recovery] dropped undecryptable (${reason}); cumulative=${undecryptableSinceRestore}`);
}

export function getUndecryptableCount(): number {
  return undecryptableSinceRestore;
}

export function resetUndecryptableCount(): void {
  undecryptableSinceRestore = 0;
}

/**
 * Apply an encrypted ratchet snapshot at restore time.
 *
 * Path: fetch the latest envelope via the configured snapshot
 * transport → decrypt with the in-memory backup master key →
 * replay every (identifier, record) pair into the live CryptoStore.
 * Subsequent inbound ciphertext can libsignal-decrypt because the
 * chain key + ratchet state is in place again.
 *
 * Rollback defence: the caller MUST persist the highest applied
 * `seq` in AsyncStorage. This helper only enforces "snapshot is
 * fresher than the one in the transport"; the persisted seq guards
 * against a server-stored older envelope being served on a future
 * restore.
 *
 * Returns:
 *   - ok: snapshot fetched + applied; `applied` is the row count
 *   - no_snapshot: transport returned null (no snapshot has been uploaded yet)
 *   - no_transport: caller never wired a snapshot transport
 *   - no_store_iter: the CryptoStore doesn't expose listSessions (apply not possible)
 *   - decrypt_failed: ciphertext rejected (wrong key or tampered)
 *   - older_seq: snapshot seq is <= persistedSeq; refuse rollback
 *   - seq_mismatch: plaintext header seq != AEAD-authenticated inner seq
 */
export async function applyRatchetSnapshot(
  store:        import('@bravo/messenger-core').CryptoStore,
  masterKeyRaw: Uint8Array,
  persistedSeq: number,
): Promise<{
  applied: number;
  seq:     number | null;
  reason:  'ok' | 'no_snapshot' | 'no_transport' | 'no_store_iter' | 'decrypt_failed' | 'older_seq' | 'seq_mismatch';
}> {
  const {
    applySessionSnapshotToStore,
    decryptSessionSnapshot,
    getSnapshotTransport,
  } = require('./ratchetSnapshot') as typeof import('./ratchetSnapshot');

  const transport = getSnapshotTransport();
  if (!transport) {return {applied: 0, seq: null, reason: 'no_transport'};}
  if (typeof store.listSessions !== 'function') {
    return {applied: 0, seq: null, reason: 'no_store_iter'};
  }
  const env = await transport.fetchLatest();
  if (!env) {return {applied: 0, seq: null, reason: 'no_snapshot'};}
  if (env.seq <= persistedSeq) {
    return {applied: 0, seq: env.seq, reason: 'older_seq'};
  }
  let plain;
  try {
    plain = await decryptSessionSnapshot(masterKeyRaw, env);
  } catch (e) {
    console.warn('[bravo.ratchet-snapshot] unwrap failed:', (e as Error).message);
    return {applied: 0, seq: env.seq, reason: 'decrypt_failed'};
  }
  // P2-B-3 — the rollback floor above compared only the UNAUTHENTICATED
  // plaintext header seq. A malicious server can inflate `env.seq` past
  // the floor while serving an OLDER snapshot blob (the inner seq is
  // AES-GCM-authenticated; the header is not). Enforce the floor against
  // the AUTHENTICATED inner seq and reject any header/inner divergence.
  if (typeof plain.seq !== 'number' || !Number.isFinite(plain.seq)) {
    return {applied: 0, seq: env.seq, reason: 'seq_mismatch'};
  }
  if (plain.seq !== env.seq) {
    console.warn(`[bravo.ratchet-snapshot] header seq=${env.seq} != authenticated seq=${plain.seq} — rejecting`);
    return {applied: 0, seq: plain.seq, reason: 'seq_mismatch'};
  }
  if (plain.seq <= persistedSeq) {
    return {applied: 0, seq: plain.seq, reason: 'older_seq'};
  }
  const {applied, seq} = await applySessionSnapshotToStore(store, plain);
  return {applied, seq, reason: 'ok'};
}
