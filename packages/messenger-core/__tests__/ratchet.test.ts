import { SessionManager, CiphertextType } from '@bravo/messenger-core';
import { makeParty } from './fixtures';

describe('Double Ratchet — 10 message chain', () => {
  it('preserves ordering and integrity across alternating sends', async () => {
    const alice = await makeParty({ userId: 'alice', deviceId: 1 });
    const bob = await makeParty({ userId: 'bob', deviceId: 1 });
    const a = new SessionManager(alice.store);
    const b = new SessionManager(bob.store);

    await a.initOutgoingSession(bob.bundle);

    // Message 1 — Alice → Bob. This is the PreKey message that bootstraps
    // Bob's inbound session.
    const ct1 = await a.encrypt(bob.address, 'msg-1-a2b');
    expect(ct1.type).toBe(CiphertextType.PreKeyWhisper);
    expect(await b.decrypt(alice.address, ct1)).toBe('msg-1-a2b');

    // Messages 2–10 alternate. After the PreKey message all subsequent
    // frames must be type=Whisper — verify that invariant.
    const script: Array<{ from: 'a' | 'b'; text: string }> = [
      { from: 'b', text: 'msg-2-b2a' },
      { from: 'a', text: 'msg-3-a2b' },
      { from: 'b', text: 'msg-4-b2a' },
      { from: 'a', text: 'msg-5-a2b' },
      { from: 'b', text: 'msg-6-b2a' },
      { from: 'a', text: 'msg-7-a2b' },
      { from: 'b', text: 'msg-8-b2a' },
      { from: 'a', text: 'msg-9-a2b' },
      { from: 'b', text: 'msg-10-b2a' },
    ];

    for (const step of script) {
      if (step.from === 'a') {
        const ct = await a.encrypt(bob.address, step.text);
        expect(ct.type).toBe(CiphertextType.Whisper);
        const pt = await b.decrypt(alice.address, ct);
        expect(pt).toBe(step.text);
      } else {
        const ct = await b.encrypt(alice.address, step.text);
        expect(ct.type).toBe(CiphertextType.Whisper);
        const pt = await a.decrypt(bob.address, ct);
        expect(pt).toBe(step.text);
      }
    }
  });

  it('still decrypts when three messages from Alice arrive out of order at Bob', async () => {
    const alice = await makeParty({ userId: 'alice', deviceId: 1 });
    const bob = await makeParty({ userId: 'bob', deviceId: 1 });
    const a = new SessionManager(alice.store);
    const b = new SessionManager(bob.store);

    await a.initOutgoingSession(bob.bundle);

    const ct1 = await a.encrypt(bob.address, 'first');
    const ct2 = await a.encrypt(bob.address, 'second');
    const ct3 = await a.encrypt(bob.address, 'third');

    // Delivery order: 1, 3, 2 — the Double Ratchet must cache skipped
    // message keys and still recover 'second'.
    expect(await b.decrypt(alice.address, ct1)).toBe('first');
    expect(await b.decrypt(alice.address, ct3)).toBe('third');
    expect(await b.decrypt(alice.address, ct2)).toBe('second');
  });
});
