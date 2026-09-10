/**
 * Audit P0-I2 — authority signature over the keys-service bundle.
 *
 * Receiving clients verify this signature before trusting any new peer
 * identity learned from a `GET /auth/keys/:userId` response. Closes the
 * cold-start residual of P0-1 (1:1 ratchet-wipe attack via forged outer
 * envelope): with P0-I2, the cert's `senderIdentityKey` claim must
 * match the verified `bundle.identityKey` for the same userId — a
 * malicious keys-service can no longer substitute identity end-to-end.
 *
 * The signing primitive is XEd25519 over the same Curve25519 authority
 * private key that signs sender certs (`SENDER_CERT_PRIVATE_KEY_B64`).
 * Reusing the key keeps the trust root single — clients already pin the
 * authority pubkey at build time for sender-cert verify, so no new key
 * distribution is needed.
 *
 * Canonical signing input MUST stay byte-for-byte identical to the
 * mobile-side implementation in
 *   `packages/messenger-core/src/crypto/bundleBinding.ts`
 * The shared canonicalization is unit-tested on both sides against the
 * same known-vector so accidental drift fails loud.
 *
 * Why plain-text canonicalization (not JSON):
 *   JSON.stringify is implementation-defined for key order, whitespace,
 *   and number-vs-string serialization. A `k=v\n` block with an
 *   explicit version prefix has no such freedom.
 *
 * What is and isn't bound:
 *   - oneTimePrekey is intentionally NOT bound. OPKs are popped per
 *     fetch (single-use), so a per-OPK binding would force re-signing
 *     on every bundle fetch. The OPK substitution attack is already
 *     caught at receive time by libsignal's X3DH MAC check; P0-I2
 *     closes the trust layer above.
 *   - registrationId is also not bound — it's a libsignal session
 *     freshness value, not a trust binding.
 */

import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';

export const BUNDLE_BINDING_VERSION = 'bsc-bundle-v1';

export interface BundleAuthoritySig {
  /** 64-byte XEd25519 signature, base64. */
  sig:        string;
  /** Server wall-clock at signing time, ms epoch. */
  signedAtMs: number;
}

export interface BundleBindingFields {
  userId:          string;
  identityKey:     string;
  signedPrekeyId:  number;
  signedPrekey:    string;
  signedPrekeySig: string;
  signedAtMs:      number;
}

/**
 * Canonical bytes the authority signs. Mirrors
 * `packages/messenger-core/src/crypto/bundleBinding.ts`. Tests on both
 * sides pin the same vector — keep them in lockstep.
 */
export function bundleBindingSigningInput(p: BundleBindingFields): Buffer {
  const lines = [
    BUNDLE_BINDING_VERSION,
    `userId=${p.userId}`,
    `identityKey=${p.identityKey}`,
    `signedPrekeyId=${p.signedPrekeyId}`,
    `signedPrekey=${p.signedPrekey}`,
    `signedPrekeySig=${p.signedPrekeySig}`,
    `signedAtMs=${p.signedAtMs}`,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * Sign a bundle binding with the supplied Curve25519 private key
 * (base64). Returns the auth-sig block the controller will attach to
 * the bundle response.
 *
 * Throws if the key is missing/wrong-length so a misconfigured deploy
 * surfaces at the first bundle fetch instead of as a silent verify
 * failure on the client.
 */
export async function signBundleBinding(
  privateKeyB64: string,
  fields: BundleBindingFields,
  curve: AsyncCurve25519Wrapper = sharedCurve,
): Promise<BundleAuthoritySig> {
  if (!privateKeyB64) {
    throw new Error('bundle_binding_priv_key_missing');
  }
  const seed = Buffer.from(privateKeyB64, 'base64');
  if (seed.byteLength !== 32) {
    throw new Error('bundle_binding_priv_key_wrong_length');
  }
  // curve25519-typescript's `sign` expects the clamped private key
  // produced by `keyPair(seed).privKey` (not the raw seed). Mirror the
  // pattern used elsewhere — see senderCert spec test fixtures.
  // `.buffer` on a Node Buffer is typed `ArrayBuffer | SharedArrayBuffer`
  // after newer @types/node lib bumps; the curve wrapper only accepts
  // ArrayBuffer. The runtime value is always an ArrayBuffer here (Node
  // Buffer.from(string,'base64') and TextEncoder().encode() both produce
  // a non-shared backing store), so the cast is sound.
  const seedAb = seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength) as ArrayBuffer;
  const kp = await curve.keyPair(seedAb);
  const msg = bundleBindingSigningInput(fields);
  const msgAb = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) as ArrayBuffer;
  const sigAb = await curve.sign(kp.privKey, msgAb);
  return {
    sig:        Buffer.from(new Uint8Array(sigAb)).toString('base64'),
    signedAtMs: fields.signedAtMs,
  };
}

const sharedCurve = new AsyncCurve25519Wrapper();
