/**
 * restoreAllMessages — the STREAMING (no-Merkle) walk.
 *
 * The deferred/Merkle path has suites; the streaming path — the one every
 * legacy account and every restore without an identity public key takes — did
 * not, so the page-by-page write/paint/cursor loop and all of its row-level
 * decisions ran untested.
 *
 * Pinned here:
 *   • The page loop writes each page durably, PAINTS it (BR-1) and persists the
 *     resume cursor — in that order, per page.
 *   • Audit P1-B2 — a persisted cursor RESUMES the walk instead of re-walking
 *     from row 0.
 *   • Round 8 (peer fallback) — an INBOUND row's peer is the SENDER. The old
 *     code used recipient_id for both directions, which on inbound rows pointed
 *     peer at SELF and broke replies, retracts and contact lookup on every
 *     restored inbound message.
 *   • Round 8 (tombstones) + M-08 — `status='deleted'` rows never enter the
 *     store, and their ids are persisted so the sealed-archive replay that runs
 *     next cannot resurrect them.
 *   • B-106 — an ad-hoc CALL group's chat row is not resurrected, but its
 *     MESSAGES still restore (the Calls tab needs them).
 *   • One bad row never aborts the run: an orphan encrypted under a previous
 *     master key, and an M-3 payload/outer id mismatch, are both COUNTED and
 *     skipped.
 *   • BUG-T — conversations paginate; a cursor-less call is capped server-side
 *     at 5000 and the client used to silently accept the truncated set.
 *   • The progress emitter is best-effort — a throwing listener cannot abort a
 *     restore.
 */

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

jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, msg: string) { super(msg); this.name = 'BackupError'; this.kind = kind; }
  }
  const state = {
    conversations: [] as Array<Record<string, unknown>>,
    rows:          [] as Array<Record<string, unknown>>,
  };
  return {
    __esModule: true,
    BackupError,
    __serverState: state,
    backupClient: {
      getConversations: jest.fn(async (since?: string, limit = 1000, sinceId?: string) => {
        // Tuple cursor on (last_message_at DESC, conversation_id), mirroring
        // the server. Null last_message_at rows sort last and cannot be
        // cursored past — they come back on the first page (documented L-6).
        const all = state.conversations;
        const rest = since
          ? all.filter(c => {
            const ts = c.last_message_at as string | null;
            if (!ts) {return false;}
            if (ts !== since) {return ts < since;}
            return sinceId ? String(c.conversation_id) > sinceId : false;
          })
          : all;
        return {conversations: rest.slice(0, limit)};
      }),
      getMessages: jest.fn(async (since?: string, limit = 1000, sinceId?: string) => {
        const rows = state.rows.filter(r => {
          if (!since) {return true;}
          if (r.msg_created_at !== since) {return (r.msg_created_at as string) > since;}
          return sinceId ? (r.message_id as string) > sinceId : false;
        });
        return {messages: rows.slice(0, limit)};
      }),
      getMerkleCommit: jest.fn(async () => null),
      getSessions:     jest.fn(async () => null),
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
  const upserts: Array<Array<Record<string, unknown>>> = [];
  return {
    __esModule: true,
    __upserts: upserts,
    SqlMessageStore: class SqlMessageStore {
      constructor(_db: unknown) { /* mock */ }
      // Stale-mock fix: the REAL upsertBatch returns the number of rows it
      // skipped (envelope-id conflicts), and restoreMessages sums it into its
      // `skipped` counter. A void mock made that sum `+= undefined` → NaN,
      // failing every skipped-count assertion. The fake inserts everything,
      // so it skips 0.
      async upsertBatch(batch: Array<Record<string, unknown>>): Promise<number> {
        upserts.push(batch);
        return 0;
      }
      async loadAll(): Promise<Record<string, unknown[]>> { return {}; }
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {restoreAllMessages} from '../backup/restoreMessages';
import {generateMasterKey, importMasterKey, aesGcmEncrypt, toB64} from '../backup/backupCrypto';
import {readRestoreCursor, writeRestoreCursor, isRestoreIncomplete} from '../backup/restoreResume';
import {loadRestoreTombstones, _resetRestoreTombstonesForTests} from '../backup/restoreTombstones';
import {isConversationTombstoned, _resetConversationTombstonesForTests} from '../backup/conversationTombstones';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';

const OWNER = 'owner-uuid-1';

type ServerState = {
  conversations: Array<Record<string, unknown>>;
  rows: Array<Record<string, unknown>>;
};
const serverState = (require('../backup/backupClient') as {__serverState: ServerState}).__serverState;
const {backupClient} = require('../backup/backupClient') as {
  backupClient: {getConversations: jest.Mock; getMessages: jest.Mock};
};
const upserts = (require('../store/sqlMessageStore') as
  {__upserts: Array<Array<Record<string, unknown>>>}).__upserts;
const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
  {SqlCipherProtocolStore: new () => {getDb: () => unknown}};

let masterKey: CryptoKey;

/** Build one v1 (direct-master-wrapped) server row, as the mirror ships it. */
async function row(i: number, over: {
  convId?: string;
  senderId?: string;
  recipientId?: string;
  status?: string;
  payloadId?: string;
  key?: CryptoKey;
} = {}): Promise<Record<string, unknown>> {
  const id = `m-${String(i).padStart(4, '0')}`;
  const ts = new Date(1_700_000_000_000 + i * 1000).toISOString();
  const convId = over.convId ?? 'conv-1';
  const senderId = over.senderId ?? OWNER;
  const payload = {
    id:              over.payloadId ?? id,
    conversation_id: convId,
    sender_id:       senderId,
    recipient_id:    over.recipientId ?? 'peer-1',
    type:            'text',
    content:         `msg ${i}`,
    status:          over.status ?? 'read',
    created_at:      ts,
  };
  const ct = await aesGcmEncrypt(over.key ?? masterKey, new TextEncoder().encode(JSON.stringify(payload)));
  return {
    message_id:      id,
    conversation_id: convId,
    sender_id:       senderId,
    recipient_id:    over.recipientId ?? 'peer-1',
    msg_type:        'text',
    ciphertext:      toB64(ct),
    ciphertext_type: 1,
    envelope_meta:   {},
    msg_created_at:  ts,
  };
}

function directConv(id = 'conv-1', over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation_id: id,
    kind:            'direct',
    name:            'Peer One',
    members:         [{userId: 'peer-1'}, {userId: OWNER}],
    last_message_at: null,
    ...over,
  };
}

const sqlOpts = (): {cryptoStore: never} => ({cryptoStore: new SqlCipherProtocolStore() as never});
const flat = (): Array<Record<string, unknown>> => upserts.flat();
const storeMsgs = (): Record<string, LocalMessage[]> =>
  useMessengerStore.getState().messages as unknown as Record<string, LocalMessage[]>;

beforeEach(async () => {
  jest.clearAllMocks();
  await (AsyncStorage as unknown as {clear: () => Promise<void>}).clear();
  _resetRestoreTombstonesForTests();
  _resetConversationTombstonesForTests();
  upserts.length = 0;
  serverState.conversations = [directConv()];
  serverState.rows = [];
  useMessengerStore.setState({conversations: {}, conversationOrder: [], groups: {}, messages: {}});
  const {raw} = await generateMasterKey();
  masterKey = await importMasterKey(raw);
});

describe('restoreAllMessages — streaming walk', () => {
  // B-594 fresh-install restore — a conversation the user deleted is carried in
  // the backup with deleted=true; a FRESH install has an empty local tombstone
  // set, so restore MUST arm it from the flag before applying, or the deleted
  // room is handed straight back. RED before the fix (restore ignored the flag).
  it('B-594 — a deleted=true conversation is NOT re-created on a fresh-install restore, and is armed into the tombstone set', async () => {
    // Fresh install: nothing in the local tombstone store (beforeEach cleared it).
    expect(isConversationTombstoned('c-del')).toBe(false);
    serverState.conversations = [
      directConv('c-live'),
      directConv('c-del', {deleted: true}),
    ];

    await restoreAllMessages(masterKey, OWNER, sqlOpts());

    const convos = useMessengerStore.getState().conversations;
    // The live one restores…
    expect(convos['c-live']).toBeTruthy();
    // …the deleted one does NOT (suppressed at the upsert)…
    expect(convos['c-del']).toBeFalsy();
    // …and its id is now armed so it also survives to the NEXT restore + is
    // consulted by the four minters.
    expect(isConversationTombstoned('c-del')).toBe(true);
    // A live room is never falsely armed.
    expect(isConversationTombstoned('c-live')).toBe(false);
  });

  it('writes, paints, and cursors each page as it goes; clears the markers on completion', async () => {
    for (let i = 0; i < 3; i++) {serverState.rows.push(await row(i));}

    const out = await restoreAllMessages(masterKey, OWNER, sqlOpts());

    expect(out).toEqual({conversations: 1, messages: 3, skipped: 0, incomplete: false});
    // Durable first…
    expect(flat().map(m => m.id)).toEqual(['m-0000', 'm-0001', 'm-0002']);
    // …painted into the live store (BR-1) — the user watches chats fill in…
    expect(storeMsgs()['conv-1'].map(m => m.id)).toEqual(['m-0000', 'm-0001', 'm-0002']);
    // …and the conversation row came back with it.
    expect(useMessengerStore.getState().conversations['conv-1']).toBeTruthy();
    // A completed run leaves nothing to resume.
    expect(await readRestoreCursor(OWNER)).toBeNull();
    expect(await isRestoreIncomplete(OWNER)).toBe(false);
  });

  it('P1-B2 — a persisted cursor RESUMES the walk instead of replaying written pages', async () => {
    for (let i = 0; i < 4; i++) {serverState.rows.push(await row(i));}
    await writeRestoreCursor(OWNER, {
      cursorTs: serverState.rows[1].msg_created_at as string,
      cursorId: 'm-0001',
    });

    const out = await restoreAllMessages(masterKey, OWNER, sqlOpts());

    // Only the two rows past the cursor are re-decoded and re-written.
    expect(out.messages).toBe(2);
    expect(flat().map(m => m.id)).toEqual(['m-0002', 'm-0003']);
    // The server was asked to start past the cursor, not from row 0.
    expect(backupClient.getMessages).toHaveBeenNthCalledWith(
      1, serverState.rows[1].msg_created_at, 1000, 'm-0001',
    );
  });

  it('Round 8 — an INBOUND row\'s peer is the SENDER, an outbound row\'s is the recipient', async () => {
    serverState.rows.push(await row(0, {senderId: 'peer-1', recipientId: OWNER}));  // inbound
    serverState.rows.push(await row(1, {senderId: OWNER, recipientId: 'peer-1'}));  // outbound

    await restoreAllMessages(masterKey, OWNER, sqlOpts());

    const written = flat() as unknown as LocalMessage[];
    // Pre-fix both used recipient_id, so the inbound row's peer was SELF and
    // replies / retracts / contact lookup broke on every restored inbound msg.
    expect(written[0].peer).toEqual({userId: 'peer-1', deviceId: 1});
    expect(written[1].peer).toEqual({userId: 'peer-1', deviceId: 1});
    // Outbound status is floored so a restored device can't claim delivery.
    expect(written[1].status).toBe('sent');
  });

  it('M-08 — deleted tombstones never enter the store and are persisted for the archive replay', async () => {
    serverState.rows.push(await row(0));
    serverState.rows.push(await row(1, {status: 'deleted'}));
    serverState.rows.push(await row(2));

    const out = await restoreAllMessages(masterKey, OWNER, sqlOpts());

    expect(out.messages).toBe(2);
    expect(flat().map(m => m.id)).toEqual(['m-0000', 'm-0002']);
    expect(storeMsgs()['conv-1'].map(m => m.id)).not.toContain('m-0001');
    // Without this the archive replay's appendMessage re-inserts the row the
    // user deleted before reinstalling.
    expect(await loadRestoreTombstones(OWNER)).toEqual(new Set(['m-0001']));
  });

  it('B-106 — an ad-hoc CALL group gets no chat row, but its messages still restore', async () => {
    serverState.conversations = [
      {conversation_id: 'call-1', kind: 'group', name: 'Call', is_custom_name: false, members: [], last_message_at: null},
      {conversation_id: 'grp-1', kind: 'group', name: 'Call', is_custom_name: true, members: [{userId: 'u-1'}], last_message_at: null},
    ];
    serverState.rows.push(await row(0, {convId: 'call-1'}));

    const out = await restoreAllMessages(masterKey, OWNER, sqlOpts());

    const convos = useMessengerStore.getState().conversations;
    // The exact BS-CALL-GHOST sentinel is suppressed…
    expect(convos['call-1']).toBeUndefined();
    // …a user-RENAMED group that happens to be called "Call" is not.
    expect(convos['grp-1']).toBeTruthy();
    // The slot's messages still land, so group-call rows stay in the Calls tab.
    expect(out.messages).toBe(1);
    expect(flat().map(m => m.id)).toEqual(['m-0000']);
  });

  it('counts and skips an undecryptable orphan row instead of aborting the restore', async () => {
    const {raw: otherRaw} = await generateMasterKey();
    const staleKey = await importMasterKey(otherRaw);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    serverState.rows.push(await row(0));
    // Backup setup ran twice: this row is wrapped under the previous key.
    serverState.rows.push(await row(1, {key: staleKey}));
    serverState.rows.push(await row(2));

    const out = await restoreAllMessages(masterKey, OWNER, sqlOpts());

    expect(out).toMatchObject({messages: 2, skipped: 1, incomplete: false});
    expect(flat().map(m => m.id)).toEqual(['m-0000', 'm-0002']);
    warn.mockRestore();
  });

  it('M-3 — a row whose PAYLOAD id disagrees with its outer message_id is rejected', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    serverState.rows.push(await row(0));
    // A same-key content swap that a legacy no-AAD row would not otherwise catch.
    serverState.rows.push(await row(1, {payloadId: 'm-9999'}));

    const out = await restoreAllMessages(masterKey, OWNER, sqlOpts());

    expect(out).toMatchObject({messages: 1, skipped: 1});
    expect(flat().map(m => m.id)).toEqual(['m-0000']);
    warn.mockRestore();
  });

  it('BUG-T — conversations paginate past the server\'s single-call cap', async () => {
    // 1200 rows with descending timestamps so the tuple cursor can advance.
    serverState.conversations = Array.from({length: 1200}, (_, i) =>
      directConv(`c-${String(i).padStart(4, '0')}`, {
        last_message_at: new Date(1_800_000_000_000 - i * 1000).toISOString(),
      }));
    // The live store already holds them, so the staged apply short-circuits
    // (BUG-D: live state always wins). Keeps this test about PAGING.
    const live: Record<string, unknown> = {};
    for (const c of serverState.conversations) {
      live[c.conversation_id as string] = {
        id: c.conversation_id, type: 'direct', name: '', participants: [],
        peer: {userId: 'peer-1', deviceId: 1}, session_state: 'fresh',
        unread_count: 0, is_muted: false, created_at: '',
      };
    }
    useMessengerStore.setState({
      conversations: live as never, conversationOrder: Object.keys(live),
    });

    const out = await restoreAllMessages(masterKey, OWNER, sqlOpts());

    // A cursor-less call is capped server-side at 5000 and the client used to
    // accept the truncated set silently, losing the remainder every restore.
    expect(out.conversations).toBe(1200);
    expect(backupClient.getConversations).toHaveBeenCalledTimes(2);
    // The second call carries the tuple cursor (ts AND id), not just the ts —
    // without `cursorId` two rows sharing a timestamp straddle the boundary.
    expect(backupClient.getConversations.mock.calls[1][0])
      .toBe(serverState.conversations[999].last_message_at);
    expect(backupClient.getConversations.mock.calls[1][2]).toBe('c-0999');
  });

  it('round-trips the conversation-level UX state (mute / pin / TTL / unread / custom name)', async () => {
    serverState.conversations = [directConv('conv-1', {
      is_muted: true, is_pinned: true, default_ttl_sec: 86400,
      unread_count: 9, is_custom_name: true, name: 'Mom',
    })];

    await restoreAllMessages(masterKey, OWNER, sqlOpts());

    // Pre-Round-8 these reset on every restore: the user came back to a noisy,
    // unpinned, name-reverted chat list.
    expect(useMessengerStore.getState().conversations['conv-1']).toMatchObject({
      name: 'Mom', is_muted: true, is_pinned: true,
      default_ttl_sec: 86400, unread_count: 9, is_custom_name: true,
    });
  });

  it('a THROWING progress listener never aborts the restore', async () => {
    for (let i = 0; i < 2; i++) {serverState.rows.push(await row(i));}
    const steps: string[] = [];

    const out = await restoreAllMessages(masterKey, OWNER, {
      ...sqlOpts(),
      onProgress: p => { steps.push(p.step); throw new Error('bad UI listener'); },
    });

    expect(out.messages).toBe(2);
    expect(steps).toContain('conversations');
    expect(steps).toContain('messages');
    expect(steps).toContain('hydrate');
  });

  it('restores into memory alone when no SQLCipher store is supplied', async () => {
    for (let i = 0; i < 2; i++) {serverState.rows.push(await row(i));}

    const out = await restoreAllMessages(masterKey, OWNER, {});

    expect(upserts).toHaveLength(0);           // nothing durable to write to
    expect(out.messages).toBe(2);
    expect(storeMsgs()['conv-1'].map(m => m.id)).toEqual(['m-0000', 'm-0001']);
    // No durable write ⇒ no resume cursor to honour on the next run.
    expect(await readRestoreCursor(OWNER)).toBeNull();
  });
});
