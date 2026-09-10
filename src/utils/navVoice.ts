/**
 * Voice guidance for the driver navigation flow — the DECISION half.
 *
 * Deliberately pure and provider-free: given the live route, which maneuver is
 * next, how far the vehicle still is from it, and what has already been said,
 * this decides what should be spoken RIGHT NOW. No timers, no audio, no
 * platform module — so the announcement timing is unit-testable, which is the
 * part that actually goes wrong (repeating a turn, announcing three cues at
 * once after a GPS jump, or speaking a turn the driver already took).
 *
 * The speaking half lives in the screen, which owns the mute toggle and the
 * "is a call in progress" gate.
 *
 * Mapbox is the preferred source: with voice_instructions=true each step
 * carries its own phrased announcements and the distance-before-the-maneuver
 * at which each should play. When the API returns none (older cached route,
 * a profile without them) we synthesize cues from the banner text at fixed
 * distances so guidance still works.
 */
import type {DirectionsRoute, DirectionStep} from './mapboxDirections';

export interface VoiceDecision {
  /** Stable id for this announcement; the caller records it as spoken. */
  key: string;
  text: string;
  /**
   * Cues that are now moot because the vehicle is already closer than their
   * trigger distance. The caller must record these as spoken too, or a later
   * fix will fire them and stack stale announcements.
   */
  superseded: string[];
}

export interface VoiceInput {
  route: DirectionsRoute;
  /** Index into route.steps of the maneuver being approached. */
  stepIndex: number;
  /** Live distance from the vehicle to that maneuver, in metres. */
  distanceToManeuverM: number;
  /** Keys already announced for the CURRENT route. */
  spoken: ReadonlySet<string>;
  /**
   * Identity of the route these keys belong to. A reroute mints a new id, so
   * the new route's cues are not suppressed by the old route's history.
   */
  routeId: string;
}

/** Fallback trigger distances (metres) when the API supplied no voice cues. */
export const FALLBACK_TRIGGERS_M = [800, 300, 80] as const;

/** Below this, an 'arrive' step is announced as arrival. */
const ARRIVAL_M = 60;

function cueKey(routeId: string, stepIndex: number, triggerM: number): string {
  return `${routeId}#${stepIndex}@${Math.round(triggerM)}`;
}

/**
 * Phrase a fallback announcement. The nearest trigger is spoken bare ("Turn
 * left onto Al Falah Street"); farther ones are prefixed with the distance,
 * which is how drivers expect to hear them.
 */
export function phraseFallback(step: DirectionStep, triggerM: number): string {
  const what = (step.bannerPrimary || step.instruction || '').trim();
  if (!what) {
    return '';
  }
  if (step.maneuverType === 'arrive') {
    return triggerM <= FALLBACK_TRIGGERS_M[2] ? 'You have arrived' : `In ${fmt(triggerM)}, you arrive`;
  }
  if (triggerM <= FALLBACK_TRIGGERS_M[2]) {
    return what;
  }
  return `In ${fmt(triggerM)}, ${lowerFirst(what)}`;
}

function fmt(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} kilometres` : `${Math.round(m)} metres`;
}

/** "Turn left…" → "turn left…", but leave an acronym/proper start alone. */
function lowerFirst(s: string): string {
  if (s.length < 2) {
    return s;
  }
  // Only downcase when the second character is lowercase — protects "E11", "Al Raha".
  return /[a-z]/.test(s[1]) ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * Decide the announcement for this tick, or null when nothing is due.
 *
 * Picks the NEAREST un-spoken cue that the vehicle has already reached, and
 * reports the farther un-spoken ones as superseded rather than queueing them —
 * after a tunnel or a stalled GPS the driver wants the turn that is coming up,
 * not a backlog.
 */
export function pickAnnouncement(input: VoiceInput): VoiceDecision | null {
  const {route, stepIndex, distanceToManeuverM, spoken, routeId} = input;
  const step = route.steps[stepIndex];
  if (!step) {
    return null;
  }
  if (!Number.isFinite(distanceToManeuverM) || distanceToManeuverM < 0) {
    return null;
  }

  // Reached cues, ordered far → near.
  const reached: Array<{key: string; text: string}> = [];

  if (step.voice.length > 0) {
    for (const cue of step.voice) {
      if (distanceToManeuverM <= cue.distanceAlongGeometryM) {
        reached.push({
          key: cueKey(routeId, stepIndex, cue.distanceAlongGeometryM),
          text: cue.announcement,
        });
      }
    }
  } else {
    for (const trigger of FALLBACK_TRIGGERS_M) {
      // Only fire a fallback cue that is actually relevant to this step: a
      // 800 m warning on a 90 m step would announce the turn before the
      // previous one is complete.
      if (trigger > step.distanceM && trigger > FALLBACK_TRIGGERS_M[2]) {
        continue;
      }
      if (distanceToManeuverM <= trigger) {
        const text = phraseFallback(step, trigger);
        if (text) {
          reached.push({key: cueKey(routeId, stepIndex, trigger), text});
        }
      }
    }
    if (step.maneuverType === 'arrive' && distanceToManeuverM <= ARRIVAL_M) {
      const key = cueKey(routeId, stepIndex, 0);
      if (!reached.some(r => r.key === key)) {
        reached.push({key, text: 'You have arrived'});
      }
    }
  }

  const fresh = reached.filter(r => !spoken.has(r.key));
  if (fresh.length === 0) {
    return null;
  }
  // reached is far → near, so the last fresh entry is the most immediate.
  const pick = fresh[fresh.length - 1];
  return {
    key: pick.key,
    text: pick.text,
    superseded: fresh.slice(0, -1).map(r => r.key),
  };
}

/**
 * Identity for a fetched route, so voice history resets on a reroute but not
 * on an ordinary re-render. Uses the leg target plus the step count AND the
 * route length rather than object identity, which changes on every poll. The
 * length matters: a reroute that happened to keep the same number of steps
 * would otherwise reuse the old id and stay silent through its new turns.
 */
export function routeVoiceId(route: DirectionsRoute, targetKey: string): string {
  return `${targetKey}|${route.steps.length}|${Math.round(route.distanceM)}`;
}
