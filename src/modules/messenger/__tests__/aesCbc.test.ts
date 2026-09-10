import {encryptAttachment, decryptAttachment} from '../media/aesCbc';

describe('Attachment AES-256-CBC', () => {
  it('encrypts then decrypts with byte-for-byte equality', async () => {
    const pt = Buffer.from('hello attachment bytes — could be an image, PDF, etc');
    const enc = await encryptAttachment(new Uint8Array(pt));
    expect(enc.ciphertext.byteLength).toBeGreaterThan(pt.byteLength); // padding grows it
    const roundTrip = await decryptAttachment({
      keyB64:     enc.key,
      ivB64:      enc.iv,
      ciphertext: enc.ciphertext,
    });
    expect(Buffer.from(roundTrip).equals(pt)).toBe(true);
  });

  it('produces distinct ciphertexts for the same plaintext', async () => {
    const pt = new Uint8Array(Buffer.from('identical input bytes'));
    const a  = await encryptAttachment(pt);
    const b  = await encryptAttachment(pt);
    // Fresh key + IV per call → ciphertexts should differ.
    expect(a.key).not.toBe(b.key);
    expect(a.iv).not.toBe(b.iv);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it('rejects a tampered ciphertext (CBC padding validation)', async () => {
    const pt = new Uint8Array(Buffer.from('sensitive content'));
    const enc = await encryptAttachment(pt);
    const tampered = Uint8Array.from(enc.ciphertext);
    tampered[tampered.byteLength - 1] ^= 0xff; // flip a byte in the last block
    await expect(
      decryptAttachment({keyB64: enc.key, ivB64: enc.iv, ciphertext: tampered}),
    ).rejects.toBeDefined();
  });

  it('decrypts correctly when the ciphertext is a non-zero-offset subarray view', async () => {
    // The receive path slices the v2 blob with `ct.subarray(1, tagOffset)`
    // — a Uint8Array view with a non-zero byteOffset. Lock that the
    // Node-style createDecipheriv path handles the view (byteOffset/
    // byteLength) without re-copying-induced corruption.
    const pt = new Uint8Array(Buffer.from('view-backed plaintext bytes for offset test'));
    const enc = await encryptAttachment(pt);
    // Wrap the ciphertext in a larger buffer so the passed view has a
    // non-zero offset, mirroring how the v2 parser hands us aesCt.
    const padded = new Uint8Array(8 + enc.ciphertext.byteLength);
    padded.set(enc.ciphertext, 8);
    const view = padded.subarray(8);
    const roundTrip = await decryptAttachment({
      keyB64: enc.key, ivB64: enc.iv, ciphertext: view,
    });
    expect(Buffer.from(roundTrip).equals(Buffer.from(pt))).toBe(true);
  });

  it('rejects wrong key length', async () => {
    const pt = new Uint8Array(Buffer.from('x'));
    const enc = await encryptAttachment(pt);
    await expect(
      decryptAttachment({keyB64: 'c2hvcnQ=' /* "short" */, ivB64: enc.iv, ciphertext: enc.ciphertext}),
    ).rejects.toThrow(/invalid key length/);
  });
});
