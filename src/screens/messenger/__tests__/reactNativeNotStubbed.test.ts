/**
 * The `app` project must get the REAL react-native, never a stub.
 *
 * This exists because it already went wrong. The `messenger-crypto`
 * project needs a react-native stub (its node environment cannot parse
 * RN's Flow-typed ESM entry), and that stub was first placed in
 * `src/modules/messenger/__tests__/__mocks__/`. Jest auto-applies a
 * manual mock for a NODE MODULE from any `__mocks__` directory under the
 * roots — no `jest.mock()` needed, and no respect for which project's
 * `moduleNameMapper` referenced it. So the stub replaced react-native
 * HERE too, and 11 of 32 messenger screen suites died at import with
 * "Cannot read properties of undefined (reading 'create')" the moment a
 * component reached `StyleSheet.create`.
 *
 * The fix was to move it to a `__stubs__` directory, reachable only
 * through an explicit mapper entry in the one project that wants it.
 *
 * Why this test rather than relying on the 31 render suites: they DO
 * fail when RN is stubbed, but they fail as a wall of unrelated import
 * errors that reads like a broken component. This one names the actual
 * cause. Keep it cheap and keep it first-principles — assert the real
 * module's shape, not our stub's absence, so it also catches a partial
 * mock introduced some other way.
 */
import * as ReactNative from 'react-native';

describe('app project uses the real react-native', () => {
  it('exposes StyleSheet.create — the symbol the stub outage killed', () => {
    expect(typeof ReactNative.StyleSheet?.create).toBe('function');
  });

  it('exposes the core primitives a render suite needs', () => {
    // View/Text are the floor for every screen test in this project.
    expect(ReactNative.View).toBeDefined();
    expect(ReactNative.Text).toBeDefined();
    expect(typeof ReactNative.Dimensions?.get).toBe('function');
  });

  it('is far richer than any stub — surface count sanity check', () => {
    // The messenger-crypto stub exports exactly 5 symbols. Real RN
    // exports well over 50. A low count here means something replaced
    // the module wholesale.
    expect(Object.keys(ReactNative).length).toBeGreaterThan(30);
  });
});
