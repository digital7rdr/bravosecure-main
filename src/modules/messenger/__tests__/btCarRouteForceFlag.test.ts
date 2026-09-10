/**
 * B-391 — call audio never reaches a car hands-free kit, on 1:1 AND group calls.
 *
 * The mechanism is fully traced in callAudioForceFlag.ts. In one line:
 * `setForceSpeakerphoneOn(false)` does not clear the force flag, it pins
 * `userSelectedAudioDevice = EARPIECE`, and that pin makes the library skip its
 * own auto-Bluetooth branch and therefore never call `startScoAudio()` — the
 * only thing that asks a car for an HFP audio link.
 *
 * These assertions are the contract. The library semantics they encode were
 * verified against the INSTALLED source (react-native-incall-manager@4.2.1),
 * not from memory:
 *   index.js:67                    boolean → ±1, anything else → 0
 *   InCallManagerModule.java:888   flag  1 → selectAudioDevice(SPEAKER_PHONE)
 *   InCallManagerModule.java:891   flag -1 → selectAudioDevice(EARPIECE)
 *   InCallManagerModule.java:893   flag  0 → selectAudioDevice(NONE)
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {forceSpeakerFlagFor} from '../runtime/callAudioForceFlag';

describe('B-391 — the force-speaker flag must not pin the earpiece on a headset route', () => {
  it('SPEAKER_PHONE still pins the speaker', () => {
    expect(forceSpeakerFlagFor('SPEAKER_PHONE')).toBe(true);
  });

  it('EARPIECE still pins the earpiece — that is how "speaker off" is expressed', () => {
    expect(forceSpeakerFlagFor('EARPIECE')).toBe(false);
  });

  // The fix. `false` here is what silently blocked every car kit.
  it('BLUETOOTH CLEARS the pin instead of pinning the earpiece', () => {
    const flag = forceSpeakerFlagFor('BLUETOOTH');
    expect(flag).toBe(0);
    // Must NOT be a boolean: index.js branches on `typeof _flag === 'boolean'`,
    // so `false` would map to -1 (EARPIECE) and re-open the bug.
    expect(typeof flag).not.toBe('boolean');
  });

  it('WIRED_HEADSET clears the pin too — same class', () => {
    expect(forceSpeakerFlagFor('WIRED_HEADSET')).toBe(0);
    expect(typeof forceSpeakerFlagFor('WIRED_HEADSET')).not.toBe('boolean');
  });

  it('the library really does treat a boolean false as EARPIECE (guards the premise)', () => {
    // If a future upgrade changes this mapping, this fix's rationale is void and
    // the test should fail loudly rather than the app silently regressing.
    const js = readFileSync(
      join(process.cwd(), 'node_modules', 'react-native-incall-manager', 'index.js'), 'utf8');
    expect(js).toMatch(/typeof _flag === "boolean"[\s\S]{0,40}\? 1 : -1[\s\S]{0,10}: 0/);
  });
});

/**
 * Comments stripped LINE BY LINE before any ABSENCE assertion — prose naming
 * the banned token is the classic false positive (CLAUDE.md). Module scope so
 * both describes below can use it.
 */
function codeOnly(rel: string): string {
  const lines = readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

describe('B-391 — both call screens must go through the shared flag', () => {
  const SCREENS = [
    'src/screens/messenger/CallScreen.tsx',
    'src/screens/messenger/GroupCallScreen.tsx',
  ];

  it.each(SCREENS)('%s never passes a bare boolean comparison to setForceSpeakerphoneOn', rel => {
    const src = codeOnly(rel);
    // The exact shape that caused this: `setForceSpeakerphoneOn(route === 'SPEAKER_PHONE')`
    // and `setForceSpeakerphoneOn(false)`. Both hand the library a boolean.
    // ONE pattern covering both call shapes and both booleans. The three it
    // replaces included `\?\?\.` — the literal characters `??.`, which are not
    // valid JS and appear nowhere, so that assertion could never fire; and
    // between them they still left `?.(true)` uncovered.
    expect(src).not.toMatch(/setForceSpeakerphoneOn\s*\??\.?\(\s*(true|false)\s*\)/);
    expect(src).not.toMatch(/setForceSpeakerphoneOn[^)\n]*===\s*'SPEAKER_PHONE'\s*\)/);
  });

  it.each(SCREENS)('%s uses forceSpeakerFlagFor', rel => {
    expect(codeOnly(rel)).toMatch(/forceSpeakerFlagFor/);
  });
});

/**
 * B-391b — the OTHER audio owner.
 *
 * The phone account is registered `selfManaged: true`, and callKitBridge's own
 * setup comment says the Telecom layer "just provides the system UI + Bluetooth
 * routing". For a self-managed call the framework route lives on the Connection
 * (`Connection.setAudioRoute(CallAudioState.ROUTE_BLUETOOTH)`), which
 * `RNCallKeep.setAudioRoute` wraps — and nothing in the app had ever called it.
 * So InCallManager drove AudioManager while Telecom sat on its default: two
 * owners of one car HFP link, one of them never told anything.
 *
 * The rule is MIRROR, never diverge — always hand Telecom the same target we
 * gave InCallManager. Divergence is what would flap the route.
 */
describe('B-391b — the chosen route is mirrored onto the Telecom connection', () => {
  const bridge = codeOnly('src/modules/messenger/push/callKitBridge.ts');

  it('the bridge exposes reportAudioRoute', () => {
    expect(bridge).toMatch(/export function reportAudioRoute/);
  });

  it('it maps to CallKeep\'s Android vocabulary, not ours', () => {
    // The native switch compares against these exact strings and silently
    // falls through to Earpiece for anything else — 'BLUETOOTH' would be a
    // no-op that looks wired.
    expect(bridge).toMatch(/'Bluetooth'/);
    expect(bridge).toMatch(/'Headset'/);
    expect(bridge).toMatch(/'Speaker'/);
  });

  it('it is Android-only and cannot throw into a call', () => {
    const fn = bridge.slice(bridge.indexOf('export function reportAudioRoute'));
    expect(fn).toMatch(/Platform\.OS !== 'android'/);
    expect(fn).toMatch(/catch/);
  });

  it('it no-ops when no Telecom call is registered', () => {
    const fn = bridge.slice(bridge.indexOf('export function reportAudioRoute'));
    expect(fn).toMatch(/activeTelecomCallId/);
    expect(fn).toMatch(/if \(!callId\) \{return;\}/);
  });

  it('the tracked call id is cleared when the call ends (no stale routing)', () => {
    expect(bridge).toMatch(/activeTelecomCallId === callId.*activeTelecomCallId = null/s);
  });

  it.each([
    'src/screens/messenger/CallScreen.tsx',
    'src/screens/messenger/GroupCallScreen.tsx',
  ])('%s mirrors every applied route to Telecom', rel => {
    expect(codeOnly(rel)).toMatch(/reportAudioRoute\(/);
  });
});

describe('B-391c — the RESTORE path must reach Telecom too', () => {
  const call = readFileSync(
    join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx'), 'utf8')
    .replace(/\r\n/g, '\n');

  /**
   * B-391b mirrored our target onto the self-managed Telecom Connection — the
   * owner of the HFP link — from `pickAudioRouteNative`. Every apply site in
   * CallScreen funnels through it EXCEPT the device-list restore branch, which
   * hand-rolled the same two native calls and mirrored nothing.
   *
   * With earbuds that asymmetry never shows. In a car it decides the bug: a
   * head unit drops SCO routinely (engine stop/start, its own navigation
   * prompt, a phone↔car handover), and every one of those lands in the restore
   * branch. So the ONE path that runs after a car drops the link was the only
   * one that could not bring it back.
   */
  it('the restore branch funnels through the mirroring primitive', () => {
    // COMMENTS STRIPPED BEFORE SLICING. A fixed character window measured from
    // an anchor is only as good as what sits between: documenting WHY this
    // branch matters pushed the code it asserts on past 2000 chars, and the
    // assertion failed on correct code. Strip first, then the window measures
    // code.
    const code = call
      .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const at = code.indexOf('const want = preferredRouteRef.current');
    expect(at).toBeGreaterThan(-1);
    const branch = code.slice(at, at + 2000);
    expect(branch).toMatch(/pickAudioRouteNative\(want\)/);
    // …and NOT by re-implementing the native pair, which is how it drifted.
    expect(branch).not.toMatch(/chooseAudioRoute\?\.\(want\)/);
  });

  it('it invalidates the applied-route cache first, or the funnel swallows it', () => {
    /**
     * `pickAudioRouteNative` short-circuits when the target equals what we last
     * ASKED for — the BS-CALL-CHOPPY de-dupe that stops SCO flapping. Reaching
     * the restore branch means the OS has already moved us off that target, so
     * the cache is stale by definition and the corrective re-apply would be
     * dropped as a no-op. B-278 learned this on the AppState path.
     */
    // GUARDED, not unconditional. Clearing the cache on every device-change
    // event disarmed the de-dupe on the highest-frequency path in the file and
    // removed the only brake on SCO churn during a car's handshake — the funnel
    // also writes the Telecom route, which can itself re-emit the event. The
    // stale case this fix is about is exactly `lastAppliedRoute === want`.
    expect(call).toMatch(/if \(appliedRouteIs\(want\)\) \{invalidateAppliedRoute\(\);\}\n\s*pickAudioRouteNative\(want\);/);
  });

  it('EVERY route apply in CallScreen goes through the mirroring primitive', () => {
    /**
     * Anti-drift: a new apply site that talks to InCallManager directly is a
     * new unmirrored audio owner, which is the entire shape of B-391b.
     *
     * Anchored on the PROPERTY ACCESS, not on a `chooseAudioRoute?.(` call
     * shape — the primitive captures the function into a local first, so the
     * call-shape form matched zero sites and the loop passed over an empty set.
     * Only the count assertion at the end caught that, which is exactly why it
     * is there.
     */
    const code = call
      .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const fn = code.indexOf('function pickAudioRouteNative');
    const fnEnd = code.indexOf('\n}', fn);
    expect(fn).toBeGreaterThan(-1);
    const sites = [...code.matchAll(/\.chooseAudioRoute\b/g)];
    for (const m of sites) {
      const i = m.index ?? 0;
      const inside = i > fn && i < fnEnd;
      expect(`apply@${i} inside the primitive → ${inside}`)
        .toBe(`apply@${i} inside the primitive → true`);
    }
    expect(sites.length).toBeGreaterThan(0);
  });

});
