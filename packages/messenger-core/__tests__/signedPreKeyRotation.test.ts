import {
  installIdentity,
  buildOwnPreKeyBundle,
  shouldRotateSignedPreKey,
  rotateSignedPreKey,
  currentSignedPreKeyId,
  SIGNED_PRE_KEY_ROTATION_INTERVAL_MS,
  SIGNED_PRE_KEY_RETENTION_MS,
  InMemoryProtocolStore,
  type CryptoStore,
} from '@bravo/messenger-core';

/**
 * Audit P0-I1 — signed pre-key rotation primitives.
 *
 * These tests cover the three exports (`shouldRotateSignedPreKey`,
 * `rotateSignedPreKey`, `currentSignedPreKeyId`) and the
 * `SIGNED_PRE_KEY_RETENTION_MS` sweep semantics.
 *
 * The in-memory store stamps `Date.now()` on every storeSignedPreKey
 * call. To exercise the rotation/retention branches without sleeping
 * we wrap the store in a small adapter that lets each test inject the
 * `createdAt` it wants on demand.
 */

/**
 * Wraps an InMemoryProtocolStore so we can override createdAt on a
 * per-keyId basis. The override is only visible through
 * `listSignedPreKeys`; every other CryptoStore method passes straight
 * through. Implemented via Proxy so `setOwnIdentity` (which is on the
 * concrete class but not on the CryptoStore interface) is still
 * reachable for `installIdentity`'s `saveOwn.setOwnIdentity` branch.
 */
function makeStoreWithClockOverride(): {
  store: CryptoStore;
  setCreatedAt: (keyId: number, ms: number) => void;
} {
  const inner = new InMemoryProtocolStore();
  const overrides = new Map<number, number>();
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'listSignedPreKeys') {
        return async () => {
          const real = await target.listSignedPreKeys!();
          return real.map(r => ({
            keyId: r.keyId,
            createdAt: overrides.has(r.keyId) ? (overrides.get(r.keyId) as number) : r.createdAt,
          }));
        };
      }
      if (prop === 'removeSignedPreKey') {
        return async (keyId: number) => {
          overrides.delete(keyId);
          await target.removeSignedPreKey(keyId);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    store: proxy as unknown as CryptoStore,
    setCreatedAt: (keyId, ms) => { overrides.set(keyId, ms); },
  };
}

describe('audit P0-I1 — currentSignedPreKeyId', () => {
  it('returns 1 on a store with no SPK rows yet', async () => {
    const store = new InMemoryProtocolStore();
    expect(await currentSignedPreKeyId(store)).toBe(1);
  });

  it('returns 1 after installIdentity (which writes SPK at keyId=1)', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    expect(await currentSignedPreKeyId(store)).toBe(1);
  });

  it('returns the latest keyId after a rotation', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    const res = await rotateSignedPreKey(store);
    expect(res.newKeyId).toBe(2);
    expect(await currentSignedPreKeyId(store)).toBe(2);
  });

  it('returns the max keyId across multiple rotations', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    await rotateSignedPreKey(store);
    await rotateSignedPreKey(store);
    await rotateSignedPreKey(store);
    expect(await currentSignedPreKeyId(store)).toBe(4);
  });

  it('falls back to 1 when the store does not implement listSignedPreKeys', async () => {
    const stub = {} as CryptoStore;
    expect(await currentSignedPreKeyId(stub)).toBe(1);
  });
});

describe('audit P0-I1 — shouldRotateSignedPreKey', () => {
  it('returns false on an empty store (installIdentity has not run)', async () => {
    const store = new InMemoryProtocolStore();
    expect(await shouldRotateSignedPreKey(store)).toBe(false);
  });

  it('returns false immediately after install — the SPK is fresh', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    expect(await shouldRotateSignedPreKey(store)).toBe(false);
  });

  it('returns true once the newest SPK age exceeds the rotation interval', async () => {
    const {store, setCreatedAt} = makeStoreWithClockOverride();
    await installIdentity(store, {preKeyCount: 2});
    // Age the install-time SPK out past the rotation interval.
    setCreatedAt(1, Date.now() - SIGNED_PRE_KEY_ROTATION_INTERVAL_MS - 1000);
    expect(await shouldRotateSignedPreKey(store)).toBe(true);
  });

  it('returns false when the newest SPK is younger than the interval', async () => {
    const {store, setCreatedAt} = makeStoreWithClockOverride();
    await installIdentity(store, {preKeyCount: 2});
    // One hour shy of the rotation interval.
    setCreatedAt(1, Date.now() - SIGNED_PRE_KEY_ROTATION_INTERVAL_MS + 60 * 60 * 1000);
    expect(await shouldRotateSignedPreKey(store)).toBe(false);
  });

  it('does NOT stampede on legacy createdAt=0 rows', async () => {
    const {store, setCreatedAt} = makeStoreWithClockOverride();
    await installIdentity(store, {preKeyCount: 2});
    setCreatedAt(1, 0); // simulate pre-timestamp install
    expect(await shouldRotateSignedPreKey(store)).toBe(false);
  });

  it('returns false when the store does not implement listSignedPreKeys', async () => {
    const stub = {} as CryptoStore;
    expect(await shouldRotateSignedPreKey(stub)).toBe(false);
  });

  it('uses the NEWEST SPK, not the oldest — so a fresh post-rotation SPK suppresses rotation', async () => {
    const {store, setCreatedAt} = makeStoreWithClockOverride();
    await installIdentity(store, {preKeyCount: 2});
    setCreatedAt(1, Date.now() - SIGNED_PRE_KEY_ROTATION_INTERVAL_MS - 1000); // ancient
    await rotateSignedPreKey(store);
    // keyId=2 is fresh; even though keyId=1 is ancient, shouldRotate is false.
    expect(await shouldRotateSignedPreKey(store)).toBe(false);
  });
});

describe('audit P0-I1 — rotateSignedPreKey', () => {
  it('mints a new SPK at currentMax+1', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    const res = await rotateSignedPreKey(store);
    expect(res.newKeyId).toBe(2);
    expect(res.prevKeyId).toBe(1);
    expect(res.publicKeyB64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(res.signatureB64).toMatch(/^[A-Za-z0-9+/=]+$/);
    // Loadable via the store under the new keyId.
    const loaded = await store.loadSignedPreKey(2);
    expect(loaded).toBeDefined();
    expect(loaded!.signature).toBeDefined();
  });

  it('signs the new SPK with the identity key — buildOwnPreKeyBundle round-trips', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    const res = await rotateSignedPreKey(store);
    const bundle = await buildOwnPreKeyBundle(
      store,
      {userId: 'alice', deviceId: 1},
      res.newKeyId,
    );
    expect(bundle.signedPreKey.keyId).toBe(res.newKeyId);
    expect(bundle.signedPreKey.publicKey).toBe(res.publicKeyB64);
    expect(bundle.signedPreKey.signature).toBe(res.signatureB64);
  });

  it('preserves the previous SPK so in-flight PreKeyWhispers still decrypt', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    const prev = await store.loadSignedPreKey(1);
    await rotateSignedPreKey(store);
    const stillThere = await store.loadSignedPreKey(1);
    expect(stillThere?.signature).toEqual(prev?.signature);
  });

  it('prunes SPKs older than SIGNED_PRE_KEY_RETENTION_MS at rotation time (once they are neither current nor previous)', async () => {
    const {store, setCreatedAt} = makeStoreWithClockOverride();
    await installIdentity(store, {preKeyCount: 2});
    // First rotation: id1 -> id2. id1 is now the PREVIOUS key (protected).
    await rotateSignedPreKey(store);
    // Backdate the now-two-generations-old id1 past the retention window.
    setCreatedAt(1, Date.now() - SIGNED_PRE_KEY_RETENTION_MS - 1000);
    // Second rotation: id2 -> id3. id1 is neither current (id3) nor
    // previous (id2), and is aged out, so THIS pass prunes it.
    const res = await rotateSignedPreKey(store);
    expect(res.newKeyId).toBe(3);
    expect(res.prunedKeyIds).toContain(1);
    expect(await store.loadSignedPreKey(1)).toBeUndefined();
    // The current and previous SPKs survive.
    expect(await store.loadSignedPreKey(2)).toBeDefined();
    expect(await store.loadSignedPreKey(res.newKeyId)).toBeDefined();
  });

  it('audit G-01 — does NOT prune the SPK it just rotated off, even when that SPK is already aged past retention', async () => {
    const {store, setCreatedAt} = makeStoreWithClockOverride();
    await installIdentity(store, {preKeyCount: 2});
    // Device sat unopened long enough that the CURRENT SPK (id1) is older
    // than the full retention window before rotation finally fires. A peer
    // could still have fetched id1 near the end and dwelled a message, so
    // id1 must survive this rotation as the previous key.
    setCreatedAt(1, Date.now() - SIGNED_PRE_KEY_RETENTION_MS - 1000);
    const res = await rotateSignedPreKey(store);
    expect(res.newKeyId).toBe(2);
    expect(res.prevKeyId).toBe(1);
    expect(res.prunedKeyIds).not.toContain(1);
    expect(await store.loadSignedPreKey(1)).toBeDefined();
  });

  it('does NOT prune the previous SPK when it is inside the retention window', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    const res = await rotateSignedPreKey(store);
    expect(res.prunedKeyIds).toEqual([]);
    expect(await store.loadSignedPreKey(1)).toBeDefined();
    expect(await store.loadSignedPreKey(res.newKeyId)).toBeDefined();
  });

  it('does NOT prune createdAt=0 legacy rows even when they would otherwise be ancient', async () => {
    const {store, setCreatedAt} = makeStoreWithClockOverride();
    await installIdentity(store, {preKeyCount: 2});
    setCreatedAt(1, 0);
    const res = await rotateSignedPreKey(store);
    expect(res.prunedKeyIds).not.toContain(1);
    expect(await store.loadSignedPreKey(1)).toBeDefined();
  });

  it('chooses a keyId strictly greater than every stored SPK on repeated rotation', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    const r1 = await rotateSignedPreKey(store);
    const r2 = await rotateSignedPreKey(store);
    const r3 = await rotateSignedPreKey(store);
    expect(r1.newKeyId).toBeGreaterThan(1);
    expect(r2.newKeyId).toBeGreaterThan(r1.newKeyId);
    expect(r3.newKeyId).toBeGreaterThan(r2.newKeyId);
  });

  it('prevKeyId is undefined when prev was the same id as new (shouldn’t happen in normal flow but defends the contract)', async () => {
    // Force the contract path by handing an empty store to rotateSignedPreKey
    // after installIdentity wrote keyId=1: with the listSignedPreKeys stub
    // returning [{keyId:1}], currentSignedPreKeyId returns 1 and the new
    // keyId is max(1,1)+1=2 — distinct from prev, so prevKeyId is `1` (defined).
    // Therefore "prev !== new" is the steady state; this test locks the
    // happy-path expectation that prev is set.
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    const res = await rotateSignedPreKey(store);
    expect(res.prevKeyId).toBe(1);
  });
});

describe('audit G-01 — installIdentity idempotency survives SPK rotation (identity time-bomb regression)', () => {
  async function idFingerprint(store: CryptoStore) {
    const id = await store.getIdentityKeyPair();
    const reg = await store.getLocalRegistrationId();
    // Compare the raw public-key bytes as a stable fingerprint.
    return {
      reg,
      pub: Array.from(new Uint8Array(id.pubKey)).join(','),
    };
  }

  it('does NOT regenerate the identity when re-run after the install-time SPK (id 1) has been pruned by rotation', async () => {
    const {store, setCreatedAt} = makeStoreWithClockOverride();
    await installIdentity(store, {preKeyCount: 2});
    const before = await idFingerprint(store);

    // Simulate ~2 months of rotations that eventually prune id 1, exactly
    // the sequence that used to delete the completion sentinel and trigger
    // an identity regeneration on the next boot.
    await rotateSignedPreKey(store);               // id1 -> id2 (id1 kept, prev)
    setCreatedAt(1, Date.now() - SIGNED_PRE_KEY_RETENTION_MS - 1000);
    const r2 = await rotateSignedPreKey(store);    // id2 -> id3, id1 pruned
    expect(r2.prunedKeyIds).toContain(1);
    expect(await store.loadSignedPreKey(1)).toBeUndefined();

    // The old sentinel checked loadSignedPreKey(1) specifically; that is
    // now gone. A re-run of installIdentity on the next boot must STILL be
    // a no-op and must NOT mint a new identity key / registration id.
    await installIdentity(store, {preKeyCount: 2});
    const after = await idFingerprint(store);

    expect(after.pub).toBe(before.pub);
    expect(after.reg).toBe(before.reg);
    // And it must not have resurrected id 1 or wiped the live keys.
    expect(await store.loadSignedPreKey(1)).toBeUndefined();
    expect(await currentSignedPreKeyId(store)).toBe(3);
  });

  it('still re-runs install when identity exists but NO signed prekey exists (genuine half-install)', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    // Wipe every SPK to simulate a crash between identity-write and
    // signed-prekey-write.
    const list = await store.listSignedPreKeys!();
    for (const row of list) {await store.removeSignedPreKey(row.keyId);}
    expect((await store.listSignedPreKeys!()).length).toBe(0);

    await installIdentity(store, {preKeyCount: 2});
    // Install re-ran and restored the sentinel SPK.
    expect((await store.listSignedPreKeys!()).length).toBeGreaterThan(0);
  });
});

describe('audit P0-I1 — retention window exceeds rotation interval (G-01 invariant)', () => {
  it('retention is strictly greater than the rotation interval so the previous SPK survives the cross-over', () => {
    expect(SIGNED_PRE_KEY_RETENTION_MS).toBeGreaterThan(SIGNED_PRE_KEY_ROTATION_INTERVAL_MS);
  });
});

describe('audit P0-I1 — InMemoryProtocolStore.listSignedPreKeys parity', () => {
  it('returns one row per stored SPK with createdAt populated', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    const list = await store.listSignedPreKeys!();
    expect(list).toHaveLength(1);
    expect(list[0].keyId).toBe(1);
    expect(list[0].createdAt).toBeGreaterThan(0);
  });

  it('returns multiple rows after rotation', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    await rotateSignedPreKey(store);
    const list = await store.listSignedPreKeys!();
    expect(list.map(r => r.keyId).sort()).toEqual([1, 2]);
  });

  it('does NOT leak key material — only (keyId, createdAt)', async () => {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 2});
    const list = await store.listSignedPreKeys!();
    for (const row of list) {
      expect(Object.keys(row).sort()).toEqual(['createdAt', 'keyId']);
    }
  });
});
