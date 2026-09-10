/**
 * productionRuntime — the CONTROL-ENVELOPE send lanes, EXECUTED.
 *
 * Reactions, edits and delete-for-everyone all ship the same shape: an
 * empty-body sealed envelope carrying a directive plus (in a group) a routing
 * stamp. They are pairwise-encrypted even in a group, which is precisely why
 * they have their own bug history:
 *
 *   B-128  — the group reaction lane had no membership gate for months because
 *            it *looked* like the text lane, which is implicitly gated by
 *            possession of the master key. `sendMutationDirective` exists as
 *            ONE fan-out for edit + delete so that divergence cannot repeat.
 *   MSG-02 — a group reaction shipped without a `group` stamp was routed into
 *            the REACTOR's 1:1 slot, so the fold never found its target and the
 *            reaction was invisible to everyone but the reactor.
 *   P2-11  — these envelopes render nothing, so `urgent:false` must keep a
 *            dozing device from being woken by a phantom banner.
 *
 * These lanes also seal with a deliberately BARE `{to, ts}` aad — widening it
 * is a CLAUDE.md stop-condition — so the suite pins the aad key set exactly.
 * See `productionRuntimeDirectSend.test.ts` for the harness rationale.
 */

jest.mock('@bravo/messenger-core', () => {
  const actual = jest.requireActual('@bravo/messenger-core');
  const g = globalThis as unknown as {__prBus?: Record<string, unknown>};
  const bus = (g.__prBus = g.__prBus ?? {
    wsSends:    [] as unknown[],
    relaySends: [] as unknown[],
    retracted:  [] as string[],
    bundles:    {} as Record<string, unknown>,
    wsThrow:    false,
    onFrame:    null as unknown,
  }) as {
    wsSends: unknown[]; relaySends: unknown[]; retracted: string[];
    bundles: Record<string, unknown>; wsThrow: boolean; onFrame: unknown;
  };

  class FakeTransport {
    constructor(opts: {onFrame?: unknown}) { bus.onFrame = opts?.onFrame ?? null; }
    connect() { return Promise.resolve(); }
    disconnect() {}
    close() {}
    isConnected() { return true; }
    msSinceServerSignal() { return 0; }
    forceReconnect() { return Promise.resolve(); }
    send(frame: {event?: string}) {
      if (frame?.event !== 'envelope.send') { return; }
      if (bus.wsThrow) { throw new Error('ws socket closed'); }
      bus.wsSends.push(frame);
    }
  }
  class FakeKeys {
    uploadBundle() { return Promise.resolve({poolSize: 50, identityRotated: false}); }
    fetchPeerBundleWithPoolSize(userId: string) {
      const bundle = bus.bundles[userId];
      if (!bundle) { return Promise.reject(new Error(`no bundle for ${userId}`)); }
      return Promise.resolve({bundle, poolSize: 50});
    }
    fetchDevices() { return Promise.resolve([]); }
  }
  class FakeCertClient {}
  class FakeRelay {
    send(req: unknown) { bus.relaySends.push(req); return Promise.resolve({envelopeId: 'e', retractToken: 't'}); }
    retract(token: string) { bus.retracted.push(token); return Promise.resolve({retracted: true}); }
    pull() { return Promise.resolve({envelopes: []}); }
    ack() { return Promise.resolve({}); }
  }
  class FakeCertCache {
    get() { return Promise.resolve({cert: 'TEST-CERT', expiresAt: Math.floor(Date.now() / 1000) + 3600}); }
    getIssued() { return this.get(); }
  }
  class FakeRevoked { start() {} stop() {} isRevoked() { return false; } }
  class FakeUsers {}

  return {
    ...actual,
    TransportClient:   FakeTransport,
    KeysHttpClient:    FakeKeys,
    SenderCertClient:  FakeCertClient,
    RelayHttpClient:   FakeRelay,
    SenderCertCache:   FakeCertCache,
    RevokedJtiCache:   FakeRevoked,
    UsersHttpClient:   FakeUsers,
  };
});

import {
  installIdentity,
  buildOwnPreKeyBundle,
  SessionManager,
  unwrapOuter,
  unsealPayload,
  type CryptoStore,
} from '../crypto';
import {InMemoryProtocolStore} from '../crypto/inMemoryStore';
import {useMessengerStore} from '../store/messengerStore';
import type {MessengerRuntime} from '../runtime/runtime';
import type {LocalMessage} from '../store/types';

jest.setTimeout(240_000);

const ALICE = 'alice-user-id';
const BOB   = 'bob-user-id';
const CAROL = 'carol-user-id';
const GID   = 'group-uuid-mut';
const DM    = `direct:${BOB}`;
const MASTER_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

type Bus = {
  wsSends: Array<{event: string; data: Record<string, unknown>}>;
  relaySends: Array<Record<string, unknown>>;
  retracted: string[];
  bundles: Record<string, unknown>;
  wsThrow: boolean;
  onFrame: ((f: unknown) => void) | null;
};
const bus = (): Bus => (globalThis as unknown as {__prBus: Bus}).__prBus;

let runtime: MessengerRuntime;
const peerStores: Record<string, CryptoStore> = {};

async function openAs(userId: string, outerSealed: string): Promise<Record<string, unknown>> {
  const store = peerStores[userId];
  const id = await store.getIdentityKeyPair();
  const un = await unwrapOuter({
    ownIdentityPrivKey: id.privKey,
    ownIdentityPubKey:  id.pubKey,
    outerSealedB64:     outerSealed,
  });
  const plain = await new SessionManager(store).decrypt({userId: ALICE, deviceId: 1}, un.ciphertext);
  return unsealPayload(plain) as unknown as Record<string, unknown>;
}

/** Every envelope this send pushed, decrypted, keyed by recipient. */
async function openAllSends(): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const f of bus().wsSends) {
    const to = f.data.to as {userId: string};
    out[to.userId] = await openAs(to.userId, f.data.outerSealed as string);
  }
  return out;
}

const rowIn = (cid: string, id: string): LocalMessage | undefined =>
  useMessengerStore.getState().messages[cid]?.find(m => m.id === id);

function seedOwnMessage(cid: string, id: string, over: Partial<LocalMessage> = {}): void {
  useMessengerStore.getState().appendMessage(cid, {
    id,
    conversation_id: cid,
    sender_id: 'self',
    type: 'text',
    content: 'original body',
    status: 'sent',
    is_encrypted: true,
    created_at: new Date().toISOString(),
    peer: {userId: BOB, deviceId: 1},
    ...over,
  } as LocalMessage);
}

function seedDirect(): void {
  useMessengerStore.getState().upsertConversation({
    id: DM, type: 'direct', peer: {userId: BOB, deviceId: 1},
    participants: [ALICE, BOB], session_state: 'established',
  } as never);
}

function seedGroup(): void {
  useMessengerStore.getState().upsertConversation({
    id: GID, type: 'group', name: 'Room', peer: {userId: BOB, deviceId: 1},
    participants: [ALICE, BOB, CAROL], session_state: 'established',
  } as never);
  useMessengerStore.setState({
    groups: {[GID]: {
      groupId: GID, name: 'Room', owner: ALICE,
      members: {
        [ALICE]: {deviceId: 1, admin: true,  joinedAt: 0},
        [BOB]:   {deviceId: 1, admin: false, joinedAt: 0},
        [CAROL]: {deviceId: 1, admin: false, joinedAt: 0},
      },
      masterKeyB64: MASTER_KEY, epoch: 1, createdAt: 0, updatedAt: 0,
    } as never},
  });
}

beforeAll(async () => {
  for (const uid of [BOB, CAROL]) {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 6});
    peerStores[uid] = store;
    bus().bundles[uid] = await buildOwnPreKeyBundle(store, {userId: uid, deviceId: 1}, 1, 1);
  }

  const {buildProductionRuntime} = require('../runtime/productionRuntime') as
    typeof import('../runtime/productionRuntime');
  runtime = await buildProductionRuntime({
    ownStore: new InMemoryProtocolStore(),
    config: {
      authBaseUrl:        'http://auth.test',
      messengerBaseUrl:   'http://msg.test',
      wsUrl:              'ws://msg.test/ws',
      getToken:           async () => 'jwt',
      authorityPubKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ownUserId:          ALICE,
      ownerKey:           'alice@test',
    },
  });
});

afterAll(() => {
  const {disposeLiveRuntime} = require('../runtime/productionRuntime') as
    typeof import('../runtime/productionRuntime');
  disposeLiveRuntime();
});

beforeEach(() => {
  const b = bus();
  b.wsSends.length = 0;
  b.relaySends.length = 0;
  b.retracted.length = 0;
  b.wsThrow = false;
  useMessengerStore.setState({messages: {}, conversations: {}, groups: {}});
});

// These lanes register a pending entry (and its 5s ack watchdog) exactly like a
// text send; ack them so no timer fires into a later test.
afterEach(() => {
  const b = bus();
  for (const frame of b.wsSends) {
    b.onFrame?.({event: 'envelope.accepted', data: {clientMsgId: frame.data.clientMsgId, envelopeId: 'flush'}});
  }
});

describe('sendReaction', () => {
  it('ships an empty-body envelope carrying only the reaction directive', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-1');
    await runtime.sendReaction({userId: BOB, deviceId: 1}, DM, 'msg-1', '👍');

    expect(bus().wsSends).toHaveLength(1);
    const sealed = await openAs(BOB, bus().wsSends[0].data.outerSealed as string);
    expect(sealed.body).toBe('');
    expect(sealed.reaction).toEqual({targetMsgId: 'msg-1', emoji: '👍', remove: false});
    // A reaction renders no bubble on the recipient, so a killed device must
    // not be woken by an FCM banner for it.
    expect(bus().wsSends[0].data.urgent).toBe(false);
  });

  it('keeps the reaction aad BARE — exactly {to, ts}, nothing else (CLAUDE.md stop-condition)', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-1');
    await runtime.sendReaction({userId: BOB, deviceId: 1}, DM, 'msg-1', '🎉');

    const sealed = await openAs(BOB, bus().wsSends[0].data.outerSealed as string);
    const aad = sealed.aad as Record<string, unknown>;
    expect(Object.keys(aad).sort()).toEqual(['to', 'ts']);
    expect(aad.to).toEqual({userId: BOB, deviceId: 1});
  });

  it('carries remove=true so the recipient clears rather than sets the chip', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-1', {reactions: {self: '👍'}});
    await runtime.sendReaction({userId: BOB, deviceId: 1}, DM, 'msg-1', '👍', true);

    const sealed = await openAs(BOB, bus().wsSends[0].data.outerSealed as string);
    expect((sealed.reaction as {remove: boolean}).remove).toBe(true);
    expect(rowIn(DM, 'msg-1')?.reactions).toEqual({});
  });

  it('echoes the reaction locally under the `self` key without waiting for the round-trip', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-1');
    await runtime.sendReaction({userId: BOB, deviceId: 1}, DM, 'msg-1', '❤️');
    expect(rowIn(DM, 'msg-1')?.reactions).toEqual({self: '❤️'});

    // One emoji per reactor — a second reaction REPLACES the first.
    await runtime.sendReaction({userId: BOB, deviceId: 1}, DM, 'msg-1', '😂');
    expect(rowIn(DM, 'msg-1')?.reactions).toEqual({self: '😂'});
  });

  it('BS-RX1 — fans a GROUP reaction out to every other member, not just the passed peer', async () => {
    seedGroup();
    seedOwnMessage(GID, 'gmsg-1');
    await runtime.sendReaction({userId: BOB, deviceId: 1}, GID, 'gmsg-1', '👍');

    const to = bus().wsSends.map(f => (f.data.to as {userId: string}).userId).sort();
    expect(to).toEqual([BOB, CAROL].sort());
  });

  it('MSG-02 — stamps the group id so the recipient folds it onto the GROUP thread', async () => {
    seedGroup();
    seedOwnMessage(GID, 'gmsg-1');
    await runtime.sendReaction({userId: BOB, deviceId: 1}, GID, 'gmsg-1', '👍');

    const opened = await openAllSends();
    for (const uid of [BOB, CAROL]) {
      expect((opened[uid].group as {groupId: string}).groupId).toBe(GID);
      expect((opened[uid].reaction as {targetMsgId: string}).targetMsgId).toBe('gmsg-1');
    }
  });

  it('does NOT stamp a group on a 1:1 reaction (that would misroute the fold)', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-1');
    await runtime.sendReaction({userId: BOB, deviceId: 1}, DM, 'msg-1', '👍');

    const sealed = await openAs(BOB, bus().wsSends[0].data.outerSealed as string);
    expect(sealed.group).toBeUndefined();
  });

  it('is a no-op with no peer userId instead of throwing at the crypto layer', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-1');
    await expect(runtime.sendReaction({userId: '', deviceId: 1}, DM, 'msg-1', '👍'))
      .resolves.toBeUndefined();
    expect(bus().wsSends).toHaveLength(0);
    expect(rowIn(DM, 'msg-1')?.reactions).toBeUndefined();
  });

  it('P2-11 — falls back to HTTP when the socket throws and still echoes locally', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-1');
    bus().wsThrow = true;
    await runtime.sendReaction({userId: BOB, deviceId: 1}, DM, 'msg-1', '👍');

    expect(bus().relaySends).toHaveLength(1);
    expect(bus().relaySends[0].urgent).toBe(false);
    expect(rowIn(DM, 'msg-1')?.reactions).toEqual({self: '👍'});
  });

  it('still echoes locally when every recipient fails to encrypt (best-effort fan-out)', async () => {
    useMessengerStore.getState().upsertConversation({
      id: GID, type: 'group', name: 'Room', peer: {userId: 'ghost', deviceId: 1},
      participants: [ALICE, 'ghost-a', 'ghost-b'], session_state: 'established',
    } as never);
    seedOwnMessage(GID, 'gmsg-1');

    await expect(runtime.sendReaction({userId: 'ghost-a', deviceId: 1}, GID, 'gmsg-1', '👍'))
      .resolves.toBeUndefined();
    expect(bus().wsSends).toHaveLength(0);
    expect(rowIn(GID, 'gmsg-1')?.reactions).toEqual({self: '👍'});
  });
});

describe('sendMessageEdit', () => {
  it('ships the edit directive top-level on a 1:1 and applies the local echo', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-1');
    await runtime.sendMessageEdit({userId: BOB, deviceId: 1}, DM, 'msg-1', 'corrected body');

    const sealed = await openAs(BOB, bus().wsSends[0].data.outerSealed as string);
    const edit = sealed.edit as {targetMsgId: string; body: string; editedAt: number};
    expect(edit.targetMsgId).toBe('msg-1');
    expect(edit.body).toBe('corrected body');
    expect(typeof edit.editedAt).toBe('number');
    expect(sealed.body).toBe('');

    const row = rowIn(DM, 'msg-1')!;
    expect(row.content).toBe('corrected body');
    expect(row.edited_at).toBe(edit.editedAt);
  });

  it('WIRE-COMPAT — in a GROUP the edit rides INSIDE the group stamp, never top-level', async () => {
    seedGroup();
    seedOwnMessage(GID, 'gmsg-1');
    await runtime.sendMessageEdit({userId: BOB, deviceId: 1}, GID, 'gmsg-1', 'fixed');

    const opened = await openAllSends();
    // A top-level key an older peer does not know DESTROYS the envelope; inside
    // `group` it is simply ignored.
    expect('edit' in opened[BOB]).toBe(false);
    expect((opened[BOB].group as {edit: {body: string}}).edit.body).toBe('fixed');
    expect(Object.keys(opened).sort()).toEqual([BOB, CAROL].sort());
  });

  it('keeps the mutation aad bare, exactly like the reaction lane', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-1');
    await runtime.sendMessageEdit({userId: BOB, deviceId: 1}, DM, 'msg-1', 'x');

    const sealed = await openAs(BOB, bus().wsSends[0].data.outerSealed as string);
    expect(Object.keys(sealed.aad as Record<string, unknown>).sort()).toEqual(['to', 'ts']);
  });

  it('refuses to edit a message we did not write — no envelope, no local rewrite', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-peer', {sender_id: BOB});
    await runtime.sendMessageEdit({userId: BOB, deviceId: 1}, DM, 'msg-peer', 'hijacked');

    expect(bus().wsSends).toHaveLength(0);
    expect(rowIn(DM, 'msg-peer')?.content).toBe('original body');
  });

  it('refuses to edit past the edit window (a stale action sheet must not ship)', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-old', {created_at: new Date(Date.now() - 48 * 3600_000).toISOString()});
    await runtime.sendMessageEdit({userId: BOB, deviceId: 1}, DM, 'msg-old', 'too late');

    expect(bus().wsSends).toHaveLength(0);
    expect(rowIn(DM, 'msg-old')?.content).toBe('original body');
  });

  it('refuses to edit a message already deleted for everyone (deletion is one-way)', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-dead', {deleted_for_all: true});
    await runtime.sendMessageEdit({userId: BOB, deviceId: 1}, DM, 'msg-dead', 'resurrect');

    expect(bus().wsSends).toHaveLength(0);
    expect(rowIn(DM, 'msg-dead')?.content).toBe('original body');
  });

  it('refuses to edit a non-text message', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-img', {type: 'image'});
    await runtime.sendMessageEdit({userId: BOB, deviceId: 1}, DM, 'msg-img', 'caption');

    expect(bus().wsSends).toHaveLength(0);
  });

  it('refuses to edit a target that is not in the store at all', async () => {
    seedDirect();
    await runtime.sendMessageEdit({userId: BOB, deviceId: 1}, DM, 'no-such-msg', 'ghost');
    expect(bus().wsSends).toHaveLength(0);
  });

  it('reconciles mentions against the EDITED body, dropping ones whose label is gone', async () => {
    seedGroup();
    seedOwnMessage(GID, 'gmsg-1');
    await runtime.sendMessageEdit(
      {userId: BOB, deviceId: 1}, GID, 'gmsg-1', 'hi @bobby only',
      [{userId: BOB, label: 'bobby'}, {userId: CAROL, label: 'carol'}],
    );

    const opened = await openAllSends();
    const edit = (opened[BOB].group as {edit: {mentions?: Array<{userId: string}>}}).edit;
    expect(edit.mentions).toEqual([{userId: BOB, label: 'bobby'}]);
    expect(rowIn(GID, 'gmsg-1')?.mentions).toEqual([{userId: BOB, label: 'bobby'}]);
  });
});

describe('sendDeleteForEveryone', () => {
  it('ships the deleteFor directive, retracts the relay copy and tombstones locally', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-1', {retract_token: 'tok-abc'});
    await runtime.sendDeleteForEveryone({userId: BOB, deviceId: 1}, DM, 'msg-1');

    const sealed = await openAs(BOB, bus().wsSends[0].data.outerSealed as string);
    const del = sealed.deleteFor as {targetMsgId: string; deletedAt: number};
    expect(del.targetMsgId).toBe('msg-1');
    expect(typeof del.deletedAt).toBe('number');

    // The only leg that can beat a recipient who has not drained yet.
    expect(bus().retracted).toEqual(['tok-abc']);

    const row = rowIn(DM, 'msg-1')!;
    expect(row.deleted_for_all).toBe(true);
    expect(row.content).toBe('');
  });

  it('WIRE-COMPAT — in a GROUP the deleteFor rides INSIDE the group stamp', async () => {
    seedGroup();
    seedOwnMessage(GID, 'gmsg-1');
    await runtime.sendDeleteForEveryone({userId: BOB, deviceId: 1}, GID, 'gmsg-1');

    const opened = await openAllSends();
    expect('deleteFor' in opened[CAROL]).toBe(false);
    expect((opened[CAROL].group as {deleteFor: {targetMsgId: string}}).deleteFor.targetMsgId)
      .toBe('gmsg-1');
  });

  it('refuses to delete a message we did not write', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-peer', {sender_id: BOB});
    await runtime.sendDeleteForEveryone({userId: BOB, deviceId: 1}, DM, 'msg-peer');

    expect(bus().wsSends).toHaveLength(0);
    expect(bus().retracted).toHaveLength(0);
    expect(rowIn(DM, 'msg-peer')?.deleted_for_all).toBeFalsy();
  });

  it('is idempotent — a second delete of an already-tombstoned row ships nothing', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-1', {retract_token: 'tok-abc'});
    await runtime.sendDeleteForEveryone({userId: BOB, deviceId: 1}, DM, 'msg-1');
    bus().wsSends.length = 0;
    bus().retracted.length = 0;

    await runtime.sendDeleteForEveryone({userId: BOB, deviceId: 1}, DM, 'msg-1');
    expect(bus().wsSends).toHaveLength(0);
    expect(bus().retracted).toHaveLength(0);
  });

  it('skips the relay retract when the message never got a retract token', async () => {
    seedDirect();
    seedOwnMessage(DM, 'msg-1');
    await runtime.sendDeleteForEveryone({userId: BOB, deviceId: 1}, DM, 'msg-1');

    expect(bus().wsSends).toHaveLength(1);
    expect(bus().retracted).toHaveLength(0);
    expect(rowIn(DM, 'msg-1')?.deleted_for_all).toBe(true);
  });
});
