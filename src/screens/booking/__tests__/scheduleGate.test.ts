import {canAdvanceSchedule} from '../scheduleGate';

const loc = {address: 'x', lat: 25.2, lng: 55.3};

describe('canAdvanceSchedule (#3 pickup/dropoff gating)', () => {
  it('blocks a transfer with no pickup', () => {
    expect(canAdvanceSchedule('transfer', null, loc)).toBe(false);
  });

  it('blocks a transfer with no dropoff', () => {
    expect(canAdvanceSchedule('transfer', loc, null)).toBe(false);
  });

  it('blocks a transfer with neither', () => {
    expect(canAdvanceSchedule('transfer', null, null)).toBe(false);
  });

  it('allows a transfer once both pickup and dropoff are set', () => {
    expect(canAdvanceSchedule('transfer', loc, loc)).toBe(true);
  });

  it('requires only pickup for a timeslot (hourly) booking', () => {
    expect(canAdvanceSchedule('timeslot', loc, null)).toBe(true);
    expect(canAdvanceSchedule('timeslot', null, null)).toBe(false);
  });

  it('requires only pickup for an itinerary booking', () => {
    expect(canAdvanceSchedule('itinerary', loc, null)).toBe(true);
    expect(canAdvanceSchedule('itinerary', null, loc)).toBe(false);
  });
});
