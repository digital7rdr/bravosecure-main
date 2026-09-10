/**
 * B-691 — behaviour pins for the chat-open transition gate (F2 of
 * docs/qa/CHAT_OPEN_ANIMATION_LAG_2026-08-29.md).
 *
 * Contract: the gate opens exactly once — on the screen's OPEN transitionEnd
 * (closing=false), or on the fallback timer when the navigator never emits one
 * — and a CLOSING event can never open it. ChatScreen keys its mount side
 * effects on this, so "opens exactly once, never early, never lost" is what
 * keeps those effects out of the 220 ms animation window without dropping any.
 */
import {act, renderHook} from '@testing-library/react-native';
import {useOpenTransitionGate, OPEN_TRANSITION_FALLBACK_MS} from '@hooks/useOpenTransitionGate';

type Listener = (e: {data?: {closing?: boolean}}) => void;

function makeNav() {
  const listeners: Listener[] = [];
  let unsubCount = 0;
  return {
    nav: {
      addListener: (_type: 'transitionEnd', cb: Listener) => {
        listeners.push(cb);
        return () => { unsubCount += 1; };
      },
    },
    emit(e: {data?: {closing?: boolean}}) { [...listeners].forEach(l => l(e)); },
    get unsubCount() { return unsubCount; },
  };
}

describe('useOpenTransitionGate', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('the default fallback clears the longest animation but stays sub-second', () => {
    // Critic finding 2: a fallback below the 220 ms animation would fire the
    // deferred effects back INSIDE the slide; one far above it would delay
    // receipts/pull past what the B-691 report promised (~¼ s).
    expect(OPEN_TRANSITION_FALLBACK_MS).toBeGreaterThanOrEqual(300);
    expect(OPEN_TRANSITION_FALLBACK_MS).toBeLessThanOrEqual(1000);
  });

  it('starts closed and opens on the open-transition end', () => {
    const h = makeNav();
    const onDone = jest.fn();
    const {result} = renderHook(() => useOpenTransitionGate(h.nav, {onDone}));
    expect(result.current).toBe(false);
    expect(onDone).not.toHaveBeenCalled();

    act(() => { h.emit({data: {closing: false}}); });
    expect(result.current).toBe(true);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0].via).toBe('transition');
  });

  it('a CLOSING transition never opens the gate', () => {
    const h = makeNav();
    const {result} = renderHook(() => useOpenTransitionGate(h.nav));
    act(() => { h.emit({data: {closing: true}}); });
    expect(result.current).toBe(false);
  });

  it('an event with no data payload is treated as the open ending (defensive)', () => {
    const h = makeNav();
    const {result} = renderHook(() => useOpenTransitionGate(h.nav));
    act(() => { h.emit({}); });
    expect(result.current).toBe(true);
  });

  it('opens via the fallback timer when the navigator never emits — delayed, never lost', () => {
    const h = makeNav();
    const onDone = jest.fn();
    const {result} = renderHook(() => useOpenTransitionGate(h.nav, {onDone}));
    act(() => { jest.advanceTimersByTime(OPEN_TRANSITION_FALLBACK_MS - 1); });
    expect(result.current).toBe(false);
    act(() => { jest.advanceTimersByTime(1); });
    expect(result.current).toBe(true);
    expect(onDone.mock.calls[0][0].via).toBe('fallback');
  });

  it('opens exactly once — later fallback and repeat events are no-ops', () => {
    const h = makeNav();
    const onDone = jest.fn();
    renderHook(() => useOpenTransitionGate(h.nav, {onDone}));
    act(() => { h.emit({data: {closing: false}}); });
    act(() => { jest.advanceTimersByTime(OPEN_TRANSITION_FALLBACK_MS + 50); });
    act(() => { h.emit({data: {closing: false}}); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('unmount unsubscribes and disarms the fallback', () => {
    const h = makeNav();
    const onDone = jest.fn();
    const {unmount} = renderHook(() => useOpenTransitionGate(h.nav, {onDone}));
    unmount();
    expect(h.unsubCount).toBe(1);
    act(() => { jest.advanceTimersByTime(OPEN_TRANSITION_FALLBACK_MS + 50); });
    expect(onDone).not.toHaveBeenCalled();
  });

  it('a throwing onDone probe cannot break the gate', () => {
    const h = makeNav();
    const {result} = renderHook(() =>
      useOpenTransitionGate(h.nav, {onDone: () => { throw new Error('probe'); }}));
    act(() => { h.emit({data: {closing: false}}); });
    expect(result.current).toBe(true);
  });
});
