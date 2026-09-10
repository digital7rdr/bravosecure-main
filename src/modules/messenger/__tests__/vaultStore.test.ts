/**
 * Unit tests for the local vault UX store.
 *
 * Round 3 / vault-test-refactor: this suite was rewritten to match the
 * Round 1 vault hardening:
 *   - setupPin / verifyPin / changePin are now async (Argon2id KDF lives
 *     behind a Promise) → every call site uses await
 *   - verifyPin returns a discriminated union {ok: true} | {ok: false,
 *     reason, …} so caller can surface lockout state
 *   - biometric is opt-in only — setupPin no longer flips it on by
 *     default (Audit fix #36)
 *   - pinHash is now a PHC-formatted Argon2id string ($argon2id$v=19$
 *     m=…,t=…,p=…$salt$hash) — not a 64-char SHA-256 hex
 *
 * Argon2 itself is mocked (see __mocks__/react-native-argon2.ts);
 * sha256(salt || pin) is the deterministic stand-in. The tests assert
 * the round-trip (setupPin → verifyPin matches; wrong pin doesn't),
 * not the cryptographic strength of the KDF (which is exercised by
 * the native build).
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

// react-native-quick-crypto is a native module; shim createHash onto
// Node's built-in crypto for unit tests. Production code path is unchanged.
jest.mock('react-native-quick-crypto', () => {
  const nodeCrypto = jest.requireActual('node:crypto');
  return {
    __esModule: true,
    createHash: nodeCrypto.createHash,
    install:    () => {},
    createHmac: nodeCrypto.createHmac,
  };
});

/**
 * B-456(b) — record every argon2 invocation so the SALT ENCODING can be pinned
 * at the decision site. Delegates to the real (moduleNameMapper'd) mock, which
 * reproduces the native salt-bytes -> base64 transformation; without that this
 * spy would prove nothing.
 */
const mockArgon2Calls: Array<{salt: string; saltEncoding: unknown}> = [];
jest.mock('react-native-argon2', () => {
  const real = jest.requireActual('react-native-argon2').default;
  return {
    __esModule: true,
    default: (password: string, salt: string, options?: Record<string, unknown>) => {
      mockArgon2Calls.push({salt, saltEncoding: options?.saltEncoding});
      return real(password, salt, options);
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {useVaultStore, type VaultFile} from '../vault/vaultStore';

function tick(ms: number) {
  jest.setSystemTime(Date.now() + ms);
}

/** Let zustand/persist's async write land. setImmediate is not faked here. */
const flush = () => new Promise<void>(r => setImmediate(r));

const file = (objectKey: string, overrides: Partial<VaultFile> = {}): VaultFile => ({
  objectKey,
  keyB64:    'k',
  ivB64:     'v',
  name:      `${objectKey}.bin`,
  size:      128,
  mimeType:  'application/octet-stream',
  createdAt: Date.now(),
  ...overrides,
});

describe('vaultStore — local PIN/biometric unlock gate', () => {
  beforeEach(() => {
    // Fake-timer scope is `setTimeout/setInterval/Date` only — leave
    // queueMicrotask / Promise.resolve real so `await` resolves
    // naturally inside the tests.
    jest.useFakeTimers({doNotFake: ['queueMicrotask', 'setImmediate']});
    jest.setSystemTime(new Date('2026-04-21T00:00:00Z'));
    useVaultStore.getState().reset();
    mockArgon2Calls.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('setup + verify', () => {
    it('starts with no PIN and locked', () => {
      const s = useVaultStore.getState();
      expect(s.hasPin()).toBe(false);
      expect(s.isUnlocked()).toBe(false);
      expect(s.biometricEnabled).toBe(false);
    });

    it('setupPin stores a PHC-formatted Argon2id hash and leaves biometric OFF', async () => {
      await useVaultStore.getState().setupPin('123456');

      const s = useVaultStore.getState();
      expect(s.hasPin()).toBe(true);
      // Audit fix #36 — biometric must NOT auto-enable on setup. The
      // Setup screen flips it on after explicit consent.
      expect(s.biometricEnabled).toBe(false);
      expect(s.isUnlocked()).toBe(true);
      // PHC string format: `$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>`.
      // Both trailing fields are BASE64 of bytes — that is what the argon2
      // reference encoder emits and what the native modules hand back. The
      // pattern used to require hex for the hash, which only ever described
      // the old lying test mock (B-456).
      expect(s.pinHash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
      expect(s.pinHash).not.toContain('123456');
    });

    it('verifyPin returns ok=false (wrong) when no PIN has been set', async () => {
      const result = await useVaultStore.getState().verifyPin('anything');
      expect(result.ok).toBe(false);
    });

    it('verifyPin matches the exact PIN and rejects others', async () => {
      const {setupPin, verifyPin, lock} = useVaultStore.getState();
      await setupPin('654321');
      lock();

      expect((await verifyPin('654320')).ok).toBe(false);
      expect((await verifyPin('')).ok).toBe(false);
      expect((await verifyPin('654321')).ok).toBe(true);
    });

    it('verifyPin on success opens the unlock window', async () => {
      const {setupPin, verifyPin, lock, isUnlocked} = useVaultStore.getState();
      await setupPin('111111');
      lock();

      expect(isUnlocked()).toBe(false);
      expect((await verifyPin('111111')).ok).toBe(true);
      expect(useVaultStore.getState().isUnlocked()).toBe(true);
    });

    it('verifyPin on failure does NOT open the unlock window', async () => {
      const {setupPin, verifyPin, lock, isUnlocked} = useVaultStore.getState();
      await setupPin('111111');
      lock();

      await verifyPin('000000');
      expect(isUnlocked()).toBe(false);
    });
  });

  /**
   * B-456 — THE VAULT PIN NEVER WORKED, through two independent mechanisms.
   * Both are pinned here because either one alone bricks the vault.
   */
  describe('B-456(a) — the hash is actually read off the native result', () => {
    it('setupPin produces a STRING, not undefined', async () => {
      await useVaultStore.getState().setupPin('123456');
      // The old code read `result.encoded`; the module returns `encodedHash`
      // (RNArgon2Module.java:89-92 / index.d.ts:11-15). `undefined` is not
      // `null`, so hasPin() still said true and the no-PIN escape was blocked
      // while every unlock failed.
      expect(typeof useVaultStore.getState().pinHash).toBe('string');
    });

    it('pinHash survives persistence — the cold-start "Set New PIN" loop', async () => {
      await useVaultStore.getState().setupPin('123456');
      await flush();
      const raw = await AsyncStorage.getItem('bravo-vault-v1');
      expect(raw).toBeTruthy();
      // JSON.stringify DROPS undefined values, so an undefined pinHash was
      // silently absent from the record and every launch rehydrated to null.
      const persisted = JSON.parse(raw as string) as {state: {pinHash: unknown}};
      expect(typeof persisted.state.pinHash).toBe('string');
      expect(persisted.state.pinHash).toBe(useVaultStore.getState().pinHash);
    });

    it('a wrong PIN reaches the lockout counter instead of early-returning', async () => {
      const {setupPin, verifyPin, lock} = useVaultStore.getState();
      await setupPin('123456');
      lock();
      await verifyPin('000000');
      // With pinHash undefined, verifyPin bailed at the `if (!state.pinHash)`
      // guard — so brute-force protection never armed either.
      expect(useVaultStore.getState().failedAttempts).toBe(1);
    });
  });

  describe('B-456(b) — create and verify hash against IDENTICAL salt bytes', () => {
    it('always asks the native module to decode the salt as hex', async () => {
      const {setupPin, verifyPin, lock} = useVaultStore.getState();
      await setupPin('246810');
      lock();
      await verifyPin('246810');
      expect(mockArgon2Calls.length).toBeGreaterThanOrEqual(2);
      for (const call of mockArgon2Calls) {
        // Without this the native side hashes the 32 ASCII characters of the
        // hex string (RNArgon2Module.java:66-68) rather than the 16 bytes.
        expect(call.saltEncoding).toBe('hex');
        expect(call.salt).toMatch(/^[0-9a-f]+$/);
      }
    });

    it('the verify salt is byte-identical to the create salt', async () => {
      const {setupPin, verifyPin, lock} = useVaultStore.getState();
      await setupPin('246810');
      lock();
      await verifyPin('246810');
      const [create, verify] = mockArgon2Calls;
      expect(verify.salt).toBe(create.salt);
    });

    it('the PHC salt field is base64 of those bytes, NOT the text we passed in', async () => {
      await useVaultStore.getState().setupPin('246810');
      const saltHex = mockArgon2Calls[0].salt;
      const phcSalt = (useVaultStore.getState().pinHash as string).split('$')[4];
      // This is the whole trap: feeding `phcSalt` back as the salt (what the
      // old saltFromPhc did) hashes against different bytes every time, so
      // verify could never match even with (a) fixed.
      expect(phcSalt).not.toBe(saltHex);
      expect(Buffer.from(phcSalt, 'base64').toString('hex')).toBe(saltHex);
    });

    it('round-trips create -> verify across a full lock (the user-visible bug)', async () => {
      const {setupPin, lock} = useVaultStore.getState();
      await setupPin('818181');
      lock();
      expect(useVaultStore.getState().isUnlocked()).toBe(false);
      expect((await useVaultStore.getState().verifyPin('818181')).ok).toBe(true);
      expect(useVaultStore.getState().isUnlocked()).toBe(true);
    });

    it('a pre-Argon2 SHA-256 hex hash forces a fresh setup rather than a stuck vault', async () => {
      // The only legacy shape that ever reached storage — no `$` separators,
      // so saltHexFromPhc returns null. See the partialize comment: nothing
      // else was ever persisted, which is why no migration exists.
      useVaultStore.setState({pinHash: 'a'.repeat(64)});
      const r = await useVaultStore.getState().verifyPin('123456');
      expect(r.ok).toBe(false);
      expect(useVaultStore.getState().pinHash).toBeNull();
      expect(useVaultStore.getState().hasPin()).toBe(false);
    });
  });

  /**
   * B-459 — `setBiometricEnabled` had zero callers, so `biometricEnabled` was
   * permanently false and VaultLock's auto-prompt could never fire. The
   * wiring lives in VaultNewPinScreen (pinned by vaultBiometricOptIn.test.ts);
   * this pins that the flag the screen sets is real and durable.
   */
  describe('B-459 — the biometric opt-in flag is settable and persisted', () => {
    it('setBiometricEnabled flips the flag', async () => {
      await useVaultStore.getState().setupPin('123456');
      expect(useVaultStore.getState().biometricEnabled).toBe(false);
      useVaultStore.getState().setBiometricEnabled(true);
      expect(useVaultStore.getState().biometricEnabled).toBe(true);
    });

    it('the flag reaches storage, so consent survives a relaunch', async () => {
      await useVaultStore.getState().setupPin('123456');
      useVaultStore.getState().setBiometricEnabled(true);
      await flush();
      const raw = await AsyncStorage.getItem('bravo-vault-v1');
      const persisted = JSON.parse(raw as string) as {state: {biometricEnabled: unknown}};
      expect(persisted.state.biometricEnabled).toBe(true);
    });

    it('reset() revokes it — a new account never inherits the old one\'s consent', async () => {
      await useVaultStore.getState().setupPin('123456');
      useVaultStore.getState().setBiometricEnabled(true);
      useVaultStore.getState().reset();
      expect(useVaultStore.getState().biometricEnabled).toBe(false);
    });
  });

  /**
   * W6 — a malformed stored hash is a clean slate for the CONSENT too.
   *
   * This was the one state where `biometricEnabled === true` could legally
   * outlive `pinHash === null`: the branch nulled the hash and left the
   * biometric consent standing, granted against a credential that no longer
   * exists, until the next setupPin happened to clear it.
   */
  describe('W6 — the malformed-record branch clears the biometric consent', () => {
    it('verifyPin nulls the hash AND turns biometric off', async () => {
      await useVaultStore.getState().setupPin('123456');
      useVaultStore.getState().setBiometricEnabled(true);
      // The only legacy shape that ever reached storage — no `$` separators.
      useVaultStore.setState({pinHash: 'a'.repeat(64)});

      const r = await useVaultStore.getState().verifyPin('123456');

      expect(r.ok).toBe(false);
      expect(useVaultStore.getState().pinHash).toBeNull();
      expect(useVaultStore.getState().biometricEnabled).toBe(false);
    });
  });

  /**
   * `pinFresh()` — the consent anchor for arming biometric unlock from
   * Settings. NOT `isUnlocked()`: that 5-minute window is also opened by
   * `unlockWithBiometric`, and even a PIN-opened one survives handing the
   * phone over (unlock for Files → give it to someone → they enrol a finger).
   *
   * The two clocks are ANDed for the same reason audit #37 ANDs them on the
   * unlock window, and each is floored at delta >= 0:
   *   - wall alone: a clock ROLLBACK makes the stamp look 0 ms old forever;
   *   - monotonic alone: `uptimeMillis` stops in doze, so a pocketed phone
   *     stays "fresh" across twenty wall-clock minutes.
   * The monotonic source is driven independently here — `performance.now()`
   * moving with `jest.setSystemTime` would make the two clocks one clock and
   * every case below vacuous.
   */
  describe('pinFresh — the biometric-arming consent anchor', () => {
    let mono = 0;
    const realPerf = (globalThis as {performance?: unknown}).performance;

    beforeEach(() => {
      mono = 1_000_000;
      Object.defineProperty(globalThis, 'performance', {
        value: {now: () => mono}, configurable: true, writable: true,
      });
    });
    afterEach(() => {
      Object.defineProperty(globalThis, 'performance', {
        value: realPerf, configurable: true, writable: true,
      });
    });

    /** Advance BOTH clocks, the way real elapsed time does. */
    const elapse = (ms: number) => { tick(ms); mono += ms; };

    it('is false until a PIN has ever been typed', () => {
      expect(useVaultStore.getState().pinFresh()).toBe(false);
      expect(useVaultStore.getState().lastPinProofAt).toBeNull();
      expect(useVaultStore.getState().lastPinProofMonotonic).toBeNull();
    });

    it('setupPin stamps it, and it expires after 60 seconds', async () => {
      await useVaultStore.getState().setupPin('123456');
      expect(useVaultStore.getState().pinFresh()).toBe(true);

      elapse(59_000);
      expect(useVaultStore.getState().pinFresh()).toBe(true);

      elapse(2_000);
      expect(useVaultStore.getState().pinFresh()).toBe(false);
    });

    it('a verifyPin SUCCESS re-stamps it — a wrong PIN does not', async () => {
      await useVaultStore.getState().setupPin('123456');
      elapse(90_000);
      expect(useVaultStore.getState().pinFresh()).toBe(false);

      expect((await useVaultStore.getState().verifyPin('999999')).ok).toBe(false);
      expect(useVaultStore.getState().pinFresh()).toBe(false);

      expect((await useVaultStore.getState().verifyPin('123456')).ok).toBe(true);
      expect(useVaultStore.getState().pinFresh()).toBe(true);
    });

    it('changePin stamps it — the same 6-digits-twice presence proof', async () => {
      await useVaultStore.getState().setupPin('123456');
      elapse(90_000);
      expect(useVaultStore.getState().pinFresh()).toBe(false);

      await useVaultStore.getState().changePin('654321');
      expect(useVaultStore.getState().pinFresh()).toBe(true);
    });

    it('a clock ROLLBACK cannot re-open it — the wall delta goes negative', async () => {
      await useVaultStore.getState().setupPin('123456');
      // Deliberately still fresh on the MONOTONIC clock, so this case turns
      // purely on the wall-clock floor. (Letting the monotonic side expire too
      // would make it pass with `delta >= 0` deleted — a vacuous pin.)
      elapse(10_000);
      expect(useVaultStore.getState().pinFresh()).toBe(true);

      // Attacker (or a timezone fix) winds the wall clock back past the stamp.
      // Without the floor a negative delta reads as "0 ms old", i.e. FOREVER
      // fresh.
      jest.setSystemTime(Date.now() - 10 * 60_000);
      expect(useVaultStore.getState().pinFresh()).toBe(false);
    });

    it('DOZE cannot hold it open — the monotonic clock stops, the wall does not', async () => {
      await useVaultStore.getState().setupPin('123456');
      // Pocketed phone: uptimeMillis freezes while 20 real minutes pass.
      tick(20 * 60_000);
      expect(useVaultStore.getState().pinFresh()).toBe(false);
    });

    it('a monotonic-only advance closes it too — neither clock rules alone', async () => {
      await useVaultStore.getState().setupPin('123456');
      mono += 90_000;
      expect(useVaultStore.getState().pinFresh()).toBe(false);
    });

    it('a monotonic reading in the PAST is refused, not read as 0 ms old', async () => {
      await useVaultStore.getState().setupPin('123456');
      // performance.now() is absent on some RN builds, where monotonicNow()
      // degrades to Date.now() — a source that CAN move backwards.
      mono -= 5_000;
      expect(useVaultStore.getState().pinFresh()).toBe(false);
    });

    it('reset() clears the proof — a signed-out device is not a fresh one', async () => {
      await useVaultStore.getState().setupPin('123456');
      expect(useVaultStore.getState().pinFresh()).toBe(true);

      useVaultStore.getState().reset();

      expect(useVaultStore.getState().pinFresh()).toBe(false);
      expect(useVaultStore.getState().lastPinProofAt).toBeNull();
      expect(useVaultStore.getState().lastPinProofMonotonic).toBeNull();
    });

    it('is NOT persisted — a proof must not outlive the process that saw it', async () => {
      await useVaultStore.getState().setupPin('123456');
      await flush();

      const raw = await AsyncStorage.getItem('bravo-vault-v1');
      const persisted = JSON.parse(raw as string) as {state: Record<string, unknown>};
      expect(persisted.state).not.toHaveProperty('lastPinProofAt');
      expect(persisted.state).not.toHaveProperty('lastPinProofMonotonic');
      // The flag beside it IS persisted, or consent would not survive a
      // relaunch — the two must never be confused for each other.
      expect(persisted.state).toHaveProperty('biometricEnabled');
    });
  });

  describe('unlock window lifecycle', () => {
    it('stays unlocked for the full 5-minute window', async () => {
      await useVaultStore.getState().setupPin('123456');
      tick(4 * 60 * 1000); // 4 minutes in
      expect(useVaultStore.getState().isUnlocked()).toBe(true);
    });

    it('auto-relocks after 5 minutes of idle', async () => {
      await useVaultStore.getState().setupPin('123456');
      tick(5 * 60 * 1000 + 1);
      expect(useVaultStore.getState().isUnlocked()).toBe(false);
    });

    it('biometric unlock extends the window without verifying the PIN', async () => {
      const {setupPin, lock, unlockWithBiometric, isUnlocked} = useVaultStore.getState();
      await setupPin('123456');
      lock();
      expect(isUnlocked()).toBe(false);

      unlockWithBiometric();
      expect(useVaultStore.getState().isUnlocked()).toBe(true);
    });

    it('manual lock() closes the window immediately', async () => {
      const {setupPin, lock} = useVaultStore.getState();
      await setupPin('123456');
      lock();
      expect(useVaultStore.getState().isUnlocked()).toBe(false);
      expect(useVaultStore.getState().unlockedUntil).toBeNull();
    });
  });

  describe('changePin', () => {
    it('replaces the stored hash and keeps the vault unlocked', async () => {
      const {setupPin, changePin, verifyPin, lock} = useVaultStore.getState();
      await setupPin('111111');
      const before = useVaultStore.getState().pinHash;

      await changePin('999999');
      const after = useVaultStore.getState().pinHash;
      expect(after).not.toBe(before);

      lock();
      expect((await verifyPin('111111')).ok).toBe(false);
      expect((await verifyPin('999999')).ok).toBe(true);
    });
  });

  describe('file index', () => {
    it('prepends new files and dedupes by objectKey', () => {
      const {addFile} = useVaultStore.getState();
      addFile(file('a'));
      addFile(file('b'));
      addFile(file('a')); // duplicate — ignored
      expect(useVaultStore.getState().files.map(f => f.objectKey)).toEqual(['b', 'a']);
    });

    it('removeFile drops the matching entry only', () => {
      const {addFile, removeFile} = useVaultStore.getState();
      addFile(file('a'));
      addFile(file('b'));
      addFile(file('c'));
      removeFile('b');
      expect(useVaultStore.getState().files.map(f => f.objectKey)).toEqual(['c', 'a']);
    });
  });

  describe('reset', () => {
    it('wipes PIN, biometric flag, unlock window, and files', async () => {
      const s = useVaultStore.getState();
      await s.setupPin('123456');
      s.addFile(file('a'));

      s.reset();

      const after = useVaultStore.getState();
      expect(after.pinHash).toBeNull();
      expect(after.biometricEnabled).toBe(false);
      expect(after.unlockedUntil).toBeNull();
      expect(after.files).toEqual([]);
    });
  });
});
