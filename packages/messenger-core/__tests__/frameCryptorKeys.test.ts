/**
 * deriveParticipantKey — coverage for the per-participant AES-256 key
 * derivation handed to libwebrtc's FrameCryptor (see
 * docs/ARCHITECTURE_AMENDMENT_SFRAME.md). The cipher itself runs
 * natively in libwebrtc; this test only locks the key schedule so two
 * peers deterministically arrive at the same key from the same
 * (master, epoch, participantTag) tuple.
 */

import {deriveParticipantKey, epochToKeyIndex, KEY_RING_SIZE} from '../src/calls/frameCryptorKeys';

const MASTER_A = Buffer.from(new Uint8Array(32).fill(0x11)).toString('base64');
const MASTER_B = Buffer.from(new Uint8Array(32).fill(0x22)).toString('base64');

describe('deriveParticipantKey', () => {
  it('returns a 32-byte (base64) AES-256 key', async () => {
    const k = await deriveParticipantKey(MASTER_A, 0, 'alice');
    expect(Buffer.from(k, 'base64').byteLength).toBe(32);
  });

  it('is deterministic in (master, epoch, participantTag)', async () => {
    const k1 = await deriveParticipantKey(MASTER_A, 7, 'alice');
    const k2 = await deriveParticipantKey(MASTER_A, 7, 'alice');
    expect(k1).toBe(k2);
  });

  it('differs across participants (same master+epoch)', async () => {
    const a = await deriveParticipantKey(MASTER_A, 1, 'alice');
    const b = await deriveParticipantKey(MASTER_A, 1, 'bob');
    expect(a).not.toBe(b);
  });

  it('differs across epochs (same master+participant) — rotation gives a fresh key', async () => {
    const e0 = await deriveParticipantKey(MASTER_A, 0, 'alice');
    const e1 = await deriveParticipantKey(MASTER_A, 1, 'alice');
    expect(e0).not.toBe(e1);
  });

  it('differs across master keys (same epoch+participant) — group separation', async () => {
    const a = await deriveParticipantKey(MASTER_A, 5, 'alice');
    const b = await deriveParticipantKey(MASTER_B, 5, 'alice');
    expect(a).not.toBe(b);
  });

  it('rejects a master key of the wrong size', async () => {
    const short = Buffer.alloc(16).toString('base64');
    await expect(deriveParticipantKey(short, 0, 'alice')).rejects.toThrow(/32-byte/);
  });
});

describe('epochToKeyIndex', () => {
  it('maps epochs into the [0, KEY_RING_SIZE) ring', () => {
    expect(KEY_RING_SIZE).toBe(16);
    for (let e = 0; e < 64; e++) {
      const idx = epochToKeyIndex(e);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(KEY_RING_SIZE);
    }
  });

  it('wraps every KEY_RING_SIZE epochs', () => {
    expect(epochToKeyIndex(0)).toBe(epochToKeyIndex(KEY_RING_SIZE));
    expect(epochToKeyIndex(1)).toBe(epochToKeyIndex(KEY_RING_SIZE + 1));
  });

  it('clamps negative epochs to 0', () => {
    expect(epochToKeyIndex(-1)).toBe(0);
    expect(epochToKeyIndex(-99)).toBe(0);
  });
});
