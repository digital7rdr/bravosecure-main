/**
 * Sealed Sender v2 / v3 — outer ECIES wrap.
 *
 * Closes the Phase-1 gap where the relay saw a `senderAddressHint`
 * field on every envelope so the recipient could pick the right
 * `SessionCipher` for decrypt. This module replaces that hint with a
 * Signal-style UnidentifiedSenderMessage wrap: the sender's address
 * travels INSIDE an outer AES-256-GCM ciphertext keyed off a fresh-
 * per-message X25519 ephemeral that DH's with the recipient's long-
 * term identity public key. The relay sees only opaque bytes, with
 * no field that could be linked back to the sender.
 *
 * ## Wire format v2 (legacy — receivers still accept; senders may opt
 *   in via `EXPO_PUBLIC_OUTER_WIRE_V2=true` for emergency rollback):
 *
 *   ┌───────┬──────────────┬───────┬─────────────────────────┐
 *   │ ver=2 │ ephPub (32B) │ iv 12 │ AES-256-GCM ct + 16-tag │
 *   └───────┴──────────────┴───────┴─────────────────────────┘
 *      1B          32B        12B           variable
 *
 *   AAD = ephPub || recipientPub
 *   Inner JSON: { "s": {"u","d"}, "c": {"t","b"} }
 *
 * ## Wire format v3 (current — closes audit P0-1):
 *
 *   ┌───────┬──────────────┬─────────┬────────────┬───────┬───────────────────┐
 *   │ ver=3 │ ephPub (32B) │ certLen │ cert UTF-8 │ iv 12 │ AES-256-GCM ct+16 │
 *   └───────┴──────────────┴─────────┴────────────┴───────┴───────────────────┘
 *      1B         32B          2B BE    certLen B    12B          variable
 *
 *   AAD = ephPub || recipientPub || certBytes
 *   Inner JSON: same shape as v2 (kept for back-compat) but the `s`
 *               field is no longer load-bearing — receivers route
 *               decryption by `cert.senderUserId/senderSignalDeviceId`
 *               which are bound into the OUTER GCM tag via the AAD.
 *
 * ### Why v3 exists (audit P0-1)
 *
 *   v2's AAD only authenticated `ephPub || recipientPub`. The inner
 *   `s: {u, d}` (sender address) was NOT bound by the outer GCM tag,
 *   so any authenticated submitter could mint a wrap with an attacker-
 *   chosen `senderAddress`. The receiver would unwrap successfully,
 *   feed the attacker-named peer to `own.decrypt`, hit `DecryptError`
 *   (no Signal session matches the attacker's inner ciphertext), and
 *   the legacy catch-block then wiped the legitimate session via
 *   `closeSession` + bundle refetch. One forged envelope per minute
 *   → perpetual disruption of any chosen 1:1 conversation.
 *
 *   v3 binds the sender's authority-signed cert into the outer AAD.
 *   On receive, the cert is parsed FIRST, signature-verified FIRST,
 *   then the AAD is rebuilt from `(ephPub, recipientPub, certBytes)`.
 *   GCM auth-fail on tamper means the cert in the wire == cert the
 *   sender minted. Receiver uses `cert.senderUserId/SignalDeviceId`
 *   as the peer address — NOT the inner `s` field, which is now an
 *   untrusted breadcrumb retained only so v2 receivers still decode
 *   v3 inner JSON. A failed cert verify drops the envelope BEFORE
 *   any `own.decrypt` call, so no DecryptError can fire and no
 *   session-wipe path can be coerced.
 *
 *   This is the construction Signal Sealed Sender v2 spec mandates;
 *   the Bravo Secure architecture doc explicitly names Sealed Sender,
 *   so v3 is spec-compliance, not deviation.
 *
 * ## Crypto details (unchanged across versions)
 *   - eph_priv = randomBytes(32); eph_pub = curve.keyPair(eph_priv).pubKey
 *   - dh   = X25519(recipient.identityPub, eph_priv)
 *   - salt = SHA-256(eph_pub || recipient.identityPub)   (binds context)
 *   - prk  = HMAC-SHA256(salt, dh)
 *   - okm  = HMAC-SHA256(prk, "Bravo-SealedSender-v2" || 0x01)
 *   - aes  = AES-256-GCM(okm, iv, inner, AAD = <see version>)
 *
 *   Note: HKDF info string still says "v2" because the KEY-DERIVATION
 *   primitive didn't change — only what's covered by the GCM AAD did.
 *   A v3 receiver can decrypt a v2 wrap from a non-upgraded peer
 *   because the AES key is computed identically; only the AAD shape
 *   differs by version.
 *
 * Forward secrecy: the ephemeral private key is discarded after wrap;
 * compromise of the recipient's identity key compromises future messages
 * but the inner Signal Double Ratchet still drives per-message FS for
 * the conversation content itself.
 */

import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import {sha256} from '@noble/hashes/sha2.js';
import {hmac} from '@noble/hashes/hmac.js';
import {fromBase64, toBase64} from './encoding';
import {CryptoError} from './errors';
import {CiphertextType, type Ciphertext, type SessionAddress} from './types';

const VERSION_BYTE_V2 = 0x02;
const VERSION_BYTE_V3 = 0x03;
const EPH_PUB_LEN    = 32;
const IV_LEN         = 12;
/** v2 header length: ver(1) + ephPub(32) + iv(12) = 45. */
const HEADER_LEN     = 1 + EPH_PUB_LEN + IV_LEN;
/** v3 cert length is a 16-bit big-endian unsigned int; cap to ~64 KiB. */
const CERT_LEN_BYTES = 2;
const MAX_CERT_BYTES = 65535;
const HKDF_INFO      = new TextEncoder().encode('Bravo-SealedSender-v2');

const curve = new AsyncCurve25519Wrapper();

/** Inner plaintext of the outer wrap. Never goes on the wire as-is. */
interface InnerPayload {
  /** Sender Signal address — recipient uses this to pick the SessionCipher. */
  s: {u: string; d: number};
  /** libsignal SessionCipher output — opaque to this layer. */
  c: {t: 1 | 3; b: string};
}

export interface WrapOuterParams {
  recipientIdentityKeyB64: string;
  sender:                  SessionAddress;
  ciphertext:              Ciphertext;
  /**
   * Audit P0-1 — sender's authority-signed cert. When present, the
   * wrap emits v3 (cert bound into outer GCM AAD); when omitted, the
   * wrap falls back to v2 wire shape. Production callers MUST always
   * pass the cert; v2 fallback exists for the emergency rollback
   * flag (`EXPO_PUBLIC_OUTER_WIRE_V2=true`) and for tests that
   * deliberately exercise the legacy receive path.
   */
  cert?: string;
}

export interface UnwrapOuterParams {
  /** Recipient's own Signal identity private key (raw 32-byte X25519). */
  ownIdentityPrivKey: ArrayBuffer;
  /** Recipient's own Signal identity public key (raw 32-byte X25519). */
  ownIdentityPubKey:  ArrayBuffer;
  /** Base64 outer blob as it arrived on the wire. */
  outerSealedB64:     string;
}

export interface UnwrappedOuter {
  /**
   * Sender address parsed from the inner JSON `s` field.
   *
   *   v2: this is the AUTHORITATIVE source the receiver routes by.
   *       Not bound by the outer GCM AAD — see security note.
   *   v3: kept for back-compat with the legacy inner-JSON shape, but
   *       receivers MUST instead use `senderCert`-derived claims as
   *       the trusted peer address (the inner `s` is forgeable; the
   *       cert is bound into the outer AAD).
   */
  sender:     SessionAddress;
  ciphertext: Ciphertext;
  /**
   * Audit P0-1 — only populated for v3 wraps. When present, the
   * receiver MUST call `verifySenderCert` BEFORE decrypting the
   * inner ciphertext. The outer GCM tag has already proved this cert
   * is the cert the sender used to derive the AAD (otherwise the
   * unwrap would have raised "outer sealed authentication failed").
   * After cert verification, derive the trusted peer address from
   * `claims.senderUserId` + `claims.senderSignalDeviceId` and use
   * THAT to call `own.decrypt` — not the inner `sender` field.
   */
  senderCert?: string;
  /** Wire version that the unwrap actually parsed (2 or 3). */
  wireVersion: 2 | 3;
}

/**
 * Wrap (sender side). Returns the base64 string the sender pushes to
 * the relay as `outerSealed`. The relay never decodes this — it only
 * sees opaque bytes.
 *
 * Wire-version selection:
 *   - When `params.cert` is provided AND the env flag
 *     `EXPO_PUBLIC_OUTER_WIRE_V2` is NOT set, emit v3 (cert-in-AAD).
 *   - Otherwise emit v2. Production callers always pass `cert`;
 *     the env flag is an emergency rollback knob.
 */
export async function wrapOuter(params: WrapOuterParams): Promise<string> {
  const recipientRaw = stripIdentityTypeByte(new Uint8Array(fromBase64(params.recipientIdentityKeyB64)));
  if (recipientRaw.byteLength !== 32) {
    throw new CryptoError(`recipient identity key must be 32 bytes, got ${recipientRaw.byteLength}`);
  }

  const ephPriv = randomBytes(32);
  const ephKp   = await curve.keyPair(toAb(ephPriv));
  const ephPub  = new Uint8Array(ephKp.pubKey);
  if (ephPub.byteLength !== EPH_PUB_LEN) {
    throw new CryptoError(`ephemeral pubkey wrong length ${ephPub.byteLength}`);
  }

  const dh = await curve.sharedSecret(toAb(recipientRaw), ephKp.privKey);
  const aesKey = await deriveOuterKey(ephPub, recipientRaw, new Uint8Array(dh));

  // Inner JSON shape is identical across v2 and v3 — receivers in either
  // version round-trip the same payload. v3 receivers TREAT THE INNER
  // `s` AS UNTRUSTED and re-derive the peer address from the cert.
  const inner: InnerPayload = {
    s: {u: params.sender.userId, d: params.sender.deviceId},
    c: {t: params.ciphertext.type as 1 | 3, b: params.ciphertext.body},
  };
  const innerJson = new TextEncoder().encode(JSON.stringify(inner));

  const iv  = randomBytes(IV_LEN);

  // Audit P0-1 — v3 path: cert bytes go into the AAD AND into the wire
  // header (uncompressed UTF-8, length-prefixed). Receiver re-derives
  // AAD from `ephPub || recipientPub || certBytes` to verify GCM tag,
  // then `verifySenderCert(certBytes)` to authenticate the sender
  // identity BEFORE any libsignal decrypt is attempted.
  const useV3 = !!params.cert && readEnv('EXPO_PUBLIC_OUTER_WIRE_V2') !== 'true';

  if (useV3) {
    const certBytes = new TextEncoder().encode(params.cert!);
    if (certBytes.byteLength === 0 || certBytes.byteLength > MAX_CERT_BYTES) {
      throw new CryptoError(`v3 cert length ${certBytes.byteLength} out of range [1, ${MAX_CERT_BYTES}]`);
    }
    const aad = concatBytes(ephPub, recipientRaw, certBytes);
    const ctAb = await crypto.subtle.encrypt(
      {name: 'AES-GCM', iv: toAb(iv), additionalData: toAb(aad)},
      aesKey,
      toAb(innerJson),
    );
    const ct = new Uint8Array(ctAb);
    const v3HeaderLen = 1 + EPH_PUB_LEN + CERT_LEN_BYTES + certBytes.byteLength + IV_LEN;
    const wire = new Uint8Array(v3HeaderLen + ct.byteLength);
    let p = 0;
    wire[p] = VERSION_BYTE_V3;                                p += 1;
    wire.set(ephPub, p);                                      p += EPH_PUB_LEN;
    wire[p]     = (certBytes.byteLength >> 8) & 0xff;         p += 1;
    wire[p]     = certBytes.byteLength & 0xff;                p += 1;
    wire.set(certBytes, p);                                   p += certBytes.byteLength;
    wire.set(iv, p);                                          p += IV_LEN;
    wire.set(ct, p);
    return toBase64(wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength));
  }

  // v2 fallback path — used when no cert is provided (legacy tests) or
  // when EXPO_PUBLIC_OUTER_WIRE_V2=true is set for emergency rollback.
  const aad = concatBytes(ephPub, recipientRaw);
  const ctAb = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv: toAb(iv), additionalData: toAb(aad)},
    aesKey,
    toAb(innerJson),
  );
  const ct = new Uint8Array(ctAb);

  const wire = new Uint8Array(HEADER_LEN + ct.byteLength);
  wire[0] = VERSION_BYTE_V2;
  wire.set(ephPub, 1);
  wire.set(iv,     1 + EPH_PUB_LEN);
  wire.set(ct,     HEADER_LEN);
  return toBase64(wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength));
}

/**
 * Unwrap (recipient side). Returns `{sender, ciphertext, senderCert?,
 * wireVersion}`; the caller passes `ciphertext` to its existing
 * `SessionCipher.decrypt` flow as before. For v3 wraps, `senderCert`
 * is populated and the caller MUST verify it BEFORE decrypt (see the
 * UnwrappedOuter type docs for the threat model).
 *
 * Throws `CryptoError` on any failure (bad version, short payload,
 * GCM tag mismatch). Never log the inner payload or the cert string.
 */
export async function unwrapOuter(params: UnwrapOuterParams): Promise<UnwrappedOuter> {
  const wire = new Uint8Array(fromBase64(params.outerSealedB64));
  if (wire.byteLength < 1) {
    throw new CryptoError('outer sealed too short');
  }
  const version = wire[0];
  if (version !== VERSION_BYTE_V2 && version !== VERSION_BYTE_V3) {
    throw new CryptoError(`unsupported outer sealed version ${version}`);
  }

  const recipientPubRaw  = stripIdentityTypeByte(new Uint8Array(params.ownIdentityPubKey));
  const recipientPrivRaw = stripIdentityTypeByte(new Uint8Array(params.ownIdentityPrivKey));
  if (recipientPubRaw.byteLength !== 32) {
    throw new CryptoError(`own identity pubkey must be 32 bytes, got ${recipientPubRaw.byteLength}`);
  }
  if (recipientPrivRaw.byteLength !== 32) {
    throw new CryptoError(`own identity privkey must be 32 bytes, got ${recipientPrivRaw.byteLength}`);
  }

  if (version === VERSION_BYTE_V2) {
    if (wire.byteLength < HEADER_LEN + 16) {
      throw new CryptoError('outer sealed too short');
    }
    const ephPub = wire.subarray(1, 1 + EPH_PUB_LEN);
    const iv     = wire.subarray(1 + EPH_PUB_LEN, HEADER_LEN);
    const ct     = wire.subarray(HEADER_LEN);
    if (ct.byteLength <= 16) {throw new CryptoError('outer sealed empty payload');}

    const dh = await curve.sharedSecret(toAb(ephPub), toAb(recipientPrivRaw));
    const aesKey = await deriveOuterKey(ephPub, recipientPubRaw, new Uint8Array(dh));
    const aad = concatBytes(ephPub, recipientPubRaw);
    let innerJsonAb: ArrayBuffer;
    try {
      innerJsonAb = await crypto.subtle.decrypt(
        {name: 'AES-GCM', iv: toAb(iv), additionalData: toAb(aad)},
        aesKey,
        toAb(ct),
      );
    } catch (e) {
      throw new CryptoError('outer sealed authentication failed', e);
    }
    const inner = asInnerPayload(jsonParseOrThrow(innerJsonAb));
    return {
      sender:     {userId: inner.s.u, deviceId: inner.s.d},
      ciphertext: {
        type: inner.c.t === 3 ? CiphertextType.PreKeyWhisper : CiphertextType.Whisper,
        body: inner.c.b,
      },
      wireVersion: 2,
    };
  }

  // v3 path
  // Minimum v3 length: ver(1) + ephPub(32) + certLen(2) + cert(>=1) + iv(12) + ct+tag(>=17) = 65
  const V3_MIN = 1 + EPH_PUB_LEN + CERT_LEN_BYTES + 1 + IV_LEN + 17;
  if (wire.byteLength < V3_MIN) {
    throw new CryptoError('outer sealed v3 too short');
  }
  let p = 1;
  const ephPub  = wire.subarray(p, p + EPH_PUB_LEN); p += EPH_PUB_LEN;
  const certLen = (wire[p] << 8) | wire[p + 1];      p += CERT_LEN_BYTES;
  if (certLen === 0 || certLen > MAX_CERT_BYTES) {
    throw new CryptoError(`outer sealed v3 cert length ${certLen} out of range`);
  }
  // Bounds-check before any subarray to avoid silent length truncation.
  if (p + certLen + IV_LEN + 17 > wire.byteLength) {
    throw new CryptoError('outer sealed v3 truncated');
  }
  const certBytes = wire.subarray(p, p + certLen);    p += certLen;
  const iv        = wire.subarray(p, p + IV_LEN);     p += IV_LEN;
  const ct        = wire.subarray(p);
  if (ct.byteLength <= 16) {throw new CryptoError('outer sealed v3 empty payload');}

  const dh = await curve.sharedSecret(toAb(ephPub), toAb(recipientPrivRaw));
  const aesKey = await deriveOuterKey(ephPub, recipientPubRaw, new Uint8Array(dh));
  // Audit P0-1 — AAD includes the cert bytes so a relay that tampers
  // with the cert (e.g. to spoof a different sender) breaks the GCM tag.
  const aad = concatBytes(ephPub, recipientPubRaw, certBytes);
  let innerJsonAb: ArrayBuffer;
  try {
    innerJsonAb = await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv: toAb(iv), additionalData: toAb(aad)},
      aesKey,
      toAb(ct),
    );
  } catch (e) {
    throw new CryptoError('outer sealed authentication failed', e);
  }
  const inner = asInnerPayload(jsonParseOrThrow(innerJsonAb));
  const senderCert = new TextDecoder('utf-8', {fatal: true}).decode(certBytes);
  return {
    // Inner `sender` is preserved for diagnostics ONLY. Receivers MUST
    // derive the trusted peer address from `verifySenderCert(senderCert)`
    // — see UnwrappedOuter docs.
    sender:     {userId: inner.s.u, deviceId: inner.s.d},
    ciphertext: {
      type: inner.c.t === 3 ? CiphertextType.PreKeyWhisper : CiphertextType.Whisper,
      body: inner.c.b,
    },
    senderCert,
    wireVersion: 3,
  };
}

function jsonParseOrThrow(buf: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
  } catch (e) {
    throw new CryptoError('outer sealed inner not JSON', e);
  }
}

/**
 * Read an env var without assuming the runtime exposes `process.env`.
 * Returns `undefined` in environments that lack it (Hermes prod
 * bundles), which the caller treats as "flag unset".
 */
function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) {return undefined;}
  return process.env[name];
}

// ─── helpers ─────────────────────────────────────────────────────────

async function deriveOuterKey(ephPub: Uint8Array, recipientPub: Uint8Array, dh: Uint8Array): Promise<CryptoKey> {
  // RFC 5869 HKDF: salt + extract → expand. We do a single HMAC-SHA256
  // expand step because we only need 32 bytes of output (AES-256 key);
  // the standard `T(1) = HMAC(prk, info || 0x01)` simplification.
  //
  // Hashing + HMAC go through @noble/hashes (pure JS) rather than
  // crypto.subtle.digest/sign, because react-native-quick-crypto's
  // bundled BoringSSL throws "Invalid Hash Algorithm!" on the digest
  // path in some Android builds — making every send fail. AES-GCM
  // below still uses subtle (its native path is unaffected).
  const salt = sha256(concatBytes(ephPub, recipientPub));
  const prk  = hmac(sha256, salt, dh);
  const info = concatBytes(HKDF_INFO, new Uint8Array([0x01]));
  const okm  = hmac(sha256, prk, info);
  return crypto.subtle.importKey(
    'raw',
    toAb(okm.subarray(0, 32)),
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt'],
  );
}

function toAb(u: Uint8Array): ArrayBuffer {
  // WebCrypto signatures across the Hermes / Node split require a real
  // ArrayBuffer (not a SharedArrayBuffer or a typed-array view). Copy
  // out so the call site is portable.
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) {total += p.byteLength;}
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/**
 * libsignal serialises Curve25519 public keys with a leading `0x05` DJB
 * type byte (and private keys are bare 32 bytes coming out of
 * `KeyHelper.generateIdentityKeyPair`). The X25519 primitives in
 * `@privacyresearch/curve25519-typescript` operate on the raw 32-byte
 * coordinate, so we drop the type byte before any DH/HMAC step. Bare
 * 32-byte inputs pass through unchanged so this works for both shapes.
 */
function stripIdentityTypeByte(buf: Uint8Array): Uint8Array {
  if (buf.byteLength === 33 && buf[0] === 0x05) {
    return buf.subarray(1);
  }
  return buf;
}

function asInnerPayload(x: unknown): InnerPayload {
  if (!x || typeof x !== 'object') {throw new CryptoError('outer sealed inner not an object');}
  const o = x as Record<string, unknown>;
  const s = o.s as Record<string, unknown> | undefined;
  const c = o.c as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object') {throw new CryptoError('outer sealed missing sender');}
  if (typeof s.u !== 'string' || typeof s.d !== 'number')
    {throw new CryptoError('outer sealed sender shape invalid');}
  if (!c || typeof c !== 'object') {throw new CryptoError('outer sealed missing ciphertext');}
  if ((c.t !== 1 && c.t !== 3) || typeof c.b !== 'string')
    {throw new CryptoError('outer sealed ciphertext shape invalid');}
  return {
    s: {u: s.u, d: s.d},
    c: {t: c.t as 1 | 3, b: c.b},
  };
}
