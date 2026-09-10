/**
 * sqa.md bug register — this suite pins: B-42, B-298.
 *
 * B-42 — group `create` on the RECEIVE side: keyless bootstrap vs keyed downgrade.
 *
 * sqa.md names `groupCreateEpochBootstrap.test.ts` as B-42's regression test, but
 * the file never existed — so the behaviour it was supposed to pin has been
 * unpinned since 2026-06-27. This file closes that gap.
 *
 * The bug: a joiner that already held a KEYLESS state for a group at an equal or
 * higher epoch (it had applied an `add`, or a key-request stub, but never received
 * the key) dropped the owner's re-broadcast `create` as "stale/replayed". The
 * joiner stayed permanently keyless — group messages never decrypted AND group
 * calls died at the 25s key-wait ("I call them, it rings, they pick up, they never
 * join"). The fix was to enforce the epoch guard only when we hold a master key
 * worth protecting: with no local key there is no keyed state to roll back, and
 * the create is already owner-signature-verified, so accepting it is a BOOTSTRAP,
 * not a downgrade.
 *
 * ⚠️ WHAT THIS FILE FOUND — the reducer has NO epoch guard on `create` at all.
 *
 * `applyAdminAction`'s create branch (groupClient.ts) runs `verifyGroupIdDerivation`
 * and then returns `{...action.state}` unconditionally. So the keyless bootstrap
 * B-42 needed does work (cases 1-2 below), but a `create` ALSO overwrites a state
 * we already hold a master key for, at ANY epoch (case 3). That contradicts
 * groupClient.ts's own doc comment above `makeAssignedGroup`, which still cites
 * "the epoch-monotonicity guard in `applyAdminAction` (a replayed old `create`
 * for a group we already hold is rejected)" as part of the security argument for
 * omitting the salt.
 *
 * Case 3 is therefore written DOCUMENTS-style: it pins the CURRENT behaviour so
 * the reducer cannot drift further unnoticed. It is NOT an endorsement.
 *
 *   → If the guard is intended to live in the reducer, case 3's assertion must
 *     become `expect(next.masterKeyB64).toBe(keyed.masterKeyB64)` (the replayed
 *     create is rejected) and the `create` branch must gain
 *     `if (state?.masterKeyB64 && action.state.epoch <= state.epoch) return state;`.
 *   → If the guard is intended to live in the CALLER (productionRuntime's
 *     group-create receive path), the `makeAssignedGroup` doc comment must be
 *     corrected to say so, and this file should gain a caller-side scan.
 *
 * Group master-key distribution and epoch handling are a CLAUDE.md stop-condition:
 * do not change the reducer to make case 3 flip without architecture sign-off.
 */

import {applyAdminAction, makeNewGroup} from '@bravo/messenger-core';
import type {GroupState} from '@bravo/messenger-core';

const OWNER = 'owner-uuid';
const JOINER = 'joiner-uuid';

/** The owner's real, keyed state — what a `create` envelope carries. */
function ownerState(): GroupState {
  return makeNewGroup({
    name: 'SQA - Fahim',
    owner: OWNER,
    ownerDeviceId: 1,
    members: [{userId: JOINER, deviceId: 1}],
  });
}

/**
 * The joiner's poisoned pre-fix state: correct membership and a NON-ZERO epoch
 * (it applied an `add` before the key ever arrived) but no master key at all.
 * This is the exact shape that made the re-broadcast create look "stale".
 */
function keylessJoinerState(from: GroupState, epoch: number): GroupState {
  const {masterKeyB64: _drop, ...rest} = from;
  return {...rest, masterKeyB64: '', epoch};
}

describe('B-42 — an owner-signed `create` bootstraps a KEYLESS joiner', () => {
  it('installs the master key when the joiner holds no key at an EQUAL epoch', () => {
    const owner = ownerState();
    const stale = keylessJoinerState(owner, owner.epoch);

    const next = applyAdminAction(
      stale,
      {type: 'create', state: owner, creatorSignature: 'sig'} as never,
      OWNER,
    );

    // The whole point of B-42: the joiner ends up with the owner's key.
    expect(next.masterKeyB64).toBe(owner.masterKeyB64);
    expect(next.masterKeyB64).not.toBe('');
  });

  it('installs the master key when the joiner holds no key at a HIGHER epoch', () => {
    // The reported case — an `add` had already advanced the joiner past the
    // owner's create epoch, so a monotonicity-only guard dropped the key
    // forever and the joiner could never decrypt or join a call.
    const owner = ownerState();
    const stale = keylessJoinerState(owner, owner.epoch + 3);

    const next = applyAdminAction(
      stale,
      {type: 'create', state: owner, creatorSignature: 'sig'} as never,
      OWNER,
    );

    expect(next.masterKeyB64).toBe(owner.masterKeyB64);
  });

  it('refuses a create whose groupId does not derive from its own salt+members', () => {
    // P1-N13 — the bootstrap relaxation must NOT have opened the id-forgery
    // hole. A create claiming an attacker-chosen groupId is still dropped.
    const owner = ownerState();
    const stale = keylessJoinerState(owner, owner.epoch);
    const forged = {...owner, groupId: 'attacker-chosen-id'};

    const next = applyAdminAction(
      stale,
      {type: 'create', state: forged, creatorSignature: 'sig'} as never,
      OWNER,
    );

    // Prior state returned unchanged — still keyless, still the real id.
    expect(next.groupId).toBe(stale.groupId);
    expect(next.masterKeyB64).toBe('');
  });

  it('DOCUMENTS B-42: a replayed create OVERWRITES a state we already hold a key for', () => {
    // See the file header. This is the current reducer behaviour, not the
    // desired one. `makeAssignedGroup`'s doc comment claims the opposite.
    const keyed = ownerState();
    const replayed = {...keyed, masterKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', epoch: 0};

    const next = applyAdminAction(
      {...keyed, epoch: 5},
      {type: 'create', state: replayed, creatorSignature: 'sig'} as never,
      OWNER,
    );

    // WHAT IT MUST BECOME (if the guard belongs in the reducer):
    //   expect(next.masterKeyB64).toBe(keyed.masterKeyB64);
    //   expect(next.epoch).toBe(5);
    expect(next.masterKeyB64).toBe(replayed.masterKeyB64);
    expect(next.epoch).toBe(0);
  });
});
