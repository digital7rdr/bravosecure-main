/**
 * AUDIT-2026-08-13 #6 (client half) — the X-Firebase-AppCheck header.
 *
 * The server guard sits warn-only because no shipped client sends the
 * header; this suite pins the client side: the helper's fail-soft
 * contract (a push registration must NEVER fail because attestation is
 * missing) and the coverage scan (every fetch to a guarded /push route
 * spreads the helper — a new call site that forgets it re-opens the #6
 * gap for that route).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const mockGetToken = jest.fn();
const mockInitializeAppCheck = jest.fn();

// Namespaced-api mock (firebase.appCheck()) — matches the helper, which
// uses it because the modular d.ts does not export the RN provider class.
jest.mock('@react-native-firebase/app-check', () => ({
  firebase: {
    appCheck: () => ({
      newReactNativeFirebaseAppCheckProvider: () => ({
        configure(): void { /* provider config is inert in tests */ },
      }),
      initializeAppCheck: (...a: unknown[]) => mockInitializeAppCheck(...a),
      getToken: (...a: unknown[]) => mockGetToken(...a),
    }),
  },
}));

describe('AUDIT #6 — appCheckHeader fail-soft contract', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetToken.mockReset();
    mockInitializeAppCheck.mockReset();
    mockInitializeAppCheck.mockResolvedValue({app: 'app-check-instance'});
  });

  const load = () =>
    (require('../push/appCheckHeader') as typeof import('../push/appCheckHeader'));

  it('returns the header when attestation mints a token', async () => {
    mockGetToken.mockResolvedValue({token: 'attest-token-1'});
    await expect(load().appCheckHeader()).resolves.toEqual({'X-Firebase-AppCheck': 'attest-token-1'});
  });

  it('returns {} — NEVER throws — when the console provider is not configured', async () => {
    mockGetToken.mockRejectedValue(new Error('AppCheck provider not configured'));
    await expect(load().appCheckHeader()).resolves.toEqual({});
  });

  it('returns {} when init itself dies, and RETRIES init on the next call', async () => {
    mockInitializeAppCheck.mockRejectedValueOnce(new Error('no firebase app'));
    const mod = load();
    await expect(mod.appCheckHeader()).resolves.toEqual({});
    // A failed init must not poison every later attempt (the cached
    // rejected-promise trap): the next call re-inits.
    mockInitializeAppCheck.mockResolvedValue({app: 'ok'});
    mockGetToken.mockResolvedValue({token: 't2'});
    await expect(mod.appCheckHeader()).resolves.toEqual({'X-Firebase-AppCheck': 't2'});
    expect(mockInitializeAppCheck).toHaveBeenCalledTimes(2);
  });

  it('init happens ONCE across concurrent callers (single-flight)', async () => {
    mockGetToken.mockResolvedValue({token: 't'});
    const mod = load();
    await Promise.all([mod.appCheckHeader(), mod.appCheckHeader(), mod.appCheckHeader()]);
    expect(mockInitializeAppCheck).toHaveBeenCalledTimes(1);
  });
});

describe('AUDIT #6 — every guarded /push call site spreads the header (coverage scan)', () => {
  const PUSH_DIR = join(__dirname, '..', 'push');

  const stripComments = (src: string): string =>
    src.split(/\r?\n/)
      .filter(l => {
        const t = l.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      })
      .join('\n');

  it.each(['fcmBootstrap.ts', 'voipPush.ts', 'unregisterPush.ts'])(
    '%s spreads appCheckHeader() into its guarded-route headers', (file) => {
      const code = stripComments(readFileSync(join(PUSH_DIR, file), 'utf8'));
      // The site hits a guarded route…
      expect(/MSG_BASE_URL\}?(\$\{path\}|\/push\/)/.test(code)).toBe(true);
      // …and its headers spread the helper.
      expect(code).toContain('...(await appCheckHeader())');
    });
});
