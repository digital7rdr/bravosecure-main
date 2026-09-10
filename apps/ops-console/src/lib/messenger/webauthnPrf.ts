/**
 * Audit fix 4.7 — passkey-derived vault key.
 *
 * BACKGROUND
 *  The IndexedDB vault is wrapped with an AES-GCM key derived from a
 *  passphrase (PBKDF2). Operators wrote those passphrases down (or
 *  re-used their login password), which is the exact failure mode the
 *  audit called out. Solution: bind the wrap key to the operator's
 *  platform authenticator (Touch ID, Windows Hello, hardware key)
 *  via the WebAuthn PRF extension. The PRF output is a stable 32-byte
 *  secret keyed by (credential, prf-input). Even if the indexed DB is
 *  exfiltrated, an attacker without the authenticator can't unwrap.
 *
 * PRF SUPPORT MATRIX (2026-Q2)
 *   - Chrome 116+ on Win/Mac/Linux: ✓ (platform + hybrid).
 *   - Firefox 122+: ✓ (platform).
 *   - Safari 17.4+: ✓ (platform, with hardware key).
 *   - Edge (Chromium): ✓.
 *  Detection is per-credential — `isPrfAvailable()` issues a real
 *  WebAuthn `get()` with PRF requested and inspects the result. If
 *  PRF is missing we surface that to the caller; the runtime falls
 *  back to the passphrase flow so an enterprise on a stale browser
 *  isn't locked out.
 *
 * STORAGE
 *  - The credential id (CBOR-decoded raw id) is stored in IndexedDB as
 *    `vault.passkey.credentialId` so the next unlock knows which
 *    authenticator to ask for. NOT secret.
 *  - The PRF salt is a per-vault random 32 bytes, stored next to it as
 *    `vault.passkey.prfSalt`. Combined with the credential it gives
 *    domain separation if the same authenticator backs multiple vaults.
 *  - The derived AES-GCM key NEVER touches storage.
 *
 * THREAT MODEL
 *  - XSS or read-only IndexedDB exfil → ciphertext only, no key.
 *  - Lost / wiped authenticator → vault is unrecoverable. Operators
 *    enroll a second authenticator (hardware key) so a stolen laptop
 *    doesn't trash their history. We expose `enrollAdditional()` on
 *    the runtime; the customer-facing privacy policy documents that
 *    the operator's vault is unrecoverable by Bravo.
 *  - Phishing the PRF response: the authenticator binds the response
 *    to the RP id, so a phishing origin gets a different secret.
 */

const RP_ID = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const RP_NAME = 'Bravo Ops Console';
const PRF_INFO_LABEL = 'bravo-ops-vault-v1';
const CHALLENGE_BYTES = 32;
const PRF_SALT_BYTES = 32;

export interface EnrolledPasskey {
  credentialId: Uint8Array;
  prfSalt:      Uint8Array;
}

/** Caller checks before offering passkey unlock. */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials !== 'undefined'
  );
}

/**
 * Enroll a platform authenticator for vault unwrap.
 *
 * Generates a fresh credential bound to the current origin and asks for
 * PRF eval input so the registration response immediately yields the
 * 32-byte unwrap secret. The caller (`runtime.enrollPasskey`) uses
 * that secret to re-wrap the vault root key, then persists the
 * `credentialId + prfSalt` for next unlock.
 *
 * Throws if:
 *   - WebAuthn isn't available
 *   - The authenticator refuses (user-cancelled, no UV)
 *   - The result lacks a PRF eval (PRF not supported by this authenticator)
 */
export async function enrollPasskey(
  userId: string,
  userDisplayName: string,
): Promise<{enrolled: EnrolledPasskey; secret: Uint8Array}> {
  if (!isPasskeySupported()) throw new Error('webauthn_not_supported');

  const prfSalt = crypto.getRandomValues(new Uint8Array(PRF_SALT_BYTES));
  const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
  const userIdBytes = new TextEncoder().encode(userId);

  const publicKey: PublicKeyCredentialCreationOptions & {extensions?: Record<string, unknown>} = {
    rp: {id: RP_ID, name: RP_NAME},
    user: {
      id: userIdBytes,
      name: userDisplayName,
      displayName: userDisplayName,
    },
    challenge,
    pubKeyCredParams: [
      {type: 'public-key', alg: -7},   // ES256
      {type: 'public-key', alg: -257}, // RS256 (Windows Hello)
    ],
    authenticatorSelection: {
      // Platform first (Touch ID / Windows Hello); fall back to hybrid.
      // Cross-platform hardware keys count as platform=undefined and
      // are accepted by default. UV required so a stolen laptop with
      // an unlocked authenticator can't be used to unwrap.
      userVerification: 'required',
      residentKey: 'required',
      requireResidentKey: true,
    },
    timeout: 60_000,
    attestation: 'none',  // we don't validate attestation; the PRF binding is the trust anchor
    extensions: {
      // PRF eval at registration → first secret available immediately.
      prf: {eval: {first: derivePrfInput(prfSalt)}},
    },
  };

  const cred = await navigator.credentials.create({publicKey}) as PublicKeyCredential | null;
  if (!cred) throw new Error('webauthn_create_returned_null');

  const credentialId = new Uint8Array(cred.rawId);
  const extResults = cred.getClientExtensionResults() as {prf?: {results?: {first?: ArrayBuffer}}};
  const first = extResults.prf?.results?.first;
  if (!first) {
    throw new Error('prf_not_supported_by_authenticator');
  }

  return {
    enrolled: {credentialId, prfSalt},
    secret:   new Uint8Array(first),
  };
}

/**
 * Run the PRF auth ceremony against an already-enrolled credential and
 * return the same 32-byte secret. Idempotent: the (credentialId, salt)
 * pair deterministically yields the same secret modulo the authenticator
 * actually being present.
 */
export async function unlockWithPasskey(enrolled: EnrolledPasskey): Promise<Uint8Array> {
  if (!isPasskeySupported()) throw new Error('webauthn_not_supported');

  const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
  const publicKey: PublicKeyCredentialRequestOptions & {extensions?: Record<string, unknown>} = {
    rpId: RP_ID,
    challenge,
    allowCredentials: [{
      type: 'public-key',
      id: enrolled.credentialId,
      transports: ['internal', 'hybrid', 'usb', 'nfc', 'ble'],
    }],
    userVerification: 'required',
    timeout: 60_000,
    extensions: {
      prf: {eval: {first: derivePrfInput(enrolled.prfSalt)}},
    },
  };

  const assertion = await navigator.credentials.get({publicKey}) as PublicKeyCredential | null;
  if (!assertion) throw new Error('webauthn_get_returned_null');

  const extResults = assertion.getClientExtensionResults() as {prf?: {results?: {first?: ArrayBuffer}}};
  const first = extResults.prf?.results?.first;
  if (!first) {
    throw new Error('prf_not_supported_by_authenticator');
  }
  return new Uint8Array(first);
}

/**
 * Derive the PRF eval input from the per-vault salt. The label provides
 * domain separation so a future feature that reuses the same
 * authenticator (e.g. signed-doc decrypt) derives a DIFFERENT secret.
 *
 * Audit OPS-MSG-05 — the input is `salt ‖ label`, returned in full. The
 * WebAuthn PRF extension accepts arbitrary-length input and the
 * authenticator HMACs it internally, so there is no need to hash or
 * truncate to 32 bytes. The previous implementation truncated to the
 * first 32 bytes, which (with a 32-byte salt) dropped the label
 * entirely and defeated the separation this function claims to provide.
 */
function derivePrfInput(salt: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(PRF_INFO_LABEL);
  const buf = new Uint8Array(salt.length + label.length);
  buf.set(salt, 0);
  buf.set(label, salt.length);
  return buf;
}

/**
 * Audit fix 4.7 — convert the PRF secret into the AES-GCM wrap key.
 * Single HKDF-equivalent: the secret IS already pseudorandom (HMAC-SHA-256
 * output from the authenticator), so we import directly as raw AES key
 * material instead of running another PBKDF2 round. PBKDF2 over a 32-byte
 * random seed gives no extra security and just adds latency.
 */
export async function importPasskeyDerivedKey(secret: Uint8Array): Promise<CryptoKey> {
  if (secret.byteLength !== 32) throw new Error('prf_secret_must_be_32_bytes');
  return crypto.subtle.importKey(
    'raw',
    secret,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt'],
  );
}
