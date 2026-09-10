/**
 * Audit P0-G2 — `parseGroupMessage` accepts legacy plaintext envelopes
 * unconditionally.
 *
 * Before this fix, when the sealed body did NOT look like a group
 * ciphertext (`isGroupCiphertext(outer)` returned false), the code fell
 * through to `inner = outer as GroupMessageEnvelope` and accepted ANY
 * JSON shaped like a group envelope. That made downgrade attacks free:
 * a relay-side actor (or anyone with a valid cert at all) could ship a
 * plaintext `kind:'text'` envelope claiming arbitrary `body` and the
 * receiver would accept it without ever consulting the group master key,
 * silently bypassing the AES-GCM wrap that's the whole point of having
 * a master key.
 *
 * The fix:
 *   - Default behaviour: REJECT plaintext `kind:'text'` envelopes
 *     (`{ok:false, reason:'malformed'}`). Production never legitimately
 *     produces them post-S2.
 *   - `kind:'admin'` plaintext is STILL accepted, because admin `create`
 *     bootstraps the master key and must be plaintext by construction
 *     (the receiver doesn't have the key yet). The applyAdminAction
 *     receiver still gates this on the admin-only / create-signature
 *     checks already in place.
 *   - Rollout escape hatch: setting `EXPO_PUBLIC_LEGACY_GROUP_PLAINTEXT=true`
 *     re-enables the old fall-through for legacy senders during the
 *     transition window. Loud `console.warn` at module load when set so
 *     the flag is visible. Follows the same S9/S10/P0-N1 pattern.
 */

import {sealPayload, parseGroupMessage, type SealedPayload} from '@bravo/messenger-core';
import {SignJWT, importPKCS8} from 'jose';
import {generateKeyPairSync} from 'node:crypto';

async function mintCert(sub: string): Promise<string> {
  const {privateKey} = generateKeyPairSync('ed25519');
  const pem = privateKey.export({type: 'pkcs8', format: 'pem'}) as string;
  const signingKey = await importPKCS8(pem, 'EdDSA');
  return new SignJWT({
    senderUserId: sub,
    senderSignalDeviceId: 1,
    senderIdentityKey: 'AAAA',
  })
    .setProtectedHeader({alg: 'EdDSA'})
    .setSubject(sub)
    .setIssuer('auth-service')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
}

describe('audit P0-G2 — parseGroupMessage rejects plaintext text envelopes by default', () => {
  it('plaintext kind:text envelope returns {ok:false, reason:malformed} (NO legacy fall-through)', async () => {
    const cert = await mintCert('alice');
    // Build a sealed payload whose inner body is RAW PLAINTEXT JSON,
    // matching the legacy pre-S2 wire format. Notably NOT a
    // GroupCiphertext shape, so the master-key path is skipped.
    const plainEnvelope = JSON.stringify({
      groupId: 'g1',
      kind: 'text',
      clientMsgId: 'msg-1',
      body: 'spoofed',
    });
    const sealed = sealPayload(cert, plainEnvelope, {
      group: {groupId: 'g1', kind: 'text', clientMsgId: 'msg-1'},
    });

    // No masterKeyB64 supplied — the legacy fall-through previously
    // accepted this. Post-fix it must reject.
    const parsed = JSON.parse(sealed) as SealedPayload;
    const result = await parseGroupMessage(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed');
    }
  });

  it('plaintext kind:admin envelope is STILL accepted (admin create needs plaintext)', async () => {
    const cert = await mintCert('alice');
    const createEnvelope = JSON.stringify({
      groupId: 'g1',
      kind: 'admin',
      clientMsgId: 'admin-1',
      body: '',
      adminAction: {
        type: 'create',
        state: {
          groupId: 'g1',
          name: 'DIFC',
          owner: 'alice',
          members: {alice: {deviceId: 1, admin: true, joinedAt: 0}},
          masterKeyB64: 'AAAA',
          epoch: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      },
    });
    const sealed = sealPayload(cert, createEnvelope, {
      group: {groupId: 'g1', kind: 'admin', clientMsgId: 'admin-1'},
    });

    const parsed = JSON.parse(sealed) as SealedPayload;
    const result = await parseGroupMessage(parsed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.adminAction?.type).toBe('create');
    }
  });

  it('non-group sealed payload returns {ok:false, reason:not_group} (untouched by this fix)', async () => {
    const cert = await mintCert('alice');
    const sealed = sealPayload(cert, JSON.stringify({hi: 'there'}), {});

    const parsed = JSON.parse(sealed) as SealedPayload;
    const result = await parseGroupMessage(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_group');
    }
  });
});
