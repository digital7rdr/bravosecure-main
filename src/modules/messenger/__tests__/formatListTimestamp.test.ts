import {formatListTimestamp} from '@utils/helpers';

/**
 * BS-TS1 — conversation-list rows previously printed time-of-day only,
 * so a week-old chat read "14:32", indistinguishable from one sent
 * minutes ago. formatListTimestamp adds relative-date tiers. `now` is
 * injected for determinism.
 */
describe('formatListTimestamp', () => {
  const now = new Date('2026-05-30T15:00:00');

  it('shows time-of-day for a message earlier today', () => {
    const out = formatListTimestamp(new Date('2026-05-30T09:05:00'), now);
    expect(out).toMatch(/^\d{2}:\d{2}$/); // HH:mm
  });

  it('shows "Yesterday" for a message one calendar day back', () => {
    expect(formatListTimestamp(new Date('2026-05-29T23:59:00'), now)).toBe('Yesterday');
  });

  it('shows a weekday for a message within the last week', () => {
    // 2026-05-26 is 4 days before 2026-05-30.
    const out = formatListTimestamp(new Date('2026-05-26T10:00:00'), now);
    expect(out).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
  });

  it('shows a short date for a message older than a week', () => {
    const out = formatListTimestamp(new Date('2026-05-10T10:00:00'), now);
    expect(out).toBe('10/05/2026');
  });

  it('treats a future-ish same-day timestamp as today (time), not yesterday', () => {
    const out = formatListTimestamp(new Date('2026-05-30T15:30:00'), now);
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });

  it('accepts an ISO string as well as a Date', () => {
    expect(formatListTimestamp('2026-05-29T12:00:00', now)).toBe('Yesterday');
  });
});
