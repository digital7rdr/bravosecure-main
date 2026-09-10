/**
 * B-648 — every idle boot re-encrypted + re-uploaded EVERY conversation row.
 *
 * Root cause: `mirrorConversation` had no dedup against the persistent
 * ledger at all — `convQueue.set()` unconditionally — and `mirror_flushed`
 * held message versions only. The boot catch-up sweep (`backupNow`) walks
 * every conversation, so each launch AES-GCM re-encrypted (fresh IV) and
 * re-POSTed the full conversation set: an I1 violation ("idle boots upload
 * NOTHING"), measured on-device 2026-08-24 as `[backup.drain] rows=42` on
 * two consecutive idle cold starts. Linear in conversation count — the
 * boot-lag class on heavy accounts.
 *
 * The fix mirrors the B-94/B-632 message pattern: conversation versions
 * live in the SAME `mirror_flushed` table under a `conv:` id namespace,
 * hydrate into an in-memory map at boot, and dedup at enqueue. These tests
 * pin:
 *
 *   1. A ledger-hydrated sweep skips an unchanged conversation (I1) and
 *      still ships a changed one.
 *   2. A successful conv flush records the `conv:`-namespaced version and
 *      does NOT raise the merkle-pending flag (conv rows are not Merkle
 *      leaves — an idle boot must stay commit-free).
 *   3. Same-session repeats dedup; a real change (mute) ships.
 *   4. Tombstones ship once and a re-add lifts (B-594 semantics kept).
 *   5. A missing ledger degrades to re-upload, never to skipping (I8).
 *   6. A non-retryable flush failure clears the dedup so the row can
 *      ship again later (H-7 parity with messages).
 *   7. The version hash covers the group state (epoch bump re-ships) —
 *      hashed over PLAINTEXT serialization, not the nondeterministic
 *      ciphertext.
 */
import type {LocalConversation} from '../store/types';
import type {GroupState} from '@bravo/messenger-core';
import type {DbHandle} from '../crypto/db';

jest.mock('react-native', () => ({
  __esModule: true,
  AppState: {addEventListener: jest.fn(() => ({remove: () => undefined}))},
}));

const mockAsyncStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockAsyncStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockAsyncStore.set(k, v); },
    removeItem: async (k: string) => { mockAsyncStore.delete(k); },
    clear:      async () => { mockAsyncStore.clear(); },
  },
}));

const mockPutMessages = jest.fn(async (rows: unknown[]) => ({written: (rows as unknown[]).length}));
const mockPutConversations = jest.fn(async (_rows: unknown[]) => ({written: 0}));
jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, message: string) { super(message); this.name = 'BackupError'; this.kind = kind; }
  }
  return {
    __esModule: true,
    BackupError,
    backupClient: {
      putMessages: (rows: unknown[]) => mockPutMessages(rows),
      putConversations: (rows: unknown[]) => mockPutConversations(rows),
    },
  };
});

const mockGetIdentityKeyPair = jest.fn(async () => ({
  privKey: new Uint8Array(32).fill(7).buffer,
  pubKey:  new Uint8Array(33).fill(5).buffer,
}));
jest.mock('../runtime/runtime', () => ({
  __esModule: true,
  getOwnCryptoStore: () => ({getIdentityKeyPair: mockGetIdentityKeyPair}),
}));

const mockCommitMerkleRoot = jest.fn(async (_p: unknown) => ({rootB64: 'r', seq: 1, rowCount: 1}));
jest.mock('../backup/merkleCommit', () => ({
  __esModule: true,
  commitMerkleRoot: (p: unknown) => mockCommitMerkleRoot(p),
}));

jest.mock('@store/authStore', () => ({
  __esModule: true,
  useAuthStore: {getState: () => ({user: {id: 'owner-1'}})},
}));

import {
  setMirrorKey, setMirrorOwner, mirrorConversation, disposeMirror,
  drainMirrorOutbox, seedMirrorDedup, computeConvMirrorVersion,
} from '../backup/messageMirror';
import {
  _setLedgerDbForTests, loadFlushedVersions, readMerkleCommitPending,
} from '../backup/mirrorLedger';
import {BackupError} from '../backup/backupClient';

const OWNER = 'owner-1';

function makeFakeLedgerDb(): {db: DbHandle; rows: Map<string, string>} {
  const rows = new Map<string, string>();
  const db = {
    execute: async (sql: string, params: Array<string | number> = []) => {
      if (/^\s*SELECT/i.test(sql)) {
        const owner = String(params[0]);
        const out: Array<{message_id: string; version: string}> = [];
        for (const [k, version] of rows) {
          const sep = k.indexOf('|');
          if (k.slice(0, sep) === owner) {out.push({message_id: k.slice(sep + 1), version});}
        }
        return {rows: out};
      }
      if (/^\s*INSERT/i.test(sql)) {
        for (let i = 0; i + 3 < params.length; i += 4) {
          rows.set(`${params[i]}|${params[i + 1]}`, String(params[i + 2]));
        }
        return {rows: []};
      }
      if (/^\s*DELETE/i.test(sql)) {
        const owner = String(params[0]);
        for (const k of [...rows.keys()]) {
          if (k.startsWith(`${owner}|`)) {rows.delete(k);}
        }
        return {rows: []};
      }
      return {rows: []};
    },
  } as unknown as DbHandle;
  return {db, rows};
}

function conv(id: string, over: Partial<LocalConversation> = {}): LocalConversation {
  return {
    id,
    type: 'direct',
    name: `Chat ${id}`,
    peer: {userId: 'peer-1', deviceId: 1},
    is_muted: false,
    is_pinned: false,
    unread_count: 0,
    is_custom_name: false,
    ...over,
  } as unknown as LocalConversation;
}

function groupConv(id: string, over: Partial<LocalConversation> = {}): LocalConversation {
  return conv(id, {type: 'group', participants: ['peer-1', 'peer-2'], peer: undefined, ...over} as Partial<LocalConversation>);
}

function makeGroupState(id: string, epoch = 1): GroupState {
  return {
    groupId: id,
    owner: OWNER,
    members: ['peer-1', 'peer-2'],
    masterKeyB64: 'a2V5LWJ5dGVz',
    epoch,
    name: `Group ${id}`,
  } as unknown as GroupState;
}

async function makeKey(): Promise<CryptoKey> {
  return (globalThis.crypto as Crypto).subtle.importKey(
    'raw', new Uint8Array(32).fill(1), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt'],
  );
}

describe('B-648 — conversation rows join the mirror_flushed ledger (idle boots upload nothing)', () => {
  let fake: ReturnType<typeof makeFakeLedgerDb>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAsyncStore.clear();
    disposeMirror();
    fake = makeFakeLedgerDb();
    _setLedgerDbForTests(fake.db);
  });
  afterEach(() => {
    disposeMirror();
    _setLedgerDbForTests(undefined);
  });

  it('ledger-hydrated dedup skips an unchanged conversation and still ships a changed one (I1)', async () => {
    const c1 = conv('c1');
    fake.rows.set(`${OWNER}|conv:c1`, computeConvMirrorVersion(c1));

    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    seedMirrorDedup(OWNER, await loadFlushedVersions(OWNER));

    // Unchanged — the server already holds this exact snapshot.
    mirrorConversation(OWNER, c1);
    await drainMirrorOutbox();
    expect(mockPutConversations).not.toHaveBeenCalled();

    // Renamed — must ship, and the ledger must adopt the new version.
    const c1v2 = conv('c1', {name: 'Renamed'});
    mirrorConversation(OWNER, c1v2);
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(1);
    expect(fake.rows.get(`${OWNER}|conv:c1`)).toBe(computeConvMirrorVersion(c1v2));
  });

  it('flush success records the conv: version and does NOT raise the merkle-pending flag', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());

    mirrorConversation(OWNER, conv('c1'));
    await drainMirrorOutbox();

    expect(mockPutConversations).toHaveBeenCalledTimes(1);
    expect(fake.rows.get(`${OWNER}|conv:c1`)).toBe(computeConvMirrorVersion(conv('c1')));
    // Conv rows are not Merkle leaves — a conv-only flush owes no commit,
    // so an idle boot that only healed a conv must stay commit-free.
    expect(await readMerkleCommitPending(OWNER)).toBe(false);
  });

  it('same-session identical snapshots dedup; a real change ships', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());

    mirrorConversation(OWNER, conv('c1'));
    await drainMirrorOutbox();
    mirrorConversation(OWNER, conv('c1'));
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(1);

    mirrorConversation(OWNER, conv('c1', {is_muted: true}));
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(2);
  });

  it('a tombstone ships once after a live flush, and a re-add lifts it (B-594 kept)', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());

    mirrorConversation(OWNER, conv('c1'));
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(1);

    mirrorConversation(OWNER, conv('c1'), undefined, {deleted: true});
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(2);
    const tombRows = mockPutConversations.mock.calls[1][0] as Array<{deleted: boolean}>;
    expect(tombRows[0].deleted).toBe(true);

    // Repeat tombstone — same version, must dedup.
    mirrorConversation(OWNER, conv('c1'), undefined, {deleted: true});
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(2);

    // Live re-add — deleted:false is a different version, must ship (the lift).
    mirrorConversation(OWNER, conv('c1'));
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(3);
    const liftRows = mockPutConversations.mock.calls[2][0] as Array<{deleted: boolean}>;
    expect(liftRows[0].deleted).toBe(false);
  });

  it('a missing ledger degrades to re-upload, never to skipping (I8)', async () => {
    _setLedgerDbForTests(null);
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    seedMirrorDedup(OWNER, await loadFlushedVersions(OWNER)); // empty map

    mirrorConversation(OWNER, conv('c1'));
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(1);
  });

  it('a non-retryable flush failure clears the dedup so the row ships later (H-7 parity)', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());

    mockPutConversations.mockRejectedValueOnce(new BackupError('invalid_request', 'bad'));
    mirrorConversation(OWNER, conv('c1'));
    await drainMirrorOutbox();
    expect(fake.rows.has(`${OWNER}|conv:c1`)).toBe(false);

    // The exact same snapshot must be enqueueable again — the drop must
    // not leave a poisoned dedup entry that skips it forever.
    mirrorConversation(OWNER, conv('c1'));
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(2);
    expect(fake.rows.get(`${OWNER}|conv:c1`)).toBe(computeConvMirrorVersion(conv('c1')));
  });

  it('the version hash covers group state — an epoch bump re-ships (plaintext-hashed)', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());

    const g1 = groupConv('g1');
    mirrorConversation(OWNER, g1, makeGroupState('g1', 1));
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(1);

    // Same conv object, same group state — nondeterministic GCM ciphertext
    // must not defeat the dedup (the hash is over plaintext serialization).
    mirrorConversation(OWNER, g1, makeGroupState('g1', 1));
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(1);

    // Rekey — epoch changed, must ship.
    mirrorConversation(OWNER, g1, makeGroupState('g1', 2));
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(2);
  });
});
