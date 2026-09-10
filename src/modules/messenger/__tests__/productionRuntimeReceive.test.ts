/**
 * productionRuntime — THE RECEIVE SIDE, EXECUTED.
 *
 * `doHandleIncoming` is the funnel every inbound message goes through:
 * ratchet decrypt → sealed unseal → sender-cert admission → sealed-AAD
 * binding → expiry gate → control routing → group-vs-direct routing →
 * store append. B-124 (duplicate/junk chat threads) and B-125 (CRITICAL
 * data loss) both shipped through a fully green suite because NOTHING
 * could execute this file — every "test" of it was a regex over its
 * source text.
 *
 * This suite runs the real thing. The only fakes are the network edges
 * (WS transport, relay/keys/cert HTTP clients); libsignal, the sealed-
 * sender envelope, the XEd25519 sender cert, the AAD binding and the
 * Zustand store are all REAL, and every message here is genuinely X3DH'd
 * and double-ratcheted from a second party.
 *
 * Two seams are exercised, because they carry different information:
 *
 *   1. `runtime.processIncoming(_, peer, ct)` — the inline decode path.
 *      No envelopeId, so it isolates doHandleIncoming's own decisions.
 *   2. `transport.onFrame({event: 'envelope.deliver', ...})` — the real
 *      WebSocket frame path, which additionally pins the ACK DISPOSITION
 *      ('delivered' vs 'discarded' vs no-ack-at-all). That single bit is
 *      the difference between the sender seeing ✓✓ and seeing
 *      `undelivered`, and it is what the handoff §3.6 rules are about.
 *
 * Deliberately NOT covered here (owned by other suites): the send path,
 * and the SQLCipher-backed branches (pending-group stash, seen-envelope
 * dedup) — the loopback runtime passes null for those stores by design,
 * which is stated in blockedItems rather than faked into a green tick.
 */

import {randomBytes, randomUUID} from 'node:crypto';
import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';

// ─── network edges only ──────────────────────────────────────────────
// In-file factory (never a __mocks__ dir for a node module — that applies
// itself repo-wide with no jest.mock() call). `requireActual` keeps every
// crypto primitive real; only the HTTP/WS clients are swapped.
jest.mock('@bravo/messenger-core', () => {
  const actual = jest.requireActual('@bravo/messenger-core');

  class FakeTransport {
    opts: Record<string, unknown>;
    state = 'disconnected';
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      (globalThis as Record<string, unknown>).__rxFakeTransport = this;
    }
    async connect(): Promise<void> { /* never opens a socket */ }
    disconnect(): void { /* noop */ }
    send(): void { /* noop */ }
    sendReadReceipt(): void { /* noop */ }
    setActivity(): void { /* noop */ }
    subscribePresence(): void { /* noop */ }
    unsubscribePresence(): void { /* noop */ }
    forceReconnect(): void { /* noop */ }
    notifyNetworkChange(): void { /* noop */ }
    msSinceServerSignal(): number { return 0; }
  }

  class FakeKeys {
    async uploadBundle(): Promise<{identityRotated: boolean}> { return {identityRotated: false}; }
    // Cold-contact bundle fetch is offline in this suite: the receive path
    // must fall back to "local trust row, else undefined" without breaking.
    async fetchPeerBundleWithPoolSize(): Promise<never> { throw new Error('keys offline'); }
    async fetchDevices(): Promise<number[]> { return [1]; }
    async mintActionToken(): Promise<null> { return null; }
  }

  class FakeCertClient {}

  class FakeCertCache {
    async get(): Promise<string> { return 'unused-own-cert'; }
    getIssued(): null { return null; }
    revokeCurrentAndInvalidate(): void { /* noop */ }
  }

  class FakeRevoked {
    start(): void { /* noop */ }
    stop(): void { /* noop */ }
    isFresh(): boolean { return false; }
    snapshot(): Set<string> { return new Set(); }
  }

  class FakeRelay {
    acked: Array<{envelopeId: string; disposition?: string}> = [];
    maxBootstrapLimit = 100;
    constructor() { (globalThis as Record<string, unknown>).__rxFakeRelay = this; }
    async bootstrap(): Promise<{envelopes: unknown[]}> { return {envelopes: []}; }
    async pull(): Promise<{envelopes: unknown[]}> { return {envelopes: []}; }
    async receipts(): Promise<unknown[]> { return []; }
    async retract(): Promise<void> { /* noop */ }
    async send(): Promise<never> { throw new Error('relay offline'); }
    async ackBatch(items: Array<{envelopeId: string; disposition?: string}>): Promise<void> {
      this.acked.push(...items);
    }
  }

  class FakeUsers {
    async listBlocked(): Promise<string[]> { return []; }
  }

  return {
    ...actual,
    TransportClient:  FakeTransport,
    KeysHttpClient:   FakeKeys,
    SenderCertClient: FakeCertClient,
    SenderCertCache:  FakeCertCache,
    RevokedJtiCache:  FakeRevoked,
    RelayHttpClient:  FakeRelay,
    UsersHttpClient:  FakeUsers,
  };
});

// NOTE: import the CORE copies, not `../crypto/sealedSender` etc. The
// mobile crypto folder holds structurally-diverged duplicates of several
// of these modules (the same dual-class hazard `firstMessageRetryBudget`
// documents); productionRuntime consumes the core ones through
// `../crypto`'s `export * from '@bravo/messenger-core'`, so the sender in
// this suite must seal with exactly those.
import {
  InMemoryProtocolStore,
  SessionManager,
  installIdentity,
  buildOwnPreKeyBundle,
  sealPayload,
  wrapOuter,
  toBase64,
  type Ciphertext,
  type SessionAddress,
  type PreKeyBundle,
  type SealOptions,
  type SealedAad,
} from '@bravo/messenger-core';
import {directConvoAadId} from '../runtime/aadBinding';
import {_resetSessionWipeProtection} from '../runtime/sessionWipeProtection';
import {resetInflightRegistry} from '../runtime/inflightEnvelopes';
import {setBlockedPeers} from '../runtime/blockedPeers';
import {flushAckQueue} from '../transport/ackQueue';
import {
  getGroupCallIdentities,
  clearAllRoomIdentities,
} from '../webrtc/groupCallIdentityRegistry';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';
import type {MessengerRuntime} from '../runtime/runtime';

const curve = new AsyncCurve25519Wrapper();

const OWN_USER = 'bob-owner-0001';
const OWN_DEVICE = 1;
const OWN_ADDRESS: SessionAddress = {userId: OWN_USER, deviceId: OWN_DEVICE};

// ─── authority (the auth-service sender-cert signer) ─────────────────

interface Authority {privKey: ArrayBuffer; pubKeyB64: string}

async function makeAuthority(): Promise<Authority> {
  const seed = randomBytes(32);
  const kp = await curve.keyPair(
    seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength),
  );
  return {privKey: kp.privKey, pubKeyB64: Buffer.from(kp.pubKey).toString('base64')};
}

function b64Json(o: unknown): string {
  return Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
}

/** Mint a real XEd25519 sender cert — identical wire format to auth-service. */
async function mintCert(auth: Authority, p: {
  sub: string; signalDeviceId: number; identityKey: string; expiresInSec?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const headerB64 = b64Json({alg: 'XEd25519', typ: 'BSC'});
  const payloadB64 = b64Json({
    senderUserId:         p.sub,
    senderSignalDeviceId: p.signalDeviceId,
    senderIdentityKey:    p.identityKey,
    iat: now,
    exp: now + (p.expiresInSec ?? 3600),
    iss: 'auth-service',
    jti: randomUUID(),
  });
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const sig = await curve.sign(
    auth.privKey,
    signingInput.buffer.slice(signingInput.byteOffset, signingInput.byteOffset + signingInput.byteLength),
  );
  return `${headerB64}.${payloadB64}.${Buffer.from(sig).toString('base64')}`;
}

// ─── module-scope handles, set up once in beforeAll ──────────────────

let authority: Authority;
let ownStore: InMemoryProtocolStore;
let ownIdentityKeyB64: string;
let runtime: MessengerRuntime;
let preKeyCursor = 1;

function transportOpts(): {onFrame: (f: unknown) => void} {
  return ((globalThis as Record<string, unknown>).__rxFakeTransport as {opts: never}).opts;
}
function fakeRelay(): {acked: Array<{envelopeId: string; disposition?: string}>} {
  return (globalThis as Record<string, unknown>).__rxFakeRelay as never;
}

/**
 * A second, fully real party with an established outbound session to us.
 * Each test gets its own so a session-destroying recovery path in one
 * test cannot poison the next.
 */
interface Sender {
  userId:      string;
  address:     SessionAddress;
  mgr:         SessionManager;
  identityB64: string;
  cert:        string;
}

let senderSeq = 0;

async function makeSender(over: {deviceId?: number} = {}): Promise<Sender> {
  const userId = `alice-${String(++senderSeq).padStart(4, '0')}`;
  const deviceId = over.deviceId ?? 1;
  const store = new InMemoryProtocolStore();
  await installIdentity(store, {preKeyCount: 1});
  const identity = await store.getIdentityKeyPair();
  const identityB64 = toBase64(identity.pubKey);
  const mgr = new SessionManager(store);
  // A fresh one-time prekey per sender so no two X3DH handshakes collide.
  const bundle: PreKeyBundle = await buildOwnPreKeyBundle(ownStore, OWN_ADDRESS, 1, preKeyCursor++);
  await mgr.initOutgoingSession(bundle);
  const cert = await mintCert(authority, {
    sub: userId, signalDeviceId: deviceId, identityKey: identityB64,
  });
  return {userId, address: {userId, deviceId}, mgr, identityB64, cert};
}

/** The AAD a well-formed 1:1 envelope from `s` to us must carry. */
function directAad(s: Sender, over: Partial<SealedAad> = {}): SealedAad {
  return {
    to:             {userId: OWN_USER, deviceId: OWN_DEVICE},
    ts:             Date.now(),
    sender:         {userId: s.userId, deviceId: s.address.deviceId},
    conversationId: directConvoAadId(OWN_USER, s.userId),
    ...over,
  };
}

/** Seal + double-ratchet-encrypt one payload from `s` to us. */
async function encryptFrom(
  s: Sender,
  body: string,
  opts: SealOptions,
  certOverride?: string,
): Promise<Ciphertext> {
  return s.mgr.encrypt(OWN_ADDRESS, sealPayload(certOverride ?? s.cert, body, opts));
}

/** The real outer-ECIES wrap the relay would carry for that ciphertext. */
async function wrapForWire(s: Sender, ct: Ciphertext): Promise<string> {
  return wrapOuter({
    recipientIdentityKeyB64: ownIdentityKeyB64,
    sender:                  s.address,
    ciphertext:              ct,
    cert:                    s.cert,
  });
}

/** Push a real `envelope.deliver` frame through the transport's onFrame. */
function deliverFrame(envelopeId: string, outerSealed: string): void {
  transportOpts().onFrame({
    event: 'envelope.deliver',
    data: {envelopeId, outerSealed, timestamp: Date.now(), ackToken: `ack-${envelopeId}`},
  });
}

async function tick(ms = 5): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, label: string, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) {return;}
    await tick();
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** Force the 200ms ack batcher and return every ack for this envelope. */
async function acksFor(envelopeId: string): Promise<Array<{disposition?: string}>> {
  await flushAckQueue(fakeRelay() as any);
  return fakeRelay().acked.filter(a => a.envelopeId === envelopeId);
}

async function waitForAck(envelopeId: string, budgetMs = 10_000): Promise<Array<{disposition?: string}>> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const acks = await acksFor(envelopeId);
    if (acks.length > 0) {return acks;}
    await tick();
  }
  throw new Error(`waitForAck timed out: ${envelopeId}`);
}

function rows(conversationId: string): LocalMessage[] {
  return useMessengerStore.getState().messages[conversationId] ?? [];
}

/** Real message bubbles — excludes the system gap-marker placeholders. */
function textRows(conversationId: string): LocalMessage[] {
  return rows(conversationId).filter(m => m.type !== 'system');
}

function seedConversation(id: string, type: 'direct' | 'group', peer: SessionAddress, participants: string[]): void {
  useMessengerStore.setState({
    conversations: {
      [id]: {
        id, type, participants, peer, unread_count: 0, is_muted: false,
        created_at: new Date().toISOString(), session_state: 'established',
      } as never,
    },
  });
}

beforeAll(async () => {
  authority = await makeAuthority();
  ownStore = new InMemoryProtocolStore();
  // Pre-install so buildProductionRuntime's own installIdentity(50) is a
  // no-op — 40 one-time prekeys is plenty for one suite and keeps the
  // single runtime build well inside the timeout.
  await installIdentity(ownStore, {preKeyCount: 40});
  ownIdentityKeyB64 = toBase64((await ownStore.getIdentityKeyPair()).pubKey);

  const mod = require('../runtime/productionRuntime') as typeof import('../runtime/productionRuntime');
  runtime = await mod.buildProductionRuntime({
    ownStore: ownStore as any,
    config: {
      authBaseUrl:        'http://127.0.0.1:1',
      messengerBaseUrl:   'http://127.0.0.1:2',
      wsUrl:              'ws://127.0.0.1:3',
      getToken:           async () => 'test-token',
      authorityPubKeyB64: authority.pubKeyB64,
      ownUserId:          OWN_USER,
      ownerKey:           OWN_USER,
    },
  });
});

afterAll(async () => {
  const mod = require('../runtime/productionRuntime') as typeof import('../runtime/productionRuntime');
  mod.disposeLiveRuntime();
  // B-304 orphan-timer class. `messengerStore`'s persist layer debounces its
  // AsyncStorage write by 500ms and — unlike `directoryNames` — does NOT
  // register itself with `globalThis.__bravoTestCleanups`. This suite is an
  // unusually heavy store writer, so it would routinely end with that timer
  // armed; it then fires after teardown and Jest blames whichever unrelated
  // suite happens to be running. Drain it inside a live environment instead.
  await new Promise(r => setTimeout(r, 700));
});

beforeEach(async () => {
  useMessengerStore.setState({
    conversations: {}, messages: {}, groups: {},
    error: null, recoveryBanner: null, undecryptableDropCount: 0,
  });
  _resetSessionWipeProtection();
  resetInflightRegistry();
  await setBlockedPeers([]);
  clearAllRoomIdentities();
  fakeRelay().acked.length = 0;
});

afterEach(async () => {
  // The ack batcher arms a 200ms timer; drain it so nothing fires into a
  // torn-down environment (the B-304 orphan-timer class).
  await flushAckQueue(fakeRelay() as any);
});

// ══════════════════════════════════════════════════════════════════════
// 1. The happy path — a real 1:1 message actually lands in the store
// ══════════════════════════════════════════════════════════════════════

describe('doHandleIncoming — 1:1 text, end to end', () => {
  it('decrypts, verifies the cert + AAD, and appends the plaintext to the peer thread', async () => {
    const alice = await makeSender();
    const ct = await encryptFrom(alice, 'meet at DIFC 14:00', {
      aad: directAad(alice), clientMsgId: 'cmid-happy',
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    const convo = `direct:${alice.userId}`;
    expect(textRows(convo)).toHaveLength(1);
    expect(textRows(convo)[0].content).toBe('meet at DIFC 14:00');
    expect(textRows(convo)[0].sender_id).toBe(alice.userId);
  });

  it('MSG-09 — orders the row by the sender-authenticated aad.ts, not receive time', async () => {
    const alice = await makeSender();
    const sentAt = Date.now() - 6 * 60 * 60 * 1000; // 6h of relay dwell
    const ct = await encryptFrom(alice, 'sent six hours ago', {aad: directAad(alice, {ts: sentAt})});

    await runtime.processIncoming('ignored', alice.address, ct);

    const row = textRows(`direct:${alice.userId}`)[0];
    expect(Math.abs(new Date(row.created_at).getTime() - sentAt)).toBeLessThan(5000);
  });

  it('Fix #16 — a successful decrypt clears the soft recovery banner a prior failure raised', async () => {
    useMessengerStore.getState().setRecoveryBanner('stale banner from an earlier envelope');
    const alice = await makeSender();
    const ct = await encryptFrom(alice, 'we are back', {aad: directAad(alice)});

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(useMessengerStore.getState().recoveryBanner).toBeNull();
  });

  it('carries reply metadata onto the stored row', async () => {
    const alice = await makeSender();
    const ct = await encryptFrom(alice, 'yes, 14:00 works', {
      aad: directAad(alice),
      replyTo: {msgId: 'orig-1', preview: 'meet at DIFC 14:00'},
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    const row = textRows(`direct:${alice.userId}`)[0];
    expect(row.reply_to_msg_id).toBe('orig-1');
    expect(row.reply_to_preview).toBe('meet at DIFC 14:00');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. Sender-cert admission — audit 1:1 P1-3 / P0-2
// ══════════════════════════════════════════════════════════════════════

describe('doHandleIncoming — sender-cert binding', () => {
  it('P1-3 — a cert naming a DIFFERENT user THROWS (so the receive txn rolls the ratchet back)', async () => {
    const alice = await makeSender();
    // A cert for someone else entirely, signed by the real authority.
    const malloryCert = await mintCert(authority, {
      sub: 'mallory-9999', signalDeviceId: 1, identityKey: alice.identityB64,
    });
    const ct = await encryptFrom(alice, 'i am not who i say', {aad: directAad(alice)}, malloryCert);

    await expect(runtime.processIncoming('ignored', alice.address, ct))
      .rejects.toThrow('cert_peer_mismatch');

    // Nothing rendered anywhere — the drop must not leak into any thread.
    expect(Object.keys(useMessengerStore.getState().messages)).toHaveLength(0);
    expect(useMessengerStore.getState().error).toBe('sender cert / hint mismatch');
  });

  it('P0-2 — a cert claiming a different deviceId THROWS (cross-device replay)', async () => {
    const alice = await makeSender();
    const otherDeviceCert = await mintCert(authority, {
      sub: alice.userId, signalDeviceId: 7, identityKey: alice.identityB64,
    });
    const ct = await encryptFrom(alice, 'replayed from device 7', {aad: directAad(alice)}, otherDeviceCert);

    await expect(runtime.processIncoming('ignored', alice.address, ct))
      .rejects.toThrow('cert_device_mismatch');
    expect(useMessengerStore.getState().error).toBe('sender cert / device-id mismatch');
  });

  it('rejects a cert signed by an authority we do not trust', async () => {
    const attacker = await makeAuthority();
    const alice = await makeSender();
    const forged = await mintCert(attacker, {
      sub: alice.userId, signalDeviceId: 1, identityKey: alice.identityB64,
    });
    const ct = await encryptFrom(alice, 'forged', {aad: directAad(alice)}, forged);

    await expect(runtime.processIncoming('ignored', alice.address, ct))
      .rejects.toThrow(/signature invalid/);
    expect(Object.keys(useMessengerStore.getState().messages)).toHaveLength(0);
  });

  it('rejects an expired cert rather than rendering the message', async () => {
    const alice = await makeSender();
    const expired = await mintCert(authority, {
      sub: alice.userId, signalDeviceId: 1, identityKey: alice.identityB64, expiresInSec: -600,
    });
    const ct = await encryptFrom(alice, 'stale cert', {aad: directAad(alice)}, expired);

    await expect(runtime.processIncoming('ignored', alice.address, ct)).rejects.toThrow();
    expect(Object.keys(useMessengerStore.getState().messages)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. Sealed-AAD binding — Security S1 / P0-N1 / P0-N2 / MSG-01
// ══════════════════════════════════════════════════════════════════════

describe('doHandleIncoming — sealed-AAD replay binding', () => {
  it('P0-N1 — an envelope with NO aad at all is dropped (fail-closed by default)', async () => {
    const alice = await makeSender();
    const ct = await encryptFrom(alice, 'no binding', {});

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(rows(`direct:${alice.userId}`)).toHaveLength(0);
    expect(useMessengerStore.getState().error).toMatch(/missing/);
  });

  it('S1 — an envelope addressed to someone else is dropped (recipient_mismatch)', async () => {
    const alice = await makeSender();
    const ct = await encryptFrom(alice, 'not for you', {
      aad: directAad(alice, {to: {userId: 'someone-else-777', deviceId: 1}}),
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(rows(`direct:${alice.userId}`)).toHaveLength(0);
    expect(useMessengerStore.getState().error).toMatch(/recipient_mismatch/);
  });

  it('P0-N2 — a ciphertext bound to a different conversation cannot be replayed into this thread', async () => {
    const alice = await makeSender();
    const ct = await encryptFrom(alice, 'cross-thread replay', {
      aad: directAad(alice, {conversationId: 'direct:some|other-pair'}),
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(rows(`direct:${alice.userId}`)).toHaveLength(0);
    expect(useMessengerStore.getState().error).toMatch(/conversation_mismatch/);
  });

  it('P0-N2 — an aad naming a different SENDER than the ratchet proves is dropped', async () => {
    const alice = await makeSender();
    const ct = await encryptFrom(alice, 'sender swap', {
      aad: directAad(alice, {sender: {userId: 'carol-1234', deviceId: 1}}),
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(rows(`direct:${alice.userId}`)).toHaveLength(0);
    expect(useMessengerStore.getState().error).toMatch(/sender_mismatch/);
  });

  it('MSG-01 — a 6-hour-old backlog envelope is NOT stale; it renders', async () => {
    // The stale bound is the 30-day relay dwell, deliberately NOT the
    // 15-minute clock-skew window. Narrowing it destroys every offline
    // backlog message, which is exactly what MSG-01 fixed.
    const alice = await makeSender();
    const ct = await encryptFrom(alice, 'overnight backlog', {
      aad: directAad(alice, {ts: Date.now() - 6 * 60 * 60 * 1000}),
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(textRows(`direct:${alice.userId}`)).toHaveLength(1);
  });

  it('MSG-01 — an envelope older than the 30-day dwell IS stale, and drops SILENTLY (no banner)', async () => {
    const alice = await makeSender();
    const ct = await encryptFrom(alice, 'ancient replay', {
      aad: directAad(alice, {ts: Date.now() - 31 * 24 * 60 * 60 * 1000}),
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(rows(`direct:${alice.userId}`)).toHaveLength(0);
    // The whole point of splitting `stale` from the other reasons: a >30d
    // replay is not a live conversation event, so it must NOT raise a
    // user-visible banner the way the mismatch reasons do.
    expect(useMessengerStore.getState().error).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. Envelopes that must NEVER render as a chat bubble
// ══════════════════════════════════════════════════════════════════════

describe('doHandleIncoming — control envelopes never render', () => {
  it('a `rehandshake` control is consumed, not rendered', async () => {
    const alice = await makeSender();
    const ct = await encryptFrom(alice, '', {aad: directAad(alice), control: 'rehandshake'});

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(rows(`direct:${alice.userId}`)).toHaveLength(0);
  });

  it('a groupCallPresence envelope feeds the tile-identity registry instead of the thread', async () => {
    const alice = await makeSender();
    const roomId = `room-${randomUUID()}`;
    const ct = await encryptFrom(alice, '', {
      aad: directAad(alice),
      groupCallPresence: {
        roomId, participantTag: 'tag-abc', displayName: 'Alice Rahman', callType: 'voice',
      },
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(rows(`direct:${alice.userId}`)).toHaveLength(0);
    expect(getGroupCallIdentities(roomId)['tag-abc']).toEqual({
      displayName: 'Alice Rahman', userId: alice.userId,
    });
  });

  it('M7/B-316 — a payload already past its TTL (plus the skew grace) is dropped unrendered', async () => {
    const alice = await makeSender();
    const ct = await encryptFrom(alice, 'should have burned', {
      aad: directAad(alice),
      expiresAtSec: Math.floor(Date.now() / 1000) - 3600,
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(rows(`direct:${alice.userId}`)).toHaveLength(0);
  });

  it('B-316 — a payload expiring inside the skew grace still renders (a fast clock must not destroy it)', async () => {
    const alice = await makeSender();
    const ct = await encryptFrom(alice, 'still inside the grace', {
      aad: directAad(alice),
      // 60s past the sender's stamp — well inside EXPIRY_CLOCK_SKEW_GRACE_MS.
      expiresAtSec: Math.floor(Date.now() / 1000) - 60,
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(textRows(`direct:${alice.userId}`)).toHaveLength(1);
  });

  it('M-07 — a blocked peer completes crypto but renders nothing', async () => {
    const alice = await makeSender();
    await setBlockedPeers([alice.userId]);
    const ct = await encryptFrom(alice, 'blocked sender text', {aad: directAad(alice)});

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(rows(`direct:${alice.userId}`)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5. B-124 — routing must never adopt a device-local group id
// ══════════════════════════════════════════════════════════════════════

describe('B-124 §3.2 — a `direct:`-shaped group id on the wire is ROUTING ONLY', () => {
  /**
   * The reporter's symptom was a duplicate chat thread on the CALLER's
   * device: an escalated 1:1 call files an ad-hoc key alias at
   * `direct:<host>`, that id then travels on the wire, and on the host's
   * own device it names the HOST. Adopting it shadow-created a second
   * chat row which the home list then relabelled with the peer's name.
   */
  it('routes a device-local group stamp to the real 1:1 slot, creating no shadow thread', async () => {
    const alice = await makeSender();
    const wireGroupId = `direct:${OWN_USER}`; // names US on our own device
    const convo = `direct:${alice.userId}`;
    // The legacy/plaintext group lane requires the sender to be in the
    // existing conversation row's participants (audit P1-4).
    seedConversation(convo, 'direct', alice.address, [alice.userId, OWN_USER]);

    const ct = await encryptFrom(alice, 'escalated call text', {
      aad: {
        to: {userId: OWN_USER, deviceId: OWN_DEVICE},
        ts: Date.now(),
        sender: {userId: alice.userId, deviceId: 1},
        conversationId: wireGroupId,
        groupId: wireGroupId,
      },
      group: {groupId: wireGroupId, kind: 'text', clientMsgId: 'cmid-b124'},
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(textRows(convo).map(m => m.content)).toEqual(['escalated call text']);
    // The shadow thread B-124 produced must not exist.
    expect(useMessengerStore.getState().messages[wireGroupId]).toBeUndefined();
  });

  it('a legitimate (non-`direct:`) group id IS adopted — the guard is not a blanket rewrite', async () => {
    const alice = await makeSender();
    const groupId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    seedConversation(groupId, 'group', alice.address, [alice.userId, OWN_USER]);

    const ct = await encryptFrom(alice, 'ops room update', {
      aad: {
        to: {userId: OWN_USER, deviceId: OWN_DEVICE},
        ts: Date.now(),
        sender: {userId: alice.userId, deviceId: 1},
        conversationId: groupId,
        groupId,
      },
      group: {groupId, kind: 'text', clientMsgId: 'cmid-group-ok'},
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(textRows(groupId).map(m => m.content)).toEqual(['ops room update']);
    expect(useMessengerStore.getState().messages[`direct:${alice.userId}`]).toBeUndefined();
  });

  it('P1-4 — a group-stamped plaintext text from a NON-participant is dropped, and creates no row', async () => {
    const alice = await makeSender();
    const groupId = 'ffeeddccbbaa99887766554433221100';
    // No conversation row at all ⇒ no participant list ⇒ sender not allowed.
    const ct = await encryptFrom(alice, 'i was never in this group', {
      aad: {
        to: {userId: OWN_USER, deviceId: OWN_DEVICE},
        ts: Date.now(),
        sender: {userId: alice.userId, deviceId: 1},
        conversationId: groupId,
        groupId,
      },
      group: {groupId, kind: 'text', clientMsgId: 'cmid-nonmember'},
    });

    await runtime.processIncoming('ignored', alice.address, ct);

    expect(useMessengerStore.getState().messages[groupId]).toBeUndefined();
    expect(useMessengerStore.getState().conversations[groupId]).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6. DecryptError recovery — audit P0-1 forged-outer-envelope defence
// ══════════════════════════════════════════════════════════════════════

describe('doHandleIncoming — DecryptError recovery', () => {
  /** Flip one byte of the ciphertext so libsignal's MAC check fails. */
  function corrupt(ct: Ciphertext): Ciphertext {
    const body = ct.body as unknown as string;
    const idx = body.length - 2;
    const flipped = String.fromCharCode(body.charCodeAt(idx) ^ 0xff);
    return {type: ct.type, body: body.slice(0, idx) + flipped + body.slice(idx + 1)} as Ciphertext;
  }

  it('a fresh peer whose message will not decrypt gets the soft "rebuild" banner, not a bubble', async () => {
    const alice = await makeSender();
    const good = await encryptFrom(alice, 'never arrives intact', {aad: directAad(alice)});

    await runtime.processIncoming('ignored', alice.address, corrupt(good));

    expect(rows(`direct:${alice.userId}`)).toHaveLength(0);
    expect(useMessengerStore.getState().recoveryBanner).toMatch(/Lost session with sender/);
  });

  it('P0-1 — after a legitimate decrypt, a later DecryptError does NOT tear the session down', async () => {
    const alice = await makeSender();
    await runtime.processIncoming(
      'ignored', alice.address,
      await encryptFrom(alice, 'legitimate traffic', {aad: directAad(alice)}),
    );
    expect(textRows(`direct:${alice.userId}`)).toHaveLength(1);
    expect(await ownStore.loadSession(`${alice.userId}.1`)).toBeDefined();

    await runtime.processIncoming(
      'ignored', alice.address,
      corrupt(await encryptFrom(alice, 'forged outer envelope', {aad: directAad(alice)})),
    );

    // The PROTECTED branch: a different banner, and — the load-bearing part —
    // the ratchet survives. The attack this defends against is "spray junk
    // envelopes at a victim until their session is wiped".
    expect(useMessengerStore.getState().recoveryBanner).toMatch(/A message failed to decrypt/);
    expect(await ownStore.loadSession(`${alice.userId}.1`)).toBeDefined();
  });

  it('the peer stays usable after the protected drop — the next real message still renders', async () => {
    const alice = await makeSender();
    await runtime.processIncoming(
      'ignored', alice.address,
      await encryptFrom(alice, 'one', {aad: directAad(alice)}),
    );
    await runtime.processIncoming(
      'ignored', alice.address,
      corrupt(await encryptFrom(alice, 'junk', {aad: directAad(alice)})),
    );
    await runtime.processIncoming(
      'ignored', alice.address,
      await encryptFrom(alice, 'three', {aad: directAad(alice)}),
    );

    expect(textRows(`direct:${alice.userId}`).map(m => m.content)).toEqual(['one', 'three']);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 7. The WebSocket frame path — and the ACK DISPOSITION it owes the sender
// ══════════════════════════════════════════════════════════════════════

describe('handleDeliver — envelope.deliver frames and their ack disposition', () => {
  it('renders the message and acks `delivered` (the sender earns its ✓✓)', async () => {
    const alice = await makeSender();
    const envId = `env-${randomUUID()}`;
    deliverFrame(envId, await wrapForWire(
      alice, await encryptFrom(alice, 'over the socket', {aad: directAad(alice)}),
    ));

    const convo = `direct:${alice.userId}`;
    await waitFor(() => textRows(convo).length === 1, 'inbound row appended');
    expect(textRows(convo)[0].content).toBe('over the socket');
    expect(textRows(convo)[0].envelope_id).toBe(envId);

    const acks = await waitForAck(envId);
    expect(acks).toHaveLength(1);
    expect(acks[0].disposition).toBe('delivered');
  });

  it('handoff §3.6 — an AAD-rejected envelope acks `discarded` and leaves a gap marker, never a false ✓✓', async () => {
    const alice = await makeSender();
    const envId = `env-${randomUUID()}`;
    deliverFrame(envId, await wrapForWire(
      alice,
      await encryptFrom(alice, 'replayed into the wrong thread', {
        aad: directAad(alice, {conversationId: 'direct:not|this-pair'}),
      }),
    ));

    expect((await waitForAck(envId))[0].disposition).toBe('discarded');

    // The user gets a persistent marker rather than silence.
    const placeholder = rows(`direct:${alice.userId}`).find(m => m.type === 'system');
    expect(placeholder?.content).toMatch(/couldn't be decrypted/);
    expect(textRows(`direct:${alice.userId}`)).toHaveLength(0);
  });

  it('B-139/M6 — a FUTURE aad timestamp is left on the relay (NO ack) with an actionable clock banner', async () => {
    const alice = await makeSender();
    const envId = `env-${randomUUID()}`;
    deliverFrame(envId, await wrapForWire(
      alice,
      await encryptFrom(alice, 'sender clock is two days ahead', {
        aad: directAad(alice, {ts: Date.now() + 2 * 24 * 60 * 60 * 1000}),
      }),
    ));

    await waitFor(
      () => /device clock looks wrong/.test(useMessengerStore.getState().error ?? ''),
      'clock-skew banner raised',
    );
    await tick(50);
    // The load-bearing assertion: acking here would DELETE the envelope off
    // the relay, destroying a message only the receiver was ever told about.
    expect(await acksFor(envId)).toHaveLength(0);
    expect(rows(`direct:${alice.userId}`)).toHaveLength(0);
  });

  it('acks `discarded` when the outer wrap cannot be unsealed at all', async () => {
    const envId = `env-${randomUUID()}`;
    deliverFrame(envId, Buffer.from('not an outer envelope').toString('base64'));

    expect((await waitForAck(envId))[0].disposition).toBe('discarded');
    // Sealed sender means we cannot know who sent it, so a COUNT is the only
    // thing MessengerHome can surface (B-46).
    expect(useMessengerStore.getState().undecryptableDropCount).toBe(1);
  });

  it('acks `discarded` (never `delivered`) when the sender cert names a different user', async () => {
    const alice = await makeSender();
    const envId = `env-${randomUUID()}`;
    const malloryCert = await mintCert(authority, {
      sub: 'mallory-4242', signalDeviceId: 1, identityKey: alice.identityB64,
    });
    deliverFrame(envId, await wrapForWire(
      alice,
      await encryptFrom(alice, 'impersonation attempt', {aad: directAad(alice)}, malloryCert),
    ));

    expect((await waitForAck(envId))[0].disposition).toBe('discarded');
    expect(textRows(`direct:${alice.userId}`)).toHaveLength(0);
  });

  it('L16 — two concurrent deliveries of the SAME envelope decrypt exactly once', async () => {
    const alice = await makeSender();
    const envId = `env-${randomUUID()}`;
    const outer = await wrapForWire(
      alice, await encryptFrom(alice, 'double push', {aad: directAad(alice)}),
    );

    // The relay re-pushes pending envelopes on reconnect; a re-push racing a
    // drain used to feed the SAME ciphertext to libsignal twice — one won the
    // ratchet, the other threw bad-MAC and flashed a decrypt-failure banner.
    deliverFrame(envId, outer);
    deliverFrame(envId, outer);

    const convo = `direct:${alice.userId}`;
    await waitFor(() => textRows(convo).length >= 1, 'first copy appended');
    await tick(200);

    expect(textRows(convo)).toHaveLength(1);
    expect(useMessengerStore.getState().recoveryBanner).toBeNull();
    expect(await acksFor(envId)).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 8. Control envelopes that PATCH an existing row — reactions
// ══════════════════════════════════════════════════════════════════════

describe('doHandleIncoming — reaction envelopes patch, never append', () => {
  it('a 1:1 reaction folds onto the target bubble instead of creating a new one', async () => {
    const alice = await makeSender();
    const convo = `direct:${alice.userId}`;
    await runtime.processIncoming('ignored', alice.address, await encryptFrom(
      alice, 'dinner at 8?', {aad: directAad(alice), clientMsgId: 'cmid-react-target'},
    ));
    expect(textRows(convo)).toHaveLength(1);

    await runtime.processIncoming('ignored', alice.address, await encryptFrom(
      alice, '', {aad: directAad(alice), reaction: {targetMsgId: 'cmid-react-target', emoji: '❤️'}},
    ));

    expect(rows(convo)).toHaveLength(1);
    expect(rows(convo)[0].reactions?.[alice.userId]).toBe('❤️');
  });

  it('a reaction with `remove` retracts the emoji rather than stacking another row', async () => {
    const alice = await makeSender();
    const convo = `direct:${alice.userId}`;
    await runtime.processIncoming('ignored', alice.address, await encryptFrom(
      alice, 'dinner at 8?', {aad: directAad(alice), clientMsgId: 'cmid-react-rm'},
    ));
    await runtime.processIncoming('ignored', alice.address, await encryptFrom(
      alice, '', {aad: directAad(alice), reaction: {targetMsgId: 'cmid-react-rm', emoji: '❤️'}},
    ));
    expect(rows(convo)[0].reactions?.[alice.userId]).toBe('❤️');

    await runtime.processIncoming('ignored', alice.address, await encryptFrom(
      alice, '',
      {aad: directAad(alice), reaction: {targetMsgId: 'cmid-react-rm', emoji: '❤️', remove: true}},
    ));

    expect(rows(convo)).toHaveLength(1);
    expect(rows(convo)[0].reactions?.[alice.userId]).toBeUndefined();
  });

  it('MSG-02 — a group-stamped reaction lands on the GROUP row, not in the reactor 1:1 slot', async () => {
    // A group reaction is a 1:1-PAIRWISE control envelope carrying a group
    // ROUTING hint. Before MSG-02 it was handled below the group-parse path,
    // which fed its empty body to parseGroupMessage and dropped it — the
    // reaction landed in the reactor's own 1:1 thread and nobody saw it.
    const alice = await makeSender();
    const groupId = '00112233445566778899aabbccddeeff';
    useMessengerStore.setState({
      messages: {
        [groupId]: [{
          id: 'grp-msg-1', conversation_id: groupId, sender_id: alice.userId,
          type: 'text', content: 'ops room note', status: 'delivered',
          is_encrypted: true, created_at: new Date().toISOString(), peer: alice.address,
        } as never],
      },
    });

    await runtime.processIncoming('ignored', alice.address, await encryptFrom(alice, '', {
      aad: {
        to: {userId: OWN_USER, deviceId: OWN_DEVICE}, ts: Date.now(),
        sender: {userId: alice.userId, deviceId: 1},
        conversationId: groupId, groupId,
      },
      group: {groupId, kind: 'text', clientMsgId: 'cmid-grp-react'},
      reaction: {targetMsgId: 'grp-msg-1', emoji: '👍'},
    }));

    expect(rows(groupId)[0].reactions?.[alice.userId]).toBe('👍');
    expect(useMessengerStore.getState().messages[`direct:${alice.userId}`]).toBeUndefined();
  });

  it('M-07 — a blocked peer cannot patch a bubble either', async () => {
    const alice = await makeSender();
    const convo = `direct:${alice.userId}`;
    await runtime.processIncoming('ignored', alice.address, await encryptFrom(
      alice, 'before the block', {aad: directAad(alice), clientMsgId: 'cmid-blocked-react'},
    ));
    await setBlockedPeers([alice.userId]);

    await runtime.processIncoming('ignored', alice.address, await encryptFrom(
      alice, '', {aad: directAad(alice), reaction: {targetMsgId: 'cmid-blocked-react', emoji: '😂'}},
    ));

    expect(rows(convo)[0].reactions).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 9. Edit / delete-for-everyone — the AUTHOR-ONLY gate
// ══════════════════════════════════════════════════════════════════════

describe('doHandleIncoming — edit / delete-for-everyone', () => {
  it('an author editing their own 1:1 message patches the row in place', async () => {
    const alice = await makeSender();
    const convo = `direct:${alice.userId}`;
    await runtime.processIncoming('ignored', alice.address, await encryptFrom(
      alice, 'meet at 3', {aad: directAad(alice), clientMsgId: 'cmid-edit-1'},
    ));

    const editedAt = Date.now();
    await runtime.processIncoming('ignored', alice.address, await encryptFrom(alice, '', {
      aad: directAad(alice),
      edit: {targetMsgId: 'cmid-edit-1', body: 'meet at 4', editedAt},
    }));

    expect(rows(convo)).toHaveLength(1);
    expect(rows(convo)[0].content).toBe('meet at 4');
    expect(rows(convo)[0].edited_at).toBe(editedAt);
  });

  it('an author deleting for everyone tombstones the row (content stripped)', async () => {
    const alice = await makeSender();
    const convo = `direct:${alice.userId}`;
    await runtime.processIncoming('ignored', alice.address, await encryptFrom(
      alice, 'please forget this', {aad: directAad(alice), clientMsgId: 'cmid-del-1'},
    ));

    await runtime.processIncoming('ignored', alice.address, await encryptFrom(alice, '', {
      aad: directAad(alice),
      deleteFor: {targetMsgId: 'cmid-del-1', deletedAt: Date.now()},
    }));

    expect(rows(convo)).toHaveLength(1);
    expect(rows(convo)[0].deleted_for_all).toBe(true);
    expect(rows(convo)[0].content).toBe('');
  });

  it('SECURITY — a peer CANNOT delete a message WE authored (`own-row`)', async () => {
    const alice = await makeSender();
    const convo = `direct:${alice.userId}`;
    useMessengerStore.setState({
      messages: {
        [convo]: [{
          id: 'my-own-row', conversation_id: convo, sender_id: 'self',
          type: 'text', content: 'my own words', status: 'sent',
          is_encrypted: true, created_at: new Date().toISOString(), peer: alice.address,
        } as never],
      },
    });

    await runtime.processIncoming('ignored', alice.address, await encryptFrom(alice, '', {
      aad: directAad(alice),
      deleteFor: {targetMsgId: 'my-own-row', deletedAt: Date.now()},
    }));

    expect(rows(convo)[0].content).toBe('my own words');
    expect(rows(convo)[0].deleted_for_all).toBeFalsy();
  });

  it('SECURITY — a group member CANNOT delete another member\'s message (`not-author`)', async () => {
    const alice = await makeSender();
    const groupId = 'aabbccddeeff00112233445566778899';
    useMessengerStore.setState({
      messages: {
        [groupId]: [{
          id: 'dave-row', conversation_id: groupId, sender_id: 'dave-user-42',
          type: 'text', content: 'dave said this', status: 'delivered',
          is_encrypted: true, created_at: new Date().toISOString(),
          peer: {userId: 'dave-user-42', deviceId: 1},
        } as never],
      },
    });

    await runtime.processIncoming('ignored', alice.address, await encryptFrom(alice, '', {
      aad: {
        to: {userId: OWN_USER, deviceId: OWN_DEVICE}, ts: Date.now(),
        sender: {userId: alice.userId, deviceId: 1},
        conversationId: groupId, groupId,
      },
      group: {
        groupId, kind: 'text', clientMsgId: 'cmid-grp-del',
        deleteFor: {targetMsgId: 'dave-row', deletedAt: Date.now()},
      },
    }));

    expect(rows(groupId)[0].content).toBe('dave said this');
    expect(rows(groupId)[0].deleted_for_all).toBeFalsy();
  });

  it('a stale edit (older stamp than the one already applied) is refused', async () => {
    const alice = await makeSender();
    const convo = `direct:${alice.userId}`;
    await runtime.processIncoming('ignored', alice.address, await encryptFrom(
      alice, 'v1', {aad: directAad(alice), clientMsgId: 'cmid-stale-edit'},
    ));
    const newer = Date.now();
    await runtime.processIncoming('ignored', alice.address, await encryptFrom(alice, '', {
      aad: directAad(alice),
      edit: {targetMsgId: 'cmid-stale-edit', body: 'v2', editedAt: newer},
    }));
    expect(rows(convo)[0].content).toBe('v2');

    // A reordered/duplicated older edit must not roll the body back.
    await runtime.processIncoming('ignored', alice.address, await encryptFrom(alice, '', {
      aad: directAad(alice),
      edit: {targetMsgId: 'cmid-stale-edit', body: 'v0', editedAt: newer - 60_000},
    }));

    expect(rows(convo)[0].content).toBe('v2');
    expect(rows(convo)[0].edited_at).toBe(newer);
  });

  it('a delete for a message we have never seen is dropped, and creates no phantom row', async () => {
    // Loopback runtime has no pending-mutation stash, so the gate's `stash`
    // verdict degrades to a drop — the observable contract is that it must
    // never invent a bubble for a target that does not exist.
    const alice = await makeSender();
    await runtime.processIncoming('ignored', alice.address, await encryptFrom(alice, '', {
      aad: directAad(alice),
      deleteFor: {targetMsgId: 'never-existed', deletedAt: Date.now()},
    }));

    expect(rows(`direct:${alice.userId}`)).toHaveLength(0);
  });
});
