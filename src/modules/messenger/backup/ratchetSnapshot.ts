/**
 * Encrypted ratchet-state snapshot for restore-after-reinstall.
 *
 * Why this exists
 * ---------------
 * The identity backup (identityBackup.ts) covers the long-lived
 * identity key + prekeys but NOT the per-peer Signal ratchet state.
 * After reinstall the ratchets are gone, so any envelope sent by a
 * peer who hasn't seen our identity rotation will libsignal-decrypt
 * with status 2 ("error in DoCipher") — the chain key is missing.
 * The existing `noteUndecryptable` counter records this but the
 * messages stay lost.
 *
 * Architecture
 * ------------
 * - serializeSessionSnapshot() walks the live CryptoStore via the
 *   optional listSessions() iterator (added in this round) and
 *   produces a flat array of {identifier, record} entries.
 * - encryptSessionSnapshot() wraps the serialized snapshot in
 *   AES-256-GCM under the in-memory master key from
 *   identityBackup.liveMasterKey (the same gate as message mirror).
 * - The wire shape ships through a new backup endpoint
 *   /backup/identity/sessions (POST to put, GET to fetch). The
 *   backend column + endpoints are an open task; until they ship,
 *   the client uses an in-memory store via `setSnapshotTransport()`
 *   so tests + the local-only path are correct end-to-end. When the
 *   backend ships, swap the transport to a backupClient adapter.
 * - applyRatchetSnapshot() (in sessionRatchetRecovery.ts) calls
 *   downloadAndDecryptSnapshot + walks each row into storeSession.
 *
 * Security properties
 * -------------------
 * - The snapshot is encrypted with AES-256-GCM under the backup
 *   master key (which itself is wrapped with argon2id(password)).
 *   The server sees only ciphertext.
 * - Replay defense: each snapshot embeds a monotonically-increasing
 *   `seq` field. Restore refuses to apply a snapshot whose `seq` is
 *   less than the highest seq already applied — prevents an
 *   attacker-controlled server from replaying an old snapshot to
 *   roll the receiver back to a prior ratchet state.
 * - Per-peer session records are libsignal-serialized strings; the
 *   plaintext contains chain keys + ratchet state. NEVER log them.
 *
 * Limitations
 * -----------
 * - A snapshot ages. Messages sent in the window between snapshot
 *   capture and reinstall still fail libsignal decrypt. The window
 *   is whatever the caller's upload cadence is (this module exposes
 *   the primitives; the cadence is wired by the runtime).
 * - Snapshots do NOT include the sender chain's pending-message
 *   queue — only the long-lived per-session ratchet state. Pending
 *   sends are recovered via the regular outbox replay path.
 */

import type {CryptoStore} from '@bravo/messenger-core';
import {aesGcmDecrypt, aesGcmEncrypt, importMasterKey, fromB64, toB64} from './backupCrypto';

export const SNAPSHOT_WIRE_VERSION = 1;
const MAGIC = 'bravo-ratchet-snapshot-v1';

/**
 * Plaintext snapshot shape. The `seq` is monotonic per-account so
 * restore can refuse rollback. `capturedAtMs` is informational.
 */
export interface RatchetSnapshotPlain {
  v:            1;
  magic:        typeof MAGIC;
  seq:          number;
  capturedAtMs: number;
  /** libsignal-serialized session records keyed by address. */
  sessions:     Array<{identifier: string; record: string}>;
}

export interface RatchetSnapshotEnvelope {
  /**
   * Base64 IV-prefixed AES-256-GCM ciphertext (12 byte IV || ct || tag).
   * Same shape used by aesGcmEncrypt/Decrypt — single string, no
   * separate IV field. The IV is fresh per upload.
   */
  blob: string;
  /** Plaintext header — server-visible, used for seq enforcement. */
  seq: number;
}

/**
 * Serialize the live ratchet state. Returns null when the store
 * doesn't expose listSessions (test harness or future store).
 */
export async function serializeSessionSnapshot(
  store: CryptoStore,
  seq:   number,
): Promise<RatchetSnapshotPlain | null> {
  if (typeof store.listSessions !== 'function') {return null;}
  const sessions = await store.listSessions();
  return {
    v:            1,
    magic:        MAGIC,
    seq,
    capturedAtMs: Date.now(),
    sessions,
  };
}

/**
 * Encrypt under the unlocked backup master key. Caller passes the
 * raw 32-byte master-key bytes — typically the same key
 * identityBackup.ts holds in `liveMasterKey`. We import on each call
 * rather than caching to avoid a long-lived imported CryptoKey
 * surface; importKey is cheap.
 */
export async function encryptSessionSnapshot(
  masterKeyRaw: Uint8Array,
  snapshot:     RatchetSnapshotPlain,
): Promise<RatchetSnapshotEnvelope> {
  const masterKey = await importMasterKey(masterKeyRaw);
  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
  const blob = await aesGcmEncrypt(masterKey, plaintext);
  return {
    blob: toB64(blob),
    seq:  snapshot.seq,
  };
}

/**
 * Decrypt + validate. Throws if the magic / version don't match
 * (defends against a substituted envelope from a different feature).
 */
export async function decryptSessionSnapshot(
  masterKeyRaw: Uint8Array,
  envelope:     RatchetSnapshotEnvelope,
): Promise<RatchetSnapshotPlain> {
  const masterKey = await importMasterKey(masterKeyRaw);
  const blob = fromB64(envelope.blob);
  let plaintext: Uint8Array;
  try {
    plaintext = await aesGcmDecrypt(masterKey, blob);
  } catch (e) {
    throw new Error('ratchet-snapshot decrypt failed (wrong master key or tampered envelope)');
  }
  const json = new TextDecoder().decode(plaintext);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('ratchet-snapshot plaintext is not JSON');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as {magic?: unknown}).magic !== MAGIC ||
    (parsed as {v?: unknown}).v !== 1 ||
    !Array.isArray((parsed as {sessions?: unknown}).sessions)
  ) {
    throw new Error('ratchet-snapshot magic/version/shape mismatch');
  }
  return parsed as RatchetSnapshotPlain;
}

/**
 * Apply a decrypted snapshot to the local store. Replays every
 * (identifier, record) pair via storeSession. Returns the number
 * applied + the seq that was applied — caller persists the seq so
 * subsequent applies can refuse rollback.
 */
export async function applySessionSnapshotToStore(
  store:    CryptoStore,
  snapshot: RatchetSnapshotPlain,
): Promise<{applied: number; seq: number}> {
  let applied = 0;
  for (const {identifier, record} of snapshot.sessions) {
    if (typeof identifier !== 'string' || typeof record !== 'string') {continue;}
    // L21 snapshot-apply-clobbers-fresh-session-on-restore — never overwrite a
    // session that ALREADY exists in the store. The snapshot was captured
    // before the reinstall, so anything already present is strictly newer: a
    // fresh install starts empty, and the only way a session exists at apply
    // time is a peer that sent (establishing a fresh X3DH session) in the brief
    // window between the runtime rebuild and this apply. Restoring the stale
    // snapshot over it would brick that live session (Bad MAC on its next msg).
    const existing = await store.loadSession(identifier);
    if (existing) {continue;}
    await store.storeSession(identifier, record);
    applied += 1;
  }
  return {applied, seq: snapshot.seq};
}

// ─── Local transport (until backend endpoints land) ────────────

/**
 * Snapshot transport surface. The production wire-up will adapt
 * this to backupClient.{putSessions, getSessions}; until those
 * backend endpoints exist, tests + the bootstrap path can install
 * an in-memory transport that round-trips locally so the rest of
 * the pipeline is exercised.
 */
export interface SnapshotTransport {
  upload(env: RatchetSnapshotEnvelope): Promise<{ok: true}>;
  fetchLatest(): Promise<RatchetSnapshotEnvelope | null>;
}

let activeTransport: SnapshotTransport | null = null;

export function setSnapshotTransport(t: SnapshotTransport | null): void {
  activeTransport = t;
}

export function getSnapshotTransport(): SnapshotTransport | null {
  return activeTransport;
}

/** Default in-memory transport — used by tests + the pre-backend bootstrap. */
export function makeInMemorySnapshotTransport(): SnapshotTransport {
  let stored: RatchetSnapshotEnvelope | null = null;
  return {
    async upload(env) {
      if (stored && stored.seq >= env.seq) {
        // Idempotent: reject older or equal seqs. The server-side
        // endpoint will enforce the same rule.
        return {ok: true};
      }
      stored = env;
      return {ok: true};
    },
    async fetchLatest() { return stored; },
  };
}
