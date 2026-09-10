import {
  recordGroupCallIdentity,
  getGroupCallIdentities,
  recordObservedTag,
  forgetObservedTag,
  clearRoomIdentities,
} from '@/modules/messenger/webrtc/groupCallIdentityRegistry';

/**
 * Audit P0-C3 — `recordGroupCallIdentity` rejects any presence claim
 * whose participantTag was never broadcast by the SFU as
 * `sfu.participant.joined` for the same room. A removed-member or
 * non-member peer who still holds a pairwise Signal session can ship
 * a sealed groupCallPresence envelope claiming any tag they like;
 * without this check the receiver's tile registry happily overwrites
 * a legitimate member's name with the attacker's "EVE".
 */

describe('groupCallIdentityRegistry — audit P0-C3', () => {
  const ROOM = 'room-aaa';
  const TAG_LEGIT = 'tag-legit';
  const TAG_FAKE  = 'tag-fake';

  beforeEach(() => {
    clearRoomIdentities(ROOM);
  });

  it('accepts a presence whose tag has been broadcast by SFU', () => {
    recordObservedTag(ROOM, TAG_LEGIT);
    recordGroupCallIdentity(ROOM, TAG_LEGIT, 'Alice', 'user-alice');
    expect(getGroupCallIdentities(ROOM)[TAG_LEGIT]).toEqual({
      displayName: 'Alice', userId: 'user-alice',
    });
  });

  it('rejects a presence whose tag was never broadcast for this room', () => {
    recordObservedTag(ROOM, TAG_LEGIT);
    // Eve sends a presence claiming TAG_FAKE — the SFU never broadcast
    // it here. The registry must drop it silently.
    recordGroupCallIdentity(ROOM, TAG_FAKE, 'EVE', 'user-eve');
    expect(getGroupCallIdentities(ROOM)[TAG_FAKE]).toBeUndefined();
  });

  it('admits early presence before any SFU broadcast (race grace)', () => {
    // First joiner's own presence envelope can race their own SFU
    // join broadcast. With no observed tags yet, the registry admits
    // — the alternative is a UX bug where the first joiner's tile
    // never gets labeled.
    recordGroupCallIdentity(ROOM, TAG_LEGIT, 'Alice', 'user-alice');
    expect(getGroupCallIdentities(ROOM)[TAG_LEGIT]).toEqual({
      displayName: 'Alice', userId: 'user-alice',
    });
  });

  it('forgets a tag on leave — subsequent presence is dropped', () => {
    recordObservedTag(ROOM, TAG_LEGIT);
    forgetObservedTag(ROOM, TAG_LEGIT);
    // Re-add another legit tag so the room is still "active" for the
    // strict check (size > 0).
    recordObservedTag(ROOM, 'tag-other');
    recordGroupCallIdentity(ROOM, TAG_LEGIT, 'IMPOSTER', 'user-eve');
    expect(getGroupCallIdentities(ROOM)[TAG_LEGIT]).toBeUndefined();
  });

  it('rooms are independent — tag from room A does not validate in room B', () => {
    const ROOM_B = 'room-bbb';
    recordObservedTag(ROOM, TAG_LEGIT);
    // Room B has its own broadcast set; without it the strict check
    // doesn't activate so the call admits (race grace).
    recordObservedTag(ROOM_B, 'tag-other');
    // Now claim TAG_LEGIT in room B where it was NEVER broadcast.
    recordGroupCallIdentity(ROOM_B, TAG_LEGIT, 'IMPOSTER', 'user-eve');
    expect(getGroupCallIdentities(ROOM_B)[TAG_LEGIT]).toBeUndefined();
    // And the legitimate room is unaffected by the rejection.
    recordGroupCallIdentity(ROOM, TAG_LEGIT, 'Alice', 'user-alice');
    expect(getGroupCallIdentities(ROOM)[TAG_LEGIT]).toBeDefined();
    clearRoomIdentities(ROOM_B);
  });
});

/**
 * Audit P0-C3 — wiring regression. The defense above was dead before
 * this fix because the runtime never fed the observed-tag set:
 * recordObservedTag / forgetObservedTag had ZERO production callers, so
 * observedTagsByRoom was always empty and the strict check never fired.
 * The runtime now calls recordSfuObservedTag(frame) for every SFU frame.
 * These tests pin that wiring — they drive the exported router with the
 * real `sfu.participant.*` frame shapes and assert the registry reacts.
 */
describe('recordSfuObservedTag — P0-C3 runtime wiring', () => {

  const {recordSfuObservedTag} = require('@/modules/messenger/webrtc/sfuDispatcher') as typeof import('@/modules/messenger/webrtc/sfuDispatcher');
  const ROOM = 'room-wire';
  const TAG_ALICE = 'tag-alice';
  const TAG_EVE   = 'tag-eve';

  beforeEach(() => {
    clearRoomIdentities(ROOM);
  });

  it('records the tag on sfu.participant.joined so a matching presence is accepted', () => {
    recordSfuObservedTag({event: 'sfu.participant.joined', data: {roomId: ROOM, participantTag: TAG_ALICE}});
    recordGroupCallIdentity(ROOM, TAG_ALICE, 'Alice', 'user-alice');
    expect(getGroupCallIdentities(ROOM)[TAG_ALICE]).toEqual({displayName: 'Alice', userId: 'user-alice'});
  });

  it('rejects a presence for a tag the SFU never broadcast once strict mode is active', () => {
    // Alice's join makes the room's observed set non-empty → strict mode on.
    recordSfuObservedTag({event: 'sfu.participant.joined', data: {roomId: ROOM, participantTag: TAG_ALICE}});
    // Eve never appeared in an sfu.participant.joined — her presence is dropped.
    recordGroupCallIdentity(ROOM, TAG_EVE, 'EVE', 'user-eve');
    expect(getGroupCallIdentities(ROOM)[TAG_EVE]).toBeUndefined();
  });

  it('forgets the tag on sfu.participant.left and a later presence claim is dropped', () => {
    recordSfuObservedTag({event: 'sfu.participant.joined', data: {roomId: ROOM, participantTag: TAG_ALICE}});
    recordSfuObservedTag({event: 'sfu.participant.joined', data: {roomId: ROOM, participantTag: 'tag-other'}});
    recordGroupCallIdentity(ROOM, TAG_ALICE, 'Alice', 'user-alice');
    expect(getGroupCallIdentities(ROOM)[TAG_ALICE]).toBeDefined();
    // Alice leaves — her tile clears and her tag is no longer admissible.
    recordSfuObservedTag({event: 'sfu.participant.left', data: {roomId: ROOM, participantTag: TAG_ALICE}});
    expect(getGroupCallIdentities(ROOM)[TAG_ALICE]).toBeUndefined();
    recordGroupCallIdentity(ROOM, TAG_ALICE, 'IMPOSTER', 'user-eve');
    expect(getGroupCallIdentities(ROOM)[TAG_ALICE]).toBeUndefined();
  });

  it('ignores malformed frames (missing roomId or participantTag)', () => {
    expect(() => recordSfuObservedTag({event: 'sfu.participant.joined', data: {roomId: ROOM}})).not.toThrow();
    expect(() => recordSfuObservedTag({event: 'sfu.participant.joined', data: {participantTag: TAG_ALICE}})).not.toThrow();
    expect(() => recordSfuObservedTag({event: 'sfu.participant.joined'})).not.toThrow();
    // No tag was recorded → strict mode still inactive → race-grace admit.
    recordGroupCallIdentity(ROOM, TAG_ALICE, 'Alice', 'user-alice');
    expect(getGroupCallIdentities(ROOM)[TAG_ALICE]).toBeDefined();
  });
});
