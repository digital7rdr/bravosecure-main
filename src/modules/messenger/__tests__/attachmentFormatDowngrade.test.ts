/**
 * Audit Rev2 CRY-01 — "attachment integrity check can be skipped".
 *
 * `decryptAttachment` decided WHETHER TO VERIFY THE MAC by reading the first
 * byte of the blob it had just downloaded from storage:
 *
 *     if (ct[0] === FORMAT_V2) { ...verify HMAC... }
 *     else if (ct[0] === FORMAT_V1) { aesCt = ct.subarray(1); }   // no HMAC
 *     else { aesCt = ct; }                                        // no HMAC
 *
 * That byte is ATTACKER-CONTROLLED, and the sealed envelope carries no
 * authenticated "this must be v2" flag. This is version-negotiation-before-
 * authentication — the same shape as a TLS downgrade. Someone able to modify
 * stored ciphertext (a storage or server compromise, explicitly in our threat
 * model) prepends 0x01, we take the legacy branch, and AES-CBC decrypts with NO
 * integrity check at all. CBC malleability returns: targeted bit-flips produce
 * attacker-chosen changes in a document or image that then renders in the UI as
 * an authentic message from a verified sender.
 *
 * The encrypt-then-MAC construction was always correct. The bug was only the
 * branch selector.
 *
 * WHY THE FIX IS "REQUIRE V2", NOT "THREAD expectedFormat FROM THE ENVELOPE":
 *   - There IS no envelope at download time. It is parsed once at receive and
 *     its fields are written to DB columns; downloads read the ROW. A photo
 *     opened after an app restart has no envelope to consult.
 *   - v1 NEVER SHIPPED. `git log -S` proves the initial implementation (0b5f371)
 *     had no version byte at all, and FORMAT_V1 and FORMAT_V2 were introduced
 *     TOGETHER in e69fd03. No commit has ever produced a 0x01 blob, so that
 *     branch is reachable only by an attacker.
 *   - The MAC already covers the version byte (macInput[0] = FORMAT_V2), so once
 *     v2 is required the version is authenticated for free.
 */
import {encryptAttachment, decryptAttachment} from '../media/aesCbc';

const FORMAT_V1 = 0x01;
const FORMAT_V2 = 0x02;
const HMAC_BYTES = 32;

const PLAINTEXT = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, // "%PDF-1.7"
  0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33,
  0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb,
]);

describe('CRY-01 — the attachment format byte must not select the security path', () => {
  it('sanity: a genuine v2 attachment round-trips', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    expect(enc.ciphertext[0]).toBe(FORMAT_V2);
    const out = await decryptAttachment({
      keyB64: enc.key, ivB64: enc.iv, ciphertext: enc.ciphertext,
    });
    expect(Array.from(out)).toEqual(Array.from(PLAINTEXT));
  });

  // THE ATTACK. Strip the 32-byte tag and flip the version byte to 0x01: the
  // remaining bytes are EXACTLY the v1 branch's `ct.subarray(1)`, so it decrypts
  // cleanly with no integrity check.
  it('rejects a v2 blob downgraded to the un-MACed v1 branch', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    const downgraded = enc.ciphertext.slice(0, enc.ciphertext.byteLength - HMAC_BYTES);
    downgraded[0] = FORMAT_V1;

    await expect(decryptAttachment({
      keyB64: enc.key, ivB64: enc.iv, ciphertext: downgraded,
    })).rejects.toThrow();
  });

  it('rejects a v2 blob downgraded to the un-MACed no-version branch', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    // Any first byte that is neither 0x01 nor 0x02 took the `else` branch, which
    // treated the WHOLE blob as ciphertext and skipped the MAC entirely.
    const downgraded = enc.ciphertext.slice(0, enc.ciphertext.byteLength - HMAC_BYTES);
    downgraded[0] = 0x7f;

    await expect(decryptAttachment({
      keyB64: enc.key, ivB64: enc.iv, ciphertext: downgraded,
    })).rejects.toThrow();
  });

  it('still rejects a tampered v2 body (the MAC check itself is unchanged)', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    const tampered = Uint8Array.from(enc.ciphertext);
    tampered[5] ^= 0xff;                       // flip a bit inside the AES body

    await expect(decryptAttachment({
      keyB64: enc.key, ivB64: enc.iv, ciphertext: tampered,
    })).rejects.toThrow(/hmac mismatch/i);
  });

  it('rejects a blob too short to carry a tag rather than falling through', async () => {
    const enc = await encryptAttachment(PLAINTEXT);
    await expect(decryptAttachment({
      keyB64: enc.key, ivB64: enc.iv, ciphertext: enc.ciphertext.slice(0, 8),
    })).rejects.toThrow();
  });
});
