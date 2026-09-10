/**
 * Client-facing route clarity (founder deck, August 2026, pages 13 and 16).
 *
 * Page 13, his handwriting: "descriptions is not what I chose" and
 * "description - English (UAE)". Page 16: "obscure map".
 *
 * ROOT CAUSE of the Arabic addresses, and it is not on this screen at all: in
 * the location picker the user taps an English Search-Box result, and the
 * screen stores that name — but the very next line recentres the map, whose
 * moveend runs a reverse geocode that did NOT pass `language=en`. Its
 * place_name comes back in the local script, the moveend handler overwrites the
 * pin, and confirm() ships THAT to the booking. Every later surface — the route
 * timeline, the map pins, the summary — was faithfully replaying a value that
 * was already wrong when it was saved.
 *
 * Source scans: these screens mount WebViews and cannot be imported by the node
 * projects. Comments are stripped, CRLF-normalised.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(rel: string[]): string {
  const src = readFileSync(join(process.cwd(), ...rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) {inBlock = false;}
      continue;
    }
    if (t.startsWith('/*') || t.startsWith('{/*')) {
      if (!t.includes('*/')) {inBlock = true;}
      continue;
    }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const PICKER_HTML = code(['src', 'modules', 'booking', 'bravoLocationPickerMapHtml.ts']);
const PICKER = code(['src', 'screens', 'booking', 'LocationPickerScreen.tsx']);
const MAP_HTML = code(['src', 'modules', 'booking', 'bravoLiveRouteMapHtml.ts']);
const TRACK = code(['src', 'screens', 'liveops', 'LiveTrackingScreen.tsx']);

describe('page 13 — the stored place name is the one the user chose, in English', () => {
  it('the picker reverse-geocode asks for English', () => {
    // Without this the UAE returns Arabic-script place_name, and that value is
    // what gets persisted on the booking.
    expect(PICKER_HTML).toContain("'&language=en' +");
  });

  it('our own recentre cannot overwrite the name the user picked', () => {
    expect(PICKER).toContain('chosenRef.current = {lat, lng, address: label}');
    expect(PICKER).toMatch(/const isOwnRecentre = !!chosen/);
    expect(PICKER).toContain('address: isOwnRecentre ? chosen.address : (msg.address ?? \'\')');
  });

  it('a genuine user pan still adopts the geocoded name', () => {
    // Otherwise the pin would keep a stale label after being dragged away.
    expect(PICKER).toContain('if (!isOwnRecentre) {chosenRef.current = null;}');
  });
});

describe('page 13 — no repeated full addresses in the route timeline', () => {
  it('the timeline place strings come from the shortened labels', () => {
    expect(TRACK).toMatch(/import \{shortPlaceLabel(, placeWithContext)?\} from '@utils\/placeLabel'/);
    expect(TRACK).toContain('shortPlaceLabel(pickupAny?.address)');
    expect(TRACK).toContain('shortPlaceLabel(dropoffAny?.address)');
  });

  it('a departure is only claimed once the mission has actually departed', () => {
    // "Departed …" was hard-coded kind:'done', so it appeared while the booking
    // was merely CONFIRMED and no vehicle had been assigned.
    expect(TRACK).toMatch(/const departed = \['DISPATCHED', 'PICKUP', 'LIVE', 'SOS', 'COMPLETED'\]/);
    expect(TRACK).toContain("kind: departed ? 'done' : 'future'");
    expect(TRACK).toContain("ts: departed ? fmt(start) : '—'");
  });

  it('a predicted arrival time is marked as a prediction', () => {
    // Rendered bare it read as a past event and produced the 06:00 / 06:06 /
    // 05:59 sequence the founder circled.
    expect(TRACK).toMatch(/`~\$\{fmt\(new Date\(Date\.now\(\) \+ etaMin \* 60_000\)\)\}`/);
  });
});

describe('page 6 — the verification code survives expanding the map', () => {
  it('the fullscreen map mirrors the code', () => {
    // The pinned card is a sibling of the header, so the fullscreen Modal
    // covered it completely: tapping expand made the code the client is meant
    // to read aloud vanish ("when I got in cpo, code gone").
    expect(TRACK).toContain('fsVerifyCode');
    expect(TRACK).toMatch(/\{showVerify && \(\s*\n\s*<View style=\{\[s\.fsVerify/);
  });

  it('there is only ONE fetcher, mirrored — not a second card', () => {
    // A second mounted VerifyGuardCard would fetch again and rotate on its own
    // clock, so the two copies could disagree mid-handover.
    expect(TRACK.match(/<VerifyGuardCard\b/g)).toHaveLength(1);
    expect(TRACK).toContain('onCode={setVerifyCode}');
    expect(TRACK).toContain('onCode?.(data.code);');
  });

  it('both surfaces share one visibility rule', () => {
    expect(TRACK).toMatch(/const showVerify = \['DISPATCHED', 'PICKUP', 'LIVE', 'SOS'\]\.includes\(missionStatus\);/);
  });
});

describe('page 11 — recenter frames every active mission marker', () => {
  it('recenter frames pickup, drop-off, vehicle, the client AND the route line', () => {
    // The old bounds covered pickup/drop-off/vehicle only, so "show me
    // everything" could not show the client — the founder's "cannot see agent"
    // on the fold view. missionBounds() is now the single basis for both the
    // Recenter tap and window.refit().
    expect(MAP_HTML).toContain('function missionBounds()');
    const mb = MAP_HTML.slice(MAP_HTML.indexOf('function missionBounds()'), MAP_HTML.indexOf('function fitAll('));
    expect(mb).toContain('lastRouteLLs');
    expect(mb).toContain('lastSelfPayload');
    expect(mb).toContain('lastNavPayload');
    const click = MAP_HTML.slice(MAP_HTML.indexOf("recenterEl.addEventListener('click'"));
    expect(click.slice(0, 300)).toContain('fitAll(');
  });

  it('the control is always on screen, not revealed only by a drag', () => {
    // It was display:none until map.on('dragstart'), so a client who never
    // touched the map had no recenter at all.
    const css = MAP_HTML.slice(MAP_HTML.indexOf('.recenter {'), MAP_HTML.indexOf('.recenter {') + 500);
    expect(css).toMatch(/display: flex/);
    expect(css).not.toMatch(/display: none/);
  });

  it('the camera re-frames itself when the officer drives out of view', () => {
    // The old policy framed once per leg and never looked again.
    expect(MAP_HTML).toContain('!userOwnsCamera && vehPos && !map.getBounds().contains(vehPos)');
  });
});

describe('page 18 — the client can tell the markers apart', () => {
  it('the client dot is labelled, not just a different colour', () => {
    expect(MAP_HTML).toContain('<div class="lbl">YOU</div>');
  });

  it('a small persistent legend names every marker', () => {
    expect(MAP_HTML).toMatch(/class="legend"/);
    for (const row of ['You', 'Your officer', 'Pick-up', 'Drop-off']) {
      expect(MAP_HTML).toContain(row);
    }
  });
});

describe('page 9 — the Route tab names the destination', () => {
  it('renders a destination row above the timeline', () => {
    // His annotation was literally a question mark beside the rows:
    // "destination?" — the tab listed events but never said where to.
    expect(TRACK).toContain('DESTINATION');
    expect(TRACK).toContain('const destShort = placeWithContext(dropoffFull)');
  });

  it('the full stored address is one tap away', () => {
    expect(TRACK).toContain('setDestExpanded(v => !v)');
    expect(TRACK).toMatch(/numberOfLines=\{destExpanded \? 4 : 1\}/);
    expect(TRACK).toMatch(/\{destExpanded \? \(dropoffFull \|\| destShort\) : destShort\}/);
  });
});

describe('page 12 — the client can see who is arriving', () => {
  it('the crew row renders a photo when the officer has one', () => {
    expect(TRACK).toContain('<Image source={{uri: photo}} style={s.avPhoto}');
    expect(TRACK).toContain('photo={c.avatar_url}');
  });

  it('initials remain the fallback', () => {
    expect(TRACK).toMatch(/photo \? \(\s*\n\s*<Image/);
    expect(TRACK).toContain('<View style={s.av}><Text style={s.avText}>{initials}</Text></View>');
  });
});

describe('page 16 — the map is not obscured, and progress is actionable', () => {
  it('map pin labels are width-capped in CSS as a backstop', () => {
    // A stored UAE address is ~60 characters and .tag is white-space: nowrap,
    // so without a cap one pin draws a black bar across the whole route.
    const i = MAP_HTML.indexOf('.tag {');
    expect(i).toBeGreaterThan(-1);
    const tag = MAP_HTML.slice(i, MAP_HTML.indexOf('}', i));
    expect(tag).toMatch(/max-width:\s*\d+vw/);
    expect(tag).toMatch(/text-overflow:\s*ellipsis/);
    expect(tag).toMatch(/overflow:\s*hidden/);
  });

  it('the progress pill takes a real label, not a bare percentage', () => {
    expect(MAP_HTML).toMatch(/window\.setProgress = function\(v\)/);
    expect(MAP_HTML).toContain("el.textContent = (typeof v === 'number') ? (v + '% TO B') : String(v);");
  });

  it('delegates to the shared, boundary-tested progress function', () => {
    // The leg logic used to be an inline expression pinned only by a text
    // match. The behaviour now lives in src/utils/missionProgress.ts and is
    // covered by real unit tests at each stage boundary; this only pins that
    // the screen still uses it rather than growing a second copy.
    expect(TRACK).toContain("import {missionProgress} from '@utils/missionProgress'");
    expect(TRACK).toContain('const progressLabel = missionProgress({');
    expect(TRACK).toContain('remainingM: remM,');
  });

  it('does not keep a second, unverified copy of the leg logic', () => {
    expect(TRACK).not.toMatch(/const legWord =/);
    expect(TRACK).not.toMatch(/const onDropoffLeg =/);
  });

  it('no live fix says so, instead of showing a false 0%', () => {
    // The wording lives in the shared function now; the screen must simply not
    // have resurrected a percentage.
    const PROG = code(['src', 'utils', 'missionProgress.ts']);
    expect(PROG).toContain("'Awaiting live GPS'");
    expect(TRACK).not.toMatch(/% TO B/);
    expect(TRACK).not.toMatch(/setProgress\(\$\{isLive && hasRealFix \? pct : 0\}\)/);
  });
});
