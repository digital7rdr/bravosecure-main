/**
 * Finding 15 — shared biometric gate used by BOTH backup screens
 * (BackupSetupScreen + BackupRestoreScreen), which each had a ~30-line
 * copy. Audit P1-B1 — a fresh biometric / device-passcode prompt fires
 * BEFORE the Argon2 derive, so an attacker who recovered the backup
 * password still needs the user's device unlock.
 *
 * Soft-fails to password-only on devices with no hardware / no enrolment
 * (a brand-new device restoring a backup is a legitimate first-boot flow);
 * hard-fails on explicit user cancellation. The decision matrix lives in
 * backupBiometricPolicy so it can be unit-tested without native modules.
 */
import * as LocalAuthentication from 'expo-local-authentication';
import {evaluateBackupBiometricPolicy} from './backupBiometricPolicy';

export async function runBackupBiometricGate(
  promptMessage: string,
): Promise<{ok: boolean; reason?: string}> {
  let hasHardware: boolean | null = null;
  let isEnrolled:  boolean | null = null;
  let authResult:  {success: boolean} | null = null;
  try {
    [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (hasHardware && isEnrolled) {
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage,
        fallbackLabel: 'Use device PIN',
        cancelLabel:   'Cancel',
        disableDeviceFallback: false,
      });
      authResult = {success: !!r.success};
    }
  } catch (e) {
    console.warn('[bravo.backup] biometric check threw:', (e as Error).message);
    hasHardware = null; isEnrolled = null;
  }
  return evaluateBackupBiometricPolicy({hasHardware, isEnrolled, authResult});
}
