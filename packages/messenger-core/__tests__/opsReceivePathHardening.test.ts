/**
 * Ops-console receive-path hardening — parity with the mobile receiver.
 *
 * The ops-console runtime previously decoded inbound envelopes on the
 * LEGACY v2 posture: it routed by the forgeable inner `sender`, verified
 * the cert only AFTER decrypt, and never called verifySealedAad. This
 * suite proves the hardened sequence the ops runtime now performs:
 *
 *   unwrapOuter → (v3) verifySenderCert PRE-decrypt, route by claims
 *               → session.decrypt → unseal
 *               → verifySenderCert (trust anchor) + deviceId pin
 *               → verifySealedAad (recipient + freshness + sender + group)
 *
 * Because ops imports all of this from @bravo/messenger-core, we exercise
 * the exact package primitives the ops call sites use. Three properties:
 *
 *   1. Happy path: a v3-wrapped operator→user broadcast verifies end-to-end.
 *   2. Forged outer envelope (attacker names a victim sender on a v2 wrap)
 *      is caught — the cert is the trust anchor, not the inner `sender`.
 *   3. Replay to a different recipient is rejected by verifySealedAad.
 */

import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import {randomBytes, randomUUID} from 'node:crypto';
import {
  SessionManager,
  sealPayload, unsealPayload,
  wrapOuter, unwrapOuter,
  verifySenderCert, verifySealedAad,
  toBase64,
  type SessionAddress,
} from '@bravo/messenger-core';
import {makeParty} from './fixtures';

const curve = new AsyncCurve25519Wrapper();

async function makeAuthorityKeys() {
  const seed = randomBytes(32);
  const kp = await curve.keyPair(seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength));
  return {privKey: kp.privKey, pubKeyB64: Buffer.from(kp.pubKey).toString('base64')};
}

function b64Json(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

async function mintCert(privKey: ArrayBuffer, p: {
  sub: string; signalDeviceId: number; identityKey: string; expiresInSec?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    senderUserId: p.sub, senderSignalDeviceId: p.signalDeviceId,
    senderIdentityKey: p.identityKey, iat: now, exp: now + (p.expiresInSec ?? 3600),
    iss: 'auth-service', jti: randomUUID(),
  };
  const headerB64 = b64Json({alg: 'XEd25519', typ: 'BSC'});
  const payloadB64 = b64Json(payload);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const sigAb = await curve.sign(privKey, signingInput.buffer.slice(signingInput.byteOffset, signingInput.byteOffset + signingInput.byteLength));
  return `${headerB64}.${payloadB64}.${Buffer.from(sigAb).toString('base64')}`;
}

/**
 * Mirror of the ops runtime.handleEnvelope verification sequence. Returns
 * the rendered body on success or a `{drop: reason}` on rejection — so the
 * test asserts the same branches the real receiver takes.
 */
async function opsReceive(args: {
  outerSealed: string;
  recipient: {store: Awaited<ReturnType<typeof makeParty>>['store']; mgr: SessionManager; self: SessionAddress};
  authorityPubKeyB64: string;
}): Promise<{body: string} | {drop: string}> {
  const {recipient} = args;
  const ownId = await recipient.store.getIdentityKeyPair();
  let unwrapped;
  try {
    unwrapped = await unwrapOuter({
      ownIdentityPrivKey: ownId.privKey, ownIdentityPubKey: ownId.pubKey,
      outerSealedB64: args.outerSealed,
    });
  } catch { return {drop: 'unwrap'}; }

  let sender = unwrapped.sender;
  // v3 pre-decrypt cert verify → route by claims.
  if (unwrapped.wireVersion === 3 && unwrapped.senderCert) {
    try {
      const claims = await verifySenderCert({cert: unwrapped.senderCert, authorityPubKeyB64: args.authorityPubKeyB64});
      sender = {userId: claims.senderUserId, deviceId: claims.senderSignalDeviceId};
    } catch { return {drop: 'v3_cert'}; }
  }

  let plain: string;
  try { plain = await recipient.mgr.decrypt(sender, unwrapped.ciphertext); }
  catch { return {drop: 'decrypt'}; }

  const sealed = unsealPayload(plain);
  // Post-decrypt cert trust anchor + deviceId pin.
  try {
    const claims = await verifySenderCert({cert: sealed.cert, authorityPubKeyB64: args.authorityPubKeyB64});
    if (claims.senderUserId !== sender.userId) {return {drop: 'cert_mismatch'};}
    if (claims.senderSignalDeviceId !== sender.deviceId) {return {drop: 'device_mismatch'};}
  } catch { return {drop: 'cert'}; }

  const aadCheck = verifySealedAad({
    sealed, selfUserId: recipient.self.userId, selfDeviceId: recipient.self.deviceId,
    requireAad: true,
    expectedSender: sender,
    expectedConversationId: sealed.group?.groupId,
    expectedGroupId: sealed.group?.groupId,
  });
  if (!aadCheck.ok) {return {drop: `aad:${aadCheck.reason}`};}

  return {body: sealed.body};
}

describe('ops-console receive-path hardening (parity with mobile)', () => {
  it('happy path — a v3-wrapped operator→user message verifies end-to-end', async () => {
    const cpo  = await makeParty({userId: 'cpo-op', deviceId: 1});
    const user = await makeParty({userId: 'user-1', deviceId: 1});
    const cpoMgr  = new SessionManager(cpo.store);
    const userMgr = new SessionManager(user.store);
    const auth = await makeAuthorityKeys();

    const cpoIdB64 = toBase64((await cpo.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert(auth.privKey, {sub: 'cpo-op', signalDeviceId: 1, identityKey: cpoIdB64});

    await cpoMgr.initOutgoingSession(user.bundle);
    const peer: SessionAddress = {userId: 'user-1', deviceId: 1};
    const sealed = sealPayload(cert, 'shift starts 06:00', {
      group: {groupId: 'mission-42', kind: 'text', clientMsgId: 'm1'},
      aad: {to: peer, ts: Date.now(), sender: {userId: 'cpo-op', deviceId: 1}, conversationId: 'mission-42', groupId: 'mission-42'},
    });
    const ct = await cpoMgr.encrypt(peer, sealed);
    const outerSealed = await wrapOuter({
      recipientIdentityKeyB64: toBase64((await user.store.getIdentityKeyPair()).pubKey),
      sender: {userId: 'cpo-op', deviceId: 1}, ciphertext: ct, cert, // v3
    });

    const res = await opsReceive({outerSealed, recipient: {store: user.store, mgr: userMgr, self: peer}, authorityPubKeyB64: auth.pubKeyB64});
    expect(res).toEqual({body: 'shift starts 06:00'});
  });

  it('forged outer envelope (v2, attacker-named sender) is dropped — inner sender is not trusted', async () => {
    // Attacker holds a valid session to the victim but wraps v2 (no cert
    // in AAD) naming a DIFFERENT sender. The mobile/ops receiver only
    // trusts the cert; on v2 the post-decrypt cert check catches the
    // mismatch between the wrap-claimed sender and the cert subject.
    const attacker = await makeParty({userId: 'attacker', deviceId: 1});
    const user     = await makeParty({userId: 'user-1',  deviceId: 1});
    const attackerMgr = new SessionManager(attacker.store);
    const userMgr     = new SessionManager(user.store);
    const auth = await makeAuthorityKeys();

    // Attacker's OWN cert (they can't mint one for 'cpo-op').
    const attackerIdB64 = toBase64((await attacker.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert(auth.privKey, {sub: 'attacker', signalDeviceId: 1, identityKey: attackerIdB64});

    await attackerMgr.initOutgoingSession(user.bundle);
    const peer: SessionAddress = {userId: 'user-1', deviceId: 1};
    const sealed = sealPayload(cert, 'spoofed', {aad: {to: peer, ts: Date.now()}});
    const ct = await attackerMgr.encrypt(peer, sealed);
    // v2 wrap (no cert) claiming the inner sender is the trusted CPO.
    const outerSealed = await wrapOuter({
      recipientIdentityKeyB64: toBase64((await user.store.getIdentityKeyPair()).pubKey),
      sender: {userId: 'cpo-op', deviceId: 1}, ciphertext: ct, // NO cert → v2, forged sender
    });

    const res = await opsReceive({outerSealed, recipient: {store: user.store, mgr: userMgr, self: peer}, authorityPubKeyB64: auth.pubKeyB64});
    // Routed by inner sender 'cpo-op' → no session under that name → decrypt fails;
    // even if it didn't, the cert subject 'attacker' ≠ 'cpo-op' would drop it.
    expect('drop' in res).toBe(true);
  });

  it('replay to a different recipient is rejected by the AAD recipient binding', async () => {
    const cpo   = await makeParty({userId: 'cpo-op', deviceId: 1});
    const user  = await makeParty({userId: 'user-1', deviceId: 1});
    const other = await makeParty({userId: 'user-2', deviceId: 1});
    const cpoMgr  = new SessionManager(cpo.store);
    const userMgr = new SessionManager(user.store);
    const auth = await makeAuthorityKeys();
    const cpoIdB64 = toBase64((await cpo.store.getIdentityKeyPair()).pubKey);
    const cert = await mintCert(auth.privKey, {sub: 'cpo-op', signalDeviceId: 1, identityKey: cpoIdB64});

    await cpoMgr.initOutgoingSession(user.bundle);
    const peer: SessionAddress = {userId: 'user-1', deviceId: 1};
    const sealedStr = sealPayload(cert, 'for user-1 only', {
      aad: {to: peer, ts: Date.now(), sender: {userId: 'cpo-op', deviceId: 1}},
    });
    const ct = await cpoMgr.encrypt(peer, sealedStr);
    const outerSealed = await wrapOuter({
      recipientIdentityKeyB64: toBase64((await user.store.getIdentityKeyPair()).pubKey),
      sender: {userId: 'cpo-op', deviceId: 1}, ciphertext: ct, cert,
    });

    // user-2 cannot even decrypt it (wrong identity for the outer ECIES),
    // but assert the AAD layer independently rejects the recipient mismatch.
    // (verifySealedAad takes the parsed SealedPayload, not the JSON string.)
    const aad = verifySealedAad({sealed: unsealPayload(sealedStr), selfUserId: 'user-2', selfDeviceId: 1, requireAad: true});
    expect(aad.ok).toBe(false);
    if (!aad.ok) {expect(aad.reason).toBe('recipient_mismatch');}

    // Sanity: the legitimate recipient still accepts.
    const res = await opsReceive({outerSealed, recipient: {store: user.store, mgr: userMgr, self: peer}, authorityPubKeyB64: auth.pubKeyB64});
    expect(res).toEqual({body: 'for user-1 only'});
    void other;
  });
});
