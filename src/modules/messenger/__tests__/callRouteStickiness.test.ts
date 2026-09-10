/**
 * "In call, in bluetooth and also normal without bluetooth — when I screen lock
 * the audio output changed to speaker." Plus: "on headphones I can hear my own
 * voice, echo problem."
 *
 * ONE root cause for the route half, in BOTH call screens.
 *
 * `onAudioDeviceChanged` re-asserted the route only when
 * `preferredRouteRef.current` was non-null — and that ref holds an EXPLICIT
 * picker choice, or the Bluetooth auto-snap. On a plain voice call with no BT
 * and no manual pick it stays null for the entire call, so the re-assert branch
 * never ran: lock the screen, Android re-evaluates output devices and hands the
 * app SPEAKER_PHONE, and nothing ever puts it back.
 *
 * The existing BS-CALL1 restore does not cover it — that fires on AppState
 * 'active', i.e. when the app returns to the FOREGROUND. It does nothing while
 * the screen is still locked and the user is mid-conversation on loudspeaker.
 *
 * The echo half is very likely the same defect: only BLUETOOTH auto-snapped, so
 * plugging in headphones mid-call left audio on the speaker while the mic kept
 * capturing it — a live acoustic echo path straight back to the far end.
 *
 * Both screens mount RN + native modules the node project cannot load, so this
 * is a source scan. Line-based: these files are CRLF and a `\n`-anchored regex
 * would pass vacuously.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREENS = join(process.cwd(), 'src', 'screens', 'messenger');
const CALL_SCREENS = [
  join(SCREENS, 'CallScreen.tsx'),
  join(SCREENS, 'GroupCallScreen.tsx'),
];

function code(path: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

describe.each(CALL_SCREENS)('%s — the audio route survives a screen lock', path => {
  const src = code(path);

  it('tracks a desired route that is defined WITHOUT an explicit pick', () => {
    // The whole bug: preferredRouteRef alone is null on a plain voice call.
    expect(src).toMatch(/const desiredRouteRef = useRef<AudioRoute \| null>\(null\)/);
    expect(src).toMatch(/desiredRouteRef\.current = desired/);
  });

  it('the re-assert falls back to it instead of bailing out', () => {
    expect(src).toMatch(/const want = preferredRouteRef\.current \?\? desiredRouteRef\.current/);
    expect(src).toMatch(/if \(want && list\.includes\(want\) && sel !== want\)/);
  });

  it('the re-assert is NOT gated behind an explicit preference', () => {
    // The exact pre-fix shape. `else if (list.includes(preferredRouteRef…` is
    // unreachable whenever that ref is null, which is the common case.
    expect(src).not.toMatch(/\} else if \(\s*list\.includes\(preferredRouteRef\.current\)/);
  });

  it('a wired headset auto-snaps, not only Bluetooth', () => {
    // Missing wired is the plausible echo path: headphones plugged in mid-call
    // left audio on the speaker with the mic still capturing it.
    //
    // B-297 — the precedence used to be hand-inlined here as a ternary, in BOTH
    // screens, duplicating `preferredHeadset`. The screens now delegate; the
    // wired-beats-Bluetooth ORDER itself is pinned once, in
    // callAudioRoute.test.ts's `preferredHeadset` describe.
    expect(src).toMatch(/const snap = preferredHeadset\(list\)/);
  });

  it('wired outranks Bluetooth — via the one shared rule', () => {
    // Plugging in headphones is a deliberate act; a BT device merely being in
    // range is not. Order matters.
    //
    // B-297 — this used to assert the ORDER of a ternary inlined in the screen.
    // That ternary was one of four hand-copies of the same rule, which is this
    // repo's recurring drift shape. The order now lives in `preferredHeadset`
    // (callAudioRoute.ts) and is asserted there; what this file pins is that
    // the screen has no SECOND, divergent copy of it.
    expect(src).toMatch(/const snap = preferredHeadset\(list\)/);
    expect(src).not.toMatch(/includes\('WIRED_HEADSET'\)\s*\?\s*'WIRED_HEADSET'/);
  });

  it('the speaker force flag follows the target, not a hardcoded false', () => {
    // Re-asserting SPEAKER_PHONE while forcing speakerphone OFF is a
    // contradiction — the route would flip straight back.
    // B-391 — still "follows the target", but through forceSpeakerFlagFor:
    // a boolean false was NOT "speaker off", it was selectAudioDevice(EARPIECE),
    // a sticky pin that stopped a car hands-free kit ever getting the call.
    // B-391c — the restore branch no longer hand-rolls the native pair; it
    // funnels through `pickAudioRouteNative`, which applies the SAME rule for
    // every caller. The anchor follows the code rather than being dropped, and
    // asserts more than it used to:
    //   1. the funnel itself applies forceSpeakerFlagFor (so the B-391 rule
    //      holds for the seed, the auto-snap, the picker AND the restore);
    //   2. the restore invalidates the applied-route cache FIRST — arriving
    //      there means the OS already moved us off the target, so the guard
    //      inside the funnel would otherwise swallow the corrective re-apply;
    //   3. no site hand-rolls `setForceSpeakerphoneOn` with a raw boolean.
    // Screen-agnostic, so it holds for both files: EVERY force-flag call takes
    // its value from the helper, and none passes a raw boolean. The old anchor
    // named one variable in one branch, so moving that branch — which is what
    // B-391c did — read as the rule disappearing.
    // `\??\.?` so a PLAIN call is caught too. GroupCallScreen has two
    // non-optional-chained sites, so the optional-chained-only form left a new
    // `InCallManager.setForceSpeakerphoneOn(x)` free to escape the rule.
    const flagCalls = [...src.matchAll(/setForceSpeakerphoneOn\s*\??\.?\(([^)]*)\)/g)].map(m => m[1]);
    expect(flagCalls.length).toBeGreaterThan(0);
    for (const arg of flagCalls) {
      // The helper, or the NAMED clear constant that shares its definition. A
      // raw `0 as unknown as boolean` is a second copy of the rule — which is
      // what this widened anchor found in GroupCallScreen's teardown.
      const t = arg.trim();
      const ok = /^forceSpeakerFlagFor\(/.test(t) || t.startsWith('FORCE_SPEAKER_CLEAR');
      expect(`${arg} → ${ok}`).toBe(`${arg} → true`);
    }
  });

  it('it does not fight the OS when already on the wanted route', () => {
    // `sel !== want` is the loop guard: without it every device-change event
    // re-issues chooseAudioRoute, which itself emits another event.
    expect(src).toMatch(/sel !== want/);
  });
});

describe('the AppState restore is kept as a SECOND line of defence', () => {
  // It is not sufficient (it only fires on foreground) but it is still
  // correct for the unlock-and-return case, so removing it would regress
  // BS-CALL1. Both mechanisms should coexist.
  it.each(CALL_SCREENS)('%s still reapplies on AppState active', path => {
    expect(code(path)).toMatch(/reapplyRouteRef\.current\(\)/);
  });
});
