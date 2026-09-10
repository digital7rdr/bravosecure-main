/**
 * restoreAllMessages — deferred (Merkle) path: verified-only writes,
 * bounded buffering with cursor resume, epoch-guarded group-state apply.
 *
 * Covers the 2026-07-10 backup findings:
 *   • P2-B-2 — deferred rows are flushed ONLY after verification ran and
 *     passed; a hard integrity failure flushes nothing.
 *   • P2-B-6 — the defer path is memory-bounded: past the buffer cap it
 *     walks leaves-only (full-set verification still runs), flushes the
 *     verified window with a persisted cursor, and RESUMES on the next
 *     run instead of re-walking from row 0.
 *   • P2-B-1 (restore side) — equal-count root_mismatch is a hard fail
 *     (no self-heal re-sign over a substituted set); an ERRORING commit
 *     endpoint hard-fails as commit_fetch_failed instead of riding the
 *     no_commit soft-pass; a genuinely-absent commit still soft-passes.
 *   • P2-B-5 — backup group_state is staged until verification passes
 *     and never stomps a locally-newer epoch.
 *   • P2-B-4 (integration) — rows written by the store's 'self' sentinel
 *     restore with status floored to 'sent'.
 *   • P1-B-1(a) at the restore level — the H-2 incomplete marker clears
 *     only on a fully-complete run.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});

jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  getOrCreateMerkleSeqHmacKey: async () => Buffer.alloc(32, 7).toString('base64'),
}));

// Curve: sign → fixed 64-byte sig; verify → false means "NOT invalid".
jest.mock('@privacyresearch/curve25519-typescript', () => ({
  __esModule: true,
  AsyncCurve25519Wrapper: class {
    async sign(): Promise<ArrayBuffer> { return new Uint8Array(64).buffer; }
    async verify(): Promise<boolean> { return false; }
  },
}));

// Stateful fake backup server.
jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, msg: string) { super(msg); this.name = 'BackupError'; this.kind = kind; }
  }
  const state = {
    conversations: [] as unknown[],
    rows: [] as Array<{message_id: string; msg_created_at: string}>,
    commit: null as unknown,
    commitFetchThrows: false,
  };
  return {
    __esModule: true,
    BackupError,
    __serverState: state,
    backupClient: {
      getConversations: jest.fn(async () => ({conversations: state.conversations})),
      getMessages: jest.fn(async (since?: string, _limit?: number, sinceId?: string) => {
        const rows = state.rows.filter(r => {
          if (!since) {return true;}
          if (r.msg_created_at !== since) {return r.msg_created_at > since;}
          return sinceId ? r.message_id > sinceId : false;
        });
        return {messages: rows};
      }),
      getMerkleCommit: jest.fn(async () => {
        if (state.commitFetchThrows) {throw new Error('HTTP 500');}
        return state.commit;
      }),
      putMerkleCommit: jest.fn(async (c: unknown) => { state.commit = c; return {ok: true}; }),
      getSessions: jest.fn(async () => null),
    },
  };
});

// SQLCipher store stand-ins — instanceof + upsert capture.
jest.mock('../crypto/sqlCipherStore', () => ({
  __esModule: true,
  SqlCipherProtocolStore: class SqlCipherProtocolStore {
    getDb(): unknown { return {}; }
  },
}));
jest.mock('../store/sqlMessageStore', () => {
  const upserts: Array<Array<{id: string; status: string}>> = [];
  return {
    __esModule: true,
    __upserts: upserts,
    SqlMessageStore: class SqlMessageStore {
      constructor(_db: unknown) { /* mock */ }
      async upsertBatch(batch: Array<{id: string; status: string}>): Promise<void> {
        upserts.push(batch);
      }
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {restoreAllMessages} from '../backup/restoreMessages';
import {commitMerkleRoot} from '../backup/merkleCommit';
import {generateMasterKey, importMasterKey, aesGcmEncrypt, toB64} from '../backup/backupCrypto';
import {readRestoreCursor, isRestoreIncomplete} from '../backup/restoreResume';
import {useMessengerStore} from '../store/messengerStore';
import type {MerkleRow} from '../backup/backupMerkle';

const OWNER = 'owner-uuid-1';
const PRIV = new Uint8Array(32).fill(9).buffer;
const PUB  = new Uint8Array(32).fill(3).buffer;

type ServerState = {
  conversations: unknown[];
  rows: Array<Record<string, unknown>>;
  commit: unknown;
  commitFetchThrows: boolean;
};
const serverState = (require('../backup/backupClient') as {__serverState: ServerState}).__serverState;
const upserts = (require('../store/sqlMessageStore') as {__upserts: Array<Array<{id: string; status: string}>>}).__upserts;
const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
  {SqlCipherProtocolStore: new () => {getDb: () => unknown}};

async function makeRow(masterKey: CryptoKey, i: number, convId: string): Promise<Record<string, unknown>> {
  const id = `m-${String(i).padStart(4, '0')}`;
  const ts = new Date(1_700_000_000_000 + i * 1000).toISOString();
  const payload = {
    id,
    conversation_id: convId,
    // P2-B-4 — the store's outbound sentinel, exactly as the mirror
    // ships it. Restored status must floor to 'sent'.
    sender_id: 'self',
    recipient_id: 'peer-1',
    type: 'text',
    content: `msg ${i}`,
    status: 'read',
    created_at: ts,
  };
  const ct = await aesGcmEncrypt(masterKey, new TextEncoder().encode(JSON.stringify(payload)));
  return {
    message_id: id,
    conversation_id: convId,
    sender_id: 'self',
    recipient_id: 'peer-1',
    msg_type: 'text',
    ciphertext: toB64(ct),
    ciphertext_type: 1,
    envelope_meta: {},
    msg_created_at: ts,
  };
}

async function seedServer(masterKey: CryptoKey, rowCount: number, extras: {
  conversations?: unknown[];
} = {}): Promise<void> {
  serverState.conversations = extras.conversations ?? [{
    conversation_id: 'conv-1',
    kind: 'direct',
    name: 'Peer One',
    members: [{userId: 'peer-1'}, {userId: OWNER}],
    last_message_at: null,
  }];
  serverState.rows = [];
  for (let i = 0; i < rowCount; i++) {
    serverState.rows.push(await makeRow(masterKey, i, 'conv-1'));
  }
  serverState.commit = null;
  serverState.commitFetchThrows = false;
  await commitMerkleRoot({
    identityPrivKey: PRIV,
    userId: OWNER,
    rows: serverState.rows.map(r => ({
      message_id:     r.message_id as string,
      msg_created_at: r.msg_created_at as string,
      ciphertext:     r.ciphertext as string,
    }) as MerkleRow),
  });
}

describe('restoreAllMessages — deferred path (P2-B-1/2/4/5/6)', () => {
  let masterKey: CryptoKey;

  beforeEach(async () => {
    await (AsyncStorage as unknown as {clear: () => Promise<void>}).clear();
    upserts.length = 0;
    useMessengerStore.setState({conversations: {}, conversationOrder: [], groups: {}, messages: {}});
    const {raw} = await generateMasterKey();
    masterKey = await importMasterKey(raw);
  });

  it('P2-B-6 — buffer cap: verified-window flush + cursor + marker survive; runs RESUME to completion', async () => {
    await seedServer(masterKey, 5);
    const opts = {
      cryptoStore: new SqlCipherProtocolStore() as never,
      identityPubKey: PUB as ArrayBuffer,
      identityPrivKey: PRIV as ArrayBuffer,
      deferBufferMaxRows: 2,
    };

    // Run 1 — decodes rows 0-1, leaf-walks 2-4, verifies the FULL set,
    // flushes the verified window, persists the cursor, stays incomplete.
    const run1 = await restoreAllMessages(masterKey, OWNER, opts);
    expect(run1.incomplete).toBe(true);
    expect(upserts.flat().map(m => m.id)).toEqual(['m-0000', 'm-0001']);
    expect(await isRestoreIncomplete(OWNER)).toBe(true);
    const cursor1 = await readRestoreCursor(OWNER);
    expect(cursor1?.cursorId).toBe('m-0001');
    // P2-B-4 — 'self' rows floored to 'sent' (backup said 'read').
    expect(upserts.flat().every(m => m.status === 'sent')).toBe(true);

    // Run 2 — resumes PAST the cursor (no re-decode of 0-1), decodes 2-3.
    const run2 = await restoreAllMessages(masterKey, OWNER, opts);
    expect(run2.incomplete).toBe(true);
    expect(upserts.flat().map(m => m.id)).toEqual(['m-0000', 'm-0001', 'm-0002', 'm-0003']);
    expect((await readRestoreCursor(OWNER))?.cursorId).toBe('m-0003');

    // Run 3 — decodes the final row; marker + cursor cleared.
    const run3 = await restoreAllMessages(masterKey, OWNER, opts);
    expect(run3.incomplete).toBe(false);
    expect(upserts.flat().map(m => m.id)).toEqual(['m-0000', 'm-0001', 'm-0002', 'm-0003', 'm-0004']);
    expect(await isRestoreIncomplete(OWNER)).toBe(false);
    expect(await readRestoreCursor(OWNER)).toBeNull();

    // No duplicates across the three runs — resume never re-flushed.
    const ids = upserts.flat().map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('P2-B-1/P2-B-2 — equal-count substitution hard-fails; NOTHING is flushed; marker stays', async () => {
    await seedServer(masterKey, 4);
    // Substitute one row's ciphertext AFTER the commit (same count) —
    // e.g. resurrecting an old ciphertext into a tombstone slot.
    const swapped = await makeRow(masterKey, 99, 'conv-1');
    serverState.rows[1] = {
      ...serverState.rows[1],
      ciphertext: swapped.ciphertext,
    };

    await expect(restoreAllMessages(masterKey, OWNER, {
      cryptoStore: new SqlCipherProtocolStore() as never,
      identityPubKey: PUB as ArrayBuffer,
      identityPrivKey: PRIV as ArrayBuffer, // priv key present — must STILL hard-fail
    })).rejects.toThrow('backup.merkle_mismatch:root_mismatch');

    expect(upserts.length).toBe(0);                       // P2-B-2: no unverified write
    expect(await isRestoreIncomplete(OWNER)).toBe(true);  // resumable, not "complete"
  });

  it('P2-B-1 — commit endpoint ERROR hard-fails (no no_commit soft-pass), nothing flushed', async () => {
    await seedServer(masterKey, 3);
    serverState.commitFetchThrows = true;

    await expect(restoreAllMessages(masterKey, OWNER, {
      cryptoStore: new SqlCipherProtocolStore() as never,
      identityPubKey: PUB as ArrayBuffer,
      identityPrivKey: PRIV as ArrayBuffer,
    })).rejects.toThrow('backup.merkle_mismatch:commit_fetch_failed');

    expect(upserts.length).toBe(0);
    expect(await isRestoreIncomplete(OWNER)).toBe(true);
  });

  it('P2-B-1 — genuinely-absent commit (clean null) still soft-passes and completes', async () => {
    await seedServer(masterKey, 3);
    serverState.commit = null; // wipe the commit the seeder shipped

    const res = await restoreAllMessages(masterKey, OWNER, {
      cryptoStore: new SqlCipherProtocolStore() as never,
      identityPubKey: PUB as ArrayBuffer,
    });
    expect(res.incomplete).toBe(false);
    expect(upserts.flat()).toHaveLength(3);
    expect(await isRestoreIncomplete(OWNER)).toBe(false);
  });

  it('P2-B-5 — backup group_state with epoch <= live epoch never stomps the live key', async () => {
    const liveKeyB64 = Buffer.alloc(32, 1).toString('base64');
    const backupKeyB64 = Buffer.alloc(32, 2).toString('base64');
    // Live runtime already holds epoch 5 (e.g. a rekey drained from the
    // relay pending queue seconds before the restore ran).
    useMessengerStore.getState().setGroupState({
      groupId: 'grp-1', name: 'Ops', owner: OWNER,
      members: {[OWNER]: {deviceId: 1, admin: true, joinedAt: 1}},
      masterKeyB64: liveKeyB64, epoch: 5, createdAt: 1, updatedAt: 1,
    });

    await seedServer(masterKey, 1, {
      conversations: [
        {
          conversation_id: 'grp-1', kind: 'group', name: 'Ops',
          members: [{userId: OWNER}, {userId: 'peer-1'}], last_message_at: null,
          // Legacy plaintext group_state (pre-v3 passthrough) — epoch 3
          // is OLDER than the live epoch 5.
          group_state: {
            groupId: 'grp-1', name: 'Ops', owner: OWNER,
            members: {[OWNER]: {deviceId: 1, admin: true, joinedAt: 1}},
            masterKeyB64: backupKeyB64, epoch: 3, createdAt: 1, updatedAt: 1,
          },
        },
        {
          conversation_id: 'grp-2', kind: 'group', name: 'New',
          members: [{userId: OWNER}], last_message_at: null,
          // No local state — a NEWER backup state must still apply.
          group_state: {
            groupId: 'grp-2', name: 'New', owner: OWNER,
            members: {[OWNER]: {deviceId: 1, admin: true, joinedAt: 1}},
            masterKeyB64: backupKeyB64, epoch: 7, createdAt: 1, updatedAt: 1,
          },
        },
      ],
    });

    const res = await restoreAllMessages(masterKey, OWNER, {
      cryptoStore: new SqlCipherProtocolStore() as never,
      identityPubKey: PUB as ArrayBuffer,
      identityPrivKey: PRIV as ArrayBuffer,
    });
    expect(res.incomplete).toBe(false);

    const groups = useMessengerStore.getState().groups;
    expect(groups['grp-1'].epoch).toBe(5);                 // guarded
    expect(groups['grp-1'].masterKeyB64).toBe(liveKeyB64); // key NOT stomped
    expect(groups['grp-2'].epoch).toBe(7);                 // fresh state applied
  });

  it('P2-B-5 — group_state is NOT applied when the integrity check hard-fails', async () => {
    await seedServer(masterKey, 2, {
      conversations: [{
        conversation_id: 'grp-3', kind: 'group', name: 'Stealth',
        members: [{userId: OWNER}], last_message_at: null,
        group_state: {
          groupId: 'grp-3', name: 'Stealth', owner: OWNER,
          members: {[OWNER]: {deviceId: 1, admin: true, joinedAt: 1}},
          masterKeyB64: Buffer.alloc(32, 3).toString('base64'),
          epoch: 1, createdAt: 1, updatedAt: 1,
        },
      }],
    });
    const swapped = await makeRow(masterKey, 42, 'conv-1');
    serverState.rows[0] = {...serverState.rows[0], ciphertext: swapped.ciphertext};

    await expect(restoreAllMessages(masterKey, OWNER, {
      cryptoStore: new SqlCipherProtocolStore() as never,
      identityPubKey: PUB as ArrayBuffer,
    })).rejects.toThrow('backup.merkle_mismatch');

    expect(useMessengerStore.getState().groups['grp-3']).toBeUndefined();
  });
});
