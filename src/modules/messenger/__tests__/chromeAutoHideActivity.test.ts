/**
 * B-305 — on a video call the controls can vanish out from under your finger,
 * so the tap lands on nothing.
 *
 * The chrome auto-hide fires 3.5 s after the chrome BECOMES VISIBLE, and its
 * effect only re-ran on `[isVideoUI, callState, chromeVisible, addPickerOpen,
 * routePickerOpen, dialpadOpen]`. Using a control changes none of those, so the
 * countdown kept running from the original reveal regardless of what the user
 * was doing.
 *
 * Concretely: tap the video to reveal the chrome, spend three seconds deciding,
 * reach for "Add" — and at 3.5 s `setChromeVisible(false)` unmounts the whole
 * control tray (`chromeVisible ? (<View style={styles.videoControls}>…)`, it is
 * a conditional RENDER, not an opacity fade). A press that was already in flight
 * lands on a view that no longer exists and nothing happens.
 *
 * That is a real contributor to the founder's "add call is not working" report
 * on video calls, and it is independent of B-299/B-300/B-301: those are why an
 * invite that WAS sent failed, this is why the tap may never register at all.
 * It also mis-reads as the app being unresponsive, which is exactly the symptom
 * CLAUDE.md's lag section warns not to misattribute.
 *
 * The rule: **the countdown measures idleness, not age.** Any interaction
 * restarts it. The modal-open guards already encode this intent for pickers
 * ("the picker modals reset the timer so the chrome doesn't snap away
 * mid-interaction"); it just never covered ordinary control taps, which are the
 * common case.
 *
 * `tap()` is the single wrapper every control's onPress already goes through, so
 * it is the one place that sees every interaction.
 *
 * CallScreen.tsx mounts RN views, so the node project cannot import it —
 * comment-stripped source scan. The file is CRLF, so nothing here is
 * `\n`-anchored (a `\n` anchor matches nothing and passes VACUOUSLY).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx'), 'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\/[^\r\n]*/g, '');

describe('B-305 — the chrome countdown measures idleness, not age', () => {
  it('every control tap registers activity', () => {
    // `tap` is the shared onPress wrapper — the one funnel that sees them all.
    expect(src).toMatch(/const tap = \(fn: \(\) => void\) => \(\) => \{[^}]*setChromeActivityTick/);
  });

  it('the auto-hide effect RE-RUNS on that activity', () => {
    // Without the dep the tick is dead state: the timer keeps running from the
    // original reveal and the tray still disappears mid-reach.
    const at = src.indexOf('setChromeVisible(false)');
    expect(at).toBeGreaterThan(-1);
    const deps = src.slice(at, at + 400);
    expect(deps).toMatch(/\}, \[[^\]]*chromeActivityTick[^\]]*\]\)/);
  });

  it('auto-hide still EXISTS — this must not become "chrome never hides"', () => {
    // The immersive full-bleed video is the point of hiding it at all; a fix
    // that just disables auto-hide trades one bug for a worse one.
    expect(src).toMatch(/setTimeout\(\(\) => \{\s*setChromeVisible\(false\)/);
    expect(src).toMatch(/\}, 3500\)/);
  });

  it('the picker-open guards survive', () => {
    // Pre-existing intent, same rule, different trigger — a refactor must not
    // trade one for the other.
    expect(src).toMatch(/if \(addPickerOpen \|\| routePickerOpen \|\| dialpadOpen\) \{ setChromeVisible\(true\); return; \}/);
  });
});
