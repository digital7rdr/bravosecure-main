/**
 * React Native crypto polyfills. Import exactly once at app entry
 * BEFORE any messenger/crypto code runs. Node tests do not use this —
 * they inherit the real crypto + Buffer from the runtime.
 *
 * Order matters:
 *   1. `text-encoding` — installs TextEncoder/TextDecoder globals with
 *      FULL encoding support (utf-8 + utf-16le/be + others). Required
 *      BEFORE any module that constructs a TextDecoder at import time —
 *      `jose`, `op-sqlite`, and RN's Blob internals all do. The lighter
 *      `fast-text-encoding` only supports utf-8 and breaks anything
 *      asking for utf-16le.
 *   2. `react-native-get-random-values` — installs crypto.getRandomValues
 *      BEFORE quick-crypto's key generation calls into it during setup.
 *   3. Buffer global (via `@craftzdog/react-native-buffer`).
 *   4. quick-crypto install — WebCrypto `crypto.subtle`.
 */

// text-encoding only installs its globals when `global.TextDecoder` is absent
// (`if (!global['TextDecoder']) global['TextDecoder'] = TextDecoder`). Hermes
// pre-populates global.TextDecoder with a utf-8-only built-in, so the polyfill
// is silently skipped and the package re-exports Hermes's broken version.
// Delete the builtins first so text-encoding is forced to install its own
// full-encoding implementation (utf-8 + utf-16le/be + all others).

const g = global as Record<string, unknown>;
// W5/B-688 — capture Hermes's NATIVE utf-8 pair BEFORE deleting. The old fix
// deleted the builtins wholesale (jose/op-sqlite need utf-16le, which Hermes
// lacks) and installed pure-JS `text-encoding` app-wide — taxing every utf-8
// encode/decode on the messenger hot paths (sealed-sender, group crypto,
// Merkle leaves; ~2.6 ms per 100 KB measured on the reference device). The
// hybrid below keeps native for utf-8 — byte-identical BY SPEC — and
// delegates every other label (and any option-carrying construction) to the
// full polyfill. Founder-approved W5, 2026-08-29; implementation-only.
const NativeTextEncoder = g.TextEncoder as (typeof globalThis.TextEncoder) | undefined;
const NativeTextDecoder = g.TextDecoder as (typeof globalThis.TextDecoder) | undefined;
delete g.TextEncoder;
delete g.TextDecoder;
const {TextEncoder: PolyTextEncoder, TextDecoder: PolyTextDecoder} = require('text-encoding') as {
  TextEncoder: typeof globalThis.TextEncoder;
  TextDecoder: typeof globalThis.TextDecoder;
};

/** W5/B-688 — the labels the native (utf-8-only) decoder may serve. */
export function isUtf8Label(label?: string): boolean {
  const l = (label ?? 'utf-8').toLowerCase().trim();
  return l === 'utf-8' || l === 'utf8' || l === 'unicode-1-1-utf-8';
}

// TextEncoder is utf-8-only BY SPEC — the native one is always right.
g.TextEncoder = NativeTextEncoder ?? PolyTextEncoder;
// TextDecoder: pick the implementation per label at construction. Options
// (fatal / ignoreBOM) also route to the polyfill — Hermes's builtin predates
// full option support, and the hot paths construct bare decoders. A
// constructor returning a foreign instance breaks `instanceof TextDecoder`
// for the native branch; no bundled consumer does that check.
function HybridTextDecoder(this: unknown, label?: string, options?: Record<string, unknown>): globalThis.TextDecoder {
  const bareOptions = options === undefined || Object.keys(options).length === 0;
  if (NativeTextDecoder && isUtf8Label(label) && bareOptions) {
    // Label-less on purpose (critic F4): every label isUtf8Label admits means
    // utf-8, and Hermes's builtin may not accept alias spellings ('utf8').
    return new NativeTextDecoder();
  }
  return new PolyTextDecoder(label, options);
}
g.TextDecoder = HybridTextDecoder as unknown as typeof globalThis.TextDecoder;

require('react-native-get-random-values');
const {Buffer} = require('@craftzdog/react-native-buffer') as {Buffer: typeof import('@craftzdog/react-native-buffer').Buffer};
// Why: react-native-quick-crypto's TS types don't always expose
// `createHmac` at the top level (only via subpaths in newer versions).
// Cast through unknown to a minimal shape so polyfills.ts compiles
// against whatever quick-crypto build is installed. Runtime behaviour
// is unchanged.
const _qc = require('react-native-quick-crypto') as unknown as {
  install: () => void;
  createHmac?: (alg: string, key: unknown) => unknown;
  createHash?: (alg: string) => {update: (d: unknown) => unknown; digest: () => Uint8Array};
};
const installQuickCrypto = _qc.install;
const createHmac = _qc.createHmac as (alg: string, key: unknown) => HmacLike;

// Local alias for the WebCrypto AlgorithmIdentifier union — Hermes/RN
// TS doesn't always pull in the DOM lib that defines it, but every
// modern WebCrypto runtime treats these inputs identically.
type AlgorithmIdentifier = string | {name: string; [k: string]: unknown};

if (typeof (global as { Buffer?: unknown }).Buffer === 'undefined') {
  (global as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

installQuickCrypto();

// ── HMAC shim for subtle.sign / subtle.verify ─────────────────────────
// quick-crypto@0.7.17 leaves `case 'HMAC'` commented-out in its
// subtle.sign/verify impls, so libsignal's HKDF (which calls
// subtle.sign({name:'HMAC', hash:'SHA-256'}, key, data)) throws
// "Unrecognized algorithm name '[object Object]' for 'sign'".
// Route HMAC ops through quick-crypto's Node-style createHmac API.
//
// We can't exportKey('raw') on the HMAC key because libsignal imports
// it non-extractable — so instead we intercept importKey and stash the
// raw bytes in a WeakMap keyed by the returned CryptoKey, then look
// them up in sign/verify. ECDSA / AES paths are untouched.
// Why: use `unknown` for the Buffer-shaped params so the type stays
// compatible with both the @craftzdog/react-native-buffer Buffer and
// Node's Buffer<ArrayBufferLike> generic — they're interchangeable at
// runtime but TS treats them as distinct due to the generic parameter.
type HmacLike = {update: (d: unknown) => HmacLike; digest: () => Uint8Array};

{
  const subtle: SubtleCrypto | undefined = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle) {
    const origSign = subtle.sign.bind(subtle);
    const origVerify = subtle.verify.bind(subtle);
    const origImportKey = subtle.importKey.bind(subtle);

    const hmacKeyBytes = new WeakMap<CryptoKey, Uint8Array>();
    // B-45 round 2 — hash bound at importKey time, so a STRING-form
    // sign/verify ('HMAC' with no hash field — legal WebCrypto, the hash
    // is a key property) resolves to the imported hash instead of ''.
    // Previously hashName('HMAC') returned '' → createHmac('') → native
    // "Invalid Hash Algorithm!" (killed the backup /verify proof).
    const hmacKeyHashName = new WeakMap<CryptoKey, string>();

    const algName = (alg: AlgorithmIdentifier): string =>
      typeof alg === 'string' ? alg : alg?.name ?? '';
    const hashName = (alg: AlgorithmIdentifier): string => {
      const h = typeof alg === 'string' ? '' : (alg as {hash?: AlgorithmIdentifier}).hash;
      const raw = typeof h === 'string' ? h : (h as {name?: string} | undefined)?.name ?? 'SHA-256';
      return raw.toLowerCase().replace('-', '');
    };
    const hashNameFor = (alg: AlgorithmIdentifier, key: CryptoKey): string =>
      hashName(alg) || hmacKeyHashName.get(key) || 'sha256';

    const hmacCreate = createHmac as unknown as (alg: string, key: unknown) => HmacLike;

    subtle.importKey = async function (format, keyData, algorithm, extractable, keyUsages) {
      const key = await origImportKey(
        format as Parameters<typeof origImportKey>[0],
        keyData as Parameters<typeof origImportKey>[1],
        algorithm as Parameters<typeof origImportKey>[2],
        extractable,
        keyUsages,
      );
      if (format === 'raw' && algName(algorithm as AlgorithmIdentifier).toUpperCase() === 'HMAC') {
        // Snapshot the raw secret so sign/verify can reach it even though
        // quick-crypto may mark the CryptoKey non-extractable.
        const src = keyData as ArrayBuffer | ArrayBufferView;
        const bytes = ArrayBuffer.isView(src)
          ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice()
          : new Uint8Array(src as ArrayBuffer).slice();
        hmacKeyBytes.set(key, bytes);
        hmacKeyHashName.set(key, hashName(algorithm as AlgorithmIdentifier));
      }
      return key;
    } as typeof subtle.importKey;

    function hmacKey(key: CryptoKey): unknown {
      const bytes = hmacKeyBytes.get(key);
      if (!bytes) {throw new Error('HMAC key not tracked — imported before polyfill shim installed');}
      return Buffer.from(bytes);
    }

    subtle.sign = async function (algorithm, key, data) {
      if (algName(algorithm as AlgorithmIdentifier).toUpperCase() === 'HMAC') {
        const hmac = hmacCreate(hashNameFor(algorithm as AlgorithmIdentifier, key), hmacKey(key));
        hmac.update(Buffer.from(data as ArrayBuffer));
        const out = hmac.digest();
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      }
      return origSign(algorithm as AlgorithmIdentifier, key, data);
    } as typeof subtle.sign;

    subtle.verify = async function (algorithm, key, signature, data) {
      if (algName(algorithm as AlgorithmIdentifier).toUpperCase() === 'HMAC') {
        const hmac = hmacCreate(hashNameFor(algorithm as AlgorithmIdentifier, key), hmacKey(key));
        hmac.update(Buffer.from(data as ArrayBuffer));
        const expected = hmac.digest();
        const actual = Buffer.from(signature as ArrayBuffer);
        if (expected.length !== actual.length) {return false;}
        let diff = 0;
        for (let i = 0; i < expected.length; i++) {diff |= expected[i] ^ actual[i];}
        return diff === 0;
      }
      return origVerify(algorithm as AlgorithmIdentifier, key, signature, data);
    } as typeof subtle.verify;
  }
}

// ── Digest shim for SHA-1 / SHA-256 / SHA-384 / SHA-512 ───────────────
// quick-crypto's MGLHashHostObject calls `EVP_get_digestbyname()` on its
// bundled OpenSSL/BoringSSL, which returns null for standard SHA names
// and throws "Invalid Hash Algorithm!" — the symmetric digest of HMAC's
// hardcoded fallback. libsignal's X3DH session-build calls
// `subtle.digest({name:'SHA-512'},…)`, so the very first message in any
// new chat fails. Route the four standard SHA digests through
// @noble/hashes (pure JS, audited) which doesn't touch the broken native
// path. Anything else falls through to the original (AES-GCM keys, etc).
/**
 * W5/B-688 — per-algorithm hasher selection, native-preferred. quick-crypto's
 * SUBTLE digest path is broken (EVP_get_digestbyname → null, the reason this
 * shim exists), but its Node-style twin resolves names differently —
 * `createHmac('sha256')` already works natively (B-45). So: try
 * `createHash` per algorithm, verify each against the FIPS "abc" test
 * vector, and keep the pure-JS @noble hasher for any algorithm whose native
 * path throws OR returns wrong bytes. Same algorithms either way —
 * implementation selection only, proven at boot, per name. Exported for the
 * cryptoPolyfillsShims suite (working / throwing / lying fakes).
 */
export function _selectHashers(
  createHash: ((alg: string) => {update: (d: unknown) => unknown; digest: () => Uint8Array}) | undefined,
  nobleHashers: Record<string, (d: Uint8Array) => Uint8Array>,
): {hashers: Record<string, (d: Uint8Array) => Uint8Array>; nativeNames: string[]} {
  const ABC = new Uint8Array([0x61, 0x62, 0x63]);
  const VECTORS: Record<string, {node: string; abcHex: string}> = {
    'SHA-1':   {node: 'sha1',   abcHex: 'a9993e364706816aba3e25717850c26c9cd0d89d'},
    'SHA-256': {node: 'sha256', abcHex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'},
    'SHA-384': {node: 'sha384', abcHex: 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7'},
    'SHA-512': {node: 'sha512', abcHex: 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f'},
  };
  const hex = (u: Uint8Array): string => Array.from(u, b => b.toString(16).padStart(2, '0')).join('');
  const hashers: Record<string, (d: Uint8Array) => Uint8Array> = {...nobleHashers};
  const nativeNames: string[] = [];
  if (createHash) {
    for (const [name, v] of Object.entries(VECTORS)) {
      try {
        const probe = createHash(v.node);
        probe.update(ABC);
        const out = probe.digest();
        if (hex(new Uint8Array(out.buffer ?? out, out.byteOffset ?? 0, out.byteLength)) === v.abcHex) {
          hashers[name] = (d: Uint8Array): Uint8Array => {
            const h = createHash(v.node);
            h.update(d);
            const o = h.digest();
            return new Uint8Array(o.buffer ?? o, o.byteOffset ?? 0, o.byteLength);
          };
          nativeNames.push(name);
        }
      } catch { /* this algorithm keeps the @noble fallback */ }
    }
  }
  return {hashers, nativeNames};
}

{
  const subtle: SubtleCrypto | undefined = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle) {

    const {sha256, sha384, sha512} = require('@noble/hashes/sha2.js') as typeof import('@noble/hashes/sha2.js');
    const {sha1} = require('@noble/hashes/legacy.js') as typeof import('@noble/hashes/legacy.js');


    const origDigest = subtle.digest.bind(subtle);

    const {hashers, nativeNames} = _selectHashers(_qc.createHash, {
      'SHA-1':   sha1   as unknown as (d: Uint8Array) => Uint8Array,
      'SHA-256': sha256 as unknown as (d: Uint8Array) => Uint8Array,
      'SHA-384': sha384 as unknown as (d: Uint8Array) => Uint8Array,
      'SHA-512': sha512 as unknown as (d: Uint8Array) => Uint8Array,
    });
    // Counts only (I9). `native=0/4` on a device means the quick-crypto
    // Node-API digest is as broken as the subtle one — the honest signal
    // that W5's remaining win needs the library upgrade, not this shim.
    console.warn(`[crypto/polyfills] digest impl: native=${nativeNames.length}/4 (${nativeNames.join(',') || 'none'}), rest pure-JS`);

    const digestAlgName = (alg: AlgorithmIdentifier): string => {
      const raw = typeof alg === 'string' ? alg : (alg as {name?: string})?.name ?? '';
      // Accept 'sha-256', 'SHA256', 'SHA-256' — normalise to the canonical
      // hyphenated upper form used as our lookup key.
      const upper = raw.toUpperCase();
      const m = /^SHA-?(\d+)$/.exec(upper);
      return m ? `SHA-${m[1]}` : upper;
    };

    const toUint8 = (data: BufferSource | Uint8Array): Uint8Array => {
      if (data instanceof Uint8Array) {return data;}
      if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      }
      return new Uint8Array(data as ArrayBuffer);
    };

    const shimmedDigest = (async function (algorithm: AlgorithmIdentifier, data: BufferSource) {
      const name = digestAlgName(algorithm);
      const hasher = hashers[name];
      if (hasher) {
        const out = hasher(toUint8(data));
        // Return a real ArrayBuffer (slice() detaches from the typed-array
        // view so callers that mutate the buffer don't corrupt @noble's
        // internal state).
        const ab = new ArrayBuffer(out.byteLength);
        new Uint8Array(ab).set(out);
        return ab;
      }
      return origDigest(algorithm, data as Parameters<typeof origDigest>[1]);
    }) as typeof subtle.digest;

    // Use Object.defineProperty rather than plain assignment so we can
    // override even if quick-crypto declared `digest` as non-writable.
    try {
      Object.defineProperty(subtle, 'digest', {
        value:        shimmedDigest,
        writable:     true,
        configurable: true,
        enumerable:   true,
      });
    } catch {
      // Fall back to plain assignment.
      subtle.digest = shimmedDigest;
    }

    // Boot-time self-test: SHA-256("abc") == ba78… If this throws or
    // returns the wrong bytes, polyfills.ts didn't actually wire up the
    // shim — every later send will fail with the same hash error.
    // Crash loudly here rather than silently breaking encryption.
    //
    // Audit fix #7 — set a global flag so the async self-test result
    // can gate identity install / first-send. Previously the test only
    // logged on failure, leaving the app to attempt encryption against
    // a broken digest implementation and produce ciphertext nobody
    // could decrypt. Callers can now check `cryptoSelfTestFailed()`
    // and refuse to boot when crypto is non-functional.
    void (async () => {
      try {
        const test = await (globalThis.crypto as Crypto).subtle.digest(
          'SHA-256',
          new TextEncoder().encode('abc'),
        );
        const hex = Array.from(new Uint8Array(test))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        const want = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
        if (hex !== want) {
          (globalThis as Record<string, unknown>).__bravo_crypto_self_test_failed__ = true;
          console.error('[crypto/polyfills] SHA-256 self-test FAILED', {got: hex, want});
        } else {
          console.log('[crypto/polyfills] @noble/hashes digest shim ACTIVE — SHA-256("abc") OK');
        }
      } catch (e) {
        (globalThis as Record<string, unknown>).__bravo_crypto_self_test_failed__ = true;
        console.error('[crypto/polyfills] SHA-256 self-test threw', e);
      }
    })();

    // Inject a custom crypto object into libsignal so its X3DH SHA-512
    // path doesn't depend on `globalThis.crypto.subtle.digest` being
    // patched (belt-and-suspenders). The wrapper exposes the SAME shim
    // for digest, and delegates everything else to globalThis.crypto.
    try {

      const libsignal = require('@privacyresearch/libsignal-protocol-typescript') as typeof import('@privacyresearch/libsignal-protocol-typescript');

      const sub = (globalThis.crypto as Crypto).subtle;
      // Why: SubtleCrypto's TS type acquires new methods over time
      // (post-quantum decapsulate*/encapsulate*/getPublicKey, etc.).
      // libsignal only consumes the classical subset, so it's safe to
      // cast through unknown rather than enumerate every new method
      // for each lib upgrade.
      const wrappedSubtle = ({
        digest:    shimmedDigest,
        importKey: sub.importKey.bind(sub),
        encrypt:   sub.encrypt.bind(sub),
        decrypt:   sub.decrypt.bind(sub),
        sign:      sub.sign.bind(sub),
        verify:    sub.verify.bind(sub),
        deriveKey:  sub.deriveKey?.bind(sub),
        deriveBits: sub.deriveBits?.bind(sub),
        exportKey:  sub.exportKey?.bind(sub),
        generateKey: sub.generateKey?.bind(sub),
        unwrapKey:  sub.unwrapKey?.bind(sub),
        wrapKey:    sub.wrapKey?.bind(sub),
      } as unknown) as SubtleCrypto;
      const wrappedCrypto = {
        getRandomValues: <T extends ArrayBufferView | null>(arr: T): T =>
          (globalThis.crypto as Crypto).getRandomValues(arr as unknown as Parameters<Crypto['getRandomValues']>[0]) as unknown as T,
        subtle: wrappedSubtle,
      } as unknown as Crypto;
      libsignal.setWebCrypto(wrappedCrypto);
      console.log('[crypto/polyfills] libsignal setWebCrypto installed');
    } catch (e) {

      console.error('[crypto/polyfills] libsignal setWebCrypto failed', e);
    }
  }
}

/**
 * Audit fix #7 — public hook for the runtime to consult before doing
 * anything that requires crypto (identity install, first send, etc.).
 *
 * Callers should `if (cryptoSelfTestFailed()) throw new Error(...)`
 * rather than silently producing ciphertext nobody can decrypt.
 *
 * Note: the self-tests above run async; this returns the LAST KNOWN
 * result. Call it after a microtask flush at boot or wrap your gate
 * in a `setTimeout(0)` to give the tests a chance to land.
 */
export function cryptoSelfTestFailed(): boolean {
  return Boolean((globalThis as Record<string, unknown>).__bravo_crypto_self_test_failed__);
}

// ─── Sender-cert verify self-test (audit fix #6) ──────────────────────
// Pin the curve25519 wrapper's verify() inversion semantics: the lib
// returns truthy on INVALID. If a future dep upgrade flips the
// convention silently, every legitimate envelope will get rejected as
// "sender cert signature invalid". Run a quick known-valid + known-
// invalid pair at boot so the failure happens here, in plain sight,
// instead of in the receive path days later.
void (async () => {
  try {
    const {AsyncCurve25519Wrapper} = require('@privacyresearch/curve25519-typescript') as
      typeof import('@privacyresearch/curve25519-typescript');
    const curve = new AsyncCurve25519Wrapper();
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    const seedAb = seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength);
    const kp = await curve.keyPair(seedAb);
    const msg = new TextEncoder().encode('bravo-self-test');
    const msgAb = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength);
    // Cast: calculateSignature isn't in every wrapper build's types but
    // is present at runtime in the bundled @privacyresearch wrapper.
    const sigAb = await (curve as unknown as {
      calculateSignature: (priv: ArrayBuffer, msg: ArrayBuffer) => Promise<ArrayBuffer>;
    }).calculateSignature(kp.privKey, msgAb);
    // Known-valid: lib must return falsy.
    const okResult = await curve.verify(kp.pubKey, msgAb, sigAb);
    const okValid = !okResult;
    // Known-invalid: flip a byte of the signature; lib must return truthy.
    const badSig = new Uint8Array(sigAb.byteLength);
    badSig.set(new Uint8Array(sigAb));
    badSig[0] ^= 0xff;
    const badAb = badSig.buffer.slice(badSig.byteOffset, badSig.byteOffset + badSig.byteLength);
    const badResult = await curve.verify(kp.pubKey, msgAb, badAb);
    const badValid = !badResult;
    if (!okValid || badValid) {
      (globalThis as Record<string, unknown>).__bravo_crypto_self_test_failed__ = true;
      console.error('[crypto/polyfills] XEd25519 verify self-test FAILED', {okValid, badValid});
    } else {
      console.log('[crypto/polyfills] XEd25519 verify self-test OK (truthy=invalid convention pinned)');
    }
  } catch (e) {
    // Don't fail-flag for a self-test wiring bug — the test relies on
    // calculateSignature which not all wrapper builds expose. Just log.
    console.warn('[crypto/polyfills] XEd25519 verify self-test could not run:', (e as Error).message);
  }
})();
