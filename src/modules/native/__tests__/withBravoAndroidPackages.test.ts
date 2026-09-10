/**
 * The Android package-registration plugin.
 *
 * This guards the highest-consequence silent failure in the native build: a
 * prebuild that regenerates MainApplication.kt and drops Bravo's five native
 * module registrations. The app still compiles and still ships — with E2EE
 * call frame crypto, the call foreground service, ringtones, battery
 * optimisation and call volume unregistered, and no build error anywhere.
 *
 * The plugin is CommonJS in plugins/, so it is required rather than imported.
 */

const plugin = require('../../../../plugins/withBravoAndroidPackages');

const {injectPackages, BRAVO_PACKAGES, ANCHOR} = plugin as {
  injectPackages: (src: string) => string;
  BRAVO_PACKAGES: string[];
  ANCHOR: string;
};

/** A MainApplication.kt as the Expo template generates it — no Bravo lines. */
const TEMPLATE = `package com.bravosecure.app

import com.facebook.react.PackageList

class MainApplication : Application(), ReactApplication {
  override val reactNativeHost: ReactNativeHost =
    object : DefaultReactNativeHost(this) {
      override fun getPackages(): List<ReactPackage> =
        ${ANCHOR}
              // add(MyReactNativePackage())
            }
    }
}
`;

describe('withBravoAndroidPackages', () => {
  it('restores every package a prebuild would have dropped', () => {
    const out = injectPackages(TEMPLATE);
    for (const pkg of BRAVO_PACKAGES) {
      expect(out).toContain(`add(${pkg}())`);
    }
    // All five, not "some" — a partial restore is the same class of bug.
    expect(BRAVO_PACKAGES).toHaveLength(5);
  });

  it('names the five modules whose loss is silent', () => {
    // Pinned explicitly: if someone adds a sixth native module and forgets
    // this list, the plugin restores four of five and the build still passes.
    expect(BRAVO_PACKAGES).toEqual([
      'BravoFrameCryptorPackage',
      'BravoCallForegroundPackage',
      'BravoRingtonePackage',
      'BravoBatteryOptimizationPackage',
      'BravoCallVolumePackage',
    ]);
  });

  it('is idempotent — prebuild runs repeatedly', () => {
    const once = injectPackages(TEMPLATE);
    const twice = injectPackages(once);
    expect(twice).toBe(once);
    // A duplicated ReactPackage throws at runtime, so this is not cosmetic.
    for (const pkg of BRAVO_PACKAGES) {
      expect(twice.match(new RegExp(`add\\(${pkg}\\(\\)\\)`, 'g'))).toHaveLength(1);
    }
  });

  it('tops up a PARTIAL registration without duplicating the rest', () => {
    // The real hazard after a half-merge: some lines survived, some did not.
    const partial = TEMPLATE.replace(ANCHOR, `${ANCHOR}\n              add(BravoRingtonePackage())`);
    const out = injectPackages(partial);
    expect(out.match(/add\(BravoRingtonePackage\(\)\)/g)).toHaveLength(1);
    for (const pkg of BRAVO_PACKAGES) {
      expect(out).toContain(`add(${pkg}())`);
    }
  });

  it('THROWS when the anchor is gone, instead of silently doing nothing', () => {
    // A plugin that no-ops here recreates the exact failure it exists to
    // prevent: a green build that ships an app with no call crypto.
    expect(() => injectPackages('package com.bravosecure.app\n// template changed\n')).toThrow(
      /Could not find/,
    );
  });

  it('keeps the registrations inside the getPackages block', () => {
    const out = injectPackages(TEMPLATE);
    const anchorAt = out.indexOf(ANCHOR);
    const closeAt = out.indexOf('}', out.indexOf('add(BravoCallVolumePackage())'));
    for (const pkg of BRAVO_PACKAGES) {
      const at = out.indexOf(`add(${pkg}())`);
      expect(at).toBeGreaterThan(anchorAt);
      expect(at).toBeLessThan(closeAt);
    }
  });
});
