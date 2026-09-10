/**
 * AUDIT-2026-08-13 #6 — AppCheckGuard configuration matrix.
 *
 * The defect: the guard's header claimed "enforce (default in prod)" while
 * the implementation defaulted to warn-only unconditionally — so production
 * ran the push-token attestation gate admit-everything with one log line as
 * the only signal, and a typo'd mode value did the same while logging "not
 * set".
 *
 * The fix (two reviewer rounds):
 *   - Prod + unset/unrecognized APP_CHECK_MODE → FAIL CLOSED ('enforce') on
 *     these routes only, with a once-per-process boot-level error naming the
 *     consequence. NEVER a process-wide failure: rev-1's boot-throw was
 *     reviewer-rejected because the live deploy lane's compose file is
 *     outside the repo (a crash-loop would take down the whole relay);
 *     this service's own precedents (SFU fail-closed, P3-P-1) gate the
 *     FEATURE and keep the process alive. scripts/deploy-staging.sh
 *     verifies in its PREAMBLE (before any rsync/build) that the box
 *     compose resolves APP_CHECK_MODE to a recognized value on the
 *     messenger-service block; bypass lanes (rollback, watchdog) get the
 *     scoped fail-closed posture, logged at boot AND at the rejection.
 *   - Values are trimmed + unquoted + case-folded: this repo's env
 *     templates are CRLF, so `warn-only\r` (or ' enforce ', or quoted
 *     values) must select the intended mode, not degrade to unset.
 *   - Explicit 'enforce' / 'warn-only' / 'disabled' preserved verbatim;
 *     'disabled' in prod warns once per process (the guard is instantiated
 *     TWICE by Nest — providers + injectables — so the flags are static).
 *   - Non-prod unset/unrecognized: warn-only, and the log names a typo'd
 *     value instead of claiming "not set".
 *   - Under 'enforce', a failed verify logs the Firebase reason but the
 *     response body carries only 'app_check_invalid' (no internal leak).
 */

import {Logger, UnauthorizedException} from '@nestjs/common';
import type {ExecutionContext} from '@nestjs/common';
import {AppCheckGuard} from './app-check.guard';

const mockVerifyToken = jest.fn();
jest.mock('firebase-admin', () => ({
  appCheck: () => ({
    verifyToken: (...args: unknown[]) => mockVerifyToken(...args),
  }),
}));

function fakeCtx(headers: Record<string, string> = {}, path = '/push/register'): ExecutionContext {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {lower[k.toLowerCase()] = v;}
  const req = {
    path,
    header: (name: string) => lower[name.toLowerCase()],
    caller: {claims: {sub: 'user-1'}},
  };
  return {switchToHttp: () => ({getRequest: () => req})} as unknown as ExecutionContext;
}

describe('AppCheckGuard (AUDIT #6)', () => {
  const ENV_KEYS = ['APP_CHECK_MODE', 'NODE_ENV'] as const;
  const saved: Record<string, string | undefined> = {};
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    for (const k of ENV_KEYS) {saved[k] = process.env[k];}
    delete process.env.APP_CHECK_MODE;
    process.env.NODE_ENV = 'test';
    mockVerifyToken.mockReset();
    AppCheckGuard.resetProcessOnceFlagsForTest();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {delete process.env[k];} else {process.env[k] = saved[k];}
    }
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── explicit modes (preserved overrides) ─────────────────────────────

  describe("APP_CHECK_MODE='enforce'", () => {
    beforeEach(() => {process.env.APP_CHECK_MODE = 'enforce';});

    it('rejects a missing token', async () => {
      const guard = new AppCheckGuard();
      await expect(guard.canActivate(fakeCtx())).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');
    });

    it('rejects an invalid token WITHOUT leaking the Firebase reason in the response', async () => {
      mockVerifyToken.mockRejectedValue(new Error('token expired at internal-detail'));
      const guard = new AppCheckGuard();
      await expect(guard.canActivate(fakeCtx({'X-Firebase-AppCheck': 'bad'})))
        .rejects.toThrow(/^app_check_invalid$/);
      // ...but the reason IS logged for the operator.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('token expired at internal-detail'));
    });

    it('admits a valid token and consumes it (replay kill)', async () => {
      mockVerifyToken.mockResolvedValue({appId: 'app'});
      const guard = new AppCheckGuard();
      await expect(guard.canActivate(fakeCtx({'x-firebase-appcheck': 'good'}))).resolves.toBe(true);
      // consume:true is the single-use/anti-replay half of the design — a
      // regression here silently re-enables token replay.
      expect(mockVerifyToken).toHaveBeenCalledWith('good', {consume: true});
    });

    it('never throws at module init, in any NODE_ENV', () => {
      expect(() => new AppCheckGuard().onModuleInit()).not.toThrow();
      process.env.NODE_ENV = 'production';
      expect(() => new AppCheckGuard().onModuleInit()).not.toThrow();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('is case-insensitive', async () => {
      process.env.APP_CHECK_MODE = 'ENFORCE';
      const guard = new AppCheckGuard();
      await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');
    });

    it('the two EXPLICIT rejection classes do NOT share a window (missing vs invalid stay independently visible)', async () => {
      // Mirror of the inferred-sharing pin: after an enforce flip, ~100% of
      // pre-header traffic hits the missing branch every minute — if the two
      // explicit classes shared a slot, that stream would permanently starve
      // the invalid-token line, which is exactly the "clients ship the header
      // but attestation is failing" signal the flip exists to surface.
      const t = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(t);
      try {
        mockVerifyToken.mockRejectedValue(new Error('bad attestation'));
        const guard = new AppCheckGuard();
        await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');
        await expect(guard.canActivate(fakeCtx({'X-Firebase-AppCheck': 'tok'}))).rejects.toThrow('app_check_invalid');
        // Disjoint anchors — both lines end in "rejecting under enforce", so
        // that substring cannot distinguish the classes.
        expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('missing token'))).toHaveLength(1);
        expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('verify failed'))).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('EXPLICIT enforce logs missing-token rejections throttled to 1/min (no unset_prod error)', async () => {
      // After a deliberate enforce flip the operator needs visibility into
      // who is being rejected — but per-request logging would spam under a
      // fleet of pre-header clients.
      const t = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(t);
      try {
        const guard = new AppCheckGuard();
        await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');
        await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');
        spy.mockReturnValue(t + 60_001);
        await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');
        const throttled = warnSpy.mock.calls.filter(c => String(c[0]).includes('rejecting under enforce'));
        expect(throttled).toHaveLength(2); // t and t+60s — the middle call suppressed
        expect(errorSpy.mock.calls.filter(c => String(c[0]).includes('app_check_mode_unset_prod'))).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("APP_CHECK_MODE='warn-only'", () => {
    beforeEach(() => {process.env.APP_CHECK_MODE = 'warn-only';});

    it('admits a missing token (logged)', async () => {
      const guard = new AppCheckGuard();
      await expect(guard.canActivate(fakeCtx())).resolves.toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing token'));
    });

    it('admits an invalid token (logged)', async () => {
      mockVerifyToken.mockRejectedValue(new Error('bad sig'));
      const guard = new AppCheckGuard();
      await expect(guard.canActivate(fakeCtx({'X-Firebase-AppCheck': 'x'}))).resolves.toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('verify failed'));
    });

    it('boots clean in production (the rollout posture, explicitly chosen — no error log)', () => {
      process.env.NODE_ENV = 'production';
      expect(() => new AppCheckGuard().onModuleInit()).not.toThrow();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe("APP_CHECK_MODE='disabled'", () => {
    beforeEach(() => {process.env.APP_CHECK_MODE = 'disabled';});

    it('skips verification entirely', async () => {
      const guard = new AppCheckGuard();
      await expect(guard.canActivate(fakeCtx({'X-Firebase-AppCheck': 'anything'}))).resolves.toBe(true);
      expect(mockVerifyToken).not.toHaveBeenCalled();
    });

    it('logs the explicit off-switch ONCE PER PROCESS across both Nest instances', () => {
      // Nest instantiates the guard twice (providers + @UseGuards
      // injectables) and calls onModuleInit on both — instance flags would
      // double every "once" log, so the flags are static.
      process.env.NODE_ENV = 'production';
      const a = new AppCheckGuard();
      const b = new AppCheckGuard();
      a.onModuleInit();
      b.onModuleInit();
      const disabledWarns = warnSpy.mock.calls.filter(c => String(c[0]).includes('disabled in production'));
      expect(disabledWarns).toHaveLength(1);
    });

    it('does not log the off-switch warning outside production', () => {
      new AppCheckGuard().onModuleInit();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // ── the AUDIT #6 core: unset/unrecognized ────────────────────────────

  describe('unset in production', () => {
    beforeEach(() => {process.env.NODE_ENV = 'production';});

    it('NEVER throws at module init — a guard misconfig must not take the relay down', () => {
      expect(() => new AppCheckGuard().onModuleInit()).not.toThrow();
    });

    it('logs a boot-level ERROR naming the consequence, once per process across both instances', () => {
      const a = new AppCheckGuard();
      const b = new AppCheckGuard();
      a.onModuleInit();
      b.onModuleInit();
      const errs = errorSpy.mock.calls.filter(c => String(c[0]).includes('FAILING CLOSED'));
      expect(errs).toHaveLength(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain('not set');
      // '/push routes' not '/push/*': a literal `/*` inside a log string
      // opens a phantom comment for the house source-scan stripper
      // (sourceScanSafety.test.ts flagged it — the swallowed-code class).
      expect(String(errorSpy.mock.calls[0][0])).toContain('/push routes');
    });

    it('requests FAIL CLOSED (401), never open', async () => {
      const guard = new AppCheckGuard();
      await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');
    });

    it('the INFERRED rejection logs AT THE REJECTION SITE, recurring 1/min so it survives log rotation', async () => {
      // The boot error dies with log rotation, and so would a once-per-process
      // line (it fires seconds after boot, in the same segment). P3-P-1 logs
      // EVERY prod rejection; 1/min is the fleet-volume concession.
      const t = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(t);
      try {
        const guard = new AppCheckGuard();
        await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');
        await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing'); // inside window — suppressed
        spy.mockReturnValue(t + 60_001);
        await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing'); // next window — logs again
        const rejects = errorSpy.mock.calls.filter(c => String(c[0]).includes('app_check_mode_unset_prod'));
        expect(rejects).toHaveLength(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('an INVALID token under inferred enforce also names the misconfig, throttled with the same slot', async () => {
      // The branch that goes live once clients ship the header: a
      // misconfigured box must not blame Firebase for its own unset var,
      // and a Firebase project without replay protection (every
      // consume:true verify throws) must not spam per-request.
      mockVerifyToken.mockRejectedValue(new Error('replay protection disabled'));
      const guard = new AppCheckGuard();
      await expect(guard.canActivate(fakeCtx({'X-Firebase-AppCheck': 'tok'}))).rejects.toThrow(/^app_check_invalid$/);
      await expect(guard.canActivate(fakeCtx({'X-Firebase-AppCheck': 'tok'}))).rejects.toThrow(/^app_check_invalid$/);
      const named = errorSpy.mock.calls.filter(c => String(c[0]).includes('app_check_mode_unset_prod'));
      expect(named).toHaveLength(1);                       // throttled, not per-request
      expect(String(named[0][0])).toContain('enforce(inferred)');
      expect(String(named[0][0])).toContain('replay protection disabled'); // verify reason still present for ops
      // THE SHARING ITSELF (critic+edge cycle-4): both inferred branches must
      // drain ONE misconfig-class slot — a split slot emits 2 lines/min and
      // ran 24/24 GREEN before this assertion existed (both reviewers proved
      // it by mutation). A missing-token rejection inside the same window
      // must therefore NOT produce a second unset_prod line.
      await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');
      expect(errorSpy.mock.calls.filter(c => String(c[0]).includes('app_check_mode_unset_prod'))).toHaveLength(1);
    });

    it('SHARED SLOT, other direction: a missing-token rejection claims the window for the invalid branch too', async () => {
      const t = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(t);
      try {
        mockVerifyToken.mockRejectedValue(new Error('replay protection disabled'));
        const guard = new AppCheckGuard();
        await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');           // claims the slot
        await expect(guard.canActivate(fakeCtx({'X-Firebase-AppCheck': 'tok'}))).rejects.toThrow('app_check_invalid'); // same window
        expect(errorSpy.mock.calls.filter(c => String(c[0]).includes('app_check_mode_unset_prod'))).toHaveLength(1);
        // Next window: whichever branch fires next logs again.
        spy.mockReturnValue(t + 60_001);
        await expect(guard.canActivate(fakeCtx({'X-Firebase-AppCheck': 'tok'}))).rejects.toThrow('app_check_invalid');
        expect(errorSpy.mock.calls.filter(c => String(c[0]).includes('app_check_mode_unset_prod'))).toHaveLength(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('empty string counts as unset', async () => {
      process.env.APP_CHECK_MODE = '';
      const guard = new AppCheckGuard();
      guard.onModuleInit();
      await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');
      expect(errorSpy.mock.calls.filter(c => String(c[0]).includes('not set'))).toHaveLength(1);
    });
  });

  describe('typo in production', () => {
    beforeEach(() => {process.env.NODE_ENV = 'production';});

    it('does not throw; boot error NAMES the unrecognized value; requests fail closed', async () => {
      process.env.APP_CHECK_MODE = 'enforced'; // the plausible typo
      const guard = new AppCheckGuard();
      expect(() => guard.onModuleInit()).not.toThrow();
      expect(errorSpy.mock.calls.filter(c => String(c[0]).includes('"enforced"'))).toHaveLength(1);
      await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');
    });
  });

  describe('value normalization (CRLF env files, quotes, whitespace)', () => {
    // The repo's env templates are CRLF and docker env-file parsers keep
    // everything after `=` verbatim — an invisible byte must never change
    // the selected mode (rev-1 turned `warn-only\r` into an outage).
    it('a trailing CR selects the intended mode (recognized as EXPLICIT, not fallback)', async () => {
      process.env.APP_CHECK_MODE = 'warn-only\r';
      const guard = new AppCheckGuard();
      await expect(guard.canActivate(fakeCtx())).resolves.toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('admitting under warn-only'));
      // In non-prod an unrecognized value ALSO falls back to warn-only, so
      // admission alone cannot pin the trim — assert the value was accepted
      // as explicit (no "unrecognized value" warn fired).
      expect(warnSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes('unrecognized value'))).toHaveLength(0);
    });

    it('surrounding whitespace and quotes are stripped', async () => {
      process.env.NODE_ENV = 'production';
      for (const v of [' enforce ', '"enforce"', "'enforce'", ' "enforce" \r']) {
        process.env.APP_CHECK_MODE = v;
        AppCheckGuard.resetProcessOnceFlagsForTest();
        const guard = new AppCheckGuard();
        expect(() => guard.onModuleInit()).not.toThrow();
        await expect(guard.canActivate(fakeCtx())).rejects.toThrow('app_check_missing');
        expect(errorSpy).not.toHaveBeenCalled(); // recognized → no misconfig error
      }
    });
  });

  describe('unset/invalid outside production', () => {
    it('unset → warn-only admit, logged once per process', async () => {
      const a = new AppCheckGuard();
      const b = new AppCheckGuard();
      await expect(a.canActivate(fakeCtx())).resolves.toBe(true);
      await b.canActivate(fakeCtx());
      const modeWarns = warnSpy.mock.calls.filter(c => String(c[0]).includes('not set'));
      expect(modeWarns).toHaveLength(1);
    });

    it('boots without throwing and without the prod error', () => {
      expect(() => new AppCheckGuard().onModuleInit()).not.toThrow();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('a typo is admitted warn-only but the log NAMES the value instead of claiming "not set"', async () => {
      process.env.APP_CHECK_MODE = 'enforced';
      const guard = new AppCheckGuard();
      await expect(guard.canActivate(fakeCtx())).resolves.toBe(true);
      const named = warnSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes('"enforced"'));
      expect(named).toHaveLength(1);
      expect(warnSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes('APP_CHECK_MODE not set'))).toHaveLength(0);
    });
  });
});
