import {decideGroupCreate, type CreateGateInput} from '@/modules/messenger/runtime/inboundGroupCreateGate';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * B-127 (group hijack) + B-41 (keyless bootstrap) + B-129 (mirror drift).
 *
 * Renamed from groupCreateEpochBootstrap.test.ts. That file hand-mirrored the
 * runtime's inline guard, drifted from it, and stayed green for weeks asserting
 * the OPPOSITE of the real same-epoch behaviour. The decision now lives in an
 * importable pure module, so these assertions exercise the REAL code. There must
 * be exactly one home for this — do not add a second mirror beside it.
 *
 * The negative cases (legitimate flows still accepted) are the message-loss and
 * call-breakage firewall: a dropped create is UNRECOVERABLE. Creates are never
 * stashed, and the owner's self-heal reshare is a fixed point that re-sends the
 * identical state, so one false positive is permanent silent key loss for that
 * member in that group.
 */

const ALICE = 'user-alice';
const BOB = 'user-bob';
const EVE = 'user-eve';
const GID = 'adhoc0c0ffee0c0ffee0c0ffee0c0ffee';
const UUID = '8b1d4e2a-11ef-4c3b-9a7d-0f2e5c1a9b44';

function input(over: Partial<CreateGateInput> = {}): CreateGateInput {
  return {
    wireGroupId: over.state?.groupId ?? GID,
    state: {groupId: GID, owner: ALICE, epoch: 0, masterKeyB64: 'K1'},
    signatureOk: true,
    signatureMissing: false,
    keySuperseded: false,
    ...over,
  };
}

describe('B-127 — attacks are rejected', () => {
  const keyed = {owner: ALICE, epoch: 4, masterKeyB64: 'K1'};

  it('T2: a different owner overwriting a keyed slot at a high epoch is dropped', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: EVE, epoch: 999, masterKeyB64: 'KE'},
      existing: keyed,
    }))).toEqual({action: 'drop', reason: 'owner-changed'});
  });

  it('T3: owner-continuity runs BEFORE the same-epoch heal, so the heal is not a bypass', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: EVE, epoch: 4, masterKeyB64: 'KE'},
      existing: keyed,
    }))).toEqual({action: 'drop', reason: 'owner-changed'});
  });

  it('T4: an attacker naming the group "Call" on the WIRE cannot opt out of the gate', () => {
    // The single most important test here. `name` is not covered by
    // canonicalCreateBytes, so trusting the wire name would reduce the entire
    // gate to one word of attacker-chosen text.
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: EVE, name: 'Call', epoch: 999, masterKeyB64: 'KE'},
      existing: keyed,
    }))).toEqual({action: 'drop', reason: 'owner-changed'});
  });

  it('T5: an unsigned create may not overwrite live key material', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 5, masterKeyB64: 'K2'},
      existing: keyed,
      signatureOk: false,
      signatureMissing: true,
    }))).toEqual({action: 'drop', reason: 'unsigned-over-live-key'});
  });

  it('T6: a stale/replayed create is dropped', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 2, masterKeyB64: 'K2'},
      existing: keyed,
    }))).toEqual({action: 'drop', reason: 'stale-epoch'});
  });

  it('T7: a same-epoch create re-installing a superseded key is dropped (rollback)', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 4, masterKeyB64: 'KOLD'},
      existing: keyed,
      keySuperseded: true,
    }))).toEqual({action: 'drop', reason: 'superseded-key'});
  });

  it('T8: a same-epoch fork that is not owner-signed is dropped', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 4, masterKeyB64: 'K2'},
      existing: keyed,
      signatureOk: false,
      signatureMissing: false,
    }))).toEqual({action: 'drop', reason: 'unsigned-fork'});
  });
});

describe('B-127 — every legitimate flow is still accepted', () => {
  it('T9 (F1 first create): no local state', () => {
    expect(decideGroupCreate(input({existing: undefined}))).toEqual({action: 'accept'});
  });

  it('T10 (F2 assigned Ops Room): server UUID, no salt, no local state', () => {
    // Also pins that the gate never consults saltB64 / id derivation.
    expect(decideGroupCreate(input({
      wireGroupId: UUID,
      state: {groupId: UUID, owner: ALICE, epoch: 0, masterKeyB64: 'K1'},
      existing: undefined,
    }))).toEqual({action: 'accept'});
  });

  it('T11 (F3/B-41 keyless bootstrap): older create onto a keyless placeholder at a HIGHER epoch', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 3, masterKeyB64: 'K1'},
      existing: {owner: ALICE, epoch: 7, masterKeyB64: ''},
    }))).toEqual({action: 'accept', bootstrap: true});
  });

  it('T12 (F4 G-05 relayed create): the gate takes no sender identity at all', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 2, masterKeyB64: 'K2'},
      existing: {owner: ALICE, epoch: 1, masterKeyB64: 'K1'},
    }))).toEqual({action: 'accept'});
  });

  it('T13 (F5 add-member re-create after rekey): normal epoch advance', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 5, masterKeyB64: 'K2'},
      existing: {owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
    }))).toEqual({action: 'accept'});
  });

  it('T14 (F6 ad-hoc call key mint): fresh derived id, no local state', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, name: 'Call', epoch: 0, masterKeyB64: 'KC'},
      existing: undefined,
    }))).toEqual({action: 'accept'});
  });

  it('T15 (F7 call resync over a `direct:` alias, owner flips): accepted', () => {
    // Re-escalating a 1:1 from the OTHER side flips the owner on an alias slot.
    // Dropping here = "Call failed" at the joiner's 25s key gate.
    expect(decideGroupCreate(input({
      wireGroupId: `direct:${BOB}`,
      state: {groupId: `direct:${BOB}`, owner: ALICE, name: 'Call', epoch: 0, masterKeyB64: 'KA'},
      existing: {owner: BOB, name: 'Call', epoch: 0, masterKeyB64: 'KB'},
      // Same epoch, different key => this IS a G-04 heal, so the outgoing key
      // is handed back for the superseded ledger. Identical to the behaviour of
      // the inline code this replaced.
    }))).toEqual({action: 'accept', supersedeKeyB64: 'KB'});
  });

  it('T16 (F7 over a server-UUID 1:1 slot): carried by localConversationType', () => {
    expect(decideGroupCreate(input({
      wireGroupId: UUID,
      state: {groupId: UUID, owner: ALICE, name: 'Call', epoch: 0, masterKeyB64: 'KA'},
      existing: {owner: BOB, name: 'Call', epoch: 0, masterKeyB64: 'KB'},
      localConversationType: 'direct',
    }))).toEqual({action: 'accept', supersedeKeyB64: 'KB'});
  });

  it('T17 (F7 on a COLD contact): carried by existing.name === "Call" ALONE', () => {
    // No conversation row has synced, and the id is a UUID — so neither the
    // shape signal nor the row-type signal applies. This is why the local-name
    // exemption is load-bearing rather than defence in depth.
    expect(decideGroupCreate(input({
      wireGroupId: UUID,
      state: {groupId: UUID, owner: ALICE, name: 'Call', epoch: 0, masterKeyB64: 'KA'},
      existing: {owner: BOB, name: 'Call', epoch: 0, masterKeyB64: 'KB'},
      localConversationType: undefined,
    }))).toEqual({action: 'accept', supersedeKeyB64: 'KB'});
  });

  it('T18: an identical-key same-epoch create still repairs a lost inbox row', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
      existing: {owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
    }))).toEqual({action: 'repair-row'});
  });

  it('T19 (G-04 heal): same epoch, different key, same owner, signed, not superseded', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 4, masterKeyB64: 'K2'},
      existing: {owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
    }))).toEqual({action: 'accept', supersedeKeyB64: 'K1'});
  });

  // B-365 — same-epoch owner-signed ROSTER heal (Ariful↔Ae2 drift,
  // 2026-08-01). Same key + same epoch used to be an unconditional
  // repair-row, silently discarding a create whose member list had GROWN.
  it('T20 (B-365): signed same-epoch same-key SUPERSET roster is adopted', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
      existing: {owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
      stateMembers: ['a', 'b', 'c'],
      existingMembers: ['a', 'b'],
    }))).toEqual({action: 'accept', rosterHeal: true});
  });

  it('T21 (B-365): an UNSIGNED same-epoch superset is DROPPED by the unsigned-over-live-key arm before the heal is even consulted', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
      existing: {owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
      signatureOk: false, signatureMissing: true,
      stateMembers: ['a', 'b', 'c'],
      existingMembers: ['a', 'b'],
    }))).toEqual({action: 'drop', reason: 'unsigned-over-live-key'});
  });

  it('T22 (B-365): a SUBSET or disjoint roster never heals — a same-epoch removal is a replay smell, not an add', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
      existing: {owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
      stateMembers: ['a'],
      existingMembers: ['a', 'b'],
    }))).toEqual({action: 'repair-row'});
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
      existing: {owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
      stateMembers: ['a', 'c'],
      existingMembers: ['a', 'b'],
    }))).toEqual({action: 'repair-row'});
  });

  it('T23 (B-365): identical member sets stay the plain idempotent duplicate', () => {
    expect(decideGroupCreate(input({
      state: {groupId: GID, owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
      existing: {owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
      stateMembers: ['a', 'b'],
      existingMembers: ['a', 'b'],
    }))).toEqual({action: 'repair-row'});
  });
});

describe('B-127 — a wire/payload id split is telemetry, never a drop', () => {
  it('T1: the decision is computed against the SIGNED id and only warns on mismatch', () => {
    // This is the hijack vector: the old code resolved local state by the WIRE
    // id while installing under the SIGNED id, so a fresh wire id skipped every
    // guard. The decision must follow the signed id.
    const d = decideGroupCreate(input({
      wireGroupId: 'some-unused-id',
      state: {groupId: GID, owner: EVE, epoch: 999, masterKeyB64: 'KE'},
      existing: {owner: ALICE, epoch: 4, masterKeyB64: 'K1'},
    }));
    expect(d.action).toBe('drop');
    expect(d.reason).toBe('owner-changed');
    expect(d.warn).toBe('wire-id-mismatch');
  });

  it('a mismatch on an otherwise-fine create warns but still accepts', () => {
    const d = decideGroupCreate(input({wireGroupId: 'other', existing: undefined}));
    expect(d.action).toBe('accept');
    expect(d.warn).toBe('wire-id-mismatch');
  });
});

/**
 * B-129 drift guard, re-targeted. The old version pinned the SHAPE of an inline
 * guard; now that the decision is extracted, it pins that productionRuntime
 * still DELEGATES and has not re-inlined a copy. Extraction kills today's drift;
 * this is what stops it coming back.
 */
describe('B-129 — the create lane delegates and has not re-inlined the guard', () => {
  // S5 — the create branch moved from productionRuntime.ts into the extracted
  // ADMIN lane (runtime/applyGroupAdmin.ts). Follow the code: this guard is
  // about whether the CREATE LANE re-inlines the epoch rule, not about which
  // file that lane currently lives in. Pointing it at the old file made the
  // whole suite fail to RUN — and a suite that fails to run reports ZERO failed
  // tests, which is exactly how it nearly passed as the B-126 flake.
  const SRC = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'applyGroupAdmin.ts'),
    'utf8',
  );
  const slice = (() => {
    const a = SRC.indexOf("action.type === 'create'");
    const b = SRC.indexOf("kind: 'drain-group'", a);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return SRC.slice(a, b);
  })();

  it('S1: the create branch calls decideGroupCreate', () => {
    expect(slice).toMatch(/decideGroupCreate\(/);
  });

  it('S2: the epoch comparison MOVED — it was not copied back inline', () => {
    expect(slice).not.toMatch(/action\.state\.epoch\s*[<>=]/);
  });

  it('S3: nothing installs group state before the gate runs', () => {
    const gate = slice.indexOf('decideGroupCreate(');
    const install = slice.indexOf('setGroupState(');
    expect(gate).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(gate);
  });

  it('S4: every new drop arm is traceable, never a bare return', () => {
    expect(slice).toMatch(/noteDestroyedEnvelope\(/);
  });

  it('S5: the create branch resolves local state by the SIGNED id, not the wire id', () => {
    // If someone "simplifies" this back to one lookup, the B-127 hijack returns.
    expect(slice).toMatch(/store\.groups\[action\.state\.groupId\]/);
  });
});
