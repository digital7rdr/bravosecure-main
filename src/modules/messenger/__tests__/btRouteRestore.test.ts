/**
 * B-278 — "Bluetooth is connected during a call, but going to the home screen /
 * another app drops it and it goes to speaker mode."
 *
 * `lastAppliedRoute` in CallScreen is NOT the device state — it is only what we
 * last ASKED for. It exists to stop redundant chooseAudioRoute calls, because
 * each one tears down and re-establishes the BT SCO link (BS-CALL-CHOPPY).
 *
 * But backgrounding invalidates that belief: Android tears down SCO and falls
 * back to the loudspeaker on its own. The AppState 'active' handler then
 * re-applies 'BLUETOOTH' — and the guard sees 'BLUETOOTH' as already applied,
 * returns immediately, and the call stays on speaker for the rest of its life.
 *
 * The call-state-transition path already clears the cache for exactly this
 * reason (the ringback player flips speakerphone underneath us). The AppState
 * path never did.
 *
 * CallScreen.tsx mounts RN views, so the node project cannot import it — this is
 * a comment-stripped source scan. The file is CRLF; nothing here is
 * `\n`-anchored (a `\n` anchor would match nothing and pass VACUOUSLY).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx'), 'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\/[^\r\n]*/g, '');

describe('B-278 — a backgrounded BT call must come back to Bluetooth', () => {
  it('the invalidator exists and clears the cached route', () => {
    expect(src).toMatch(/function invalidateAppliedRoute\(\)\s*:\s*void\s*\{\s*lastAppliedRoute = null;\s*\}/);
  });

  it('the AppState re-apply invalidates BEFORE re-applying', () => {
    // Order is the whole fix. Invalidating after the re-apply leaves the guard
    // in force for the one call that mattered.
    // Anchor on the CALL (trailing semicolon) — `invalidateAppliedRoute()`
    // alone also matches the declaration `function invalidateAppliedRoute():`.
    const at = src.indexOf('invalidateAppliedRoute();');
    const reapplyAt = src.indexOf('reapplyRouteRef.current()', at);
    expect(at).toBeGreaterThan(-1);
    expect(reapplyAt).toBeGreaterThan(at);
    // They must be in the same statement block, not merely both present
    // somewhere in a 3000-line file.
    expect(reapplyAt - at).toBeLessThan(200);
  });

  it('the idempotence guard SURVIVES — deleting it would restore SCO churn', () => {
    // The fix is to invalidate the cache at the right moment, NOT to remove the
    // guard. Without the guard every convergent effect re-issues the same route
    // and each re-issue flaps the SCO link (audible stutter, BS-CALL-CHOPPY).
    expect(src).toMatch(/if \(route === lastAppliedRoute\)/);
  });

  it('the call-state-transition invalidation is still there too', () => {
    // The pre-existing sibling case; a refactor must not trade one for the other.
    expect(src).toContain('lastAppliedRoute = null');
    const occurrences = src.match(/lastAppliedRoute = null/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('BLUETOOTH is a route the native picker actually accepts', () => {
    // Guards against a rename that silently drops BT from the union and makes
    // every BT restore a type-level no-op.
    expect(src).toMatch(/'SPEAKER_PHONE' \| 'EARPIECE' \| 'BLUETOOTH' \| 'WIRED_HEADSET'/);
  });
});

describe('B-276 — the force-speaker flag must track the route', () => {
  it('pickAudioRouteNative sets the flag to MATCH the chosen route', () => {
    // Three other route paths cleared this flag; this one did not, so a video
    // call that opened on headphones kept the loudspeaker live underneath the
    // headset route — the mic recaptured it and both sides heard echo.
    // B-391 — the flag still tracks the route, but the VALUE now comes from
    // forceSpeakerFlagFor(route), not from a boolean comparison. A boolean
    // false maps to -1 in the library, i.e. selectAudioDevice(EARPIECE) — a
    // sticky pin that blocked Bluetooth SCO for car kits entirely.
    expect(src).toMatch(/setForceSpeakerphoneOn\?\.\(forceSpeakerFlagFor\(route\)\)/);
  });

  it('the flag is set BEFORE chooseAudioRoute runs', () => {
    const flagAt = src.indexOf('setForceSpeakerphoneOn?.(forceSpeakerFlagFor(route))');
    const chooseAt = src.indexOf('chooseAudioRoute', flagAt);
    expect(flagAt).toBeGreaterThan(-1);
    expect(chooseAt).toBeGreaterThan(flagAt);
  });
});

describe('B-276 — the group screen honours an attached headset', () => {
  const gsrc = readFileSync(
    join(process.cwd(), 'src', 'screens', 'messenger', 'GroupCallScreen.tsx'), 'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');

  it('uses the SHARED headset decision, not a bare speaker force', () => {
    // It used to force SPEAKER_PHONE for every video room with no check for what
    // was plugged in — echo for everyone on headphones. B-251 fixed this class
    // on the 1:1 mount path; the group screen never got it.
    //
    // B-297 — this used to assert `initialCallRoute(parseAudioDeviceList(
    // rawDevices)…)`, where `rawDevices` came from a `getAudioDeviceList()` that
    // does not exist on this native module. The expression was real; its input
    // was always `undefined`, so the decision collapsed to the media-type
    // default on every call and this assertion vouched for nothing. The live
    // decision is the shared `preferredHeadset` in the device-event handler.
    expect(gsrc).toMatch(/const snap = preferredHeadset\(list\)/);
    expect(gsrc).toMatch(/import \{[^}]*preferredHeadset[^}]*\} from '@\/modules\/messenger\/runtime\/callAudioRoute'/);
    // The original bug: an unconditional speaker force for video.
    expect(gsrc).not.toMatch(/setForceSpeakerphoneOn\?\.\(true\)/);
  });

  it('no longer hard-codes chooseAudioRoute to SPEAKER_PHONE at session start', () => {
    expect(gsrc).not.toMatch(/chooseAudioRoute\?\.\('SPEAKER_PHONE'\)/);
  });

  it('keeps the force flag consistent with the opening route', () => {
    // B-391 — same rule on the group path.
    expect(gsrc).toMatch(/setForceSpeakerphoneOn\(forceSpeakerFlagFor\(opening\)/);
  });
});
