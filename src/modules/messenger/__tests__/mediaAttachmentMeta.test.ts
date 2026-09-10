/**
 * Media-parity (2026-07-03) — sealed-attachment metadata round-trip +
 * validation. The optional display fields (name/width/height/durationMs/
 * thumbB64) ride INSIDE the sealed payload; the envelope validator must
 * accept them when well-formed and REJECT wrong types / oversized
 * thumbnails so a hostile sender can't crash the renderer or bloat the
 * envelope. Also pins the native-HMAC path produces byte-identical
 * output to the reference (G14) via a full encrypt→decrypt round-trip.
 */

import {sealPayload, unsealPayload} from '@bravo/messenger-core';
import {encryptAttachment, decryptAttachment} from '../media/aesCbc';

const CERT = 'test-cert';

function seal(attachment: unknown): string {
  return sealPayload(CERT, 'caption', {attachment: attachment as never});
}

describe('sealed attachment metadata — validation', () => {
  const base = {
    objectKey: 'att/abc',
    keyB64:    'AAAA',
    ivB64:     'BBBB',
    mimeType:  'image/jpeg',
    size:      1234,
  };

  it('accepts a full metadata block', () => {
    const json = seal({
      ...base,
      kind:       'image',
      name:       'holiday.jpg',
      width:      1920,
      height:     1080,
      durationMs: 0,
      thumbB64:   'dGh1bWI=',
    });
    const back = unsealPayload(json);
    expect(back.attachment?.width).toBe(1920);
    expect(back.attachment?.name).toBe('holiday.jpg');
    expect((back.attachment as {thumbB64?: string}).thumbB64).toBe('dGh1bWI=');
  });

  it('accepts an attachment with NO metadata (legacy senders unchanged)', () => {
    const back = unsealPayload(seal(base));
    expect(back.attachment?.objectKey).toBe('att/abc');
    expect((back.attachment as {name?: string}).name).toBeUndefined();
  });

  it('rejects a wrong-typed dimension', () => {
    expect(() => unsealPayload(seal({...base, width: 'huge'}))).toThrow();
  });

  it('rejects an over-long filename', () => {
    expect(() => unsealPayload(seal({...base, name: 'x'.repeat(257)}))).toThrow();
  });

  it('rejects an oversized thumbnail (envelope-bloat guard)', () => {
    expect(() => unsealPayload(seal({...base, thumbB64: 'A'.repeat(64 * 1024 + 1)}))).toThrow();
  });
});

describe('aesCbc native-HMAC path — round-trip integrity (G14)', () => {
  it('encrypt→decrypt returns the exact plaintext for varied sizes', async () => {
    for (const n of [0, 1, 15, 16, 17, 4096, 100_000]) {
      const pt = new Uint8Array(n);
      for (let i = 0; i < n; i++) {pt[i] = (i * 31 + 7) & 0xff;}
      const enc = await encryptAttachment(pt);
      const back = await decryptAttachment({keyB64: enc.key, ivB64: enc.iv, ciphertext: enc.ciphertext});
      expect(Array.from(back)).toEqual(Array.from(pt));
    }
  });

  it('a flipped ciphertext byte fails the HMAC (tamper still caught)', async () => {
    const pt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const enc = await encryptAttachment(pt);
    enc.ciphertext[5] ^= 0xff; // corrupt inside the AES ciphertext region
    await expect(
      decryptAttachment({keyB64: enc.key, ivB64: enc.iv, ciphertext: enc.ciphertext}),
    ).rejects.toThrow(/hmac/i);
  });
});
