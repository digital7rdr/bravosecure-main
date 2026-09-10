/**
 * Phase-2 ratchet-snapshot — END-TO-END recovery proof with REAL libsignal.
 *
 * This is the test that proves the "old inbound messages from the
 * reinstall window" gap is actually closed — not just that the
 * primitives round-trip bytes, but that a libsignal ciphertext encrypted
 * under a peer's pre-reinstall ratchet DECRYPTS after the snapshot is
 * applied to a fresh store, when it would otherwise fail.
 *
 * Scenario:
 *   1. Alice ↔ Bob establish a Double Ratchet session and exchange a
 *      few messages (Bob's session now holds advanced chain state).
 *   2. Bob captures + uploads an encrypted snapshot of his session.
 *   3. Alice sends ONE MORE message M (encrypted under the current
 *      ratchet) — this is the "in the reinstall window" message.
 *   4. Bob "reinstalls": a brand-new store, identity restored, but NO
 *      session ratchets. Decrypting M fails (the gap).
 *   5. applyRatchetSnapshot replays Bob's captured session into the new
 *      store. Decrypting M now SUCCEEDS.
 */

import {SessionManager} from '@bravo/messenger-core';
import {InMemoryProtocolStore} from '@bravo/messenger-core';
import {installIdentity} from '@bravo/messenger-core';
import {makeParty} from './fixtures';
import {
  serializeSessionSnapshot,
  encryptSessionSnapshot,
  setSnapshotTransport,
  makeInMemorySnapshotTransport,
} from '../backup/ratchetSnapshot';
import {applyRatchetSnapshot} from '../backup/sessionRatchetRecovery';
import {generateMasterKey} from '../backup/backupCrypto';

describe('ratchet snapshot — real-libsignal reinstall recovery', () => {
  afterEach(() => setSnapshotTransport(null));

  it('recovers an in-window message that a fresh install could not decrypt', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const a = new SessionManager(alice.store);
    const b = new SessionManager(bob.store);

    // 1. Establish + exchange so Bob's ratchet advances.
    await a.initOutgoingSession(bob.bundle);
    const c1 = await a.encrypt(bob.address, 'hello-1');
    expect(await b.decrypt(alice.address, c1)).toBe('hello-1');
    const c2 = await b.encrypt(alice.address, 'reply-2');
    expect(await a.decrypt(bob.address, c2)).toBe('reply-2');

    // 2. Bob captures + uploads his ratchet snapshot.
    const {raw} = await generateMasterKey();
    const transport = makeInMemorySnapshotTransport();
    setSnapshotTransport(transport);
    const snap = await serializeSessionSnapshot(bob.store, 1);
    expect(snap).not.toBeNull();
    expect(snap!.sessions.length).toBeGreaterThan(0);
    const env = await encryptSessionSnapshot(raw, snap!);
    await transport.upload(env);

    // 3. The "reinstall-window" message — sent AFTER the snapshot, under
    //    the current ratchet. (Bob's live store could decrypt it, but the
    //    fresh install below cannot.)
    const cWindow = await a.encrypt(bob.address, 'in-window-secret');

    // 4. Bob reinstalls: fresh store. The production restore flow
    //    re-installs Bob's ORIGINAL identity from the backup bundle
    //    (restoreBackup) BEFORE the snapshot apply runs — the Double
    //    Ratchet MAC binds to the identity keys, so we mirror that here
    //    by restoring Bob's identity into the fresh store. What's still
    //    missing is the per-peer SESSION ratchet (wiped on uninstall),
    //    which is exactly what the snapshot recovers.
    const freshStore = new InMemoryProtocolStore();
    await installIdentity(freshStore, {preKeyCount: 1});
    const bobIdentity = await bob.store.getIdentityKeyPair();
    const bobRegId    = await bob.store.getLocalRegistrationId();
    freshStore.setOwnIdentity(bobRegId, bobIdentity.pubKey, bobIdentity.privKey);
    const bFresh = new SessionManager(freshStore);
    await expect(bFresh.decrypt(alice.address, cWindow)).rejects.toThrow();

    // 5. Apply the snapshot → the same ciphertext now decrypts.
    const res = await applyRatchetSnapshot(freshStore, raw, 0);
    expect(res.reason).toBe('ok');
    expect(res.applied).toBeGreaterThan(0);
    expect(res.seq).toBe(1);

    const bRecovered = new SessionManager(freshStore);
    expect(await bRecovered.decrypt(alice.address, cWindow)).toBe('in-window-secret');
  });

  it('refuses to roll back to an older snapshot seq (replay defence)', async () => {
    const {raw} = await generateMasterKey();
    const transport = makeInMemorySnapshotTransport();
    setSnapshotTransport(transport);
    const bob = await makeParty({userId: 'bob', deviceId: 1});
    // seq=3 lives on the server; the device floor is already 3.
    const snap = await serializeSessionSnapshot(bob.store, 3);
    await transport.upload(await encryptSessionSnapshot(raw, snap!));
    const res = await applyRatchetSnapshot(bob.store, raw, 3);
    expect(res.reason).toBe('older_seq');
    expect(res.applied).toBe(0);
  });

  // P2-B-3 — the rollback floor used to check ONLY the unauthenticated
  // plaintext header `seq`. A malicious server could inflate the header
  // past the floor while serving an OLDER blob (the inner seq is
  // AES-GCM-authenticated; the header is not), installing stale ratchet
  // records on a fresh install. The AUTHENTICATED inner seq now governs.
  describe('P2-B-3 — authenticated inner seq governs the floor', () => {
    it('rejects a header seq inflated past the floor over an older authenticated blob', async () => {
      const {raw} = await generateMasterKey();
      const transport = makeInMemorySnapshotTransport();
      setSnapshotTransport(transport);
      const bob = await makeParty({userId: 'bob', deviceId: 1});
      // Authenticated inner seq = 2 (older than the floor 3), but the
      // server rewrites the plaintext header to 99 to slip past the
      // pre-decrypt check.
      const snap = await serializeSessionSnapshot(bob.store, 2);
      const env = await encryptSessionSnapshot(raw, snap!);
      const forged = {...env, seq: 99};
      await transport.upload(forged);
      const res = await applyRatchetSnapshot(bob.store, raw, 3);
      expect(res.applied).toBe(0);
      // Header (99) != authenticated inner (2) → rejected before the
      // floor even matters.
      expect(res.reason).toBe('seq_mismatch');
    });

    it('rejects header/inner divergence even when both clear the floor', async () => {
      const {raw} = await generateMasterKey();
      const transport = makeInMemorySnapshotTransport();
      setSnapshotTransport(transport);
      const bob = await makeParty({userId: 'bob', deviceId: 1});
      const snap = await serializeSessionSnapshot(bob.store, 5);
      const env = await encryptSessionSnapshot(raw, snap!);
      await transport.upload({...env, seq: 7});
      const res = await applyRatchetSnapshot(bob.store, raw, 3);
      expect(res.applied).toBe(0);
      expect(res.reason).toBe('seq_mismatch');
    });

    it('consistent header+inner seq above the floor still applies (regression guard)', async () => {
      const {raw} = await generateMasterKey();
      const transport = makeInMemorySnapshotTransport();
      setSnapshotTransport(transport);
      const bob = await makeParty({userId: 'bob', deviceId: 1});
      const snap = await serializeSessionSnapshot(bob.store, 4);
      await transport.upload(await encryptSessionSnapshot(raw, snap!));
      // Fresh store so the L21 skip-if-existing guard doesn't zero `applied`.
      const fresh = new InMemoryProtocolStore();
      const res = await applyRatchetSnapshot(fresh, raw, 3);
      expect(res.reason).toBe('ok');
      expect(res.seq).toBe(4);
    });
  });
});
