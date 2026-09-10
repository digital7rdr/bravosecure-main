/**
 * Ratchet-snapshot CAPTURE scheduler — Phase-2 wire-up.
 *
 * Background
 * ----------
 * `ratchetSnapshot.ts` provides the primitives (serialize / encrypt /
 * decrypt / apply) and `sessionRatchetRecovery.applyRatchetSnapshot`
 * provides the restore-side consumer. Until now NOTHING called them on
 * the capture side, so the encrypted snapshot was never produced and
 * the restore path always reported `no_snapshot` — leaving the
 * "old inbound messages from the reinstall window" gap open.
 *
 * This module closes that: it periodically serializes the live per-peer
 * Double Ratchet state, AES-256-GCM-wraps it under the SAME backup
 * master key the message mirror uses, and uploads it through the active
 * `SnapshotTransport`. On the next reinstall, `applyRatchetSnapshot`
 * replays it BEFORE any inbound is processed, so ciphertext sent under
 * the captured ratchet state decrypts cleanly instead of being dropped.
 *
 * Design choices
 * --------------
 *  • Master-key source: the RAW 32-byte key from the OS keychain
 *    (`loadMirrorMasterKey`). identityBackup/messageMirror hold the key
 *    as an opaque `CryptoKey` (non-extractable), but the snapshot
 *    primitives need raw bytes to import a fresh GCM key. The keychain
 *    entry is the authoritative raw copy, written by setupBackup and by
 *    the restore screen, and gated by the same hardware-keystore /
 *    device-unlock policy as the SQLCipher DB key.
 *
 *  • Gating: capture is a no-op unless (a) the message mirror is enabled
 *    (master key is live in-session → the user has an active backup) and
 *    (b) the keychain still holds the raw key. No backup configured →
 *    nothing to capture, matching the mirror's own gate.
 *
 *  • Monotonic seq: persisted in AsyncStorage per-owner. Capture bumps
 *    it before each upload; restore reads it as the rollback floor for
 *    `applyRatchetSnapshot`. Both sides go through THIS module so the
 *    floor and the producer never diverge. The transport (in-memory and
 *    HTTP/backend) also enforces "reject older-or-equal seq" as defence
 *    in depth.
 *
 *  • Debounce: ratchet state changes on every send/receive, but
 *    uploading on every message would be wasteful and would hammer the
 *    backend. We coalesce to at most one capture per
 *    `MIN_CAPTURE_INTERVAL_MS`. The runtime calls `requestCapture()`
 *    liberally (timer tick, reconnect, app-foreground); the debounce
 *    turns that into a sane cadence.
 *
 * Security
 * --------
 *  • The serialized session records contain chain keys + ratchet state.
 *    They are NEVER logged and only ever leave this process AES-256-GCM
 *    encrypted under the backup master key. The server sees ciphertext +
 *    a plaintext seq integer.
 *  • A failed capture is always non-fatal — it must never break send /
 *    receive. Worst case the snapshot ages and the reinstall-window gap
 *    widens back toward the pre-fix behaviour for the un-captured delta.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {hmac} from '@noble/hashes/hmac.js';
import {sha256} from '@noble/hashes/sha2.js';
import type {CryptoStore} from '@bravo/messenger-core';
import {fromB64} from './backupCrypto';
import {
  serializeSessionSnapshot,
  encryptSessionSnapshot,
  getSnapshotTransport,
} from './ratchetSnapshot';
import {isMirrorEnabled} from './messageMirror';

const SEQ_KEY_PREFIX = 'bravo:backup:ratchet-snapshot-seq:';
const SEQ_FORMAT_VERSION = 'v2';

// L-18 — the snapshot-rollback floor is security-relevant: an attacker
// with AsyncStorage write access (rooted device) who LOWERS it lets a
// malicious server replay an OLDER ratchet snapshot (rolling the chain
// back to previously-burned keys). The Merkle commit seq got HMAC-tag
// protection in P1-N12; this counter now gets the same. On any keychain
// error we degrade to the untagged form (never breaking capture/restore),
// and a legacy plain-decimal value is trusted once so existing installs
// upgrade transparently on their next write.
async function seqSecret(ownerUserId: string): Promise<string | null> {
  try {
    const {getOrCreateMerkleSeqHmacKey} = require('../runtime/keychain') as
      typeof import('../runtime/keychain');
    return await getOrCreateMerkleSeqHmacKey(ownerUserId);
  } catch {
    return null;
  }
}

function tagSnapshotSeq(secretB64: string, ownerUserId: string, seq: number): string {
  const key = Buffer.from(secretB64, 'base64');
  // Domain-separated from the Merkle-commit tag ('userId:seq') so the two
  // counters can share the per-user keychain secret without a tag from
  // one being replayable as the other.
  const msg = Buffer.from(`snapshot:${ownerUserId}:${seq}`, 'utf8');
  return Buffer.from(hmac(sha256, key, msg)).toString('base64');
}

function timingSafeEqB64(a: string, b: string): boolean {
  if (a.length !== b.length) {return false;}
  let diff = 0;
  for (let i = 0; i < a.length; i++) {diff |= a.charCodeAt(i) ^ b.charCodeAt(i);}
  return diff === 0;
}

/**
 * Minimum spacing between two uploaded captures. Ratchet state advances
 * per message; 5 min keeps the snapshot fresh enough to close most of
 * the reinstall-window gap without turning every chat into an upload.
 */
export const MIN_CAPTURE_INTERVAL_MS = 5 * 60 * 1000;

interface SchedulerState {
  ownerUserId: string;
  store:       CryptoStore;
  lastCaptureAtMs: number;
  inFlight:    Promise<void> | null;
}

let state: SchedulerState | null = null;

/**
 * Bind the scheduler to the live owner + crypto store. Called by the
 * runtime once the SQLCipher store is open. Idempotent per owner — a
 * re-arm for the same owner just refreshes the store handle. Switching
 * owners resets the debounce clock so the new session captures promptly.
 */
export function armRatchetSnapshotScheduler(ownerUserId: string, store: CryptoStore): void {
  if (!ownerUserId) {return;}
  if (state && state.ownerUserId === ownerUserId) {
    state.store = store;
    return;
  }
  state = {ownerUserId, store, lastCaptureAtMs: 0, inFlight: null};
}

/** Tear down on logout / runtime rebuild so a stale store handle can't be written under the next owner. */
export function disarmRatchetSnapshotScheduler(): void {
  state = null;
}

async function readSeq(ownerUserId: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(`${SEQ_KEY_PREFIX}${ownerUserId}`);
    if (!raw) {return 0;}
    // Tagged (v2) form first.
    try {
      const parsed = JSON.parse(raw) as {v?: string; seq?: number; tag?: string};
      if (parsed?.v === SEQ_FORMAT_VERSION && typeof parsed.seq === 'number' && typeof parsed.tag === 'string') {
        const secret = await seqSecret(ownerUserId);
        if (secret) {
          const expected = tagSnapshotSeq(secret, ownerUserId, parsed.seq);
          if (timingSafeEqB64(parsed.tag, expected)) {
            return parsed.seq >= 0 ? Math.floor(parsed.seq) : 0;
          }
          // Tag mismatch — tampered or wrong secret. Treat as unknown (0)
          // so the rollback floor degrades to "accept" rather than trust
          // a forged (lowered) value that would DoS or roll back.
          console.warn('[ratchet-snapshot] cached seq tag invalid — treating as unknown');
          return 0;
        }
        // No secret available (keychain unavailable / test env) — can't
        // verify; use the value as-is defensively.
        return parsed.seq >= 0 ? Math.floor(parsed.seq) : 0;
      }
    } catch {
      /* not JSON — legacy plain-decimal value handled below */
    }
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

async function writeSeq(ownerUserId: string, seq: number): Promise<void> {
  try {
    const secret = await seqSecret(ownerUserId);
    const payload = secret
      ? JSON.stringify({v: SEQ_FORMAT_VERSION, seq, tag: tagSnapshotSeq(secret, ownerUserId, seq)})
      : String(seq);   // degraded (untagged) when keychain is unavailable
    await AsyncStorage.setItem(`${SEQ_KEY_PREFIX}${ownerUserId}`, payload);
  } catch {
    /* best-effort — a lost seq just means the next capture reuses the
       same number, which the transport's >= guard rejects, so we'd skip
       one upload. Non-fatal. */
  }
}

/**
 * Read the highest snapshot seq this device has persisted. Restore uses
 * it as the rollback floor passed to `applyRatchetSnapshot`. On a fresh
 * reinstall AsyncStorage is empty so this returns 0 — the very first
 * restore accepts any snapshot the server holds.
 */
export async function readPersistedSnapshotSeq(ownerUserId: string): Promise<number> {
  if (!ownerUserId) {return 0;}
  return readSeq(ownerUserId);
}

/**
 * Persist the seq that restore just applied so a subsequent in-session
 * re-restore (or the next capture) can't roll back below it.
 */
export async function persistAppliedSnapshotSeq(ownerUserId: string, seq: number): Promise<void> {
  if (!ownerUserId || !Number.isFinite(seq) || seq < 0) {return;}
  const current = await readSeq(ownerUserId);
  if (seq > current) {await writeSeq(ownerUserId, seq);}
}

/**
 * Resolve the raw 32-byte backup master key from the keychain. Returns
 * null when no backup is configured for this owner (nothing to encrypt
 * a snapshot under) — capture then no-ops.
 */
async function loadRawMasterKey(ownerUserId: string): Promise<Uint8Array | null> {
  try {
    const {loadMirrorMasterKey} = require('../runtime/keychain') as
      typeof import('../runtime/keychain');
    const b64 = await loadMirrorMasterKey(ownerUserId);
    if (!b64) {return null;}
    const raw = fromB64(b64);
    return raw.byteLength === 32 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Request a capture. Cheap to call from hot-ish paths (timer, reconnect,
 * foreground) — it self-debounces and coalesces concurrent calls.
 *
 *  • `force: true` bypasses the time debounce (used by an explicit
 *    "back up now" or pre-logout flush) but still coalesces with any
 *    in-flight capture.
 *
 * Returns the capture outcome for tests / telemetry; callers in the
 * runtime fire-and-forget.
 */
export async function requestCapture(opts: {force?: boolean} = {}): Promise<{
  reason: 'ok' | 'not_armed' | 'mirror_disabled' | 'debounced' | 'no_master_key'
        | 'no_transport' | 'no_sessions' | 'no_store_iter' | 'failed';
  uploaded?: number;
  seq?: number;
}> {
  const s = state;
  if (!s) {return {reason: 'not_armed'};}
  // Gate on the mirror being enabled — same authority gate the message
  // backup uses. No active backup → no snapshot.
  if (!isMirrorEnabled()) {return {reason: 'mirror_disabled'};}
  if (typeof s.store.listSessions !== 'function') {return {reason: 'no_store_iter'};}

  const now = Date.now();
  if (!opts.force && now - s.lastCaptureAtMs < MIN_CAPTURE_INTERVAL_MS) {
    return {reason: 'debounced'};
  }
  // Coalesce: if a capture is already running, await it rather than
  // starting a second one that would race on the seq counter.
  if (s.inFlight) {
    await s.inFlight;
    return {reason: 'debounced'};
  }

  const run = async (): Promise<{
    reason: 'ok' | 'no_master_key' | 'no_transport' | 'no_sessions' | 'no_store_iter' | 'failed';
    uploaded?: number;
    seq?: number;
  }> => {
    const transport = getSnapshotTransport();
    if (!transport) {return {reason: 'no_transport'};}
    const masterKeyRaw = await loadRawMasterKey(s.ownerUserId);
    if (!masterKeyRaw) {return {reason: 'no_master_key'};}
    try {
      const nextSeq = (await readSeq(s.ownerUserId)) + 1;
      const snapshot = await serializeSessionSnapshot(s.store, nextSeq);
      if (!snapshot) {return {reason: 'no_store_iter'};}
      if (snapshot.sessions.length === 0) {
        // Nothing to protect yet — don't burn a seq or an upload.
        return {reason: 'no_sessions'};
      }
      const env = await encryptSessionSnapshot(masterKeyRaw, snapshot);
      await transport.upload(env);
      // Persist the seq only AFTER a successful upload so a failed
      // upload doesn't advance the floor past what the server holds.
      await writeSeq(s.ownerUserId, nextSeq);
      s.lastCaptureAtMs = Date.now();
      return {reason: 'ok', uploaded: snapshot.sessions.length, seq: nextSeq};
    } catch (e) {
      // B-67 — stale_seq self-heal (mirror of the B-50 merkle adopt-and-
      // retry, which never existed on THIS path): the server holds seq S ≥
      // our local counter (fresh keychain/AsyncStorage, tag-mismatch reset
      // to 0, or another device advanced it). The 409 body carries S —
      // adopt S+1 (the sessions guard is `>=`), re-serialize, retry ONCE.
      // Without this the 2026-07-10 Pixel-7a hammered the same rejected
      // seq every 4 s heartbeat indefinitely and snapshots froze at S.
      // Structural check (not `instanceof BackupError`): importing
      // backupClient here pulls expo/virtual/env into the Jest module
      // graph and breaks every suite that loads this scheduler.
      const be = e as {kind?: string; meta?: {currentSeq?: number}} | null;
      const serverSeq = be?.kind === 'stale_seq' ? Number(be.meta?.currentSeq) : NaN;
      if (Number.isFinite(serverSeq)) {
        try {
          const adopted = serverSeq + 1;
          console.warn(`[ratchet-snapshot] stale_seq server=${serverSeq} — adopting seq=${adopted} and retrying once`);
          const snapshot = await serializeSessionSnapshot(s.store, adopted);
          if (snapshot && snapshot.sessions.length > 0) {
            const env = await encryptSessionSnapshot(masterKeyRaw, snapshot);
            await transport.upload(env);
            await writeSeq(s.ownerUserId, adopted);
            s.lastCaptureAtMs = Date.now();
            return {reason: 'ok', uploaded: snapshot.sessions.length, seq: adopted};
          }
        } catch (e2) {
          console.warn('[bravo.ratchet-snapshot] stale_seq adopt-retry failed:', (e2 as Error).message);
        }
      }
      // B-67 — hold the debounce on failure too. lastCaptureAtMs used to
      // advance only on success, so a persistent failure defeated the
      // 5-min debounce and every 4 s heartbeat ran a full serialize+
      // encrypt+upload attempt (battery/data drain, forever).
      s.lastCaptureAtMs = Date.now();
      console.warn('[bravo.ratchet-snapshot] capture failed:', (e as Error).message);
      return {reason: 'failed'};
    } finally {
      // L-17 — zero the raw backup master key on EVERY exit (incl. the
      // no_sessions / no_store_iter early returns, which previously left
      // the 32-byte key un-scrubbed in JS memory).
      masterKeyRaw.fill(0);
    }
  };

  const promise = run();
  // Track an erasure-typed void promise so concurrent callers can await
  // without seeing the result shape.
  s.inFlight = promise.then(() => undefined, () => undefined);
  try {
    return await promise;
  } finally {
    s.inFlight = null;
  }
}
