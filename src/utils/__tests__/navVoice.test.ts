/**
 * Voice-guidance timing pins.
 *
 * The failure modes this locks are the ones drivers actually notice: the same
 * turn announced twice, a backlog of three announcements firing at once after
 * the GPS stalls, a far-out warning played on a step too short to warrant it,
 * and voice history from the OLD route silencing the reroute.
 */
import {
  pickAnnouncement,
  phraseFallback,
  routeVoiceId,
  FALLBACK_TRIGGERS_M,
} from '../navVoice';
import type {DirectionsRoute, DirectionStep} from '../mapboxDirections';

const step = (over: Partial<DirectionStep> = {}): DirectionStep => ({
  instruction: 'Turn right onto Al Falah Street',
  bannerPrimary: 'Turn right onto Al Falah Street',
  bannerSecondary: null,
  maneuverType: 'turn',
  modifier: 'right',
  distanceM: 1200,
  location: {lng: 55.27, lat: 25.2},
  roadName: null,
  voice: [],
  ...over,
});

const route = (steps: DirectionStep[]): DirectionsRoute => ({
  coordinates: [{lng: 55.2, lat: 25.2}, {lng: 55.3, lat: 25.3}],
  distanceM: 4000,
  durationS: 600,
  maxspeedKph: null,
  steps,
});

const NONE: ReadonlySet<string> = new Set<string>();

describe('navVoice · Mapbox-supplied cues', () => {
  const withCues = step({
    voice: [
      {distanceAlongGeometryM: 1000, announcement: 'In 1 kilometre, turn right onto Al Falah Street'},
      {distanceAlongGeometryM: 400, announcement: 'In 400 metres, turn right onto Al Falah Street'},
      {distanceAlongGeometryM: 90, announcement: 'Turn right onto Al Falah Street'},
    ],
  });

  it('says nothing while the vehicle is still beyond the first trigger', () => {
    const d = pickAnnouncement({
      route: route([withCues]), stepIndex: 0, distanceToManeuverM: 1500,
      spoken: NONE, routeId: 'r1',
    });
    expect(d).toBeNull();
  });

  it('speaks the far cue once the vehicle reaches it', () => {
    const d = pickAnnouncement({
      route: route([withCues]), stepIndex: 0, distanceToManeuverM: 950,
      spoken: NONE, routeId: 'r1',
    });
    expect(d?.text).toBe('In 1 kilometre, turn right onto Al Falah Street');
    expect(d?.superseded).toEqual([]);
  });

  it('never repeats a cue that was already spoken', () => {
    const first = pickAnnouncement({
      route: route([withCues]), stepIndex: 0, distanceToManeuverM: 950,
      spoken: NONE, routeId: 'r1',
    });
    const again = pickAnnouncement({
      route: route([withCues]), stepIndex: 0, distanceToManeuverM: 930,
      spoken: new Set([first!.key]), routeId: 'r1',
    });
    expect(again).toBeNull();
  });

  it('after a GPS stall it speaks the IMMEDIATE turn and supersedes the backlog', () => {
    // Vehicle jumps from 1500 m to 50 m with nothing spoken: the driver needs
    // "turn right now", not the 1 km and 400 m warnings first.
    const d = pickAnnouncement({
      route: route([withCues]), stepIndex: 0, distanceToManeuverM: 50,
      spoken: NONE, routeId: 'r1',
    });
    expect(d?.text).toBe('Turn right onto Al Falah Street');
    expect(d?.superseded).toHaveLength(2);
    // And once those are recorded, nothing more fires for this step.
    const after = pickAnnouncement({
      route: route([withCues]), stepIndex: 0, distanceToManeuverM: 40,
      spoken: new Set([d!.key, ...d!.superseded]), routeId: 'r1',
    });
    expect(after).toBeNull();
  });

  it('a reroute mints a new routeId so the new cues are not suppressed', () => {
    const d = pickAnnouncement({
      route: route([withCues]), stepIndex: 0, distanceToManeuverM: 950,
      spoken: NONE, routeId: 'r1',
    });
    const afterReroute = pickAnnouncement({
      route: route([withCues]), stepIndex: 0, distanceToManeuverM: 950,
      spoken: new Set([d!.key]), routeId: 'r2',
    });
    expect(afterReroute).not.toBeNull();
    expect(afterReroute!.key).not.toBe(d!.key);
  });
});

describe('navVoice · fallback when the API returned no cues', () => {
  it('uses the 800/300/80 ladder', () => {
    expect(FALLBACK_TRIGGERS_M).toEqual([800, 300, 80]);
    const r = route([step()]);
    const far = pickAnnouncement({
      route: r, stepIndex: 0, distanceToManeuverM: 790, spoken: NONE, routeId: 'r1',
    });
    expect(far?.text).toBe('In 800 metres, turn right onto Al Falah Street');
    const near = pickAnnouncement({
      route: r, stepIndex: 0, distanceToManeuverM: 70,
      spoken: new Set([far!.key]), routeId: 'r1',
    });
    // The closest cue is spoken bare — no distance prefix.
    expect(near?.text).toBe('Turn right onto Al Falah Street');
  });

  it('does not fire a far warning on a step too short to justify it', () => {
    // A 90 m step must not trigger the 800 m or 300 m announcement, or the
    // turn is called out before the previous one is finished. At 85 m out the
    // only surviving trigger (80 m) has not been reached, so nothing is due.
    const shortStep = step({distanceM: 90});
    const r = route([shortStep]);
    expect(pickAnnouncement({
      route: r, stepIndex: 0, distanceToManeuverM: 85, spoken: NONE, routeId: 'r1',
    })).toBeNull();
    // Crossing the 80 m trigger speaks it bare, with no backlog behind it.
    const d = pickAnnouncement({
      route: r, stepIndex: 0, distanceToManeuverM: 70, spoken: NONE, routeId: 'r1',
    });
    expect(d?.text).toBe('Turn right onto Al Falah Street');
    expect(d?.superseded).toEqual([]);
  });

  it('announces arrival on the arrive step', () => {
    const arrive = step({
      maneuverType: 'arrive', modifier: null, distanceM: 40,
      bannerPrimary: 'You will arrive at your destination',
    });
    const d = pickAnnouncement({
      route: route([arrive]), stepIndex: 0, distanceToManeuverM: 30,
      spoken: NONE, routeId: 'r1',
    });
    expect(d?.text).toBe('You have arrived');
  });
});

describe('navVoice · phrasing', () => {
  it('downcases an ordinary sentence start after the distance prefix', () => {
    expect(phraseFallback(step(), 300)).toBe('In 300 metres, turn right onto Al Falah Street');
  });

  it('leaves a proper noun or road code alone', () => {
    expect(phraseFallback(step({bannerPrimary: 'E11 towards Dubai'}), 300))
      .toBe('In 300 metres, E11 towards Dubai');
  });

  it('renders kilometres above 1000 m', () => {
    const long = step({distanceM: 5000});
    // 800 m is the largest trigger, so exercise the formatter directly.
    expect(phraseFallback(long, 1200)).toContain('1.2 kilometres');
  });
});

describe('navVoice · guards', () => {
  it('returns null for a step index that is not in the route', () => {
    expect(pickAnnouncement({
      route: route([step()]), stepIndex: 7, distanceToManeuverM: 100,
      spoken: NONE, routeId: 'r1',
    })).toBeNull();
  });

  it('returns null for a non-finite or negative distance', () => {
    const r = route([step()]);
    expect(pickAnnouncement({
      route: r, stepIndex: 0, distanceToManeuverM: Number.NaN, spoken: NONE, routeId: 'r1',
    })).toBeNull();
    expect(pickAnnouncement({
      route: r, stepIndex: 0, distanceToManeuverM: -5, spoken: NONE, routeId: 'r1',
    })).toBeNull();
  });

  it('routeVoiceId changes when the leg target changes', () => {
    const r = route([step()]);
    expect(routeVoiceId(r, 'P:55.1,25.1')).not.toBe(routeVoiceId(r, 'D:55.9,25.9'));
  });
});
