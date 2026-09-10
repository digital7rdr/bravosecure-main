/**
 * Expo config plugin — re-registers Bravo's hand-written Android native
 * modules in the generated MainApplication.kt on every prebuild.
 *
 * WHY THIS EXISTS
 * ---------------
 * iOS already does this properly: the real sources live in `native/ios/` and
 * `withBravoFrameCryptor` copies + registers them on every prebuild, so
 * `expo prebuild` is safe there. Android had no equivalent. Its five package
 * registrations were hand-edited into MainApplication.kt — a file the Expo
 * template OWNS and regenerates — and the result was force-added to git.
 *
 * That shortcut works until the first prebuild, and then fails in the worst
 * possible way: the app still COMPILES and still SHIPS, but with E2EE call
 * frame crypto, the call foreground service, ringtones, battery optimisation
 * and call volume silently unregistered. There is no build error. You find out
 * from someone on a live protection mission.
 *
 * With this plugin, `expo prebuild` is safe on Android too.
 *
 * DELIBERATELY LOUD
 * -----------------
 * If the anchor cannot be found, this THROWS. A config plugin that silently
 * does nothing recreates the exact failure it was written to prevent — the
 * whole point is that a missing registration must stop the build, not reach a
 * device. Same reasoning as the "no silent stubs" rule in BravoMap.
 */
const {withMainApplication} = require('expo/config-plugins');

/**
 * The packages MainApplication must register, in order. All live in
 * `com.bravosecure.app`, the same package as MainApplication itself, so no
 * import lines are needed — only the `add(...)` calls.
 */
const BRAVO_PACKAGES = [
  'BravoFrameCryptorPackage',
  'BravoCallForegroundPackage',
  'BravoRingtonePackage',
  'BravoBatteryOptimizationPackage',
  'BravoCallVolumePackage',
];

/** The line the Expo template generates, which we append into. */
const ANCHOR = 'PackageList(this).packages.apply {';

function injectPackages(src) {
  const at = src.indexOf(ANCHOR);
  if (at === -1) {
    throw new Error(
      '[withBravoAndroidPackages] Could not find "' +
        ANCHOR +
        '" in MainApplication.kt. The Expo template changed shape. Registering ' +
        'Bravo native modules by hand is NOT an acceptable fallback — it is the ' +
        'failure mode this plugin exists to remove. Fix the anchor here instead.',
    );
  }

  // Idempotent: prebuild runs repeatedly, and a second pass must not duplicate
  // registrations (a duplicated ReactPackage throws at runtime).
  const missing = BRAVO_PACKAGES.filter(p => !src.includes(`add(${p}())`));
  if (missing.length === 0) {
    return src;
  }

  const insertAt = at + ANCHOR.length;
  const indent = '\n              ';
  const added = missing.map(p => `${indent}add(${p}())`).join('');
  return src.slice(0, insertAt) + added + src.slice(insertAt);
}

const withBravoAndroidPackages = config =>
  withMainApplication(config, cfg => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error(
        '[withBravoAndroidPackages] Expected a Kotlin MainApplication, got ' +
          cfg.modResults.language +
          '. Refusing to guess — a wrong injection here ships an app with no ' +
          'call crypto and no foreground service.',
      );
    }
    cfg.modResults.contents = injectPackages(cfg.modResults.contents);
    return cfg;
  });

module.exports = withBravoAndroidPackages;
// Exported for the unit test — the injection rule is what needs pinning, and
// it must be assertable without running a real prebuild.
module.exports.injectPackages = injectPackages;
module.exports.BRAVO_PACKAGES = BRAVO_PACKAGES;
module.exports.ANCHOR = ANCHOR;
