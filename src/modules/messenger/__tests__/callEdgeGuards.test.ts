/**
 * B-320 / B-321 / B-322 — call edge-case guards (W4 of
 * MESSENGER_STABILITY_PLAN_2026-07-28). Source scans (screens/navigation pull
 * react-native); CRLF-safe, comments stripped. Anchors are fix-only strings —
 * reverting any fix turns its scan red.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function load(rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const launch = load(['src', 'modules', 'messenger', 'webrtc', 'launchCall.ts']);
const nav = load(['src', 'navigation', 'MainNavigator.tsx']);
const screen = load(['src', 'screens', 'messenger', 'CallScreen.tsx']);
const fcm = load(['src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts']);

describe('B-320 — launchCall busy guards cover BOTH registries, both branches', () => {
  it('the combined check sits above the group branch', () => {
    const guard = launch.indexOf('const busyGroup = getActiveGroupCall();');
    const groupBranch = launch.indexOf('if (groupCall) {');
    expect(guard).toBeGreaterThan(-1);
    expect(groupBranch).toBeGreaterThan(guard);
    expect(launch).toMatch(/const busyOneToOne = getActiveCall\(\);/);
  });

  it('re-joining the SAME conversation group call stays allowed', () => {
    expect(launch).toMatch(/busyGroup\.conversationId === opts\.conversationId/);
  });

  it('the stale-registry clear captures leave() BEFORE nulling the slot', () => {
    const b = launch.slice(launch.indexOf('const stale = getActiveGroupCall();'));
    const capture = b.indexOf('const staleLeave = stale.leave;');
    const clear = b.indexOf('setActiveGroupCall(null);');
    expect(capture).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(capture);
    expect(b).toMatch(/staleLeave\(\)\.catch/);
  });
});

describe('B-321 — a parked group ring survives a minimized 1:1', () => {
  it('the park site arms a registry-null consume fallback', () => {
    const park = nav.indexOf('parkGroupRing(ring);');
    expect(park).toBeGreaterThan(-1);
    const after = nav.slice(park, park + 4000);
    expect(after).toMatch(/onActiveCallChange/);
    expect(after).toMatch(/consumePendingGroupRing\(\)/);
    expect(after).toMatch(/IncomingGroupCallScreen/);
  });

  it('the fallback respects the mid-teardown route guard (retry, not stomp)', () => {
    const park = nav.indexOf('parkGroupRing(ring);');
    const after = nav.slice(park, park + 4000);
    expect(after).toMatch(/attemptConsume\(attempt \+ 1\)/);
  });

  it("CallScreen's own dismissal consume is untouched (one-shot pairing)", () => {
    expect(screen).toMatch(/const ring = consumePendingGroupRing\(\);/);
  });
});

describe('W4.2 — a busy device never raises a second system call surface', () => {
  it('warm path: Telecom report + cache sit BELOW both busy banner branches', () => {
    // Before the fix, reportIncomingCall fired ABOVE the group/1:1 busy
    // branches, so a device already on a call still got a full system call
    // UI for the second ring. The banner paths own the busy presentation.
    const lastBanner = nav.lastIndexOf('banner.setPendingOneToOne(data);');
    const telecom = nav.indexOf('reportIncomingCall({');
    const cacheWrite = nav.indexOf('cache.setIncomingCallPayload({');
    expect(lastBanner).toBeGreaterThan(-1);
    expect(telecom).toBeGreaterThan(lastBanner);
    expect(cacheWrite).toBeGreaterThan(lastBanner);
  });

  it('FCM path: a registry busy-guard sits ABOVE the ringers, same-id falls through', () => {
    // WI-4.10 added a SECOND lane with the same shape (the foreground 1:1
    // rescue), so first-occurrence indexOf would compare a guard in one lane
    // against a ringer in the other. Scope to the BG wake lane explicitly.
    const bgLane = fcm.slice(fcm.indexOf('setBackgroundMessageHandler(async'));
    const guard = bgLane.indexOf('[ring.fcm] busy');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(bgLane.indexOf('bridge.reportIncomingCall('));
    expect(bgLane).toMatch(/live\.callId !== incomingCallId/);
    expect(bgLane).toMatch(/liveGroup\.roomId !== incomingCallId/);
  });

  it('WI-4.10 — the foreground 1:1 rescue keeps the same busy-above-ringers order', () => {
    const fgStart = fcm.indexOf('messaging().onMessage(');
    const fgLane = fcm.slice(fgStart, fcm.indexOf('setBackgroundMessageHandler(async', fgStart));
    const guard = fgLane.indexOf('fg busy');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fgLane.indexOf('bridge.reportIncomingCall('));
  });
});

describe('B-322 — incoming 1:1 cannot stomp an outgoing call mid-boot', () => {
  it('the call-waiting branch has the mounted-route fallback', () => {
    expect(nav).toMatch(/const bootingOtherCall =/);
    expect(nav).toMatch(/curRoute\?\.name === 'CallScreen' \|\| curRoute\?\.name === 'VoiceCall'/);
  });

  it('the same-callId offer replay still falls through (B-102 A1)', () => {
    expect(nav).toMatch(/curRouteCallId !== data\.callId/);
    expect(nav).toMatch(/\(liveCall && liveCall\.callId !== data\.callId\) \|\| bootingOtherCall/);
  });
});
