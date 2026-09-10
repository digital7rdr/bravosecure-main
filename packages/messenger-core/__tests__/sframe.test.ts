/* eslint-disable no-bitwise -- binary protocol tests: header inspection + bit-flip negative cases use bitwise ops */
import {
  SframeSender,
  SframeReceiver,
  ReplayWindow,
  deriveSframeBaseKey,
  parseFrameHeader,
  SFRAME_VERSION,
  SFRAME_HEADER_LEN,
  SFRAME_TAG_LEN,
  SFRAME_KIND_AUDIO,
  SFRAME_KIND_VIDEO,
} from '../src/calls/sframe';
import {toBase64} from '../src/crypto/encoding';

function randomMasterKeyB64(): string {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return toBase64(k.buffer.slice(k.byteOffset, k.byteOffset + k.byteLength));
}

function bytes(n: number, fill = 0xab): Uint8Array {
  const b = new Uint8Array(n);
  b.fill(fill);
  return b;
}

describe('sframe key schedule', () => {
  it('derives identical base keys on both sides from the same master + epoch', async () => {
    const mk = randomMasterKeyB64();
    const a = await deriveSframeBaseKey(mk, 0);
    const b = await deriveSframeBaseKey(mk, 0);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(a.byteLength).toBe(32);
  });

  it('produces different keys for different epochs (rekey domain separation)', async () => {
    const mk = randomMasterKeyB64();
    const e0 = await deriveSframeBaseKey(mk, 0);
    const e1 = await deriveSframeBaseKey(mk, 1);
    expect(Buffer.from(e0).equals(Buffer.from(e1))).toBe(false);
  });

  it('produces different keys for different master secrets', async () => {
    const a = await deriveSframeBaseKey(randomMasterKeyB64(), 7);
    const b = await deriveSframeBaseKey(randomMasterKeyB64(), 7);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('rejects a master key of the wrong length', async () => {
    const short = toBase64(new Uint8Array(16).buffer);
    await expect(deriveSframeBaseKey(short, 0)).rejects.toThrow(/32 bytes/);
  });
});

describe('sframe header', () => {
  it('round-trips version + kind + counter', async () => {
    const sender = await makeSender({participantTag: 'tag1', kind: 'video'});
    const env = await sender.encryptFrame(bytes(64));
    const h = parseFrameHeader(env);
    expect(h.version).toBe(SFRAME_VERSION);
    expect(h.kind).toBe('video');
    expect(h.counter).toBe(0);
  });

  it('rejects unsupported version byte', () => {
    const env = new Uint8Array(SFRAME_HEADER_LEN + SFRAME_TAG_LEN);
    env[0] = 0xff;
    env[1] = SFRAME_KIND_AUDIO;
    expect(() => parseFrameHeader(env)).toThrow(/unsupported version/);
  });

  it('rejects unknown kind byte', () => {
    const env = new Uint8Array(SFRAME_HEADER_LEN + SFRAME_TAG_LEN);
    env[0] = SFRAME_VERSION;
    env[1] = 0x09;
    expect(() => parseFrameHeader(env)).toThrow(/unknown kind/);
  });

  it('rejects frames smaller than header + tag', () => {
    expect(() => parseFrameHeader(new Uint8Array(SFRAME_HEADER_LEN + SFRAME_TAG_LEN - 1)))
      .toThrow(/too short/);
  });
});

async function makeSender(args: {
  participantTag: string;
  kind:           'audio' | 'video';
  masterKeyB64?:  string;
  epoch?:         number;
}): Promise<SframeSender> {
  const mk = args.masterKeyB64 ?? randomMasterKeyB64();
  const epoch = args.epoch ?? 0;
  const baseKey = await deriveSframeBaseKey(mk, epoch);
  return new SframeSender({baseKey, epoch, participantTag: args.participantTag, kind: args.kind});
}

async function makeReceiver(args: {
  participantTag: string;
  kind:           'audio' | 'video';
  masterKeyB64:   string;
  epoch:          number;
}): Promise<SframeReceiver> {
  const baseKey = await deriveSframeBaseKey(args.masterKeyB64, args.epoch);
  return new SframeReceiver({baseKey, epoch: args.epoch, participantTag: args.participantTag, kind: args.kind});
}

describe('sframe roundtrip', () => {
  it('encrypts then decrypts an audio payload byte-for-byte', async () => {
    const mk = randomMasterKeyB64();
    const sender = new SframeSender({
      baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0,
      participantTag: 'alice-tag', kind: 'audio',
    });
    const receiver = await makeReceiver({participantTag: 'alice-tag', kind: 'audio', masterKeyB64: mk, epoch: 0});
    const payload = bytes(160, 0x42); // ~20 ms of 8 kHz mono PCM
    const env = await sender.encryptFrame(payload);
    const out = await receiver.decryptFrame(env);
    expect(Buffer.from(out).equals(Buffer.from(payload))).toBe(true);
  });

  it('handles 100 frames in counter order', async () => {
    const mk = randomMasterKeyB64();
    const sender   = new SframeSender({baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0, participantTag: 'p', kind: 'video'});
    const receiver = await makeReceiver({participantTag: 'p', kind: 'video', masterKeyB64: mk, epoch: 0});
    for (let i = 0; i < 100; i++) {
      const pt = bytes(120, i & 0xff);
      const env = await sender.encryptFrame(pt);
      const out = await receiver.decryptFrame(env);
      expect(out[0]).toBe(i & 0xff);
    }
  });

  it('rejects a frame from a different participant (wrong tag in key derivation)', async () => {
    const mk = randomMasterKeyB64();
    const sender = new SframeSender({baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0, participantTag: 'alice', kind: 'audio'});
    const receiver = await makeReceiver({participantTag: 'mallory', kind: 'audio', masterKeyB64: mk, epoch: 0});
    const env = await sender.encryptFrame(bytes(64));
    await expect(receiver.decryptFrame(env)).rejects.toThrow(/AEAD tag/);
  });

  it('rejects a frame from a different epoch (different base key)', async () => {
    const mk = randomMasterKeyB64();
    const sender = new SframeSender({baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0, participantTag: 'p', kind: 'audio'});
    const receiver = await makeReceiver({participantTag: 'p', kind: 'audio', masterKeyB64: mk, epoch: 1});
    const env = await sender.encryptFrame(bytes(64));
    await expect(receiver.decryptFrame(env)).rejects.toThrow(/AEAD tag/);
  });

  it('rejects a frame whose kind was flipped in transit (AAD bind)', async () => {
    const mk = randomMasterKeyB64();
    const sender = new SframeSender({baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0, participantTag: 'p', kind: 'audio'});
    const receiver = await makeReceiver({participantTag: 'p', kind: 'audio', masterKeyB64: mk, epoch: 0});
    const env = await sender.encryptFrame(bytes(64));
    // Flip kind byte audio→video.
    env[1] = SFRAME_KIND_VIDEO;
    await expect(receiver.decryptFrame(env)).rejects.toThrow(/receiver kind=audio but frame kind=video/);
  });

  it('rejects ciphertext mutated by one bit', async () => {
    const mk = randomMasterKeyB64();
    const sender = new SframeSender({baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0, participantTag: 'p', kind: 'video'});
    const receiver = await makeReceiver({participantTag: 'p', kind: 'video', masterKeyB64: mk, epoch: 0});
    const env = await sender.encryptFrame(bytes(200));
    env[env.byteLength - 1] ^= 0x01;
    await expect(receiver.decryptFrame(env)).rejects.toThrow(/AEAD tag/);
  });

  it('rotates cleanly under an admin rekey', async () => {
    const mkOld = randomMasterKeyB64();
    const mkNew = randomMasterKeyB64();
    const sender = new SframeSender({baseKey: await deriveSframeBaseKey(mkOld, 0), epoch: 0, participantTag: 'p', kind: 'audio'});
    const receiver = await makeReceiver({participantTag: 'p', kind: 'audio', masterKeyB64: mkOld, epoch: 0});
    // First frame under old epoch.
    const env1 = await sender.encryptFrame(bytes(40, 0x11));
    const out1 = await receiver.decryptFrame(env1);
    expect(out1[0]).toBe(0x11);
    // Rekey both sides.
    const newBaseKey = await deriveSframeBaseKey(mkNew, 1);
    sender.rotate(newBaseKey, 1);
    receiver.rotate(newBaseKey, 1);
    const env2 = await sender.encryptFrame(bytes(40, 0x22));
    const out2 = await receiver.decryptFrame(env2);
    expect(out2[0]).toBe(0x22);
  });
});

describe('sframe RFC 9605 variable-length counter (BS-CTR widening)', () => {
  // Pre-fix the counter was a fixed 16-bit field and encryptFrame threw
  // 'counter exhausted' past 65535 — capping a call at ~11 min (audio
  // 100 fps) / ~36 min (video). RFC 9605 §4.2 encodes CTR as a compact
  // variable-length integer up to 64-bit, so the cap should not exist.

  it('round-trips a counter far above the old 16-bit ceiling', async () => {
    const mk = randomMasterKeyB64();
    const sender = new SframeSender({baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0, participantTag: 'p', kind: 'audio'});
    const receiver = await makeReceiver({participantTag: 'p', kind: 'audio', masterKeyB64: mk, epoch: 0});
    // Jump the sender's counter past 0xffff (the old hard cap).
    (sender as unknown as {counter: number}).counter = 70_000;
    const env = await sender.encryptFrame(bytes(64, 0x5a));
    expect(parseFrameHeader(env).counter).toBe(70_000);
    const out = await receiver.decryptFrame(env);
    expect(out[0]).toBe(0x5a);
  });

  it('does NOT throw "counter exhausted" at the old 16-bit boundary', async () => {
    const mk = randomMasterKeyB64();
    const sender = new SframeSender({baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0, participantTag: 'p', kind: 'video'});
    (sender as unknown as {counter: number}).counter = 0xffff + 1;
    await expect(sender.encryptFrame(bytes(32))).resolves.toBeInstanceOf(Uint8Array);
  });

  it('encodes counter=0 with the minimum-bytes rule (no trailing counter bytes)', async () => {
    const sender = await makeSender({participantTag: 'p', kind: 'audio'});
    const env = await sender.encryptFrame(bytes(16));
    // version + kind + config(=0 ctr bytes) = 3-byte header for counter 0.
    expect(parseFrameHeader(env).counter).toBe(0);
    expect(parseFrameHeader(env).headerLen).toBe(3);
  });

  it('grows the header by exactly the minimum bytes as the counter grows', async () => {
    const sender = await makeSender({participantTag: 'p', kind: 'audio'});
    (sender as unknown as {counter: number}).counter = 0x01;       // 1 byte
    expect(parseFrameHeader(await sender.encryptFrame(bytes(8))).headerLen).toBe(4);
    (sender as unknown as {counter: number}).counter = 0x0100;     // 2 bytes
    expect(parseFrameHeader(await sender.encryptFrame(bytes(8))).headerLen).toBe(5);
    (sender as unknown as {counter: number}).counter = 0x010000;   // 3 bytes
    expect(parseFrameHeader(await sender.encryptFrame(bytes(8))).headerLen).toBe(6);
  });

  it('binds the variable-length header as AAD — flipping a counter byte fails the tag', async () => {
    const mk = randomMasterKeyB64();
    const sender = new SframeSender({baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0, participantTag: 'p', kind: 'audio'});
    const receiver = await makeReceiver({participantTag: 'p', kind: 'audio', masterKeyB64: mk, epoch: 0});
    (sender as unknown as {counter: number}).counter = 0x1234;
    const env = await sender.encryptFrame(bytes(40));
    // Mutate the last counter byte (header), not the ciphertext.
    env[parseFrameHeader(env).headerLen - 1] ^= 0x01;
    await expect(receiver.decryptFrame(env)).rejects.toThrow(/replay|AEAD tag/);
  });

  it('long run across the old boundary stays decryptable in order', async () => {
    const mk = randomMasterKeyB64();
    const sender = new SframeSender({baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0, participantTag: 'p', kind: 'video'});
    const receiver = await makeReceiver({participantTag: 'p', kind: 'video', masterKeyB64: mk, epoch: 0});
    (sender as unknown as {counter: number}).counter = 0xfffe;
    for (let i = 0; i < 5; i++) {
      const env = await sender.encryptFrame(bytes(24, (0x90 + i) & 0xff));
      const out = await receiver.decryptFrame(env);
      expect(out[0]).toBe((0x90 + i) & 0xff);
    }
  });
});

describe('ReplayWindow', () => {
  it('accepts the first counter and advances to it', () => {
    const w = new ReplayWindow(64);
    expect(w.observe(0)).toBe(true);
    expect(w.observe(0)).toBe(false); // immediate replay
  });

  it('accepts strictly increasing counters', () => {
    const w = new ReplayWindow(64);
    for (let i = 0; i < 32; i++) {expect(w.observe(i)).toBe(true);}
  });

  it('accepts in-window out-of-order arrivals exactly once', () => {
    const w = new ReplayWindow(64);
    expect(w.observe(10)).toBe(true);
    expect(w.observe(5)).toBe(true);
    expect(w.observe(5)).toBe(false);
    expect(w.observe(7)).toBe(true);
    expect(w.observe(10)).toBe(false);
  });

  it('rejects counters that fall outside the window', () => {
    const w = new ReplayWindow(64);
    expect(w.observe(100)).toBe(true);
    // 100 - 64 + 1 = 37 is the oldest accepted offset; anything <= 36 is out.
    expect(w.observe(36)).toBe(false);
    expect(w.observe(37)).toBe(true);
  });

  it('shifts correctly across large counter jumps', () => {
    const w = new ReplayWindow(64);
    expect(w.observe(0)).toBe(true);
    expect(w.observe(10_000)).toBe(true);
    // The old bit at 0 must now be far below the window.
    expect(w.observe(0)).toBe(false);
    // Fresh counters near the new high should still work.
    expect(w.observe(9_999)).toBe(true);
    expect(w.observe(9_999)).toBe(false);
  });

  it('handles partial-byte shifts (bit-shift path)', () => {
    const w = new ReplayWindow(64);
    expect(w.observe(0)).toBe(true);
    expect(w.observe(3)).toBe(true); // shifts by 3 bits
    expect(w.observe(0)).toBe(false);
    expect(w.observe(3)).toBe(false);
    expect(w.observe(1)).toBe(true);
    expect(w.observe(2)).toBe(true);
  });
});

describe('SframeReceiver replay rejection', () => {
  it('refuses an exact duplicate frame', async () => {
    const mk = randomMasterKeyB64();
    const sender = new SframeSender({baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0, participantTag: 'p', kind: 'audio'});
    const receiver = await makeReceiver({participantTag: 'p', kind: 'audio', masterKeyB64: mk, epoch: 0});
    const env = await sender.encryptFrame(bytes(20));
    await receiver.decryptFrame(env);
    await expect(receiver.decryptFrame(env)).rejects.toThrow(/replay/);
  });
});

describe('SframeReceiver verify-before-advance (2026-07-09 audit §8)', () => {
  // Pre-fix the receiver advanced the replay window on the UNVERIFIED
  // header (observe() before the AEAD check), so a single forged
  // high-counter frame — which fails the tag and is dropped — slid the
  // window past every genuine in-flight counter and wedged the stream.

  it('a forged high-counter frame fails AEAD and does NOT wedge the stream', async () => {
    const mk = randomMasterKeyB64();
    const sender = new SframeSender({baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0, participantTag: 'p', kind: 'audio'});
    const receiver = await makeReceiver({participantTag: 'p', kind: 'audio', masterKeyB64: mk, epoch: 0});
    await receiver.decryptFrame(await sender.encryptFrame(bytes(20, 0x01)));

    // Attacker without the group key forges a frame claiming counter
    // 50_000 (same tag/kind, wrong master key → tag check must fail).
    const attacker = new SframeSender({
      baseKey: await deriveSframeBaseKey(randomMasterKeyB64(), 0),
      epoch: 0, participantTag: 'p', kind: 'audio',
    });
    (attacker as unknown as {counter: number}).counter = 50_000;
    const forged = await attacker.encryptFrame(bytes(20, 0xee));
    await expect(receiver.decryptFrame(forged)).rejects.toThrow(/AEAD tag/);

    // The stream keeps flowing: genuine counters 1..3 still decrypt
    // (pre-fix they were all rejected as out-of-window).
    let lastGenuine: Uint8Array | null = null;
    for (let i = 1; i <= 3; i++) {
      lastGenuine = await sender.encryptFrame(bytes(20, i));
      const out = await receiver.decryptFrame(lastGenuine);
      expect(out[0]).toBe(i);
    }
    // And genuine frames still COMMIT the window — replaying one rejects.
    await expect(receiver.decryptFrame(lastGenuine as Uint8Array)).rejects.toThrow(/replay/);
  });

  it('a rejected forgery does not burn the genuine counter it claimed', async () => {
    const mk = randomMasterKeyB64();
    const sender = new SframeSender({baseKey: await deriveSframeBaseKey(mk, 0), epoch: 0, participantTag: 'p', kind: 'video'});
    const receiver = await makeReceiver({participantTag: 'p', kind: 'video', masterKeyB64: mk, epoch: 0});
    await receiver.decryptFrame(await sender.encryptFrame(bytes(24, 0x10))); // counter 0

    const attacker = new SframeSender({
      baseKey: await deriveSframeBaseKey(randomMasterKeyB64(), 0),
      epoch: 0, participantTag: 'p', kind: 'video',
    });
    (attacker as unknown as {counter: number}).counter = 1;
    await expect(receiver.decryptFrame(await attacker.encryptFrame(bytes(24, 0xee))))
      .rejects.toThrow(/AEAD tag/);

    // The GENUINE frame with counter 1 must still be accepted — the
    // forgery must not have marked that counter as seen.
    const out = await receiver.decryptFrame(await sender.encryptFrame(bytes(24, 0x11))); // counter 1
    expect(out[0]).toBe(0x11);
  });
});

describe('ReplayWindow.isFresh (non-mutating check)', () => {
  it('does not record the counter — only observe() commits', () => {
    const w = new ReplayWindow(64);
    expect(w.isFresh(10)).toBe(true);
    expect(w.isFresh(10)).toBe(true); // still fresh — nothing recorded
    expect(w.observe(10)).toBe(true);
    expect(w.isFresh(10)).toBe(false); // now a replay
    expect(w.isFresh(11)).toBe(true);
    expect(w.isFresh(5)).toBe(true);   // in-window, unseen
    expect(w.isFresh(-1)).toBe(false);
  });

  it('agrees with observe() on out-of-window counters', () => {
    const w = new ReplayWindow(64);
    expect(w.observe(100)).toBe(true);
    expect(w.isFresh(36)).toBe(false); // below the window
    expect(w.isFresh(37)).toBe(true);  // oldest accepted offset
  });
});
