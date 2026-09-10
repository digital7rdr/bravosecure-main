/**
 * Finding 9 — map internal backup error CODES to human-readable copy for
 * the backup screens. Previously codes like `messenger_not_ready`,
 * `not_logged_in`, `probe_failed_retry`, and `Restore failed: <kind>`
 * were rendered verbatim to users. Strings that are already sentences (or
 * unknown) pass through unchanged.
 *
 * Shared by BackupSetupScreen + BackupRestoreScreen so the two entry
 * points show identical copy (part of the finding-15 de-duplication).
 */
const MAP: Record<string, string> = {
  probe_failed_retry:      "Couldn't reach the backup service. Check your connection and try again.",
  header_fetch_failed:     "Couldn't check your backup. Check your connection and try again.",
  backup_service_disabled: 'Backup is temporarily unavailable. Please try again later.',
  messenger_not_ready:     'Secure messaging is still starting up. Please try again in a moment.',
  not_logged_in:           'You need to be signed in to use backup.',
  wrong_password:          'Wrong password. Please try again.',
  verifier_missing:        'This backup needs to be re-secured. Set your backup password again.',
  nonce_expired:           'That took too long — please try again.',
  // BUG-K — NOT a wrong password: the proof verified but the single-use
  // token expired/was consumed. Telling the user "Wrong password" here
  // steered correct-password users toward the permanent-wipe action.
  verify_required:         'Verification expired — your password was accepted, just try again.',
  quota_exceeded:          'Backup storage is full. Older messages can no longer be backed up.',
  setup_failed:            'Setup failed. Please try again.',
};

export function humanizeBackupError(code: string | null | undefined): string {
  if (!code) {return '';}
  if (MAP[code]) {return MAP[code];}
  // Codes of the form "prefix: detail" (e.g. "setup_failed: <msg>",
  // "Restore failed: <kind>", "header_fetch_failed: <msg>").
  const sep = code.indexOf(':');
  const prefix = (sep >= 0 ? code.slice(0, sep) : code).trim();
  // BKRES-27 — a known code in the DETAIL wins over the prefix, so the
  // screens' wrapped form ('Restore failed: nonce_expired') resolves to
  // the dedicated entry instead of the generic restore-failed copy.
  const detail = sep >= 0 ? code.slice(sep + 1).trim() : '';
  if (detail && MAP[detail]) {return MAP[detail];}
  if (MAP[prefix]) {return MAP[prefix];}
  if (prefix === 'Restore failed') {
    return 'Restore failed. Please try again, or contact support if it keeps failing.';
  }
  // Already a full sentence (has spaces) — trust it; otherwise it's an
  // unknown short code, so show a generic fallback rather than the token.
  return code.includes(' ') ? code : 'Something went wrong. Please try again.';
}
