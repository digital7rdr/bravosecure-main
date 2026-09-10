/**
 * Audit P0-1 — verify the client/server HMAC proof matches byte-for-byte.
 *
 * The server (apps/messenger-service/src/backup/backup.service.ts)
 * recomputes the proof as:
 *
 *   HMAC-SHA256(verifier_key,
 *               "bravo-backup-verify-v1" || ":" || userId || ":" || nonce)
 *
 * `computeVerifyProof` is the client counterpart. If the two ever drift
 * the verify endpoint becomes universally-rejecting (every legitimate
 * client fails proof). This test is the canary: pin both halves of the
 * domain-separation contract.
 */
import {createHmac} from 'node:crypto';
import {computeVerifyProof, deriveVerifierKey} from '../backup/backupCrypto';

// Mirror of the server's constants — if either side changes them, this
// test starts failing immediately rather than at production restore.
const VERIFY_DOMAIN_TAG = 'bravo-backup-verify-v1';

function expectedProof(verifierKey: Uint8Array, userId: string, nonce: string): Uint8Array {
  const mac = createHmac('sha256', Buffer.from(verifierKey));
  mac.update(Buffer.from(VERIFY_DOMAIN_TAG, 'utf8'));
  mac.update(Buffer.from(':', 'utf8'));
  mac.update(Buffer.from(userId, 'utf8'));
  mac.update(Buffer.from(':', 'utf8'));
  mac.update(Buffer.from(nonce, 'utf8'));
  return new Uint8Array(mac.digest());
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {return false;}
  for (let i = 0; i < a.length; i++) {if (a[i] !== b[i]) {return false;}}
  return true;
}

describe('P0-1 backup verify proof', () => {
  it('client proof matches server HMAC byte-for-byte', async () => {
    const verifierKey = new Uint8Array(32);
    for (let i = 0; i < verifierKey.length; i++) {verifierKey[i] = i + 1;}
    const userId = '0000aaaa-bbbb-cccc-dddd-eeeeffff0001';
    const nonce  = 'IPCG3i/6OWG3lOdo7crSnsRGCDgZuVZ23dCJpAhEHzc=';

    const proof = await computeVerifyProof(verifierKey, userId, nonce);
    const exp   = expectedProof(verifierKey, userId, nonce);

    expect(eqBytes(proof, exp)).toBe(true);
    expect(proof.length).toBe(32);
  });

  it('proof changes when the nonce changes (replay resistance)', async () => {
    const verifierKey = new Uint8Array(32);
    verifierKey[0] = 0xab;
    const userId = 'user-1';
    const p1 = await computeVerifyProof(verifierKey, userId, 'nonce-A');
    const p2 = await computeVerifyProof(verifierKey, userId, 'nonce-B');
    expect(eqBytes(p1, p2)).toBe(false);
  });

  it('proof changes when the userId changes (cross-account replay resistance)', async () => {
    const verifierKey = new Uint8Array(32);
    verifierKey[0] = 0xab;
    const nonce = 'nonce-shared';
    const p1 = await computeVerifyProof(verifierKey, 'user-1', nonce);
    const p2 = await computeVerifyProof(verifierKey, 'user-2', nonce);
    expect(eqBytes(p1, p2)).toBe(false);
  });

  it('proof changes when the verifier key changes (wrong-password rejects)', async () => {
    const k1 = new Uint8Array(32); k1[0] = 0x01;
    const k2 = new Uint8Array(32); k2[0] = 0x02;
    const p1 = await computeVerifyProof(k1, 'user', 'nonce');
    const p2 = await computeVerifyProof(k2, 'user', 'nonce');
    expect(eqBytes(p1, p2)).toBe(false);
  });

  it('deriveVerifierKey is deterministic + binds to its HKDF info tag', async () => {
    const derived = new Uint8Array(32);
    for (let i = 0; i < derived.length; i++) {derived[i] = i;}
    const v1 = await deriveVerifierKey(derived);
    const v2 = await deriveVerifierKey(derived);
    expect(eqBytes(v1, v2)).toBe(true);
    expect(v1.length).toBe(32);

    // A different derived key yields a different verifier — sanity check
    // that the HKDF doesn't collapse the input.
    const derived2 = derived.slice();
    derived2[0] ^= 1;
    const v3 = await deriveVerifierKey(derived2);
    expect(eqBytes(v1, v3)).toBe(false);
  });

  it('deriveVerifierKey rejects wrong-length input', async () => {
    await expect(deriveVerifierKey(new Uint8Array(16))).rejects.toThrow(/wrong_length/);
  });

  // B-45 — deriveVerifierKey moved from WebCrypto HKDF (not implemented
  // by react-native-quick-crypto 0.7.17 on device) to @noble/hashes.
  // These two tests pin the output to the ORIGINAL WebCrypto contract so
  // the swap (and any future one) can never silently re-derive different
  // verifier keys, which would brick every existing backup's /verify.

  it('deriveVerifierKey matches the pinned HKDF-SHA256 vector (empty salt)', async () => {
    const ikm = new Uint8Array(32);
    for (let i = 0; i < ikm.length; i++) {ikm[i] = i;}
    const v = await deriveVerifierKey(ikm);
    const hex = Array.from(v).map(b => b.toString(16).padStart(2, '0')).join('');
    // Computed with Node WebCrypto: HKDF-SHA256, salt=empty,
    // info='bravo-backup-verifier-v1', L=32 — the pre-B-45 implementation.
    expect(hex).toBe('00fd2a334b9ad3ec65d8e33e444df99d123b28c5d60453eace07c0186b59d5d4');
  });

  it('deriveVerifierKey matches WebCrypto HKDF byte-for-byte (cross-impl)', async () => {
    const {webcrypto} = require('node:crypto') as typeof import('node:crypto');
    const ikm = new Uint8Array(32);
    for (let i = 0; i < ikm.length; i++) {ikm[i] = (i * 7 + 3) & 0xff;}
    const ours = await deriveVerifierKey(ikm);
    const key = await webcrypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await webcrypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new ArrayBuffer(0),
        info: new TextEncoder().encode('bravo-backup-verifier-v1'),
      },
      key,
      256,
    );
    expect(eqBytes(ours, new Uint8Array(bits))).toBe(true);
  });
});
