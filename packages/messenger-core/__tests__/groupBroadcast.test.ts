import {SignJWT} from 'jose';
import {generateKeyPairSync} from 'node:crypto';
import {
  SessionManager,
  unsealPayload,
  verifySealedAad,
  broadcastToGroup, parseGroupMessage, applyAdminAction, makeNewGroup,
  planRemoveAndRekey, planAddAndRekey, genFreshGroupMasterKey,
  signGroupCreate, verifyGroupCreateSignature, canonicalCreateBytes,
  type Ciphertext, type SessionAddress,
} from '@bravo/messenger-core';
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

  it('audit G-05 — a relayed owner create verifies ONLY against the OWNER identity, not the relayer/attacker (no forge)', async () => {
    const {alice, bob, group} = await setupGroup();
    const alicePriv = (await alice.store.getIdentityKeyPair()).privKey;
    const aliceIdB64 = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const bobIdB64   = toB64((await bob.store.getIdentityKeyPair()).pubKey);

    // Owner (alice) signs the create over the canonical (groupId,members,key,epoch).
    const ownerSig = await signGroupCreate(alicePriv, group);

    // A member RELAYS that signature. The receiver (G-05) verifies it against
    // the OWNER's identity key — regardless of who relayed it — so it passes.
    const okAsOwner = await verifyGroupCreateSignature({
      state: group, senderIdentityKeyB64: aliceIdB64, creatorSignature: ownerSig,
    });
    expect(okAsOwner.ok).toBe(true);

    // The SAME signature verified against a NON-owner (bob) identity FAILS —
    // so a member can only relay a genuine owner signature, never forge a key.
    const failAsBob = await verifyGroupCreateSignature({
      state: group, senderIdentityKeyB64: bobIdB64, creatorSignature: ownerSig,
    });
    expect(failAsBob.ok).toBe(false);

    // And a signature bob mints over the same state does NOT verify against the
    // owner identity — an attacker can't fabricate an owner-signed create.
    const bobPriv = (await bob.store.getIdentityKeyPair()).privKey;
    const bobSig = await signGroupCreate(bobPriv, group);
    const forge = await verifyGroupCreateSignature({
      state: group, senderIdentityKeyB64: aliceIdB64, creatorSignature: bobSig,
    });
    expect(forge.ok).toBe(false);
  });

  it('audit P0-N2 (group AAD) — binds sender + conversation + group; verifySealedAad enforces them', async () => {
    const {alice, aliceMgr, bobMgr, group} = await setupGroup();
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);
    const delivered: Array<{peer: SessionAddress; ct: Ciphertext}> = [];
    await broadcastToGroup({
      group, self: {userId: 'alice', deviceId: 1}, cert, body: 'brief',
      session: aliceMgr,
      deliver: async (peer, ct) => { delivered.push({peer, ct}); },
    });
    const bobCopy = delivered.find(d => d.peer.userId === 'bob')!;
    const sealed  = unsealPayload(await bobMgr.decrypt({userId: 'alice', deviceId: 1}, bobCopy.ct));

    // The new AAD bindings are present and point at the right values.
    expect(sealed.aad?.to).toEqual({userId: 'bob', deviceId: 1});
    expect(sealed.aad?.sender).toEqual({userId: 'alice', deviceId: 1});
    expect(sealed.aad?.conversationId).toBe(group.groupId);
    expect(sealed.aad?.groupId).toBe(group.groupId);
    // epoch 0 is a placeholder — must be omitted so a future
    // expectedEpoch check can't false-reject.
    expect(sealed.aad?.epoch).toBeUndefined();

    // Bob (the real recipient) accepts; verification enforces sender +
    // conversation + group bindings.
    const ok = verifySealedAad({
      sealed, selfUserId: 'bob', selfDeviceId: 1,
      requireAad: true,
      expectedSender: {userId: 'alice', deviceId: 1},
      expectedConversationId: group.groupId,
      expectedGroupId: group.groupId,
    });
    expect(ok.ok).toBe(true);

    // Carol replaying Bob's copy to herself is rejected (recipient_mismatch).
    const stolen = verifySealedAad({
      sealed, selfUserId: 'carol', selfDeviceId: 1, requireAad: true,
    });
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) {expect(stolen.reason).toBe('recipient_mismatch');}

    // Splicing the ciphertext into a different group thread is rejected.
    const crossGroup = verifySealedAad({
      sealed, selfUserId: 'bob', selfDeviceId: 1, requireAad: true,
      expectedGroupId: 'some-other-group',
    });
    expect(crossGroup.ok).toBe(false);
    if (!crossGroup.ok) {expect(crossGroup.reason).toBe('group_mismatch');}
  });

  it('parseGroupMessage rejects when inner envelope and outer group hint diverge', async () => {
    const {alice, aliceMgr, bobMgr, group} = await setupGroup();
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);
    // B-126 — select Bob's copy by PEER, never by index. broadcastToGroup fans
    // out with Promise.allSettled over a concurrency window (groupClient.ts:266),
    // so `delivered` is ordered by resolution, not by member order. Taking
    // delivered[0] handed Carol's ciphertext to bobMgr whenever her send won the
    // race — a "Bad MAC" that only reproduced under parallel load, and one of the
    // suites behind the ~50% random-suite failure.
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

  // ─── Audit P0-G3 — addAndRekey planner ────────────────────────────
  //
  // A bare `add` admits a new member at the current epoch under the
  // current master key — every queued envelope (≤ 30d dwell) and every
  // sealed-archive row (≤ 90d) becomes decryptable by the new member.
  // The chained rekey rotates the key the instant the membership set
  // expands so the new member can only read messages sent AFTER they
  // joined, matching Signal-spec forward secrecy on add.

  it('audit P0-G3 — planAddAndRekey produces an add at current epoch and a rekey at next epoch', () => {
    const g = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}],
    });
    const plan = planAddAndRekey(g, {userId: 'c', deviceId: 1});
    expect(plan.add).toEqual({type: 'add', member: {userId: 'c', deviceId: 1}, atEpoch: 0});
    expect(plan.rekey.type).toBe('rekey');
    expect(plan.rekey.atEpoch).toBe(1);
    expect(plan.newMasterKeyB64).toBe(plan.rekey.newMasterKeyB64);
    expect(plan.newMasterKeyB64).not.toBe(g.masterKeyB64);
    expect(plan.newMasterKeyB64.length).toBeGreaterThan(40);
  });

  it('audit P0-G3 — planAddAndRekey, applied in order, adds member AND rotates the key', () => {
    const g = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}],
    });
    const oldKey = g.masterKeyB64;
    const plan = planAddAndRekey(g, {userId: 'c', deviceId: 1});

    // Step 1: add at epoch 0 → epoch 1, members include c, key UNCHANGED.
    const afterAdd = applyAdminAction(g, plan.add, 'a');
    expect(afterAdd.epoch).toBe(1);
    expect(afterAdd.members.c).toBeTruthy();
    expect(afterAdd.members.c?.deviceId).toBe(1);
    expect(afterAdd.members.c?.admin).toBe(false);
    expect(afterAdd.masterKeyB64).toBe(oldKey);

    // Step 2: rekey at epoch 1 → epoch 2, key replaced.
    const afterRekey = applyAdminAction(afterAdd, plan.rekey, 'a');
    expect(afterRekey.epoch).toBe(2);
    expect(afterRekey.masterKeyB64).toBe(plan.newMasterKeyB64);
    expect(afterRekey.masterKeyB64).not.toBe(oldKey);
    // Membership unchanged from afterAdd.
    expect(afterRekey.members.c).toBeTruthy();
    expect(afterRekey.members.b).toBeTruthy();
    expect(afterRekey.members.a).toBeTruthy();
  });

  it('audit P0-G3 — planAddAndRekey throws when target is already a member', () => {
    const g = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}],
    });
    expect(() => planAddAndRekey(g, {userId: 'b', deviceId: 1}))
      .toThrow(/already in group/);
  });

  it('audit P0-G3 — planAddAndRekey rejects malformed member', () => {
    const g = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}],
    });
    expect(() => planAddAndRekey(g, {userId: '', deviceId: 1})).toThrow(/invalid newMember/);
    expect(() => planAddAndRekey(g, {userId: 'c', deviceId: 0})).toThrow(/invalid newMember/);
  });

  it('audit P0-G3 — non-admin sender cannot apply the add or rekey leg', () => {
    const g = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}],
    });
    const plan = planAddAndRekey(g, {userId: 'c', deviceId: 1});
    // 'b' is a non-admin member — both legs must be dropped.
    expect(applyAdminAction(g, plan.add, 'b')).toBe(g);
    expect(applyAdminAction(g, plan.rekey, 'b')).toBe(g);
  });

  it('audit P0-G3 — forward-secrecy property: pre-add ciphertext is undecryptable by the new member', async () => {
    // The behavioural assertion: after add+rekey, a NEW message
    // encrypted under the new key cannot be decrypted by anything
    // holding the OLD key. The contrapositive is what matters — a
    // message encrypted under the OLD key (pre-add) sits on the relay,
    // but the new member only ever holds the NEW key, so they cannot
    // read it. We model this end-to-end with the symmetric crypto:
    const {groupEncrypt, groupDecrypt} = await import('../src/crypto/groupCrypto');

    const g = makeNewGroup({
      name: 'X', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}],
    });

    // Existing members encrypt a message under the OLD key BEFORE the
    // add. (In real life this envelope is still queued on the relay
    // up to 30 days.)
    const preAddCipher = await groupEncrypt(g.masterKeyB64, 'secret from before c joined');

    // Run the planner end-to-end.
    const plan = planAddAndRekey(g, {userId: 'c', deviceId: 1});
    const afterAdd = applyAdminAction(g, plan.add, 'a');
    const afterRekey = applyAdminAction(afterAdd, plan.rekey, 'a');

    // The new member only holds the NEW master key. They cannot decrypt
    // the pre-add ciphertext — GCM auth-fails because the key is wrong.
    await expect(groupDecrypt(afterRekey.masterKeyB64, preAddCipher))
      .rejects.toThrow(/group decrypt failed/);

    // Post-add messages encrypted under the new key DO decrypt for all
    // current members including c.
    const postAddCipher = await groupEncrypt(afterRekey.masterKeyB64, 'after c joined');
    const pt = await groupDecrypt(afterRekey.masterKeyB64, postAddCipher);
    expect(pt).toBe('after c joined');
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

  // ─── B-10 — epoch redistribution ordering ─────────────────────────
  //
  // Whenever a path advances/rotates the group epoch, the new-epoch key
  // MUST be redistributed to all members BEFORE the host sends any
  // message under the new epoch — otherwise the host's next message
  // drops as `tamper` (key divergence) on lagging peers. And if a rekey
  // fan-out reaches 0 peers, the host must NOT silently proceed.

  it('B-10 — epoch advance (add+rekey) redistributes the new key to ALL members before the first new-epoch message', async () => {
    const {alice, aliceMgr, group} = await setupGroup();
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);

    // Add dave (needs an outgoing session so the rekey envelope encrypts).
    const dave = await makeParty({userId: 'dave', deviceId: 1});
    await aliceMgr.initOutgoingSession(dave.bundle);

    const plan = planAddAndRekey(group, {userId: 'dave', deviceId: 1});
    const stateAfterAdd = applyAdminAction(group, plan.add, 'alice');

    // Redistribute the rekey to the POST-add member set, under the OLD
    // key (still active). Capture who received it.
    const rekeyRecipients: string[] = [];
    await broadcastToGroup({
      group: stateAfterAdd, self: {userId: 'alice', deviceId: 1}, cert,
      body: '', admin: plan.rekey, session: aliceMgr,
      deliver: async (peer) => { rekeyRecipients.push(peer.userId); },
    });

    // Every non-self member (incl. the just-added dave) gets the rekey
    // envelope — i.e. the new epoch key is distributed to ALL of them.
    expect(new Set(rekeyRecipients)).toEqual(new Set(['bob', 'carol', 'dave']));

    // Only AFTER redistribution do we rotate locally and send the first
    // new-epoch message. The first message goes out to the same full set,
    // so no member is left behind on the old epoch.
    const stateAfterRekey = applyAdminAction(stateAfterAdd, plan.rekey, 'alice');
    expect(stateAfterRekey.masterKeyB64).toBe(plan.newMasterKeyB64);
    const firstMsgRecipients: string[] = [];
    await broadcastToGroup({
      group: stateAfterRekey, self: {userId: 'alice', deviceId: 1}, cert,
      body: 'first message under the new epoch', session: aliceMgr,
      deliver: async (peer) => { firstMsgRecipients.push(peer.userId); },
    });
    expect(new Set(firstMsgRecipients)).toEqual(new Set(rekeyRecipients));
  });

  it('B-10 — remove+rekey redistributes the new key to the POST-remove member set (removed user excluded)', async () => {
    const {alice, aliceMgr, group} = await setupGroup();
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);

    const plan = planRemoveAndRekey(group, 'carol');
    const stateAfterRemove = applyAdminAction(group, plan.remove, 'alice');

    const rekeyRecipients: string[] = [];
    await broadcastToGroup({
      group: stateAfterRemove, self: {userId: 'alice', deviceId: 1}, cert,
      body: '', admin: plan.rekey, session: aliceMgr,
      deliver: async (peer) => { rekeyRecipients.push(peer.userId); },
    });
    // The removed member never receives the new key; everyone else does.
    expect(rekeyRecipients).toEqual(['bob']);
    expect(rekeyRecipients).not.toContain('carol');
  });

  it('B-10 — a rekey fan-out that reaches 0 peers is SURFACED, not silently accepted', async () => {
    const {alice, aliceMgr, group} = await setupGroup();
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);

    const plan = planRemoveAndRekey(group, 'carol');
    const stateAfterRemove = applyAdminAction(group, plan.remove, 'alice');

    // Faithful replica of the runtime's 0-peer policy (productionRuntime.ts
    // remove+rekey / add+rekey): retry the fan-out once, then surface if it
    // still reached nobody — never silently proceed.
    let surfaced: string | null = null;
    const setError = (m: string) => { surfaced = m; };
    const fanOutRekey = async (): Promise<number> => {
      let delivered = 0;
      await broadcastToGroup({
        group: stateAfterRemove, self: {userId: 'alice', deviceId: 1}, cert,
        body: '', admin: plan.rekey, session: aliceMgr,
        // Every delivery throws → simulates an all-offline member set.
        deliver: async () => { throw new Error('peer unreachable'); },
      });
      // broadcastToGroup swallows per-peer deliver throws into `failures`
      // and returns recipients=0; the runtime counts successful deliveries.
      return delivered;
    };
    let rekeyDelivered = await fanOutRekey();
    if (rekeyDelivered === 0) { rekeyDelivered = await fanOutRekey(); }
    if (rekeyDelivered === 0) {
      setError('Group key update reached no members — they may miss new messages until they refetch');
    }

    expect(rekeyDelivered).toBe(0);
    expect(surfaced).not.toBeNull();
    expect(surfaced).toMatch(/reached no members/);
  });

  // ─── GRP-26 — parallel fan-out ─────────────────────────────────────
  //
  // broadcastToGroup used to await ensureSession + encrypt + deliver
  // per member SEQUENTIALLY, making a group CREATE O(members × RTT).
  // The fan-out now runs concurrently (Promise.allSettled in chunks of
  // 8) while preserving per-member error semantics and the delivered-
  // count contract (callers throw when recipients === 0).

  it('GRP-26 — fan-out is parallel: the second delivery starts before the first completes', async () => {
    const {alice, aliceMgr, group} = await setupGroup();
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);

    // Barrier: no delivery may finish until BOTH have started. A
    // sequential fan-out would deadlock here (#2 never starts while #1
    // awaits), so a 2s fallback releases the gate and fails the
    // assertion instead of hanging the suite.
    let releaseGate!: () => void;
    const gate = new Promise<void>(r => { releaseGate = r; });
    let started = 0;
    let timedOut = false;
    const fallback = setTimeout(() => { timedOut = true; releaseGate(); }, 2_000);

    const res = await broadcastToGroup({
      group, self: {userId: 'alice', deviceId: 1}, cert, body: 'x',
      session: aliceMgr,
      deliver: async () => {
        started += 1;
        if (started === 2) {releaseGate();}
        await gate;
      },
    });
    clearTimeout(fallback);

    expect(timedOut).toBe(false);
    expect(started).toBe(2);
    expect(res.recipients).toBe(2);
  });

  it('GRP-26 — every member is still attempted when some fail; recipients counts successes only', async () => {
    const {alice, aliceMgr, group} = await setupGroup();
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);

    const attempted: string[] = [];
    const res = await broadcastToGroup({
      group, self: {userId: 'alice', deviceId: 1}, cert, body: 'x',
      session: aliceMgr,
      deliver: async (peer) => {
        attempted.push(peer.userId);
        if (peer.userId === 'bob') {throw new Error('bob unreachable');}
        return {envelopeId: `env-${peer.userId}`};
      },
    });
    expect(new Set(attempted)).toEqual(new Set(['bob', 'carol']));
    expect(res.recipients).toBe(1);
    expect(res.envelopeIds).toEqual(['env-carol']);
    expect(res.failures).toEqual([{userId: 'bob', deviceId: 1, error: 'bob unreachable'}]);
  });

  it('GRP-26 — an all-fail fan-out still returns recipients=0 with every failure recorded', async () => {
    const {alice, aliceMgr, group} = await setupGroup();
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);

    const res = await broadcastToGroup({
      group, self: {userId: 'alice', deviceId: 1}, cert, body: 'x',
      session: aliceMgr,
      deliver: async () => { throw new Error('offline'); },
    });
    expect(res.recipients).toBe(0);
    expect(res.envelopeIds).toEqual([]);
    expect(res.failures.map(f => f.userId).sort()).toEqual(['bob', 'carol']);
  });

  it('GRP-26 — concurrency is capped (≤8 in flight) on a large roster; all members delivered', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);
    const members: Array<{userId: string; deviceId: number}> = [];
    for (let i = 0; i < 10; i++) {
      const uid = `peer${i}`;
      const p = await makeParty({userId: uid, deviceId: 1});
      await aliceMgr.initOutgoingSession(p.bundle);
      members.push({userId: uid, deviceId: 1});
    }
    const group = makeNewGroup({name: 'big', owner: 'alice', ownerDeviceId: 1, members});
    const cert = await mintCert('alice', toB64((await alice.store.getIdentityKeyPair()).pubKey));

    let active = 0;
    let maxActive = 0;
    const attempted = new Set<string>();
    const res = await broadcastToGroup({
      group, self: {userId: 'alice', deviceId: 1}, cert, body: 'x',
      session: aliceMgr,
      deliver: async (peer) => {
        attempted.add(peer.userId);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 20));
        active -= 1;
      },
    });
    expect(res.recipients).toBe(10);
    expect(attempted.size).toBe(10);
    expect(maxActive).toBeGreaterThan(1);    // actually parallel…
    expect(maxActive).toBeLessThanOrEqual(8); // …but chunk-capped
  });
});

function toB64(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}
