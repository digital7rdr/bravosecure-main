import {stalenessFor} from './protection.staleness';

// Fixed server "now" so the ladder boundaries are deterministic.
const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

describe('stalenessFor — §6 ladder, server clock only', () => {
  it('no fix yet → idle (a REQUESTED session that never streamed)', () => {
    expect(stalenessFor(null, NOW)).toEqual({age_seconds: null, state: 'idle'});
  });

  it('≤45s → live', () => {
    expect(stalenessFor(ago(0), NOW).state).toBe('live');
    expect(stalenessFor(ago(45), NOW).state).toBe('live');
  });

  it('45s–3m → delayed', () => {
    expect(stalenessFor(ago(46), NOW).state).toBe('delayed');
    expect(stalenessFor(ago(180), NOW).state).toBe('delayed');
  });

  it('>3m → unavailable (never a live-looking stale marker, rule 9)', () => {
    expect(stalenessFor(ago(181), NOW).state).toBe('unavailable');
    expect(stalenessFor(ago(3600), NOW).state).toBe('unavailable');
  });

  it('reports a non-negative integer age even if a fix is slightly in the future (clock skew)', () => {
    const s = stalenessFor(new Date(NOW + 5000).toISOString(), NOW);
    expect(s.age_seconds).toBe(0);
    expect(s.state).toBe('live');
  });

  it('garbage timestamp degrades to idle, never throws', () => {
    expect(stalenessFor('not-a-date', NOW)).toEqual({age_seconds: null, state: 'idle'});
  });
});
