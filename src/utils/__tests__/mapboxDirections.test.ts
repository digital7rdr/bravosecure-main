// babel-preset-expo rewrites `process.env.EXPO_PUBLIC_*` into an import from
// `expo/virtual/env`, which the app project does not transform. Stub it so the
// pure helpers are importable under jest (no token → fetchDirections short-circuits).
jest.mock('expo/virtual/env', () => ({env: process.env}), {virtual: true});

import {
  haversineM,
  nearestIndexOnRoute,
  offRouteDistanceM,
  remainingRouteM,
  splitRouteAtProgress,
  nextManeuver,
  formatDistance,
  parseDirectionsRoute,
  speedLimitAtKph,
  currentRoadName,
  fetchDirections,
  type DirectionsRoute,
  type LngLat,
} from '../mapboxDirections';

// A simple west→east route along the equator: 5 vertices ~100 m apart-ish.
const ROUTE: LngLat[] = [
  {lng: 55.2700, lat: 25.2000},
  {lng: 55.2710, lat: 25.2000},
  {lng: 55.2720, lat: 25.2000},
  {lng: 55.2730, lat: 25.2000},
  {lng: 55.2740, lat: 25.2000},
];

describe('mapboxDirections · geo helpers', () => {
  it('haversineM ~111 km per degree of latitude', () => {
    const d = haversineM({lng: 0, lat: 0}, {lng: 0, lat: 1});
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });

  it('haversineM is zero for identical points', () => {
    expect(haversineM({lng: 55.27, lat: 25.2}, {lng: 55.27, lat: 25.2})).toBe(0);
  });

  it('nearestIndexOnRoute snaps to the closest vertex', () => {
    expect(nearestIndexOnRoute(ROUTE, {lng: 55.27205, lat: 25.2001})).toBe(2);
    expect(nearestIndexOnRoute(ROUTE, {lng: 55.2699, lat: 25.2})).toBe(0);
    expect(nearestIndexOnRoute(ROUTE, {lng: 55.2741, lat: 25.2})).toBe(4);
  });

  it('offRouteDistanceM is small on-route and large off-route', () => {
    expect(offRouteDistanceM(ROUTE, {lng: 55.2720, lat: 25.2000})).toBeLessThan(5);
    expect(offRouteDistanceM(ROUTE, {lng: 55.2720, lat: 25.2100})).toBeGreaterThan(900);
  });
});

describe('mapboxDirections · splitRouteAtProgress', () => {
  it('splits traveled (behind) from remaining (ahead, starting at the guard)', () => {
    const guard = {lng: 55.27205, lat: 25.2000}; // nearest = idx 2
    const {traveled, remaining} = splitRouteAtProgress(ROUTE, guard);
    expect(traveled).toHaveLength(3); // vertices 0,1,2
    expect(traveled[0]).toEqual(ROUTE[0]);
    expect(remaining[0]).toEqual(guard); // ahead-line starts at the dot
    expect(remaining[remaining.length - 1]).toEqual(ROUTE[4]);
  });

  it('degrades safely on a sub-2-vertex route', () => {
    const {traveled, remaining} = splitRouteAtProgress([ROUTE[0]], {lng: 55.27, lat: 25.2});
    expect(traveled).toHaveLength(0);
    expect(remaining).toHaveLength(1);
  });
});

describe('mapboxDirections · nextManeuver', () => {
  const route: DirectionsRoute = {
    coordinates: ROUTE,
    distanceM: 400,
    durationS: 90,
    maxspeedKph: null,
    steps: [
      {instruction: 'Head east', bannerPrimary: 'Head east', bannerSecondary: null,
        maneuverType: 'depart', modifier: null, distanceM: 100, location: ROUTE[0], roadName: null, voice: []},
      {instruction: 'Turn left onto Al Khail Rd', bannerPrimary: 'Turn left', bannerSecondary: 'Al Khail Rd',
        maneuverType: 'turn', modifier: 'left', distanceM: 200, location: ROUTE[2], roadName: 'Al Khail Rd', voice: []},
      {instruction: 'Arrive at destination', bannerPrimary: 'Arrive', bannerSecondary: null,
        maneuverType: 'arrive', modifier: null, distanceM: 0, location: ROUTE[4], roadName: null, voice: []},
    ],
  };

  it('returns the upcoming turn while the guard is before it', () => {
    const m = nextManeuver(route, {lng: 55.2711, lat: 25.2000}); // nearest idx 1, before the turn at idx 2
    expect(m?.step.maneuverType).toBe('turn');
    expect(m?.step.bannerSecondary).toBe('Al Khail Rd');
    expect(m?.distanceM).toBeGreaterThan(0);
  });

  it('advances to arrival once the turn is passed', () => {
    const m = nextManeuver(route, {lng: 55.2735, lat: 25.2000}); // nearest idx 3, past the turn
    expect(m?.step.maneuverType).toBe('arrive');
  });

  it('still shows the turn while the guard is standing exactly on it (turn-now boundary)', () => {
    const m = nextManeuver(route, {lng: 55.2720, lat: 25.2000}); // nearest idx 2 == the turn vertex
    expect(m?.step.maneuverType).toBe('turn');
  });

  it('returns null when there are no steps', () => {
    expect(nextManeuver({...route, steps: []}, ROUTE[0])).toBeNull();
  });
});

describe('mapboxDirections · remainingRouteM (live ETA basis)', () => {
  it('is ~full length at the start and ~zero near the end', () => {
    const atStart = remainingRouteM(ROUTE, ROUTE[0]);
    const atEnd = remainingRouteM(ROUTE, ROUTE[ROUTE.length - 1]);
    expect(atStart).toBeGreaterThan(atEnd);
    expect(atEnd).toBeLessThan(20); // essentially arrived
  });

  it('decreases monotonically as the guard advances along the route', () => {
    const early = remainingRouteM(ROUTE, {lng: 55.2710, lat: 25.2000});
    const later = remainingRouteM(ROUTE, {lng: 55.2730, lat: 25.2000});
    expect(later).toBeLessThan(early);
  });

  it('returns 0 for a degenerate route', () => {
    expect(remainingRouteM([ROUTE[0]], ROUTE[0])).toBe(0);
  });
});

describe('mapboxDirections · formatDistance', () => {
  it.each([
    [0, '0 m'],
    [-5, '0 m'],
    [204, '200 m'],
    [206, '210 m'],
    [950, '950 m'],
    [1240, '1.2 km'],
    [12400, '12 km'],
  ])('formats %d m as %s', (m, label) => {
    expect(formatDistance(m)).toBe(label);
  });
});

describe('mapboxDirections · parseDirectionsRoute', () => {
  const raw = {
    distance: 412.5,
    duration: 97.2,
    geometry: {coordinates: [[55.27, 25.2], [55.271, 25.2], [55.272, 25.2]] as [number, number][]},
    legs: [{
      steps: [
        {
          distance: 120,
          maneuver: {type: 'depart', instruction: 'Head east', location: [55.27, 25.2] as [number, number]},
          bannerInstructions: [{primary: {text: 'Head east on Marasi Dr'}, secondary: null}],
        },
        {
          distance: 200,
          maneuver: {type: 'turn', modifier: 'left', instruction: 'Turn left onto Al Khail Road', location: [55.271, 25.2] as [number, number]},
          bannerInstructions: [{primary: {text: 'Turn left'}, secondary: {text: 'Al Khail Road'}}],
        },
        // No maneuver.location — must be filtered out, not crash.
        {distance: 0, maneuver: {type: 'arrive', instruction: 'Arrive'}},
      ],
    }],
  };

  it('maps distance/duration/coordinates and banner text', () => {
    const route = parseDirectionsRoute(raw)!;
    expect(route.distanceM).toBe(412.5);
    expect(route.durationS).toBe(97.2);
    expect(route.coordinates).toHaveLength(3);
    expect(route.coordinates[0]).toEqual({lng: 55.27, lat: 25.2});
    expect(route.steps).toHaveLength(2); // arrival without location filtered out
    expect(route.steps[0].bannerPrimary).toBe('Head east on Marasi Dr');
    expect(route.steps[1].bannerPrimary).toBe('Turn left');
    expect(route.steps[1].bannerSecondary).toBe('Al Khail Road');
    expect(route.steps[1].modifier).toBe('left');
  });

  it('returns null when the geometry is missing or too short', () => {
    expect(parseDirectionsRoute({})).toBeNull();
    expect(parseDirectionsRoute({geometry: {coordinates: [[55.27, 25.2]]}})).toBeNull();
  });

  it('falls back to the maneuver instruction when banners are absent', () => {
    const route = parseDirectionsRoute({
      geometry: {coordinates: [[0, 0], [1, 1]]},
      legs: [{steps: [{distance: 10, maneuver: {type: 'turn', instruction: 'Turn right', location: [0, 0]}}]}],
    })!;
    expect(route.steps[0].bannerPrimary).toBe('Turn right');
    expect(route.steps[0].bannerSecondary).toBeNull();
  });
});

describe('mapboxDirections · fetchDirections', () => {
  it('returns null without a Mapbox token (no network call)', async () => {
    // EXPO_PUBLIC_MAPBOX_TOKEN is unset under test, so the token guard short-circuits.
    const out = await fetchDirections({lng: 55.27, lat: 25.2}, {lng: 55.28, lat: 25.21});
    expect(out).toBeNull();
  });

  it('defaults to the congestion-aware driving-traffic profile', async () => {
    const prev = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
    process.env.EXPO_PUBLIC_MAPBOX_TOKEN = 'pk.test-token';
    const fetchMock = jest.fn().mockResolvedValue({ok: false});
    const realFetch = (global as {fetch?: unknown}).fetch;
    (global as {fetch: unknown}).fetch = fetchMock;
    try {
      jest.resetModules();
      // TOKEN is captured at module load — re-require with the token set.
      const mod = require('../mapboxDirections') as {fetchDirections: typeof fetchDirections};
      await mod.fetchDirections({lng: 55.27, lat: 25.2}, {lng: 55.28, lat: 25.21});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain('/directions/v5/mapbox/driving-traffic/');
    } finally {
      (global as {fetch?: unknown}).fetch = realFetch;
      if (prev === undefined) {delete process.env.EXPO_PUBLIC_MAPBOX_TOKEN;}
      else {process.env.EXPO_PUBLIC_MAPBOX_TOKEN = prev;}
      jest.resetModules();
    }
  });
});

// ─── Navigation.docx (2026-08-26) — road name + speed limit ──────────────────
// The Waze/Google reference screens show the road being driven on, the legal
// limit in red and the vehicle speed in black. Road name rides `step.name`;
// the limit rides `annotations=maxspeed` on the SAME response.
describe('mapboxDirections · road name + maxspeed (Navigation.docx)', () => {
  const rawNav = {
    distance: 300,
    duration: 60,
    geometry: {coordinates: [[55.27, 25.2], [55.271, 25.2], [55.272, 25.2], [55.273, 25.2]] as [number, number][]},
    legs: [{
      steps: [
        {distance: 150, name: 'Marasi Dr', maneuver: {type: 'depart', instruction: 'Head east', location: [55.27, 25.2] as [number, number]}},
        {distance: 150, name: 'Al Khail Road', maneuver: {type: 'turn', modifier: 'left', instruction: 'Turn left', location: [55.272, 25.2] as [number, number]}},
        {distance: 0, name: '', maneuver: {type: 'arrive', instruction: 'Arrive', location: [55.273, 25.2] as [number, number]}},
      ],
      annotation: {maxspeed: [
        {speed: 60, unit: 'km/h'},
        {speed: 50, unit: 'mph'},
        {unknown: true},
      ]},
    }],
  };

  it('parses step.name into roadName (empty → null)', () => {
    const route = parseDirectionsRoute(rawNav)!;
    expect(route.steps[0].roadName).toBe('Marasi Dr');
    expect(route.steps[1].roadName).toBe('Al Khail Road');
    expect(route.steps[2].roadName).toBeNull();
  });

  it('parses maxspeed per segment: km/h passthrough, mph converted, unknown/none → null', () => {
    const route = parseDirectionsRoute(rawNav)!;
    expect(route.maxspeedKph).toEqual([60, 80, null]); // 50 mph → 80 km/h
  });

  it('a response without the annotation yields maxspeedKph null, never a guess', () => {
    const route = parseDirectionsRoute({
      distance: 100, duration: 20,
      geometry: {coordinates: [[55.27, 25.2], [55.271, 25.2]] as [number, number][]},
      legs: [{steps: []}],
    })!;
    expect(route.maxspeedKph).toBeNull();
  });

  it('speedLimitAtKph reads the limit at the nearest segment and null when absent', () => {
    const route = parseDirectionsRoute(rawNav)!;
    expect(speedLimitAtKph(route, {lng: 55.27, lat: 25.2})).toBe(60);
    expect(speedLimitAtKph(route, {lng: 55.271, lat: 25.2})).toBe(80);
    // Past the annotated segments: clamps to the last entry (unknown → null).
    expect(speedLimitAtKph(route, {lng: 55.2735, lat: 25.2})).toBeNull();
    const bare = {...route, maxspeedKph: null};
    expect(speedLimitAtKph(bare, {lng: 55.27, lat: 25.2})).toBeNull();
  });

  it('currentRoadName is the road being driven ON: the step BEFORE the upcoming maneuver', () => {
    const route = parseDirectionsRoute(rawNav)!;
    // Upcoming maneuver = the mid-route turn (index 1) → still on Marasi Dr.
    expect(currentRoadName(route, 1)).toBe('Marasi Dr');
    // Upcoming = arrive (index 2) → on Al Khail Road.
    expect(currentRoadName(route, 2)).toBe('Al Khail Road');
    // Depart (index 0) → the first step's own road.
    expect(currentRoadName(route, 0)).toBe('Marasi Dr');
  });
});
