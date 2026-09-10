/**
 * B-344 — a mid-call-ADDED member sees other participants' names as hex tags
 * ("encrypted") forever (founder, 2026-07-30 20:19, room ad686237).
 *
 * Presence was one-shot: each participant broadcast their identity ONCE, at
 * their own boot, to the member list AS IT WAS THEN. A member added mid-call
 * (the kick→re-add flow makes this routine) was in nobody's list — no
 * envelope ever targeted them, so labelFor() fell back to
 * tag.slice(0,6).toUpperCase() permanently.
 *
 * Fix shape:
 *  1. Reciprocal presence: when the identity snapshot gains a NEW userId
 *     (the newcomer's own announcement — their roster-derived recipient list
 *     does include the existing members), each in-call participant replies
 *     ONCE with their own identity, targeted at that userId. The reply-target
 *     selection is a pure helper so this project can test it.
 *  2. The join ack's existingProducers tags feed the P0-C3 observed-tag set
 *     (recordObservedTag) so those replies pass strict mode on the newcomer.
 *     This feeds the gate MORE SFU-authoritative data; the gate's rule is
 *     unchanged.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  selectPresenceReplyTargets,
  markPresenceSent,
  clearAllRoomIdentities,
} from '../webrtc/groupCallIdentityRegistry';

function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}
const HOOK = strip(fs.readFileSync(
  path.join(__dirname, '..', 'webrtc', 'useGroupCall.ts'), 'utf8'));

describe('B-344 — selectPresenceReplyTargets', () => {
  beforeEach(() => { clearAllRoomIdentities(); });
  const snap = (m: Record<string, {displayName: string; userId?: string}>) => m;

  test('a new userId in the snapshot is a reply target', () => {
    markPresenceSent('r1', ['u-old']);
    expect(selectPresenceReplyTargets(
      'r1', snap({t1: {displayName: 'Ari2', userId: 'u-new'}}), 'u-me',
    )).toEqual(['u-new']);
  });

  test('already-sent userIds are not re-targeted (no reply storms)', () => {
    markPresenceSent('r1', ['u-new']);
    expect(selectPresenceReplyTargets(
      'r1', snap({t1: {displayName: 'Ari2', userId: 'u-new'}}), 'u-me',
    )).toEqual([]);
  });

  test('self and tag-only entries are never targeted', () => {
    expect(selectPresenceReplyTargets(
      'r1', snap({t1: {displayName: 'Me', userId: 'u-me'}, t2: {displayName: 'NoId'}}), 'u-me',
    )).toEqual([]);
  });

  test('duplicate tags for one userId produce one target', () => {
    expect(selectPresenceReplyTargets(
      'r1', snap({t1: {displayName: 'A', userId: 'u-x'}, t2: {displayName: 'A', userId: 'u-x'}}), 'u-me',
    )).toEqual(['u-x']);
  });

  test('sent-sets are per room', () => {
    markPresenceSent('r1', ['u-x']);
    expect(selectPresenceReplyTargets(
      'r2', snap({t1: {displayName: 'A', userId: 'u-x'}}), 'u-me',
    )).toEqual(['u-x']);
  });
});

describe('B-344 — wiring in useGroupCall', () => {
  test('the identity subscription replies via selectPresenceReplyTargets', () => {
    expect(HOOK).toMatch(/selectPresenceReplyTargets\(/);
    // The reply must go through the runtime presence broadcast.
    const subAt = HOOK.indexOf('selectPresenceReplyTargets(');
    const region = HOOK.slice(subAt, subAt + 1600);
    expect(region).toMatch(/broadcastGroupCallPresence\(/);
  });

  test('join seeds the observed-tag set from existingProducers', () => {
    const joinedAt = HOOK.indexOf('participantTagRef.current = joined.participantTag');
    expect(joinedAt).toBeGreaterThan(-1);
    const region = HOOK.slice(joinedAt, joinedAt + 1200);
    expect(region).toMatch(/recordObservedTag\(/);
    expect(region).toMatch(/existingProducers/);
  });
});
