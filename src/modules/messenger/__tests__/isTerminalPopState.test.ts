import {isTerminalPopState, TERMINAL_POP_DELAY_MS} from '@/modules/messenger/webrtc/groupCallLayout';
import type {GroupCallState} from '@/modules/messenger/webrtc/useGroupCall';

/**
 * BS-GC1 — the GroupCallScreen auto-pop decision. The screen's effect
 * pops (navigation.goBack after TERMINAL_POP_DELAY_MS) iff this predicate
 * is true. Before the fix, 'ended-by-host' / 'left' fell through to the
 * live UI showing "Connecting…" forever with no exit but hardware back.
 *
 * The full render test (mounting GroupCallScreen under
 * react-test-renderer) is documented + skipped in
 * src/screens/messenger/__tests__/GroupCallScreen.autopop.test.tsx — the
 * screen's transitive native/effect surface doesn't settle under jsdom
 * without a much larger mock harness. This pure test pins the decision
 * the effect depends on; the effect wiring itself is covered by typecheck
 * + read review.
 */
describe('isTerminalPopState (BS-GC1)', () => {
  it('returns true for the two "call is over" states that clear the registry', () => {
    expect(isTerminalPopState('ended-by-host')).toBe(true);
    expect(isTerminalPopState('left')).toBe(true);
  });

  it('returns false for a live joined call (must NOT pop)', () => {
    expect(isTerminalPopState('joined')).toBe(false);
  });

  it('returns false for in-progress states', () => {
    expect(isTerminalPopState('idle')).toBe(false);
    expect(isTerminalPopState('creating')).toBe(false);
    expect(isTerminalPopState('joining')).toBe(false);
    expect(isTerminalPopState('reconnecting')).toBe(false);
  });

  it('returns false for blocking states that have their OWN Close-button screen', () => {
    // These render the blocker UI (full/kicked/failed/unavailable) — they
    // must not be auto-popped or the user never sees why the call ended.
    expect(isTerminalPopState('full')).toBe(false);
    expect(isTerminalPopState('kicked')).toBe(false);
    expect(isTerminalPopState('failed')).toBe(false);
    expect(isTerminalPopState('unavailable')).toBe(false);
  });

  it('is exhaustive over GroupCallState — exactly two terminal-pop states', () => {
    const all: GroupCallState[] = [
      'idle', 'unavailable', 'creating', 'joining', 'joined',
      'reconnecting', 'left', 'failed', 'kicked', 'ended-by-host', 'full',
    ];
    const popStates = all.filter(isTerminalPopState);
    expect(popStates.sort()).toEqual(['ended-by-host', 'left']);
  });

  it('uses a perceptible-but-short pop delay', () => {
    expect(TERMINAL_POP_DELAY_MS).toBeGreaterThan(0);
    expect(TERMINAL_POP_DELAY_MS).toBeLessThanOrEqual(1000);
  });
});
