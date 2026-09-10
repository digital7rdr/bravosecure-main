/**
 * B-33 — group-call resume must keep the roster and resume the timer (not
 * reset to 0:00) after navigating call → Messenger → back.
 *
 * The receive/render orchestration (GroupCallScreen + the useGroupCall hook)
 * can't be unit-mounted (the autopop render test is infra-skipped), so — per
 * this codebase's convention — these tests pin the two exported pure helpers
 * that drive the fix:
 *   - Defect A: groupCallElapsedSeconds (timer anchored to registry joinedAtMs)
 *   - Defect B: seedRosterForRepublish (same-room rejoin keeps the roster)
 */
import {
  groupCallElapsedSeconds,
  seedRosterForRepublish,
  type ActiveGroupCallState,
} from '../runtime/groupCallRegistry';

describe('B-33 Defect A — groupCallElapsedSeconds (timer resumes from joinedAtMs)', () => {
  it('returns whole seconds since joinedAtMs (resumes, does not reset to 0)', () => {
    const now = 1_000_000_000;
    expect(groupCallElapsedSeconds(now - 65_000, now)).toBe(65); // 1:05, not 0:00
    expect(groupCallElapsedSeconds(now - 1_000, now)).toBe(1);
  });

  it('reads 0 when not yet joined (null/undefined anchor)', () => {
    expect(groupCallElapsedSeconds(null, 1_000_000)).toBe(0);
    expect(groupCallElapsedSeconds(undefined, 1_000_000)).toBe(0);
  });

  it('clamps a future anchor to 0 (never negative)', () => {
    const now = 1_000_000;
    expect(groupCallElapsedSeconds(now + 5_000, now)).toBe(0);
  });
});

describe('B-33 Defect B — seedRosterForRepublish (same-room rejoin keeps the roster)', () => {
  const tile = (tag: string) => ({tag}) as never;
  const prior = (roomId: string): ActiveGroupCallState =>
    ({
      roomId,
      remoteTiles: [tile('peerA'), tile('peerB')],
      identityByTag: {peerA: {displayName: 'A'}, peerB: {displayName: 'B'}},
    }) as unknown as ActiveGroupCallState;

  it('same room: keeps the prior tiles and merges self into the identity map', () => {
    const out = seedRosterForRepublish(prior('room-1'), 'room-1', 'self', 'Me');
    expect(out.remoteTiles).toHaveLength(2); // roster preserved, NOT blanked
    expect(out.identityByTag).toEqual({
      peerA: {displayName: 'A'},
      peerB: {displayName: 'B'},
      self: {displayName: 'Me'},
    });
  });

  it('different room: seeds empty tiles + self-only identity (no stale roster carried over)', () => {
    const out = seedRosterForRepublish(prior('room-OLD'), 'room-NEW', 'self', 'Me');
    expect(out.remoteTiles).toEqual([]);
    expect(out.identityByTag).toEqual({self: {displayName: 'Me'}});
  });

  it('no prior call: seeds empty tiles + self-only identity', () => {
    const out = seedRosterForRepublish(null, 'room-1', 'self', 'Me');
    expect(out.remoteTiles).toEqual([]);
    expect(out.identityByTag).toEqual({self: {displayName: 'Me'}});
  });
});
