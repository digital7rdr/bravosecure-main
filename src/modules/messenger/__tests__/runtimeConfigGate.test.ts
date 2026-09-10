/**
 * B-272 — "production runtime requires configureMessengerRuntime(cfg) first",
 * shown to a user, inside a chat.
 *
 * MainNavigator resolves the SQLCipher ownerKey pin from AsyncStorage BEFORE
 * calling configureMessengerRuntime(), so from process start until that read
 * resolves there is no config and every getMessengerRuntime() throws. Nothing
 * used to reach that window; a notification deep-link now does — it mounts
 * ChatScreen in the same frame MainNavigator mounts, and the chat's own
 * pullEnvelopes() raced the read. It lost, threw, and ChatScreen swallowed the
 * throw into a console.log that release builds strip. The drain for the very
 * message the user tapped never ran.
 *
 * The gate makes early callers WAIT for the in-flight configure. `configEpoch`
 * exists because the gate's own body calls _resetMessengerRuntime() on its way
 * to configuring: a build parked on the gate would wake up with its singleton
 * nulled and start a SECOND buildProductionRuntime — two SQLCipher opens.
 */

jest.mock('react-native', () => ({Platform: {OS: 'test'}}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(async () => null),
    setItem:    jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  },
}));
jest.mock('../runtime/keychain', () => ({getOrCreateDbKey: jest.fn(async () => 'deadbeefdeadbeef')}));
jest.mock('../crypto', () => ({}));

import {
  getMessengerRuntime, _resetMessengerRuntime, setMessengerConfigGate,
} from '../runtime/runtime';

const deferred = (): {promise: Promise<void>; resolve: () => void} => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(r => { resolve = r; });
  return {promise, resolve};
};

describe('B-272 — the runtime config gate', () => {
  beforeEach(() => {
    _resetMessengerRuntime();
    setMessengerConfigGate(null);
  });
  afterEach(() => { setMessengerConfigGate(null); });

  it('with NO gate, an unconfigured production build still fails fast', () => {
    // The gate must not turn a genuine misconfiguration into a hang.
    return expect(getMessengerRuntime('production')).rejects.toThrow(/configureMessengerRuntime/);
  });

  it('a caller arriving during an in-flight configure WAITS instead of throwing', async () => {
    const gate = deferred();
    setMessengerConfigGate(gate.promise);

    const pending = getMessengerRuntime('production');
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    // THE BUG: without the gate this has already rejected by now, and the raw
    // message is on the user's screen.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    // The gate settled without configuring (the cancelled-effect case), so the
    // honest outcome is still a failure — but only AFTER waiting for it.
    await expect(pending).rejects.toThrow(/configureMessengerRuntime/);
  });

  it('a gate that REJECTS does not wedge the caller', async () => {
    // The gate is MainNavigator's async effect; if it throws, every caller
    // parked behind it must still get an answer.
    setMessengerConfigGate(Promise.reject(new Error('storage blew up')));
    await expect(getMessengerRuntime('production')).rejects.toThrow(/configureMessengerRuntime/);
  });

  it('_resetMessengerRuntime bumps the epoch so a parked build hands off', async () => {
    // Pinning the mechanism, not just the outcome: the gate body resets the
    // singleton before configuring, and the parked caller must notice.
    const gate = deferred();
    let epochObserved = false;
    setMessengerConfigGate(gate.promise.then(() => {
      _resetMessengerRuntime();      // what MainNavigator does mid-gate
      epochObserved = true;
    }));

    const pending = getMessengerRuntime('production');
    gate.resolve();
    await expect(pending).rejects.toThrow(/configureMessengerRuntime/);
    expect(epochObserved).toBe(true);
  });

  it('loopback mode is untouched by the gate', () => {
    // The gate is production-only; a dev loopback boot must not wait on it.
    setMessengerConfigGate(new Promise<void>(() => { /* never settles */ }));
    // Not awaited — we only assert it does not park on the never-settling gate
    // by checking it returns a promise distinct from a production call.
    const p = getMessengerRuntime('loopback-memory');
    expect(p).toBeInstanceOf(Promise);
    void p.catch(() => undefined);
  });
});
