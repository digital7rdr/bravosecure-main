/**
 * PDF-1 #6 — formatDateRanges: raw ISO date lists rendered as clean
 * "DD Mon YYYY" ranges (consecutive UTC days collapsed into runs).
 */
import {formatDateRanges} from '../datetime';

describe('formatDateRanges', () => {
  it('collapses a consecutive run into one range', () => {
    expect(
      formatDateRanges(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']),
    ).toBe('01 Sep 2026 to 05 Sep 2026');
  });

  it('renders a single day as just that date', () => {
    expect(formatDateRanges(['2026-09-01'])).toBe('01 Sep 2026');
  });

  it('groups non-consecutive dates into separate runs joined by " · "', () => {
    expect(
      formatDateRanges(['2026-09-01', '2026-09-02', '2026-09-05']),
    ).toBe('01 Sep 2026 to 02 Sep 2026 · 05 Sep 2026');
  });

  it('keeps two multi-day runs distinct', () => {
    expect(
      formatDateRanges(['2026-09-01', '2026-09-02', '2026-09-10', '2026-09-11']),
    ).toBe('01 Sep 2026 to 02 Sep 2026 · 10 Sep 2026 to 11 Sep 2026');
  });

  it('sorts unsorted input before grouping', () => {
    expect(
      formatDateRanges(['2026-09-05', '2026-09-01', '2026-09-03', '2026-09-02', '2026-09-04']),
    ).toBe('01 Sep 2026 to 05 Sep 2026');
  });

  it('dedupes repeated dates', () => {
    expect(
      formatDateRanges(['2026-09-01', '2026-09-01', '2026-09-02']),
    ).toBe('01 Sep 2026 to 02 Sep 2026');
  });

  it('treats a month boundary as consecutive (UTC calendar days)', () => {
    expect(formatDateRanges(['2026-08-31', '2026-09-01'])).toBe('31 Aug 2026 to 01 Sep 2026');
  });

  it('returns "—" for an empty list', () => {
    expect(formatDateRanges([])).toBe('—');
  });

  it('ignores invalid entries', () => {
    expect(formatDateRanges(['', 'not-a-date', '2026-09-02'])).toBe('02 Sep 2026');
  });
});

/**
 * PDF-1 #6 follow-up — the client's wording is "Booked from 01 Sep 2026 to
 * 05 Sep 2026": an OPTIONAL status prefix turns the bare range into a sentence.
 * Without a prefix every output above is unchanged (pinned by the suite above).
 */
describe('formatDateRanges — status prefix', () => {
  it('single multi-day run: "<prefix> from A to B"', () => {
    expect(
      formatDateRanges(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'], {prefix: 'Booked'}),
    ).toBe('Booked from 01 Sep 2026 to 05 Sep 2026');
  });

  it('single day: "<prefix> on A"', () => {
    expect(formatDateRanges(['2026-09-01'], {prefix: 'Requested'})).toBe('Requested on 01 Sep 2026');
  });

  it('several runs: "<prefix> for R1 · R2" (one sentence, runs kept distinct)', () => {
    expect(
      formatDateRanges(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-07', '2026-09-08'], {prefix: 'Booked'}),
    ).toBe('Booked for 01 Sep 2026 to 03 Sep 2026 · 07 Sep 2026 to 08 Sep 2026');
    expect(
      formatDateRanges(['2026-09-01', '2026-09-02', '2026-09-05'], {prefix: 'Scheduled'}),
    ).toBe('Scheduled for 01 Sep 2026 to 02 Sep 2026 · 05 Sep 2026');
  });

  it('an empty/blank prefix is the bare range', () => {
    expect(formatDateRanges(['2026-09-01', '2026-09-02'], {prefix: ''})).toBe('01 Sep 2026 to 02 Sep 2026');
    expect(formatDateRanges(['2026-09-01', '2026-09-02'], {prefix: '  '})).toBe('01 Sep 2026 to 02 Sep 2026');
    expect(formatDateRanges(['2026-09-01', '2026-09-02'], {})).toBe('01 Sep 2026 to 02 Sep 2026');
  });

  it('empty input stays "—" even with a prefix', () => {
    expect(formatDateRanges([], {prefix: 'Booked'})).toBe('—');
    expect(formatDateRanges(['not-a-date'], {prefix: 'Booked'})).toBe('—');
  });
});
