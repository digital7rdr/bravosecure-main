/**
 * productionRuntime — the 1:1 SEND path, EXECUTED.
 *
 * `productionRuntime.ts` is the most-churned file in the repo and until the
 * import wall came down nothing could `require()` it, so ~50 suites "covered"
 * it by regexing its source as text. Text cannot catch a wrong value: B-125
 * (CRITICAL data loss) shipped on a fully green run.
 *
 * This suite builds a REAL runtime — real `SessionManager`, real X3DH, real
 * sealed-sender + outer ECIES — against an `InMemoryProtocolStore`, and mocks
 * only the network edge (`TransportClient` / `RelayHttpClient` /
 * `KeysHttpClient` / `SenderCertCache` come from `@bravo/messenger-core`, so
 * one in-file `jest.mock` factory replaces exactly those and passes everything
 * else through with `requireActual`).
 *
 * Because the store is NOT a `SqlCipherProtocolStore`, `buildProductionRuntime`
 * skips its whole SQLCipher block and `sqlOutbox` stays null. That is not a
 * limitation here — it is the "no durable queue" arm of every send branch, the
 * one where the bubble state is the ONLY thing standing between the user and a
 * lost message. Those are exactly the B-125 branches.
 *
 * The peer (Bob) gets his own store and bundle, so every envelope this suite
 * asserts on is genuinely decryptable: we unwrap it, run it through Bob's
 * ratchet and read the sealed payload. That is what makes the aad assertions
 * real rather than a restatement of the implementation.
 */

jest.mock('@bravo/messenger-core', () => {
  const actual = jest.requireActual('@bravo/messenger-core');
  const g = globalThis as unknown as {__prBus?: Record<string, unknown>};
  const bus = (g.__prBus = g.__prBus ?? {
    wsSends:    [] as unknown[],
    relaySends: [] as unknown[],
    bundles:    {} as Record<string, unknown>,
    wsThrow:    false,
    relayThrow: null as string | null,
    certThrow:  false,
    onFrame:    null as unknown,
  }) as {
    wsSends: unknown[]; relaySends: unknown[]; bundles: Record<string, unknown>;
    wsThrow: boolean; relayThrow: string | null; certThrow: boolean; onFrame: unknown;
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
      // Only envelope submits are interesting; the runtime also pushes 4s
      // heartbeat pings and presence frames down this same call.
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
    send(req: {clientMsgId: string}) {
      if (bus.relayThrow) { return Promise.reject(new Error(bus.relayThrow)); }
      bus.relaySends.push(req);
      return Promise.resolve({
        envelopeId:   'env-' + bus.relaySends.length,
        retractToken: 'rt-' + bus.relaySends.length,
      });
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

import {
  installIdentity,
  buildOwnPreKeyBundle,
  SessionManager,
  unwrapOuter,
  unsealPayload,
  type CryptoStore,
} from '../crypto';
import {InMemoryProtocolStore} from '../crypto/inMemoryStore';
import {directConvoAadId} from '../runtime/aadBinding';
import {useMessengerStore} from '../store/messengerStore';
import type {MessengerRuntime} from '../runtime/runtime';
import type {LocalMessage} from '../store/types';

jest.setTimeout(180_000);

const ALICE = 'alice-user-id';
const BOB   = 'bob-user-id';

type Bus = {
  wsSends: Array<{event: string; data: Record<string, unknown>}>;
  relaySends: Array<Record<string, unknown>>;
  bundles: Record<string, unknown>;
  wsThrow: boolean;
  relayThrow: string | null;
  certThrow: boolean;
  onFrame: ((f: unknown) => void) | null;
};
const bus = (): Bus => (globalThis as unknown as {__prBus: Bus}).__prBus;

let runtime: MessengerRuntime;
let aliceStore: CryptoStore;
let bobStore: CryptoStore;

/** Decrypt an outbound envelope exactly as Bob's device would. */
/** Poll until `pred` holds, or throw at the ceiling. Keeps the ack-watchdog
 *  tests honest without paying a fixed sleep on every crypto-project run. */
async function waitFor(pred: () => boolean, ceilingMs: number): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ceilingMs) {throw new Error('waitFor: condition never held');}
    await new Promise(r => setTimeout(r, 25));
  }
}

async function openAsBob(outerSealed: string): Promise<Record<string, unknown>> {
  const id = await bobStore.getIdentityKeyPair();
  const un = await unwrapOuter({
    ownIdentityPrivKey: id.privKey,
    ownIdentityPubKey:  id.pubKey,
    outerSealedB64:     outerSealed,
  });
  const bob = new SessionManager(bobStore);
  const plain = await bob.decrypt({userId: ALICE, deviceId: 1}, un.ciphertext);
  return unsealPayload(plain) as unknown as Record<string, unknown>;
}

const msgsIn = (cid: string): LocalMessage[] =>
  useMessengerStore.getState().messages[cid] ?? [];

beforeAll(async () => {
  aliceStore = new InMemoryProtocolStore();
  bobStore   = new InMemoryProtocolStore();
  await installIdentity(bobStore, {preKeyCount: 6});
  bus().bundles[BOB] = await buildOwnPreKeyBundle(bobStore, {userId: BOB, deviceId: 1}, 1, 1);

  const {buildProductionRuntime} = require('../runtime/productionRuntime') as
    typeof import('../runtime/productionRuntime');
  runtime = await buildProductionRuntime({
    ownStore: aliceStore,
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
  b.wsThrow = false;
  b.relayThrow = null;
  b.certThrow = false;
  useMessengerStore.setState({messages: {}, conversations: {}, groups: {}});
});

// Every WS submit arms a 5s ack watchdog that re-ships over HTTP. Left armed,
// it fires INTO A LATER TEST and pollutes its relay capture. Acking each
// submit disarms its timer through the runtime's own handleAccepted path
// (`entry.ackTimer` clearTimeout) rather than by reaching into jest timers.
afterEach(() => {
  const b = bus();
  for (const frame of b.wsSends) {
    b.onFrame?.({
      event: 'envelope.accepted',
      data:  {clientMsgId: frame.data.clientMsgId, envelopeId: 'flush'},
    });
  }
});

describe('sendText 1:1 — the wire envelope Bob actually receives', () => {
  it('seals the body under a real ratchet and stamps the P0-N2 aad block', async () => {
    const cid = `direct:${BOB}`;
    await runtime.sendText(cid, 'hello over the wire', {peer: {userId: BOB, deviceId: 1}});

    expect(bus().wsSends).toHaveLength(1);
    const frame = bus().wsSends[0];
    expect(frame.event).toBe('envelope.send');

    const sealed = await openAsBob(frame.data.outerSealed as string);
    expect(sealed.body).toBe('hello over the wire');

    const aad = sealed.aad as Record<string, unknown>;
    expect(aad).toBeDefined();
    expect(aad.to).toEqual({userId: BOB, deviceId: 1});
    expect(aad.sender).toEqual({userId: ALICE, deviceId: 1});
    expect(typeof aad.ts).toBe('number');
    // P0-N2-follow-up: the aad conversationId must be the ORDER-INDEPENDENT
    // pair id, not either side's local UI key — asymmetry made verifySealedAad
    // reject every 1:1 message with `conversation_mismatch`.
    expect(aad.conversationId).toBe(directConvoAadId(ALICE, BOB));
    expect(aad.conversationId).toBe(directConvoAadId(BOB, ALICE));
    expect(aad.conversationId).not.toBe(cid);
    // 1:1 must never carry group addressing — that stamp is what routes a
    // message into a group thread on the receiver (B-124).
    expect(sealed.group).toBeUndefined();
  });

  it('ships the wire clientMsgId as the local bubble id so reactions/replies match (BS-REACT-AUTHOR)', async () => {
    const cid = `direct:${BOB}`;
    await runtime.sendText(cid, 'anchor', {peer: {userId: BOB, deviceId: 1}});

    const bubble = msgsIn(cid)[0];
    expect(bubble).toBeDefined();
    expect(bus().wsSends[0].data.clientMsgId).toBe(bubble.id);
    const sealed = await openAsBob(bus().wsSends[0].data.outerSealed as string);
    expect(sealed.clientMsgId).toBe(bubble.id);
  });

  it('carries replyTo on the wire and on the bubble (B-144)', async () => {
    const cid = `direct:${BOB}`;
    await runtime.sendText(cid, 'quoting you', {
      peer: {userId: BOB, deviceId: 1},
      replyTo: {messageId: 'target-123', preview: 'the original'},
    });

    const sealed = await openAsBob(bus().wsSends[0].data.outerSealed as string);
    expect(sealed.replyTo).toEqual({msgId: 'target-123', preview: 'the original'});
    const bubble = msgsIn(cid)[0];
    expect(bubble.reply_to_msg_id).toBe('target-123');
    expect(bubble.reply_to_preview).toBe('the original');
  });

  it('survives a reply whose preview is undefined instead of crashing on .slice()', async () => {
    const cid = `direct:${BOB}`;
    await expect(
      runtime.sendText(cid, 'reply to a media-only message', {
        peer: {userId: BOB, deviceId: 1},
        replyTo: {messageId: 'media-only'} as {messageId: string; preview?: string},
      }),
    ).resolves.toBeUndefined();

    const sealed = await openAsBob(bus().wsSends[0].data.outerSealed as string);
    expect(sealed.replyTo).toEqual({msgId: 'media-only', preview: ''});
  });

  it('emits isForwarded at the TOP level on the 1:1 lane only (MM-09 wire-compat)', async () => {
    const cid = `direct:${BOB}`;
    await runtime.sendText(cid, 'fwd', {peer: {userId: BOB, deviceId: 1}, isForwarded: true});

    const sealed = await openAsBob(bus().wsSends[0].data.outerSealed as string);
    expect(sealed.isForwarded).toBe(true);
    expect(msgsIn(cid)[0].is_forwarded).toBe(true);
  });

  it('omits isForwarded entirely when the flag is false (never ships `false`)', async () => {
    const cid = `direct:${BOB}`;
    await runtime.sendText(cid, 'plain', {peer: {userId: BOB, deviceId: 1}, isForwarded: false});

    const sealed = await openAsBob(bus().wsSends[0].data.outerSealed as string);
    expect('isForwarded' in sealed).toBe(false);
    expect(msgsIn(cid)[0].is_forwarded).toBeUndefined();
  });

  it('never puts a top-level `mentions` key on a 1:1 envelope (fatal to older peers)', async () => {
    const cid = `direct:${BOB}`;
    await runtime.sendText(cid, 'hi @bob', {
      peer: {userId: BOB, deviceId: 1},
      mentions: [{userId: BOB, label: 'bob'}],
    });

    const sealed = await openAsBob(bus().wsSends[0].data.outerSealed as string);
    expect('mentions' in sealed).toBe(false);
  });

  it('propagates ttlSeconds as an epoch-seconds expiry on both wire and bubble', async () => {
    const cid = `direct:${BOB}`;
    const before = Math.floor(Date.now() / 1000);
    await runtime.sendText(cid, 'burn me', {peer: {userId: BOB, deviceId: 1}, ttlSeconds: 60});

    const sealed = await openAsBob(bus().wsSends[0].data.outerSealed as string);
    const exp = sealed.expiresAtSec as number;
    expect(exp).toBeGreaterThanOrEqual(before + 60);
    expect(exp).toBeLessThanOrEqual(before + 62);
    expect(msgsIn(cid)[0].expires_at).toBe(exp * 1000);
  });
});

describe('sendText 1:1 — bubble lifecycle (the B-125 contract: the text always survives)', () => {
  it('leaves the bubble in `sending` after a WS submit — single tick means "server has it"', async () => {
    const cid = `direct:${BOB}`;
    await runtime.sendText(cid, 'unacked', {peer: {userId: BOB, deviceId: 1}});

    expect(msgsIn(cid)[0].status).toBe('sending');
    expect(bus().relaySends).toHaveLength(0);

    // Draining the pending entry also disarms its 5s ack watchdog, so the
    // timer cannot fire into a later test.
    const wireId = bus().wsSends[0].data.clientMsgId as string;
    bus().onFrame?.({
      event: 'envelope.accepted',
      data:  {clientMsgId: wireId, envelopeId: 'srv-env-1', retractToken: 'srv-tok-1'},
    });
    const acked = msgsIn(cid)[0];
    expect(acked.status).toBe('sent');
    expect(acked.envelope_id).toBe('srv-env-1');
  });

  it('falls back to HTTP when the socket throws, and only THAT path flips to `sent` synchronously', async () => {
    bus().wsThrow = true;
    const cid = `direct:${BOB}`;
    await runtime.sendText(cid, 'over http', {peer: {userId: BOB, deviceId: 1}});

    expect(bus().wsSends).toHaveLength(0);
    expect(bus().relaySends).toHaveLength(1);
    // OM-03 — the HTTP lane has no live submitter mapping, so it must park the
    // anonymous receipt slot or the bubble can never leave a single tick.
    expect(bus().relaySends[0].receipt).toBe(true);

    const bubble = msgsIn(cid)[0];
    expect(bubble.status).toBe('sent');
    expect(bubble.envelope_id).toBe('env-1');
    expect(bubble.retract_token).toBe('rt-1');
  });

  it('keeps the typed text as a `failed` bubble when there is no peer to send to', async () => {
    const cid = 'server-uuid-with-no-peer';
    await expect(runtime.sendText(cid, 'do not lose me', {}))
      .rejects.toThrow(/requires explicit peer address/);

    const bubble = msgsIn(cid)[0];
    expect(bubble).toBeDefined();
    expect(bubble.content).toBe('do not lose me');
    expect(bubble.status).toBe('failed');
  });

  it('keeps the typed text as a `failed` bubble when the message exceeds the 65536-char cap', async () => {
    const cid = `direct:${BOB}`;
    const huge = 'x'.repeat(65_537);
    await expect(runtime.sendText(cid, huge, {peer: {userId: BOB, deviceId: 1}}))
      .rejects.toThrow(/message too long to send/);

    expect(msgsIn(cid)[0].status).toBe('failed');
    expect(msgsIn(cid)[0].content).toBe(huge);
    expect(bus().wsSends).toHaveLength(0);
  });

  it('keeps the typed text as a `failed` bubble when the sender cert cannot be issued and no outbox exists', async () => {
    bus().certThrow = true;
    const cid = `direct:${BOB}`;
    await expect(runtime.sendText(cid, 'offline compose', {peer: {userId: BOB, deviceId: 1}}))
      .rejects.toThrow(/sender-cert unavailable/);

    const bubble = msgsIn(cid)[0];
    expect(bubble.content).toBe('offline compose');
    expect(bubble.status).toBe('failed');
    expect(bus().wsSends).toHaveLength(0);
  });

  it('keeps the typed text as a `failed` bubble when the peer has no published bundle', async () => {
    const cid = 'direct:ghost-user';
    await expect(runtime.sendText(cid, 'first contact', {peer: {userId: 'ghost-user', deviceId: 1}}))
      .rejects.toThrow(/no bundle for ghost-user/);

    expect(msgsIn(cid)[0].status).toBe('failed');
    expect(msgsIn(cid)[0].content).toBe('first contact');
  });

  it('flips the bubble to `failed` when both WS and the HTTP fallback are down', async () => {
    bus().wsThrow = true;
    bus().relayThrow = 'relay 500';
    const cid = `direct:${BOB}`;
    await expect(runtime.sendText(cid, 'nowhere to go', {peer: {userId: BOB, deviceId: 1}}))
      .rejects.toThrow(/relay 500/);

    expect(msgsIn(cid)[0].status).toBe('failed');
    expect(msgsIn(cid)[0].content).toBe('nowhere to go');
  });

  it('B-703 MR-4 — an accept landing DURING the HTTP retry is not overwritten by the retry failure', async () => {
    const cid = `direct:${BOB}`;
    await runtime.sendText(cid, 'accepted mid-retry', {peer: {userId: BOB, deviceId: 1}});
    expect(msgsIn(cid)[0].status).toBe('sending');
    const wireId = bus().wsSends[0].data.clientMsgId as string;

    // The relay is down by the time the ack watchdog gives up, so its HTTP
    // retry will fail.
    bus().relayThrow = 'relay 503 mid-retry';

    // The watchdog's own log line is a synchronous hook that fires AFTER its
    // "already sent?" pre-check and BEFORE it starts httpFallback() — exactly
    // the window the race needs, with no timer or microtask racing.
    const warn = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('WS ack timeout')) {
        bus().onFrame?.({
          event: 'envelope.accepted',
          data:  {clientMsgId: wireId, envelopeId: 'srv-env-late', retractToken: 'srv-tok-late'},
        });
      }
    });
    try {
      // The RTT registry resolves but has no published RTT (no pongs), so the
      // deadline is the 2.5 s floor. Poll rather than sleeping a fixed 5 s: the
      // whole crypto project pays this wall clock on every run.
      await waitFor(() => msgsIn(cid)[0].status !== 'sending', 8_000);
    } finally {
      warn.mockRestore();
    }

    const bubble = msgsIn(cid)[0];
    // Pre-fix this read 'failed': the accept deleted the pending entry and
    // recorded the envelope id, then the retry's catch stamped over it. The
    // chip that produced is also what mints a fresh wire id on tap, so the
    // recipient would receive the message twice.
    expect(bubble.status).toBe('sent');
    expect(bubble.envelope_id).toBe('srv-env-late');
    expect(bubble.content).toBe('accepted mid-retry');
  }, 30_000);

  it('B-703 MR-4 (critic L1) — a RETRY that genuinely fails still reports failure, stale artifact and all', async () => {
    const cid = `direct:${BOB}`;
    // Round 1 goes out over HTTP and is accepted, so the bubble carries
    // env-1 / rt-1. The 1:1 retry lane deliberately KEEPS those artifacts
    // (only the group lane calls resetWireArtifactsForResend), so round 2
    // starts with someone else's proof of delivery already on the row.
    bus().wsThrow = true;
    await runtime.sendText(cid, 'round one', {peer: {userId: BOB, deviceId: 1}});
    const round1 = msgsIn(cid)[0];
    expect(round1.status).toBe('sent');
    expect(round1.envelope_id).toBe('env-1');

    // Now the retry: everything is down.
    bus().relayThrow = 'relay 500 on the retry';
    await expect(runtime.sendText(cid, 'round one', {
      peer: {userId: BOB, deviceId: 1}, existingMsgId: round1.id,
    })).rejects.toThrow(/relay 500/);

    // An artifact-only guard would have returned early here and left the
    // bubble at 'sending' — no chip, no banner, and with no durable outbox
    // behind it (this harness's arm), the message simply disappears.
    const after = msgsIn(cid)[0];
    expect(after.status).toBe('failed');
    expect(after.content).toBe('round one');
  }, 30_000);

  it('B-703 MR-4 (critic L2) — a status-only accept mid-retry is honoured too', async () => {
    const cid = `direct:${BOB}`;
    await runtime.sendText(cid, 'status only', {peer: {userId: BOB, deviceId: 1}});
    const wireId = bus().wsSends[0].data.clientMsgId as string;
    bus().relayThrow = 'relay 503 status-only';

    // The accept carries NO envelopeId/retractToken, so only the status half of
    // the shared rule can see it. Swapping the call site back to an
    // artifact-only test passes every other case but fails this one.
    const warn = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('WS ack timeout')) {
        bus().onFrame?.({event: 'envelope.accepted', data: {clientMsgId: wireId}});
      }
    });
    try {
      await waitFor(() => msgsIn(cid)[0].status !== 'sending', 8_000);
    } finally {
      warn.mockRestore();
    }

    expect(msgsIn(cid)[0].status).toBe('sent');
  }, 30_000);

  it('appends exactly one bubble and reuses it when sendMedia hands over an existingMsgId (P2-12)', async () => {
    const cid = `direct:${BOB}`;
    bus().wsThrow = true;
    useMessengerStore.getState().appendMessage(cid, {
      id: 'preexisting-bubble',
      conversation_id: cid,
      sender_id: 'self',
      type: 'text',
      content: 'caption',
      status: 'sending',
      is_encrypted: true,
      created_at: new Date().toISOString(),
      peer: {userId: BOB, deviceId: 1},
    } as LocalMessage);

    await runtime.sendText(cid, 'caption', {
      peer: {userId: BOB, deviceId: 1},
      existingMsgId: 'preexisting-bubble',
    });

    expect(msgsIn(cid)).toHaveLength(1);
    expect(msgsIn(cid)[0].id).toBe('preexisting-bubble');
    expect(msgsIn(cid)[0].status).toBe('sent');
  });
});

describe('sendText 1:1 — peer derivation and conversation routing', () => {
  it('derives the peer from a `direct:<uid>` id when the caller has none (B-364)', async () => {
    const cid = `direct:${BOB}`;
    await runtime.sendText(cid, 'from a notification action', {});

    expect(bus().wsSends).toHaveLength(1);
    expect(msgsIn(cid)[0].peer).toEqual({userId: BOB, deviceId: 1});
    const sealed = await openAsBob(bus().wsSends[0].data.outerSealed as string);
    expect((sealed.aad as {to: unknown}).to).toEqual({userId: BOB, deviceId: 1});
  });

  it('derives the peer from a server-UUID conversation row when the caller has none (B-364)', async () => {
    const cid = 'server-uuid-1';
    useMessengerStore.getState().upsertConversation({
      id: cid,
      type: 'direct',
      peer: {userId: BOB, deviceId: 1},
      participants: [ALICE, BOB],
      session_state: 'established',
    } as never);

    await runtime.sendText(cid, 'resolved from the row', {});
    expect(bus().wsSends).toHaveLength(1);
    expect(msgsIn(cid)[0].peer).toEqual({userId: BOB, deviceId: 1});
  });

  it('canonicalises `direct:<uid>` onto the server-UUID slot the ChatScreen subscribes to', async () => {
    const canonical = 'server-uuid-2';
    useMessengerStore.getState().upsertConversation({
      id: canonical,
      type: 'direct',
      peer: {userId: BOB, deviceId: 1},
      participants: [ALICE, BOB],
      session_state: 'established',
    } as never);

    await runtime.sendText(`direct:${BOB}`, 'lands in the canonical slot', {
      peer: {userId: BOB, deviceId: 1},
    });

    expect(msgsIn(canonical)).toHaveLength(1);
    expect(msgsIn(`direct:${BOB}`)).toHaveLength(0);
  });

  it('M2/B-124 — a `direct:` id never takes the group lane even with a group key aliased under it', async () => {
    const cid = `direct:${BOB}`;
    // Exactly the 1:1→group-call escalation shape: ensureCallGroupKey files a
    // throwaway 'Call' key under the real 1:1 conversation id.
    useMessengerStore.setState({
      groups: {
        [cid]: {
          groupId: cid, name: 'Call', owner: ALICE,
          members: {[ALICE]: {deviceId: 1, admin: true, joinedAt: 0},
                    [BOB]:   {deviceId: 1, admin: false, joinedAt: 0}},
          masterKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          epoch: 1, createdAt: 0, updatedAt: 0,
        } as never,
      },
    });

    await runtime.sendText(cid, 'still a 1:1', {peer: {userId: BOB, deviceId: 1}});

    const sealed = await openAsBob(bus().wsSends[0].data.outerSealed as string);
    expect(sealed.group).toBeUndefined();
    expect(sealed.body).toBe('still a 1:1');
  });

  it('B-124 — a `type: "direct"` row is not group-routed even when participants.length > 1', async () => {
    const cid = 'server-uuid-3';
    useMessengerStore.getState().upsertConversation({
      id: cid,
      type: 'direct',
      peer: {userId: BOB, deviceId: 1},
      participants: [ALICE, BOB],
      session_state: 'established',
    } as never);

    await runtime.sendText(cid, 'two participants, still direct', {peer: {userId: BOB, deviceId: 1}});

    const sealed = await openAsBob(bus().wsSends[0].data.outerSealed as string);
    expect(sealed.group).toBeUndefined();
  });
});
