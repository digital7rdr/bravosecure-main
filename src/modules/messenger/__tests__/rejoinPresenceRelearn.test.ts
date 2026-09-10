/**
 * B-345 — leave + get-re-added → names show as hex AGAIN (founder screenshot,
 * 2026-07-30 21:25, room 92BA50: the rejoined member saw 9F3048 / 842D08).
 *
 * B-344's reply guard remembers "already sent my identity to userId X" — but a
 * peer who LEAVES wipes their own map (`clearRoomIdentities` in leaveInternal)
 * while every veteran still remembered having told them. On rejoin the member
 * re-announced into silence: every veteran's guard skipped the reply, hex tags
 * forever.
 *
 * Rule: `forgetObservedTag` (fed by sfuDispatcher for EVERY participant.left —
 * both the full and the reduced restore-path frame handlers) must UN-LEARN the
 * leaver's userId from the room's presence sent-set, so their re-announcement
 * selects a fresh reply. The sent-set lives in the identity registry precisely
 * so this single seam covers all handler variants (a per-boot closure set
 * could not — that was the first, wrong, shape of this fix).
 */
import {
  recordGroupCallIdentity,
  recordObservedTag,
  forgetObservedTag,
  markPresenceSent,
  selectPresenceReplyTargets,
  clearAllRoomIdentities,
  getGroupCallIdentities,
} from '../webrtc/groupCallIdentityRegistry';
import * as fs from 'fs';
import * as path from 'path';

beforeEach(() => { clearAllRoomIdentities(); });

describe('B-345 — a leaver is un-learned so their rejoin gets a fresh reply', () => {
  test('the full rejoin story: sent → leave → re-announce → selected again', () => {
    // Veteran told u-redmi once (boot seed or an earlier reply).
    recordObservedTag('room1', 'tagA');
    recordGroupCallIdentity('room1', 'tagA', 'Ammu', 'u-redmi');
    markPresenceSent('room1', ['u-redmi']);
    // While remembered, no reply is selected for them.
    expect(selectPresenceReplyTargets(
      'room1', getGroupCallIdentities('room1'), 'u-me',
    )).toEqual([]);
    // They LEAVE — sfuDispatcher feeds this for every participant.left.
    forgetObservedTag('room1', 'tagA');
    // They REJOIN under a fresh tag and announce themselves.
    recordObservedTag('room1', 'tagB');
    recordGroupCallIdentity('room1', 'tagB', 'Ammu', 'u-redmi');
    // The un-learn means they are selected for a fresh reply — the bug was
    // this coming back [] forever.
    expect(selectPresenceReplyTargets(
      'room1', getGroupCallIdentities('room1'), 'u-me',
    )).toEqual(['u-redmi']);
  });

  test('forgetObservedTag un-learns BEFORE dropping the identity (needs the tag→userId mapping)', () => {
    recordObservedTag('r', 't1');
    recordGroupCallIdentity('r', 't1', 'A', 'u-x');
    markPresenceSent('r', ['u-x']);
    forgetObservedTag('r', 't1');
    // Identity gone AND the sent-set no longer blocks u-x.
    expect(getGroupCallIdentities('r')).toEqual({});
    recordObservedTag('r', 't2');
    recordGroupCallIdentity('r', 't2', 'A', 'u-x');
    expect(selectPresenceReplyTargets('r', getGroupCallIdentities('r'), 'me'))
      .toEqual(['u-x']);
  });

  test('sfuDispatcher feeds every participant.left through forgetObservedTag', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'webrtc', 'sfuDispatcher.ts'), 'utf8');
    expect(src).toMatch(/forgetObservedTag\(/);
  });
});
