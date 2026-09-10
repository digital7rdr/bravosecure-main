/**
 * Regression — `commitMerkleRoot` must page with the SAME tuple cursor
 * (msg_created_at, message_id) that restoreMessages.ts uses.
 *
 * The bug: commitMerkleRoot paged with a timestamp-only cursor
 * (`getMessages(cursor, 1000)`), while the restore path used the tuple
 * cursor (`getMessages(cursorTs, 1000, cursorId)`). When a duplicate
 * msg_created_at straddled a 1000-row page boundary, the timestamp-only
 * commit cursor advanced PAST the tied rows on the next page and silently
 * dropped them — so the signed root covered fewer rows than the restore
 * side recomputes. Every restore for a >1000-message account then failed
 * verifyMerkleCommit with `root_mismatch`, with no tampering involved.
 *
 * This test stands up a fake server that holds 1000+ rows with a tied
 * timestamp at the boundary and asserts commitMerkleRoot collects the
 * FULL set (i.e. the root it signs equals the root over every row).
 */
import {computeMerkleRoot} from '../backup/backupMerkle';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

jest.mock('react-native-keychain', () => ({
  __esModule: true,
  SECURITY_LEVEL: {SECURE_HARDWARE: 'sh', SECURE_SOFTWARE: 'ss'},
  ACCESSIBLE: {
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'a',
    WHEN_UNLOCKED_THIS_DEVICE_ONLY:     'b',
  },
  setGenericPassword: async () => true,
  getGenericPassword: async () => false,
  resetGenericPassword: async () => true,
}));

// The dataset + fake server live INSIDE the mock factory because jest
// hoists jest.mock() above the imports — a factory that closed over a
// module-scope variable would throw a "out-of-scope" reference error.
// The factory exposes the canonical row set as `__allRows` so the test
// can recompute the expected root over the full dataset.
jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, msg: string) { super(msg); this.name = 'BackupError'; this.kind = kind; }
  }

  // 1500 rows. Index 999 reuses index 1000's timestamp so a duplicate
  // msg_created_at straddles the first 1000-row page boundary — the exact
  // condition that defeated the old timestamp-only commit cursor.
  const TOTAL = 1500;
  const allRows = Array.from({length: TOTAL}, (_, i) => {
    const id = `m${String(i).padStart(5, '0')}`;   // lexical == numeric order
    const tsIndex = i === 999 ? 1000 : i;
    const ts = new Date(1_700_000_000_000 + tsIndex * 1000).toISOString();
    return {message_id: id, msg_created_at: ts, ciphertext: `ct-${id}`};
  });

  // Server-accurate paging: ORDER BY (msg_created_at, message_id), advance
  // strictly past the tuple cursor when sinceId is present, else past the
  // timestamp only. Mirrors apps/messenger-service backup.service.getMessages.
  function fakeGetMessages(since?: string, limit?: number, sinceId?: string) {
    limit = limit ?? 1000;
    const sorted = [...allRows].sort((a, b) =>
      a.msg_created_at !== b.msg_created_at
        ? (a.msg_created_at < b.msg_created_at ? -1 : 1)
        : (a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0),
    );
    let filtered = sorted;
    if (since) {
      filtered = sorted.filter(r =>
        sinceId
          ? (r.msg_created_at > since || (r.msg_created_at === since && r.message_id > sinceId))
          : r.msg_created_at > since,
      );
    }
    return {messages: filtered.slice(0, limit)};
  }

  return {
    __esModule: true,
    BackupError,
    __allRows: allRows,
    backupClient: {
      getMessages: jest.fn(async (since, limit, sinceId) =>
        fakeGetMessages(since, limit, sinceId)),
      putMerkleCommit: jest.fn(async () => ({ok: true})),
      getSessions: async () => null,
      getMerkleCommit: async () => null,
    },
  };
});

// Stub the keychain HMAC accessor used by the seq counter.
jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  getOrCreateMerkleSeqHmacKey: async () => Buffer.alloc(32, 7).toString('base64'),
}));

// Curve sign is irrelevant to which ROWS get collected; stub to a fixed
// 64-byte signature so commitMerkleRoot completes without a real key.
jest.mock('@privacyresearch/curve25519-typescript', () => ({
  __esModule: true,
  AsyncCurve25519Wrapper: class {
    async sign(): Promise<ArrayBuffer> { return new Uint8Array(64).buffer; }
    async verify(): Promise<boolean> { return false; }
  },
}));

import {commitMerkleRoot} from '../backup/merkleCommit';
import * as backupClientModule from '../backup/backupClient';
import {toB64} from '../backup/backupCrypto';

const {backupClient} = backupClientModule;
const allRows = (backupClientModule as unknown as {__allRows: Array<{
  message_id: string; msg_created_at: string; ciphertext: string;
}>}).__allRows;
const TOTAL = allRows.length;

describe('Regression — commitMerkleRoot tuple-cursor paging', () => {
  it('collects EVERY row (including a duplicate-timestamp page-boundary tie)', async () => {
    const result = await commitMerkleRoot({
      identityPrivKey: new Uint8Array(32).buffer,
      userId:          'user-1',
    });

    expect(result).not.toBeNull();
    // All rows must be committed — the dropped-duplicate bug made this
    // TOTAL-1 (or fewer) and signed a root over the smaller set.
    expect(result!.rowCount).toBe(TOTAL);

    // The signed root must equal the root over the FULL dataset, which is
    // exactly what the restore side recomputes from its tuple-cursor walk.
    const expectedRoot = toB64(computeMerkleRoot(allRows));
    expect(result!.rootB64).toBe(expectedRoot);
  });

  it('passes the tuple cursor (sinceId) on every page after the first', () => {
    const calls = (backupClient.getMessages as jest.Mock).mock.calls;
    // First call has no cursor; every subsequent paging call must carry a
    // sinceId — proving the commit side no longer uses timestamp-only paging.
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0][2]).toBeUndefined();
    for (let i = 1; i < calls.length; i++) {
      expect(typeof calls[i][2]).toBe('string');
    }
  });
});
