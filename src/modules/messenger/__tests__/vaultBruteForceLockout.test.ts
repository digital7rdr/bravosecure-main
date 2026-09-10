/**
 * `vaultStore` — audit fix #35, the PIN brute-force lockout, executed.
 *
 * The existing `vaultStore` suite covers setup / verify / the unlock window, but
 * the entire LOCKOUT half was never run: the lockout gate (line 294), the tier
 * application (336/340), `getAttemptStatus` and the malformed-hash migration all
 * sat at 0%. That is the half that resists a stolen device — the PIN is only 4-8
 * digits, so the schedule IS the brute-force resistance:
 *
 *   5 failures → 30 s, 10 → 5 min, 15 → 1 h, and the counters are persisted so a
 *   restart cannot reset them.
 *
 * SECURITY — these tests are written so that WEAKENING the lockout turns them
 * red. Two properties in particular are the ones an "improvement" would quietly
 * remove:
 *
 *   - during a lockout, even the CORRECT PIN is refused (the gate runs before
 *     the hash comparison, so an attacker cannot use a hit to escape the wait);
 *   - `failedAttempts` and `lockoutUntil` are in `partialize`, so force-killing
 *     the app does not hand back a fresh set of guesses.
 *
 * Argon2 is the deterministic PHC stub (`__mocks__/react-native-argon2.ts`) —
 * re-declared in-file only so one test can make the KDF throw.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

jest.mock('react-native-quick-crypto', () => {
  const nodeCrypto = jest.requireActual('node:crypto');
  return {__esModule: true, createHash: nodeCrypto.createHash, createHmac: nodeCrypto.createHmac, install: () => {}};
});

/**
 * A switch so ONE test can fail the KDF — everything else delegates to the
 * shared mock.
 *
 * B-456: this used to be a hand-rolled copy of the stub, and it drifted. It
 * returned `{rawHash, encoded}` and echoed the salt STRING back into the PHC
 * output; the real native module returns `{rawHash, encodedHash}` and embeds
 * base64 of the salt BYTES. Once `hashPin` was fixed to read `.encodedHash`,
 * this local copy handed it `undefined` and every lockout counter read 0.
 * Delegating means the shape can only ever drift in ONE place.
 */
const mockKdfThrows = {value: false};
jest.mock('react-native-argon2', () => {
  const shared = jest.requireActual('./__mocks__/react-native-argon2');
  return {
    __esModule: true,
    default: async (...args: unknown[]) => {
      if (mockKdfThrows.value) {throw new Error('native argon2 unavailable');}
      return (shared.default as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import {useVaultStore} from '../vault/vaultStore';

const s = () => useVaultStore.getState();
const PIN = '246813';
const WRONG = '000000';

/** Burn `n` wrong guesses, returning the last result. */
async function failTimes(n: number) {
  let last = await s().verifyPin(WRONG);
  for (let i = 1; i < n; i++) {last = await s().verifyPin(WRONG);}
  return last;
}

/** Move past a lockout window without ending the test's control of the clock. */
function advance(ms: number) {
  jest.setSystemTime(Date.now() + ms);
}

beforeEach(async () => {
  jest.useFakeTimers({doNotFake: ['queueMicrotask', 'setImmediate']});
  jest.setSystemTime(new Date('2026-08-13T09:00:00Z'));
  mockKdfThrows.value = false;
  s().reset();
  await s().setupPin(PIN);
  s().lock();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('vault PIN lockout — the escalating schedule', () => {
  it('counts down the attempts remaining before the first lockout', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await s().verifyPin(WRONG);
      expect(r).toMatchObject({ok: false, reason: 'wrong'});
      if (!r.ok && r.reason === 'wrong') {seen.push(r.remainingAttemptsBeforeLockout);}
    }
    // A warning that does not count down is not a warning.
    expect(seen).toEqual([4, 3, 2, 1]);
  });

  it('locks out for 30 seconds on the 5th failure', async () => {
    const r = await failTimes(5);
    expect(r).toEqual({ok: false, reason: 'lockout', msUntilRetry: 30_000});
  });

  it('escalates to 5 minutes at 10 failures', async () => {
    await failTimes(5);
    for (let i = 0; i < 4; i++) {advance(31_000); await s().verifyPin(WRONG);}
    advance(31_000);
    expect(await s().verifyPin(WRONG)).toEqual({ok: false, reason: 'lockout', msUntilRetry: 5 * 60_000});
  });

  it('escalates to an hour at 15 failures', async () => {
    await failTimes(5);
    for (let i = 5; i < 14; i++) {advance(5 * 60_000 + 1_000); await s().verifyPin(WRONG);}
    advance(5 * 60_000 + 1_000);
    expect(await s().verifyPin(WRONG)).toEqual({ok: false, reason: 'lockout', msUntilRetry: 60 * 60_000});
  });

  it('keeps re-locking between tiers instead of handing back free guesses', async () => {
    await failTimes(5);
    advance(31_000);
    // Failure 6 is past the first tier but short of the second: it must re-lock,
    // not fall back to the "you have N attempts left" branch.
    expect(await s().verifyPin(WRONG)).toEqual({ok: false, reason: 'lockout', msUntilRetry: 30_000});
  });
});

describe('vault PIN lockout — the wait cannot be skipped', () => {
  /**
   * THE property. The gate is checked BEFORE the candidate is hashed, so a
   * thief who guesses right mid-lockout still waits. Moving the gate after the
   * comparison — the obvious "be nice to the real owner" change — would make the
   * lockout worthless: the attacker's winning guess is the one that escapes it.
   */
  it('refuses even the CORRECT pin while the lockout is live', async () => {
    await failTimes(5);
    const r = await s().verifyPin(PIN);

    expect(r).toMatchObject({ok: false, reason: 'lockout'});
    expect(s().isUnlocked()).toBe(false);
  });

  it('reports a shrinking wait as the window drains', async () => {
    await failTimes(5);
    advance(10_000);
    const r = await s().verifyPin(PIN);
    expect(r).toMatchObject({reason: 'lockout', msUntilRetry: 20_000});
  });

  it('accepts the correct pin once the window has passed, and clears the record', async () => {
    await failTimes(5);
    advance(30_001);

    expect(await s().verifyPin(PIN)).toEqual({ok: true});
    expect(s().isUnlocked()).toBe(true);
    expect(s().getAttemptStatus()).toEqual({failedAttempts: 0, msUntilRetry: 0});
  });

  it('a correct pin resets the counter, so 4 + 4 failures never lock', async () => {
    await failTimes(4);
    expect(await s().verifyPin(PIN)).toEqual({ok: true});

    const r = await failTimes(4);
    expect(r).toMatchObject({ok: false, reason: 'wrong', remainingAttemptsBeforeLockout: 1});
  });

  /**
   * "The counter persists in AsyncStorage so a restart can't reset the lockout."
   * If either field left `partialize`, force-killing the app would hand an
   * attacker a fresh five guesses every 30 seconds — while every in-memory
   * assertion above still passed.
   */
  it('PERSISTS the counters, so a force-kill does not buy fresh guesses', async () => {
    await failTimes(5);
    await Promise.resolve();

    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const persisted = JSON.parse(await AsyncStorage.getItem('bravo-vault-v1')).state;
    expect(persisted.failedAttempts).toBe(5);
    expect(persisted.lockoutUntil).toBe(Date.now() + 30_000);
  });

  it('does NOT persist the unlock window — a restart relocks', async () => {
    expect(await s().verifyPin(PIN)).toEqual({ok: true});
    await Promise.resolve();

    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const persisted = JSON.parse(await AsyncStorage.getItem('bravo-vault-v1')).state;
    expect(persisted.unlockedUntil).toBeUndefined();
    expect(persisted.unlockedUntilMonotonic).toBeUndefined();
  });
});

describe('getAttemptStatus — what the lock screen renders', () => {
  it('reports nothing to wait for before any failure', () => {
    expect(s().getAttemptStatus()).toEqual({failedAttempts: 0, msUntilRetry: 0});
  });

  it('reports the failures accrued while still under the first tier', async () => {
    await failTimes(3);
    expect(s().getAttemptStatus()).toEqual({failedAttempts: 3, msUntilRetry: 0});
  });

  it('reports the live wait during a lockout', async () => {
    await failTimes(5);
    advance(5_000);
    expect(s().getAttemptStatus()).toEqual({failedAttempts: 5, msUntilRetry: 25_000});
  });

  it('clamps an elapsed lockout to zero rather than showing a negative countdown', async () => {
    await failTimes(5);
    advance(60_000);
    expect(s().getAttemptStatus()).toEqual({failedAttempts: 5, msUntilRetry: 0});
  });
});

describe('verifyPin — degenerate stored state fails closed but recoverable', () => {
  /**
   * A pre-Argon2 install stored a bare SHA-256 hex string. `saltFromPhc` cannot
   * read it, so the user could never match it again — the store clears the hash
   * instead, which routes them to first-time setup rather than a vault that
   * refuses every PIN forever.
   */
  it('a legacy non-PHC hash is discarded so the user can set a new PIN', async () => {
    useVaultStore.setState({pinHash: 'a'.repeat(64)});
    expect(s().hasPin()).toBe(true);

    const r = await s().verifyPin(PIN);

    expect(r).toMatchObject({ok: false, reason: 'wrong'});
    expect(s().hasPin()).toBe(false);          // → VaultNewPin, not a dead end
    expect(s().isUnlocked()).toBe(false);
  });

  it('a KDF that throws denies the attempt instead of unlocking', async () => {
    mockKdfThrows.value = true;
    const r = await s().verifyPin(PIN);
    expect(r).toMatchObject({ok: false, reason: 'wrong'});
    expect(s().isUnlocked()).toBe(false);
  });

  it('verifying before a PIN exists never unlocks', async () => {
    s().reset();
    expect(s().hasPin()).toBe(false);
    expect(await s().verifyPin('123456')).toMatchObject({ok: false, reason: 'wrong'});
    expect(s().isUnlocked()).toBe(false);
  });
});

describe('biometric preference — audit fix #36, opt-IN', () => {
  it('setupPin leaves biometric off until the user consents', () => {
    expect(s().biometricEnabled).toBe(false);
  });

  it('the setup screen can turn it on, and back off again', () => {
    s().setBiometricEnabled(true);
    expect(s().biometricEnabled).toBe(true);
    s().setBiometricEnabled(false);
    expect(s().biometricEnabled).toBe(false);
  });

  it('a full wipe takes the consent with it', () => {
    s().setBiometricEnabled(true);
    s().reset();
    expect(s().biometricEnabled).toBe(false);
  });
});

describe('vault albums — renaming a folder', () => {
  it('renames without touching the filed objects', () => {
    const id = s().createVaultAlbum('Licences').id!;
    s().moveToVaultAlbum(['vault/a', 'vault/b'], id);

    expect(s().renameVaultAlbum(id, 'Licences 2026')).toBeNull();
    expect(s().albumState.albums.map(a => a.name)).toEqual(['Licences 2026']);
    expect(s().albumState.assignments).toEqual({'vault/a': id, 'vault/b': id});
  });

  it('refuses an unknown album', () => {
    expect(s().renameVaultAlbum('valb_ghost', 'Anything')).toBe('not_found');
  });

  it('refuses a duplicate name and leaves both folders as they were', () => {
    const a = s().createVaultAlbum('Contracts').id!;
    s().createVaultAlbum('Licences');
    expect(s().renameVaultAlbum(a, 'licences')).toBe('duplicate');
    expect(s().albumState.albums.map(x => x.name)).toEqual(['Contracts', 'Licences']);
  });
});
