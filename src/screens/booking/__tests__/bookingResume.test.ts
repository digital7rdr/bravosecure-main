import {resumeTargetFor, liveTargetFor, findResumableBooking, isUpcomingScheduled} from '../bookingStatus';

// LB-OTP1 / LB-ST2 — the booking FSM stays CONFIRMED for the whole mission, so
// resume/deep-link routing must key off mission_status (when present), not just
// booking.status. Regression guard for the "verify code / status frozen on
// resume" class of bugs.
describe('resumeTargetFor — mission-aware routing', () => {
  it('routes a plain CONFIRMED (no mission yet) to BookingConfirmation', () => {
    expect(resumeTargetFor('b1', 'CONFIRMED')).toEqual({screen: 'BookingConfirmation', bookingId: 'b1'});
  });

  it('routes CONFIRMED-with-a-live-mission straight to LiveTracking', () => {
    for (const ms of ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS']) {
      expect(resumeTargetFor('b1', 'CONFIRMED', ms)).toEqual({screen: 'LiveTracking', bookingId: 'b1'});
    }
  });

  it('does NOT divert to LiveTracking for a mission that ended (ABORTED/COMPLETED)', () => {
    expect(resumeTargetFor('b1', 'CONFIRMED', 'ABORTED')).toEqual({screen: 'BookingConfirmation', bookingId: 'b1'});
    // COMPLETED booking is terminal → no resume target.
    expect(resumeTargetFor('b1', 'COMPLETED', 'COMPLETED')).toBeNull();
  });

  it('keeps the pre-mission booking states intact', () => {
    expect(resumeTargetFor('b1', 'DISPATCHING')).toEqual({screen: 'FindingDetail', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'PENDING_OPS')).toEqual({screen: 'OpsRoomReview', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'LIVE')).toEqual({screen: 'LiveTracking', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'NO_PROVIDER')).toEqual({screen: 'NoDetail', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'CANCELLED')).toBeNull();
  });

  it('liveTargetFor reads both fields off a booking object', () => {
    expect(liveTargetFor({id: 'b1', status: 'CONFIRMED', mission_status: 'PICKUP'}))
      .toEqual({screen: 'LiveTracking', bookingId: 'b1'});
    expect(liveTargetFor({id: 'b1', status: 'CONFIRMED', mission_status: null}))
      .toEqual({screen: 'BookingConfirmation', bookingId: 'b1'});
  });
});

// B-405 — a parked FUTURE reservation ('later' + PENDING_OPS/OPS_APPROVED)
// must never auto-yank the user off Home: "after making a future booking it
// needs to go back to the normal screen" (founder, 2026-08-09).
describe('B-405 — parked future reservations do not trap the client', () => {
  it('isUpcomingScheduled recognises exactly the parked pre-dispatch later states', () => {
    expect(isUpcomingScheduled({status: 'PENDING_OPS', booking_mode: 'later'})).toBe(true);
    expect(isUpcomingScheduled({status: 'PENDING_OPS', booking_mode: 'later', dispatch_mode: null})).toBe(true);
    expect(isUpcomingScheduled({status: 'OPS_APPROVED', booking_mode: 'later', dispatch_mode: 'auto'})).toBe(true);
    // A LEGACY approved 'later' row owes payment NOW — it is ACTIVE, not
    // parked (3-agent review: parking it let the booking die unpaid at
    // pickup+60 behind a green APPROVED chip).
    expect(isUpcomingScheduled({status: 'OPS_APPROVED', booking_mode: 'later'})).toBe(false);
    expect(isUpcomingScheduled({status: 'OPS_APPROVED', booking_mode: 'later', dispatch_mode: null})).toBe(false);
    // A 'now' booking in the same states IS an active mission.
    expect(isUpcomingScheduled({status: 'PENDING_OPS', booking_mode: 'now'})).toBe(false);
    // Once dispatch starts (or payment/live phases), the reservation is active.
    for (const s of ['DISPATCHING', 'PAYMENT_PENDING', 'CONFIRMED', 'LIVE', 'COMPLETED', 'CANCELLED']) {
      expect(isUpcomingScheduled({status: s, booking_mode: 'later', dispatch_mode: 'auto'})).toBe(false);
    }
    // Legacy rows without booking_mode never match.
    expect(isUpcomingScheduled({status: 'OPS_APPROVED'})).toBe(false);
    expect(isUpcomingScheduled({status: 'OPS_APPROVED', booking_mode: null})).toBe(false);
  });

  it('findResumableBooking skips upcoming reservations but still resumes real missions', () => {
    const upcoming = {id: 'later1', status: 'OPS_APPROVED', booking_mode: 'later', dispatch_mode: 'auto'};
    const live = {id: 'now1', status: 'LIVE', booking_mode: 'now'};
    // Only the parked reservation → nothing to resume (user stays on Home).
    expect(findResumableBooking([upcoming])).toBeUndefined();
    // A genuinely live mission still resumes, even listed after the reservation.
    expect(findResumableBooking([upcoming, live])).toBe(live);
    // Once the sweep flips the reservation to DISPATCHING it resumes again.
    expect(findResumableBooking([{id: 'later1', status: 'DISPATCHING', booking_mode: 'later'}]))
      .toEqual({id: 'later1', status: 'DISPATCHING', booking_mode: 'later'});
    // A LEGACY approved 'later' booking resumes too — that yank into
    // OpsRoomReview is what runs its pay countdown.
    expect(findResumableBooking([{id: 'legacy1', status: 'OPS_APPROVED', booking_mode: 'later'}]))
      .toEqual({id: 'legacy1', status: 'OPS_APPROVED', booking_mode: 'later'});
  });
});
