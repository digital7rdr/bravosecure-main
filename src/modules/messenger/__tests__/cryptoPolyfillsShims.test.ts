/**
 * `crypto/polyfills.ts` — the WebCrypto shims the whole app is keyed on, plus
 * the curve25519 verify-inversion convention they claim to guard.
 *
 * `index.js` line 1 is `import '@/modules/messenger/crypto/polyfills'`, so this
 * module runs before anything else on device. It had 0% executable coverage.
 * What lives inside it is not glue:
 *
 *   - an HMAC shim, because quick-crypto@0.7.17 leaves `case 'HMAC'`
 *     commented out in subtle.sign/verify. Every libsignal HKDF goes through it.
 *   - a SHA-1/256/384/512 digest shim routed to @noble/hashes, because
 *     quick-crypto's native EVP lookup throws "Invalid Hash Algorithm!".
 *     X3DH's SHA-512 goes through it, i.e. the FIRST message in any new chat.
 *   - a boot self-test that is supposed to make a broken crypto stack crash
 *     loudly instead of producing ciphertext nobody can decrypt.
 *
 * The tests execute the real module against the real @noble/hashes and the real
 * @privacyresearch/curve25519-typescript. Only quick-crypto is substituted (the
 * messenger-crypto project already maps it to Node's crypto), which is exactly
 * the edge that cannot exist off-device.
 *
 * CONTAINMENT: polyfills.ts mutates `globalThis.crypto.subtle` in place, and in
 * a Jest node environment that object can be shared with other suites in the
 * same worker. Every patched member's property descriptor is captured before
 * the import and restored in afterAll, so this file cannot leak a patched
 * SubtleCrypto into an unrelated suite (the B-126 cross-file-state class).
 */

import {createHmac, createHash} from 'node:crypto';

type Patchable = 'sign' | 'verify' | 'digest' | 'importKey';
const PATCHED: Patchable[] = ['sign', 'verify', 'digest', 'importKey'];

const savedSubtle: Partial<Record<Patchable, PropertyDescriptor | undefined>> = {};
let savedTextEncoder: unknown;
let savedTextDecoder: unknown;

let cryptoSelfTestFailed: () => boolean;

const hex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');

// Why: RN's TS config does not pull in the DOM lib that declares
// `AlgorithmIdentifier` / `CryptoKeyPair` — the same reason polyfills.ts
// declares its own local alias. Derive them from the members that DO resolve
// rather than adding to the typecheck baseline.
type DigestAlg = Parameters<SubtleCrypto['digest']>[0];
type KeyPair   = {privateKey: CryptoKey; publicKey: CryptoKey};

beforeAll(async () => {
  const subtle = globalThis.crypto.subtle as unknown as Record<string, unknown>;
  for (const k of PATCHED) {savedSubtle[k] = Object.getOwnPropertyDescriptor(subtle, k);}
  savedTextEncoder = (global as Record<string, unknown>).TextEncoder;
  savedTextDecoder = (global as Record<string, unknown>).TextDecoder;


  ({cryptoSelfTestFailed} = require('../crypto/polyfills'));

  // The module's self-tests are fire-and-forget async IIFEs; give them a turn.
  await new Promise(r => setTimeout(r, 0));
});

afterAll(() => {
  const subtle = globalThis.crypto.subtle as unknown as Record<string, unknown>;
  for (const k of PATCHED) {
    const d = savedSubtle[k];
    if (d) {Object.defineProperty(subtle, k, d);} else {delete subtle[k];}
  }
  (global as Record<string, unknown>).TextEncoder = savedTextEncoder;
  (global as Record<string, unknown>).TextDecoder = savedTextDecoder;
});

describe('digest shim — the four standard SHA algorithms', () => {
  // Known vectors. If @noble is ever swapped for something wrong, these are the
  // only assertions in the repo that would notice before ciphertext went out.
  it.each([
    ['SHA-1',   'a9993e364706816aba3e25717850c26c9cd0d89d'],
    ['SHA-256', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['SHA-384', 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed' +
                '8086072ba1e7cc2358baeca134c825a7'],
    ['SHA-512', 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
                '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f'],
  ])('digest("%s", "abc") matches the published vector', async (alg, want) => {
    const out = await crypto.subtle.digest(alg, new TextEncoder().encode('abc'));
    expect(hex(out)).toBe(want);
  });

  it('agrees with Node`s own implementation on a non-trivial input', async () => {
    const data = new Uint8Array(4096).map((_, i) => (i * 31) & 0xff);
    const out  = await crypto.subtle.digest('SHA-256', data);
    expect(hex(out)).toBe(createHash('sha256').update(Buffer.from(data)).digest('hex'));
  });

  it.each([
    ['lower-case hyphenated', 'sha-256'],
    ['un-hyphenated upper',   'SHA256'],
    ['un-hyphenated lower',   'sha256'],
    ['object form',           {name: 'SHA-256'}],
  ])('normalises the %s algorithm name to the same hasher', async (_l, alg) => {
    const out = await crypto.subtle.digest(alg as DigestAlg, new TextEncoder().encode('abc'));
    expect(hex(out)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('accepts an ArrayBuffer, a Uint8Array and an offset view of the same bytes', async () => {
    const backing = new Uint8Array([0, 0, 0x61, 0x62, 0x63]);        // padded 'abc'
    const view    = new Uint8Array(backing.buffer, 2, 3);
    const want    = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(hex(await crypto.subtle.digest('SHA-256', view))).toBe(want);
    expect(hex(await crypto.subtle.digest('SHA-256', view.slice().buffer))).toBe(want);
    expect(hex(await crypto.subtle.digest('SHA-256', new DataView(view.slice().buffer)))).toBe(want);
  });

  it('returns a DETACHED buffer — mutating the result cannot corrupt the next digest', async () => {
    const data  = new TextEncoder().encode('abc');
    const first = await crypto.subtle.digest('SHA-256', data);
    new Uint8Array(first).fill(0xff);
    const second = await crypto.subtle.digest('SHA-256', data);
    expect(hex(second)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('falls through to the original implementation for an algorithm it does not shim', async () => {
    await expect(crypto.subtle.digest('MD5' as unknown as DigestAlg,
      new Uint8Array([1]))).rejects.toBeDefined();
  });

  it('leaves the boot self-test flag clear when the digest path is healthy', () => {
    expect(cryptoSelfTestFailed()).toBe(false);
  });
});

describe('HMAC shim — subtle.sign / subtle.verify', () => {
  const KEY  = new Uint8Array(32).map((_, i) => i + 1);
  const DATA = new TextEncoder().encode('bravo message body');

  async function importHmac(hash: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', KEY, {name: 'HMAC', hash}, false, ['sign', 'verify']);
  }

  const nodeHmac = (alg: string) =>
    createHmac(alg, Buffer.from(KEY)).update(Buffer.from(DATA)).digest('hex');

  it.each(['SHA-256', 'SHA-512'])('sign() with %s matches Node`s HMAC byte for byte', async (h) => {
    const key = await importHmac(h);
    const sig = await crypto.subtle.sign({name: 'HMAC', hash: h}, key, DATA);
    expect(hex(sig)).toBe(nodeHmac(h.toLowerCase().replace('-', '')));
  });

  it('verify() accepts the signature sign() produced', async () => {
    const key = await importHmac('SHA-256');
    const sig = await crypto.subtle.sign({name: 'HMAC', hash: 'SHA-256'}, key, DATA);
    expect(await crypto.subtle.verify({name: 'HMAC', hash: 'SHA-256'}, key, sig, DATA)).toBe(true);
  });

  it('verify() rejects a single flipped bit', async () => {
    const key = await importHmac('SHA-256');
    const sig = new Uint8Array(await crypto.subtle.sign({name: 'HMAC', hash: 'SHA-256'}, key, DATA));
    sig[0] ^= 0x01;
    expect(await crypto.subtle.verify({name: 'HMAC', hash: 'SHA-256'}, key, sig, DATA)).toBe(false);
  });

  it('verify() rejects a truncated signature instead of throwing', async () => {
    // The length guard runs BEFORE the compare loop; without it the constant-
    // time XOR would read past the end and quietly return "equal".
    const key = await importHmac('SHA-256');
    const sig = new Uint8Array(await crypto.subtle.sign({name: 'HMAC', hash: 'SHA-256'}, key, DATA));
    expect(await crypto.subtle.verify({name: 'HMAC', hash: 'SHA-256'}, key, sig.slice(0, 16), DATA))
      .toBe(false);
  });

  it('verify() rejects the right signature over the WRONG data', async () => {
    const key = await importHmac('SHA-256');
    const sig = await crypto.subtle.sign({name: 'HMAC', hash: 'SHA-256'}, key, DATA);
    const other = new TextEncoder().encode('bravo message bodY');
    expect(await crypto.subtle.verify({name: 'HMAC', hash: 'SHA-256'}, key, sig, other)).toBe(false);
  });

  it('B-45 round 2 — STRING-form "HMAC" resolves the hash bound at importKey time', async () => {
    // Legal WebCrypto: the hash is a property of the KEY, so sign/verify may be
    // called with the bare string. Before the fix, hashName('HMAC') returned ''
    // → createHmac('') → native "Invalid Hash Algorithm!", which killed the
    // backup /verify proof. The hash must come from the imported key, and it
    // must be the RIGHT one — not a hardcoded sha256 fallback.
    const key512 = await importHmac('SHA-512');
    const sig    = await crypto.subtle.sign('HMAC', key512, DATA);
    expect(hex(sig)).toBe(nodeHmac('sha512'));
    expect(hex(sig)).not.toBe(nodeHmac('sha256'));
    expect(await crypto.subtle.verify('HMAC', key512, sig, DATA)).toBe(true);
  });

  it('string-form verify() also resolves the key`s hash, not the fallback', async () => {
    const key512 = await importHmac('SHA-512');
    const sig512 = Buffer.from(nodeHmac('sha512'), 'hex');
    expect(await crypto.subtle.verify('HMAC', key512, sig512, DATA)).toBe(true);
  });

  it('the shim is case-insensitive on the algorithm name', async () => {
    const key = await importHmac('SHA-256');
    const sig = await crypto.subtle.sign({name: 'hmac', hash: 'SHA-256'}, key, DATA);
    expect(hex(sig)).toBe(nodeHmac('sha256'));
  });

  it('fails LOUDLY for an HMAC key the importKey shim never saw', async () => {
    // The raw bytes are stashed at importKey time because libsignal imports the
    // key non-extractable. A key minted any other way has no bytes to reach, and
    // silently signing with the wrong secret would be far worse than throwing.
    const generated = await crypto.subtle.generateKey(
      {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify'],
    ) as CryptoKey;
    await expect(crypto.subtle.sign({name: 'HMAC', hash: 'SHA-256'}, generated, DATA))
      .rejects.toThrow(/HMAC key not tracked/);
  });

  it('does NOT intercept non-HMAC sign/verify — ECDSA still reaches the real impl', async () => {
    const pair = await crypto.subtle.generateKey(
      {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign', 'verify'],
    ) as KeyPair;
    const alg = {name: 'ECDSA', hash: 'SHA-256'};
    const sig = await crypto.subtle.sign(alg, pair.privateKey, DATA);
    expect(await crypto.subtle.verify(alg, pair.publicKey, sig, DATA)).toBe(true);
    const bad = new Uint8Array(sig);
    bad[0] ^= 0xff;
    expect(await crypto.subtle.verify(alg, pair.publicKey, bad, DATA)).toBe(false);
  });

  it('does not disturb AES-GCM importKey/encrypt (only raw HMAC keys are tracked)', async () => {
    const key = await crypto.subtle.importKey(
      'raw', new Uint8Array(32), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt'],
    );
    const iv = new Uint8Array(12);
    const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, DATA);
    const pt = await crypto.subtle.decrypt({name: 'AES-GCM', iv}, key, ct);
    expect(new TextDecoder().decode(pt)).toBe('bravo message body');
  });
});

/**
 * The security property polyfills.ts calls out by name.
 *
 * `AsyncCurve25519Wrapper.verify()` returns TRUTHY when a signature is INVALID
 * and FALSY when it is valid — the sync wrapper ships a `signatureIsValid`
 * helper that inverts it, the async one does not. `verifyXEd25519Signature`
 * inverts exactly once, and every sender-cert admission decision in the receive
 * path is that one `!`.
 *
 * If a dependency upgrade flips the convention, the inversion becomes
 * "truthy = valid" and `verifyXEd25519Signature` starts returning `{valid:true}`
 * for FORGED certs. Nothing else in the suite would notice.
 */
describe('curve25519 verify() — truthy means INVALID', () => {
  const load = () =>

    require('@privacyresearch/curve25519-typescript') as
      typeof import('@privacyresearch/curve25519-typescript');

  async function keyed() {
    const {AsyncCurve25519Wrapper} = load();
    const curve = new AsyncCurve25519Wrapper();
    const seed  = new Uint8Array(32);
    crypto.getRandomValues(seed);
    const kp   = await curve.keyPair(seed.buffer.slice(0) as ArrayBuffer);
    const msg  = new TextEncoder().encode('bravo-self-test');
    const msgAb = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) as ArrayBuffer;
    const sig  = await (curve as unknown as {
      sign: (p: ArrayBuffer, m: ArrayBuffer) => Promise<ArrayBuffer>;
    }).sign(kp.privKey, msgAb);
    return {curve, kp, msgAb, sig};
  }

  it('returns FALSY for a genuine signature', async () => {
    const {curve, kp, msgAb, sig} = await keyed();
    expect(await curve.verify(kp.pubKey, msgAb, sig)).toBeFalsy();
  });

  it('returns TRUTHY for a signature with one byte flipped', async () => {
    const {curve, kp, msgAb, sig} = await keyed();
    const bad = new Uint8Array(sig.byteLength);
    bad.set(new Uint8Array(sig));
    bad[0] ^= 0xff;
    expect(await curve.verify(kp.pubKey, msgAb, bad.buffer as ArrayBuffer)).toBeTruthy();
  });

  it('returns TRUTHY when the message was altered under a genuine signature', async () => {
    const {curve, kp, sig} = await keyed();
    const tampered = new TextEncoder().encode('bravo-self-tesT');
    const ab = tampered.buffer.slice(
      tampered.byteOffset, tampered.byteOffset + tampered.byteLength,
    ) as ArrayBuffer;
    expect(await curve.verify(kp.pubKey, ab, sig)).toBeTruthy();
  });

  it('returns TRUTHY when a different identity`s public key is presented', async () => {
    const a = await keyed();
    const b = await keyed();
    expect(await a.curve.verify(b.kp.pubKey, a.msgAb, a.sig)).toBeTruthy();
  });
});

describe('verifyXEd25519Signature — the single inversion every cert admission rests on', () => {
  async function material() {
    const {AsyncCurve25519Wrapper} =

      require('@privacyresearch/curve25519-typescript') as
        typeof import('@privacyresearch/curve25519-typescript');
    const curve = new AsyncCurve25519Wrapper();
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    const kp = await curve.keyPair(seed.buffer.slice(0) as ArrayBuffer);
    const m  = new TextEncoder().encode('cert.header.payload');
    const message = m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength) as ArrayBuffer;
    const signature = await (curve as unknown as {
      sign: (p: ArrayBuffer, msg: ArrayBuffer) => Promise<ArrayBuffer>;
    }).sign(kp.privKey, message);
    return {publicKey: kp.pubKey as ArrayBuffer, message, signature};
  }

  it('reports {valid:true} for a genuine signature and {valid:false} for a forged one', async () => {
    // Not re-exported from the package barrel — reach the shipping module directly.

    const {verifyXEd25519Signature} = require('@bravo/messenger-core/crypto/senderCert') as
      typeof import('@bravo/messenger-core/crypto/senderCert');
    const {publicKey, message, signature} = await material();

    expect(await verifyXEd25519Signature({publicKey, message, signature}))
      .toEqual({valid: true});

    const forged = new Uint8Array(signature.byteLength);
    forged.set(new Uint8Array(signature));
    forged[63] ^= 0x01;
    expect(await verifyXEd25519Signature({
      publicKey, message, signature: forged.buffer as ArrayBuffer,
    })).toEqual({valid: false});
  });
});

describe('the boot self-test that is supposed to guard the convention above', () => {
  it('cannot run against the INSTALLED wrapper build — it calls a method that is absent', () => {
    // polyfills.ts reaches for `curve.calculateSignature(...)`; the shipped
    // @privacyresearch/curve25519-typescript exposes `sign(...)` instead. The
    // call throws, lands in the catch, and only `console.warn`s — so
    // `__bravo_crypto_self_test_failed__` is NEVER set by the XEd25519 check
    // and a flipped convention would reach production silently. The four
    // `curve25519 verify()` tests above are the real guard today.
    //
    // If a dependency upgrade restores `calculateSignature`, this goes red —
    // read the comment, then delete this test because the boot check is live again.

    const {AsyncCurve25519Wrapper} = require('@privacyresearch/curve25519-typescript') as
      typeof import('@privacyresearch/curve25519-typescript');
    const curve = new AsyncCurve25519Wrapper() as unknown as Record<string, unknown>;
    expect(typeof curve.calculateSignature).toBe('undefined');
    expect(typeof curve.sign).toBe('function');
    // Consequence, stated as an assertion: nothing set the failure flag.
    expect(cryptoSelfTestFailed()).toBe(false);
  });
});

describe('W5/B-688 — native-preferred digest selection (_selectHashers)', () => {
  const {_selectHashers} = require('../crypto/polyfills') as typeof import('../crypto/polyfills');
  const noble: Record<string, (d: Uint8Array) => Uint8Array> = {
    'SHA-1':   d => createHash('sha1').update(d).digest(),
    'SHA-256': d => createHash('sha256').update(d).digest(),
    'SHA-384': d => createHash('sha384').update(d).digest(),
    'SHA-512': d => createHash('sha512').update(d).digest(),
  };
  const nodeCreate = (alg: string) => {
    const h = createHash(alg);
    return {update: (d: unknown) => h.update(d as Uint8Array), digest: () => new Uint8Array(h.digest())};
  };

  it('a WORKING native createHash wins all four algorithms', () => {
    const {nativeNames, hashers} = _selectHashers(nodeCreate, noble);
    expect(nativeNames.sort()).toEqual(['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']);
    const out = hashers['SHA-256'](new Uint8Array([0x61, 0x62, 0x63]));
    expect(Buffer.from(out).toString('hex'))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('a THROWING native path keeps the pure-JS fallback (the shipped-device case)', () => {
    const {nativeNames, hashers} = _selectHashers(() => { throw new Error('Invalid Hash Algorithm!'); }, noble);
    expect(nativeNames).toEqual([]);
    expect(Buffer.from(hashers['SHA-512'](new Uint8Array([0x61, 0x62, 0x63]))).toString('hex'))
      .toBe(createHash('sha512').update('abc').digest('hex'));
  });

  it('a LYING native path (wrong bytes) is rejected per algorithm', () => {
    const lying = (alg: string) =>
      alg === 'sha256'
        ? {update: () => undefined, digest: () => new Uint8Array(32)}   // wrong bytes
        : nodeCreate(alg);
    const {nativeNames} = _selectHashers(lying as never, noble);
    expect(nativeNames).not.toContain('SHA-256');
    expect(nativeNames).toContain('SHA-512');
  });

  it('no createHash at all keeps every @noble fallback', () => {
    const {nativeNames, hashers} = _selectHashers(undefined, noble);
    expect(nativeNames).toEqual([]);
    expect(Object.keys(hashers).sort()).toEqual(['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']);
  });
});

describe('W5/B-688 — hybrid text codec', () => {
  const {isUtf8Label} = require('../crypto/polyfills') as typeof import('../crypto/polyfills');

  it('isUtf8Label accepts the utf-8 spellings and nothing else', () => {
    for (const yes of [undefined, 'utf-8', 'UTF-8', 'utf8', ' Unicode-1-1-utf-8 ']) {
      expect(isUtf8Label(yes as string | undefined)).toBe(true);
    }
    for (const no of ['utf-16le', 'utf-16be', 'iso-8859-1', 'windows-1252', 'ascii']) {
      expect(isUtf8Label(no)).toBe(false);
    }
  });

  it('utf-8 round-trips through the installed globals', () => {
    const s = 'héllo — ✓ 你好 𐍈';
    const bytes = new TextEncoder().encode(s);
    expect(new TextDecoder().decode(bytes)).toBe(s);
    expect(new TextDecoder('utf-8').decode(bytes)).toBe(s);
  });

  it('utf-16le still decodes (the jose/op-sqlite contract the polyfill exists for)', () => {
    // 'AB' in utf-16le: 0x41 0x00 0x42 0x00
    const out = new TextDecoder('utf-16le').decode(new Uint8Array([0x41, 0x00, 0x42, 0x00]));
    expect(out).toBe('AB');
  });

  it('option-carrying utf-8 constructions still honor fatal (routed to the polyfill)', () => {
    const dec = new TextDecoder('utf-8', {fatal: true});
    expect(() => dec.decode(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
  });
});

describe('W5/B-688 — the @noble-selected FULL digest path (the broken-device shape)', () => {
  // Critic F6 — with the stub's WORKING createHash, every earlier digest test
  // exercises the native branch; this one re-imports polyfills with a
  // THROWING createHash so subtle.digest runs the @noble-selected path end to
  // end — exactly what ships on a device where the native probe fails.
  // Placed LAST in the file on purpose: the re-import re-wraps the global
  // subtle, and the afterAll restore still puts the originals back.
  it('subtle.digest agrees with node:crypto when every native probe throws', async () => {
    let digestOut: ArrayBuffer | null = null;
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        jest.doMock('react-native-quick-crypto', () => {
          const {createHmac: nodeHmac} = require('node:crypto');
          const throwing = () => { throw new Error('Invalid Hash Algorithm!'); };
          return {
            __esModule: true,
            install: () => {},
            createHmac: nodeHmac,
            createHash: throwing,
            default: {install: () => {}, createHmac: nodeHmac, createHash: throwing},
          };
        });
        require('../crypto/polyfills');
        void (async () => {
          try {
            digestOut = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('noble path proof'));
            resolve();
          } catch (e) { reject(e as Error); }
        })();
      });
    });
    expect(Buffer.from(digestOut!).toString('hex'))
      .toBe(createHash('sha256').update('noble path proof').digest('hex'));
  });
});
