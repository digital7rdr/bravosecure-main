/**
 * CN-09 — poor-connection banner logic (classifier + debounce gate).
 *
 * The failure modes this pins:
 *  - a missing stats row (null metric) must never read as "poor" — stats are
 *    transiently absent mid-renegotiation, and a banner that flashes on every
 *    renegotiation trains the user to ignore it;
 *  - the banner must not flap: 3 consecutive poor samples to show, 6
 *    consecutive good ones to hide (asymmetric by design);
 *  - a single good sample inside a bad stretch resets the show streak but
 *    must NOT hide an already-visible banner.
 */
import {createQualityGate, isPoorSample} from '../runtime/callQuality';

const good = {rttMs: 80, jitterMs: 15, packetLossPct: 0};
const poor = {rttMs: 900, jitterMs: 15, packetLossPct: 0};

describe('isPoorSample — thresholds', () => {
  it.each([
    [{rttMs: 501, jitterMs: null, packetLossPct: null}, true],
    [{rttMs: 500, jitterMs: null, packetLossPct: null}, false],
    [{rttMs: null, jitterMs: 81, packetLossPct: null}, true],
    [{rttMs: null, jitterMs: 80, packetLossPct: null}, false],
    [{rttMs: null, jitterMs: null, packetLossPct: 8}, true],
    [{rttMs: null, jitterMs: null, packetLossPct: 7}, false],
  ])('%o → %s', (sample, expected) => {
    expect(isPoorSample(sample)).toBe(expected);
  });

  it('all-null (no stats yet) is NOT poor', () => {
    expect(isPoorSample({rttMs: null, jitterMs: null, packetLossPct: null})).toBe(false);
  });
});

describe('createQualityGate — debounce', () => {
  it('shows only after 3 consecutive poor samples', () => {
    const g = createQualityGate();
    expect(g.next(poor)).toBe(false);
    expect(g.next(poor)).toBe(false);
    expect(g.next(poor)).toBe(true);
  });

  it('a good sample mid-stretch resets the show streak', () => {
    const g = createQualityGate();
    g.next(poor);
    g.next(poor);
    g.next(good);
    expect(g.next(poor)).toBe(false);
    expect(g.next(poor)).toBe(false);
    expect(g.next(poor)).toBe(true);
  });

  it('hides only after 6 consecutive good samples — no flap', () => {
    const g = createQualityGate();
    g.next(poor); g.next(poor); g.next(poor);
    expect(g.visible()).toBe(true);
    // 5 good samples: still visible (a brief lull must not clear the warning).
    for (let i = 0; i < 5; i++) {expect(g.next(good)).toBe(true);}
    // A poor sample resets the hide streak entirely.
    expect(g.next(poor)).toBe(true);
    for (let i = 0; i < 5; i++) {expect(g.next(good)).toBe(true);}
    expect(g.next(good)).toBe(false);
  });

  it('reset() disarms everything (call teardown)', () => {
    const g = createQualityGate();
    g.next(poor); g.next(poor); g.next(poor);
    g.reset();
    expect(g.visible()).toBe(false);
    expect(g.next(poor)).toBe(false); // streak restarted from zero
  });
});
