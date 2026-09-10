import {parseDateMs, safeIso} from '../safeDate';

describe('parseDateMs', () => {
  it('parses a valid ISO string to epoch ms', () => {
    expect(parseDateMs('2026-01-15T10:30:00.000Z')).toBe(Date.parse('2026-01-15T10:30:00.000Z'));
  });

  it('parses a numeric epoch', () => {
    expect(parseDateMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('returns null for an unparseable string', () => {
    expect(parseDateMs('not-a-date')).toBeNull();
  });

  it('returns null for empty / null / undefined', () => {
    expect(parseDateMs('')).toBeNull();
    expect(parseDateMs(null)).toBeNull();
    expect(parseDateMs(undefined)).toBeNull();
  });
});

describe('safeIso', () => {
  it('round-trips a valid date', () => {
    expect(safeIso('2026-01-15T10:30:00.000Z')).toBe('2026-01-15T10:30:00.000Z');
  });

  it('does NOT throw on an invalid date (the rssClient crash)', () => {
    // new Date('garbage').toISOString() throws RangeError — safeIso must not.
    expect(() => safeIso('garbage')).not.toThrow();
  });

  it('falls back to the provided fallback for invalid input', () => {
    const fb = Date.parse('2020-01-01T00:00:00.000Z');
    expect(safeIso('garbage', fb)).toBe('2020-01-01T00:00:00.000Z');
  });

  it('falls back for empty input', () => {
    const fb = Date.parse('2020-01-01T00:00:00.000Z');
    expect(safeIso('', fb)).toBe('2020-01-01T00:00:00.000Z');
  });
});
