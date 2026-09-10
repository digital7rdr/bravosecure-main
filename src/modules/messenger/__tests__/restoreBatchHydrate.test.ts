/**
 * sqa.md bug register — this suite pins: B-163, B-165.
 *
 * BUG-B verified-only ledger seed = B-163 · BUG-D live-row no-stomp + participants resync = B-165.
 * Source of the mapping: docs/audits/BACKUP_AUDIT_2026-07-24.md (§2 table + §5
 * suite map). The cases below carry the audit-internal BUG-x ids; this block is
 * the crosswalk so an sqa.md bug id greps to its regression test.
 */
/**
 * BR-1 + BUG-B + BUG-D — restoreAllMessages progressive hydration and
 * verified-only side effects.
 *
 *   • BR-1 — the deferred flush paints the store batch-by-batch (with
 *     the M-13 write-through suppression held for every batch) so the
 *     user watches history stream in on MessengerHome instead of
 *     staring at a blank list until one giant final hydrate.
 *   • SECURITY — nothing reaches the store (messages OR conversations)
 *     when the Merkle gate hard-fails: batch hydration must never leak
 *     unverified content that the abort then leaves visible.
 *   • BUG-B — the B-94 ledger seed covers EXACTLY the rows the verified
 *     flush wrote. The old loadAll()-based seed also marked archive-
 *     replayed / live-received rows as flushed, so the boot sweep
 *     skipped rows the server mirror never held — silent loss on the
 *     next restore.
 *   • BUG-D — conversation rows are staged until integrity clears, and
 *     NEVER overwrite a conversation the live store already holds (the
 *     unlock-path stomp / L9 stale-participants class). When the epoch
 *     guard keeps a newer live group state, participants re-sync from
 *     the LIVE membership.
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

jest.mock('@privacyresearch/curve25519-typescript', () => ({
  __esModule: true,
  AsyncCurve25519Wrapper: class {
    async sign(): Promise<ArrayBuffer> { return new Uint8Array(64).buffer; }
    async verify(): Promise<boolean> { return false; }
  },
}));

jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, msg: string) { super(msg); this.name = 'BackupError'; this.kind = kind; }
  }
  const state = {
    conversations: [] as unknown[],
    rows: [] as Array<{message_id: string; msg_created_at: string}>,
    commit: null as unknown,
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
      getMerkleCommit: jest.fn(async () => state.commit),
      putMerkleCommit: jest.fn(async (c: unknown) => { state.commit = c; return {ok: true}; }),
      getSessions: jest.fn(async () => null),
    },
  };
});

jest.mock('../crypto/sqlCipherStore', () => ({
  __esModule: true,
  SqlCipherProtocolStore: class SqlCipherProtocolStore {
    getDb(): unknown { return {}; }
  },
}));
jest.mock('../store/sqlMessageStore', () => {
  const byId = new Map<string, {id: string; conversation_id: string; status: string}>();
  const upserts: Array<Array<{id: string; status: string}>> = [];
  return {
    __esModule: true,
    __upserts: upserts,
    __byId: byId,
    SqlMessageStore: class SqlMessageStore {
      constructor(_db: unknown) { /* mock */ }
      async upsertBatch(batch: Array<{id: string; conversation_id: string; status: string}>): Promise<void> {
        upserts.push(batch);
        for (const m of batch) {byId.set(m.id, m);}
      }
      async loadAll(): Promise<Record<string, Array<{id: string; conversation_id: string; status: string}>>> {
        const out: Record<string, Array<{id: string; conversation_id: string; status: string}>> = {};
        for (const m of byId.values()) {
          if (!out[m.conversation_id]) {out[m.conversation_id] = [];}
          out[m.conversation_id].push(m);
        }
        return out;
      }
    },
  };
});
// BUG-B observers — the walk lazily requires these for the verified seed.
// Full-surface stub: merkleCommit also imports the epoch/pending helpers.
jest.mock('../backup/mirrorLedger', () => ({
  __esModule: true,
  recordFlushedVersions: jest.fn(async () => undefined),
  getFlushEpoch: () => 0,
  bumpFlushEpoch: () => undefined,
  setMerkleCommitPending: jest.fn(async () => undefined),
  readMerkleCommitPending: jest.fn(async () => false),
  clearMerkleCommitPendingIfNoFlushSince: jest.fn(async () => undefined),
  loadFlushedVersions: jest.fn(async () => new Map()),
  clearFlushedForOwner: jest.fn(async () => undefined),
}));
jest.mock('../backup/messageMirror', () => ({
  __esModule: true,
  computeMirrorVersion: (m: {id: string}) => `v:${m.id}`,
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {restoreAllMessages} from '../backup/restoreMessages';
import {commitMerkleRoot} from '../backup/merkleCommit';
import {generateMasterKey, importMasterKey, aesGcmEncrypt, toB64} from '../backup/backupCrypto';
import {isRestoreWriteThroughSuppressed} from '../backup/restoreWriteThrough';
import {recordFlushedVersions} from '../backup/mirrorLedger';
import {useMessengerStore} from '../store/messengerStore';
import type {MerkleRow} from '../backup/backupMerkle';

const OWNER = 'owner-uuid-1';
const PRIV = new Uint8Array(32).fill(9).buffer;
const PUB  = new Uint8Array(32).fill(3).buffer;

type ServerState = {conversations: unknown[]; rows: Array<Record<string, unknown>>; commit: unknown};
const serverState = (require('../backup/backupClient') as {__serverState: ServerState}).__serverState;
const upserts = (require('../store/sqlMessageStore') as {__upserts: unknown[][]}).__upserts;
const sqlById = (require('../store/sqlMessageStore') as {__byId: Map<string, unknown>}).__byId;
const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
  {SqlCipherProtocolStore: new () => {getDb: () => unknown}};

async function makeRow(masterKey: CryptoKey, i: number, convId: string): Promise<Record<string, unknown>> {
  const id = `m-${String(i).padStart(4, '0')}`;
  const ts = new Date(1_700_000_000_000 + i * 1000).toISOString();
  const payload = {
    id, conversation_id: convId, sender_id: 'self', recipient_id: 'peer-1',
    type: 'text', content: `msg ${i}`, status: 'read', created_at: ts,
  };
  const ct = await aesGcmEncrypt(masterKey, new TextEncoder().encode(JSON.stringify(payload)));
  return {
    message_id: id, conversation_id: convId, sender_id: 'self', recipient_id: 'peer-1',
    msg_type: 'text', ciphertext: toB64(ct), ciphertext_type: 1, envelope_meta: {}, msg_created_at: ts,
  };
}

async function seedServer(masterKey: CryptoKey, rowCount: number, extras: {conversations?: unknown[]} = {}): Promise<void> {
  serverState.conversations = extras.conversations ?? [{
    conversation_id: 'conv-1', kind: 'direct', name: 'Peer One',
    members: [{userId: 'peer-1'}, {userId: OWNER}], last_message_at: null,
  }];
  serverState.rows = [];
  for (let i = 0; i < rowCount; i++) {
    serverState.rows.push(await makeRow(masterKey, i, 'conv-1'));
  }
  serverState.commit = null;
  await commitMerkleRoot({
    identityPrivKey: PRIV,
    userId: OWNER,
    rows: serverState.rows.map(r => ({
      message_id: r.message_id as string,
      msg_created_at: r.msg_created_at as string,
      ciphertext: r.ciphertext as string,
    }) as MerkleRow),
  });
}

describe('BR-1 — batch-by-batch verified hydration', () => {
  let masterKey: CryptoKey;

  beforeEach(async () => {
    await (AsyncStorage as unknown as {clear: () => Promise<void>}).clear();
    upserts.length = 0;
    sqlById.clear();
    jest.clearAllMocks();
    useMessengerStore.setState({conversations: {}, conversationOrder: [], groups: {}, messages: {}});
    const {raw} = await generateMasterKey();
    masterKey = await importMasterKey(raw);
  });

  it('paints the store incrementally during the verified flush, write-through suppressed each time', async () => {
    await seedServer(masterKey, 5);
    // Observe every store commit that grows conv-1's message list and the
    // M-13 flag AT COMMIT TIME (Zustand fires subscribers synchronously
    // inside set(), so this reads the flag exactly during the hydrate).
    const growth: Array<{count: number; suppressed: boolean}> = [];
    const unsub = useMessengerStore.subscribe(s => {
      const count = (s.messages['conv-1'] ?? []).length;
      const last = growth[growth.length - 1];
      if (!last || last.count !== count) {
        growth.push({count, suppressed: isRestoreWriteThroughSuppressed()});
      }
    });
    try {
      // Small pages via the buffer cap → 3 runs, each flushing its window
      // batch-by-batch. Run to completion.
      const opts = {
        cryptoStore: new SqlCipherProtocolStore() as never,
        identityPubKey: PUB as ArrayBuffer,
        identityPrivKey: PRIV as ArrayBuffer,
        deferBufferMaxRows: 2,
      };
      let incomplete = true;
      for (let i = 0; i < 5 && incomplete; i++) {
        incomplete = (await restoreAllMessages(masterKey, OWNER, opts)).incomplete;
      }
      expect(incomplete).toBe(false);
    } finally {
      unsub();
    }
    // Progressive: the store grew in MULTIPLE steps, not one 0→5 jump.
    const grew = growth.filter(g => g.count > 0);
    expect(grew.length).toBeGreaterThanOrEqual(2);
    // Every message-growing commit ran under the M-13 suppression.
    expect(grew.every(g => g.suppressed)).toBe(true);
    // End state — full history in the store.
    expect(useMessengerStore.getState().messages['conv-1'].map(m => m.id)).toEqual(
      ['m-0000', 'm-0001', 'm-0002', 'm-0003', 'm-0004'],
    );
  });

  it('SECURITY — a hard integrity failure hydrates NOTHING (no batch leaks, no conversations)', async () => {
    await seedServer(masterKey, 4);
    const swapped = await makeRow(masterKey, 99, 'conv-1');
    serverState.rows[1] = {...serverState.rows[1], ciphertext: swapped.ciphertext};

    await expect(restoreAllMessages(masterKey, OWNER, {
      cryptoStore: new SqlCipherProtocolStore() as never,
      identityPubKey: PUB as ArrayBuffer,
    })).rejects.toThrow('backup.merkle_mismatch:root_mismatch');

    const s = useMessengerStore.getState();
    expect(Object.keys(s.messages)).toHaveLength(0);
    // BUG-D — staged conversations dropped with the buffers.
    expect(Object.keys(s.conversations)).toHaveLength(0);
    expect(upserts.length).toBe(0);
    expect(recordFlushedVersions).not.toHaveBeenCalled();
  });

  it('BUG-B — the ledger seed covers EXACTLY the verified flushed rows, nothing else', async () => {
    await seedServer(masterKey, 5);
    // A row the SQL store holds that this walk did NOT flush (stand-in
    // for an archive-replayed / live-received message).
    sqlById.set('m-alien', {id: 'm-alien', conversation_id: 'conv-1', status: 'delivered'});

    const opts = {
      cryptoStore: new SqlCipherProtocolStore() as never,
      identityPubKey: PUB as ArrayBuffer,
      identityPrivKey: PRIV as ArrayBuffer,
      deferBufferMaxRows: 2,
    };
    const run1 = await restoreAllMessages(masterKey, OWNER, opts);
    expect(run1.incomplete).toBe(true);

    const seeded = (recordFlushedVersions as jest.Mock).mock.calls
      .flatMap(c => c[1] as Array<{messageId: string; version: string}>);
    // Run 1 flushed its 2-row verified window — and ONLY that.
    expect(seeded.map(e => e.messageId).sort()).toEqual(['m-0000', 'm-0001']);
    expect(seeded.every(e => e.version.startsWith('v:'))).toBe(true);
    expect(seeded.some(e => e.messageId === 'm-alien')).toBe(false);

    // Complete the restore — the alien row must STILL never be seeded.
    let incomplete = true;
    for (let i = 0; i < 5 && incomplete; i++) {
      incomplete = (await restoreAllMessages(masterKey, OWNER, opts)).incomplete;
    }
    const allSeeded = (recordFlushedVersions as jest.Mock).mock.calls
      .flatMap(c => c[1] as Array<{messageId: string}>).map(e => e.messageId);
    expect(allSeeded).not.toContain('m-alien');
    expect(new Set(allSeeded)).toEqual(new Set(['m-0000', 'm-0001', 'm-0002', 'm-0003', 'm-0004']));
  });

  it('BUG-D — a conversation the live store already holds is never stomped by the backup row', async () => {
    // Live conversation with fresher state than the backup copy.
    useMessengerStore.getState().upsertConversation({
      id: 'conv-1', type: 'direct', name: 'Live Name',
      peer: {userId: 'peer-1', deviceId: 1}, participants: ['peer-1'],
      session_state: 'fresh', unread_count: 7, is_muted: true, is_pinned: true,
      default_ttl_sec: 60, is_custom_name: true, created_at: new Date().toISOString(),
    } as never);

    await seedServer(masterKey, 1, {
      conversations: [{
        conversation_id: 'conv-1', kind: 'direct', name: 'Stale Backup Name',
        members: [{userId: 'peer-1'}, {userId: OWNER}], last_message_at: null,
        is_muted: false, is_pinned: false, unread_count: 0, is_custom_name: false,
      }],
    });

    const res = await restoreAllMessages(masterKey, OWNER, {
      cryptoStore: new SqlCipherProtocolStore() as never,
      identityPubKey: PUB as ArrayBuffer,
      identityPrivKey: PRIV as ArrayBuffer,
    });
    expect(res.incomplete).toBe(false);

    const conv = useMessengerStore.getState().conversations['conv-1'];
    expect(conv.name).toBe('Live Name');
    expect(conv.is_muted).toBe(true);
    expect(conv.is_pinned).toBe(true);
    expect(conv.unread_count).toBe(7);
  });

  it('BUG-D — rejected older group_state re-syncs participants from the LIVE membership', async () => {
    const liveKeyB64 = Buffer.alloc(32, 1).toString('base64');
    // Live group state (epoch 5) exists — e.g. a rekey drained during
    // password entry — but NO conversation row yet (fresh install).
    useMessengerStore.getState().setGroupState({
      groupId: 'grp-1', name: 'Ops', owner: OWNER,
      members: {
        [OWNER]:   {deviceId: 1, admin: true,  joinedAt: 1},
        'peer-new': {deviceId: 1, admin: false, joinedAt: 2},
      },
      masterKeyB64: liveKeyB64, epoch: 5, createdAt: 1, updatedAt: 1,
    });

    await seedServer(masterKey, 1, {
      conversations: [{
        conversation_id: 'grp-1', kind: 'group', name: 'Ops',
        // Backup's member list still contains the REMOVED member.
        members: [{userId: OWNER}, {userId: 'peer-removed'}], last_message_at: null,
        group_state: {
          groupId: 'grp-1', name: 'Ops', owner: OWNER,
          members: {
            [OWNER]:        {deviceId: 1, admin: true,  joinedAt: 1},
            'peer-removed': {deviceId: 1, admin: false, joinedAt: 1},
          },
          masterKeyB64: Buffer.alloc(32, 2).toString('base64'),
          epoch: 3, createdAt: 1, updatedAt: 1,
        },
      }],
    });

    const res = await restoreAllMessages(masterKey, OWNER, {
      cryptoStore: new SqlCipherProtocolStore() as never,
      identityPubKey: PUB as ArrayBuffer,
      identityPrivKey: PRIV as ArrayBuffer,
    });
    expect(res.incomplete).toBe(false);

    const s = useMessengerStore.getState();
    // Live epoch kept, key not stomped.
    expect(s.groups['grp-1'].epoch).toBe(5);
    expect(s.groups['grp-1'].masterKeyB64).toBe(liveKeyB64);
    // The conversation exists (inserted from backup) BUT its send
    // fan-out set follows the LIVE membership, not the stale backup list.
    const parts = s.conversations['grp-1'].participants ?? [];
    expect(parts).toContain('peer-new');
    expect(parts).not.toContain('peer-removed');
  });
});
