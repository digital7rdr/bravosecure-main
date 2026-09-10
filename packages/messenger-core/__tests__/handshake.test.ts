import { SessionManager, CiphertextType } from '@bravo/messenger-core';
import { makeParty } from './fixtures';

describe('X3DH handshake', () => {
  it('establishes a session from a fresh pre-key bundle', async () => {
    const alice = await makeParty({ userId: 'alice', deviceId: 1 });
    const bob = await makeParty({ userId: 'bob', deviceId: 1 });

    const aliceMgr = new SessionManager(alice.store);
    const bobMgr = new SessionManager(bob.store);

    await aliceMgr.initOutgoingSession(bob.bundle);

    expect(await aliceMgr.hasSession(bob.address)).toBe(true);
    expect(await bobMgr.hasSession(alice.address)).toBe(false);

    const ct = await aliceMgr.encrypt(bob.address, 'hello bob');
    expect(ct.type).toBe(CiphertextType.PreKeyWhisper);

    const pt = await bobMgr.decrypt(alice.address, ct);
    expect(pt).toBe('hello bob');

    // Bob now has an inbound session with Alice.
    expect(await bobMgr.hasSession(alice.address)).toBe(true);
  });

  it('rejects a tampered first message without establishing state', async () => {
    const alice = await makeParty({ userId: 'alice', deviceId: 1 });
    const bob = await makeParty({ userId: 'bob', deviceId: 1 });
    const aliceMgr = new SessionManager(alice.store);
    const bobMgr = new SessionManager(bob.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const ct = await aliceMgr.encrypt(bob.address, 'hello bob');
    const tampered = {
      type: ct.type,
      body: flipFirstByte(ct.body),
    };

    await expect(bobMgr.decrypt(alice.address, tampered)).rejects.toThrow();
  });
});

function flipFirstByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[0] = buf[0] ^ 0xff;
  return buf.toString('base64');
}
