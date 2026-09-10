/**
 * Driver-grade navigation contract (founder feedback, August 2026).
 *
 * "The current map is not good enough for real driver navigation." The seven
 * requirements were: track the vehicle and rotate the map to its direction,
 * turn-by-turn instructions, remaining distance and ETA, voice directions,
 * automatic rerouting, a reliable recenter, and keeping navigation usable
 * while calling/messaging/using emergency controls — all WITHOUT swapping map
 * technology.
 *
 * Turn-by-turn, ETA and rerouting already existed. What did not: the camera
 * never rotated (easeTo set only centre and zoom, so the map was permanently
 * north-up), nothing was ever spoken, remaining distance was computed but only
 * used to scale the ETA, and the driver's own marker was read back from the
 * SERVER — a ~10 s throttled telemetry push polled every 4 s, so the dot could
 * be ~14 s behind the vehicle.
 *
 * These are string scans: the map is Mapbox GL JS inside a WebView template
 * literal, so it cannot be executed under Jest. They therefore anchor on CODE
 * shapes, never on prose that a comment could satisfy.
 */
import {buildAgentTrackerHtml} from '@modules/booking/bravoAgentTrackerMapHtml';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const HTML = buildAgentTrackerHtml('pk.test-token');

const SCREEN = readFileSync(
  join(process.cwd(), 'src', 'screens', 'agent', 'AgentLiveTrackerScreen.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

const DIRECTIONS = readFileSync(
  join(process.cwd(), 'src', 'utils', 'mapboxDirections.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

/** The body of a named block, so an assertion can be scoped to it. */
function region(src: string, startMarker: string, length = 700): string {
  const i = src.indexOf(startMarker);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, i + length);
}

describe('requirement 1 — track the vehicle and rotate the map to its direction', () => {
  it('the follow camera applies a bearing and a pitch, not just a centre', () => {
    const follow = region(HTML, 'if (navActive && follow) {');
    expect(follow).toContain('cam.bearing = navBearing;');
    expect(follow).toContain('cam.pitch = NAV_PITCH;');
    expect(follow).toContain('map.easeTo(cam)');
  });

  it('the vehicle is offset toward the lower third so the road ahead is visible', () => {
    expect(region(HTML, 'if (navActive && follow) {')).toContain('cam.offset = navOffset();');
    expect(HTML).toMatch(/NAV_OFFSET_FRAC\s*=\s*0?\.\d+/);
  });

  it('the bearing is course over ground, gated on real movement', () => {
    // A parked vehicle must not spin the map on GPS noise.
    const setCpo = region(HTML, 'window.setCpo = function', 1800);
    expect(setCpo).toMatch(/metresBetween\(lastCourseLL, \[lng, lat\]\) >= MIN_COURSE_M/);
    expect(setCpo).toContain('bearingDeg(lastCourseLL, [lng, lat])');
  });

  it('bearing changes take the shortest arc', () => {
    // Without this, 350 -> 10 degrees spins the map backwards through 340.
    expect(HTML).toContain('function blendBearing(');
    expect(HTML).toMatch(/const d = \(\(to - from \+ 540\) % 360\) - 180;/);
    expect(region(HTML, 'window.setCpo = function', 1800)).toContain('blendBearing(navBearing, raw');
  });

  it('the nav puck is counter-rotated against the map bearing', () => {
    // The puck is a screen-space DOM element with no rotationAlignment, so
    // once the CAMERA carries the bearing the puck double-counts it.
    // (Was paintHeadingCone until the detached cone became the Google-Maps
    // style chevron; the counter-rotation contract is unchanged.)
    expect(HTML).toContain('function paintNavPuck()');
    expect(HTML).toContain("rotate(' + (navBearing - map.getBearing()) + 'deg)");
    // And it must be repainted throughout a rotation, not only on a new fix.
    expect(HTML).toContain("map.on('rotate', paintNavPuck)");
  });

  it('the directional chevron only appears once a bearing is known', () => {
    // An arrowhead pointing an arbitrary way is worse than an honest dot, so
    // the .nav class is set in the one place that proves a bearing exists.
    expect(region(HTML, 'function paintNavPuck()', 500)).toContain("classList.add('nav')");
    expect(HTML).toContain('.mk.cpo.nav .puck { display: block; }');
    expect(HTML).toContain('.mk.cpo.nav .core { display: none; }');
    // paintNavPuck returns early without a bearing — that early return is what
    // keeps the plain dot on screen for a fix with no course history.
    expect(region(HTML, 'function paintNavPuck()', 200)).toContain('!haveBearing) return');
  });

  it('Track Up is the default and North Up is selectable', () => {
    expect(HTML).toContain('window.setNavCamera = function');
    expect(HTML).toMatch(/navMode = \(payload && payload\.mode\) === 'north' \? 'north' : 'course'/);
    // Default on the RN side: Track Up for whoever is driving, north-up for a
    // remote observer (rotating someone else's map is disorienting).
    expect(SCREEN).toMatch(/useState<'course' \| 'north'>\(\s*\n?\s*isDriver \? 'course' : 'north',?\s*\n?\s*\)/);
    expect(SCREEN).toContain('window.setNavCamera(');
  });
});

describe('requirement 3 — remaining distance as well as ETA', () => {
  it('renders a real remaining-distance label, not only a percentage', () => {
    expect(SCREEN).toContain('setRemainingLabel(formatDistance(remainM))');
    expect(SCREEN).toMatch(/<Text style=\{s\.etaK\}>LEFT<\/Text>/);
    expect(SCREEN).toMatch(/\{remainingLabel\}/);
  });
});

describe('requirement 4 — voice directions', () => {
  it('asks the Directions API for spoken instructions in English', () => {
    // Anchored on the QUERY-STRING literal, not the bare tokens: the comment
    // above it also mentions voice_instructions and language=en, so a looser
    // assertion would pass on prose alone even if the URL lost the params.
    expect(DIRECTIONS).toContain(
      "'&voice_instructions=true&voice_units=metric&language=en' +",
    );
    // The parsed step must actually carry them through.
    expect(DIRECTIONS).toContain('voiceInstructions');
    expect(DIRECTIONS).toMatch(/voice: VoiceCue\[\]/);
  });

  it('speaks through the pure decision engine, not ad-hoc timers', () => {
    expect(SCREEN).toContain('pickAnnouncement({');
    expect(SCREEN).toContain('speakNav(say.text)');
    // Superseded cues are recorded so a GPS stall cannot queue a backlog.
    expect(SCREEN).toContain('for (const k of say.superseded)');
  });

  it('never talks over a live call (requirement 7)', () => {
    const speak = region(SCREEN, 'const speakNav = useCallback');
    expect(speak).toContain('getActiveCall() || getActiveGroupCall()');
  });

  it('is mutable by the driver and stops on unmount', () => {
    expect(SCREEN).toMatch(/voiceOn \? 'VOICE' : 'MUTED'/);
    expect(SCREEN).toContain('speech().stop()');
  });

  it('resolves the native TTS module lazily so an unlinked build cannot crash the navigator', () => {
    // A module-scope import of a native module throws during module init, which
    // would take down the whole agent/CPO navigator rather than just muting.
    expect(SCREEN).not.toMatch(/^import .*from 'expo-speech'/m);
    expect(SCREEN).toContain("require('expo-speech')");
    expect(SCREEN).toContain('SILENT_SPEECH');
  });

  it('only records a cue as spoken when it was ACTUALLY spoken', () => {
    // Recording a suppressed cue (muted / call in progress) would permanently
    // swallow that maneuver: un-muting mid-approach would give silence.
    expect(SCREEN).toContain('if (say && speakNav(say.text))');
    expect(SCREEN).toMatch(/const speakNav = useCallback\(\(text: string\): boolean/);
  });
});

describe('requirement 6 — a reliable recenter', () => {
  it('restores the FULL navigation camera, not just the centre', () => {
    const click = region(HTML, "recenterEl.addEventListener('click'");
    expect(click).toContain('follow = true;');
    expect(click).toContain('bearing: up ? navBearing : 0');
    expect(click).toContain('pitch: up ? NAV_PITCH : 0');
    expect(click).toContain('offset: up ? navOffset() : [0, 0]');
  });

  it('a gesture rotate or pitch also hands control back to the driver', () => {
    // Our own easeTo fires these events too — only a real gesture carries
    // originalEvent, so the guard is what keeps follow from self-cancelling.
    expect(HTML).toMatch(/map\.on\('rotatestart', \(e\) => \{ if \(e\.originalEvent\) breakFollow\(\); \}\)/);
    expect(HTML).toMatch(/map\.on\('pitchstart', \(e\) => \{ if \(e\.originalEvent\) breakFollow\(\); \}\)/);
  });
});

describe('the 1 Hz cadence does not flood the bridge or the renderer', () => {
  it('re-sends the split polyline only when the split actually moves', () => {
    // The payload is the WHOLE route geometry. At 1 Hz on a long leg that is
    // tens of KB per second of string marshalling to the WebView — this repo
    // has a documented history of exactly this class of JS-thread stall.
    const split = region(SCREEN, 'const splitIdx = nearestIndexOnRoute(rt.coordinates, cpo);', 800);
    expect(split).toContain('prevSplit.idx !== splitIdx');
    expect(split).toContain('movedM > 20');
    expect(split).toContain('mapCmd.setNavRoute(');
  });

  it('the throttle is keyed on ROUTE identity, so a reroute always redraws', () => {
    // A reroute to the same destination yields a byte-identical targetKey, and
    // the cached index then points into the ABANDONED geometry. Keyed that way,
    // a fresh route whose index happened to collide was never drawn: the map
    // kept showing the route the driver had just left while the banner and the
    // voice described the new one.
    const split = region(SCREEN, 'const rid = routeVoiceId(rt, targetKey);', 900);
    expect(split).toContain('prevSplit.key !== rid');
    expect(split).toContain('lastSplitRef.current = {idx: splitIdx, at: cpo, key: rid}');
    // The voice id is the same identity, computed once.
    expect(SCREEN).toContain('const vid = rid;');
  });

  it('effects needing only a fallback anchor do not depend on the 1 Hz position', () => {
    // window.setRoute REBUILDS the pickup/drop-off DOM markers. Keyed on
    // currentLat/currentLng it re-fired on every fix — once per second under
    // own-GPS — tearing down and recreating those markers continuously.
    const routeEffect = region(SCREEN, 'mapCmd.setRoute(', 1400);
    expect(routeEffect).toContain('posRef.current.lat');
    expect(routeEffect).toMatch(
      /\}, \[webReady, pickupCoord, dropoffCoord, polyline, mapCmd\]\);/,
    );
    /**
     * Same for the group-message bubble pusher.
     *
     * B-659 RE-POINTED, not weakened. This asserted the deps array as an exact
     * literal, so it went red when `directoryNames` was added to resolve real
     * sender names (the room's members are typically people this device has no
     * 1:1 thread with, so the labels were raw id fragments).
     *
     * The INVARIANT this test exists for is "does not re-fire at 1 Hz" — i.e.
     * it must not depend on the live position. An exact-literal match cannot
     * tell a 1 Hz dep from a harmless one, and has to be rewritten for every
     * legitimate addition. So: pin the deps that must be PRESENT, and the ones
     * that must be ABSENT.
     */
    const bubbleDeps = SCREEN.match(/\}, \[webReady, groupMsgs, ownUserId,[^\]]*\]\);/)?.[0] ?? '';
    expect(bubbleDeps).not.toBe('');
    // The 1 Hz values — these are what would flood the bridge.
    expect(bubbleDeps).not.toMatch(/currentLat|currentLng|\bpos\b|heading/);
  });

  it('re-renders the maneuver banner only when its visible content changes', () => {
    // An always-new object would re-render the whole tracker every second.
    expect(SCREEN).toContain('if (sig !== navBannerSigRef.current)');
    // …and the signature resets with the banner, or a later identical
    // maneuver would be suppressed.
    expect(SCREEN).toMatch(/navBannerSigRef\.current = '';\s*\n\s*setNavBanner\(null\);/);
  });
});

describe('map style controls are secondary while navigating (pages 20/22)', () => {
  it('the column collapses to a single control once there is a route to follow', () => {
    // It was a permanently expanded 154dp block in the map gutter.
    expect(SCREEN).toMatch(/const STYLE_FULL_H = 154;/);
    expect(SCREEN).toMatch(/const STYLE_MINI_H = \d+;/);
    expect(SCREEN).toMatch(/const styleExpanded = !navShown \|\| styleOpen;/);
  });

  it('the band gate reserves the height ACTUALLY rendered', () => {
    // STYLE_TOGGLE_H keeps its name (navBannerLegibility pins the gate
    // expression) but is derived, so a collapsed column cannot reserve 154dp.
    expect(SCREEN).toMatch(/const STYLE_TOGGLE_H = styleExpanded \? STYLE_FULL_H : STYLE_MINI_H;/);
    expect(SCREEN).toMatch(/band >= SLIDE_HANDLE_H \+ 12 \+ STYLE_TOGGLE_H/);
  });

  it('picking a style re-collapses it, and starting navigation collapses it too', () => {
    expect(SCREEN).toMatch(/setStyleId\(k\); if \(navShown\) \{setStyleOpen\(false\);\}/);
    expect(SCREEN).toMatch(/if \(navShown\) \{setStyleOpen\(false\);\}\s*\n\s*\}, \[navShown\]\);/);
  });

  it('the collapsed control still says which style is active', () => {
    expect(SCREEN).toMatch(/accessibilityLabel=\{`Map style: \$\{styleId\}\. Tap to change`\}/);
  });
});

describe('the driver navigates from their OWN gps, not a server round trip', () => {
  it('subscribes to own-device fixes, and only when actually in the vehicle', () => {
    expect(SCREEN).toContain('subscribeOwnPosition(');
    // A remote observer has no own fix and must keep the server's copy.
    expect(SCREEN).toMatch(/const isDriver = mode !== 'monitor';/);
    expect(region(SCREEN, 'if (!isDriver || !isFocused) {return undefined;}'))
      .toContain('subscribeOwnPosition');
  });

  it('stops the 1 Hz watch when the driver is looking at another screen', () => {
    // This screen stays mounted under Chat / the call screen / the lead
    // console; a 1 Hz high-accuracy watch must not keep running there.
    expect(SCREEN).toContain('const isFocused = useIsFocused();');
    expect(SCREEN).toMatch(/\}, \[isDriver, isFocused\]\);/);
  });

  it('measures fix freshness on our own clock, not the provider timestamp', () => {
    expect(SCREEN).toContain('ownFixAtRef.current = fix.receivedAt;');
  });

  it('a fresh own fix outranks the slower server copy', () => {
    expect(SCREEN).toMatch(
      /const ownFresh = isDriver && Date\.now\(\) - ownFixAtRef\.current < OWN_FIX_TTL_MS;/,
    );
    // The server write is gated on it, rather than unconditionally clobbering.
    expect(SCREEN).toMatch(/if \(!ownFresh\) \{\s*\n\s*setCurrentLat\(data\.mission\?\.current_lat/);
  });

  it('falls back to the server when the device GPS goes quiet', () => {
    // The TTL is the fallback: without it a dead GPS would freeze the marker.
    expect(SCREEN).toMatch(/OWN_FIX_TTL_MS = 15_000/);
  });
});
