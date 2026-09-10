/**
 * WI-3.5 — `IncomingGroupCallScreen` must survive PARAM REUSE.
 *
 * A navigator can hand this already-mounted screen a NEW ring by swapping
 * `route.params` — no remount, no fresh refs, no re-run of `[]`-deps effects.
 * The screen half-knew this (it reset `settledRef` on `roomId`) and that made
 * things worse rather than better:
 *
 *   • the 45 s ring-timeout was a `[]`-deps one-shot, so its ONLY clearTimeout
 *     lived in an unmount cleanup. Ring #1's timer therefore survived into
 *     ring #2 and fired holding ring #1's `conversationId` and `dismissRing`:
 *     a missed-call bubble written into the WRONG conversation, `settledRef`
 *     latched (killing ring #2's Accept), and ring #2 popped off-screen while
 *     the user was looking at it. And the reset at the top is what let the
 *     stale timer past its own guard.
 *   • ring #2 got no 45 s fallback of its own, so a lost `sfu.ring.cancel`
 *     rang forever — the exact failure the fallback exists to prevent.
 *   • `bindInAppRingOwnership` stayed bound to ring #1's roomId, so the NA-06
 *     native-ring hand-off was wrong for #2.
 *   • `cancelledRef` only ever latched TRUE and was never reset, so a cancel
 *     for ring #1 permanently poisoned ring #2: Accept took the BS-RING-RACE
 *     branch and recorded a missed call instead of joining a live room.
 *
 * SOURCE SCAN, not a render test: this screen imports `expo-av` tones and
 * `useGroupCall` (mediasoup at module top), so it cannot mount under the
 * node-based messenger-crypto project — see the same limitation recorded in
 * `callScreenBackFallback.test.ts` and `inAppRingOwnership.test.ts`.
 *
 * The scan strips comments first. That is load-bearing here: the fix's own
 * comments discuss `[]` deps in prose, and an unstripped scan would match the
 * explanation instead of the code and pass vacuously.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(
  process.cwd(), 'src', 'screens', 'messenger', 'IncomingGroupCallScreen.tsx',
);

/**
 * Drop whole-line comments only.
 *
 * Deliberately conservative: this repo's more aggressive stripper has eaten
 * real code before by treating `/*` inside a string literal as a comment
 * opener. Every comment this scan needs to ignore is a whole-line one.
 */
function strip(src: string): string {
  return src
    .split(/\r?\n/)
    .filter(line => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

const RAW = readFileSync(SCREEN, 'utf8');
const CODE = strip(RAW);

/** The effect body containing `anchor`, up to its closing dep array. */
function effectClosing(anchor: string): string {
  const i = CODE.indexOf(anchor);
  expect(i).toBeGreaterThan(-1);
  const rest = CODE.slice(i);
  const m = rest.match(/\}, \[[^\]]*\]\);/);
  expect(m).toBeTruthy();
  return m![0];
}

describe('WI-3.5 — the ring timeout is re-armed per ring', () => {
  it('the 45 s ring timeout still exists at all', () => {
    // Guard the guard: if this ever moves, every assertion below would pass
    // vacuously against an anchor that matched nothing.
    expect(CODE).toContain('const ringTimeout = setTimeout(');
    expect(CODE).toMatch(/\}, 45000\)/);
  });

  it('its effect is keyed on roomId, NOT a bare one-shot', () => {
    // THE bug. `[]` meant the cleanup — which holds the only clearTimeout —
    // ran on unmount alone, so ring #1's timer outlived ring #1.
    const closing = effectClosing('const ringTimeout = setTimeout(');
    expect(closing).toContain('roomId');
    expect(closing).not.toBe('}, []);');
  });

  it('the effect clears its timeout on re-run', () => {
    const i = CODE.indexOf('const ringTimeout = setTimeout(');
    const body = CODE.slice(i, i + 1200);
    expect(body).toContain('clearTimeout(ringTimeout)');
  });

  it('B-480 — the ringtone/ownership effect IS re-keyed per ring', () => {
    /**
     * This assertion was inverted, deliberately, and the history matters.
     *
     * WI-3.5 first re-keyed this effect and had to revert: React runs the
     * cleanup before the re-run, `stopRingtone()` set the tone slot to
     * 'stopping' synchronously, and the re-run's `bindInAppRingOwnership` calls
     * `startRingtone()` synchronously inside bind — which the slot refused
     * because it was not 'idle'. Ring #2 vibrated in silence, so the pin was
     * written to LOCK the one-shot until the slot could cope.
     *
     * `bravoTones` now queues a start that arrives mid-teardown and drains it
     * once the slot is idle (see `bravoTonesAudioMode.test.ts`), so re-keying
     * is safe and the two gaps the old pin recorded are closed: the NA-06
     * ownership binding follows the room, and the `autoAccept || roomMissing`
     * early return is re-evaluated per ring instead of once per instance.
     */
    const bind = CODE.indexOf('bindInAppRingOwnership(');
    expect(bind).toBeGreaterThan(-1);
    const rest = CODE.slice(bind);
    const closing = rest.match(/\}, \[[^\]]*\]\);/);
    expect(closing).toBeTruthy();
    expect(closing![0]).toContain('roomId');
    expect(closing![0]).not.toBe('}, []);');
  });

  it('B-480 — the tone slot it depends on actually has the restart queue', () => {
    // Cross-file, on purpose: re-keying the effect above is only safe because
    // `bravoTones` queues a start that lands while the slot is tearing down.
    // If that queue is ever removed, this screen goes silent on ring #2 — and
    // nothing in THIS file would notice.
    const tones = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'bravoTones.ts'), 'utf8',
    );
    expect(tones).toContain('pendingStart');
    expect(tones).toMatch(/if \(slot\.state === 'stopping'\) \{/);
    expect(tones).toContain('drainPendingStart');
  });

  it('the timer effect and the tone effect are SEPARATE effects', () => {
    // If a future edit merges them back, one of the two bugs above returns
    // depending on which dep array survives.
    const bind  = CODE.indexOf('bindInAppRingOwnership(');
    const timer = CODE.indexOf('const ringTimeout = setTimeout(');
    expect(bind).toBeGreaterThan(-1);
    expect(timer).toBeGreaterThan(bind);
    // A `useEffect(` must open between them — i.e. they are not one body.
    expect(CODE.slice(bind, timer)).toContain('useEffect(');
  });
});

describe('WI-3.5 — the cancel latch resets with the settled latch', () => {
  it('cancelledRef is reset, not only settledRef', () => {
    // Without this a cancel for ring #1 permanently poisons Accept for #2.
    expect(CODE).toMatch(/cancelledRef\.current\s*=\s*false/);
  });

  it('both latches reset in the SAME per-ring-keyed effect', () => {
    // Resetting only `settledRef` is strictly worse than resetting neither:
    // it re-opens Accept while leaving the cancel trap armed.
    // Phase 6 round 2 (critic F4) — the key widened from [roomId] to
    // [roomId, ringId]: a same-room re-ring swaps params with an UNCHANGED
    // roomId, so the roomId-only key left ring #1's latches poisoning ring #2.
    const i = CODE.indexOf('settledRef.current   = false;');
    expect(i).toBeGreaterThan(-1);
    const block = CODE.slice(i, i + 300);
    expect(block).toMatch(/cancelledRef\.current\s*=\s*false/);
    expect(block).toMatch(/\}, \[roomId, ringId\]\);/);
  });

  it('the cancel handler still LATCHES cancelledRef (the reset must not remove the guard)', () => {
    // BS-RING-RACE is a real race — Accept losing a same-tick race to a cancel
    // must still route to the missed-call UX. Only the CARRY-OVER was wrong.
    expect(CODE).toMatch(/cancelledRef\.current\s*=\s*true/);
    expect(CODE).toContain('if (cancelledRef.current) {');
  });
});

describe('WI-3.5 — the param-driven effects re-fire for a second ring', () => {
  it('the autoAccept auto-join is keyed on roomId', () => {
    // Two notification-answered rings in a row keep `autoAccept` true across
    // the swap, so without roomId the second one never auto-joins: the user
    // taps Answer and lands on a ring screen that just sits there.
    const closing = effectClosing('accept();');
    expect(closing).toContain('roomId');
  });

  it('the roomMissing dismissal is keyed on roomId', () => {
    const i = CODE.indexOf('if (!roomMissing) {return;}');
    expect(i).toBeGreaterThan(-1);
    const m = CODE.slice(i).match(/\}, \[[^\]]*\]\);/);
    expect(m).toBeTruthy();
    expect(m![0]).toContain('roomId');
  });
});
