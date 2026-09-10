/**
 * BB-3 (2026-08-15 back-button audit) — every server-wake SecureTab deep-link
 * must seed the Booking stack's real root beneath its target (initial: false).
 *
 * Flagless nesting re-roots the lazy Booking stack AT the target on a cold
 * start (nestedNavigationInitialFlag.test.ts states the rule): the target
 * becomes the stack's only route. Concretely: 'booking-completed' landed on
 * MissionComplete whose ONLY exit is popToTop() — a no-op on a single-route
 * stack — with gestureEnabled:false, i.e. genuinely stuck; TripSummary's back
 * arrow died on six notification kinds; 'booking-redispatching' landed on
 * FindingDetail where the only live control cancels the booking server-side.
 *
 * The literal `screen: 'X'` scanner in nestedNavigationInitialFlag cannot see
 * these sites (the leaf is a VARIABLE — `screen`, `proScreen`, a ternary), so
 * this suite pins the fcmBootstrap sites by their `name: 'SecureTab'` anchor.
 *
 * fcmBootstrap.ts is CRLF — normalise before matching.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const fcm = readFileSync(
  join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts'),
  'utf8').replace(/\r\n/g, '\n');

describe('BB-3 — server-wake SecureTab deep-links carry initial: false', () => {
  it('every SecureTab candidate seeds the stack root beneath the target', () => {
    const anchors = [...fcm.matchAll(/name: 'SecureTab'/g)].map(m => m.index ?? -1);
    // Anti-vacuity — the wake router genuinely fans out over SecureTab.
    expect(anchors.length).toBeGreaterThanOrEqual(6);
    const unflagged = anchors.filter(i => !/initial: false/.test(fcm.slice(i, i + 220)));
    expect(unflagged.map(i => fcm.slice(i, i + 90))).toEqual([]);
  });

  it('the missed-call CallsLog fallback seeds MessengerHome beneath (BB-3/CallsLog)', () => {
    // The sibling Chat branch six lines up has carried the flag since B-85;
    // the CallsLog arm was the one cold-start lane left flagless, and its
    // back arrow was dead after a missed-call notification tap.
    expect(fcm).toMatch(
      /navigateToMessengerScreen\(navigationRef as never, 'CallsLog', \{\}, \{initial: false\}\)/);
  });
});

describe('BB-3 — the backup screens self-defend on the flagless backupBoot lanes', () => {
  // backupBoot's {screen: 'BackupSetup'/'BackupRestore'} nestings stay
  // DELIBERATELY flagless (nestedNavigationInitialFlag lists them), so the
  // screens themselves must survive being the stack's only route.
  const screen = (f: string): string => readFileSync(
    join(process.cwd(), 'src', 'screens', 'messenger', f), 'utf8').replace(/\r\n/g, '\n');

  it('every BackupSetup leave-without-restore exit rides the guarded leaveSetup', () => {
    const src = screen('BackupSetupScreen.tsx');
    const at = src.indexOf('const leaveSetup');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('};', src.indexOf('} catch', at)));
    expect(body).toMatch(/canGoBack\(\)/);
    expect(body).toMatch(/replace\('MessengerHome'\)/);
    // No exit may bypass it: the only remaining goBack verbs in the file are
    // the ones INSIDE the helper.
    expect(src.match(/goBackOnce\(navigation\)/g)).toHaveLength(1);
    expect(src).not.toMatch(/navigation\.goBack\(\)/);
  });

  it("BackupRestore's Skip restore carries the cold-mount fallback", () => {
    const src = screen('BackupRestoreScreen.tsx');
    expect(src).toMatch(
      /'Skip restore', style: 'destructive', onPress: \(\) => \(\s*navigation\.canGoBack\(\) \? navigation\.goBack\(\) : navigation\.replace\('MessengerHome'\)\)/);
  });
});
