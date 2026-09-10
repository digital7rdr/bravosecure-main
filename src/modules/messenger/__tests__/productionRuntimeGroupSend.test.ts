/**
 * productionRuntime — the GROUP fan-out send path, EXECUTED.
 *
 * Companion to `productionRuntimeDirectSend.test.ts`; see that file's header
 * for why a built-runtime suite exists at all and how the network edge is
 * mocked. This one owns the group lane, which is where the two worst message
 * bugs in the log were born:
 *
 *   B-124/B-125 — a 1:1 conversation was routed through the group fan-out
 *     because a throwaway call key had been aliased under its id. The wire got
 *     group-stamped with a device-local id (ghost threads on both ends) and the
 *     recipient list derived from the ghost row was empty, so the send threw
 *     and DESTROYED the user's typed text.
 *
 * Everything asserted below is read out of a real envelope: the group body is
 * AES-GCM-wrapped under the real master key by `groupEncrypt`, sealed
 * per-recipient, encrypted through a real libsignal ratchet and outer-ECIES
 * wrapped. The test unwraps all four layers.
 */

jest.mock('@bravo/messenger-core', () => {
  const actual = jest.requireActual('@bravo/messenger-core');
  const g = globalThis as unknown as {__prBus?: Record<string, unknown>};
  const bus = (g.__prBus = g.__prBus ?? {
    wsSends:    [] as unknown[],
    relaySends: [] as unknown[],
    bundles:    {} as Record<string, unknown>,
    relayThrow: null as string | null,
    certThrow:  false,
    onFrame:    null as unknown,
  }) as {
    wsSends: unknown[]; relaySends: unknown[]; bundles: Record<string, unknown>;
    relayThrow: string | null; certThrow: boolean; onFrame: unknown;
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
    send(req: {recipient: {userId: string}}) {
      if (bus.relayThrow) { return Promise.reject(new Error(bus.relayThrow)); }
      bus.relaySends.push(req);
      const n = bus.relaySends.length;
      return Promise.resolve({envelopeId: `env-${req.recipient.userId}`, retractToken: `rt-${n}`});
    }
    retract() { return Promise.resolve({retracted: true}); }
    pull() { return Promise.resolve({envelopes: []}); }
    ack() { return Promise.resolve({}); }
  }
  class FakeCertCache {
    get() {
      if (bus.certThrow) { return Promise.reject(new Error('sender-cert unavailable')); }
      return Promise.resolve({cert: 'TEST-CERT', expiresAt: Math.floor(Date.now() / 1000) + 3600});
    }
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

import {groupDecrypt} from '@bravo/messenger-core';
import {
  installIdentity,
  buildOwnPreKeyBundle,
  SessionManager,
  unwrapOuter,
  unsealPayload,
  type CryptoStore,
} from '../crypto';
import {InMemoryProtocolStore} from '../crypto/inMemoryStore';
import {GROUP_KEY_PENDING_SEND_ERROR} from '../runtime/messagingLogic';
import {useMessengerStore} from '../store/messengerStore';
import type {MessengerRuntime} from '../runtime/runtime';
import type {LocalMessage} from '../store/types';

jest.setTimeout(240_000);

const ALICE = 'alice-user-id';
const BOB   = 'bob-user-id';
const CAROL = 'carol-user-id';
const GID   = 'group-uuid-1';
const MASTER_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';   // 32 bytes

type Bus = {
  wsSends: Array<{event: string; data: Record<string, unknown>}>;
  relaySends: Array<{recipient: {userId: string; deviceId: number}; outerSealed: string;
                     clientMsgId: string; receipt?: boolean}>;
  bundles: Record<string, unknown>;
  relayThrow: string | null;
  certThrow: boolean;
  onFrame: ((f: unknown) => void) | null;
};
const bus = (): Bus => (globalThis as unknown as {__prBus: Bus}).__prBus;

let runtime: MessengerRuntime;
const peerStores: Record<string, CryptoStore> = {};

/** Peel all four layers of a group envelope exactly as that member's device would. */
async function openAsMember(userId: string, outerSealed: string): Promise<{
  sealed: Record<string, unknown>;
  inner:  Record<string, unknown>;
}> {
  const store = peerStores[userId];
  const id = await store.getIdentityKeyPair();
  const un = await unwrapOuter({
    ownIdentityPrivKey: id.privKey,
    ownIdentityPubKey:  id.pubKey,
    outerSealedB64:     outerSealed,
  });
  const plain = await new SessionManager(store).decrypt({userId: ALICE, deviceId: 1}, un.ciphertext);
  const sealed = unsealPayload(plain) as unknown as Record<string, unknown>;
  const inner = JSON.parse(
    await groupDecrypt(MASTER_KEY, JSON.parse(sealed.body as string)),
  ) as Record<string, unknown>;
  return {sealed, inner};
}

const msgsIn = (cid: string): LocalMessage[] =>
  useMessengerStore.getState().messages[cid] ?? [];

/** Seed a group conversation the server has already synced membership for. */
function seedGroup(participants: string[], opts: {masterKey?: string | null} = {}): void {
  useMessengerStore.getState().upsertConversation({
    id: GID,
    type: 'group',
    name: 'Ops Room',
    peer: {userId: participants[0] ?? ALICE, deviceId: 1},
    participants,
    session_state: 'established',
  } as never);
  if (opts.masterKey !== null) {
    useMessengerStore.setState({
      groups: {
        [GID]: {
          groupId: GID, name: 'Ops Room', owner: ALICE,
          members: Object.fromEntries(
            participants.map(u => [u, {deviceId: 1, admin: u === ALICE, joinedAt: 0}]),
          ),
          masterKeyB64: opts.masterKey ?? MASTER_KEY,
          epoch: 1, createdAt: 0, updatedAt: 0,
        } as never,
      },
    });
  }
}

/**
 * `runWithGroupAdminLock` evicts its Map entry with `void next.finally(...)`.
 * `.finally()` PROPAGATES a rejection, so whenever the work it guards throws —
 * which is exactly what the GF-5 fail-closed guard does — that derived promise
 * rejects with no handler attached. The real `next` IS awaited by the caller;
 * only the eviction shim leaks, and React Native merely warns on that, so it is
 * a wart rather than a bug and is not a test's business to fix.
 *
 * Jest is less forgiving: it registers its unhandled-rejection handler on the
 * WORKER process (out of reach of anything in this VM) and attributes a late
 * rejection to whichever test happens to be running when Node reports it, which
 * made this suite fail in a moving, order-dependent place. Attaching a no-op
 * catch AT CREATION means Node never flags the promise at all. Scoped to the
 * single call that provokes it and restored immediately.
 */
async function withoutFinallyLeak<T>(work: () => Promise<T>): Promise<T> {
  const proto = Promise.prototype as unknown as {finally: unknown};
  const original = proto.finally;
  proto.finally = function patched(this: Promise<unknown>, cb?: () => void) {
    const derived = (original as (cb?: () => void) => Promise<unknown>).call(this, cb);
    void derived.catch(() => { /* eviction shim — the real promise is awaited */ });
    return derived;
  };
  try {
    return await work();
  } finally {
    proto.finally = original;
  }
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
  b.relayThrow = null;
  b.certThrow = false;
  useMessengerStore.setState({messages: {}, conversations: {}, groups: {}});
});

describe('sendText group — fan-out and the wire envelope each member receives', () => {
  it('ships one HTTP envelope per OTHER member and never uses the WS lane', async () => {
    seedGroup([ALICE, BOB, CAROL]);
    await runtime.sendText(GID, 'ops broadcast', {});

    // The WS path flips to 'sent' on a pure buffered write with no ack, which
    // is why the group lane is HTTP-only.
    expect(bus().wsSends).toHaveLength(0);
    expect(bus().relaySends.map(r => r.recipient.userId).sort()).toEqual([BOB, CAROL].sort());
    // Self is never a fan-out recipient.
    expect(bus().relaySends.some(r => r.recipient.userId === ALICE)).toBe(false);
    // OM-03 — no live submitter mapping on this lane, so the receipt slot is
    // the only way the bubble ever leaves a single tick.
    expect(bus().relaySends.every(r => r.receipt === true)).toBe(true);
  });

  it('wraps the body under the group master key and stamps group addressing (M9)', async () => {
    seedGroup([ALICE, BOB, CAROL]);
    await runtime.sendText(GID, 'master-key wrapped', {});

    const leg = bus().relaySends.find(r => r.recipient.userId === BOB)!;
    const {sealed, inner} = await openAsMember(BOB, leg.outerSealed);

    // GF-5 — the sealed body must be the AES-GCM group ciphertext, never the
    // unwrapped plaintext fallback (the receive side classifies that shape as
    // a downgrade and drops it).
    expect(sealed.body).not.toContain('master-key wrapped');
    expect(inner.body).toBe('master-key wrapped');
    expect(inner.groupId).toBe(GID);
    expect(inner.kind).toBe('text');

    const grp = sealed.group as Record<string, unknown>;
    expect(grp.groupId).toBe(GID);
    expect(grp.kind).toBe('text');
  });

  it('uses the local bubble id as the wire clientMsgId on every leg (BS-REACT-AUTHOR)', async () => {
    seedGroup([ALICE, BOB, CAROL]);
    await runtime.sendText(GID, 'reactable', {});

    const bubbleId = msgsIn(GID)[0].id;
    expect(bus().relaySends.map(r => r.clientMsgId)).toEqual([bubbleId, bubbleId]);
    const {sealed, inner} = await openAsMember(CAROL, bus().relaySends
      .find(r => r.recipient.userId === CAROL)!.outerSealed);
    expect((sealed.group as {clientMsgId: string}).clientMsgId).toBe(bubbleId);
    expect(inner.clientMsgId).toBe(bubbleId);
  });

  it('binds each leg to ITS OWN recipient in the aad while sharing one group body (Round 5 / S1)', async () => {
    seedGroup([ALICE, BOB, CAROL]);
    await runtime.sendText(GID, 'per-recipient aad', {});

    const bobLeg   = bus().relaySends.find(r => r.recipient.userId === BOB)!;
    const carolLeg = bus().relaySends.find(r => r.recipient.userId === CAROL)!;
    const bobSealed   = (await openAsMember(BOB, bobLeg.outerSealed)).sealed;
    const carolSealed = (await openAsMember(CAROL, carolLeg.outerSealed)).sealed;

    expect((bobSealed.aad as {to: unknown}).to).toEqual({userId: BOB, deviceId: 1});
    expect((carolSealed.aad as {to: unknown}).to).toEqual({userId: CAROL, deviceId: 1});
    // P0-N2 — group ciphertext cannot be replayed into another thread.
    expect((bobSealed.aad as {groupId: string}).groupId).toBe(GID);
    expect((bobSealed.aad as {conversationId: string}).conversationId).toBe(GID);
    expect((bobSealed.aad as {sender: unknown}).sender).toEqual({userId: ALICE, deviceId: 1});
    // ONE group-encrypted body shared across legs; only the outer wrap repeats.
    expect(bobSealed.body).toBe(carolSealed.body);
  });

  it('carries mentions INSIDE the group block, never as a top-level key', async () => {
    seedGroup([ALICE, BOB, CAROL]);
    await runtime.sendText(GID, 'ping @bobby now', {
      mentions: [{userId: BOB, label: 'bobby'}],
    });

    const {sealed} = await openAsMember(BOB, bus().relaySends.find(r => r.recipient.userId === BOB)!.outerSealed);
    // A top-level `mentions` key is rejected outright by clients built before
    // the field existed, which DESTROYED the message on arrival.
    expect('mentions' in sealed).toBe(false);
    expect((sealed.group as {mentions: unknown}).mentions).toEqual([{userId: BOB, label: 'bobby'}]);
  });

  it('drops a mention whose label the user deleted from the body before sending', async () => {
    seedGroup([ALICE, BOB, CAROL]);
    await runtime.sendText(GID, 'never mind', {
      mentions: [{userId: BOB, label: 'bobby'}],
    });

    const {sealed} = await openAsMember(BOB, bus().relaySends.find(r => r.recipient.userId === BOB)!.outerSealed);
    expect((sealed.group as Record<string, unknown>).mentions).toBeUndefined();
    expect(msgsIn(GID)[0].mentions).toBeUndefined();
  });

  it('B-271 — expands @all into the per-member list the recipients actually need', async () => {
    seedGroup([ALICE, BOB, CAROL]);
    await runtime.sendText(GID, 'heads up @all', {
      mentions: [{userId: '*all*', label: 'all'}],
    });

    const {sealed} = await openAsMember(BOB, bus().relaySends.find(r => r.recipient.userId === BOB)!.outerSealed);
    const mentions = (sealed.group as {mentions: Array<{userId: string}>}).mentions;
    // The sentinel must never reach the wire, and self is never mentioned.
    expect(mentions.map(m => m.userId).sort()).toEqual([BOB, CAROL].sort());
    expect(mentions.some(m => m.userId === '*all*')).toBe(false);
    expect(mentions.some(m => m.userId === ALICE)).toBe(false);
  });

  it('carries replyTo and the forwarded flag through the group lane (B-144 / MM-09)', async () => {
    seedGroup([ALICE, BOB, CAROL]);
    await runtime.sendText(GID, 'quoted + forwarded', {
      replyTo: {messageId: 'orig-1', preview: 'the original'},
      isForwarded: true,
    });

    const {sealed} = await openAsMember(BOB, bus().relaySends.find(r => r.recipient.userId === BOB)!.outerSealed);
    expect(sealed.replyTo).toEqual({msgId: 'orig-1', preview: 'the original'});
    // MM-09 — the group lane must carry isForwarded INSIDE `group`; a new
    // top-level key is fatal to peers predating its allowlist entry.
    expect('isForwarded' in sealed).toBe(false);
    expect((sealed.group as {isForwarded: boolean}).isForwarded).toBe(true);
  });

  it('records a per-recipient envelopeId and retract token on the bubble (SYNC-1 / B-187)', async () => {
    seedGroup([ALICE, BOB, CAROL]);
    await runtime.sendText(GID, 'receipted', {});

    const bubble = msgsIn(GID)[0];
    expect(bubble.status).toBe('sent');
    // Keeping only the first leg's id made every OTHER member's read receipt
    // unmatchable, so the "all participants read" aggregate never completed.
    expect(bubble.envelope_ids?.[BOB]).toBe(`env-${BOB}`);
    expect(bubble.envelope_ids?.[CAROL]).toBe(`env-${CAROL}`);
    expect(bubble.retract_token).toBeDefined();
  });
});

describe('sendText group — guards (the B-125 contract: a guard must never eat the text)', () => {
  it('leaves a retryable `failed` bubble when the group row has no other members', async () => {
    seedGroup([ALICE]);
    await expect(runtime.sendText(GID, 'nobody to send to', {}))
      .rejects.toThrow(/no other members to send to/);

    const bubble = msgsIn(GID)[0];
    expect(bubble).toBeDefined();
    expect(bubble.content).toBe('nobody to send to');
    expect(bubble.status).toBe('failed');
    expect(bus().relaySends).toHaveLength(0);
  });

  it('refuses a fan-out above the 250-recipient cap without losing the text (Security S5)', async () => {
    seedGroup([ALICE, ...Array.from({length: 251}, (_, i) => `member-${i}`)]);
    await expect(runtime.sendText(GID, 'too many', {}))
      .rejects.toThrow(/group too large to send \(251 > 250 recipients\)/);

    expect(msgsIn(GID)[0].status).toBe('failed');
    expect(msgsIn(GID)[0].content).toBe('too many');
    expect(bus().relaySends).toHaveLength(0);
  });

  it('accepts a fan-out exactly AT the 250 cap (off-by-one guard)', async () => {
    seedGroup([ALICE, ...Array.from({length: 250}, (_, i) => `member-${i}`)]);
    // Every member is unprovisioned so no envelope ships, but the cap itself
    // must not reject: the error, if any, must not be the size error.
    await expect(runtime.sendText(GID, 'exactly at the cap', {}))
      .resolves.toBeUndefined();
    expect(msgsIn(GID)[0].status).not.toBe('failed');
  });

  it('GF-5 — fails closed with the key-pending error when the master key is missing', async () => {
    seedGroup([ALICE, BOB, CAROL], {masterKey: ''});
    await withoutFinallyLeak(async () => {
      await expect(runtime.sendText(GID, 'no key yet', {}))
        .rejects.toThrow(GROUP_KEY_PENDING_SEND_ERROR);
    });

    // The unwrapped fallback would be classified as a downgrade by the
    // receiver, so nothing may go out at all.
    expect(bus().relaySends).toHaveLength(0);
    expect(msgsIn(GID)[0].status).toBe('failed');
    expect(msgsIn(GID)[0].content).toBe('no key yet');
  });

  it('refuses an over-long group message without losing the text', async () => {
    seedGroup([ALICE, BOB, CAROL]);
    const huge = 'y'.repeat(65_537);
    await expect(runtime.sendText(GID, huge, {})).rejects.toThrow(/message too long to send/);
    expect(msgsIn(GID)[0].status).toBe('failed');
    expect(bus().relaySends).toHaveLength(0);
  });

  it('parks the bubble in `sending` (never `failed`, never a throw) when NO peer was reachable', async () => {
    seedGroup([ALICE, BOB, CAROL]);
    bus().relayThrow = 'network unreachable';

    // A dept-channel post where every member is offline must stay queued, not
    // hard-throw: the bubble is the durable record the drain re-ships from.
    await expect(runtime.sendText(GID, 'everyone offline', {})).resolves.toBeUndefined();

    const bubble = msgsIn(GID)[0];
    expect(bubble.status).toBe('sending');
    expect(bubble.content).toBe('everyone offline');
  });

  it('flips to `sent` when at least ONE leg lands, even though another member is unprovisioned', async () => {
    seedGroup([ALICE, BOB, 'unprovisioned-member']);
    await runtime.sendText(GID, 'partial delivery', {});

    expect(bus().relaySends.map(r => r.recipient.userId)).toEqual([BOB]);
    expect(msgsIn(GID)[0].status).toBe('sent');
  });

  it('flips the bubble to `failed` when the sender cert cannot be issued and no outbox exists', async () => {
    seedGroup([ALICE, BOB, CAROL]);
    bus().certThrow = true;
    await expect(runtime.sendText(GID, 'cert cold', {})).rejects.toThrow(/sender-cert unavailable/);

    expect(msgsIn(GID)[0].status).toBe('failed');
    expect(msgsIn(GID)[0].content).toBe('cert cold');
    expect(bus().relaySends).toHaveLength(0);
  });

  it('treats an `ops_channel` conversation as a group even without local group members', async () => {
    useMessengerStore.getState().upsertConversation({
      id: GID, type: 'ops_channel', name: 'Dept', peer: {userId: BOB, deviceId: 1},
      participants: [ALICE, BOB], session_state: 'established',
    } as never);
    useMessengerStore.setState({
      groups: {[GID]: {
        groupId: GID, name: 'Dept', owner: ALICE,
        members: {[ALICE]: {deviceId: 1, admin: true, joinedAt: 0}},
        masterKeyB64: MASTER_KEY, epoch: 1, createdAt: 0, updatedAt: 0,
      } as never},
    });

    await runtime.sendText(GID, 'dept post', {});
    const {sealed} = await openAsMember(BOB, bus().relaySends.find(r => r.recipient.userId === BOB)!.outerSealed);
    expect((sealed.group as {groupId: string}).groupId).toBe(GID);
  });
});
