/**
 * B-81 — repair for the equal-count `root_mismatch` restore dead-end.
 *
 * Drift mechanism: re-mirrors re-encrypt rows with a fresh AES-GCM IV, and
 * the signed Merkle commit trails the upload by a debounced server walk — an
 * app kill in that window leaves the server rows ahead of the signed root
 * (same COUNT when the uploads were updates), which the restore verifier
 * deliberately hard-fails forever. These tests pin the repair primitives —
 * including the adversarial-review findings:
 *
 *   • the repair signs via commitMerkleRootNow DIRECTLY (the ambient
 *     after-flush hook is NOT installed on the restore paths — a hook-based
 *     commit would silently no-op and return a false success);
 *   • an outbox that fails to fully drain ABORTS the repair (no torn root);
 *   • an empty local store refuses BEFORE any side effect (dedup intact);
 *   • clearMirrorDedupForOwner + fireMerkleHookNowIfPending behave.
 */
import type {LocalMessage} from '../store/types';

jest.mock('react-native', () => ({
  __esModule: true,
  AppState: {addEventListener: jest.fn(() => ({remove: () => undefined}))},
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

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

// The repair signs directly (no ambient hook). Give it a runtime store that
// is NOT a SqlCipherProtocolStore (so row collection walks the in-memory
// messenger store) but DOES expose the identity key pair the signer needs.
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
  setMirrorKey, setMirrorOwner, mirrorMessage, disposeMirror,
  setMerkleAfterFlushHook, drainMirrorOutbox,
  clearMirrorDedupForOwner, fireMerkleHookNowIfPending, mirrorOutboxSize,
} from '../backup/messageMirror';
import {repairBackupCommit} from '../backup/mirrorBootstrap';
import {useMessengerStore} from '../store/messengerStore';

const OWNER = 'owner-1';

function msg(id: string): LocalMessage {
  return {
    id,
    conversation_id: 'conv-1',
    sender_id: OWNER,
    content: `hello ${id}`,
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

describe('B-81 — backup repair commit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    disposeMirror();
    useMessengerStore.setState({messages: {}, conversations: {}, conversationOrder: []} as never);
  });
  afterEach(() => {
    setMerkleAfterFlushHook(null);
    disposeMirror();
  });

  it('clearMirrorDedupForOwner lets an already-mirrored row re-enqueue (fresh upload)', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    mirrorMessage(OWNER, msg('m1'));
    await drainMirrorOutbox();
    expect(mockPutMessages).toHaveBeenCalledTimes(1);

    // Same row again — dedup swallows it.
    mirrorMessage(OWNER, msg('m1'));
    await drainMirrorOutbox();
    expect(mockPutMessages).toHaveBeenCalledTimes(1);

    // After the dedup clear, the same row uploads again (repair semantics).
    clearMirrorDedupForOwner(OWNER);
    mirrorMessage(OWNER, msg('m1'));
    await drainMirrorOutbox();
    expect(mockPutMessages).toHaveBeenCalledTimes(2);
  });

  it('repairBackupCommit re-uploads the full local store and signs DIRECTLY (no ambient hook installed)', async () => {
    // Production restore path: startMirrorBootstrap never ran, so there is
    // NO after-flush hook. The review-confirmed critical: a hook-based
    // commit silently no-ops here and returns a false success.
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    useMessengerStore.setState({
      messages: {c1: [msg('m1'), msg('m2')]},
      conversations: {},
    } as never);
    // Pre-seed dedup so the test proves the repair CLEARS it.
    mirrorMessage(OWNER, msg('m1'));
    mirrorMessage(OWNER, msg('m2'));
    await drainMirrorOutbox();
    expect(mockPutMessages).toHaveBeenCalledTimes(1);
    mockCommitMerkleRoot.mockClear();

    const repaired = await repairBackupCommit(OWNER);
    expect(repaired).toBe(true);
    // Dedup cleared → both rows re-uploaded despite being seen before…
    expect(mockPutMessages).toHaveBeenCalledTimes(2);
    expect((mockPutMessages.mock.calls[1][0] as unknown[]).length).toBe(2);
    // …and the fresh root was signed directly, with the identity priv key.
    expect(mockCommitMerkleRoot).toHaveBeenCalledTimes(1);
    expect(mockCommitMerkleRoot).toHaveBeenCalledWith(
      expect.objectContaining({userId: OWNER, identityPrivKey: expect.anything()}),
    );
    expect(mirrorOutboxSize()).toBe(0);
  });

  it('refuses an empty local store BEFORE any side effect (fresh device — dedup + queues untouched)', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    // Seed dedup with a row, then empty the store: a refused repair must
    // not clear the dedup or enqueue conversations.
    useMessengerStore.setState({messages: {c1: [msg('m1')]}, conversations: {}} as never);
    mirrorMessage(OWNER, msg('m1'));
    await drainMirrorOutbox();
    expect(mockPutMessages).toHaveBeenCalledTimes(1);
    useMessengerStore.setState({messages: {}, conversations: {}} as never);
    mockPutConversations.mockClear();

    const repaired = await repairBackupCommit(OWNER);
    expect(repaired).toBe(false);
    expect(mockCommitMerkleRoot).not.toHaveBeenCalled();
    expect(mockPutConversations).not.toHaveBeenCalled();   // no conv enqueue side effect
    // Dedup untouched: the previously-seen row is still swallowed.
    mirrorMessage(OWNER, msg('m1'));
    await drainMirrorOutbox();
    expect(mockPutMessages).toHaveBeenCalledTimes(1);
  });

  it('refuses when the mirror is locked', async () => {
    useMessengerStore.setState({messages: {c1: [msg('m1')]}, conversations: {}} as never);
    const repaired = await repairBackupCommit(OWNER);
    expect(repaired).toBe(false);
    expect(mockPutMessages).not.toHaveBeenCalled();
    expect(mockCommitMerkleRoot).not.toHaveBeenCalled();
  });

  it('fireMerkleHookNowIfPending is a no-op with no pending commit, fires once with one', async () => {
    const hook = jest.fn(async () => undefined);
    setMerkleAfterFlushHook(hook);
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());

    await fireMerkleHookNowIfPending();          // nothing scheduled
    expect(hook).not.toHaveBeenCalled();

    mirrorMessage(OWNER, msg('m9'));
    await drainMirrorOutbox();                   // flush schedules the commit
    await fireMerkleHookNowIfPending();
    expect(hook).toHaveBeenCalledTimes(1);
    await tick(50);                              // debounce cleared — no double fire
    expect(hook).toHaveBeenCalledTimes(1);
  });

  // LAST deliberately: the failed flush arms an anonymous jittered retry
  // timer that can fire into a later test; keeping this at the end (and
  // restoring the putMessages implementation) isolates it.
  it('ABORTS (no commit) when the outbox cannot fully drain — never signs a torn set', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    useMessengerStore.setState({messages: {c1: [msg('m1')]}, conversations: {}} as never);
    // Every upload fails retryably → flush requeues → drain bails on
    // no-progress with rows still queued.
    mockPutMessages.mockImplementation(() => Promise.reject(new Error('network down')));
    try {
      const repaired = await repairBackupCommit(OWNER);
      expect(repaired).toBe(false);
      expect(mirrorOutboxSize()).toBeGreaterThan(0);   // rows still pending
      expect(mockCommitMerkleRoot).not.toHaveBeenCalled();
    } finally {
      mockPutMessages.mockImplementation(async (rows: unknown[]) => ({written: (rows as unknown[]).length}));
    }
  });
});
