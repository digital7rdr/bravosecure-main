/**
 * Audit S9 — the LEGACY_FALLBACK escape hatch in push/voipWakeVerify.ts.
 *
 * This flag decides whether an UNSIGNED VoIP wake (or a signed one on a device
 * with no wake key yet) rings the user or is dropped. It used to be a hard-coded
 * `true`, which accepted any replayed payload forever and defeated the entire
 * anti-replay design. It is now read ONCE at module load from
 * EXPO_PUBLIC_VOIP_WAKE_LEGACY, and infra must keep that unset in production.
 *
 * voipWakeVerify.test.ts can only ever see the flag in whatever state the test
 * process happened to boot with — it never re-loads the module — so the two
 * things that actually matter here are unpinned by it:
 *
 *   1. The DEFAULT is fail-CLOSED, and only the exact string "true" opens it
 *      (a truthy-ish "1" / "TRUE" must NOT enable an accept-everything mode).
 *   2. The value is frozen for the process lifetime, so nothing can flip the
 *      verifier open mid-session.
 */
type WakeVerify = typeof import('../push/voipWakeVerify');

/** Load a FRESH copy of the module with the env var in a chosen state. */
function loadWith(envValue: string | undefined): WakeVerify {
  let mod!: WakeVerify;
  jest.isolateModules(() => {
    if (envValue === undefined) {
      delete process.env.EXPO_PUBLIC_VOIP_WAKE_LEGACY;
    } else {
      process.env.EXPO_PUBLIC_VOIP_WAKE_LEGACY = envValue;
    }
    mod = require('../push/voipWakeVerify') as WakeVerify;
  });
  return mod;
}

const UNSIGNED = {kind: 'voip-wake', callId: 'call-legacy'};

let warnSpy: jest.SpyInstance;
const originalEnv = process.env.EXPO_PUBLIC_VOIP_WAKE_LEGACY;

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  // Never leak the override into another suite sharing this worker process.
  if (originalEnv === undefined) {
    delete process.env.EXPO_PUBLIC_VOIP_WAKE_LEGACY;
  } else {
    process.env.EXPO_PUBLIC_VOIP_WAKE_LEGACY = originalEnv;
  }
});

describe('audit S9 — unsigned wakes are rejected by default', () => {
  it('with the env var unset, an unsigned wake is malformed (dropped, no ring)', async () => {
    const m = loadWith(undefined);
    m._setVoipNoncePersistenceForTests({load: async () => null, save: async () => {}});
    m._setVoipWakeKeyLoaderForTests(async () => 'a2V5');

    const r = await m.verifyVoipWake({selfUserId: 'alice', fields: UNSIGNED});

    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('malformed');}
    // No module-load warning when the hatch is shut.
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('LEGACY_FALLBACK');
  });

  it.each(['false', '1', 'TRUE', 'yes', ''])(
    'only the exact string "true" opens the hatch — %p does not',
    async (value) => {
      const m = loadWith(value);
      m._setVoipNoncePersistenceForTests({load: async () => null, save: async () => {}});
      m._setVoipWakeKeyLoaderForTests(async () => null);

      const r = await m.verifyVoipWake({selfUserId: 'alice', fields: UNSIGNED});
      expect(r.ok).toBe(false);
    },
  );
});

describe('the rollout escape hatch (EXPO_PUBLIC_VOIP_WAKE_LEGACY=true)', () => {
  it('accepts an unsigned wake as legacy_unsigned and warns loudly at module load', async () => {
    const m = loadWith('true');
    m._setVoipNoncePersistenceForTests({load: async () => null, save: async () => {}});

    const r = await m.verifyVoipWake({selfUserId: 'alice', fields: UNSIGNED});

    expect(r.ok).toBe(true);
    if (r.ok) {expect(r.reason).toBe('legacy_unsigned');}
    // The warn is the only thing standing between a stray override and a silent
    // accept-everything production build.
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('LEGACY_FALLBACK enabled');
  });

  it('accepts a fully-signed wake on a device with no wake key yet (first run before register)', async () => {
    const m = loadWith('true');
    m._setVoipNoncePersistenceForTests({load: async () => null, save: async () => {}});
    m._setVoipWakeKeyLoaderForTests(async () => null);

    const exp = Math.floor(Date.now() / 1000) + 30;
    const r = await m.verifyVoipWake({
      selfUserId: 'alice',
      fields: {kind: 'voip-wake', callId: 'c-1', nonce: 'n-1', exp, sig: 'anything'},
    });

    expect(r.ok).toBe(true);
    if (r.ok) {expect(r.reason).toBe('legacy_unsigned');}
  });

  it('a forged sig is still rejected while the hatch is open (the hatch only covers ABSENT fields)', async () => {
    const m = loadWith('true');
    m._setVoipNoncePersistenceForTests({load: async () => null, save: async () => {}});
    m._setVoipWakeKeyLoaderForTests(async () => Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'));

    const exp = Math.floor(Date.now() / 1000) + 30;
    const r = await m.verifyVoipWake({
      selfUserId: 'alice',
      fields: {kind: 'voip-wake', callId: 'c-2', nonce: 'n-2', exp, sig: 'forged'},
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('bad_sig');}
  });

  it('the flag is frozen at module load — flipping the env mid-session changes nothing', async () => {
    const m = loadWith(undefined);
    m._setVoipNoncePersistenceForTests({load: async () => null, save: async () => {}});

    process.env.EXPO_PUBLIC_VOIP_WAKE_LEGACY = 'true';
    const r = await m.verifyVoipWake({selfUserId: 'alice', fields: UNSIGNED});

    expect(r.ok).toBe(false); // still fail-closed for the life of this module
  });
});
