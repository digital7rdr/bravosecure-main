/**
 * BravoMap — the native Mapbox surface, built to REPLACE the WebView maps one
 * screen at a time.
 *
 * Why a ref API and not props: the eight WebView screens already drive their
 * map with an imperative command set injected as JS
 * (`window.setRoute(...)`, `window.setCpo(...)`, …). Mirroring those exact
 * commands here means a screen migrates by swapping
 *   inject(`window.setCpo(${JSON.stringify(p)})`)  ->  mapRef.current?.setCpo(p)
 * instead of having its whole data flow rewritten. Same names, same payload
 * shapes, same call sites.
 *
 * AT COMMAND PARITY with the WebView map as of 2026-08-23: all thirteen
 * commands AgentLiveTrackerScreen issues exist here. Parity is pinned by
 * __tests__/nativeMapParity.test.ts — if a command is ever reduced to a no-op
 * that type-checks, that suite fails, because a silent stub is how a feature
 * disappears during a migration.
 *
 * NOT YET RUN ON A DEVICE. Everything below is type-checked and unit-tested
 * only; the renderer swap is gated behind EXPO_PUBLIC_NATIVE_MAP so the
 * WebView path stays reachable.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import Mapbox from '@rnmapbox/maps';

import {ensureNativeMapboxConfigured} from './nativeMapbox';
import {ROUTE_POLYLINE_PRECISION, decodePolyline} from './decodePolyline';
import {advanceCourse, initialCourse, type CourseState} from './courseOverGround';
import {
  expireMarkerBubbles,
  expireSystemBubbles,
  nextExpiry,
  pushMarkerBubble,
  pushSystemBubble,
  visibleForAnchor,
  visibleSystem,
  type MarkerBubble,
  type PushBubbleInput,
  type PushSystemInput,
  type SystemBubble,
} from './bubbleStacks';

export type BravoMapStyleId = 'dark' | 'light' | 'sat' | '3d';

/** Same URLs the WebView map uses — see bravoAgentTrackerMapHtml.ts STYLES. */
const STYLE_URL: Record<BravoMapStyleId, string> = {
  dark: 'mapbox://styles/mapbox/dark-v11',
  light: 'mapbox://styles/mapbox/light-v11',
  sat: 'mapbox://styles/mapbox/satellite-streets-v12',
  '3d': 'mapbox://styles/mapbox/standard',
};

/** [lng, lat] — Mapbox order, NOT the {lat, lng} the payloads carry. */
export type LngLat = [number, number];

export interface CpoPayload {
  lat: number;
  lng: number;
  callsign?: string | null;
  heading_deg?: number | null;
}

export interface RoutePayload {
  pickup?: {lat: number; lng: number} | null;
  dropoff?: {lat: number; lng: number} | null;
  /** Mapbox-ENCODED polyline string (precision 6), as the API returns it. */
  polyline?: string | null;
}

export interface NavRoutePayload {
  traveled: LngLat[];
  ahead: LngLat[];
}

export interface BravoMapHandle {
  setRoute(p: RoutePayload): void;
  setNavRoute(p: NavRoutePayload): void;
  setCpo(p: CpoPayload): void;
  setPrincipal(p: {lat: number; lng: number} | null): void;
  setStyle(id: BravoMapStyleId): void;
  setNavCamera(p: {mode: 'course' | 'north'}): void;
  pushBubble(p: PushBubbleInput): void;
  pushSystem(p: PushSystemInput): void;
  setAwaiting(on: boolean): void;
  /** Px of map top covered by the RN maneuver banner — cards stay below it. */
  setSysTopGuard(px: number): void;
}

/**
 * How much real-world detail the map carries.
 *
 * 'plain' is the WebView map's look — flat, route and markers only.
 * 'rich'  adds live traffic congestion, 3D building extrusions and a sky,
 *         which is the Google-Maps-during-navigation read. These are native
 *         SDK capabilities the WebView map never had; each is a real tile
 *         request, so they are opt-in rather than always on.
 */
export type BravoMapDetail = 'plain' | 'rich';

interface Props {
  /** Rendered instead of the map when the build has no public token baked in. */
  fallback?: React.ReactNode;
  onReady?: () => void;
  detail?: BravoMapDetail;
}

/**
 * The driving camera — the Google-Maps-navigation read, same numbers the
 * WebView map converged on (NAV_PITCH matches its constant; the offset
 * fraction is its 0.20-below-centre expressed as top padding):
 *
 *   NAV_PITCH        pitched horizon so the road ahead has depth
 *   NAV_ZOOM         focused street-level tracking while following
 *   NORTH_ZOOM       slightly wider when the user pins north-up
 *   NAV_OFFSET_FRAC  fraction of the map height padded off the TOP so the
 *                    puck rides the lower third and the view is the road
 *                    AHEAD, not a circle around the vehicle
 */
const NAV_PITCH = 55;
const NAV_ZOOM = 16.5;
const NORTH_ZOOM = 15;
const NAV_OFFSET_FRAC = 0.4;
const ZERO_PADDING = {paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0};

/** MG-12 — never let a null-island payload move a marker. */
function validLngLat(lng: number | null | undefined, lat: number | null | undefined): boolean {
  return (
    typeof lng === 'number' &&
    typeof lat === 'number' &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90 &&
    !(lng === 0 && lat === 0)
  );
}

function lineFeature(coords: LngLat[]) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: {type: 'LineString' as const, coordinates: coords},
  };
}

const BravoMap = forwardRef<BravoMapHandle, Props>(function BravoMap(
  {fallback = null, onReady, detail = 'rich'},
  ref,
) {
  const configured = useMemo(() => ensureNativeMapboxConfigured(), []);

  const cameraRef = useRef<Mapbox.Camera>(null);

  const [styleId, setStyleId] = useState<BravoMapStyleId>('dark');
  const [cpo, setCpo] = useState<CpoPayload | null>(null);
  const [principal, setPrincipal] = useState<{lat: number; lng: number} | null>(null);
  const [route, setRoute] = useState<RoutePayload | null>(null);
  const [navRoute, setNavRoute] = useState<NavRoutePayload>({traveled: [], ahead: []});
  const [camMode, setCamMode] = useState<'course' | 'north'>('course');

  const [markerBubbles, setMarkerBubbles] = useState<MarkerBubble[]>([]);
  const [systemBubbles, setSystemBubbles] = useState<SystemBubble[]>([]);
  const [awaiting, setAwaitingState] = useState(false);
  const [sysTopGuard, setSysTopGuardState] = useState(156);
  // Issue 42 — the map follows the CPO until the user takes manual control.
  // A drag flips this off and raises the recenter pill; only the pill restores it.
  const [following, setFollowing] = useState(true);

  // Course over ground, derived the same way the WebView map derives it: from
  // consecutive fixes, so GPS noise while stationary cannot spin the camera.
  // A server heading_deg only SEEDS it. The rules live in courseOverGround.ts
  // (unit-tested); this ref just holds the state between fixes. Renders pick
  // up the new bearing because every accepted fix also setCpo()s.
  const courseRef = useRef<CourseState>(initialCourse);
  // The camera heading the map is ACTUALLY at (from onCameraChanged), so the
  // puck chevron can be counter-rotated: it must point at (course − map
  // heading) on screen, or course-up mode applies the rotation twice — the
  // exact bug the WebView map's paintNavPuck comment documents.
  const mapHeadingRef = useRef(0);
  // Map height, for the lower-third camera padding. 0 until the first layout.
  const [mapHeightPx, setMapHeightPx] = useState(0);

  useImperativeHandle(
    ref,
    (): BravoMapHandle => ({
      setRoute: p => setRoute(p),
      setNavRoute: p =>
        setNavRoute({traveled: p?.traveled ?? [], ahead: p?.ahead ?? []}),
      setCpo: p => {
        if (!p || !validLngLat(p.lng, p.lat)) {
          return;
        }
        // Every accepted fix advances the course (seed → move-gate → blend).
        // This is what actually turns the course-up camera; the 1.0.252 build
        // only ever SEEDED the bearing, so the map never rotated (B-507 class).
        courseRef.current = advanceCourse(courseRef.current, [p.lng, p.lat], p.heading_deg);
        setCpo(p);
      },
      setPrincipal: p => {
        if (p && !validLngLat(p.lng, p.lat)) {
          return;
        }
        setPrincipal(p);
      },
      setStyle: id => setStyleId(STYLE_URL[id] ? id : 'dark'),
      // WebView parity: choosing an orientation is an explicit request to have
      // the camera driven again, so it also re-arms follow and drops the pill.
      setNavCamera: p => {
        setCamMode(p?.mode === 'north' ? 'north' : 'course');
        setFollowing(true);
      },
      // The stacking rules live in bubbleStacks.ts, which is unit-tested.
      // These setters only hand it `Date.now()` and the payload.
      pushBubble: p => setMarkerBubbles(s => pushMarkerBubble(s, p, Date.now())),
      pushSystem: p => setSystemBubbles(s => pushSystemBubble(s, p, Date.now())),
      setAwaiting: on => setAwaitingState(!!on),
      setSysTopGuard: px => {
        const v = Number(px);
        if (!Number.isFinite(v) || v < 0) {
          return;
        }
        setSysTopGuardState(v);
      },
    }),
    [],
  );

  // ONE timer for every bubble on screen, re-armed at the next expiry.
  // Why not a timer per bubble: the WebView map arms a setTimeout per push,
  // which leaks a pending callback for every bubble the user navigates away
  // from. A single sweep against Date.now() also self-corrects after the app
  // is backgrounded, instead of firing a burst of stale callbacks on resume.
  useEffect(() => {
    const due = nextExpiry(markerBubbles, systemBubbles);
    if (due === null) {
      return;
    }
    const delay = Math.max(0, due - Date.now());
    const t = setTimeout(() => {
      const now = Date.now();
      setMarkerBubbles(s => expireMarkerBubbles(s, now));
      setSystemBubbles(s => expireSystemBubbles(s, now));
    }, delay);
    return () => clearTimeout(t);
  }, [markerBubbles, systemBubbles]);

  // Decode once per route change, not per render. Precision 6 is not the
  // library default — decoding at 5 puts the route ~10x off, which reads as a
  // route to nowhere rather than an error.
  const routeCoords = useMemo(
    () => (route?.polyline ? decodePolyline(route.polyline, ROUTE_POLYLINE_PRECISION) : []),
    [route?.polyline],
  );

  const onRecenter = useCallback(() => setFollowing(true), []);
  // A gesture-driven camera move means the user took control. The SDK reports
  // the reason, so a programmatic follow-move does not switch itself off.
  // The actual heading is tracked (ref, not state — this fires per frame
  // during animations) for the puck counter-rotation.
  const onCameraChanged = useCallback(
    (e: {gestures?: {isGestureActive?: boolean}; properties?: {heading?: number}}) => {
      if (typeof e?.properties?.heading === 'number') {
        mapHeadingRef.current = e.properties.heading;
      }
      if (e?.gestures?.isGestureActive) {
        setFollowing(false);
      }
    },
    [],
  );
  const onMapLayout = useCallback(
    (e: {nativeEvent: {layout: {height: number}}}) => {
      const h = Math.round(e.nativeEvent.layout.height);
      if (h > 0) {
        setMapHeightPx(h);
      }
    },
    [],
  );

  if (!configured) {
    return <>{fallback}</>;
  }

  const cpoAt: LngLat | null = cpo ? [cpo.lng, cpo.lat] : null;
  const courseBearing = courseRef.current.bearing;
  const courseUp = camMode === 'course';
  // Screen-space chevron rotation: course minus where the map actually points.
  // In course-up follow that is ~0 (chevron rides screen-up, the Google read);
  // in north-up or a user-panned frame it is the raw course.
  const puckRotation =
    courseBearing !== null ? (courseBearing - mapHeadingRef.current + 360) % 360 : null;

  return (
    <View style={styles.fill} onLayout={onMapLayout}>
      <Mapbox.MapView
        style={styles.fill}
        styleURL={STYLE_URL[styleId]}
        logoEnabled={false}
        attributionEnabled
        scaleBarEnabled={false}
        onDidFinishLoadingMap={onReady}
        onCameraChanged={onCameraChanged}>
        {/* ── Rich detail ─────────────────────────────────────────
            Live traffic, 3D buildings and a sky. Skipped on 'sat',
            whose imagery already carries the real world — extruding
            grey boxes on top of a photograph looks broken. */}
        {detail === 'rich' && styleId !== 'sat' && (
          <>
            {/* Congestion straight off Mapbox's traffic tileset. The colour
                ramp is the near-universal one (green→amber→red→maroon), so it
                needs no legend. Drawn UNDER the route: the route is the
                instruction, traffic is context. */}
            <Mapbox.VectorSource id="bravo-traffic" url="mapbox://mapbox.mapbox-traffic-v1">
              <Mapbox.LineLayer
                id="bravo-traffic-line"
                sourceLayerID="traffic"
                belowLayerID="bravo-route-ahead-line"
                style={{
                  // Widens with zoom so congestion reads clearly at nav zoom
                  // without shouting on the overview frame.
                  lineWidth: ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 2.4, 17, 4.5],
                  lineCap: 'round',
                  lineColor: [
                    'match',
                    ['get', 'congestion'],
                    'low', '#3DD68C',
                    'moderate', '#E8B33D',
                    'heavy', '#F2704B',
                    'severe', '#C62828',
                    'transparent',
                  ],
                }}
              />
            </Mapbox.VectorSource>

            {/* 3D building extrusions — the Google-Maps-at-a-junction read.
                Height ramps in with zoom so the city does not pop up abruptly
                the moment the camera crosses the threshold. */}
            <Mapbox.FillExtrusionLayer
              id="bravo-buildings-3d"
              sourceID="composite"
              sourceLayerID="building"
              filter={['==', ['get', 'extrude'], 'true']}
              minZoomLevel={15}
              // Required alongside minZoomLevel in @rnmapbox/maps v10 types.
              maxZoomLevel={22}
              style={{
                fillExtrusionColor: '#1B2431',
                fillExtrusionOpacity: 0.72,
                fillExtrusionBase: ['get', 'min_height'],
                fillExtrusionHeight: [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  15,
                  0,
                  16.5,
                  ['get', 'height'],
                ],
              }}
            />

            <Mapbox.SkyLayer
              id="bravo-sky"
              style={{skyType: 'atmosphere', skyAtmosphereSun: [0, 0], skyAtmosphereSunIntensity: 5}}
            />
          </>
        )}

        {/* The chase camera. Driven ONLY while following — a user pan freezes
            every prop (undefined = uncontrolled), otherwise each fix would
            yank the map back and rotate it under their fingers. While
            following in course-up: tight nav zoom, pitched horizon, rotated
            to the course, and the puck padded into the lower third so the
            screen is the road AHEAD — the Google-Maps-driving read. easeTo
            (not the flyTo default) so consecutive fixes glide instead of
            swooping. */}
        <Mapbox.Camera
          ref={cameraRef}
          followUserLocation={false}
          centerCoordinate={following ? cpoAt ?? undefined : undefined}
          zoomLevel={following ? (courseUp ? NAV_ZOOM : NORTH_ZOOM) : undefined}
          heading={following ? (courseUp ? courseBearing ?? 0 : 0) : undefined}
          pitch={following ? (courseUp ? NAV_PITCH : 0) : undefined}
          padding={
            following && courseUp && mapHeightPx > 0
              ? {...ZERO_PADDING, paddingTop: Math.round(mapHeightPx * NAV_OFFSET_FRAC)}
              : ZERO_PADDING
          }
          animationMode="easeTo"
          animationDuration={800}
        />

        {navRoute.ahead.length > 1 && (
          <Mapbox.ShapeSource id="bravo-route-ahead" shape={lineFeature(navRoute.ahead)}>
            <Mapbox.LineLayer
              id="bravo-route-ahead-line"
              style={{
                lineColor: '#1E88FF',
                lineWidth: 6,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </Mapbox.ShapeSource>
        )}

        {navRoute.traveled.length > 1 && (
          <Mapbox.ShapeSource id="bravo-route-done" shape={lineFeature(navRoute.traveled)}>
            <Mapbox.LineLayer
              id="bravo-route-done-line"
              style={{
                lineColor: '#3C5573',
                lineWidth: 5,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </Mapbox.ShapeSource>
        )}

        {routeCoords.length > 1 && navRoute.ahead.length === 0 && (
          <Mapbox.ShapeSource id="bravo-route-full" shape={lineFeature(routeCoords)}>
            <Mapbox.LineLayer
              id="bravo-route-full-line"
              style={{
                lineColor: '#1E88FF',
                lineWidth: 5,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </Mapbox.ShapeSource>
        )}

        {!!principal && (
          <Mapbox.MarkerView id="bravo-principal" coordinate={[principal.lng, principal.lat]}>
            <View style={styles.principal} />
          </Mapbox.MarkerView>
        )}

        {!!cpoAt && (
          <Mapbox.MarkerView id="bravo-cpo" coordinate={cpoAt}>
            {/* The same rule as the WebView puck: the directional chevron only
                once a bearing exists, otherwise an honest dot. Rotation is
                counter-rotated by the map's actual heading (see puckRotation)
                so course-up mode does not apply the course twice. */}
            <View
              style={[
                styles.puck,
                puckRotation !== null && {
                  transform: [{rotate: `${puckRotation}deg`}],
                },
              ]}>
              <View style={puckRotation !== null ? styles.chevron : styles.dot} />
            </View>
          </Mapbox.MarkerView>
        )}

        {/* ── Mission event cards, anchored where the event happened ── */}
        {visibleSystem(systemBubbles).map(b => (
          <Mapbox.MarkerView
            key={b.id}
            id={`bravo-sys-${b.id}`}
            coordinate={[b.lng, b.lat]}
            anchor={{x: 0.5, y: 1.4}}>
            <View style={styles.sysCard}>
              {!!b.label && <Text style={styles.sysLabel}>{b.label}</Text>}
              {!!b.preview && (
                <Text style={styles.sysPreview} numberOfLines={2}>
                  {b.preview}
                </Text>
              )}
            </View>
          </Mapbox.MarkerView>
        ))}

        {/* ── Chat bubbles, anchored to whichever marker they belong to ── */}
        {(
          [
            ['cpo', cpoAt] as const,
            ['principal', principal ? ([principal.lng, principal.lat] as LngLat) : null] as const,
          ] as const
        ).map(([anchor, at]) =>
          at
            ? visibleForAnchor(markerBubbles, anchor).map((b, i) => (
                <Mapbox.MarkerView
                  key={`${anchor}-${b.id}`}
                  id={`bravo-bub-${anchor}-${b.id}`}
                  coordinate={at}
                  // Stack upward off the marker so two bubbles never overlap.
                  anchor={{x: 0.5, y: 1.8 + i * 0.9}}>
                  <View style={[styles.bubble, b.kind === 'sos' && styles.bubbleSos]}>
                    {!!(b.name ?? b.sender) && (
                      <Text style={[styles.bubbleName, b.kind === 'sos' && styles.bubbleNameSos]}>
                        {b.name ?? b.sender}
                      </Text>
                    )}
                    {!!b.preview && (
                      <Text style={styles.bubbleText} numberOfLines={2}>
                        {b.preview}
                      </Text>
                    )}
                  </View>
                </Mapbox.MarkerView>
              ))
            : null,
        )}
      </Mapbox.MapView>

      {/* ── Awaiting telemetry ──────────────────────────────────────
          Sits BELOW the measured banner guard, which is exactly what
          setSysTopGuard is for — RN owns the banner, the map cannot see it. */}
      {awaiting && (
        <View style={[styles.awaiting, {top: sysTopGuard + 8}]} pointerEvents="none">
          <View style={styles.awaitingDot} />
          <Text style={styles.awaitingTxt}>AWAITING TELEMETRY</Text>
        </View>
      )}

      {/* ── Recenter ──────────────────────────────────────────────── */}
      {!following && (
        <TouchableOpacity
          style={styles.recenter}
          onPress={onRecenter}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Recenter the map on the officer">
          <Text style={styles.recenterTxt}>⌖ FOLLOW</Text>
        </TouchableOpacity>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  fill: {flex: 1},
  puck: {width: 38, height: 38, alignItems: 'center', justifyContent: 'center'},
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#1E88FF',
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  // Border-triangle chevron: RN has no SVG here, and the WebView puck's exact
  // path is not reproducible with borders — this is the closest honest shape.
  chevron: {
    width: 0,
    height: 0,
    borderLeftWidth: 11,
    borderRightWidth: 11,
    borderBottomWidth: 26,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#1E88FF',
  },
  principal: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#7ED6FF',
    borderWidth: 2.5,
    borderColor: '#FFFFFF',
  },

  // Chat bubble — same palette as the WebView map's .bub.
  bubble: {
    maxWidth: 240,
    paddingVertical: 7,
    paddingHorizontal: 11,
    borderRadius: 14,
    backgroundColor: '#1B3A66',
    borderWidth: 1,
    borderColor: '#244C82',
  },
  bubbleSos: {backgroundColor: '#5A1B22', borderColor: '#8E2B33'},
  bubbleName: {
    color: '#7ED6FF',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  bubbleNameSos: {color: '#FF9B9B'},
  bubbleText: {color: '#FFFFFF', fontSize: 12, fontWeight: '500', marginTop: 1},

  // Mission event card.
  sysCard: {
    maxWidth: 220,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(6,20,43,0.92)',
    borderWidth: 1,
    borderColor: '#1C3B66',
  },
  sysLabel: {
    color: '#B8C7E0',
    fontSize: 8.5,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  sysPreview: {color: '#FFFFFF', fontSize: 11.5, fontWeight: '600', marginTop: 1},

  awaiting: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: 'rgba(255,193,7,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,193,7,0.45)',
  },
  awaitingDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFC107'},
  awaitingTxt: {color: '#FFC107', fontSize: 10.5, fontWeight: '800', letterSpacing: 1.6},

  recenter: {
    position: 'absolute',
    right: 12,
    bottom: 150,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(6,20,43,0.92)',
    borderWidth: 1,
    borderColor: '#4CC2FF',
  },
  recenterTxt: {color: '#4CC2FF', fontSize: 10, fontWeight: '800', letterSpacing: 1},
});

export default BravoMap;
