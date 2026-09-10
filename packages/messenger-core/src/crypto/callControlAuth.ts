/**
 * Audit P1-C2 + P1-C3 — caller-identity binding for mid-call control
 * frames (`call.answer` and `call.media-state`).
 *
 * S7 introduced the binding for `call.offer`. The other two control
 * frames stayed unauthenticated end-to-end:
 *
 *   • call.answer       — a compromised relay (or any insider with WS
 *                          access) could ship an answer matching the
 *                          callee's `callId` from an attacker's WS,
 *                          and the offerer would happily complete DTLS
 *                          to the attacker because acceptAnswer(sdp)
 *                          runs without any sender check. P1-N5 already
 *                          gates on the relay-stamped `from` address
 *                          matching `descriptor.peer`; P1-C3 layers a
 *                          CRYPTOGRAPHIC signature on top so a relay
 *                          that lies about `from` is also caught.
 *
 *   • call.media-state  — visual-only attack: spoofed `cameraOff=true`
 *                          blanks the receiver's tile mid-call. The
 *                          signature stops a relay from re-stamping
 *                          state advisories without the peer's identity.
 *
 * The signing primitive is the same XEd25519-over-identity-key pattern
 * S7 uses, with a per-frame canonical AAD. Cert reuse keeps the trust
 * root unchanged — no new key handshake.
 */
import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import {sha256} from '@noble/hashes/sha2.js';
import {fromBase64, toBase64} from './encoding';
import {CryptoError} from './errors';
import {verifySenderCert, verifyXEd25519Signature, type SenderCertClaims} from './senderCert';

const curve = new AsyncCurve25519Wrapper();

const CALL_CONTROL_AUTH_VERSION = 1;

/** Default freshness window — 2 minutes, same as call.offer. */
export const CALL_CONTROL_AAD_SKEW_MS = 2 * 60 * 1000;

export interface CallControlAuthAddress {
  userId:   string;
  deviceId: number;
}

/** Frame kinds covered by this primitive. */
export type CallControlKind = 'call.answer' | 'call.media-state';

export interface CallControlAad {
  v:      number;
  /** `call.answer` or `call.media-state` — binds the AAD to ONE frame type. */
  kind:   CallControlKind;
  callId: string;
  from:   CallControlAuthAddress;
  to:     CallControlAuthAddress;
  /**
   * Frame-type-specific payload hash. For `call.answer` the answerer
   * hashes the SDP they're shipping; for `call.media-state` the booleans
   * are joined with a separator. Hashed (not embedded) so the canonical
   * bytes stay small + so a future field add doesn't change the digest
   * format for existing kinds.
   *
   * Encoded as opaque base64 — the receiver re-derives from the wire
   * frame and compares.
   */
  bodyHash: string;
  ts:       number;
}

export interface CallControlAuth {
  cert: string;
  aad:  CallControlAad;
  sig:  string;
}

/**
 * Derive the body hash for a control frame. Pure function — same input
 * always produces same output. The shape per kind:
 *
 *   call.answer       — SHA-256(utf-8(sdp))
 *   call.media-state  — SHA-256(utf-8('mute:<micOff>|cam:<cameraOff>'))
 *
 * SHA-256 via SubtleCrypto when available; Node's `crypto` fallback for
 * the messenger-crypto Jest environment (which has SubtleCrypto on Node
 * 18+ but the test setup occasionally polyfills). We import lazily so
 * the ops-console bundle doesn't pull in node:crypto.
 */
export async function callControlBodyHash(
  kind:    CallControlKind,
  payload: {sdp?: string; cameraOff?: boolean; micOff?: boolean},
): Promise<string> {
  let canonical: string;
  if (kind === 'call.answer') {
    if (typeof payload.sdp !== 'string') {
      throw new CryptoError('callControlBodyHash: call.answer requires sdp');
    }
    canonical = `sdp:${payload.sdp}`;
  } else if (kind === 'call.media-state') {
    if (typeof payload.cameraOff !== 'boolean' || typeof payload.micOff !== 'boolean') {
      throw new CryptoError('callControlBodyHash: call.media-state requires cameraOff+micOff');
    }
    canonical = `mute:${payload.micOff ? '1' : '0'}|cam:${payload.cameraOff ? '1' : '0'}`;
  } else {
    throw new CryptoError(`callControlBodyHash: unknown kind=${String(kind)}`);
  }
  const bytes = new TextEncoder().encode(canonical);
  // Why: @noble/hashes is pure JS and bundles cleanly under Metro for
  // React Native; the previous SubtleCrypto-with-node:crypto-fallback
  // dual path made Metro try to resolve `node:crypto` and bombed the
  // release bundle. Same hash output as before (SHA-256 over the
  // canonical bytes), just a sync producer wrapped to keep the
  // public Promise<string> signature.
  const digest = sha256(bytes);
  const ab = digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength) as ArrayBuffer;
  return toBase64(ab);
}

export function canonicalCallControlAuthBytes(aad: CallControlAad): Uint8Array {
  const canonical = [
    'BRAVO_CALL_CONTROL_AUTH_V1',
    String(aad.v),
    aad.kind,
    aad.callId,
    `${aad.from.userId}.${aad.from.deviceId}`,
    `${aad.to.userId}.${aad.to.deviceId}`,
    aad.bodyHash,
    String(aad.ts),
  ].join('\n');
  return new TextEncoder().encode(canonical);
}

export interface SignCallControlAuthParams {
  cert: string;
  identityPrivKey: ArrayBuffer;
  kind:    CallControlKind;
  callId:  string;
  from:    CallControlAuthAddress;
  to:      CallControlAuthAddress;
  /** Same shape as callControlBodyHash's payload — passed straight through. */
  body:    {sdp?: string; cameraOff?: boolean; micOff?: boolean};
  now?:    number;
}

export async function signCallControlAuth(p: SignCallControlAuthParams): Promise<CallControlAuth> {
  if (!p.cert) {throw new CryptoError('signCallControlAuth: missing sender cert');}
  if (!(p.identityPrivKey instanceof ArrayBuffer) || p.identityPrivKey.byteLength !== 32) {
    throw new CryptoError('signCallControlAuth: identity priv key must be 32-byte ArrayBuffer');
  }
  const bodyHash = await callControlBodyHash(p.kind, p.body);
  const aad: CallControlAad = {
    v:        CALL_CONTROL_AUTH_VERSION,
    kind:     p.kind,
    callId:   p.callId,
    from:     {userId: p.from.userId, deviceId: p.from.deviceId},
    to:       {userId: p.to.userId,   deviceId: p.to.deviceId},
    bodyHash,
    ts:       p.now ?? Date.now(),
  };
  const bytes = canonicalCallControlAuthBytes(aad);
  const msgAb = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(msgAb).set(bytes);
  const sigAb = await curve.sign(p.identityPrivKey, msgAb);
  return {cert: p.cert, aad, sig: toBase64(sigAb)};
}

export interface VerifyCallControlAuthParams {
  auth: CallControlAuth;
  wire: {
    kind:   CallControlKind;
    callId: string;
    from:   CallControlAuthAddress;
    body:   {sdp?: string; cameraOff?: boolean; micOff?: boolean};
  };
  self: CallControlAuthAddress;
  authorityPubKeyB64: string;
  now?:         number;
  clockSkewMs?: number;
  revokedJtis?: ReadonlySet<string>;
}

export type CallControlAuthFailReason =
  | 'missing'
  | 'malformed'
  | 'cert_invalid'
  | 'sig_invalid'
  | 'kind_mismatch'
  | 'callId_mismatch'
  | 'from_mismatch'
  | 'to_mismatch'
  | 'body_mismatch'
  | 'sender_identity_mismatch'
  | 'stale'
  | 'future'
  | 'version_unsupported';

export type CallControlAuthResult =
  | {ok: true;  claims: SenderCertClaims}
  | {ok: false; reason: CallControlAuthFailReason};

export async function verifyCallControlAuth(p: VerifyCallControlAuthParams): Promise<CallControlAuthResult> {
  if (!p.auth || typeof p.auth !== 'object') {return {ok: false, reason: 'missing'};}
  const {cert, aad, sig} = p.auth;
  if (!cert || !aad || !sig) {return {ok: false, reason: 'missing'};}
  if (typeof aad.v !== 'number' || aad.v < 1 || aad.v > CALL_CONTROL_AUTH_VERSION) {
    return {ok: false, reason: 'version_unsupported'};
  }
  if (typeof aad.kind !== 'string'
      || (aad.kind !== 'call.answer' && aad.kind !== 'call.media-state')
      || typeof aad.callId !== 'string' || !aad.callId
      || !aad.from || !aad.to
      || typeof aad.from.userId !== 'string' || typeof aad.from.deviceId !== 'number'
      || typeof aad.to.userId !== 'string'   || typeof aad.to.deviceId !== 'number'
      || typeof aad.bodyHash !== 'string'    || !aad.bodyHash
      || typeof aad.ts !== 'number') {
    return {ok: false, reason: 'malformed'};
  }

  let claims: SenderCertClaims;
  try {
    claims = await verifySenderCert({
      cert,
      authorityPubKeyB64: p.authorityPubKeyB64,
      revokedJtis: p.revokedJtis,
    });
  } catch {
    return {ok: false, reason: 'cert_invalid'};
  }

  if (claims.senderUserId !== aad.from.userId
      || claims.senderSignalDeviceId !== aad.from.deviceId) {
    return {ok: false, reason: 'sender_identity_mismatch'};
  }

  if (aad.kind !== p.wire.kind) {return {ok: false, reason: 'kind_mismatch'};}
  if (aad.callId !== p.wire.callId) {return {ok: false, reason: 'callId_mismatch'};}
  if (aad.from.userId !== p.wire.from.userId || aad.from.deviceId !== p.wire.from.deviceId) {
    return {ok: false, reason: 'from_mismatch'};
  }
  if (aad.to.userId !== p.self.userId || aad.to.deviceId !== p.self.deviceId) {
    return {ok: false, reason: 'to_mismatch'};
  }

  let wireBodyHash: string;
  try { wireBodyHash = await callControlBodyHash(p.wire.kind, p.wire.body); }
  catch { return {ok: false, reason: 'malformed'}; }
  if (wireBodyHash !== aad.bodyHash) {return {ok: false, reason: 'body_mismatch'};}

  const now = p.now ?? Date.now();
  const skew = p.clockSkewMs ?? CALL_CONTROL_AAD_SKEW_MS;
  if (aad.ts < now - skew) {return {ok: false, reason: 'stale'};}
  if (aad.ts > now + skew) {return {ok: false, reason: 'future'};}

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

  const bytes = canonicalCallControlAuthBytes(aad);
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
