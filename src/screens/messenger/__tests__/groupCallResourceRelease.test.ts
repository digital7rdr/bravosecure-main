/**
 * B-595 — "whenever a group call happens and we end the call, the call thing is
 * STILL in the notification tray."
 *
 * `GroupCallScreen`'s audio effect is one of only two places that release the
 * shared InCallManager session and the call foreground service (the other is
 * `endActiveGroupCall`). Its old guard asked "is the registry still pointing at
 * my room?" and treated yes as "someone still needs these" — but the End button
 * never marks the entry `ending`, so the answer was yes for the instance's OWN
 * dying call and the release was skipped.
 *
 * Both directions matter and both are pinned:
 *   release too timidly → the "Bravo Secure call · Hang up" notification is
 *     stranded with nothing left to dismiss it (the founder's report);
 *   release too eagerly  → the session and notification are torn off a call
 *     that is still running (B-243/B-256, the reason the guard exists).
 *
 * The screen cannot be imported by a node test — which is exactly how this
 * survived — so the decision lives in a pure module and is tested here.
 */
import {
  shouldReleaseSharedCallResources, type LiveGroupEntry,
} from '../groupCallResourceRelease';

const ROOM = 'room-1';
const entry = (over: Partial<LiveGroupEntry> = {}): LiveGroupEntry =>
  ({roomId: ROOM, ...over});

describe('release when nothing live needs these', () => {
  it('releases when the registry is empty', () => {
    expect(shouldReleaseSharedCallResources({
      entry: null, roomKey: ROOM, state: 'left',
    })).toBe(true);
  });

  it('releases when the only entry is mid-teardown (`ending`)', () => {
    // WI-1.6 — an `ending` entry owns nothing; it is already being torn down.
    expect(shouldReleaseSharedCallResources({
      entry: entry({ending: true}), roomKey: ROOM, state: 'joined',
    })).toBe(true);
  });

  it('THE BUG: releases when our OWN room is still registered but we have ended', () => {
    /**
     * The End button calls `call.leave()`, not `endActiveGroupCall`, so nothing
     * ever sets `ending: true`. The old test was `live.roomId === roomKey →
     * return`, which matched here and skipped the stop — stranding the
     * notification. Terminal state is the ONLY thing that distinguishes this
     * from a re-mounted screen for a call that is genuinely still up.
     */
    for (const state of ['left', 'failed', 'kicked', 'ended-by-host', 'unavailable'] as const) {
      expect(`${state}:${shouldReleaseSharedCallResources({
        entry: entry(), roomKey: ROOM, state,
      })}`).toBe(`${state}:true`);
    }
  });
});

describe('never release from under a call that is still live', () => {
  it('holds for a MINIMIZED call (keepAlive) — no screen is mounted to re-stop it', () => {
    expect(shouldReleaseSharedCallResources({
      entry: entry({keepAlive: true}), roomKey: ROOM, state: 'joined',
    })).toBe(false);
  });

  it('holds for a minimized call EVEN IF this instance is terminal', () => {
    // keepAlive is checked first, deliberately: a restored-then-ended instance
    // must not tear down the call the overlay is still showing.
    expect(shouldReleaseSharedCallResources({
      entry: entry({keepAlive: true}), roomKey: ROOM, state: 'left',
    })).toBe(false);
  });

  it('holds while our room is live and we are NOT terminal (a re-mounted screen)', () => {
    for (const state of ['joined', 'joining', 'creating', 'reconnecting'] as const) {
      expect(`${state}:${shouldReleaseSharedCallResources({
        entry: entry(), roomKey: ROOM, state,
      })}`).toBe(`${state}:false`);
    }
  });

  it('`reconnecting` is NOT terminal — an ICE restart is in flight', () => {
    // Releasing here would kill the audio session and the notification during
    // an ordinary mid-call network hiccup, and the call is expected back.
    expect(shouldReleaseSharedCallResources({
      entry: entry(), roomKey: ROOM, state: 'reconnecting',
    })).toBe(false);
  });

  it('holds when a NEWER call in ANOTHER room owns them', () => {
    /**
     * The latent half. The old form returned only for keepAlive or OUR room and
     * fell through — RELEASING — when a live entry named a different room, so an
     * old screen's unmount tore the session and notification off a newer call.
     * The rule is "is ANY group call live", not "is the registry pointing at me".
     */
    expect(shouldReleaseSharedCallResources({
      entry: entry({roomId: 'room-2'}), roomKey: ROOM, state: 'left',
    })).toBe(false);
  });

  it('a null roomId on the live entry is not our room', () => {
    expect(shouldReleaseSharedCallResources({
      entry: entry({roomId: null}), roomKey: ROOM, state: 'left',
    })).toBe(false);
  });
});
