import {
  SessionManager,
  wrapOuter, unwrapOuter,
  sealPayload, unsealPayload,
  toBase64, fromBase64,
  CryptoError,
  CiphertextType,
} from '@bravo/messenger-core';
import {makeParty} from './fixtures';

/**
 * Sealed Sender v2 — outer ECIES wrap.
 *
 * Replaces the Phase-1 `senderAddressHint` decrypt-routing field with
 * an X25519+AES-GCM ECIES envelope around the existing libsignal
 * SessionCipher output. The relay now sees nothing identifying the
 * sender — the recipient address is the only routable field.
 */

describe('Sealed Sender v2 — outer ECIES wrap', () => {
  it('round-trips a Signal ciphertext through the outer wrap', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);
    const bobMgr   = new SessionManager(bob.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const innerCt = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'meet at DIFC'));

    // Sender-side wrap — payload now opaque to the relay.
    const wire = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              innerCt,
    });
    expect(typeof wire).toBe('string');
    expect(wire.length).toBeGreaterThan(0);

    // Recipient-side unwrap recovers the sender + Signal ciphertext.
    const bobIdentity = await bob.store.getIdentityKeyPair();
    const recovered = await unwrapOuter({
      ownIdentityPrivKey: bobIdentity.privKey,
      ownIdentityPubKey:  bobIdentity.pubKey,
      outerSealedB64:     wire,
    });
    expect(recovered.sender.userId).toBe('alice');
    expect(recovered.sender.deviceId).toBe(1);
    expect(recovered.ciphertext.type).toBe(innerCt.type);
    expect(recovered.ciphertext.body).toBe(innerCt.body);

    // The recovered ciphertext drives the existing decrypt path.
    const sealedJson = await bobMgr.decrypt(recovered.sender, recovered.ciphertext);
    const {body} = unsealPayload(sealedJson);
    expect(body).toBe('meet at DIFC');
  });

  it('produces distinct wires for the same plaintext (ephemeral key is fresh)', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    // Two distinct Signal ciphertexts (Double Ratchet ensures these
    // already differ); the outer wrap should differ for the same
    // input too because each call mints a fresh ephemeral.
    const ct = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'msg'));

    const w1 = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              ct,
    });
    const w2 = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              ct,
    });
    expect(w1).not.toBe(w2);
  });

  it('rejects a wire signed for a different recipient', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const carla = await makeParty({userId: 'carla', deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const ct = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'for-bob'));
    const wire = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              ct,
    });

    const carlaIdentity = await carla.store.getIdentityKeyPair();
    await expect(
      unwrapOuter({
        ownIdentityPrivKey: carlaIdentity.privKey,
        ownIdentityPubKey:  carlaIdentity.pubKey,
        outerSealedB64:     wire,
      }),
    ).rejects.toThrow(CryptoError);
  });

  it('rejects a tampered ciphertext (AES-GCM tag check)', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const ct = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'msg'));
    const wire = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              ct,
    });

    const bytes = new Uint8Array(fromBase64(wire));
    bytes[bytes.byteLength - 1] ^= 0x01; // flip a bit in the GCM tag
    const tampered = toBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

    const bobIdentity = await bob.store.getIdentityKeyPair();
    await expect(
      unwrapOuter({
        ownIdentityPrivKey: bobIdentity.privKey,
        ownIdentityPubKey:  bobIdentity.pubKey,
        outerSealedB64:     tampered,
      }),
    ).rejects.toThrow(/authentication failed/);
  });

  it('rejects a wire with a swapped ephemeral pubkey (AAD binding catches it)', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const ct = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'msg'));
    const wire = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              ct,
    });
    const bytes = new Uint8Array(fromBase64(wire));
    bytes[5] ^= 0xff; // mutate a byte inside the ephemeral pubkey
    const tampered = toBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

    const bobIdentity = await bob.store.getIdentityKeyPair();
    await expect(
      unwrapOuter({
        ownIdentityPrivKey: bobIdentity.privKey,
        ownIdentityPubKey:  bobIdentity.pubKey,
        outerSealedB64:     tampered,
      }),
    ).rejects.toThrow(CryptoError);
  });

  it('rejects an unknown version byte', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const ct = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'msg'));
    const wire = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              ct,
    });
    const bytes = new Uint8Array(fromBase64(wire));
    bytes[0] = 0x99;
    const bumped = toBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

    const bobIdentity = await bob.store.getIdentityKeyPair();
    await expect(
      unwrapOuter({
        ownIdentityPrivKey: bobIdentity.privKey,
        ownIdentityPubKey:  bobIdentity.pubKey,
        outerSealedB64:     bumped,
      }),
    ).rejects.toThrow(/version/);
  });

  it('preserves PreKeyWhisper type through the wrap', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    // The very first message after initOutgoingSession is type=3
    // (PreKeyWhisper) — make sure the wire encoding round-trips it.
    const ct = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'first'));
    expect(ct.type).toBe(CiphertextType.PreKeyWhisper);
    const wire = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              ct,
    });
    const bobIdentity = await bob.store.getIdentityKeyPair();
    const recovered = await unwrapOuter({
      ownIdentityPrivKey: bobIdentity.privKey,
      ownIdentityPubKey:  bobIdentity.pubKey,
      outerSealedB64:     wire,
    });
    expect(recovered.ciphertext.type).toBe(CiphertextType.PreKeyWhisper);
  });

  it('rejects an under-length wire', async () => {
    const bob = await makeParty({userId: 'bob', deviceId: 1});
    const bobIdentity = await bob.store.getIdentityKeyPair();
    const tinyWire = toBase64(new Uint8Array([0x02, 0x00]).buffer);
    await expect(
      unwrapOuter({
        ownIdentityPrivKey: bobIdentity.privKey,
        ownIdentityPubKey:  bobIdentity.pubKey,
        outerSealedB64:     tinyWire,
      }),
    ).rejects.toThrow(/too short/);
  });
});
