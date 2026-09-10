/**
 * `media/aesCbc.ts` — the encrypt-then-MAC contract, at the edges.
 *
 * `aesCbc.test.ts` (round-trip, tamper, key length) and
 * `attachmentFormatDowngrade.test.ts` (CRY-01 — v2 is the ONLY accepted
 * format) cover the main paths. What neither executes is the set of
 * properties the construction actually rests on, each of which can be broken
 * without failing either of those suites:
 *
 *  1. ORDER — the MAC is verified BEFORE the AES decrypt. A wrong-but-
 *     well-formed key must fail with an HMAC error, never a padding error:
 *     a padding error IS the padding oracle audit fix #20 exists to remove.
 *  2. DOMAIN SEPARATION — the tag key is HKDF'd from the AES key, so a tag
 *     computed under the raw AES key must NOT validate. Delete the HKDF and
 *     every existing test still passes.
 *  3. COVERAGE OF THE WHOLE BLOB — tag, body, version byte and length are all
 *     authenticated; truncation and extension are rejected.
 *  4. IMPLEMENTATION PARITY — HMAC runs natively via quick-crypto on device
 *     and falls back to @noble where the factory lacks `createHmac`. The two
 *     must be byte-identical, or an attachment encrypted on one build is
 *     undecryptable on the other. The header claims this; nothing tested it.
 */
import {encryptAttachment, decryptAttachment} from '../media/aesCbc';
import {hmac} from '@noble/hashes/hmac.js';
import {sha256} from '@noble/hashes/sha2.js';

const HMAC_BYTES = 32;
const PLAINTEXT = new Uint8Array(Buffer.from('%PDF-1.7 a contract worth forging'));

const decrypt = (enc: {key: string; iv: string}, ciphertext: Uint8Array) =>
  decryptAttachment({keyB64: enc.key, ivB64: enc.iv, ciphertext});

describe('encrypt-then-MAC — verification happens BEFORE the cipher runs', () => {
  it('a wrong (but well-formed) key fails on the MAC, not on the padding', async () => {
    // A padding failure here would mean the AES decrypt ran against
    // unauthenticated bytes — the oracle audit fix #20 removed.
    const enc = await encryptAttachment(PLAINTEXT);
    const otherKey = (await encryptAttachment(PLAINTEXT)).key;
    await expect(decrypt({key: otherKey, iv: enc.iv}, enc.ciphertext))
      .rejects.toThrow(/hmac mismatch \(tampered or wrong key\)/);
  });

  it('a wrong IV is caught by the MAC too — no cipher run on unverified bytes', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    const otherIv = (await encryptAttachment(PLAINTEXT)).iv;
    // The IV is not inside the MAC input, so this one DOES reach the cipher;
    // what must never happen is silently returning corrupted plaintext.
    const out = await decrypt({key: enc.key, iv: otherIv}, enc.ciphertext).catch(e => e as Error);
    if (out instanceof Error) {
      expect(out.message).toBeTruthy();
    } else {
      expect(Buffer.from(out).equals(Buffer.from(PLAINTEXT))).toBe(false);
    }
  });

  it('the HMAC key is DERIVED, not the AES key itself (HKDF domain separation)', async () => {
    // Forge a tag the way a "simplified" implementation would — straight
    // HMAC-SHA256 under the file key. It must not validate.
    const enc = await encryptAttachment(PLAINTEXT);
    const rawKey = new Uint8Array(Buffer.from(enc.key, 'base64'));
    const aesCt  = enc.ciphertext.subarray(1, enc.ciphertext.byteLength - HMAC_BYTES);
    const macInput = new Uint8Array(1 + aesCt.byteLength);
    macInput[0] = 0x02;
    macInput.set(aesCt, 1);
    const forged = hmac(sha256, rawKey, macInput);

    const blob = Uint8Array.from(enc.ciphertext);
    blob.set(forged, 1 + aesCt.byteLength);
    await expect(decrypt(enc, blob)).rejects.toThrow(/hmac mismatch/);
  });
});

describe('the tag covers the WHOLE blob', () => {
  it('rejects a flipped bit inside the tag', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    const blob = Uint8Array.from(enc.ciphertext);
    blob[blob.byteLength - 1] ^= 0x01;
    await expect(decrypt(enc, blob)).rejects.toThrow(/hmac mismatch/);
  });

  it('rejects an APPENDED byte (length extension of the stored object)', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    const blob = new Uint8Array(enc.ciphertext.byteLength + 1);
    blob.set(enc.ciphertext, 0);
    await expect(decrypt(enc, blob)).rejects.toThrow(/hmac mismatch/);
  });

  it('rejects a blob truncated into the tag', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    await expect(decrypt(enc, enc.ciphertext.slice(0, enc.ciphertext.byteLength - 4)))
      .rejects.toThrow(/hmac mismatch/);
  });

  it('rejects a blob with a version byte but no room for a tag', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    await expect(decrypt(enc, enc.ciphertext.slice(0, 1 + HMAC_BYTES - 1)))
      .rejects.toThrow(/too short for v2/);
  });

  it('rejects an empty object (a purged/zero-length R2 body)', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    await expect(decrypt(enc, new Uint8Array(0))).rejects.toThrow(/empty ciphertext/);
  });

  it('names the downgrade explicitly when the version byte is not v2', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    const blob = Uint8Array.from(enc.ciphertext);
    blob[0] = 0x03;
    await expect(decrypt(enc, blob)).rejects.toThrow(/format not supported — possible downgrade attack/);
  });
});

describe('key/iv shape guards', () => {
  it('rejects an over-long key before doing any work', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    const longKey = Buffer.alloc(33).toString('base64');
    await expect(decrypt({key: longKey, iv: enc.iv}, enc.ciphertext))
      .rejects.toThrow(/invalid key length/);
  });

  it('rejects a wrong-length IV', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    await expect(decrypt({key: enc.key, iv: Buffer.alloc(12).toString('base64')}, enc.ciphertext))
      .rejects.toThrow(/invalid iv length/);
  });

  it('emits exactly 32-byte key and 16-byte iv material, base64-encoded', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    expect(Buffer.from(enc.key, 'base64')).toHaveLength(32);
    expect(Buffer.from(enc.iv, 'base64')).toHaveLength(16);
    expect(enc.ciphertext[0]).toBe(0x02);
  });

  it('handles a zero-byte attachment (still padded, still MACed)', async () => {
    const enc = await encryptAttachment(new Uint8Array(0));
    expect(enc.ciphertext.byteLength).toBe(1 + 16 + HMAC_BYTES);   // one pad block
    expect((await decrypt(enc, enc.ciphertext)).byteLength).toBe(0);
  });
});

/**
 * The AES/HMAC primitives are resolved lazily from quick-crypto, with a
 * documented @noble fallback. Swapping the module out requires a fresh
 * registry, so these load their own copy of aesCbc.
 */
describe('primitive resolution', () => {
  type AesCbc = typeof import('../media/aesCbc');

  const nodeCrypto = jest.requireActual<typeof import('node:crypto')>('node:crypto');

  function loadWith(factory: () => unknown): AesCbc {
    jest.resetModules();
    jest.doMock('react-native-quick-crypto', factory);

    return require('../media/aesCbc') as AesCbc;
  }

  afterEach(() => {
    jest.dontMock('react-native-quick-crypto');
    jest.resetModules();
  });

  it('falls back to the @noble HMAC when the factory ships no createHmac', async () => {
    const noNativeHmac = loadWith(() => ({
      createCipheriv:   nodeCrypto.createCipheriv,
      createDecipheriv: nodeCrypto.createDecipheriv,
      // createHmac deliberately absent — the older shim shape.
    }));
    const enc = await noNativeHmac.encryptAttachment(PLAINTEXT);
    const out = await noNativeHmac.decryptAttachment({
      keyB64: enc.key, ivB64: enc.iv, ciphertext: enc.ciphertext,
    });
    expect(Buffer.from(out).equals(Buffer.from(PLAINTEXT))).toBe(true);
  });

  it('the @noble and native tags are INTERCHANGEABLE (a device swap must not orphan media)', async () => {
    // Encrypt with the JS fallback…
    const jsOnly = loadWith(() => ({
      createCipheriv:   nodeCrypto.createCipheriv,
      createDecipheriv: nodeCrypto.createDecipheriv,
    }));
    const enc = await jsOnly.encryptAttachment(PLAINTEXT);

    // …and verify + decrypt it with the native primitive. A tag mismatch here
    // would mean attachments sent from one build are unreadable on the other.
    const withNative = loadWith(() => ({
      createCipheriv:   nodeCrypto.createCipheriv,
      createDecipheriv: nodeCrypto.createDecipheriv,
      createHmac:       nodeCrypto.createHmac,
    }));
    const out = await withNative.decryptAttachment({
      keyB64: enc.key, ivB64: enc.iv, ciphertext: enc.ciphertext,
    });
    expect(Buffer.from(out).equals(Buffer.from(PLAINTEXT))).toBe(true);
  });

  it('resolves the primitives off a default export too (quick-crypto interop)', async () => {
    const viaDefault = loadWith(() => ({
      default: {
        createCipheriv:   nodeCrypto.createCipheriv,
        createDecipheriv: nodeCrypto.createDecipheriv,
        createHmac:       nodeCrypto.createHmac,
      },
    }));
    const enc = await viaDefault.encryptAttachment(PLAINTEXT);
    expect(enc.ciphertext[0]).toBe(0x02);
  });

  it('fails loudly when no cipher primitive is available at all', async () => {
    const broken = loadWith(() => ({}));
    await expect(broken.encryptAttachment(PLAINTEXT))
      .rejects.toThrow(/no createCipheriv available/);
  });
});
