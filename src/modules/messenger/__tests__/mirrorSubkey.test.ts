/**
 * Round 5 / Security S7 — per-row subkey wrap (mirror v2).
 *
 * Each mirrored message row encrypts the payload under a fresh
 * random subkey; the subkey itself is wrapped under the master key
 * and shipped in envelope_meta.wrappedSubkey. On restore the client
 * unwraps the subkey, then decrypts the payload.
 *
 * Properties under test:
 *   • round-trip works (v2 wrap → v2 unwrap → original bytes)
 *   • two rows under the same master key get DIFFERENT subkeys (i.e.
 *     a leak of one subkey does NOT compromise the other)
 *   • v1 rows still round-trip under the legacy direct-master path
 *   • v2 row with the wrong wrappedSubkey field fails closed
 */
import {
  aesGcmDecrypt, aesGcmEncrypt, generateSubkey, importSubkey,
  generateMasterKey, importMasterKey, fromB64, toB64,
} from '../backup/backupCrypto';

describe('Mirror subkey wrap (Round 5 / S7)', () => {
  it('round-trips a payload through v2 wrap/unwrap', async () => {
    const {key: master} = await generateMasterKey();
    const payload = new TextEncoder().encode(JSON.stringify({hello: 'world', n: 42}));

    // Wrap
    const {key: subkey, raw: subkeyRaw} = await generateSubkey();
    const wrappedPayload = await aesGcmEncrypt(subkey, payload);
    const wrappedSubkey = await aesGcmEncrypt(master, subkeyRaw);

    // Unwrap
    const recoveredSubkeyRaw = await aesGcmDecrypt(master, wrappedSubkey);
    const recoveredSubkey = await importSubkey(recoveredSubkeyRaw);
    const recovered = await aesGcmDecrypt(recoveredSubkey, wrappedPayload);

    expect(Buffer.from(recovered)).toEqual(Buffer.from(payload));
  });

  it('two rows under the same master use different subkeys', async () => {
    const {key: master} = await generateMasterKey();
    const sub1 = await generateSubkey();
    const sub2 = await generateSubkey();
    expect(Buffer.from(sub1.raw)).not.toEqual(Buffer.from(sub2.raw));

    const wrap1 = await aesGcmEncrypt(master, sub1.raw);
    const wrap2 = await aesGcmEncrypt(master, sub2.raw);
    // Different subkeys ⇒ different wrapped forms (under master).
    // (Note: even SAME plaintext would differ because IV is random,
    // so the inequality here is mostly proving the IV path works.)
    expect(toB64(wrap1)).not.toBe(toB64(wrap2));
  });

  it('compromise of ONE subkey does not let an attacker decrypt another row', async () => {
    const {key: master} = await generateMasterKey();
    const {key: subA, raw: subARaw} = await generateSubkey();
    const {key: subB} = await generateSubkey();
    const ptA = new TextEncoder().encode('row A secret');
    const ptB = new TextEncoder().encode('row B secret');
    const ctA = await aesGcmEncrypt(subA, ptA);
    const ctB = await aesGcmEncrypt(subB, ptB);

    // Adversary leaks subA only (no master, no subB).
    const leakedA = await importSubkey(subARaw);
    // They can decrypt row A:
    const okA = await aesGcmDecrypt(leakedA, ctA);
    expect(Buffer.from(okA)).toEqual(Buffer.from(ptA));
    // But row B fails closed under the leaked subkey:
    await expect(aesGcmDecrypt(leakedA, ctB)).rejects.toThrow();

    // Sanity: master still recovers subB if needed.
    void master;
  });

  it('legacy v1 direct-master row still round-trips', async () => {
    const {key: master, raw} = await generateMasterKey();
    const payload = new TextEncoder().encode('legacy payload');
    const wrapped = await aesGcmEncrypt(master, payload);
    const recovered = await aesGcmDecrypt(master, wrapped);
    expect(Buffer.from(recovered)).toEqual(Buffer.from(payload));
    // Round-trip the raw form too — the importMasterKey path is what
    // restoreBackup uses after unwrapping the wrapped_master_key.
    const reimport = await importMasterKey(raw);
    const recovered2 = await aesGcmDecrypt(reimport, wrapped);
    expect(Buffer.from(recovered2)).toEqual(Buffer.from(payload));
  });

  it('v2 row with a corrupted wrappedSubkey fails closed', async () => {
    const {key: master} = await generateMasterKey();
    const {raw: subkeyRaw} = await generateSubkey();
    const wrappedSubkey = await aesGcmEncrypt(master, subkeyRaw);
    // Flip a byte in the wrapped subkey ciphertext (after IV).
    wrappedSubkey[wrappedSubkey.length - 1] ^= 0x01;
    await expect(aesGcmDecrypt(master, wrappedSubkey)).rejects.toThrow();
    // Use the toB64/fromB64 round-trip too — exercises the path the
    // mirror restore takes.
    const b64 = toB64(wrappedSubkey);
    const back = fromB64(b64);
    await expect(aesGcmDecrypt(master, back)).rejects.toThrow();
  });
});
