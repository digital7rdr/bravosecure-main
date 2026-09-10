/**
 * B-302 — escalating a 1:1 call to a group call silently discards the audio
 * route the user had explicitly chosen.
 *
 * `CallScreen.escalateToGroupCall` ends in `navigation.replace('GroupCallScreen',
 * …)`. `replace` UNMOUNTS CallScreen, so everything it held dies with it —
 * including `preferredRouteRef`, which is where both the manual picker
 * (CallScreen.tsx:1386) and the headset auto-snap (:1336) record the route.
 *
 * The fresh GroupCallScreen then starts at `useRef<AudioRoute | null>(null)`.
 * With no preference, the first `onAudioDeviceChanged` takes the "no preference
 * yet" branch and auto-snaps to whatever headset is attached — overriding the
 * user's choice, one device-event after the escalation.
 *
 * Device evidence (Pixel 6a, 2026-07-27, realme Buds Wireless 3 paired and
 * connected throughout — the founder had SPEAKER selected on the 1:1 leg):
 *
 *   10:57:53.707 New device status: available=[EARPIECE, SPEAKER_PHONE, BLUETOOTH], selected=BLUETOOTH
 *   10:57:53.708 RNInCallManager.chooseAudioRoute(): user choose audioDevice = BLUETOOTH
 *
 * Audio went into earbuds on a desk. This is the founder's "also the audio
 * output" report — a lost preference, NOT a dead route (see B-297 for the dead
 * code that merely looked like the cause).
 *
 * A route is a user DECISION. Continuity of the call must carry it; a screen
 * swap is an implementation detail the user did not ask for and cannot see.
 *
 * Both screens mount RN views, so the node project cannot import them —
 * comment-stripped source scan. Both files are CRLF, so nothing here is
 * `\n`-anchored (a `\n` anchor matches nothing and passes VACUOUSLY).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(...rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const callScreen  = () => code('src', 'screens', 'messenger', 'CallScreen.tsx');
const groupScreen = () => code('src', 'screens', 'messenger', 'GroupCallScreen.tsx');
const navTypes    = () => code('src', 'navigation', 'types.ts');

describe('B-302 — an explicit audio route survives the 1:1 → group escalation', () => {
  it('the route is part of the GroupCallScreen route contract', () => {
    // If it is not in the param list it cannot be typed, and the handoff
    // degrades to an untyped cast that the next refactor drops.
    expect(navTypes()).toMatch(/GroupCallScreen: \{[\s\S]{0,1400}initialAudioRoute\?: AudioRoute/);
  });

  it('escalateToGroupCall HANDS OVER the route it is currently on', () => {
    const src = callScreen();
    const at = src.indexOf('const escalateToGroupCall');
    expect(at).toBeGreaterThan(-1);
    /**
     * Anchor the END of the slice on the navigation itself, not on a fixed
     * character count from the function start.
     *
     * This was `at + 2600`, and on 2026-08-12 it went RED for a change that
     * did not touch the audio handover at all: the escalation gained a
     * camera-release step (the 1:1 must let go of the camera before the
     * group boot asks for it), which pushed `navigation.replace` from
     * offset ~2400 to ~3200 and slid `initialAudioRoute:` out of the
     * window. A fixed window silently converts "someone added code above
     * this line" into "the contract is broken", and the reverse failure —
     * a window so wide it always passes — is worse. Anchoring on the
     * replace call keeps the assertion tight AND insert-proof.
     */
    const repAt = src.indexOf("navigation.replace('GroupCallScreen'", at);
    expect(repAt).toBeGreaterThan(at);
    const body = src.slice(at, repAt + 900);
    // Must travel in the replace() params — the only channel that survives the
    // unmount.
    expect(body).toMatch(/navigation\.replace\('GroupCallScreen', \{[\s\S]{0,600}initialAudioRoute:/);
    // And it must be sourced from the ref that actually holds the preference,
    // not from a fresh default.
    expect(body).toMatch(/initialAudioRoute:\s*preferredRouteRef\.current/);
  });

  it('GroupCallScreen SEEDS its preference from the handover, not from null', () => {
    const src = groupScreen();
    // The whole bug is this ref starting at null on a screen the user did not
    // knowingly open.
    expect(src).not.toMatch(/const preferredRouteRef = useRef<AudioRoute \| null>\(null\)/);
    expect(src).toMatch(/const preferredRouteRef = useRef<AudioRoute \| null>\(initialAudioRoute \?\? null\)/);
  });

  it('the auto-snap still runs when there was NO preference to carry', () => {
    // Seeding must not disable the headset auto-snap for calls that were never
    // escalated — that branch is what covers an already-connected headset at
    // all (B-297), so trading one for the other would be a straight swap of
    // bugs.
    expect(groupScreen()).toMatch(/if \(preferredRouteRef\.current === null\)[\s\S]{0,400}const snap = preferredHeadset\(list\)/);
  });
});
