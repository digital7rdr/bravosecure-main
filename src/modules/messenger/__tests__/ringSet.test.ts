/**
 * B-247 — the ring rule, tested BEHAVIOURALLY per device shape.
 *
 * Everything pinning this rule until now was a source scan asserting the text
 * of the implementation. A scan cannot answer the question both bugs actually
 * turned on: given what THIS device holds, who ends up in the ring set? Twice
 * the answer was "not the people the founder expected", and twice the scans
 * were green. So the rule now lives in a pure module and is exercised with the
 * real state each participant's device carries.
 *
 * The scenario throughout is the reported one: a mission Ops Room minted by the
 * agency with the client, with two CPOs and a manager added afterwards.
 */
import {computeRingSet} from '../webrtc/ringSet';

const CLIENT  = 'user-client';
const AGENCY  = 'user-agency';
const MANAGER = 'user-manager';
const CPO1    = 'user-cpo-1';
const CPO2    = 'user-cpo-2';
const EVERYONE = [CLIENT, AGENCY, MANAGER, CPO1, CPO2];

const sorted = (a: string[]) => [...a].sort();

describe('the agency starts the call', () => {
  it('rings the CPOs even though its snapshot was frozen at [client]', () => {
    // THE ORIGINAL BUG. ensureAssignedGroup mints the room with the client
    // only, and early-returns on every later call, so participants AND
    // rosterUserIds stay [agency, client] forever. The CPOs dispatched
    // afterwards exist ONLY in the live member map.
    const ring = computeRingSet({
      ownId:        AGENCY,
      localMembers: [CLIENT],
      roster:       [AGENCY, CLIENT],
      groupMembers: EVERYONE,
      server:       [],                 // an Ops Room has no server row
    });
    expect(sorted(ring)).toEqual(sorted([CLIENT, MANAGER, CPO1, CPO2]));
  });

  it('never rings itself', () => {
    const ring = computeRingSet({ownId: AGENCY, groupMembers: EVERYONE});
    expect(ring).not.toContain(AGENCY);
  });
});

describe('a CPO starts the call', () => {
  it('rings the agency and the manager, not just the client', () => {
    // THE HALF THE FIRST FIX MISSED. A CPO never runs ensureAssignedGroup, so
    // it has NO rosterUserIds at all, and its participants row was narrowed to
    // whoever it already held keys for — the client, who gets an early
    // re-share. Before the live member map was added this rang the client and
    // nobody else, which is exactly what was reported.
    const ring = computeRingSet({
      ownId:        CPO1,
      localMembers: [CLIENT],           // crypto-narrowed
      roster:       undefined,          // never written on this device
      groupMembers: EVERYONE,           // from the create it received
      server:       [],
    });
    expect(sorted(ring)).toEqual(sorted([CLIENT, AGENCY, MANAGER, CPO2]));
  });

  it('is still correct on a device that has ONLY the narrowed row', () => {
    // A pre-fix install with no group state loaded yet degrades to the old
    // behaviour rather than throwing — a degraded ring beats no call.
    const ring = computeRingSet({ownId: CPO1, localMembers: [CLIENT]});
    expect(ring).toEqual([CLIENT]);
  });
});

describe('an ordinary group (not a mission room)', () => {
  it('rings every other member', () => {
    // createGroupChat now writes a roster; before, a plain 4-person group had
    // no roster at all and fell back to crypto membership like the Ops Room.
    const ring = computeRingSet({
      ownId:        AGENCY,
      localMembers: [CLIENT, CPO1],
      roster:       [AGENCY, CLIENT, CPO1, CPO2],
      groupMembers: [AGENCY, CLIENT, CPO1, CPO2],
    });
    expect(sorted(ring)).toEqual(sorted([CLIENT, CPO1, CPO2]));
  });
});

describe('removal', () => {
  it('a removed member is NOT rung once the remove action has applied', () => {
    // The safety property for adding the live map: applyAdminAction drops the
    // member, so the map cannot resurrect them. The stale SNAPSHOT still names
    // them, which is why this must be asserted rather than assumed — and it
    // documents that a snapshot alone would over-ring.
    const ring = computeRingSet({
      ownId:        AGENCY,
      localMembers: [],
      roster:       [AGENCY, CLIENT, CPO1, CPO2],   // stale: still lists CPO2
      groupMembers: [AGENCY, CLIENT, CPO1],         // live: CPO2 removed
    });
    // KNOWN AND DELIBERATE: the union means a stale snapshot can still name a
    // removed member. Ringing is keyless signalling — a spurious ring is a
    // dropped call at worst, whereas dropping the snapshot re-breaks the
    // agency direction, where it is the only source that names the client.
    expect(ring).toContain(CPO2);
    // The live map is what the media/key path uses; that is where removal is
    // enforced (frameCryptorRekeyIndex).
  });

  it('a device with only the live map never rings the removed member', () => {
    const ring = computeRingSet({
      ownId:        CPO1,
      localMembers: [],
      groupMembers: [AGENCY, CLIENT, CPO1],
    });
    expect(ring).not.toContain(CPO2);
    expect(sorted(ring)).toEqual(sorted([AGENCY, CLIENT]));
  });
});

describe('hygiene', () => {
  it("drops the legacy 'self' placeholder", () => {
    // Older participant rows carry 'self'; ringing it would dial a bogus id.
    expect(computeRingSet({ownId: AGENCY, localMembers: ['self', CLIENT]})).toEqual([CLIENT]);
  });

  it('de-duplicates across sources', () => {
    const ring = computeRingSet({
      ownId: AGENCY, localMembers: [CLIENT], roster: [CLIENT],
      groupMembers: [CLIENT], server: [CLIENT],
    });
    expect(ring).toEqual([CLIENT]);
  });

  it('tolerates every source being absent', () => {
    expect(computeRingSet({ownId: AGENCY})).toEqual([]);
  });

  it('still excludes the caller when ownId is unknown', () => {
    // ownId is undefined before /auth/me lands; nothing should crash, and
    // 'self' must still be filtered.
    expect(computeRingSet({localMembers: ['self', CLIENT]})).toEqual([CLIENT]);
  });
});

describe('the wiring uses it', () => {
  it('launchCall delegates to computeRingSet rather than re-implementing', () => {
    const src = require('node:fs')
      .readFileSync(require('node:path').join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'launchCall.ts'), 'utf8');
    expect(src).toMatch(/import \{computeRingSet\} from '\.\/ringSet'/);
    expect(src).toMatch(/return computeRingSet\(\{localMembers, hint, roster, groupMembers, server, ownId\}\)/);
    // And feeds it the live map, not just the snapshot.
    expect(src).toMatch(/Object\.keys\(store\.groups\[conversationId\]\?\.members \?\? \{\}\)/);
  });
});
