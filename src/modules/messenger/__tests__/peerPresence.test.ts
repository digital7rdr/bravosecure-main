/**
 * Active-status UI rules — first coverage of ui/PeerPresence.tsx.
 *
 * Pins formatLastSeen's boundaries and, through the two components, the
 * private tier() rule: away beats the derived online boolean (PRES-02),
 * "recent" needs a last-seen within 5 minutes, and any non-offline tier
 * suppresses the offline banner. DOCUMENTS one live defect: a
 * future-dated lastSeen (peer clock skew) makes tier() report 'recent',
 * so an offline peer shows "Active recently" — while formatLastSeen
 * correctly refuses the same timestamp (B-147).
 *
 * The component module pulls RN/expo at module scope — stubbed the same
 * way privacyToggleLatestWins.test.ts stubs its screen.
 */

jest.mock('react-native', () => ({
  StyleSheet: {create: (s: unknown) => s},
  View: 'View',
  Text: 'Text',
  Platform: {select: (o: {ios?: unknown; default?: unknown}) => o.default ?? o.ios},
  Easing: {out: (e: unknown) => e, ease: jest.fn()},
  Animated: {
    Value: class {
      setValue(): void {}
      interpolate(): number {return 0;}
    },
    timing: () => ({start: jest.fn(), stop: jest.fn()}),
    loop: () => ({start: jest.fn(), stop: jest.fn()}),
    View: 'Animated.View',
  },
}));
jest.mock(
  '@expo/vector-icons/MaterialCommunityIcons',
  () => ({__esModule: true, default: 'Icon'}),
  {virtual: true},
);

import React from 'react';
// @ts-expect-error — react-test-renderer ships no bundled types and the
// repo avoids @types devDeps for test-only tooling; the module is `any`.
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import type {PresenceRec} from '../ui/PeerPresence';
import {formatLastSeen, PeerOfflineBanner, PeerPresencePill} from '../ui/PeerPresence';

const NOW = 1_753_248_000_000;
let nowSpy: jest.SpyInstance<number, []>;

beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  nowSpy.mockRestore();
  jest.useRealTimers();
});

/** All string leaves of the rendered tree, concatenated. */
function textOf(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) {return;}
    if (typeof node === 'string') {out.push(node); return;}
    if (Array.isArray(node)) {node.forEach(walk); return;}
    const j = node as {children?: unknown};
    if (j.children) {walk(j.children);}
  };
  walk(r.toJSON());
  return out.join('');
}

function render(el: React.ReactElement): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => { r = create(el); });
  return r;
}

const pill = (presence?: PresenceRec, extra: Record<string, unknown> = {}) =>
  render(React.createElement(PeerPresencePill, {presence, ...extra}));
const banner = (presence?: PresenceRec, extra: Record<string, unknown> = {}) =>
  render(React.createElement(PeerOfflineBanner, {presence, ...extra}));

describe('formatLastSeen — boundaries', () => {
  it.each<[number, string]>([
    [NOW - 30_000, 'just now'],
    [NOW - 59_999, 'just now'],
    [NOW - 60_000, '1m ago'],
    [NOW - 3_599_999, '59m ago'],
    [NOW - 3_600_000, '1h ago'],
    [NOW - 86_399_999, '23h ago'],
    [NOW - 86_400_000, '1d ago'],
    [NOW - 6 * 86_400_000, '6d ago'],
  ])('%d → %s', (epochMs, expected) => {
    expect(formatLastSeen(epochMs)).toBe(expected);
  });

  it('older than 7 days falls back to a calendar date', () => {
    const s = formatLastSeen(NOW - 8 * 86_400_000);
    expect(s).not.toBeNull();
    expect(s).not.toMatch(/ago|just now/);
  });

  it('a date in a PREVIOUS calendar year includes the year (WhatsApp style)', () => {
    // "Last seen Apr 29" is ambiguous once the calendar rolls over.
    // NOW is 2025-07-23, so 300 days back lands in 2024.
    expect(formatLastSeen(NOW - 300 * 86_400_000)).toMatch(/2024/);
  });

  it('a same-year date older than 7 days still omits the year', () => {
    expect(formatLastSeen(NOW - 8 * 86_400_000)).not.toMatch(/\d{4}/);
  });

  it('a future timestamp is refused', () => {
    expect(formatLastSeen(NOW + 5_000)).toBeNull();
  });

  it.each([undefined, 0])('%p → null', v => {
    expect(formatLastSeen(v)).toBeNull();
  });
});

describe('PeerPresencePill — tier → label', () => {
  it('online → "Online"', () => {
    expect(textOf(pill({online: true, state: 'online'}))).toBe('Online');
  });

  it('active → "Active now"', () => {
    expect(textOf(pill({online: true, state: 'active'}))).toBe('Active now');
  });

  it('PRES-02: away beats the derived online boolean', () => {
    expect(textOf(pill({online: true, state: 'away'}))).toBe('Away');
  });

  it('offline within 5 minutes of last-seen → "Active recently"', () => {
    expect(textOf(pill({online: false, state: 'offline', lastSeen: NOW - 2 * 60_000})))
      .toBe('Active recently');
  });

  it('offline with an older last-seen → "Last seen …"', () => {
    expect(textOf(pill({online: false, state: 'offline', lastSeen: NOW - 3 * 3_600_000})))
      .toBe('Last seen 3h ago');
  });

  it('offline with no last-seen → "Offline"', () => {
    expect(textOf(pill({online: false, state: 'offline'}))).toBe('Offline');
  });

  it('no presence record at all → "Offline"', () => {
    expect(textOf(pill(undefined))).toBe('Offline');
  });

  it('an explicit label overrides the derived one', () => {
    expect(textOf(pill({online: true, state: 'online'}, {label: 'In call'}))).toBe('In call');
  });

  it('compact renders the dot only — no label text', () => {
    expect(textOf(pill({online: true, state: 'online'}, {compact: true}))).toBe('');
  });

  it('B-147 FIXED: a FUTURE last-seen no longer claims "Active recently"', () => {
    // A negative delta is clock skew, not recency. tier() and
    // formatLastSeen now agree about the same record.
    expect(textOf(pill({online: false, state: 'offline', lastSeen: NOW + 60_000})))
      .toBe('Offline');
  });

  it('B-147: the recency window is still open at its real boundaries', () => {
    // Guard against over-correcting: 0 and just-under-5min stay 'recent',
    // exactly-5min falls out.
    expect(textOf(pill({online: false, state: 'offline', lastSeen: NOW})))
      .toBe('Active recently');
    expect(textOf(pill({online: false, state: 'offline', lastSeen: NOW - (5 * 60_000 - 1)})))
      .toBe('Active recently');
    expect(textOf(pill({online: false, state: 'offline', lastSeen: NOW - 5 * 60_000})))
      .toBe('Last seen 5m ago');
  });
});

describe('PeerOfflineBanner — gating', () => {
  it.each<[string, PresenceRec]>([
    ['online', {online: true, state: 'online'}],
    ['active', {online: true, state: 'active'}],
    ['away', {online: true, state: 'away'}],
    ['recent', {online: false, state: 'offline', lastSeen: NOW - 60_000}],
  ])('never paints for a non-offline tier (%s)', (_k, presence) => {
    expect(banner(presence).toJSON()).toBeNull();
  });

  it('chat variant renders immediately with the last-seen line', () => {
    const r = banner(
      {online: false, state: 'offline', lastSeen: NOW - 2 * 3_600_000},
      {peerName: 'Bob'},
    );
    const t = textOf(r);
    expect(t).toContain('Bob are offline');
    expect(t).toContain('Last seen 2h ago');
  });

  it('chat variant omits the last-seen line when none is known', () => {
    const t = textOf(banner({online: false, state: 'offline'}));
    expect(t).toContain('are offline');
    expect(t).not.toContain('Last seen');
  });

  it('call variant is graced for 4s, then warns softly', () => {
    jest.useFakeTimers();
    const r = banner(
      // Note: the missed-call sub-line is gated on a KNOWN lastSeen —
      // without one the call banner renders its title only.
      {online: false, state: 'offline', lastSeen: NOW - 2 * 3_600_000},
      {variant: 'call', peerName: 'Bob'},
    );
    expect(r.toJSON()).toBeNull();
    act(() => { jest.advanceTimersByTime(4000); });
    const t = textOf(r);
    expect(t).toContain('Bob may be offline');
    expect(t).toContain('missed-call notification');
  });

  it('B-147 FIXED: a future last-seen no longer suppresses the offline banner', () => {
    // This was the sharper half of B-147 — clock skew hid the banner
    // outright, because it only paints for tier 'offline'.
    const t = textOf(banner(
      {online: false, state: 'offline', lastSeen: NOW + 60_000},
      {peerName: 'Bob'},
    ));
    expect(t).toContain('Bob are offline');
    // formatLastSeen still refuses the skewed stamp, so no bogus line.
    expect(t).not.toContain('Last seen');
  });
});
