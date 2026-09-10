/**
 * Audit P0-I2 — authority-signed binding between (userId, identityKey,
 * signedPreKey) on the keys-service bundle.
 *
 * Closes the cold-start residual of P0-1: before P0-I2, a client
 * fetching a peer bundle for an unknown peer trusted the bundle's
 * embedded `identityKey` on TOFU — a malicious keys-service (or any
 * relay-side substitution) could swap the peer's identity end-to-end
 * with no offline-verifiable counter-signal. With P0-I2, every bundle
 * the auth-service serves carries an XEd25519 signature by the same
 * authority key that signs sender certs. The mobile/ops-console clients
 * verify the signature before trusting the bundle, then cross-check the
 * verified `bundle.identityKey` against the sender cert's
 * `claims.senderIdentityKey` on cold-start receive.
 *
 * Why XEd25519 over a Curve25519 priv key:
 *   - auth-service already provisions a Curve25519 authority priv key
 *     (SENDER_CERT_PRIVATE_KEY_B64) for sender-cert signing. Reusing it
 *     keeps the trust root single and avoids a second key-rotation
 *     story. The mobile/ops-console clients already pin the authority
 *     pubkey (`authorityPubKeyB64`) at build time for sender-cert
 *     verify; no new pubkey distribution needed.
 *   - libsignal's curve25519-typescript is already loaded on every
 *     client; no extra polyfill for native Ed25519 (which RN's
 *     quick-crypto doesn't expose in `crypto.subtle`).
 *
 * Wire shape (returned alongside the existing bundle JSON):
 *
 *   {
 *     ... existing bundle fields ...,
 *     authoritySig: {
 *       sig:        Base64,                        // 64-byte XEd25519
 *       signedAtMs: number,                         // server-side ms epoch
 *     }
 *   }
 *
 * Signing input is the canonical UTF-8 encoding of:
 *
 *   `bsc-bundle-v1\n` +
 *   `userId=<targetUserId>\n` +
 *   `identityKey=<base64>\n` +
 *   `signedPrekeyId=<int>\n` +
 *   `signedPrekey=<base64>\n` +
 *   `signedPrekeySig=<base64>\n` +
 *   `signedAtMs=<int>`
 *
 * Notes on what is and isn't bound:
 *   - oneTimePrekey is intentionally NOT in the binding. OPKs are
 *     server-popped on every fetch (single-use, see keys.service.ts),
 *     so a binding-per-OPK would force the auth-service to re-sign on
 *     every bundle fetch (network/CPU cost) AND would mean a stale
 *     binding fails after a single use. The forward-secrecy contract
 *     OPKs provide is independent of the authority's identity binding:
 *     the signedPreKey signature (made by the bundle's identityKey)
 *     covers the signedPrekey, and the identityKey itself is bound by
 *     the authority signature here. An attacker who substitutes the OPK
 *     can be detected at receive time when the X3DH handshake fails to
 *     match the receiver's local OPK private — the existing libsignal
 *     "Bad MAC" path catches it. P0-I2 closes the layer above.
 *   - registrationId is also not bound — it's a freshness/anti-replay
 *     value tied to the libsignal session, not a trust binding.
 *   - signedAtMs is included so a stale binding (replayed across an
 *     identity rotation that didn't re-upload) gets rejected by a
 *     freshness window on the client.
 */

import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import type {PreKeyBundle} from './types';
import {fromBase64} from './encoding';
import {CryptoError} from './errors';
import {verifyXEd25519Signature} from './senderCert';

export const BUNDLE_BINDING_VERSION = 'bsc-bundle-v1';

export interface BundleAuthoritySig {
  /** 64-byte XEd25519 signature, base64. */
  sig:        string;
  /** Server-side wall-clock at signing time (ms). */
  signedAtMs: number;
}

/**
 * Canonical bytes the authority signs. MUST stay byte-for-byte
 * identical to the auth-service implementation in
 * `apps/auth-service/src/keys/bundle-binding.ts`. Tests on both sides
 * pin known vectors to make accidental drift fail loud.
 */
export function bundleBindingSigningInput(params: {
  userId:          string;
  identityKey:     string;
  signedPrekeyId:  number;
  signedPrekey:    string;
  signedPrekeySig: string;
  signedAtMs:      number;
}): Uint8Array {
  // Multiline plain-text canonicalization (not JSON) because JSON.stringify
  // is not stable: key order, whitespace, and number-vs-string serialization
  // are implementation-defined across runtimes. Plain-text k=v\n with no
  // optional fields and an explicit version prefix is unambiguous.
  const lines = [
    BUNDLE_BINDING_VERSION,
    `userId=${params.userId}`,
    `identityKey=${params.identityKey}`,
    `signedPrekeyId=${params.signedPrekeyId}`,
    `signedPrekey=${params.signedPrekey}`,
    `signedPrekeySig=${params.signedPrekeySig}`,
    `signedAtMs=${params.signedAtMs}`,
  ];
  return new TextEncoder().encode(lines.join('\n'));
}

export interface VerifyBundleBindingParams {
  /** The bundle as it came off the wire. */
  bundle:             PreKeyBundle;
  /** authoritySig block from the server response. */
  authoritySig:       BundleAuthoritySig;
  /** Base64 32-byte Curve25519 authority public key (same as sender-cert). */
  authorityPubKeyB64: string;
  /**
   * Freshness window in ms. Defaults to 7 days. A binding older than
   * this is rejected — long enough that a legitimate signed-prekey
   * rotation (every 30d per audit P0-I1 once that lands) doesn't trip
   * verify, short enough that a replayed pre-rotation binding can't
   * outlive its identity-rotation event by much. Today (P0-I1 still
   * open: signed-prekey never rotates) any window > install lifetime
   * is permissive; pinning at 7d is the right floor for when P0-I1
   * lands without forcing a coordinated rollout.
   */
  maxAgeMs?:          number;
  /** Clock-skew tolerance for the signedAtMs check. Default 120s. */
  clockSkewMs?:       number;
}

const DEFAULT_MAX_AGE_MS    = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 120_000;

/**
 * Verify an authority binding over a peer bundle. Throws CryptoError
 * on any failure (signature invalid, expired, future-dated). Returns
 * the validated `signedAtMs` so the caller can persist freshness if
 * desired. Never log the bundle or signature.
 */
export async function verifyBundleBinding(
  params: VerifyBundleBindingParams,
): Promise<{signedAtMs: number}> {
  const sigBuf = fromBase64(params.authoritySig.sig);
  if (sigBuf.byteLength !== 64) {
    throw new CryptoError('bundle authority signature wrong length');
  }
  const pubBuf = fromBase64(params.authorityPubKeyB64);
  if (pubBuf.byteLength !== 32) {
    throw new CryptoError('authority public key wrong length');
  }

  const signedAtMs = params.authoritySig.signedAtMs;
  if (!Number.isFinite(signedAtMs) || signedAtMs <= 0) {
    throw new CryptoError('bundle authority signedAtMs invalid');
  }
  const now      = Date.now();
  const maxAge   = params.maxAgeMs    ?? DEFAULT_MAX_AGE_MS;
  const skew     = params.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (signedAtMs > now + skew) {
    throw new CryptoError('bundle authority signedAtMs in future');
  }
  if (now - signedAtMs > maxAge) {
    throw new CryptoError('bundle authority binding expired');
  }

  const msg = bundleBindingSigningInput({
    userId:          params.bundle.address.userId,
    identityKey:     params.bundle.identityKey,
    signedPrekeyId:  params.bundle.signedPreKey.keyId,
    signedPrekey:    params.bundle.signedPreKey.publicKey,
    signedPrekeySig: params.bundle.signedPreKey.signature,
    signedAtMs,
  });
  const msgAb = new ArrayBuffer(msg.byteLength);
  new Uint8Array(msgAb).set(msg);

  const {valid} = await verifyXEd25519Signature({
    publicKey: pubBuf,
    message:   msgAb,
    signature: sigBuf,
  });
  if (!valid) {
    throw new CryptoError('bundle authority signature invalid');
  }
  return {signedAtMs};
}

/**
 * Sign a bundle binding. Used by auth-service tests and by the
 * test-only auth-service mock in mobile integration tests. Production
 * signing happens in auth-service via its own AsyncCurve25519Wrapper
 * instance with the priv key from `SENDER_CERT_PRIVATE_KEY_B64`; this
 * helper exists so the canonicalization is single-source-of-truth.
 */
export async function signBundleBinding(params: {
  privateKeyB64:   string;
  userId:          string;
  identityKey:     string;
  signedPrekeyId:  number;
  signedPrekey:    string;
  signedPrekeySig: string;
  signedAtMs:      number;
}): Promise<BundleAuthoritySig> {
  const seedBuf = fromBase64(params.privateKeyB64);
  if (seedBuf.byteLength !== 32) {
    throw new CryptoError('authority private key wrong length');
  }
  // curve25519-typescript's `sign` expects the CLAMPED private key
  // produced by `keyPair(seed).privKey`, not the raw 32-byte seed.
  // Run the seed through keyPair() first so the signing key matches
  // what `keyPair(seed).pubKey` was derived from — without this,
  // verify with the derived pub silently fails on signatures that
  // were produced from the raw seed.
  const curve = new AsyncCurve25519Wrapper();
  const kp = await curve.keyPair(seedBuf);
  const msg = bundleBindingSigningInput(params);
  const msgAb = new ArrayBuffer(msg.byteLength);
  new Uint8Array(msgAb).set(msg);
  const sigAb = await curve.sign(kp.privKey, msgAb);
  return {
    sig:        Buffer.from(new Uint8Array(sigAb)).toString('base64'),
    signedAtMs: params.signedAtMs,
  };
}
