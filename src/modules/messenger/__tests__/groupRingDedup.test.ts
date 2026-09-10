import {shouldNavigateForRing} from '@/modules/messenger/runtime/groupCallRegistry';

/**
 * B-08 — duplicate `sfu.ring.incoming` frames must not navigate to the
 * ring screen while the user is already in/joining that room. The old
 * MainNavigator.onIncoming navigated on EVERY ring frame, so a duplicate
 * ring unmounted the in-progress GroupCallScreen and aborted the join
 * ('sfu.join started' → 'tearing down' ~132ms later). These tests pin the
 * pure suppression predicate that onIncoming now consults before
 * navigating.
 */

const ROOM = 'room-aaa';
const OTHER = 'room-bbb';

describe('shouldNavigateForRing — B-08 duplicate-ring suppression', () => {
  it('(a) suppresses when an active call is already in this room', () => {
    expect(shouldNavigateForRing(ROOM, ROOM, undefined, undefined)).toBe(false);
  });

  it('(b) suppresses when already on GroupCallScreen for this room', () => {
    expect(shouldNavigateForRing(ROOM, null, 'GroupCallScreen', ROOM)).toBe(false);
  });

  it('(b) suppresses when already on IncomingGroupCallScreen for this room', () => {
    expect(
      shouldNavigateForRing(ROOM, null, 'IncomingGroupCallScreen', ROOM),
    ).toBe(false);
  });

  it('(c) navigates for a genuinely different room even with an active call', () => {
    expect(shouldNavigateForRing(OTHER, ROOM, 'GroupCallScreen', ROOM)).toBe(true);
  });

  it('(c) navigates when on a call screen for a DIFFERENT room', () => {
    expect(shouldNavigateForRing(OTHER, null, 'GroupCallScreen', ROOM)).toBe(true);
  });

  it('(d) navigates when there is no active call and no matching route', () => {
    expect(shouldNavigateForRing(ROOM, null, undefined, undefined)).toBe(true);
    expect(shouldNavigateForRing(ROOM, null, 'ConversationScreen', undefined)).toBe(
      true,
    );
  });

  it('navigates when the call screen route has no roomId param', () => {
    expect(shouldNavigateForRing(ROOM, null, 'GroupCallScreen', undefined)).toBe(true);
  });
});
