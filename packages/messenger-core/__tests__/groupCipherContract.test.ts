/**
 * groupCrypto — the AES-256-GCM contract for the group master key.
 *
 * This is the SHIPPING copy (`packages/messenger-core/src/crypto/groupCrypto.ts`,
 * consumed as `@bravo/messenger-core`); the near-identical file under
 * `src/modules/messenger/crypto/groupCrypto.ts` is a diverged fork that
 * production does not import.
 *
 * What was already pinned before this file: `groupKeyDispose.test.ts` covers the
 * P0-G2 cache LIFECYCLE (dispose / LRU cap / promotion) and `groupBroadcast.test.ts`
 * exercises one rekey round-trip. What NOTHING executed was the cipher contract
 * itself and every failure branch:
 *
 *   - the key-length gate (`must be 32 bytes`)
 *   - the rejected-import cache eviction (`promise.catch(() => keyCache.delete)`)
 *   - `groupDecrypt`'s catch → CryptoError for wrong key / tampered ct / tampered IV
 *   - `isGroupCiphertext`'s null / primitive / partial-shape branches
 *   - the "never reuse an IV" property that the whole GCM security argument rests on
 *
 * Every test here runs the real WebCrypto AES-GCM — no mocks.
 */

import {
  groupEncrypt, groupDecrypt, isGroupCiphertext,
  disposeAllGroupKeys, _isGroupKeyCached,
} from '../src/crypto/groupCrypto';
import {CryptoError} from '../src/crypto/errors';

function randomKeyB64(bytes = 32): string {
  const u8 = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {u8[i] = Math.floor(Math.random() * 256);}
  return Buffer.from(u8).toString('base64');
}

describe('groupCrypto — AES-256-GCM round trip', () => {
  beforeEach(() => { disposeAllGroupKeys(); });

  it('round-trips a utf-8 body through the master key', async () => {
    const key = randomKeyB64();
    const ct = await groupEncrypt(key, 'mission brief: RV at 0800');
    expect(await groupDecrypt(key, ct)).toBe('mission brief: RV at 0800');
  });

  it('round-trips an empty body — an attachment-only group post has no text', async () => {
    const key = randomKeyB64();
    const ct = await groupEncrypt(key, '');
    expect(await groupDecrypt(key, ct)).toBe('');
  });

  it('round-trips non-latin text and emoji without mangling code points', async () => {
    const key = randomKeyB64();
    const body = 'مرحبا — принято ✅🛡️ 東京';
    expect(await groupDecrypt(key, await groupEncrypt(key, body))).toBe(body);
  });

  it('emits a 12-byte IV and a ciphertext longer than the plaintext (GCM tag suffix)', async () => {
    const key = randomKeyB64();
    const ct = await groupEncrypt(key, 'abcdefgh');
    expect(Buffer.from(ct.i, 'base64')).toHaveLength(12);
    // 8 bytes plaintext + 16-byte GCM tag.
    expect(Buffer.from(ct.c, 'base64')).toHaveLength(8 + 16);
  });

  it('never reuses an IV across calls on the same key — the GCM security bound', async () => {
    const key = randomKeyB64();
    const ivs = new Set<string>();
    const cts = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const out = await groupEncrypt(key, 'same body every time');
      ivs.add(out.i);
      cts.add(out.c);
    }
    expect(ivs.size).toBe(32);
    // Fresh IV ⇒ the identical plaintext must not produce identical bytes.
    expect(cts.size).toBe(32);
  });
});

describe('groupCrypto — key validation', () => {
  beforeEach(() => { disposeAllGroupKeys(); });

  it.each([
    ['16 bytes (AES-128-sized)', 16],
    ['31 bytes (one short)',     31],
    ['33 bytes (one long)',      33],
    ['0 bytes (empty)',          0],
  ])('rejects a master key of %s with a CryptoError naming the byte count', async (_label, len) => {
    const bad = randomKeyB64(len);
    await expect(groupEncrypt(bad, 'x')).rejects.toBeInstanceOf(CryptoError);
    await expect(groupEncrypt(bad, 'x')).rejects.toThrow(
      new RegExp(`group key must be 32 bytes; got ${len}`),
    );
  });

  it('does NOT pin a rejected import in the cache — a bad key must not poison the slot', async () => {
    // The cache stores the in-flight PROMISE, so without the
    // `promise.catch(() => keyCache.delete(keyB64))` line a single transient
    // importKey failure would make that key permanently unusable for the
    // life of the process, even after the caller fixed it.
    const bad = randomKeyB64(16);
    await expect(groupEncrypt(bad, 'x')).rejects.toBeInstanceOf(CryptoError);
    // Let the rejection handler's microtask land.
    await Promise.resolve();
    expect(_isGroupKeyCached(bad)).toBe(false);
  });

  it('rejects a key that is not valid base64 of 32 bytes', async () => {
    await expect(groupEncrypt('not-a-key', 'x')).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('groupCrypto — decrypt fails closed', () => {
  beforeEach(() => { disposeAllGroupKeys(); });

  it('rejects ciphertext under a DIFFERENT master key (post-rekey replay)', async () => {
    const oldKey = randomKeyB64();
    const newKey = randomKeyB64();
    const ct = await groupEncrypt(oldKey, 'pre-rekey secret');
    await expect(groupDecrypt(newKey, ct)).rejects.toBeInstanceOf(CryptoError);
    await expect(groupDecrypt(newKey, ct)).rejects.toThrow(/wrong key or tampered ciphertext/);
  });

  it('rejects a ciphertext with a flipped bit — the GCM tag must catch tampering', async () => {
    const key = randomKeyB64();
    const ct = await groupEncrypt(key, 'authenticated body');
    const bytes = Buffer.from(ct.c, 'base64');
    bytes[0] ^= 0xff;
    await expect(groupDecrypt(key, {...ct, c: bytes.toString('base64')}))
      .rejects.toBeInstanceOf(CryptoError);
  });

  it('rejects a ciphertext whose GCM TAG (last 16 bytes) was truncated', async () => {
    const key = randomKeyB64();
    const ct = await groupEncrypt(key, 'authenticated body');
    const bytes = Buffer.from(ct.c, 'base64');
    await expect(groupDecrypt(key, {...ct, c: bytes.subarray(0, bytes.length - 4).toString('base64')}))
      .rejects.toBeInstanceOf(CryptoError);
  });

  it('rejects when the IV was swapped for another message`s IV', async () => {
    const key = randomKeyB64();
    const a = await groupEncrypt(key, 'message A');
    const b = await groupEncrypt(key, 'message B');
    await expect(groupDecrypt(key, {c: a.c, i: b.i})).rejects.toBeInstanceOf(CryptoError);
  });

  it('wraps the underlying WebCrypto failure as `cause` rather than swallowing it', async () => {
    const key = randomKeyB64();
    const ct = await groupEncrypt(key, 'body');
    const err = await groupDecrypt(randomKeyB64(), ct).catch(e => e as CryptoError);
    expect(err).toBeInstanceOf(CryptoError);
    // errors.ts keeps the original on the instance; assert it is not lost.
    expect((err as unknown as {cause?: unknown}).cause).toBeDefined();
  });
});

describe('isGroupCiphertext — the mixed-fleet type guard', () => {
  it('accepts a real groupEncrypt output', async () => {
    const out = await groupEncrypt(randomKeyB64(), 'hi');
    expect(isGroupCiphertext(out)).toBe(true);
  });

  it.each([
    ['null',              null],
    ['undefined',         undefined],
    ['a string',          'ciphertext'],
    ['a number',          42],
    ['a boolean',         true],
    ['an empty object',   {}],
    ['only c',            {c: 'aa'}],
    ['only i',            {i: 'bb'}],
    ['c not a string',    {c: 1, i: 'bb'}],
    ['i not a string',    {c: 'aa', i: 1}],
    ['legacy plaintext',  {body: 'hello', kind: 'text'}],
  ])('rejects %s', (_label, value) => {
    expect(isGroupCiphertext(value)).toBe(false);
  });

  it('accepts an array only when it carries both string fields — arrays are objects', () => {
    // Documents the guard`s actual reach: it is a shape check, not a class
    // check. An array without c/i is refused, which is what receive-time
    // dispatch relies on.
    expect(isGroupCiphertext([])).toBe(false);
  });
});
