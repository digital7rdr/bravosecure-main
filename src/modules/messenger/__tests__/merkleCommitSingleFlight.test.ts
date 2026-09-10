/**
 * sqa.md bug register — this suite pins: B-167.
 *
 * BUG-1 strict commit serialization = B-167.
 * Source of the mapping: docs/audits/BACKUP_AUDIT_2026-07-24.md (§2 table + §5
 * suite map). The cases below carry the audit-internal BUG-x ids; this block is
 * the crosswalk so an sqa.md bug id greps to its regression test.
 */
/**
 * BUG-1 (audit 2026-07-23) — commitMerkleRoot is single-flight.
 *
 * The commit has ≥6 unserialized entry points (debounce timer, AppState
 * background force, catch-up sweep, repair, setup baseline). Two
 * overlapping commits could ship OUT OF ORDER: a slow walk-A finishing
 * after a fresh walk-B meant A's stale root 409'd and the I6 adopt then
 * re-signed THAT STALE ROOT at a higher seq — the server accepted
 * pre-flush bytes as the newest signed commit while the pending flag was
 * already cleared: a permanent equal-count root_mismatch with no heal.
 *
 * The fix chains every call in arrival order; this pins that a second
 * commit's server walk cannot begin until the first commit fully shipped.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    },
  };
});
jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  getOrCreateMerkleSeqHmacKey: async () => Buffer.alloc(32, 7).toString('base64'),
}));
jest.mock('@privacyresearch/curve25519-typescript', () => ({
  __esModule: true,
  AsyncCurve25519Wrapper: class {
    async sign(): Promise<ArrayBuffer> { return new Uint8Array(64).buffer; }
    async verify(): Promise<boolean> { return false; }
  },
}));
jest.mock('../backup/mirrorLedger', () => ({
  __esModule: true,
  getFlushEpoch: () => 0,
  clearMerkleCommitPendingIfNoFlushSince: jest.fn(async () => undefined),
}));

const mockEvents: string[] = [];
let mockReleaseFirstWalk!: () => void;
const mockFirstWalkGate = new Promise<void>(r => { mockReleaseFirstWalk = r; });
const mockWalkCounter = {n: 0};

jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, msg: string) { super(msg); this.name = 'BackupError'; this.kind = kind; }
  }
  return {
    __esModule: true,
    BackupError,
    backupClient: {
      getMessages: jest.fn(async () => {
        mockWalkCounter.n += 1;
        const call = mockWalkCounter.n;
        mockEvents.push(`walk-${call}:start`);
        if (call === 1) {
          // Commit A's walk stalls (slow network) until released.
          await mockFirstWalkGate;
        }
        mockEvents.push(`walk-${call}:end`);
        return {messages: []};
      }),
      putMerkleCommit: jest.fn(async (c: {seq: number}) => {
        mockEvents.push(`put:seq=${c.seq}`);
        return {ok: true};
      }),
    },
  };
});

import {commitMerkleRoot} from '../backup/merkleCommit';

const PRIV = new Uint8Array(32).fill(9).buffer;

describe('BUG-1 — merkle commit single-flight serialization', () => {
  it('a second commit cannot start its server walk until the first fully shipped', async () => {
    const a = commitMerkleRoot({identityPrivKey: PRIV, userId: 'u-1'});
    const b = commitMerkleRoot({identityPrivKey: PRIV, userId: 'u-1'});

    // Give A a beat to enter its (stalled) walk; B must NOT have started.
    await new Promise(r => setTimeout(r, 50));
    expect(mockEvents).toContain('walk-1:start');
    expect(mockEvents).not.toContain('walk-2:start');

    mockReleaseFirstWalk();
    await Promise.all([a, b]);

    // Strict serialization: A walked AND shipped before B even started.
    const aPut = mockEvents.findIndex(e => e.startsWith('put:'));
    const bStart = mockEvents.indexOf('walk-2:start');
    expect(aPut).toBeGreaterThanOrEqual(0);
    expect(bStart).toBeGreaterThan(aPut);
    // Both shipped, in seq order.
    const puts = mockEvents.filter(e => e.startsWith('put:'));
    expect(puts).toEqual(['put:seq=1', 'put:seq=2']);
  });

  it('a rejected commit does not wedge the chain — the next commit still runs', async () => {
    const {backupClient} = require('../backup/backupClient') as {
      backupClient: {putMerkleCommit: jest.Mock};
    };
    backupClient.putMerkleCommit.mockRejectedValueOnce(new Error('http_502'));
    await expect(commitMerkleRoot({identityPrivKey: PRIV, userId: 'u-1'})).rejects.toThrow('http_502');
    await expect(commitMerkleRoot({identityPrivKey: PRIV, userId: 'u-1'})).resolves.toMatchObject({rowCount: 0});
  });
});
