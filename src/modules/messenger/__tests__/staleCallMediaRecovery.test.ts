/**
 * B-343 — "Call failed" loop after a kick-mid-call left a zombie call holding
 * the camera (founder, 2026-07-30 19:32-19:35).
 *
 * Measured chain: a call's camera stayed held after its group was purged (the
 * B-339 eject did not fire — cause under diagnosis, see the probe's new
 * else-warn), and NOTHING could ever recover: every later accept queued
 * getUserMedia behind the zombie and died at the 15 s bound, "Call failed",
 * forever, until a force-stop. Structural hole: the boot OVERWRITES the
 * registry entry of any previous call (setActiveGroupCall) without ending it,
 * orphaning its tracks — only that entry's leave() could stop them.
 *
 * Rules pinned (comment-stripped source; file is CRLF — no \n anchors):
 *  1. BEFORE acquiring media, a boot that finds a DIFFERENT room's call in
 *     the registry ends it (await endActiveGroupCall) — frees the camera on
 *     the first retry, whatever leaked it.
 *  2. A failed boot stops the tracks it acquired (outer catch) — a boot
 *     failure can never strand the camera.
 *  3. The B-339 purge probe warns WHY when it does not eject (null vs
 *     conversation mismatch) — the missing datum in today's incident.
 */
import * as fs from 'fs';
import * as path from 'path';

function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const HOOK = strip(fs.readFileSync(
  path.join(__dirname, '..', 'webrtc', 'useGroupCall.ts'), 'utf8'));
const RUNTIME = strip(fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'productionRuntime.ts'), 'utf8'));

describe('B-343 — stale-call media recovery', () => {
  test('boot ends a DIFFERENT room\'s registry call BEFORE acquiring media', () => {
    const guardAt = HOOK.indexOf('roomId !== rid');
    const mediaAt = HOOK.indexOf('getLocalMedia({video: isVideo})');
    expect(guardAt).toBeGreaterThan(-1);
    expect(mediaAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(mediaAt);
    // The guard must END the stale call (which stops its tracks), not merely
    // overwrite its registry slot.
    const guardRegion = HOOK.slice(guardAt, guardAt + 600);
    // WI-1.5 — and it must END THE STALE ROOM specifically. Unkeyed, this
    // teardown would follow the slot if it moved between the guard and here.
    expect(guardRegion).toMatch(/endActiveGroupCall\(stale\.roomId\)/);
  });

  test('a failed boot stops the tracks it acquired', () => {
    const catchAt = HOOK.indexOf("console.warn('[useGroupCall] boot failed:'");
    expect(catchAt).toBeGreaterThan(-1);
    const catchRegion = HOOK.slice(catchAt, catchAt + 1600);
    expect(catchRegion).toMatch(/audioTrackRef\.current\?\.stop\(\)/);
    expect(catchRegion).toMatch(/videoTrackRef\.current\?\.stop\(\)/);
  });

  test('the B-339 probe names WHY it did not eject', () => {
    const probeAt = RUNTIME.indexOf('removed mid-call — ending group call first');
    expect(probeAt).toBeGreaterThan(-1);
    // An else-branch warn naming the skip reason (no live call / different
    // conversation) within the probe block.
    const region = RUNTIME.slice(probeAt - 800, probeAt + 1200);
    expect(region).toMatch(/eject skipped/);
  });
});
