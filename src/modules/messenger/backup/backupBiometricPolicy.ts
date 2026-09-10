/**
 * Audit P1-B1 — biometric-gate policy for backup setup / restore /
 * unlock flows.
 *
 * Pulled out of the screen helpers so the soft-fail vs hard-fail
 * decision can be unit-tested without standing up React Native + the
 * expo-local-authentication module. The two screen helpers
 * (BackupRestoreScreen.requireBiometricUnlock and
 * BackupSetupScreen.requireBiometricUnlock) call into LocalAuthentication
 * and then route their inputs through {@link evaluateBackupBiometricPolicy}.
 *
 * The decision matrix:
 *
 *   hasHardware | isEnrolled | authResult     | verdict
 *   ----------- | ---------- | -------------- | ----------------
 *   true        | true       | {success:true} | ok (verified)
 *   true        | true       | {success:false}| hard-fail (cancelled)
 *   true        | false      | n/a            | soft-pass (no enrol)
 *   false       | n/a        | n/a            | soft-pass (no hw)
 *   null (threw)| n/a        | n/a            | soft-pass (degraded)
 *
 * Hard-fail vs soft-fail rationale: a first-boot restore on a brand-
 * new device hasn't had time to enrol biometrics. Hard-failing here
 * would brick legitimate first-boot restores. Soft-fail keeps the
 * password as the floor (which is the legacy pre-P1-B1 behaviour).
 */
export interface BackupBiometricInputs {
  /** Result of LocalAuthentication.hasHardwareAsync — null when probe threw. */
  hasHardware: boolean | null;
  /** Result of LocalAuthentication.isEnrolledAsync — null when probe threw. */
  isEnrolled:  boolean | null;
  /** Result of LocalAuthentication.authenticateAsync — null when not invoked. */
  authResult:  {success: boolean} | null;
}

export type BackupBiometricVerdict =
  | {ok: true;  degraded: false; reason: 'verified'}
  | {ok: true;  degraded: true;  reason: 'unsupported' | 'threw'}
  | {ok: false; reason: 'biometric_cancelled'};

export function evaluateBackupBiometricPolicy(
  i: BackupBiometricInputs,
): BackupBiometricVerdict {
  // Probe-threw branch — treat as no-hardware so the user isn't blocked
  // by an unknown native error. Hard-failing here is a footgun: any
  // upstream expo-local-authentication bug would lock every user out
  // of their backup until patched.
  if (i.hasHardware === null || i.isEnrolled === null) {
    return {ok: true, degraded: true, reason: 'threw'};
  }
  if (!i.hasHardware || !i.isEnrolled) {
    return {ok: true, degraded: true, reason: 'unsupported'};
  }
  // Hardware + enrolment present — the auth result decides.
  if (!i.authResult?.success) {
    return {ok: false, reason: 'biometric_cancelled'};
  }
  return {ok: true, degraded: false, reason: 'verified'};
}
