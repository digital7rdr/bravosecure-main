/**
 * Audit S7 — bind a `call.offer` to the caller's verified identity so the
 * relay cannot fabricate a ringing call on behalf of a third party.
 *
 *   The 1:1 P2P signalling lane carries the offerer's SDP + (relay-stamped)
 *   `from` address. Before S7 the body was unauthenticated end-to-end:
 *   a compromised gateway, or any insider with WS access, could mint a
 *   `call.offer` attributing it to any user, ring the callee's CallScreen
 *   under that identity, and (depending on the callee's accept policy)
 *   establish a DTLS-SRTP leg whose far end is NOT the claimed caller.
 *
 *   The fix is an explicit signed-AAD block on every outgoing offer:
 *
 *     auth: {
 *       cert,    // existing XEd25519 sender cert from auth-service.
 *       aad: {
 *         v, callId, from:{userId,deviceId}, to:{userId,deviceId}, kind, ts
 *       },
 *       sig      // XEd25519(canonical-JSON(aad)), signed by the caller's
 *                // signal identity priv key — the same key the cert
 *                // attests via `senderIdentityKey`.
 *     }
 *
 *   The callee verifies the cert (XEd25519 over the auth-service signer),
 *   verifies the sig (XEd25519 over the cert's `senderIdentityKey`), and
 *   then checks the AAD binds to this call: `aad.callId == frame.callId`,
 *   `aad.from == frame.from`, `aad.to == self`, `aad.kind == frame.kind`,
 *   `|now - aad.ts| < skew`. Any mismatch is treated as spoofed; the
 *   call.offer is dropped and the callee never rings.
 *
 *   Pure-relay invariant is preserved — the relay still sees only opaque
 *   bytes in the auth block; verification happens end-to-end on the
 *   callee. The signal identity key is the one the receiver already
 *   trusts via X3DH (and which the sender cert binds), so this fix
 *   inherits the existing trust root rather than introducing a new one.
 */
import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import {fromBase64, toBase64} from './encoding';
import {CryptoError} from './errors';
import {verifySenderCert, verifyXEd25519Signature, type SenderCertClaims} from './senderCert';

const curve = new AsyncCurve25519Wrapper();

const CALL_OFFER_AUTH_VERSION = 1;

/** Default freshness window for the AAD timestamp — 2 minutes. */
export const CALL_OFFER_AAD_SKEW_MS = 2 * 60 * 1000;

export interface CallOfferAuthAddress {
  userId:   string;
  deviceId: number;
}

export interface CallOfferAad {
  /** Schema version — bump if the canonical shape changes. */
  v:        number;
  /** UUID — same value as the outer ClientCallOffer.data.callId. */
  callId:   string;
  /** Caller's address — must match the relay-stamped `from` on the wire. */
  from:     CallOfferAuthAddress;
  /** Callee's address — must match the recipient on accept. */
  to:       CallOfferAuthAddress;
  /** Call kind — voice/video — match the wire. */
  kind:     'voice' | 'video';
  /** Sender wall clock (epoch ms). Receiver tolerates ±CALL_OFFER_AAD_SKEW_MS. */
  ts:       number;
}

export interface CallOfferAuth {
  /** Wire-format XEd25519 sender cert (`<header>.<payload>.<sig>`). */
  cert: string;
  /** Bound metadata — same fields the wire frame carries, hashed in canonical order. */
  aad:  CallOfferAad;
  /** Base64 64-byte XEd25519 signature over `canonicalCallOfferAuthBytes(aad)`. */
  sig:  string;
}

/**
 * Canonical bytes that get signed. Field order is fixed and primitives are
 * stringified so a future struct addition can't silently change the digest.
 * `\n` separator matches the convention used by `canonicalCreateBytes` in
 * groupClient — keep them aligned so the same review can audit both.
 */
export function canonicalCallOfferAuthBytes(aad: CallOfferAad): Uint8Array {
  const canonical = [
    'BRAVO_CALL_OFFER_AUTH_V1',
    String(aad.v),
    aad.callId,
    `${aad.from.userId}.${aad.from.deviceId}`,
    `${aad.to.userId}.${aad.to.deviceId}`,
    aad.kind,
    String(aad.ts),
  ].join('\n');
  return new TextEncoder().encode(canonical);
}

export interface SignCallOfferAuthParams {
  /** Cert previously issued by auth-service for this device. */
  cert: string;
  /** Raw 32-byte Curve25519 priv key — the signal identity priv key. */
  identityPrivKey: ArrayBuffer;
  callId: string;
  from:   CallOfferAuthAddress;
  to:     CallOfferAuthAddress;
  kind:   'voice' | 'video';
  /** Defaults to Date.now(); override for deterministic tests. */
  now?:   number;
}

/**
 * Build the auth block for an outgoing `call.offer`. The caller passes
 * the already-cached sender cert plus their identity priv key; this
 * helper stamps the AAD and signs it.
 */
export async function signCallOfferAuth(p: SignCallOfferAuthParams): Promise<CallOfferAuth> {
  if (!p.cert) {throw new CryptoError('signCallOfferAuth: missing sender cert');}
  if (!(p.identityPrivKey instanceof ArrayBuffer) || p.identityPrivKey.byteLength !== 32) {
    throw new CryptoError('signCallOfferAuth: identity priv key must be a 32-byte ArrayBuffer');
  }
  const aad: CallOfferAad = {
    v:      CALL_OFFER_AUTH_VERSION,
    callId: p.callId,
    from:   {userId: p.from.userId, deviceId: p.from.deviceId},
    to:     {userId: p.to.userId,   deviceId: p.to.deviceId},
    kind:   p.kind,
    ts:     p.now ?? Date.now(),
  };
  const bytes = canonicalCallOfferAuthBytes(aad);
  const msgAb = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(msgAb).set(bytes);
  const sigAb = await curve.sign(p.identityPrivKey, msgAb);
  return {cert: p.cert, aad, sig: toBase64(sigAb)};
}

export interface VerifyCallOfferAuthParams {
  /** Auth block as it arrived on the wire. */
  auth: CallOfferAuth;
  /** Fields from the outer `ServerCallOffer.data` — used to enforce binding. */
  wire: {
    callId: string;
    from:   CallOfferAuthAddress;
    /** The kind from the wire frame; must match aad.kind. */
    kind:   'voice' | 'video';
  };
  /** The receiver's own address — must match aad.to. */
  self: CallOfferAuthAddress;
  /** Auth-service Curve25519 signer public key (base64, 32 bytes). */
  authorityPubKeyB64: string;
  /** Defaults to Date.now(); override for deterministic tests. */
  now?: number;
  /** Defaults to CALL_OFFER_AAD_SKEW_MS. */
  clockSkewMs?: number;
  /**
   * Optional revoked-jti allowlist polled from auth-service. When provided,
   * any cert whose `jti` appears is treated as forged.
   */
  revokedJtis?: ReadonlySet<string>;
}

export type CallOfferAuthFailReason =
  | 'missing'
  | 'malformed'
  | 'cert_invalid'
  | 'sig_invalid'
  | 'callId_mismatch'
  | 'from_mismatch'
  | 'to_mismatch'
  | 'kind_mismatch'
  | 'sender_identity_mismatch'
  | 'stale'
  | 'future'
  | 'version_unsupported';

export type CallOfferAuthResult =
  | {ok: true;  claims: SenderCertClaims}
  | {ok: false; reason: CallOfferAuthFailReason};

/**
 * Validate an inbound call.offer auth block. Performs (in order):
 *   1. Shape check — auth block present and well-formed.
 *   2. Cert verify — XEd25519 over auth-service's signer pubkey, jti check.
 *   3. AAD binding — callId/from/to/kind match the wire frame + self.
 *   4. Freshness — `|now - aad.ts| < skew`.
 *   5. Sig verify — XEd25519 over canonical-bytes using the cert's
 *      `senderIdentityKey` as the public key.
 *
 * Returns ok with the validated cert claims when every check passes, else
 * a discriminated failure reason. Never throws — callers can log + drop
 * without try/catch noise.
 */
export async function verifyCallOfferAuth(p: VerifyCallOfferAuthParams): Promise<CallOfferAuthResult> {
  if (!p.auth || typeof p.auth !== 'object') {return {ok: false, reason: 'missing'};}
  const {cert, aad, sig} = p.auth;
  if (!cert || !aad || !sig) {return {ok: false, reason: 'missing'};}
  if (typeof aad.v !== 'number' || aad.v < 1 || aad.v > CALL_OFFER_AUTH_VERSION) {
    return {ok: false, reason: 'version_unsupported'};
  }
  if (typeof aad.callId !== 'string' || !aad.callId
      || !aad.from || !aad.to
      || typeof aad.from.userId !== 'string' || typeof aad.from.deviceId !== 'number'
      || typeof aad.to.userId !== 'string'   || typeof aad.to.deviceId !== 'number'
      || (aad.kind !== 'voice' && aad.kind !== 'video')
      || typeof aad.ts !== 'number') {
    return {ok: false, reason: 'malformed'};
  }

  let claims: SenderCertClaims;
  try {
    claims = await verifySenderCert({
      cert,
      authorityPubKeyB64: p.authorityPubKeyB64,
      // Defer the identity-key cross-check until we know who the caller
      // claims to be on the wire — and even then it's the cert itself
      // that names the identity. Anything dishonest about identity is
      // caught by the sig check below.
      revokedJtis: p.revokedJtis,
    });
  } catch {
    return {ok: false, reason: 'cert_invalid'};
  }

  // Cert names the caller's userId+deviceId — must agree with the AAD claim.
  if (claims.senderUserId !== aad.from.userId
      || claims.senderSignalDeviceId !== aad.from.deviceId) {
    return {ok: false, reason: 'sender_identity_mismatch'};
  }

  // Wire ↔ AAD binding — refuses an attacker stitching one valid auth
  // block onto an attacker-chosen outer frame.
  if (aad.callId !== p.wire.callId) {return {ok: false, reason: 'callId_mismatch'};}
  if (aad.from.userId !== p.wire.from.userId || aad.from.deviceId !== p.wire.from.deviceId) {
    return {ok: false, reason: 'from_mismatch'};
  }
  if (aad.kind !== p.wire.kind) {return {ok: false, reason: 'kind_mismatch'};}

  // Receiver binding — refuses an attacker replaying a valid offer that
  // was originally addressed to someone else.
  if (aad.to.userId !== p.self.userId || aad.to.deviceId !== p.self.deviceId) {
    return {ok: false, reason: 'to_mismatch'};
  }

  // Freshness.
  const now = p.now ?? Date.now();
  const skew = p.clockSkewMs ?? CALL_OFFER_AAD_SKEW_MS;
  if (aad.ts < now - skew) {return {ok: false, reason: 'stale'};}
  if (aad.ts > now + skew) {return {ok: false, reason: 'future'};}

  // Signature — verify with the cert's identity key. libsignal identity
  // pubkeys are 33 bytes on the wire (leading 0x05 DJB type byte); the
  // curve25519 wrapper operates on raw 32-byte keys, so strip it if
  // present (same convention as verifyGroupCreateSignature).
  let sigBytes: Uint8Array;
  try { sigBytes = new Uint8Array(fromBase64(sig)); }
  catch { return {ok: false, reason: 'malformed'}; }
  if (sigBytes.byteLength !== 64) {return {ok: false, reason: 'malformed'};}

  let pubBytes: Uint8Array;
  try { pubBytes = new Uint8Array(fromBase64(claims.senderIdentityKey)); }
  catch { return {ok: false, reason: 'cert_invalid'}; }
  let rawPub: Uint8Array;
  if (pubBytes.byteLength === 33 && pubBytes[0] === 0x05) {
    rawPub = pubBytes.subarray(1);
  } else if (pubBytes.byteLength === 32) {
    rawPub = pubBytes;
  } else {
    return {ok: false, reason: 'cert_invalid'};
  }

  const bytes = canonicalCallOfferAuthBytes(aad);
  const msgAb = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(msgAb).set(bytes);
  const pubAb = new ArrayBuffer(rawPub.byteLength);
  new Uint8Array(pubAb).set(rawPub);
  const sigAb = new ArrayBuffer(sigBytes.byteLength);
  new Uint8Array(sigAb).set(sigBytes);

  const {valid} = await verifyXEd25519Signature({
    publicKey: pubAb,
    message:   msgAb,
    signature: sigAb,
  });
  if (!valid) {return {ok: false, reason: 'sig_invalid'};}
  return {ok: true, claims};
}
