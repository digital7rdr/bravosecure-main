/**
 * Audit P1-B1 — biometric-gate soft-fail policy.
 *
 * The screen-side helper (BackupRestoreScreen.requireBiometricUnlock,
 * BackupSetupScreen.requireBiometricUnlock) implements a single
 * decision: when the device cannot prompt biometrics, do we hard-fail
 * the restore or degrade to password-only?
 *
 * Hard-fail would brick first-boot restores on a device that hasn't
 * yet been enrolled — we deliberately soft-fail in that case so the
 * user can complete the restore. The policy is locked here so any
 * future refactor that flips the default fails this regression.
 */
import {evaluateBackupBiometricPolicy} from '../backup/backupBiometricPolicy';

describe('Audit P1-B1 — backup biometric gate policy', () => {
  it('passes when biometric authenticate returns success', () => {
    const v = evaluateBackupBiometricPolicy({
      hasHardware: true,
      isEnrolled:  true,
      authResult:  {success: true},
    });
    expect(v.ok).toBe(true);
    if (v.ok) {expect(v.degraded).toBe(false);}
  });

  it('REJECTS when biometric authenticate returns failure (user cancelled)', () => {
    const v = evaluateBackupBiometricPolicy({
      hasHardware: true,
      isEnrolled:  true,
      authResult:  {success: false},
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('biometric_cancelled');
  });

  it('soft-passes when device has no biometric hardware (first-boot)', () => {
    const v = evaluateBackupBiometricPolicy({
      hasHardware: false,
      isEnrolled:  false,
      authResult:  null,
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.degraded).toBe(true);
      expect(v.reason).toBe('unsupported');
    }
  });

  it('soft-passes when device has hardware but no enrolled credential', () => {
    const v = evaluateBackupBiometricPolicy({
      hasHardware: true,
      isEnrolled:  false,
      authResult:  null,
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.degraded).toBe(true);
      expect(v.reason).toBe('unsupported');
    }
  });

  it('soft-passes when the LocalAuthentication probe threw (rare)', () => {
    const v = evaluateBackupBiometricPolicy({
      hasHardware: null, // probe threw
      isEnrolled:  null,
      authResult:  null,
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.degraded).toBe(true);
      expect(v.reason).toBe('threw');
    }
  });
});
