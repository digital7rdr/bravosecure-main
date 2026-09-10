/**
 * ADD_CALL_AUDIT_2026-07-27 — pins for the AC-3 / AC-4 / AC-6 remediations.
 * (B-306/B-307/B-308 carry their own suites: escalationRingHandoff,
 * ringDedupPresented, pendingGroupRing, callControllerTeardownWins,
 * addPickerScrollable.)
 *
 * AC-3 — the FCM lane's foreground GROUP wake re-dispatches through the ring
 * dispatcher instead of being dropped on the assumption that the WS lane
 * always presents the ring UI (run 3 disproved it). The roomId dedup makes
 * the re-dispatch idempotent with the WS lane.
 *
 * AC-4 — GroupCallScreen's invite sheet SUBSCRIBES to the name maps; the old
 * getState() read inside the memo could never re-render, so the backfill the
 * memo itself fired had no way to deliver and rows stayed "Member" forever.
 *
 * AC-6 — the ring path's release-build trail: every hop logs a
 * `[CALLDIAG]` console.warn (transform-remove-console strips log, keeps
 * warn). The 2026-07-27 device diagnosis had to infer the receiver's ring
 * handling from an ABSENCE of native lines; each of these tags exists so the
 * next one is a read, not an inference.
 *
 * All target files mount RN views / import natives — comment-stripped source
 * scans. Files are CRLF; nothing here is `\n`-anchored (a `\n` anchor
 * matches nothing and passes VACUOUSLY).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(...rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

describe('AC-3 — the FCM lane rescues a lost foreground group ring', () => {
  const src = () => code('src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts');

  it('the foreground voip-wake branch dispatches group wakes through the dispatcher', () => {
    const s = src();
    const at = s.indexOf("kind === 'voip-wake'");
    expect(at).toBeGreaterThan(-1);
    const branch = s.slice(at, at + 3200); // widened 2600->3200 (Step 2.1 added the fg-lane TURN prewarm inside this branch)
    expect(branch).toMatch(/group-voice/);
    expect(branch).toMatch(/dispatchGroupRingFrame\(/);
    // The gateway contract: a group wake's callId IS the roomId.
    expect(branch).toMatch(/roomId:\s*data\.callId/);
  });

  it('1:1 wakes keep the old behaviour — no dispatch for a bare voice/video wake', () => {
    const s = src();
    const at = s.indexOf("kind === 'voip-wake'");
    const branch = s.slice(at, at + 3200); // widened 2600->3200 (Step 2.1 added the fg-lane TURN prewarm inside this branch)
    // The dispatch is gated on the group kinds, not unconditional.
    const gateAt = branch.indexOf("wakeKind === 'group-voice'");
    const dispatchAt = branch.indexOf('dispatchGroupRingFrame(');
    expect(gateAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(gateAt);
  });
});

describe('AC-4 — invite-sheet names are reactive', () => {
  const src = () => code('src', 'screens', 'messenger', 'GroupCallScreen.tsx');

  it('the name maps are SUBSCRIBED, not read imperatively in the memo', () => {
    const s = src();
    expect(s).toMatch(/useMessengerStore\(s => s\.groupMemberNames\[conversationId\]\)/);
    expect(s).toMatch(/useMessengerStore\(s => s\.directoryNames\)/);
    // The imperative shape this bug shipped as, scoped to the memo body:
    const at = s.indexOf('const inviteCandidates = useMemo');
    expect(at).toBeGreaterThan(-1);
    const memo = s.slice(at, s.indexOf('INVITE_RING_WINDOW_MS', at));
    expect(memo).not.toMatch(/useMessengerStore\.getState\(\)/);
  });

  it('the maps are memo deps — subscribing without depending changes nothing', () => {
    const s = src();
    const at = s.indexOf('const inviteCandidates = useMemo');
    const memo = s.slice(at, s.indexOf('INVITE_RING_WINDOW_MS', at));
    expect(memo).toMatch(/\}, \[[^\]]*inviteMemberNames[^\]]*inviteDirectoryNames[^\]]*\]\)/);
  });
});

describe('AC-6 — the ring path has a release-visible [CALLDIAG] trail', () => {
  const CASES: Array<[file: string[], tag: string]> = [
    [['src', 'modules', 'messenger', 'webrtc', 'groupCallRingDispatcher.ts'], '[ring.dispatch]'],
    [['src', 'navigation', 'MainNavigator.tsx'],                              '[ring.route]'],
    [['src', 'screens', 'messenger', 'IncomingGroupCallScreen.tsx'],          '[ring.screen]'],
    [['src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'],            '[ring.send]'],
    [['src', 'screens', 'messenger', 'CallScreen.tsx'],                       '[ring.handoff]'],
    [['src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts'],              '[ring.fcm]'],
  ];

  it.each(CASES)('%s carries a console.warn %s probe', (file, tag) => {
    const s = code(...file);
    const esc = tag.replace(/[[\]]/g, m => '\\' + m);
    // Must be console.warn — transform-remove-console strips log/info/debug
    // from release builds, and release is the only place this trail matters.
    expect(s).toMatch(new RegExp(`console\\.warn\\('\\[CALLDIAG\\] ${esc}`));
  });
});
