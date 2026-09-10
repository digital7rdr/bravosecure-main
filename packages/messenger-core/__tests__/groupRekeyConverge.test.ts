/**
 * AUDIT-2026-08-13 #1 (P0) — rekey keys carry FRESH ENTROPY the removed
 * member does not hold. FLIPS the former P0-G3 pins in this file.
 *
 * P0-G3 made `planRemoveAndRekey` deterministic — KDF(prevKey ‖ removed ‖
 * postEpoch) — so two admins racing the same remove converged on one key.
 * The audit's finding: the REMOVED member holds prevKey and can see the
 * public inputs, so they could compute the new key and chain forward
 * through every later deterministic rekey — rotation was
 * cryptographically ineffective against exactly the party it names
 * (group-call media keys, sealed archives, photo keys all derive from the
 * master key). Architecture contract ("forward secrecy at epoch
 * boundaries") requires the rotation to actually lock the leaver out.
 *
 * The fork P0-G3 solved is now held by: (1) the leave-auto-rekey's single
 * DESIGNATED sender; (2) the epoch guard no-oping the losing pair for
 * same-order receivers; (3) the key-request/reshare + no_key-stash
 * self-heal for a genuine cross-order fork — machinery that did not exist
 * when P0-G3 chose determinism. The cross-order key divergence is pinned
 * DOCUMENTED below, not hidden.
 */

import {
  makeNewGroup,
  planRemoveAndRekey,
  planAddAndRekey,
  planLeaveAndRekey,
  applyAdminAction,
  deriveRekeyMasterKey,
} from '@bravo/messenger-core';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function freshGroup() {
  return makeNewGroup({
    name: 'difc-ops',
    owner: 'alice',
    ownerDeviceId: 1,
    members: [
      {userId: 'bob', deviceId: 1},
      {userId: 'carol', deviceId: 1},
      {userId: 'dave', deviceId: 1},
    ],
  });
}

describe('AUDIT #1 — the removed member can no longer predict the rekey key', () => {
  it('THE ATTACK, pinned: derive(prevKey, removed, postEpoch) does NOT predict any planner output', () => {
    // This is the audit's evidence line executed as the adversary: the
    // removed member holds state.masterKeyB64 and the public inputs.
    // Under P0-G3 this equalled the planner output — RED under a revert.
    const state = freshGroup();
    const predicted = deriveRekeyMasterKey({
      prevMasterKeyB64: state.masterKeyB64,
      removedMemberIds: ['dave'],
      postEpoch: state.epoch + 1,
    });
    expect(planRemoveAndRekey(state, 'dave').newMasterKeyB64).not.toBe(predicted);
    expect(planLeaveAndRekey(state, 'dave').newMasterKeyB64).not.toBe(predicted);
    const addPredicted = deriveRekeyMasterKey({
      prevMasterKeyB64: state.masterKeyB64,
      removedMemberIds: ['erin'],
      postEpoch: state.epoch + 1,
    });
    expect(planAddAndRekey(state, {userId: 'erin', deviceId: 1}).newMasterKeyB64).not.toBe(addPredicted);
  });

  it('two plans for the SAME change carry DIFFERENT keys (fresh entropy each)', () => {
    const state = freshGroup();
    const a = planRemoveAndRekey(state, 'dave');
    const b = planRemoveAndRekey(state, 'dave');
    expect(a.newMasterKeyB64).not.toBe(b.newMasterKeyB64);
    const c = planAddAndRekey(state, {userId: 'erin', deviceId: 1});
    const d = planAddAndRekey(state, {userId: 'erin', deviceId: 1});
    expect(c.newMasterKeyB64).not.toBe(d.newMasterKeyB64);
    const e = planLeaveAndRekey(state, 'dave');
    const f = planLeaveAndRekey(state, 'dave');
    expect(e.newMasterKeyB64).not.toBe(f.newMasterKeyB64);
  });

  it('the new key is never the previous key, and is well-formed base64', () => {
    const state = freshGroup();
    for (const key of [
      planRemoveAndRekey(state, 'dave').newMasterKeyB64,
      planLeaveAndRekey(state, 'dave').newMasterKeyB64,
      planAddAndRekey(state, {userId: 'erin', deviceId: 1}).newMasterKeyB64,
    ]) {
      expect(key).not.toBe(state.masterKeyB64);
      expect(key).toMatch(/^[A-Za-z0-9+/=]+$/);
    }
  });

  it('receivers ADOPT the carried key — the rekey action is self-contained on the wire', () => {
    // Wire-compatibility invariant: applyAdminAction never re-derives, so
    // fresh-random keys need NO receiver change and old clients interop.
    const state = freshGroup();
    const plan = planRemoveAndRekey(state, 'dave');
    let s = applyAdminAction(state, plan.remove, 'alice');
    s = applyAdminAction(s, plan.rekey, 'alice');
    expect(s.masterKeyB64).toBe(plan.newMasterKeyB64);
    expect(s.epoch).toBe(state.epoch + 2);
    expect(s.members.dave).toBeUndefined();
  });

  it('same-order receivers still converge: the losing pair no-ops at the epoch guard', () => {
    const state = freshGroup();
    const promote: typeof state = {
      ...state,
      members: {
        ...state.members,
        bob: {...state.members.bob, admin: true},
        carol: {...state.members.carol, admin: true},
      },
    };
    const planB = planRemoveAndRekey(promote, 'dave');
    const planC = planRemoveAndRekey(promote, 'dave');
    let s1 = applyAdminAction(promote, planB.remove, 'bob');
    s1 = applyAdminAction(s1, planB.rekey, 'bob');
    const afterWinner = s1.masterKeyB64;
    s1 = applyAdminAction(s1, planC.remove, 'carol'); // stale — no-op
    s1 = applyAdminAction(s1, planC.rekey, 'carol');  // stale — no-op
    expect(s1.masterKeyB64).toBe(afterWinner);
    expect(s1.masterKeyB64).toBe(planB.newMasterKeyB64);
  });

  it('DOCUMENTED RESIDUAL (audit #1): cross-order receivers diverge on the KEY (membership+epoch converge) — healed by key-request/reshare', () => {
    // This is the P0-G3 fork, deliberately re-admitted in its narrow form:
    // it needs two admins racing the SAME remove AND receivers applying
    // the pairs in OPPOSITE orders. Membership and epoch still converge;
    // only masterKeyB64 differs, which the no_key/divergence self-heal
    // lanes resolve (stash → key-request → reshare → drain). If this
    // assertion ever starts FAILING because the keys became equal, the
    // deterministic derivation is back — that is a P0 regression.
    const state = freshGroup();
    const promote: typeof state = {
      ...state,
      members: {
        ...state.members,
        bob: {...state.members.bob, admin: true},
        carol: {...state.members.carol, admin: true},
      },
    };
    const planB = planRemoveAndRekey(promote, 'dave');
    const planC = planRemoveAndRekey(promote, 'dave');
    let s1 = applyAdminAction(promote, planB.remove, 'bob');
    s1 = applyAdminAction(s1, planB.rekey, 'bob');
    let s2 = applyAdminAction(promote, planC.remove, 'carol');
    s2 = applyAdminAction(s2, planC.rekey, 'carol');
    expect(Object.keys(s1.members).sort()).toEqual(Object.keys(s2.members).sort());
    expect(s1.epoch).toBe(s2.epoch);
    expect(s1.masterKeyB64).not.toBe(s2.masterKeyB64); // the documented divergence
  });

  it('DOCUMENTED RESIDUAL (critic): leave-races-remove on the SAME member also diverges now (was convergent under P0-G3)', () => {
    // X taps Leave while an admin taps Remove-X: under the deterministic
    // derivation both computed the SAME key (same prevKey, same
    // removedIds=[X], same postEpoch) — no fork. With fresh randomness
    // they diverge, and the leave ALSO arms the designated-admin
    // auto-rekey, so up to THREE rekey senders can be in flight over one
    // departure. Same heal path as the two-admin race; pinned so the
    // residual's documented scope cannot silently narrow.
    const state = freshGroup();
    const promote: typeof state = {
      ...state,
      members: {...state.members, bob: {...state.members.bob, admin: true}},
    };
    const leavePlan  = planLeaveAndRekey(promote, 'dave');   // dave leaves
    const removePlan = planRemoveAndRekey(promote, 'dave');  // bob removes dave
    expect(leavePlan.rekey.newMasterKeyB64).not.toBe(removePlan.rekey.newMasterKeyB64);
    // Both rekeys target the same post-departure epoch — the same
    // first-wins/epoch-guard mechanics as the two-admin race apply.
    expect(leavePlan.rekey.atEpoch).toBe(removePlan.rekey.atEpoch);
  });

  it('no planner (nor the runtime auto-rekey) calls deriveRekeyMasterKey any more (source scan)', () => {
    // The deprecated fn stays exported ONLY for the attack pin above; a
    // production caller returning is the P0 coming back.
    const core = readFileSync(
      join(__dirname, '..', 'src', 'groups', 'groupClient.ts'), 'utf8');
    const lineStartCalls = core.split(/\r?\n/)
      .filter(l => /^\s*const newMasterKeyB64 = deriveRekeyMasterKey\(/.test(l)).length;
    expect(lineStartCalls).toBe(0);
    const freshCalls = core.split(/\r?\n/)
      .filter(l => l.trim().startsWith('const newMasterKeyB64 = genFreshGroupMasterKey();')).length;
    expect(freshCalls).toBe(3); // remove, leave, add planners
    // Function-SCOPED, not file-wide (edge F8: "the token exists somewhere
    // in a 9,000-line file" is the CLAUDE.md anti-pattern), and the
    // absence check is on the bare SYMBOL so a renamed/re-wrapped call
    // cannot slip back in under a different shape.
    const runtime = readFileSync(
      join(__dirname, '..', '..', '..', 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8');
    const fnStart = runtime.indexOf('const rekeyAfterLeaveImpl = async (');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = runtime.indexOf('const issuedCert = await certCache.getIssued();', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const mintRegion = runtime.slice(fnStart, fnEnd);
    expect(mintRegion.split(/\r?\n/).some(l => l.trim().startsWith('const newMasterKeyB64 = genFreshGroupMasterKey();'))).toBe(true);
    expect(mintRegion).not.toContain('deriveRekeyMasterKey');
  });
});

// P1-G4 voluntary leave + rekey — unchanged semantics (the leaver removes
// themselves; only a REMAINING admin can rotate).
describe('P1-G4 — leave + rekey', () => {
  function group() {
    return makeNewGroup({
      name: 'difc-ops',
      owner: 'alice',
      ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}, {userId: 'carol', deviceId: 1}],
    });
  }

  it('remaining members apply the leave: sender removed, epoch bumped', () => {
    const state = group();
    const plan = planLeaveAndRekey(state, 'bob');
    const s = applyAdminAction(state, plan.leave, 'bob');
    expect(s.members.bob).toBeUndefined();
    expect(s.members.alice).toBeDefined();
    expect(s.members.carol).toBeDefined();
    expect(s.epoch).toBe(state.epoch + 1);
  });

  it('post-leave rekey signed by the leaver is a no-op (non-member rejected)', () => {
    const state = group();
    const plan = planLeaveAndRekey(state, 'bob');
    const afterLeave = applyAdminAction(state, plan.leave, 'bob');
    const afterRekey = applyAdminAction(afterLeave, plan.rekey, 'bob');
    expect(afterRekey.masterKeyB64).toBe(afterLeave.masterKeyB64);
  });
});
