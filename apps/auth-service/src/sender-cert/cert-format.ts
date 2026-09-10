/**
 * Bravo Sealed Cert (BSC) — XEd25519-signed sender certificate format.
 *
 * The auth-service mints these and the messenger clients verify them.
 * It uses the same Curve25519/XEd25519 primitive libsignal already
 * brings in transitively (`@privacyresearch/curve25519-typescript`),
 * so neither mobile nor ops-console need a fresh Ed25519 polyfill.
 *
 * Wire shape — three base64 segments joined by dots, JWT-shaped but
 * NOT a standard JWS (`alg` is `XEd25519`, not in the JOSE registry):
 *
 *   <base64(headerJson)>.<base64(payloadJson)>.<base64(sig64)>
 *
 * The signing input is utf-8 of the first two segments joined by '.'.
 * Signature is the raw 64-byte XEd25519 output of Curve25519Wrapper.sign.
 */

export const CERT_HEADER = {alg: 'XEd25519', typ: 'BSC'} as const;

export interface CertPayload {
  senderUserId:         string;
  senderSignalDeviceId: number;
  senderIdentityKey:    string;
  iat: number;
  exp: number;
  iss: string;
  jti: string;
  /**
   * P2-17 — "revoke all sessions" generation counter at mint time. ADDITIVE
   * and OPTIONAL: old verifiers ignore unknown fields, so shipping it doesn't
   * break existing cert verification. A verifier that knows the sender's
   * current generation can reject any cert whose `gen` is behind it, which is
   * what makes `revokeAllForUser` (which increments the counter) actually
   * invalidate outstanding certs. It is part of the SIGNED payload so it
   * can't be stripped/downgraded in flight.
   */
  gen?: number;
}

export function encodeCert(payload: CertPayload, sig: Uint8Array): string {
  const headerB64  = b64(JSON.stringify(CERT_HEADER));
  const payloadB64 = b64(JSON.stringify(payload));
  const sigB64     = b64FromBytes(sig);
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

/** Bytes that the signer must sign. Caller hands these to Curve25519. */
export function signingInput(payload: CertPayload): Uint8Array {
  const headerB64  = b64(JSON.stringify(CERT_HEADER));
  const payloadB64 = b64(JSON.stringify(payload));
  return new TextEncoder().encode(`${headerB64}.${payloadB64}`);
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function b64FromBytes(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');
}
