/**
 * B-306 — the receiver-side escalation handoff: park, then consume. One
 * navigation actor, no race.
 *
 * Device-proven failure (2026-07-27 two-device run 3): the host escalated a
 * live 1:1; on the peer, CallScreen's ended auto-dismiss (50 ms goBack) and
 * the ring handler's navigate raced. The goBack popped the just-pushed
 * IncomingGroupCallScreen, the once-ever dedup swallowed the replay, and the
 * user was left on a dead call screen with a ring they could never answer.
 *
 * The contract pinned here:
 *  1. MainNavigator's ring handler PARKS when a 1:1 owns the screen
 *     (a live registry call OR a mounted 1:1 call route — the registry can
 *     already be null mid-teardown, which is exactly the race window), and
 *     does not navigate.
 *  2. Ring cancel clears the parked ring by roomId, so an expired/withdrawn
 *     invite cannot be consumed later.
 *  3. CallScreen consumes the parked ring at its OWN dismissal moment and
 *     routes into IncomingGroupCallScreen; the plain goBack survives for the
 *     no-parked-ring case.
 *  4. All three CallScreen dismissal paths (state-driven auto-dismiss, the
 *     endCall watchdog, the declineCall watchdog) funnel through the ONE
 *     consuming helper — a path that bypasses it re-opens the race.
 *
 * Both files mount RN views, so the node project cannot import them —
 * comment-stripped source scans. The files are CRLF; nothing here is
 * `\n`-anchored (a `\n` anchor matches nothing and passes VACUOUSLY).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(...rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const mainNav    = () => code('src', 'navigation', 'MainNavigator.tsx');
const callScreen = () => code('src', 'screens', 'messenger', 'CallScreen.tsx');

describe('B-306 — MainNavigator parks instead of racing a live 1:1', () => {
  it('the ring handler consults the 1:1 registry', () => {
    const src = mainNav();
    const at = src.indexOf('setGroupCallRingHandler({');
    expect(at).toBeGreaterThan(-1);
    // Window widened 3000 → 3400 → 3800 (2026-08-20, audit Step 0 then 2.1):
    // the handler entry gained the [CALLLAT] `ring:received` row and the
    // prewarmIceServers() warm-up (~500 chars after stripping); the
    // park → return → navigate ordering asserted below is unchanged.
    const handler = src.slice(at, at + 3800);
    expect(handler).toMatch(/getActiveCall\(\)/);
  });

  it('busy → parkGroupRing and RETURN (no navigate over the call)', () => {
    const src = mainNav();
    const at = src.indexOf('setGroupCallRingHandler({');
    // Window widened 3000 → 3400 → 3800 (2026-08-20, audit Step 0 then 2.1):
    // the handler entry gained the [CALLLAT] `ring:received` row and the
    // prewarmIceServers() warm-up (~500 chars after stripping); the
    // park → return → navigate ordering asserted below is unchanged.
    const handler = src.slice(at, at + 3800);
    expect(handler).toMatch(/parkGroupRing\(ring\)/);
    // The park must short-circuit the navigate. Ops-Room call fix: the
    // handler navigates via the shell resolver now, so anchor on that.
    const parkAt = handler.indexOf('parkGroupRing(ring)');
    const navAt  = handler.indexOf('navigateToMessengerScreen');
    expect(parkAt).toBeGreaterThan(-1);
    expect(navAt).toBeGreaterThan(parkAt);
    expect(handler.slice(parkAt, navAt)).toMatch(/return;/);
  });

  it('a mounted 1:1 call route parks too — the registry is null mid-teardown', () => {
    const src = mainNav();
    const at = src.indexOf('setGroupCallRingHandler({');
    // Window widened 3000 → 3400 → 3800 (2026-08-20, audit Step 0 then 2.1):
    // the handler entry gained the [CALLLAT] `ring:received` row and the
    // prewarmIceServers() warm-up (~500 chars after stripping); the
    // park → return → navigate ordering asserted below is unchanged.
    const handler = src.slice(at, at + 3800);
    // Both stacks register the 1:1 screen: 'CallScreen' and 'VoiceCall'.
    expect(handler).toMatch(/'CallScreen'/);
    expect(handler).toMatch(/'VoiceCall'/);
  });

  it('ring cancel clears the parked ring by roomId', () => {
    const src = mainNav();
    const at = src.indexOf('setGroupCallRingHandler({');
    // Anchor on onCancel itself — the onIncoming body above it grew with the
    // B-321 registry-null consume fallback, so a fixed window from the
    // handler start no longer reaches it.
    const cancelAt = src.indexOf('onCancel:', at);
    expect(cancelAt).toBeGreaterThan(at);
    expect(src.slice(cancelAt, cancelAt + 600)).toMatch(/clearPendingGroupRing\(/);
  });
});

describe('B-306 — CallScreen consumes the parked ring at dismissal', () => {
  it('one consuming dismissal helper exists', () => {
    const src = callScreen();
    expect(src).toMatch(/const dismissCallScreen = /);
    expect(src).toMatch(/consumePendingGroupRing\(\)/);
  });

  it('a parked ring routes into IncomingGroupCallScreen', () => {
    const src = callScreen();
    const at = src.indexOf('const dismissCallScreen');
    // Window widened for B-478: the consume site now checks the resolver's
    // verdict and re-parks on refusal, which pushed the no-ring pop past the
    // old 1800-char horizon. A fixed-size window that silently stops covering
    // the thing it names is the failure mode here, so assert the anchor is
    // inside it rather than trusting the number.
    const body = src.slice(at, at + 2800);
    expect(body).toMatch(/IncomingGroupCallScreen/);
    // And the no-ring case still just pops.
    expect(body).toMatch(/goBack/);
  });

  it('ALL FOUR dismissal paths funnel through the helper', () => {
    // Auto-dismiss on 'ended', the endCall watchdog, the declineCall
    // watchdog, and the NA-02 dead-offer pop. Exactly one place may flip
    // dismissedRef: the helper — any other `dismissedRef.current = true`
    // residue is a path that bypasses the consume and re-opens the pop-race.
    const src = callScreen();
    const matches = src.match(/dismissedRef\.current = true;/g) ?? [];
    expect(matches).toHaveLength(1);
    // WI-2.4 — the End and Decline watchdogs now share ONE owned timer helper
    // (`armPopWatchdog`) so unmount can clear them; they used to be two bare
    // `setTimeout(... dismissCallScreen(), 800)` calls. The funnel is intact —
    // the helper's only body calls `dismissCallScreen()`, asserted below and in
    // `callScreenTimerOwnership.test.ts` — so count the helper as the path it
    // is, rather than requiring the raw shape the B-306 note explicitly warns
    // against pinning.
    const calls = src.match(/dismissCallScreen\(\)/g) ?? [];
    const armed = src.match(/armPopWatchdog\(\)/g) ?? [];
    expect(calls.length + armed.length).toBeGreaterThanOrEqual(4);
    // The helper must actually be a funnel, not a rename.
    const helperAt = src.indexOf('const armPopWatchdog');
    expect(helperAt).toBeGreaterThan(-1);
    expect(src.slice(helperAt, helperAt + 400)).toContain('dismissCallScreen()');
  });
});
