import {
  GroupCallEncryption,
  type GroupKeySource,
} from '../src/calls/groupCallEncryption';
import {toBase64} from '../src/crypto/encoding';

function randomMasterKeyB64(): string {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return toBase64(k.buffer.slice(k.byteOffset, k.byteOffset + k.byteLength));
}

interface FakeSource extends GroupKeySource {
  set:   (conversationId: string, masterKeyB64: string, epoch: number) => void;
  clear: (conversationId: string) => void;
}

function makeFakeSource(): FakeSource {
  const data = new Map<string, {masterKeyB64: string; epoch: number}>();
  const subs = new Map<string, Set<(next: {masterKeyB64: string; epoch: number}) => void>>();
  return {
    current(conversationId) { return data.get(conversationId) ?? null; },
    subscribe(conversationId, listener) {
      let set = subs.get(conversationId);
      if (!set) { set = new Set(); subs.set(conversationId, set); }
      set.add(listener);
      return () => { set?.delete(listener); };
    },
    set(conversationId, masterKeyB64, epoch) {
      data.set(conversationId, {masterKeyB64, epoch});
      subs.get(conversationId)?.forEach(cb => cb({masterKeyB64, epoch}));
    },
    clear(conversationId) { data.delete(conversationId); },
  };
}

describe('GroupCallEncryption', () => {
  it('refuses to init when no group key — never silently downgrades', async () => {
    const src = makeFakeSource();
    const enc = new GroupCallEncryption({conversationId: 'missing', selfTag: 'self', keySource: src});
    await expect(enc.init()).rejects.toThrow(/refuse to start unencrypted/);
  });

  it('initializes from the source and round-trips an encrypted frame', async () => {
    const src = makeFakeSource();
    src.set('conv-1', randomMasterKeyB64(), 0);

    const alice = new GroupCallEncryption({conversationId: 'conv-1', selfTag: 'alice-tag', keySource: src});
    const bob   = new GroupCallEncryption({conversationId: 'conv-1', selfTag: 'bob-tag',   keySource: src});
    await alice.init();
    await bob.init();

    const sender = alice.getOrCreateSender('audio');
    const recv   = bob.getOrCreateReceiver('alice-tag', 'audio');

    const pt = new Uint8Array(80);
    pt.fill(0x33);
    const env = await sender.encryptFrame(pt);
    const out = await recv.decryptFrame(env);
    expect(Buffer.from(out).equals(Buffer.from(pt))).toBe(true);

    alice.dispose();
    bob.dispose();
  });

  it('auto-rotates senders + receivers when the admin layer bumps the epoch', async () => {
    const src   = makeFakeSource();
    const mkOld = randomMasterKeyB64();
    const mkNew = randomMasterKeyB64();
    src.set('conv-1', mkOld, 0);

    const alice = new GroupCallEncryption({conversationId: 'conv-1', selfTag: 'alice-tag', keySource: src});
    const bob   = new GroupCallEncryption({conversationId: 'conv-1', selfTag: 'bob-tag',   keySource: src});
    await alice.init();
    await bob.init();

    const s = alice.getOrCreateSender('audio');
    const r = bob.getOrCreateReceiver('alice-tag', 'audio');
    const e1 = await s.encryptFrame(new Uint8Array([1, 2, 3]));
    expect(Array.from(await r.decryptFrame(e1))).toEqual([1, 2, 3]);

    src.set('conv-1', mkNew, 1);
    await alice.whenIdle();
    await bob.whenIdle();

    const e2 = await s.encryptFrame(new Uint8Array([4, 5, 6]));
    expect(Array.from(await r.decryptFrame(e2))).toEqual([4, 5, 6]);

    alice.dispose();
    bob.dispose();
  });

  it('drops a receiver cleanly on participant leave', async () => {
    const src = makeFakeSource();
    src.set('conv-1', randomMasterKeyB64(), 0);
    const enc = new GroupCallEncryption({conversationId: 'conv-1', selfTag: 'self', keySource: src});
    await enc.init();

    const r1 = enc.getOrCreateReceiver('peer-1', 'audio');
    const r2 = enc.getOrCreateReceiver('peer-1', 'audio');
    expect(r1).toBe(r2);

    enc.dropReceiver('peer-1', 'audio');
    const r3 = enc.getOrCreateReceiver('peer-1', 'audio');
    expect(r3).not.toBe(r1);

    enc.dispose();
  });

  it('dispose() unsubscribes — subsequent rotations are inert', async () => {
    const src = makeFakeSource();
    src.set('conv-1', randomMasterKeyB64(), 0);
    const enc = new GroupCallEncryption({conversationId: 'conv-1', selfTag: 'self', keySource: src});
    await enc.init();
    enc.dispose();

    expect(enc.isReady()).toBe(false);
    src.set('conv-1', randomMasterKeyB64(), 7);
    expect(enc.isReady()).toBe(false);
  });

  it('isReady() flips to true only after init() resolves', async () => {
    const src = makeFakeSource();
    src.set('conv-1', randomMasterKeyB64(), 0);
    const enc = new GroupCallEncryption({conversationId: 'conv-1', selfTag: 'self', keySource: src});
    expect(enc.isReady()).toBe(false);
    await enc.init();
    expect(enc.isReady()).toBe(true);
    enc.dispose();
  });
});
