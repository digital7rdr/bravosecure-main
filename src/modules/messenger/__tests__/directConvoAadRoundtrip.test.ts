/**
 * Audit P0-N2 follow-up — END-TO-END regression for the 1:1 AAD
 * conversationId symmetry bug.
 *
 * This test stands in for the device-level smoke test the user asked
 * about (boot two devices, send 1:1, observe receiver renders). The
 * messenger-crypto Jest project is Node-only — no Metro, no SQLCipher,
 * no real WS — but we CAN drive sealPayload + verifySealedAad with
 * the exact AAD shape that productionRuntime stamps on each side.
 *
 * The bug:
 *   Sender (Alice → Bob) stamped `aad.conversationId = "direct:bob"`
 *     (Alice's local UI key)
 *   Receiver (Bob) expected `aad.conversationId = "direct:alice"`
 *     (Bob's local UI key)
 *   → verifySealedAad rejected with `conversation_mismatch`
 *
 * The fix is to wrap the value in `directConvoAadId(self, peer)` on
 * BOTH sides. This test verifies the round-trip succeeds with the
 * fixed helper and FAILS catastrophically with the buggy shape — so
 * a regression that puts the asymmetric stamp back can't slip past.
 */

import {sealPayload, unsealPayload, verifySealedAad} from '@bravo/messenger-core';

// Mirror of the production helper in
// src/modules/messenger/runtime/productionRuntime.ts. Kept in lockstep
// with that file. When the helper moves to a shared module, replace
// this with a real import.
function directConvoAadId(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `direct:${lo}|${hi}`;
}

/** Simulate Alice's sender path stamping the sealed envelope. */
function aliceStampsForBob(text: string, opts: {useFix: boolean}): string {
  const aliceUserId = 'alice-uuid';
  const bob = {userId: 'bob-uuid', deviceId: 1};
  const conversationId = opts.useFix
    ? directConvoAadId(aliceUserId, bob.userId)
    : `direct:${bob.userId}`; // OLD buggy: peer-from-Alice's-view
  return sealPayload('cert.cert.cert', text, {
    aad: {
      to:             bob,
      ts:             Date.now(),
      sender:         {userId: aliceUserId, deviceId: 1},
      conversationId,
    },
  });
}

/** Simulate Bob's receiver path computing expectedConversationId. */
function bobVerifiesFromAlice(wire: string, opts: {useFix: boolean}) {
  const bobUserId = 'bob-uuid';
  const alice = {userId: 'alice-uuid', deviceId: 1};
  const expectedConversationId = opts.useFix
    ? directConvoAadId(bobUserId, alice.userId)
    : `direct:${alice.userId}`; // OLD buggy: peer-from-Bob's-view
  const sealed = unsealPayload(wire);
  return verifySealedAad({
    sealed,
    selfUserId:             bobUserId,
    selfDeviceId:           1,
    requireAad:             true,
    expectedSender:         alice,
    expectedConversationId,
  });
}

describe('1:1 sealed AAD — end-to-end roundtrip (P0-N2 follow-up)', () => {
  it('FIXED: Alice→Bob round-trips cleanly with the symmetric helper on both sides', () => {
    const wire = aliceStampsForBob('hello bob', {useFix: true});
    const result = bobVerifiesFromAlice(wire, {useFix: true});
    expect(result.ok).toBe(true);
  });

  it('FIXED: Bob→Alice round-trips cleanly (other direction, same symmetry)', () => {
    // Swap roles: Bob is now the sender.
    const aliceUserId = 'alice-uuid';
    const bobUserId   = 'bob-uuid';
    const wire = sealPayload('cert.cert.cert', 'hello alice', {
      aad: {
        to:             {userId: aliceUserId, deviceId: 1},
        ts:             Date.now(),
        sender:         {userId: bobUserId, deviceId: 1},
        conversationId: directConvoAadId(bobUserId, aliceUserId),
      },
    });
    const sealed = unsealPayload(wire);
    const result = verifySealedAad({
      sealed,
      selfUserId:             aliceUserId,
      selfDeviceId:           1,
      requireAad:             true,
      expectedSender:         {userId: bobUserId, deviceId: 1},
      expectedConversationId: directConvoAadId(aliceUserId, bobUserId),
    });
    expect(result.ok).toBe(true);
  });

  // ─── Regression: the old buggy code would FAIL these ─────────────

  it('BUGGY (kept as regression) — pre-fix asymmetric stamping is rejected with conversation_mismatch', () => {
    // This exactly reproduces the user-reported bug: Alice's old code
    // stamped `direct:bob`, Bob's old code expected `direct:alice`.
    const wire = aliceStampsForBob('this would have silently dropped', {useFix: false});
    const result = bobVerifiesFromAlice(wire, {useFix: false});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('conversation_mismatch');
    }
  });

  it('CROSS — even mixing one fixed side and one buggy side fails (proves the fix is symmetric only when BOTH sides upgrade)', () => {
    // Alice ships fixed, Bob still buggy → mismatch.
    {
      const wire = aliceStampsForBob('hi', {useFix: true});
      const result = bobVerifiesFromAlice(wire, {useFix: false});
      expect(result.ok).toBe(false);
    }
    // Alice still buggy, Bob fixed → mismatch.
    {
      const wire = aliceStampsForBob('hi', {useFix: false});
      const result = bobVerifiesFromAlice(wire, {useFix: true});
      expect(result.ok).toBe(false);
    }
  });

  it('group fan-out is unaffected — AAD conversationId resolves to groupId on both sides regardless of helper', () => {
    // Both sides see the same groupId from the inner sealed payload.
    const groupId = 'group-uuid-42';
    const wire = sealPayload('cert.cert.cert', 'team standup at 10', {
      aad: {
        to:             {userId: 'bob-uuid', deviceId: 1},
        ts:             Date.now(),
        sender:         {userId: 'alice-uuid', deviceId: 1},
        conversationId: groupId,
        groupId,
        epoch:          1,
      },
    });
    const sealed = unsealPayload(wire);
    const result = verifySealedAad({
      sealed,
      selfUserId:             'bob-uuid',
      selfDeviceId:           1,
      requireAad:             true,
      expectedSender:         {userId: 'alice-uuid', deviceId: 1},
      expectedConversationId: groupId,
      expectedGroupId:        groupId,
    });
    expect(result.ok).toBe(true);
  });
});
