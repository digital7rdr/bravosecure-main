/**
 * sqa.md bug register — this suite pins: B-236u, B-297.
 *
 * B-236u (the in-call route picker was DEAD for the first ~11 s of every call — taps
 * dropped against an empty `available []` list) is the user-visible symptom of B-297, the
 * phantom InCallManager.getAudioDeviceList() this suite pins: the seed that was supposed to
 * populate that list on call start calls a method the library does not have, so it has
 * never once observed a device.
 */
/**
 * B-297 — `InCallManager.getAudioDeviceList()` DOES NOT EXIST.
 *
 * B-251 introduced a "seed" that was supposed to notice a headset which was
 * ALREADY connected when a call started (that case fires no
 * `onAudioDeviceChanged` transition, so the transition path alone misses it).
 * B-276 copied the same seed into GroupCallScreen. Both read:
 *
 *     (InCallManager as unknown as {getAudioDeviceList?: () => string})
 *       .getAudioDeviceList?.()
 *
 * react-native-incall-manager@4.2.1 has no such method — not in `index.js`,
 * not as a `@ReactMethod` on the Android module, and there is no patch for it
 * in `patches/`. Because the call site uses an OPTIONAL call, the missing
 * method does not throw: it evaluates to `undefined`, the `catch` never runs,
 * `parseAudioDeviceList(undefined)` returns `[]`, and `initialCallRoute([])`
 * falls through to the media-type default. The seed has therefore never once
 * observed a device, on any platform, since the day it was written.
 *
 * It is masked in practice — the FIRST `onAudioDeviceChanged` event carries
 * the full list and the transition handler snaps correctly ~870ms later (device
 * log 2026-07-27, Pixel 6a: request at 10:57:52.839 against `available []`,
 * list populated at 10:57:53.707). So this is dead code with a live
 * replacement, not a broken route. It is logged because it produced FALSE
 * CONFIDENCE: `callAudioRoute.test.ts` is green while the feature it covers
 * never executes, because that suite invents its own device arrays and never
 * touches the native module.
 *
 * The device list has exactly two real sources, both proven against the
 * installed source:
 *   1. the `onAudioDeviceChanged` event payload, and
 *   2. the RESOLVED VALUE of `chooseAudioRoute()` (it resolves
 *      `getAudioDeviceStatusMap()` — InCallManagerModule.java:1528).
 *
 * The screens mount RN views, so the node project cannot import them: the
 * screen half is a comment-stripped source scan. Those files are CRLF, so
 * nothing here is `\n`-anchored — a `\n` anchor matches nothing and passes
 * VACUOUSLY. Comments are stripped first because the B-276 prose in
 * GroupCallScreen.tsx literally contains the banned identifier.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const LIB = join(process.cwd(), 'node_modules', 'react-native-incall-manager');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

function screenSource(file: string): string {
  return stripComments(
    readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', file), 'utf8'),
  );
}

describe('B-297 — the phantom enumerator', () => {
  // Guard rather than assume: a pruned install would otherwise make the
  // contract assertions below pass for the wrong reason.
  const libPresent = existsSync(join(LIB, 'index.js'));

  (libPresent ? it : it.skip)(
    'the installed library exposes NO getAudioDeviceList — this is why the seed was dead',
    () => {
      const js = readFileSync(join(LIB, 'index.js'), 'utf8');
      expect(js).not.toContain('getAudioDeviceList');

      const java = join(
        LIB, 'android', 'src', 'main', 'java', 'com', 'zxcpoiu', 'incallmanager',
        'InCallManagerModule.java',
      );
      if (existsSync(java)) {
        expect(readFileSync(java, 'utf8')).not.toContain('getAudioDeviceList');
      }
    },
  );

  (libPresent ? it : it.skip)(
    'chooseAudioRoute IS real and resolves the device status map — the supported source',
    () => {
      // If this ever fails, the replacement path in the screens is gone too and
      // the auto-snap has no list to work from.
      expect(readFileSync(join(LIB, 'index.js'), 'utf8')).toContain('chooseAudioRoute');

      const java = join(
        LIB, 'android', 'src', 'main', 'java', 'com', 'zxcpoiu', 'incallmanager',
        'InCallManagerModule.java',
      );
      if (existsSync(java)) {
        const src = readFileSync(java, 'utf8');
        // The method resolves the status map, which is what makes it usable as
        // an enumerator at all.
        expect(src).toContain('promise.resolve(getAudioDeviceStatusMap())');
        expect(src).toContain('availableAudioDeviceList');
      }
    },
  );

  it.each(['CallScreen.tsx', 'GroupCallScreen.tsx'])(
    '%s must not call the phantom getAudioDeviceList',
    file => {
      expect(screenSource(file)).not.toContain('getAudioDeviceList');
    },
  );

  it.each(['CallScreen.tsx', 'GroupCallScreen.tsx'])(
    '%s still subscribes to onAudioDeviceChanged — the path that actually works',
    file => {
      // Deleting the dead seed must NOT take the live replacement with it.
      expect(screenSource(file)).toContain('onAudioDeviceChanged');
    },
  );
});
