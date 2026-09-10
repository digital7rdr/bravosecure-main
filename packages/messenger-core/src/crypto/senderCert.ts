import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import {fromBase64} from './encoding';
import {CryptoError} from './errors';

/**
 * Sender certificate verified at unwrap time. Issued by auth-service
 * (XEd25519 over a Curve25519 priv key) and verified here using the
 * same primitive libsignal already loads via curve25519-typescript.
 *
 * Wire shape (`apps/auth-service/src/sender-cert/cert-format.ts`):
 *   <base64(headerJson)>.<base64(payloadJson)>.<base64(sig)>
 *
 * `signalIdentityKey` MUST equal the Signal identity public key the
 * recipient holds for this sender's address. If it differs, treat the
 * message as spoofed even though the Signal session decrypted it.
 */
export interface SenderCertClaims {
  /** Auth-service user id (JWT-style `sub`). */
  senderUserId:        string;
  /** Signal protocol device id (number). */
  senderSignalDeviceId: number;
  /** Base64 Signal identity pubkey — cross-checked against our trust store. */
  senderIdentityKey:   string;
  /** Issued-at (epoch sec). */
  iat: number;
  /** Expiry (epoch sec). */
  exp: number;
  /** Issuer — always `auth-service` for now. */
  iss: string;
  /** Unique cert id — used for revocation list checks. */
  jti: string;
}

/**
 * Thrown when the cert is authority-signed and otherwise valid, but
 * its embedded `senderIdentityKey` does not match the recipient's
 * locally-cached trust for the same address. The cert itself is NOT
 * forged (signature already verified before this throw) — the
 * mismatch reflects an identity rotation the local store hasn't
 * picked up yet.
 *
 * Catch sites can use the attached `claims.senderIdentityKey` to
 * look the peer up against keys-service: if the keys-service confirms
 * the cert's claimed identity is current, the rotation is real and
 * trust can be updated; otherwise the cert is stale or replayed.
 *
 * Subclasses CryptoError so existing catch blocks that only test for
 * CryptoError still match — behaviour change is opt-in via instanceof.
 */
export class IdentityKeyMismatchError extends CryptoError {
  constructor(
    public readonly claims:           SenderCertClaims,
    public readonly expectedIdentity: string,
  ) {
    super('sender identity key mismatch');
    this.name = 'IdentityKeyMismatchError';
  }
}

export interface VerifyCertParams {
  cert:                string;
  /**
   * Base64 32-byte Curve25519 public key for the auth-service signer.
   * Bundled with the app at build time.
   */
  authorityPubKeyB64:  string;
  /** When the cert names a Signal identity, optionally cross-check against this. */
  expectedIdentityKey?: string;
  /** Accepted issuer — defaults to 'auth-service'. */
  issuer?: string;
  /**
   * Clock skew tolerance in seconds. Defaults to 120.
   *
   * Audit 1:1 P1-6 — bumped from 30 → 120s. The 30-second window made
   * exp/iat checks fail every Doze-thaw cycle on Android (the device
   * wakes from low-power state with a wall-clock that the OS lazily
   * resyncs against NTP over the next minute; meanwhile cert verify
   * runs on the still-skewed clock and rejects a perfectly valid cert).
   * Two minutes is well inside the AAD freshness window (15 min — see
   * SEALED_AAD_SKEW_MS) so a stale cert can't outlive the AAD's reject
   * boundary, while comfortably absorbing typical post-Doze drift.
   */
  clockToleranceSec?: number;
  /**
   * Optional revoked-jti allowlist fetched from auth-service's
   * `GET /sender-cert/revocation-list`. When provided, any cert whose
   * `jti` appears in this set is rejected. Callers should poll the
   * endpoint periodically (e.g. every 5–10 min) and cache the result.
   */
  revokedJtis?: ReadonlySet<string>;
}

const curve = new AsyncCurve25519Wrapper();

/**
 * Verify a sender cert produced by auth-service. Throws on any failure:
 * bad signature, wrong issuer, expired, or identity-key mismatch.
 * Returns validated claims on success. Never log the cert or claims.
 */
export async function verifySenderCert(
  params: VerifyCertParams,
): Promise<SenderCertClaims> {
  const parts = params.cert.split('.');
  if (parts.length !== 3) {throw new CryptoError('sender cert malformed');}
  const [headerB64, payloadB64, sigB64] = parts;

  const header = parseB64Json(headerB64, 'header');
  if (header.alg !== 'XEd25519' || header.typ !== 'BSC') {
    throw new CryptoError(`sender cert unexpected header alg=${header.alg} typ=${header.typ}`);
  }

  const payload = parseB64Json(payloadB64, 'payload');
  const claims  = normalizeClaims(payload);

  const tolerance = params.clockToleranceSec ?? 120;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp + tolerance < now) {throw new CryptoError('sender cert expired');}
  if (claims.iat - tolerance > now) {throw new CryptoError('sender cert not yet valid');}
  if (claims.iss !== (params.issuer ?? 'auth-service')) {
    throw new CryptoError(`sender cert wrong issuer: ${claims.iss}`);
  }

  const sigBuf = fromBase64(sigB64);
  if (sigBuf.byteLength !== 64) {throw new CryptoError('sender cert signature wrong length');}
  const pubBuf = fromBase64(params.authorityPubKeyB64);
  if (pubBuf.byteLength !== 32) {throw new CryptoError('authority public key wrong length');}

  const msgBytes = utf8Bytes(`${headerB64}.${payloadB64}`);
  // Copy into a fresh ArrayBuffer so the helper's signature
  // (`message: ArrayBuffer`) is satisfied regardless of whether
  // msgBytes' underlying buffer is ArrayBuffer or SharedArrayBuffer.
  const msgAb = new ArrayBuffer(msgBytes.byteLength);
  new Uint8Array(msgAb).set(msgBytes);
  const {valid} = await verifyXEd25519Signature({
    publicKey: pubBuf,
    message:   msgAb,
    signature: sigBuf,
  });
  if (!valid) {throw new CryptoError('sender cert signature invalid');}

  if (params.expectedIdentityKey && claims.senderIdentityKey !== params.expectedIdentityKey) {
    // Throw a typed error so the receive path can attempt a refresh-
    // and-retry under the claimed identity. The cert signature is
    // already verified at this point (line above) — the claims are
    // authority-attested; the failure is a LOCAL-TRUST mismatch, not
    // a forgery. Catch sites use the attached `claims` to look the
    // peer up against keys-service and reconcile the rotation.
    throw new IdentityKeyMismatchError(claims, params.expectedIdentityKey);
  }
  if (params.revokedJtis?.has(claims.jti)) {
    throw new CryptoError('sender cert revoked');
  }
  return claims;
}

/**
 * Audit fix #6 — wrap the curve25519 wrapper's `verify` semantics in a
 * typed helper that returns `{valid}`. The underlying API is fragile:
 *
 *   AsyncCurve25519Wrapper.verify(...) returns a truthy value when the
 *   signature is INVALID and falsy when it is VALID. The sync wrapper
 *   ships a `signatureIsValid` helper that inverts this; the async
 *   wrapper doesn't. A future dep upgrade could flip the convention
 *   silently.
 *
 * Pinning the inversion in one place lets every caller reason in the
 * obvious "true means valid" direction, and the boot-time self-test in
 * polyfills.ts validates the convention against known-valid + known-
 * invalid inputs at app start so a behaviour change crashes loud.
 */
export interface VerifyXEd25519Params {
  /** 32-byte raw Curve25519 public key. */
  publicKey: ArrayBuffer;
  /** UTF-8 encoded message body. */
  message:   ArrayBuffer;
  /** 64-byte XEd25519 signature. */
  signature: ArrayBuffer;
}

export async function verifyXEd25519Signature(
  params: VerifyXEd25519Params,
): Promise<{valid: boolean}> {
  const result = await curve.verify(params.publicKey, params.message, params.signature);
  // The library returns truthy on INVALID. Invert exactly once, here,
  // so callers downstream see a normal boolean.
  return {valid: !result};
}

function parseB64Json(seg: string, what: string): Record<string, unknown> {
  let json: string;
  try {
    const buf = fromBase64(seg);
    json = new TextDecoder().decode(new Uint8Array(buf));
  } catch (e) {
    throw new CryptoError(`sender cert ${what} not base64`, e);
  }
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch (e) {
    throw new CryptoError(`sender cert ${what} not JSON`, e);
  }
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function normalizeClaims(p: Record<string, unknown>): SenderCertClaims {
  const senderUserId         = String(p.senderUserId ?? p.sub ?? '');
  const senderSignalDeviceId = Number(p.senderSignalDeviceId);
  const senderIdentityKey    = String(p.senderIdentityKey ?? '');
  const iat = Number(p.iat);
  const exp = Number(p.exp);
  const iss = String(p.iss ?? '');
  const jti = String(p.jti ?? '');
  if (!senderUserId || !Number.isFinite(senderSignalDeviceId) || !senderIdentityKey
      || !Number.isFinite(iat) || !Number.isFinite(exp) || !iss || !jti) {
    throw new CryptoError('sender cert missing required claims');
  }
  return {senderUserId, senderSignalDeviceId, senderIdentityKey, iat, exp, iss, jti};
}
