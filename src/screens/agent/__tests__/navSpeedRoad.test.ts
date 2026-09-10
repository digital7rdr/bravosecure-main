/**
 * Navigation.docx (founder, 2026-08-26) — the two displays the Waze/Google
 * reference screens have that our native turn-by-turn lacked:
 *
 *   1. SPEED — legal limit (red ring, from `annotations=maxspeed`) beside the
 *      vehicle's own speed (from the same GPS fix that moves the puck).
 *   2. ROAD — the name of the road being driven ON, inside the nav banner.
 *
 * Source scans (this project is node — @rnmapbox/maps cannot mount here),
 * comment-stripped per the CLAUDE.md scanner rules so prose can never satisfy
 * an assertion, and CRLF-normalised.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\r\n/g, '\n')
    // Strip block + line comments so a comment mentioning a token cannot pass.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const TRACKER = 'src/screens/agent/AgentLiveTrackerScreen.tsx';
const DIRECTIONS = 'src/utils/mapboxDirections.ts';

describe('Navigation.docx — speed limit + current speed + road name', () => {
  it('the Directions request asks for the maxspeed annotation', () => {
    const src = read(DIRECTIONS);
    expect(src).toMatch(/&annotations=maxspeed/);
  });

  it('the parser converts mph and refuses unknown/none (never a guessed limit)', () => {
    const src = read(DIRECTIONS);
    expect(src).toMatch(/e\.unknown === true \|\| e\.none === true\) \{return null;\}/);
    expect(src).toMatch(/e\.unit === 'mph' \? Math\.round\(v \* 1\.60934\)/);
  });

  it('the tracker keeps the GPS speed instead of discarding it', () => {
    const src = read(TRACKER);
    // Inside the own-position subscription, speedMps becomes rounded km/h.
    expect(src).toMatch(/setSpeedKph\(\s*fix\.speedMps !== null/);
    expect(src).toMatch(/Math\.round\(fix\.speedMps \* 3\.6\)/);
  });

  it('the nav loop derives the limit from the route at the current fix', () => {
    const src = read(TRACKER);
    expect(src).toMatch(/setLimitKph\(speedLimitAtKph\(rt, cpo\)\)/);
    // And clears it when navigation is unavailable — no stale limit.
    const elseBlock = src.slice(src.indexOf('setNavBanner(null);'));
    expect(elseBlock.slice(0, 120)).toMatch(/setLimitKph\(null\)/);
  });

  it('the limit ring renders ONLY when the annotation knows the limit here', () => {
    const src = read(TRACKER);
    expect(src).toMatch(/\{limitKph !== null && \(\s*<View style=\{s\.speedLimit\}>/);
  });

  it('the cluster shows current speed with an overspeed treatment', () => {
    const src = read(TRACKER);
    expect(src).toMatch(/speedKph > limitKph \+ 2 && s\.speedCurOver/);
    expect(src).toMatch(/\{speedKph \?\? '--'\}/);
  });

  it('the road being driven on reaches the banner (state, signature, render)', () => {
    const src = read(TRACKER);
    expect(src).toMatch(/const roadName = currentRoadName\(rt, nm\.index\)/);
    // In the re-render signature, so a road change repaints the banner…
    expect(src).toMatch(/\$\{icon\}\|\$\{roadName \?\? ''\}/);
    // …and rendered inside it.
    expect(src).toMatch(/\{!!navBanner\.roadName && <Text style=\{s\.navRoad\}/);
  });

  it('the speed cluster is anchored off the measured dock like every overlay', () => {
    const src = read(TRACKER);
    expect(src).toMatch(/s\.speedCluster, \{bottom: \(dockHeight \|\| 0\) \+ 12\}/);
  });
});
