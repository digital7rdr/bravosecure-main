import {Injectable, CanActivate, ExecutionContext, OnModuleInit, UnauthorizedException, Logger} from '@nestjs/common';
import type {Request} from 'express';
import * as admin from 'firebase-admin';

/**
 * P0-N9 — Firebase App Check / Apple App Attest token verification.
 *
 * Without this, any caller with a valid JWT can register an attacker-
 * controlled FCM/APNs token in the victim's slot — all subsequent
 * chat-wakes and VoIP-wakes for the victim then ring the attacker's
 * device instead. The JWT only proves "I have an authed account"; it
 * does NOT prove "this request came from the legit Bravo Secure binary
 * on a non-rooted device."
 *
 * App Check tokens are minted by the Firebase / Apple attestation flow
 * on the client and verified by Firebase Admin server-side. Token TTL
 * is short (default 1h), tokens are single-use when consume:true is
 * passed to verifyToken — eliminates replay.
 *
 * Operator mode toggle via env (trimmed, unquoted, case-insensitive):
 *   APP_CHECK_MODE = 'enforce'   — reject missing/invalid.
 *   APP_CHECK_MODE = 'warn-only' — log + admit (client rollout window).
 *   APP_CHECK_MODE = 'disabled'  — skip the guard (logged loudly in prod).
 *   unset / unrecognized — non-prod: warn-only.
 *                          Prod: FAILS CLOSED on these routes ('enforce')
 *                          with a boot-level error log.
 *
 * AUDIT-2026-08-13 #6 — the old default was warn-only even in prod while
 * this header claimed enforce-in-prod. Two silent failure modes were on
 * the table and both are rejected:
 *   - silent enforce-in-prod: no shipped client sends X-Firebase-AppCheck
 *     yet (sqa.md — the warn-only log fires on every live /push/register),
 *     so a silent flip would 401 every push registration with no signal.
 *     The prod default IS 'enforce' now, but it is paired with a boot-level
 *     error log, a RECURRING (1/min) error AT THE REJECTION SITE (P3-P-1's
 *     shape — diagnosable from the rejection long after the boot error
 *     rotated away), and
 *     scripts/deploy-staging.sh verifies IN ITS PREAMBLE that the box
 *     compose resolves APP_CHECK_MODE to a recognized value on the
 *     messenger-service block before anything is synced or built. Lanes
 *     that bypass that script (rollback `up -d`, the box watchdog) get the
 *     scoped fail-closed posture below, never a dead process.
 *   - REFUSING TO BOOT (rev-1 of this fix, reviewer-rejected): this
 *     service's own misconfig precedents fail closed at the FEATURE level
 *     and keep the process alive (sfu.service.ts "Refusing to enable the
 *     SFU plane in production (fail closed)"; gateway P3-P-1 rejects the
 *     join). The boot-throw precedent lives in auth-service, where an
 *     outage costs login — here it would cost the entire real-time plane
 *     (relay, WS, calls, backup) for a guard that governs five push
 *     routes (register/unregister x2 + token-health — note token-health,
 *     the diagnostic route, is behind this guard too), and the live
 *     deployment's compose file is outside the repo's reach, so the
 *     required env var cannot be shipped atomically with the code. A
 *     guard misconfig must never take messaging down.
 *
 * Bootstrap requires `admin.initializeApp()` to have run with a
 * credential that has App Check permissions. Existing FCM init in
 * push.service.ts already does this — we reuse the default app.
 * Before flipping 'enforce': verify /push/token-health reports
 * fcmReady=true (a missing FCM credential 401s every register for a
 * server-side reason) and that App Check replay protection is enabled
 * on the Firebase project (consume:true requires it). NOTE (edge review
 * 2026-08-14): token-health sits BEHIND this guard and has no client
 * caller — it is an operator probe, so under 'enforce' a bare curl of
 * it 401s BY DESIGN. Probe it BEFORE the flip, or use a Firebase debug
 * token after; do not read its post-flip 401 as the registration
 * outage it exists to diagnose.
 */
@Injectable()
export class AppCheckGuard implements CanActivate, OnModuleInit {
  private readonly log = new Logger(AppCheckGuard.name);
  // Once-per-PROCESS flags — Nest instantiates this guard twice (once from
  // PushModule.providers, once as a @UseGuards injectable), so instance
  // flags would double every "once" log.
  private static warnedMissingMode = false;
  private static warnedDisabledInProd = false;
  private static erroredUnsetInProd = false;
  // Rejection-site log throttles (1/min). The INFERRED (misconfig) class
  // recurs at ERROR level so it survives log rotation — P3-P-1's prod
  // branch logs EVERY rejection; 1/min is the concession to fleet volume,
  // not a once-per-process flag (rev-3's once-only died with the first
  // rotation, reviewer-rejected). Explicit-enforce rejections recur at
  // WARN — the operator chose the mode but still needs to see who is
  // being rejected after the flip.
  // Why the slot layout: the two INFERRED branches deliberately SHARE one
  // slot (one misconfig signal, can't double-spam; the operator's next step
  // is identical either way), while the two EXPLICIT classes deliberately
  // do NOT — post-flip, the high-volume missing-token stream must never
  // starve the invalid-token line (the attestation-failing signal the flip
  // exists to surface). Both properties are mutation-pinned in the spec.
  private static lastInferredRejectMs = 0;
  private static lastEnforceMissingWarnMs = 0;
  private static lastEnforceInvalidWarnMs = 0;

  /** Test-only: reset the once-per-process/throttle state between cases. */
  static resetProcessOnceFlagsForTest(): void {
    AppCheckGuard.warnedMissingMode = false;
    AppCheckGuard.warnedDisabledInProd = false;
    AppCheckGuard.erroredUnsetInProd = false;
    AppCheckGuard.lastInferredRejectMs = 0;
    AppCheckGuard.lastEnforceMissingWarnMs = 0;
    AppCheckGuard.lastEnforceInvalidWarnMs = 0;
  }

  /** 1/min throttle over a static timestamp slot; first hit always logs. */
  private static throttleOk(slot: 'lastInferredRejectMs' | 'lastEnforceMissingWarnMs' | 'lastEnforceInvalidWarnMs'): boolean {
    const now = Date.now();
    if (now - AppCheckGuard[slot] < 60_000) return false;
    AppCheckGuard[slot] = now;
    return true;
  }

  private static isProd(): boolean {
    return process.env.NODE_ENV === 'production';
  }

  /**
   * Raw env → explicit mode, or undefined when unset/unrecognized.
   * Trim + strip surrounding quotes first: compose/env-file parsers keep
   * everything after `=` verbatim, and this repo's env templates are CRLF —
   * a trailing `\r`, space, or quoted value must select the intended mode,
   * not silently degrade it.
   */
  private static explicitMode(): 'enforce' | 'warn-only' | 'disabled' | undefined {
    const raw = (process.env.APP_CHECK_MODE ?? '').trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
    if (raw === 'disabled')  return 'disabled';
    if (raw === 'warn-only') return 'warn-only';
    if (raw === 'enforce')   return 'enforce';
    return undefined;
  }

  /**
   * Boot-time visibility only — this NEVER throws. A prod deploy without an
   * explicit mode fails closed on /push routes (see `mode`), and this error names
   * that consequence in the boot log so the 401s are diagnosable in one read.
   */
  onModuleInit(): void {
    const explicit = AppCheckGuard.explicitMode();
    if (explicit === undefined && AppCheckGuard.isProd() && !AppCheckGuard.erroredUnsetInProd) {
      AppCheckGuard.erroredUnsetInProd = true;
      const raw = process.env.APP_CHECK_MODE;
      this.log.error(
        `[app-check] APP_CHECK_MODE is ${raw === undefined || raw === '' ? 'not set' : `set to the unrecognized value ${JSON.stringify(raw)}`} ` +
        'with NODE_ENV=production — FAILING CLOSED: every /push routes request without a valid App Check token will be rejected (401) until it is set. ' +
        "Set APP_CHECK_MODE explicitly: 'warn-only' during the client rollout window (current clients do not send " +
        "X-Firebase-AppCheck yet), 'enforce' once clients ship the header, or 'disabled' to knowingly turn the gate off. " +
        'Messaging/calls are unaffected — this gate governs only the push routes.',
      );
    }
    if (explicit === 'disabled' && AppCheckGuard.isProd() && !AppCheckGuard.warnedDisabledInProd) {
      AppCheckGuard.warnedDisabledInProd = true;
      this.log.warn('[app-check] APP_CHECK_MODE=disabled in production — the push-token binary-attestation gate is OFF by explicit operator choice.');
    }
  }

  /**
   * `inferred` = the mode was NOT explicitly configured (prod fail-closed
   * fallback / non-prod warn-only default). The rejection site logs the
   * inferred case so a misconfigured box is diagnosable from the rejection
   * itself, P3-P-1 style — the boot error alone dies with log rotation.
   */
  private resolveMode(): {mode: 'enforce' | 'warn-only' | 'disabled'; inferred: boolean} {
    const explicit = AppCheckGuard.explicitMode();
    if (explicit !== undefined) return {mode: explicit, inferred: false};
    // Unset/unrecognized. Prod fails CLOSED — scoped to these routes, never
    // the process (see header). Non-prod stays warn-only for dev/test.
    if (AppCheckGuard.isProd()) return {mode: 'enforce', inferred: true};
    if (!AppCheckGuard.warnedMissingMode) {
      AppCheckGuard.warnedMissingMode = true;
      const raw = process.env.APP_CHECK_MODE;
      this.log.warn(
        `APP_CHECK_MODE ${raw === undefined || raw === '' ? 'not set' : `has unrecognized value ${JSON.stringify(raw)}`} — defaulting to warn-only (non-production only; production fails closed instead). ` +
        'Set APP_CHECK_MODE=enforce once clients ship the X-Firebase-AppCheck header.',
      );
    }
    return {mode: 'warn-only', inferred: true};
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const {mode, inferred} = this.resolveMode();
    if (mode === 'disabled') return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const token = req.header('x-firebase-appcheck') ?? req.header('X-Firebase-AppCheck');

    if (!token || typeof token !== 'string') {
      if (mode === 'warn-only') {
        this.log.warn(`[app-check] missing token path=${req.path} caller=${req.caller?.claims?.sub ?? '?'} — admitting under warn-only`);
        return true;
      }
      if (inferred) {
        // Misconfigured-box rejection — recurring ERROR (1/min) so the
        // reason is readable at the rejection long after the boot error
        // rotated away (P3-P-1's shape).
        if (AppCheckGuard.throttleOk('lastInferredRejectMs')) {
          this.log.error(`[app-check] rejecting path=${req.path} caller=${req.caller?.claims?.sub ?? '?'} reason=app_check_mode_unset_prod — APP_CHECK_MODE is unset/unrecognized so /push routes fails closed. Set it (see runbook). Throttled 1/min.`);
        }
      } else if (AppCheckGuard.throttleOk('lastEnforceMissingWarnMs')) {
        // Explicit enforce: the operator chose this, but they still need
        // visibility into who is being rejected after the flip. 1/min cap.
        this.log.warn(`[app-check] missing token path=${req.path} caller=${req.caller?.claims?.sub ?? '?'} — rejecting under enforce (throttled 1/min)`);
      }
      throw new UnauthorizedException('app_check_missing');
    }

    try {
      // consume:true forces single-use per token — replays fail.
      // Requires Firebase project with App Check enforcement enabled.
      await admin.appCheck().verifyToken(token, {consume: true});
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (mode === 'warn-only') {
        this.log.warn(`[app-check] verify failed path=${req.path} caller=${req.caller?.claims?.sub ?? '?'} reason=${msg} — admitting under warn-only`);
        return true;
      }
      // Reason goes to the LOG only — Firebase's internal error text is not
      // a client-facing contract and must not leak in the response body.
      // This branch goes live the moment clients ship the header, so it must
      // distinguish a misconfigured box from a real verify failure, and it
      // must not spam per-request (a Firebase project without App Check
      // replay protection makes EVERY consume:true verify throw).
      if (inferred) {
        if (AppCheckGuard.throttleOk('lastInferredRejectMs')) {
          this.log.error(`[app-check] verify failed path=${req.path} caller=${req.caller?.claims?.sub ?? '?'} reason=app_check_mode_unset_prod mode=enforce(inferred) verify=${msg} — APP_CHECK_MODE is unset/unrecognized so /push routes fails closed. Throttled 1/min.`);
        }
      } else if (AppCheckGuard.throttleOk('lastEnforceInvalidWarnMs')) {
        this.log.warn(`[app-check] verify failed path=${req.path} caller=${req.caller?.claims?.sub ?? '?'} reason=${msg} — rejecting under enforce (throttled 1/min)`);
      }
      throw new UnauthorizedException('app_check_invalid');
    }
  }
}
