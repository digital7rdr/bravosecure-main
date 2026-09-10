// Why: the Schedule step (BookingDateTimeScreen) gates advancing to the next step
// on having the required locations. A point-to-point `transfer` needs BOTH a
// pick-up and a drop-off; hourly/itinerary bookings legitimately have no single
// destination, so they only require a pick-up. Extracted here so the gate is
// unit-testable without rendering the screen.
export const canAdvanceSchedule = (
  type: string | undefined,
  pickup: unknown,
  dropoff: unknown,
): boolean => Boolean(pickup) && (type !== 'transfer' || Boolean(dropoff));

/**
 * Issue 29 — which booking SHAPE a service uses.
 *
 * 'transfer' is point-to-point and needs a drop-off; everything else is
 * time-based (a duration at a location) and legitimately has none —
 * scheduleGate.canAdvanceSchedule already encodes that rule.
 *
 * This also closes a latent hole: ServiceTypeScreen used to set only `service`,
 * leaving `type` at its 'timeslot' default, so a Secure TRANSFER never required
 * a drop-off either.
 */
export function bookingTypeFor(service: string): 'transfer' | 'timeslot' {
  return service === 'secure_transfer' ? 'transfer' : 'timeslot';
}

/**
 * E-13 — minimum lead time (hours) for a scheduled ("later") booking. Client
 * mirror of `booking.service.ts` MIN_LEAD_HOURS. ONE definition: the Lite
 * schedule screen and the executive schedule screen previously each re-declared
 * it, so a server change would silently drift one of them.
 */
export const MIN_LEAD_HOURS = 3;
