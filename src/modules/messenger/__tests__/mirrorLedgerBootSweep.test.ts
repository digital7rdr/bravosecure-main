/**
 * B-94 — the recurring `root_mismatch` drift factory.
 *
 * Root cause: the mirror dedup was in-memory only, so EVERY boot's
 * catch-up sweep re-enqueued the entire local store; each re-mirror
 * re-encrypts with a fresh AES-GCM IV (new server bytes, same count),
 * and the signed Merkle commit only trails the uploads. Any kill in
 * that window left the server ahead of the signed root at equal count —
 * the exact state the restore verifier hard-fails (P2-B-1) and a
 * fresh-install restore can never repair (B-81 refuses without local
 * history). These tests pin the persistent-ledger fix:
 *
 *   1. A ledger-hydrated sweep skips rows whose current version already
 *      reached the server (idle boot uploads NOTHING).
 *   2. A successful flush records versions to the ledger AND raises the
 *      pending-commit flag; tombstones record '__deleted__'.
 *   3. A boot sweep with the pending flag set fires a commit even when
 *      it uploaded nothing (heals a prior session's kill-window).
 *   4. The flag-clear is flush-epoch-guarded (an interleaved flush must
 *      not lose its pending commit).
 *   5. repairBackupCommit purges the ledger so nothing short-circuits
 *      its full re-upload.
 */
import type {LocalMessage} from '../store/types';
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
const mockPutConversations = jest.fn(async () => ({written: 0}));
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
      putConversations: () => mockPutConversations(),
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
  setMirrorKey, setMirrorOwner, mirrorMessage, mirrorRemoval, disposeMirror,
  setMerkleAfterFlushHook, drainMirrorOutbox, seedMirrorDedup,
  computeMirrorVersion,
} from '../backup/messageMirror';
import {
  _setLedgerDbForTests, loadFlushedVersions, recordFlushedVersions,
  clearFlushedForOwner, bumpFlushEpoch, getFlushEpoch,
  setMerkleCommitPending, readMerkleCommitPending,
  clearMerkleCommitPendingIfNoFlushSince,
} from '../backup/mirrorLedger';
import {startMirrorBootstrap, stopMirrorBootstrap, repairBackupCommit} from '../backup/mirrorBootstrap';
import {useMessengerStore} from '../store/messengerStore';

const OWNER = 'owner-1';
const PENDING_KEY = `bravo:backup:merkle-pending:${OWNER}`;

/**
 * Minimal fake of the op-sqlite DbHandle for the three ledger statements
 * (SELECT / chunked INSERT OR REPLACE / DELETE). Rows keyed `owner|id`.
 */
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

function msg(id: string, content = `hello ${id}`): LocalMessage {
  return {
    id,
    conversation_id: 'conv-1',
    sender_id: OWNER,
    content,
    type: 'text',
    status: 'sent',
    created_at: new Date(1_700_000_000_000).toISOString(),
  } as unknown as LocalMessage;
}

async function makeKey(): Promise<CryptoKey> {
  return (globalThis.crypto as Crypto).subtle.importKey(
    'raw', new Uint8Array(32).fill(1), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt'],
  );
}

const tick = (ms = 25): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Poll until the fire-and-forget boot sweep settles. */
async function waitFor(cond: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {await tick(20);}
}

describe('B-94 — persistent mirror ledger kills the boot re-upload drift factory', () => {
  let fake: ReturnType<typeof makeFakeLedgerDb>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAsyncStore.clear();
    stopMirrorBootstrap();
    disposeMirror();
    fake = makeFakeLedgerDb();
    _setLedgerDbForTests(fake.db);
    useMessengerStore.setState({messages: {}, conversations: {}, conversationOrder: []} as never);
  });
  afterEach(() => {
    stopMirrorBootstrap();
    setMerkleAfterFlushHook(null);
    disposeMirror();
    _setLedgerDbForTests(undefined);
  });

  it('ledger-hydrated dedup skips unchanged rows and still ships changed ones', async () => {
    const m1 = msg('m1');
    fake.rows.set(`${OWNER}|m1`, computeMirrorVersion(m1));

    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    seedMirrorDedup(OWNER, await loadFlushedVersions(OWNER));

    // Unchanged row — the server already holds these exact bytes' plaintext.
    mirrorMessage(OWNER, m1);
    await drainMirrorOutbox();
    expect(mockPutMessages).not.toHaveBeenCalled();

    // Changed row — must ship, and the ledger must adopt the new version.
    const m1v2 = msg('m1', 'edited content');
    mirrorMessage(OWNER, m1v2);
    await drainMirrorOutbox();
    expect(mockPutMessages).toHaveBeenCalledTimes(1);
    expect(fake.rows.get(`${OWNER}|m1`)).toBe(computeMirrorVersion(m1v2));
  });

  it('flush success records ledger versions, raises the pending flag, and tombstones as __deleted__', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    expect(await readMerkleCommitPending(OWNER)).toBe(false);

    mirrorMessage(OWNER, msg('m1'));
    mirrorRemoval(OWNER, {id: 'm2', conversation_id: 'conv-1', created_at: new Date(1_700_000_000_000).toISOString()});
    await drainMirrorOutbox();

    expect(mockPutMessages).toHaveBeenCalledTimes(1);
    expect(fake.rows.get(`${OWNER}|m1`)).toBe(computeMirrorVersion(msg('m1')));
    expect(fake.rows.get(`${OWNER}|m2`)).toBe('__deleted__');
    expect(await readMerkleCommitPending(OWNER)).toBe(true);
  });

  it('boot sweep with the pending flag fires a commit even when it uploads nothing', async () => {
    // Prior session: rows flushed (ledger has them), killed before the
    // commit → flag still set. This boot must sign WITHOUT re-uploading.
    const m1 = msg('m1');
    fake.rows.set(`${OWNER}|m1`, computeMirrorVersion(m1));
    mockAsyncStore.set(PENDING_KEY, '1');
    useMessengerStore.setState({messages: {c1: [m1]}, conversations: {}} as never);

    startMirrorBootstrap();                    // wires sweep + after-flush hook
    setMirrorKey(await makeKey());             // disabled→enabled fires the sweep
    await waitFor(() => mockCommitMerkleRoot.mock.calls.length > 0);

    expect(mockPutMessages).not.toHaveBeenCalled();          // idle — no re-upload
    expect(mockCommitMerkleRoot).toHaveBeenCalledTimes(1);   // …but the owed commit ships
  });

  it('boot sweep with NO pending flag and nothing new stays commit-free (idle boots are silent)', async () => {
    const m1 = msg('m1');
    fake.rows.set(`${OWNER}|m1`, computeMirrorVersion(m1));
    useMessengerStore.setState({messages: {c1: [m1]}, conversations: {}} as never);

    startMirrorBootstrap();
    setMirrorKey(await makeKey());
    await tick(150);                           // let the sweep settle

    expect(mockPutMessages).not.toHaveBeenCalled();
    expect(mockCommitMerkleRoot).not.toHaveBeenCalled();
  });

  it('pending-flag clear is flush-epoch-guarded', async () => {
    await setMerkleCommitPending(OWNER);

    // A flush landed while the commit walk was in flight → flag survives.
    const epochAtCommitStart = getFlushEpoch();
    bumpFlushEpoch();
    await clearMerkleCommitPendingIfNoFlushSince(OWNER, epochAtCommitStart);
    expect(await readMerkleCommitPending(OWNER)).toBe(true);

    // No interleaved flush → flag retires.
    await clearMerkleCommitPendingIfNoFlushSince(OWNER, getFlushEpoch());
    expect(await readMerkleCommitPending(OWNER)).toBe(false);
  });

  it('repairBackupCommit purges the ledger so its full re-upload cannot be short-circuited', async () => {
    const m1 = msg('m1');
    fake.rows.set(`${OWNER}|m1`, computeMirrorVersion(m1));
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    seedMirrorDedup(OWNER, await loadFlushedVersions(OWNER));
    useMessengerStore.setState({messages: {c1: [m1]}, conversations: {}} as never);

    const repaired = await repairBackupCommit(OWNER);
    expect(repaired).toBe(true);
    // The ledgered-but-untrusted row was re-uploaded (server bytes rewritten
    // with local truth), then re-recorded by the flush.
    expect(mockPutMessages).toHaveBeenCalledTimes(1);
    expect(mockCommitMerkleRoot).toHaveBeenCalledTimes(1);
    expect(fake.rows.get(`${OWNER}|m1`)).toBe(computeMirrorVersion(m1));
  });

  it('recordFlushedVersions round-trips through loadFlushedVersions (restore seeding path)', async () => {
    const entries = [
      {messageId: 'a', version: 'v-a'},
      {messageId: 'b', version: 'v-b'},
    ];
    expect(await recordFlushedVersions(OWNER, entries)).toBe(true);
    const loaded = await loadFlushedVersions(OWNER);
    expect(loaded.get('a')).toBe('v-a');
    expect(loaded.get('b')).toBe('v-b');

    await clearFlushedForOwner(OWNER);
    expect((await loadFlushedVersions(OWNER)).size).toBe(0);
  });

  it('degrades to pre-B-94 behaviour when the ledger DB is unavailable', async () => {
    _setLedgerDbForTests(null);
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    expect((await loadFlushedVersions(OWNER)).size).toBe(0);

    // Rows still flush fine — the ledger is strictly best-effort.
    mirrorMessage(OWNER, msg('m1'));
    await drainMirrorOutbox();
    expect(mockPutMessages).toHaveBeenCalledTimes(1);
    // The pending flag is AsyncStorage-backed and still raised.
    expect(await readMerkleCommitPending(OWNER)).toBe(true);
  });
});
