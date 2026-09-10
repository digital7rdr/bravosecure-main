/**
 * Secure Services Streamlined — GAP 1: the two booking dashboards show every
 * wall-clock time as 12-hour ("6:25 PM", never "18:25") and the Book Later
 * time snaps UP to the next 5-minute boundary. The formatter and the snap are
 * pure helpers shared by WheelTimePicker (12-hour mode) and both screens, so
 * the node `booking` project pins the arithmetic directly.
 */
import {formatTime12h, roundUpToMinuteStep, to12h, to24h} from '../../../components/booking/time12h';

describe('formatTime12h — "h:mm AM/PM", hour unpadded, minute padded', () => {
  it.each([
    [0, 5, '12:05 AM'],
    [0, 0, '12:00 AM'],
    [1, 0, '1:00 AM'],
    [11, 59, '11:59 AM'],
    [12, 0, '12:00 PM'],
    [12, 30, '12:30 PM'],
    [13, 5, '1:05 PM'],
    [18, 25, '6:25 PM'],
    [23, 55, '11:55 PM'],
  ])('%i:%i → %s', (h, m, out) => {
    expect(formatTime12h(h, m)).toBe(out);
  });

  it('never emits a 24-hour hour', () => {
    for (let h = 0; h < 24; h++) {
      const label = formatTime12h(h, 0);
      const hour = Number(label.split(':')[0]);
      expect(hour).toBeGreaterThanOrEqual(1);
      expect(hour).toBeLessThanOrEqual(12);
      expect(label).toMatch(/ (AM|PM)$/);
    }
  });
});

describe('to12h / to24h — a lossless round trip over the whole day', () => {
  it('maps midnight and noon to 12, AM and PM respectively', () => {
    expect(to12h(0)).toEqual({hour12: 12, pm: false});
    expect(to12h(12)).toEqual({hour12: 12, pm: true});
    expect(to12h(18)).toEqual({hour12: 6, pm: true});
    expect(to12h(6)).toEqual({hour12: 6, pm: false});
  });

  it('round-trips every hour 0-23', () => {
    for (let h = 0; h < 24; h++) {
      const {hour12, pm} = to12h(h);
      expect(hour12).toBeGreaterThanOrEqual(1);
      expect(hour12).toBeLessThanOrEqual(12);
      expect(to24h(hour12, pm)).toBe(h);
    }
  });

  it('12 AM is 0 and 12 PM is 12 (the two off-by-twelve traps)', () => {
    expect(to24h(12, false)).toBe(0);
    expect(to24h(12, true)).toBe(12);
  });
});

describe('roundUpToMinuteStep — Book Later snaps UP to the next 5-minute boundary', () => {
  const at = (h: number, m: number, s = 0) => new Date(2026, 7, 22, h, m, s, 0);

  it('rounds 18:22 up to 18:25 (never down)', () => {
    const out = roundUpToMinuteStep(at(18, 22), 5);
    expect([out.getHours(), out.getMinutes()]).toEqual([18, 25]);
  });

  it('leaves a time already on the boundary alone', () => {
    const out = roundUpToMinuteStep(at(18, 25), 5);
    expect([out.getHours(), out.getMinutes()]).toEqual([18, 25]);
  });

  it('clears seconds and milliseconds', () => {
    const out = roundUpToMinuteStep(new Date(2026, 7, 22, 9, 10, 45, 500), 5);
    expect(out.getSeconds()).toBe(0);
    expect(out.getMilliseconds()).toBe(0);
  });

  it('rolls over the hour and the day', () => {
    const h = roundUpToMinuteStep(at(18, 58), 5);
    expect([h.getHours(), h.getMinutes()]).toEqual([19, 0]);
    const d = roundUpToMinuteStep(at(23, 58), 5);
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([23, 0, 0]);
  });

  it('does not mutate its input', () => {
    const input = at(18, 22);
    const before = input.getTime();
    roundUpToMinuteStep(input, 5);
    expect(input.getTime()).toBe(before);
  });

  it('defaults to a 5-minute step', () => {
    expect(roundUpToMinuteStep(at(10, 1)).getMinutes()).toBe(5);
  });
});
