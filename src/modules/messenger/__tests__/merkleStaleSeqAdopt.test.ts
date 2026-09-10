/**
 * B-50 — fresh-install restore self-heal vs the server's monotonic seq guard.
 *
 * On-device repro (2026-07-06, v1.0.100): restore on a reinstalled device
 * failed `root_mismatch` even though the S8 self-heal re-committed over the
 * exact fetched leaves. Root cause chain:
 *   1. the local Merkle seq cache lives in the keychain/AsyncStorage — a
 *      fresh install has none, so commitMerkleRoot ships seq=1;
 *   2. the server's putMerkleCommit monotonic guard (L-9) 409s any seq
 *      strictly below the stored one ({error:'stale_seq', currentSeq});
 *   3. backupClient mapped EVERY 409 to 'verifier_missing' and dropped the
 *      body, so the caller could neither detect nor recover;
 *   4. recommitAndReverify caught the throw → returned false → hard
 *      root_mismatch on a perfectly healthy backup.
 * The fix: backupClient surfaces kind='stale_seq' + meta.currentSeq, and
 * commitMerkleRoot adopts currentSeq+1 and retries ONCE.
 *
 * The fake server here enforces the real guard — the previous test file's
 * fake accepted any seq, which is exactly why this class was invisible.
 */
import {computeMerkleRoot} from '../backup/backupMerkle';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async () => null,     // fresh install: no cached seq anchor
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  getOrCreateMerkleSeqHmacKey: async () => Buffer.alloc(32, 7).toString('base64'),
}));

// Stateful fake server WITH the production monotonic guard (L-9).
jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    meta?: Record<string, unknown>;
    constructor(kind: string, msg: string, meta?: Record<string, unknown>) {
      super(msg); this.name = 'BackupError'; this.kind = kind; this.meta = meta;
    }
  }
  let stored: {rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string} | null = null;
  const putCalls: number[] = [];
  return {
    __esModule: true,
    BackupError,
    __seed: (c: {rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string}) => { stored = c; },
    __stored: () => stored,
    __putCalls: putCalls,
    backupClient: {
      getMessages: jest.fn(async () => ({messages: []})),
      putMerkleCommit: jest.fn(async (c: {rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string}) => {
        putCalls.push(c.seq);
        if (stored && stored.seq > c.seq) {
          throw new BackupError('stale_seq', 'stale_seq', {currentSeq: stored.seq});
        }
        stored = c;
        return {ok: true};
      }),
      getMerkleCommit: jest.fn(async () => stored),
      getSessions: async () => null,
    },
  };
});

jest.mock('@privacyresearch/curve25519-typescript', () => ({
  __esModule: true,
  AsyncCurve25519Wrapper: class {
    async sign(): Promise<ArrayBuffer> { return new Uint8Array(64).buffer; }
    async verify(): Promise<boolean> { return false; } // false = "NOT invalid" = valid sig
  },
}));

import {commitMerkleRoot, verifyMerkleCommit} from '../backup/merkleCommit';
import {toB64} from '../backup/backupCrypto';
import type {MerkleRow} from '../backup/backupMerkle';


const fake = require('../backup/backupClient') as {
  __seed: (c: {rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string}) => void;
  __stored: () => {rootB64: string; rowCount: number; seq: number} | null;
  __putCalls: number[];
};

const ROWS: MerkleRow[] = Array.from({length: 11}, (_, i) => ({
  message_id:     `m${String(i).padStart(4, '0')}`,
  msg_created_at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  ciphertext:     `ct-${i}`,
}));

const PRIV = new Uint8Array(32).fill(9).buffer;
const PUB  = new Uint8Array(32).fill(3).buffer;
const USER = 'restore-user@test';

beforeEach(() => {
  fake.__putCalls.length = 0;
});

describe('B-50 — stale_seq adopt-and-retry', () => {
  it('fresh install vs server seq=7: first PUT 409s, retry adopts seq=8 and ships', async () => {
    // Old device's commit at seq=7, signed over a DRIFTED byte-form
    // (same count, different root) — the on-device state.
    const drifted = ROWS.map((r, i) => i === 5 ? {...r, ciphertext: r.ciphertext + 'X'} : r);
    fake.__seed({rootB64: toB64(computeMerkleRoot(drifted)), rowCount: 11, seq: 7, sentAtMs: 1, sigB64: toB64(new Uint8Array(64))});

    const res = await commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS});
    expect(res).not.toBeNull();
    expect(fake.__putCalls).toEqual([1, 8]);     // seq=1 rejected, seq=8 adopted
    expect(res!.seq).toBe(8);
    expect(fake.__stored()!.seq).toBe(8);
    expect(fake.__stored()!.rootB64).toBe(toB64(computeMerkleRoot(ROWS)));
  });

  it('full self-heal now converges: root_mismatch → re-commit → verify ok', async () => {
    const drifted = ROWS.map((r, i) => i === 5 ? {...r, ciphertext: r.ciphertext + 'X'} : r);
    fake.__seed({rootB64: toB64(computeMerkleRoot(drifted)), rowCount: 11, seq: 7, sentAtMs: 1, sigB64: toB64(new Uint8Array(64))});

    // 1. First verify fails exactly as on-device (equal count, root drift).
    const first = await verifyMerkleCommit({identityPubKey: PUB, userId: USER, rows: ROWS});
    expect(first.ok).toBe(false);
    if (!first.ok) {expect(first.reason).toBe('root_mismatch');}

    // 2. What recommitAndReverify does: re-commit over the fetched rows …
    const committed = await commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS});
    expect(committed).not.toBeNull();

    // 3. … then re-verify. Pre-fix this path never got here (the PUT threw).
    const retry = await verifyMerkleCommit({identityPubKey: PUB, userId: USER, rows: ROWS});
    expect(retry.ok).toBe(true);
  });

  it('retries only ONCE — a server that keeps rejecting still fails closed', async () => {
    // Guard that always rejects (stored seq climbs ahead of every attempt).
    const drifted = ROWS.map((r, i) => i === 2 ? {...r, ciphertext: r.ciphertext + 'Y'} : r);
    fake.__seed({rootB64: toB64(computeMerkleRoot(drifted)), rowCount: 11, seq: 7, sentAtMs: 1, sigB64: toB64(new Uint8Array(64))});

    const {backupClient, BackupError} = require('../backup/backupClient');
    (backupClient.putMerkleCommit as jest.Mock).mockImplementation(async (c: {seq: number}) => {
      fake.__putCalls.push(c.seq);
      throw new BackupError('stale_seq', 'stale_seq', {currentSeq: c.seq + 6});
    });

    await expect(commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS})).rejects.toThrow();
    expect(fake.__putCalls).toEqual([1, 8]);     // exactly one adopt-retry, no loop
  });
});
