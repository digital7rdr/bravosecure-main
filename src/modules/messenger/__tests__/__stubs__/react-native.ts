/**
 * Jest stub for `react-native` in the `messenger-crypto` project.
 *
 * ⚠️ THIS FILE MUST NOT LIVE IN A `__mocks__` DIRECTORY. ⚠️
 *
 * Jest applies a manual mock for a NODE MODULE automatically, from any
 * `__mocks__` directory under the project roots, with no `jest.mock()`
 * call and — critically — WITHOUT REGARD TO WHICH PROJECT'S
 * `moduleNameMapper` names it. Placing this file in `__mocks__` silently
 * replaced the real react-native in the `app` project too, which is
 * preset-`react-native` and renders real screens: `StyleSheet`, `View`
 * and everything else outside the five symbols below became `undefined`,
 * and 11 of 32 messenger screen suites died at import with
 * "Cannot read properties of undefined (reading 'create')".
 *
 * That misfire also poisoned its own diagnosis: an app-project run taken
 * to establish a "baseline" already had this untracked file on disk, so
 * the breakage read as pre-existing. Verified after moving it here —
 * app project goes 11 failed/15 red → 31 passed/334 green.
 *
 * `__stubs__` is not special to Jest; that is exactly the point. Nothing
 * in here is reachable except through an explicit `moduleNameMapper`
 * entry in ONE project, which is the scoping this needs.
 *
 * WHY THIS EXISTS. The project is `testEnvironment: node` with a
 * transform that does not cover `node_modules/react-native`, whose entry
 * point is Flow-typed ESM:
 *
 *   node_modules/react-native/index.js:27
 *   import typeof * as ReactNativePublicAPI from './index.js.flow';
 *   SyntaxError: Cannot use import statement outside a module
 *
 * Any module that reaches `react-native` — directly or through a chain of
 * relative imports — is therefore UNLOADABLE by this project. That is the
 * real reason `productionRuntime.ts` has zero executable tests: not its
 * size, but this one unresolvable specifier in its dependency graph.
 * `runtime/runtime.ts`, which productionRuntime imports directly, is one
 * of the 15 messenger modules that import react-native.
 *
 * SCOPE. Deliberately minimal. The whole messenger tree consumes exactly
 * five runtime symbols and one type from react-native, so this mock
 * provides those and nothing else. Keep it that way: a stub that grows a
 * fake implementation of a native API is a place for tests to pass
 * against behaviour the device does not have. If a suite needs richer
 * behaviour it should `jest.mock('react-native', …)` locally, which
 * still takes precedence over this mapping.
 *
 * Platform.OS defaults to 'android'. Suites that care about the branch
 * must pin it themselves (see groupCallVideoEncodings.test.ts, which
 * loads the module twice under `jest.isolateModules`) — an implicit
 * default is not a contract.
 */

export const Platform = {
  OS: 'android' as 'android' | 'ios',
  select: <T,>(spec: {android?: T; ios?: T; native?: T; default?: T}): T | undefined =>
    spec.android ?? spec.native ?? spec.default,
  Version: 34,
};

export type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

export const AppState = {
  currentState: 'active' as AppStateStatus,
  addEventListener: (_type: string, _handler: (state: AppStateStatus) => void) => ({
    remove: () => {},
  }),
};

export const DeviceEventEmitter = {
  addListener: (_event: string, _handler: (...args: unknown[]) => void) => ({remove: () => {}}),
  emit: (_event: string, ..._args: unknown[]) => {},
  removeAllListeners: (_event?: string) => {},
};

// Why: an empty object, not a proxy that auto-creates methods. Code that
// reaches for a native module under test should fail loudly rather than
// silently receive a no-op that makes an assertion pass.
export const NativeModules: Record<string, Record<string, unknown>> = {};

export const PermissionsAndroid = {
  PERMISSIONS: {} as Record<string, string>,
  RESULTS: {GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again'},
  request: async () => 'granted',
  check: async () => true,
};
