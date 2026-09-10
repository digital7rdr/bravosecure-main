import {SignJWT} from 'jose';
import {generateKeyPairSync} from 'node:crypto';
// Audit P0-G1 — `broadcastToGroup` / `parseGroupMessage` now live in the
// package (mobile mirror is a thin re-export). `SessionManager` must come
// from the same module instance, otherwise the test's mobile-side mgr is
// nominally a different type than the broadcast param expects (same
// shape, distinct TypeScript identity).
import {SessionManager, unsealPayload} from '@bravo/messenger-core';
import {
  broadcastToGroup, parseGroupMessage, applyAdminAction, makeNewGroup,
  planRemoveAndRekey, genFreshGroupMasterKey,
  signGroupCreate, verifyGroupCreateSignature, canonicalCreateBytes,
} from '../groups';
import type {Ciphertext, SessionAddress} from '@bravo/messenger-core';
import {makeParty} from './fixtures';

/**
 * 3-party group broadcast roundtrip.
 *
 * Proves:
 *   1. A single broadcast produces N-1 ciphertexts (sender excluded).
 *   2. Each recipient decrypts + unseal + parseGroupMessage gives back
 *      the identical envelope, including clientMsgId for dedup.
 *   3. Group metadata spoof is detected — tamper the inner envelope's
 *      groupId vs the sealed group hint, parse returns null.
 *   4. Admin actions (add/remove) advance epoch and update membership
 *      only when `atEpoch` matches the current state's epoch.
 *   5. Server sees nothing linkable as "group" — the sealed envelopes
 *      are N independent pairwise ciphertexts, not a broadcast frame.
 *      (Verified via the shape of what's delivered.)
 */

async function mintCert(sub: string, identityKeyB64: string): Promise<string> {
  const {privateKey} = generateKeyPairSync('ed25519');
  const pem = privateKey.export({type: 'pkcs8', format: 'pem'}) as string;
  const {importPKCS8} = await import('jose');
  const signingKey = await importPKCS8(pem, 'EdDSA');
  return new SignJWT({
    senderUserId:         sub,
    senderSignalDeviceId: 1,
    senderIdentityKey:    identityKeyB64,
  })
    .setProtectedHeader({alg: 'EdDSA'})
    .setSubject(sub)
    .setIssuer('auth-service')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
}

describe('Group broadcast — pairwise fan-out over Signal sessions', () => {
  async function setupGroup() {
    // 3 parties — Alice (owner), Bob, Carol
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const carol = await makeParty({userId: 'carol', deviceId: 1});

    const aliceMgr = new SessionManager(alice.store);
    const bobMgr   = new SessionManager(bob.store);
    const carolMgr = new SessionManager(carol.store);

    // Initialise outgoing sessions Alice → {Bob, Carol}
    await aliceMgr.initOutgoingSession(bob.bundle);
    await aliceMgr.initOutgoingSession(carol.bundle);

    const group = makeNewGroup({
      name: 'DIFC Ops',
      owner: 'alice',
      ownerDeviceId: 1,
      members: [
        {userId: 'bob',   deviceId: 1},
        {userId: 'carol', deviceId: 1},
      ],
    });

    return {alice, bob, carol, aliceMgr, bobMgr, carolMgr, group};
  }

  it('produces one ciphertext per non-self member; all recipients decrypt identical body', async () => {
    const {alice, aliceMgr, bobMgr, carolMgr, group} = await setupGroup();

    const delivered: Array<{peer: SessionAddress; ct: Ciphertext; clientMsgId: string}> = [];
    const {aliceIdentityKeyB64} = await (async () => ({
      aliceIdentityKeyB64: (await alice.store.getIdentityKeyPair()).pubKey,
    }))().then(async o => ({aliceIdentityKeyB64: toB64(o.aliceIdentityKeyB64)}));
    const cert = await mintCert('alice', aliceIdentityKeyB64);

    const res = await broadcastToGroup({
      group,
      self:    {userId: 'alice', deviceId: 1},
      cert,
      body:    'ops brief at 14:00',
      session: aliceMgr,
      deliver: async (peer, ct, clientMsgId) => { delivered.push({peer, ct, clientMsgId}); },
    });
    expect(res.recipients).toBe(2);
    expect(delivered).toHaveLength(2);
    expect(new Set(delivered.map(d => d.clientMsgId)).size).toBe(1); // shared across copies

    // Bob's copy
    const bobCopy   = delivered.find(d => d.peer.userId === 'bob')!;
    const carolCopy = delivered.find(d => d.peer.userId === 'carol')!;
    const bobPlain   = await bobMgr.decrypt({userId: 'alice', deviceId: 1}, bobCopy.ct);
    const carolPlain = await carolMgr.decrypt({userId: 'alice', deviceId: 1}, carolCopy.ct);
    const bobSealed   = unsealPayload(bobPlain);
    const carolSealed = unsealPayload(carolPlain);
    expect(bobSealed.group?.groupId).toBe(group.groupId);
    expect(carolSealed.group?.groupId).toBe(group.groupId);

    // Recipients now share the group master key (delivered via the
    // admin create flow in production; passed here directly).
    const bobEnv   = await parseGroupMessage(bobSealed,   group.masterKeyB64);
    const carolEnv = await parseGroupMessage(carolSealed, group.masterKeyB64);
    expect(bobEnv.ok).toBe(true);
    expect(carolEnv.ok).toBe(true);
    if (!bobEnv.ok || !carolEnv.ok) {throw new Error('parse failed');}
    expect(bobEnv.envelope.body).toBe('ops brief at 14:00');
    expect(carolEnv.envelope.body).toBe('ops brief at 14:00');
    expect(bobEnv.envelope.clientMsgId).toBe(carolEnv.envelope.clientMsgId);
  });

  it('parseGroupMessage rejects when inner envelope and outer group hint diverge', async () => {
    const {alice, aliceMgr, bobMgr, group} = await setupGroup();
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);
    // B-126 — select Bob's copy by PEER, never by index. broadcastToGroup fans
    // out with Promise.allSettled over a concurrency window (groupClient.ts:266),
    // so `delivered` is ordered by resolution, not by member order. Taking
    // delivered[0] handed Carol's ciphertext to bobMgr whenever her send won the
    // race — a "Bad MAC" that only reproduced under parallel load.
    const delivered: Array<{peer: SessionAddress; ct: Ciphertext}> = [];
    await broadcastToGroup({
      group, self: {userId: 'alice', deviceId: 1}, cert, body: 'hi',
      session: aliceMgr,
      deliver: async (peer, ct) => { delivered.push({peer, ct}); },
    });
    const bobCopy = delivered.find(d => d.peer.userId === 'bob')!;
    expect(bobCopy).toBeDefined();
    const plain = await bobMgr.decrypt({userId: 'alice', deviceId: 1}, bobCopy.ct);
    const sealed = unsealPayload(plain);

    // Tamper: rewrite sealed.group.groupId but leave inner body's groupId.
    const tampered = {
      ...sealed,
      group: {...sealed.group!, groupId: 'some-other-group'},
    };
    const res = await parseGroupMessage(tampered, group.masterKeyB64);
    expect(res.ok).toBe(false);
    if (!res.ok) {expect(res.reason).toBe('tamper');}
  });

  it('applyAdminAction advances epoch + updates membership on add/remove', () => {
    const g = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}],
    });
    expect(g.epoch).toBe(0);

    // Audit fix #26 — applyAdminAction now requires senderUserId for
    // admin gating. We pass the owner ('a') here since they're the
    // admin in the seed group.
    const withC = applyAdminAction(g, {type: 'add', member: {userId: 'c', deviceId: 1}, atEpoch: 0}, 'a');
    expect(withC.epoch).toBe(1);
    expect(withC.members.c).toBeTruthy();

    // Stale admin (wrong atEpoch) is ignored.
    const stale = applyAdminAction(withC, {type: 'remove', userId: 'b', atEpoch: 0}, 'a');
    expect(stale.epoch).toBe(1);
    expect(stale.members.b).toBeTruthy();

    // Fresh remove at the correct epoch.
    const withoutB = applyAdminAction(withC, {type: 'remove', userId: 'b', atEpoch: 1}, 'a');
    expect(withoutB.epoch).toBe(2);
    expect(withoutB.members.b).toBeUndefined();
  });

  it('planRemoveAndRekey produces a remove at current epoch and a rekey at next epoch', () => {
    // Round 5 / Security S2 — removing a member without rotating
    // leaks subsequent group messages to them. The plan helper bundles
    // both admin actions so the runtime can fan them out in order.
    const g = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}, {userId: 'c', deviceId: 1}],
    });
    const plan = planRemoveAndRekey(g, 'b');
    expect(plan.remove).toEqual({type: 'remove', userId: 'b', atEpoch: 0});
    expect(plan.rekey.type).toBe('rekey');
    expect(plan.rekey.atEpoch).toBe(1);
    expect(plan.newMasterKeyB64).toBe(plan.rekey.newMasterKeyB64);
    // Master key is fresh (different from the original).
    expect(plan.newMasterKeyB64).not.toBe(g.masterKeyB64);
    expect(plan.newMasterKeyB64.length).toBeGreaterThan(40); // base64 of 32 bytes
  });

  it('planRemoveAndRekey, applied in order, removes target AND rotates the key', () => {
    const g = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}, {userId: 'c', deviceId: 1}],
    });
    const plan = planRemoveAndRekey(g, 'b');
    const afterRemove = applyAdminAction(g, plan.remove, 'a');
    expect(afterRemove.members.b).toBeUndefined();
    expect(afterRemove.epoch).toBe(1);
    expect(afterRemove.masterKeyB64).toBe(g.masterKeyB64); // not yet rekeyed

    const afterRekey = applyAdminAction(afterRemove, plan.rekey, 'a');
    expect(afterRekey.epoch).toBe(2);
    expect(afterRekey.masterKeyB64).toBe(plan.newMasterKeyB64);
    expect(afterRekey.masterKeyB64).not.toBe(g.masterKeyB64);
    // Membership unchanged from afterRemove.
    expect(afterRekey.members.b).toBeUndefined();
    expect(afterRekey.members.c).toBeTruthy();
  });

  it('planRemoveAndRekey throws when target is not in the group', () => {
    const g = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}],
    });
    expect(() => planRemoveAndRekey(g, 'not-a-member')).toThrow(/not in group/);
  });

  it('non-admin caller cannot apply the rekey leg either', () => {
    // Defense-in-depth: even if a non-admin somehow gets hold of the
    // rekey action wire bytes, the local applyAdminAction gate drops
    // it. Only the membership change at admin-action time is what
    // matters.
    const g = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}],
    });
    const plan = planRemoveAndRekey(g, 'b');
    // 'b' is a non-admin member — the rekey from them must be ignored.
    const tampered = applyAdminAction(g, plan.rekey, 'b');
    expect(tampered).toBe(g); // returned unchanged
    expect(tampered.masterKeyB64).toBe(g.masterKeyB64);
  });

  it('genFreshGroupMasterKey returns a base64 32-byte key each time', () => {
    const k1 = genFreshGroupMasterKey();
    const k2 = genFreshGroupMasterKey();
    expect(k1).not.toBe(k2);
    expect(Buffer.from(k1, 'base64').length).toBe(32);
  });

  it('canonicalCreateBytes is deterministic regardless of member insertion order', () => {
    // Round 5 / Security S4 — the canonical form sorts members so two
    // creators with the same intent produce the same digest. Otherwise
    // a receiver who computed the digest in a different order than the
    // sender would always fail signature verification.
    const a = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}, {userId: 'c', deviceId: 1}],
    });
    const b = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'c', deviceId: 1}, {userId: 'b', deviceId: 1}],
    });
    // groupIds may differ (random salt) — overwrite to compare digest
    // with identical inputs.
    const aClone = {...a, groupId: 'fixed', masterKeyB64: 'fixed'};
    const bClone = {...b, groupId: 'fixed', masterKeyB64: 'fixed'};
    const da = canonicalCreateBytes(aClone);
    const db = canonicalCreateBytes(bClone);
    expect(Buffer.from(da)).toEqual(Buffer.from(db));
  });

  it('signGroupCreate + verifyGroupCreateSignature round-trips for a real identity keypair', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const ident = await alice.store.getIdentityKeyPair();
    const state = makeNewGroup({
      name: 'X', owner: 'alice', ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}],
    });
    const sig = await signGroupCreate(ident.privKey, state);
    const r = await verifyGroupCreateSignature({
      state,
      senderIdentityKeyB64: toB64(ident.pubKey),
      creatorSignature:     sig,
    });
    expect(r.ok).toBe(true);
  });

  it('verifyGroupCreateSignature rejects when state was tampered after signing', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const ident = await alice.store.getIdentityKeyPair();
    const state = makeNewGroup({
      name: 'X', owner: 'alice', ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}],
    });
    const sig = await signGroupCreate(ident.privKey, state);
    // Attacker substitutes a member with their own — same signature, different state.
    const tampered = {
      ...state,
      members: {...state.members, mallory: {deviceId: 1, admin: true, joinedAt: 0}},
    };
    const r = await verifyGroupCreateSignature({
      state:                tampered,
      senderIdentityKeyB64: toB64(ident.pubKey),
      creatorSignature:     sig,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('bad');}
  });

  it('verifyGroupCreateSignature flags missing signature distinctly from a bad one', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const ident = await alice.store.getIdentityKeyPair();
    const state = makeNewGroup({
      name: 'X', owner: 'alice', ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}],
    });
    const r = await verifyGroupCreateSignature({
      state,
      senderIdentityKeyB64: toB64(ident.pubKey),
      creatorSignature:     undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('missing');}
  });

  it('verifyGroupCreateSignature rejects malformed signatures (wrong length)', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const ident = await alice.store.getIdentityKeyPair();
    const state = makeNewGroup({
      name: 'X', owner: 'alice', ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}],
    });
    const r = await verifyGroupCreateSignature({
      state,
      senderIdentityKeyB64: toB64(ident.pubKey),
      creatorSignature:     'AAAA', // 3 bytes — not 64
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('malformed');}
  });

  it('verifyGroupCreateSignature rejects when checked against the wrong identity pubkey', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const mallory = await makeParty({userId: 'mallory', deviceId: 1});
    const aliceIdent = await alice.store.getIdentityKeyPair();
    const mallIdent  = await mallory.store.getIdentityKeyPair();
    const state = makeNewGroup({
      name: 'X', owner: 'alice', ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}],
    });
    const sig = await signGroupCreate(aliceIdent.privKey, state);
    const r = await verifyGroupCreateSignature({
      state,
      senderIdentityKeyB64: toB64(mallIdent.pubKey), // wrong key
      creatorSignature:     sig,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('bad');}
  });

  it('broadcast omits self — sender never sends themselves a copy', async () => {
    const {alice, aliceMgr, group} = await setupGroup();
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);
    const delivered: Array<{peer: SessionAddress}> = [];
    await broadcastToGroup({
      group, self: {userId: 'alice', deviceId: 1}, cert, body: 'x',
      session: aliceMgr,
      deliver: async (peer) => { delivered.push({peer}); },
    });
    expect(delivered.some(d => d.peer.userId === 'alice')).toBe(false);
  });
});

function toB64(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}
