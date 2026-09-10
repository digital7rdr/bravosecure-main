import {CONNECTION_LOST_THRESHOLD_MIN, LIVE_FIX_MAX_AGE_SEC} from './protection.constants';

export type StalenessState = 'idle' | 'live' | 'delayed' | 'unavailable';

export interface Staleness {
  /** Seconds since the newest fix's SERVER receive time, or null when none yet. */
  age_seconds: number | null;
  state: StalenessState;
}

/**
 * The §6 staleness ladder, computed from SERVER timestamps only:
 *   - `lastFixAt` is `protection_session_locations.received_at` (server clock),
 *   - `nowMs` is the server's `Date.now()`.
 * Both come from the same clock, so device drift can NEVER make a stale marker
 * look live (the trap that burned the group-call "stale" investigation).
 *
 *   no fix yet → idle · ≤45s → live · ≤3m → delayed · >3m → unavailable
 *
 * The caller renders `unavailable` as "Location unavailable — last update X min
 * ago" with a greyed marker; never a live-looking stale marker (rule 9).
 */
export function stalenessFor(lastFixAt: string | Date | null, nowMs: number): Staleness {
  if (!lastFixAt) {return {age_seconds: null, state: 'idle'};}
  const fixMs = lastFixAt instanceof Date ? lastFixAt.getTime() : new Date(lastFixAt).getTime();
  if (!Number.isFinite(fixMs)) {return {age_seconds: null, state: 'idle'};}
  const age = Math.max(0, Math.round((nowMs - fixMs) / 1000));
  if (age <= LIVE_FIX_MAX_AGE_SEC) {return {age_seconds: age, state: 'live'};}
  if (age <= CONNECTION_LOST_THRESHOLD_MIN * 60) {return {age_seconds: age, state: 'delayed'};}
  return {age_seconds: age, state: 'unavailable'};
}
