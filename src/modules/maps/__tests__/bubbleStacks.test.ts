/**
 * The on-map bubble rules, ported from the WebView map.
 *
 * These were untestable in their original home (DOM callbacks inside a
 * generated HTML template literal). B-406 was filed against exactly this
 * behaviour — unbounded system cards piling up over the map — so it gets real
 * unit tests here rather than a source scan.
 */
import {
  DEFAULT_BUBBLE_TTL_MS,
  DEFAULT_SYSTEM_TTL_MS,
  MAX_MARKER_VISIBLE,
  MAX_SYS_VISIBLE,
  expireMarkerBubbles,
  expireSystemBubbles,
  nextExpiry,
  pushMarkerBubble,
  pushSystemBubble,
  visibleForAnchor,
  visibleSystem,
  type MarkerBubble,
  type SystemBubble,
} from '../bubbleStacks';

const T0 = 1_000_000;

function msg(id: string, over: Partial<Parameters<typeof pushMarkerBubble>[1]> = {}) {
  return {id, preview: `p-${id}`, ...over};
}

describe('marker bubbles', () => {
  it('de-dupes by id — the same envelope twice is one bubble', () => {
    let s: MarkerBubble[] = [];
    s = pushMarkerBubble(s, msg('a'), T0);
    const before = s;
    s = pushMarkerBubble(s, msg('a'), T0 + 10);
    expect(s).toHaveLength(1);
    // Same reference, so the host can skip the re-render entirely.
    expect(s).toBe(before);
  });

  it('is newest-first — a driver glances once', () => {
    let s: MarkerBubble[] = [];
    s = pushMarkerBubble(s, msg('old'), T0);
    s = pushMarkerBubble(s, msg('new'), T0 + 1);
    expect(s.map(b => b.id)).toEqual(['new', 'old']);
  });

  it('shows only a window, but does NOT discard the queue', () => {
    let s: MarkerBubble[] = [];
    for (const id of ['a', 'b', 'c', 'd']) {
      s = pushMarkerBubble(s, msg(id), T0);
    }
    expect(visibleForAnchor(s, 'cpo')).toHaveLength(MAX_MARKER_VISIBLE);
    // The queued ones are still present — losing them is the bug, not the fix.
    expect(s).toHaveLength(4);
  });

  it('promotes a queued bubble when a visible one expires', () => {
    let s: MarkerBubble[] = [];
    s = pushMarkerBubble(s, msg('a', {ttl: 100}), T0);
    s = pushMarkerBubble(s, msg('b', {ttl: 5000}), T0);
    s = pushMarkerBubble(s, msg('c', {ttl: 5000}), T0);
    // c, b visible; a queued.
    expect(visibleForAnchor(s, 'cpo').map(b => b.id)).toEqual(['c', 'b']);
    s = expireMarkerBubbles(s, T0 + 6000);
    // Everything with a short/expired clock is gone; nothing is stranded.
    expect(s.map(b => b.id)).toEqual([]);
  });

  it('SOS never expires — a panic bubble that times out is a lost alarm', () => {
    let s: MarkerBubble[] = [];
    s = pushMarkerBubble(s, msg('panic', {kind: 'sos'}), T0);
    s = pushMarkerBubble(s, msg('chat'), T0);
    expect(s.find(b => b.id === 'panic')?.expiresAt).toBeNull();

    s = expireMarkerBubbles(s, T0 + 10 * 60 * 1000);
    expect(s.map(b => b.id)).toEqual(['panic']);
  });

  it('defaults the TTL and honours an explicit one', () => {
    let s: MarkerBubble[] = [];
    s = pushMarkerBubble(s, msg('d'), T0);
    expect(s[0].expiresAt).toBe(T0 + DEFAULT_BUBBLE_TTL_MS);
    s = pushMarkerBubble(s, msg('e', {ttl: 250}), T0);
    expect(s[0].expiresAt).toBe(T0 + 250);
  });

  it('keeps the two anchors separate', () => {
    let s: MarkerBubble[] = [];
    s = pushMarkerBubble(s, msg('x', {anchor: 'principal'}), T0);
    s = pushMarkerBubble(s, msg('y'), T0);
    expect(visibleForAnchor(s, 'cpo').map(b => b.id)).toEqual(['y']);
    expect(visibleForAnchor(s, 'principal').map(b => b.id)).toEqual(['x']);
    // An unknown anchor falls back to cpo rather than vanishing.
    s = pushMarkerBubble(s, msg('z', {anchor: 'nonsense'}), T0);
    expect(visibleForAnchor(s, 'cpo').map(b => b.id)).toContain('z');
  });

  it('an idle sweep returns the same reference (no wasted render)', () => {
    let s: MarkerBubble[] = [];
    s = pushMarkerBubble(s, msg('a'), T0);
    expect(expireMarkerBubbles(s, T0 + 1)).toBe(s);
  });
});

describe('system bubbles (B-406 — the pile-up)', () => {
  const at = (id: string, over: Partial<SystemBubble> = {}) => ({
    id,
    label: 'WAYPOINT',
    preview: id,
    lat: 25.2,
    lng: 55.3,
    ...over,
  });

  it('caps what renders — every waypoint event used to mount its own card', () => {
    let s: SystemBubble[] = [];
    for (let i = 0; i < 10; i++) {
      s = pushSystemBubble(s, at(`e${i}`), T0);
    }
    expect(visibleSystem(s)).toHaveLength(MAX_SYS_VISIBLE);
    expect(s).toHaveLength(10);
  });

  it('de-dupes, and refuses a card with no coordinate', () => {
    let s: SystemBubble[] = [];
    s = pushSystemBubble(s, at('a'), T0);
    expect(pushSystemBubble(s, at('a'), T0)).toBe(s);
    // A null island / missing fix must not mount a card in the Atlantic.
    s = pushSystemBubble(s, at('b', {lat: undefined as unknown as number}), T0);
    expect(s.map(b => b.id)).toEqual(['a']);
  });

  it('expires on its own longer default', () => {
    let s: SystemBubble[] = [];
    s = pushSystemBubble(s, at('a'), T0);
    expect(s[0].expiresAt).toBe(T0 + DEFAULT_SYSTEM_TTL_MS);
    expect(expireSystemBubbles(s, T0 + DEFAULT_SYSTEM_TTL_MS + 1)).toHaveLength(0);
  });
});

describe('scheduling', () => {
  it('reports the single next expiry so the host arms ONE timer', () => {
    let m: MarkerBubble[] = [];
    let s: SystemBubble[] = [];
    m = pushMarkerBubble(m, msg('a', {ttl: 900}), T0);
    m = pushMarkerBubble(m, msg('sos', {kind: 'sos'}), T0);
    s = pushSystemBubble(s, {id: 's', lat: 1, lng: 1, ttl: 400}, T0);
    expect(nextExpiry(m, s)).toBe(T0 + 400);
  });

  it('is null when only holds remain — nothing to wake up for', () => {
    const m = pushMarkerBubble([], msg('sos', {kind: 'sos'}), T0);
    expect(nextExpiry(m, [])).toBeNull();
  });
});
