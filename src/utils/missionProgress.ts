/**
 * The mission progress label — one stage-aware function, shared by the client
 * tracker's map pill and any other surface that needs it.
 *
 * The founder's deck asked for progress that "updates consistently and is
 * linked to pickup and drop-off mission states". Two things were wrong before:
 *
 *  - it was a bare percentage to "B", which read 0% for the entire approach to
 *    the pickup and told the client nothing they could act on;
 *  - it was gated on the BOOKING being LIVE, and `lite_bookings.status` only
 *    flips to LIVE in the same transaction that sets the mission LIVE — so the
 *    whole approach leg showed nothing, and the "to pickup" wording was
 *    unreachable on the normal auto-dispatch path.
 *
 * Pure, so the leg boundaries (pre-pickup / at pickup / post-pickup / arrival)
 * can be unit-tested rather than reasoned about.
 */
import {formatDistance} from './mapboxDirections';

/** Which end of the journey the remaining distance is measured to. */
export type MissionLeg = 'pickup' | 'dropoff';

export interface MissionProgressInput {
  /** missions.status, any case. Empty/absent before a crew accepts. */
  missionStatus: string | null | undefined;
  /** lite_bookings.status, any case. */
  bookingStatus?: string | null | undefined;
  /** Metres remaining along the live route, or null when unknown. */
  remainingM: number | null;
  /** Whether the position driving `remainingM` is a REAL device fix. */
  hasRealFix: boolean;
}

export interface MissionProgress {
  leg: MissionLeg;
  /** The pill text. Never empty. */
  label: string;
  /** False when we are honestly saying we do not know yet. */
  known: boolean;
}

const up = (v: string | null | undefined): string => (v ?? '').toUpperCase();

/**
 * Once protection is active the vehicle is carrying the principal, so the
 * remaining distance is to the DROP-OFF. SOS counts as active — it is a live
 * drive, and treating it as an approach said "to pickup" mid-mission.
 */
export function missionLeg(
  missionStatus: string | null | undefined,
  bookingStatus?: string | null | undefined,
): MissionLeg {
  const m = up(missionStatus);
  return m === 'LIVE' || m === 'SOS' || up(bookingStatus) === 'LIVE' ? 'dropoff' : 'pickup';
}

export function missionProgress(input: MissionProgressInput): MissionProgress {
  const leg = missionLeg(input.missionStatus, input.bookingStatus);
  const legWord = leg === 'dropoff' ? 'to drop-off' : 'to pickup';

  // Only a real fix may move the pill: a simulated or pickup-parked position
  // would otherwise count down a distance nobody is travelling.
  if (!input.hasRealFix || input.remainingM === null || !Number.isFinite(input.remainingM)) {
    return {leg, label: 'Awaiting live GPS', known: false};
  }
  return {leg, label: `${formatDistance(input.remainingM)} ${legWord}`, known: true};
}
