/**
 * productionRuntime — the module-level LIFECYCLE exports, EXECUTED.
 *
 * `buildProductionRuntime` is not a pure factory: it owns process-wide state
 * that outlives any single runtime object — the owner epoch, the archive-replay
 * handle, and the deferred-bundle-publish latch. Every one of those exists
 * because of a shipped incident, and none of them can be seen by inspecting a
 * returned object, which is why they went untested for the file's whole life.
 *
 *   Round 6 — the owner epoch is a FENCE. A frame already sitting in the
 *     socket.io receive queue at signOut() would otherwise run through
 *     handleServerFrame after the NEXT user's runtime wired up the store,
 *     writing the previous user's plaintext into the new user's messages.
 *     Every async closure re-checks `myEpoch === currentOwnerEpoch`, so the
 *     epoch must MOVE on dispose and MOVE AGAIN on rebuild.
 *
 *   Round 8 — `setDeferBundlePublish` exists because publishing the fresh
 *     identity that `installIdentity` just minted, in the middle of a
 *     restore-from-backup, makes auth-service read it as an identity ROTATION
 *     and WIPE every server-side OPK public the user's peers hold sessions
 *     against. The restore screen sets the latch before boot and calls
 *     `publishOwnBundleAfterRestore` once the recovered identity is installed.
 *
 * Harness rationale: see `productionRuntimeDirectSend.test.ts`.
 */

jest.mock('@bravo/messenger-core', () => {
  const actual = jest.requireActual('@bravo/messenger-core');
  const g = globalThis as unknown as {__prBus?: Record<string, unknown>};
  const bus = (g.__prBus = g.__prBus ?? {
    uploads:  [] as unknown[],
    acks:     [] as unknown[],
  }) as {uploads: unknown[]; acks: unknown[]};

  class FakeTransport {
    connect() { return Promise.resolve(); }
    disconnect() {}
    close() {}
    isConnected() { return true; }
    msSinceServerSignal() { return 0; }
    forceReconnect() { return Promise.resolve(); }
    send() {}
  }
  class FakeKeys {
    uploadBundle(b: unknown) {
      bus.uploads.push(b);
      return Promise.resolve({poolSize: 50, identityRotated: false});
    }
    fetchPeerBundleWithPoolSize() { return Promise.reject(new Error('no bundle')); }
    fetchDevices() { return Promise.resolve([]); }
  }
  class FakeCertClient {}
  class FakeRelay {
    send() { return Promise.resolve({envelopeId: 'e', retractToken: 't'}); }
    retract() { return Promise.resolve({retracted: true}); }
    pull() { return Promise.resolve({envelopes: []}); }
    ack(a: unknown) { bus.acks.push(a); return Promise.resolve({}); }
    ackBatch(a: unknown) { bus.acks.push(a); return Promise.resolve({}); }
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

import {toBase64} from '../crypto';
import {InMemoryProtocolStore} from '../crypto/inMemoryStore';
import {useMessengerStore} from '../store/messengerStore';
import type {MessengerRuntime} from '../runtime/runtime';

jest.setTimeout(300_000);

type Bus = {uploads: Array<{identityKey: string; oneTimePreKeys: unknown[]}>; acks: unknown[]};
const bus = (): Bus => (globalThis as unknown as {__prBus: Bus}).__prBus;

const runtimeMod = (): typeof import('../runtime/productionRuntime') =>
  require('../runtime/productionRuntime') as typeof import('../runtime/productionRuntime');

const NO_OWNER_EPOCH = -1;

/**
 * ONE crypto store shared by every build in this file. `installIdentity` is
 * idempotent (it early-returns once the identity + signed pre-key exist), so
 * reusing the store makes every build after the first skip 50 pure-JS
 * curve25519 key generations. That matters: `safetyNumber.test.ts` runs 5200
 * awaited SHA-256 iterations and is starved into a timeout by extra CPU load
 * elsewhere in the project — see jest.setup.messenger-crypto.js.
 */
const sharedStore = new InMemoryProtocolStore();

async function build(ownerKey: string, ownStore: InMemoryProtocolStore = sharedStore): Promise<{
  runtime: MessengerRuntime; store: InMemoryProtocolStore;
}> {
  const runtime = await runtimeMod().buildProductionRuntime({
    ownStore,
    config: {
      authBaseUrl:        'http://auth.test',
      messengerBaseUrl:   'http://msg.test',
      wsUrl:              'ws://msg.test/ws',
      getToken:           async () => 'jwt',
      authorityPubKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ownUserId:          `${ownerKey}-uuid`,
      ownerKey,
    },
  });
  return {runtime, store: ownStore};
}

/** The boot bundle publish is deliberately fire-and-forget (Notif-latency E1). */
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  bus().uploads.length = 0;
  bus().acks.length = 0;
  runtimeMod().setDeferBundlePublish(false);
  useMessengerStore.setState({messages: {}, conversations: {}, groups: {}});
});

afterAll(() => {
  runtimeMod().disposeLiveRuntime();
  runtimeMod().setDeferBundlePublish(false);
});

describe('owner epoch — the Round 6 fence against cross-user frame leakage', () => {
  afterEach(() => { runtimeMod().disposeLiveRuntime(); });

  it('sits at the no-owner sentinel before any runtime is built', () => {
    runtimeMod().disposeLiveRuntime();
    expect(runtimeMod().getCurrentOwnerEpoch()).toBe(NO_OWNER_EPOCH);
  });

  it('claims a real epoch on build and drops back to the sentinel on dispose', async () => {
    await build('epoch-a');
    const live = runtimeMod().getCurrentOwnerEpoch();
    expect(live).toBeGreaterThan(0);

    runtimeMod().disposeLiveRuntime();
    // A frame that was already queued at signOut now fails `myEpoch ===
    // currentOwnerEpoch` and bails instead of writing into the next user's store.
    expect(runtimeMod().getCurrentOwnerEpoch()).toBe(NO_OWNER_EPOCH);
    expect(runtimeMod().getCurrentOwnerEpoch()).not.toBe(live);
  });

  it('never REUSES an epoch across a rebuild — a stale closure must always lose', async () => {
    await build('epoch-b');
    const first = runtimeMod().getCurrentOwnerEpoch();
    await build('epoch-c');
    const second = runtimeMod().getCurrentOwnerEpoch();

    expect(second).toBeGreaterThan(first);
  });

  it('is safe to dispose repeatedly with no runtime standing', () => {
    expect(() => {
      runtimeMod().disposeLiveRuntime();
      runtimeMod().disposeLiveRuntime();
    }).not.toThrow();
    expect(runtimeMod().getCurrentOwnerEpoch()).toBe(NO_OWNER_EPOCH);
  });
});

describe('deferred bundle publish — the Round 8 restore guard', () => {
  afterEach(() => {
    runtimeMod().setDeferBundlePublish(false);
    runtimeMod().disposeLiveRuntime();
  });

  it('uploads the own bundle on an ordinary boot', async () => {
    const {store} = await build('publish-on');
    await settle();

    expect(bus().uploads).toHaveLength(1);
    const identity = await store.getIdentityKeyPair();
    expect(bus().uploads[0].identityKey).toBe(toBase64(identity.pubKey));
    // installIdentity seeds a 50-key OPK pool; the upload must carry it or
    // peers cannot open a first-contact session.
    expect(bus().uploads[0].oneTimePreKeys).toHaveLength(50);
  });

  it('uploads NOTHING while the restore latch is set', async () => {
    runtimeMod().setDeferBundlePublish(true);
    await build('publish-deferred');
    await settle();

    // Uploading the freshly-minted identity here makes auth-service read it as
    // an identity rotation and WIPE every peer's OPK public.
    expect(bus().uploads).toHaveLength(0);
  });

  it('publishOwnBundleAfterRestore uploads the bundle the restore installed', async () => {
    runtimeMod().setDeferBundlePublish(true);
    const {store} = await build('publish-after-restore');
    await settle();
    expect(bus().uploads).toHaveLength(0);

    await runtimeMod().publishOwnBundleAfterRestore();
    expect(bus().uploads).toHaveLength(1);
    const identity = await store.getIdentityKeyPair();
    expect(bus().uploads[0].identityKey).toBe(toBase64(identity.pubKey));
  });

  it('publishOwnBundleAfterRestore is a warning no-op when no runtime is live', async () => {
    runtimeMod().disposeLiveRuntime();
    await expect(runtimeMod().publishOwnBundleAfterRestore()).resolves.toBeUndefined();
    expect(bus().uploads).toHaveLength(0);
  });

  it('clearing the latch restores ordinary boot-time publishing', async () => {
    runtimeMod().setDeferBundlePublish(true);
    await build('latch-set');
    await settle();
    expect(bus().uploads).toHaveLength(0);

    runtimeMod().setDeferBundlePublish(false);
    bus().uploads.length = 0;
    await build('latch-cleared');
    await settle();
    expect(bus().uploads).toHaveLength(1);
  });
});

describe('replayArchivedEnvelope — the restore-after-reinstall drain handle', () => {
  afterEach(() => { runtimeMod().disposeLiveRuntime(); });

  it('reports false when no runtime is built, so the caller boots one first', async () => {
    runtimeMod().disposeLiveRuntime();
    await expect(runtimeMod().replayArchivedEnvelope({
      envelopeId: 'arch-1', outerSealed: 'AAAA', timestampMs: Date.now(),
    })).resolves.toBe(false);
  });

  it('reports true once a runtime owns the handle, even for an undecryptable row', async () => {
    await build('replay-live');
    // A garbage envelope must not reject: ONE bad archived row cannot be
    // allowed to abort the restore drain.
    await expect(runtimeMod().replayArchivedEnvelope({
      envelopeId: 'arch-2', outerSealed: 'AAAA', timestampMs: Date.now(),
    })).resolves.toBe(true);
  });

  it('goes back to false after dispose so a torn-down runtime cannot be replayed into', async () => {
    await build('replay-disposed');
    runtimeMod().disposeLiveRuntime();
    await expect(runtimeMod().replayArchivedEnvelope({
      envelopeId: 'arch-3', outerSealed: 'AAAA', timestampMs: Date.now(),
    })).resolves.toBe(false);
  });
});
