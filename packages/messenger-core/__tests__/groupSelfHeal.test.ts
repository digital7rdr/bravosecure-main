import {SignJWT} from 'jose';
import {generateKeyPairSync} from 'node:crypto';
import {
  SessionManager,
  unsealPayload,
  broadcastToGroup, parseGroupMessage, applyAdminAction, makeNewGroup,
  planAddAndRekey, signGroupCreate,
  type Ciphertext, type SessionAddress, type GroupAdminAction, type GroupState,
} from '@bravo/messenger-core';
import {makeParty} from './fixtures';

/**
 * Self-heal group-key recovery.
 *
 * The user's report: "when I delete the app or log out, my key is lost, so
 * I can't decrypt the group — it should self-heal: the admin re-shares the
 * key to the member who lost it." These tests pin the primitives that make
 * that work, reusing the proven `admin: create` carrier (the ONE envelope
 * that ships UNWRAPPED, so a keyless member can read it):
 *
 *   1. `key-request` is an inert no-op in the reducer — a stray/forged
 *      request can never mutate membership, epoch, or the key.
 *   2. `broadcastToGroup` ships a `key-request` UNWRAPPED, so a member with
 *      NO master key can actually emit it.
 *   3. `only` restricts delivery to specific members while the `create`
 *      payload still carries the full, real roster.
 *   4. The full recovery roundtrip: a returning member that lost its key
 *      receives the owner's re-shared `create` and decrypts again.
 *   5. RC1 — a freshly ADDED member cannot decrypt the wrapped add/rekey
 *      envelopes, but DOES recover once the owner re-shares the post-rekey
 *      state as a `create`.
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

function toB64(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

describe('Self-heal group-key recovery', () => {
  it('key-request is an INERT no-op in applyAdminAction (never mutates state/epoch/key)', () => {
    const g = makeNewGroup({
      name: 'Ops', owner: 'a', ownerDeviceId: 1,
      members: [{userId: 'b', deviceId: 1}, {userId: 'c', deviceId: 1}],
    });
    const req: GroupAdminAction = {type: 'key-request', groupId: g.groupId, atEpochSeen: 0};
    // From a member, the owner/admin, and a non-member — ALL return the
    // SAME reference (no clone, no epoch bump, no key change).
    expect(applyAdminAction(g, req, 'b')).toBe(g);
    expect(applyAdminAction(g, req, 'a')).toBe(g);
    expect(applyAdminAction(g, req, 'stranger')).toBe(g);
    expect(g.epoch).toBe(0);
  });

  it('broadcastToGroup ships a key-request UNWRAPPED so a keyless member can send it', async () => {
    // Carol lost her key (reinstall). She has NO group state — only the
    // participant list — so she builds a synthetic state with an empty key
    // and asks the owner (alice) to re-share.
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const carol = await makeParty({userId: 'carol', deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);
    const carolMgr = new SessionManager(carol.store);
    await carolMgr.initOutgoingSession(alice.bundle);

    const groupId = 'group-xyz';
    const synthetic: GroupState = {
      groupId, name: '', owner: '',
      members: {alice: {deviceId: 1, admin: false, joinedAt: 0}},
      masterKeyB64: '', // no key — must NOT be needed
      epoch: 0, createdAt: 0, updatedAt: 0,
    };
    const carolId = toB64((await carol.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('carol', carolId);

    const delivered: Array<{ct: Ciphertext}> = [];
    const res = await broadcastToGroup({
      group: synthetic, self: {userId: 'carol', deviceId: 1}, cert,
      body: '', admin: {type: 'key-request', groupId, atEpochSeen: 0},
      session: carolMgr,
      deliver: async (_p, ct) => { delivered.push({ct}); },
    });
    expect(res.recipients).toBe(1);

    // Alice receives it WITHOUT any group key (she parses with her own key,
    // but the request is plaintext-admin so it parses regardless).
    const sealed = unsealPayload(await aliceMgr.decrypt({userId: 'carol', deviceId: 1}, delivered[0].ct));
    const parsed = await parseGroupMessage(sealed /* no master key needed */);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {throw new Error('parse failed');}
    expect(parsed.envelope.kind).toBe('admin');
    expect(parsed.envelope.adminAction?.type).toBe('key-request');
    if (parsed.envelope.adminAction?.type === 'key-request') {
      expect(parsed.envelope.adminAction.groupId).toBe(groupId);
    }
  });

  it('`only` restricts delivery to the listed members while the create carries the FULL roster', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const carol = await makeParty({userId: 'carol', deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);
    const carolMgr = new SessionManager(carol.store);
    await aliceMgr.initOutgoingSession(bob.bundle);
    await aliceMgr.initOutgoingSession(carol.bundle);

    const group = makeNewGroup({
      name: 'Ops', owner: 'alice', ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}, {userId: 'carol', deviceId: 1}],
    });
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);
    const sig = await signGroupCreate((await alice.store.getIdentityKeyPair()).privKey, group);

    const delivered: Array<{peer: SessionAddress; ct: Ciphertext}> = [];
    const res = await broadcastToGroup({
      group, self: {userId: 'alice', deviceId: 1}, cert, body: '',
      admin: {type: 'create', state: group, creatorSignature: sig},
      session: aliceMgr,
      only: ['carol'], // re-share to carol ONLY
      deliver: async (peer, ct) => { delivered.push({peer, ct}); },
    });

    // Only carol got a copy — bob was filtered out.
    expect(res.recipients).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].peer.userId).toBe('carol');

    // …but the create carol receives still names BOTH members (the roster
    // is intact; we only restricted WHO we delivered to).
    const sealed = unsealPayload(await carolMgr.decrypt({userId: 'alice', deviceId: 1}, delivered[0].ct));
    const parsed = await parseGroupMessage(sealed);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {throw new Error('parse failed');}
    if (parsed.envelope.adminAction?.type === 'create') {
      // Full roster — owner included — even though we only delivered to carol.
      expect(Object.keys(parsed.envelope.adminAction.state.members).sort())
        .toEqual(['alice', 'bob', 'carol']);
    } else {
      throw new Error('expected create admin action');
    }
  });

  it('ROSTER-GATE: an `only` target who is NOT a current member receives ZERO deliveries (no key leak)', async () => {
    // The re-share engine filters its targets to current members before
    // calling broadcastToGroup; this locks the broadcast layer itself —
    // even if a non-member id is passed in `only`, the members-loop never
    // iterates it, so a removed/non-member gets nothing.
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);
    await aliceMgr.initOutgoingSession(bob.bundle);

    const group = makeNewGroup({
      name: 'Ops', owner: 'alice', ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}],
    });
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);
    const sig = await signGroupCreate((await alice.store.getIdentityKeyPair()).privKey, group);

    const delivered: Array<{peer: SessionAddress}> = [];
    const res = await broadcastToGroup({
      group, self: {userId: 'alice', deviceId: 1}, cert, body: '',
      admin: {type: 'create', state: group, creatorSignature: sig},
      session: aliceMgr,
      only: ['mallory'], // NOT a member of the group
      deliver: async (peer) => { delivered.push({peer}); },
    });
    // mallory is not in group.members, so the fan-out never produces a copy.
    expect(res.recipients).toBe(0);
    expect(delivered).toHaveLength(0);
  });

  it('SELF-HEAL roundtrip: owner re-shares the current create → a returning keyless member recovers the key and decrypts', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const carol = await makeParty({userId: 'carol', deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);
    const carolMgr = new SessionManager(carol.store);
    await aliceMgr.initOutgoingSession(carol.bundle);

    const group = makeNewGroup({
      name: 'Ops Room', owner: 'alice', ownerDeviceId: 1,
      members: [{userId: 'carol', deviceId: 1}],
    });
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);

    // Carol reinstalled — she holds NO group state. A group text alice sent
    // is undecryptable to her (no_key).
    const preMsg: Array<{ct: Ciphertext}> = [];
    await broadcastToGroup({
      group, self: {userId: 'alice', deviceId: 1}, cert, body: 'mission briefing',
      session: aliceMgr,
      deliver: async (_p, ct) => { preMsg.push({ct}); },
    });
    const preSealed = unsealPayload(await carolMgr.decrypt({userId: 'alice', deviceId: 1}, preMsg[0].ct));
    const blocked = await parseGroupMessage(preSealed /* carol has no key */);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {expect(blocked.reason).toBe('no_key');}

    // OWNER RE-SHARE — alice re-delivers the CURRENT signed create to carol
    // (no epoch bump). This is exactly what reshareGroupKeyState does.
    const sig = await signGroupCreate((await alice.store.getIdentityKeyPair()).privKey, group);
    const reshare: Array<{ct: Ciphertext}> = [];
    await broadcastToGroup({
      group, self: {userId: 'alice', deviceId: 1}, cert, body: '',
      admin: {type: 'create', state: group, creatorSignature: sig},
      session: aliceMgr, only: ['carol'],
      deliver: async (_p, ct) => { reshare.push({ct}); },
    });
    const reshareSealed = unsealPayload(await carolMgr.decrypt({userId: 'alice', deviceId: 1}, reshare[0].ct));
    const createParsed = await parseGroupMessage(reshareSealed);
    expect(createParsed.ok).toBe(true);
    if (!createParsed.ok || createParsed.envelope.adminAction?.type !== 'create') {
      throw new Error('expected a create re-share');
    }
    // Carol applies it — she now holds the master key at the SAME epoch
    // (no rollback, no bump — a re-delivery of the existing key).
    const recovered = applyAdminAction(group, createParsed.envelope.adminAction, 'alice');
    expect(recovered.epoch).toBe(group.epoch);
    expect(recovered.masterKeyB64).toBe(group.masterKeyB64);

    // Now a SUBSEQUENT group text decrypts for carol — she's healed.
    const postMsg: Array<{ct: Ciphertext}> = [];
    await broadcastToGroup({
      group, self: {userId: 'alice', deviceId: 1}, cert, body: 'welcome back',
      session: aliceMgr,
      deliver: async (_p, ct) => { postMsg.push({ct}); },
    });
    const postSealed = unsealPayload(await carolMgr.decrypt({userId: 'alice', deviceId: 1}, postMsg[0].ct));
    const healed = await parseGroupMessage(postSealed, recovered.masterKeyB64);
    expect(healed.ok).toBe(true);
    if (!healed.ok) {throw new Error('still cannot decrypt after re-share');}
    expect(healed.envelope.body).toBe('welcome back');
  });

  it('RC1 — a freshly added member cannot decrypt the wrapped add/rekey, but recovers via a create re-share of the post-rekey state', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const dave  = await makeParty({userId: 'dave',  deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);
    const daveMgr  = new SessionManager(dave.store);
    await aliceMgr.initOutgoingSession(bob.bundle);
    await aliceMgr.initOutgoingSession(dave.bundle);

    const group = makeNewGroup({
      name: 'Ops', owner: 'alice', ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}],
    });
    const aliceId = toB64((await alice.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert('alice', aliceId);

    // Add dave: the add + rekey envelopes are BOTH wrapped under a key dave
    // never held — so dave (no key) gets no_key on the rekey envelope.
    const plan = planAddAndRekey(group, {userId: 'dave', deviceId: 1});
    const stateAfterAdd = applyAdminAction(group, plan.add, 'alice');
    const rekeyToDave: Array<{ct: Ciphertext}> = [];
    await broadcastToGroup({
      group: stateAfterAdd, self: {userId: 'alice', deviceId: 1}, cert,
      body: '', admin: plan.rekey, session: aliceMgr,
      only: ['dave'],
      deliver: async (_p, ct) => { rekeyToDave.push({ct}); },
    });
    const rekeySealed = unsealPayload(await daveMgr.decrypt({userId: 'alice', deviceId: 1}, rekeyToDave[0].ct));
    const cannot = await parseGroupMessage(rekeySealed /* dave has no key */);
    expect(cannot.ok).toBe(false);
    if (!cannot.ok) {expect(cannot.reason).toBe('no_key');}

    // RC1 FIX — owner re-shares the post-rekey state to dave as a create.
    const stateAfterRekey = applyAdminAction(stateAfterAdd, plan.rekey, 'alice');
    const sig = await signGroupCreate((await alice.store.getIdentityKeyPair()).privKey, stateAfterRekey);
    const createToDave: Array<{ct: Ciphertext}> = [];
    await broadcastToGroup({
      group: stateAfterRekey, self: {userId: 'alice', deviceId: 1}, cert, body: '',
      admin: {type: 'create', state: stateAfterRekey, creatorSignature: sig},
      session: aliceMgr, only: ['dave'],
      deliver: async (_p, ct) => { createToDave.push({ct}); },
    });
    const createSealed = unsealPayload(await daveMgr.decrypt({userId: 'alice', deviceId: 1}, createToDave[0].ct));
    const createParsed = await parseGroupMessage(createSealed);
    expect(createParsed.ok).toBe(true);
    if (!createParsed.ok || createParsed.envelope.adminAction?.type !== 'create') {
      throw new Error('expected create');
    }
    const daveState = applyAdminAction(stateAfterRekey, createParsed.envelope.adminAction, 'alice');
    expect(daveState.masterKeyB64).toBe(stateAfterRekey.masterKeyB64);

    // Dave can now read a post-join message under the new key.
    const post: Array<{ct: Ciphertext}> = [];
    await broadcastToGroup({
      group: stateAfterRekey, self: {userId: 'alice', deviceId: 1}, cert,
      body: 'dave can read this', session: aliceMgr, only: ['dave'],
      deliver: async (_p, ct) => { post.push({ct}); },
    });
    const postSealed = unsealPayload(await daveMgr.decrypt({userId: 'alice', deviceId: 1}, post[0].ct));
    const healed = await parseGroupMessage(postSealed, daveState.masterKeyB64);
    expect(healed.ok).toBe(true);
    if (!healed.ok) {throw new Error('dave still keyless after RC1 re-share');}
    expect(healed.envelope.body).toBe('dave can read this');
  });
});
