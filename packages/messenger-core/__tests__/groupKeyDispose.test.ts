import {
  groupEncrypt, groupDecrypt, disposeGroupKey, disposeAllGroupKeys,
  _isGroupKeyCached, _groupKeyCacheSize,
} from '../src/crypto/groupCrypto';

/**
 * Audit P0-G2 — group master-key cache lifecycle.
 *
 * Bug closed:
 *   The CryptoKey cache was unbounded and had no explicit dispose.
 *   On every `applyAdminAction(rekey)` the previous key remained
 *   cached for the entire process lifetime; combined with any gap in
 *   P0-G1's epoch-AAD defence, a relay replay of pre-rekey ciphertext
 *   would `groupDecrypt` cleanly because the local cache still held
 *   the rotated-out key.
 *
 * Tests:
 *   1. groupEncrypt populates the cache for that key
 *   2. disposeGroupKey removes the named entry, keeping siblings
 *   3. disposeAllGroupKeys clears every entry
 *   4. LRU cap evicts oldest when MAX_CACHED_KEYS exceeded
 *   5. cache hit promotes the entry (least-recently-USED, not -INSERTED)
 *   6. disposeGroupKey on an unknown key is a harmless no-op
 *
 * Key bytes are random per test so the cache state from previous tests
 * cannot leak into this one. We still call `disposeAllGroupKeys` in a
 * beforeEach so the LRU-cap test starts from a clean slate.
 */

function randomKeyB64(): string {
  const u8 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {u8[i] = Math.floor(Math.random() * 256);}
  return Buffer.from(u8).toString('base64');
}

describe('audit P0-G2 — group key cache dispose + LRU', () => {
  beforeEach(() => { disposeAllGroupKeys(); });

  it('groupEncrypt populates the cache for that key', async () => {
    const k = randomKeyB64();
    expect(_isGroupKeyCached(k)).toBe(false);
    await groupEncrypt(k, 'hello');
    expect(_isGroupKeyCached(k)).toBe(true);
  });

  it('disposeGroupKey removes the named entry only', async () => {
    const a = randomKeyB64();
    const b = randomKeyB64();
    await groupEncrypt(a, 'x');
    await groupEncrypt(b, 'y');
    expect(_isGroupKeyCached(a)).toBe(true);
    expect(_isGroupKeyCached(b)).toBe(true);

    disposeGroupKey(a);

    expect(_isGroupKeyCached(a)).toBe(false);
    expect(_isGroupKeyCached(b)).toBe(true);
  });

  it('disposeAllGroupKeys clears every entry', async () => {
    const a = randomKeyB64();
    const b = randomKeyB64();
    const c = randomKeyB64();
    await groupEncrypt(a, 'x');
    await groupEncrypt(b, 'y');
    await groupEncrypt(c, 'z');
    expect(_groupKeyCacheSize()).toBe(3);

    disposeAllGroupKeys();

    expect(_groupKeyCacheSize()).toBe(0);
    expect(_isGroupKeyCached(a)).toBe(false);
    expect(_isGroupKeyCached(b)).toBe(false);
    expect(_isGroupKeyCached(c)).toBe(false);
  });

  it('LRU cap evicts the oldest entry when MAX_CACHED_KEYS exceeded', async () => {
    // MAX_CACHED_KEYS in source is 64; populate 65 distinct keys and
    // confirm the FIRST one we touched is gone, the LAST one is in.
    const keys: string[] = [];
    for (let i = 0; i < 65; i++) {
      const k = randomKeyB64();
      keys.push(k);
      await groupEncrypt(k, `m-${i}`);
    }
    // The first key inserted should have been evicted; size capped at 64.
    expect(_groupKeyCacheSize()).toBe(64);
    expect(_isGroupKeyCached(keys[0])).toBe(false);
    expect(_isGroupKeyCached(keys[64])).toBe(true);
  });

  it('cache hit promotes the entry (least-recently-USED, not -INSERTED)', async () => {
    // Insert 64 keys to fill the cache, then ACCESS the first one and
    // insert one MORE. The first key was touched most recently, so the
    // evictee should be the SECOND-inserted key (now the oldest), not
    // the first.
    const keys: string[] = [];
    for (let i = 0; i < 64; i++) {
      const k = randomKeyB64();
      keys.push(k);
      await groupEncrypt(k, `m-${i}`);
    }
    expect(_groupKeyCacheSize()).toBe(64);

    // Touch the first key → promotes it to MRU.
    await groupEncrypt(keys[0], 'promoted');

    // Add one more → cap exceeded. With LRU promotion, the OLDEST entry
    // is now keys[1], not keys[0].
    const overflow = randomKeyB64();
    await groupEncrypt(overflow, 'overflow');

    expect(_groupKeyCacheSize()).toBe(64);
    expect(_isGroupKeyCached(keys[0])).toBe(true);   // promoted → survives
    expect(_isGroupKeyCached(keys[1])).toBe(false);  // now-oldest → evicted
    expect(_isGroupKeyCached(overflow)).toBe(true);
  });

  it('disposeGroupKey on an unknown key is a harmless no-op', () => {
    expect(() => disposeGroupKey(randomKeyB64())).not.toThrow();
    expect(_groupKeyCacheSize()).toBe(0);
  });

  it('decrypt-after-dispose still works (importKey re-runs)', async () => {
    // Functional regression — disposing the cache must NOT lose access
    // to the key permanently. The key bytes still live in GroupState;
    // the next encrypt/decrypt rebuilds the cache entry.
    const k = randomKeyB64();
    const ct = await groupEncrypt(k, 'before-dispose');
    expect(_isGroupKeyCached(k)).toBe(true);

    disposeGroupKey(k);
    expect(_isGroupKeyCached(k)).toBe(false);

    // Decrypt forces a fresh importKey; result must still be correct
    // AND the cache is repopulated.
    const pt = await groupDecrypt(k, ct);
    expect(pt).toBe('before-dispose');
    expect(_isGroupKeyCached(k)).toBe(true);
  });
});
