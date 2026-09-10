/**
 * Audit P0-B1 — single source of truth for backup-password policy.
 *
 * History: raised 6 → 10 (P0-B1, Signal's documented floor; OWASP 2024
 * treats <10 chars as trivially crackable offline once the KDF params
 * leak). LOWERED 10 → 4 on the founder's explicit instruction
 * (2026-08-27, annotated screenshot: "shorten this password to 4
 * letters, 10 too long"). Recorded tradeoff: argon2id slows guessing,
 * but a 4-char password is within reach of an offline brute force if
 * the encrypted bundle is ever exfiltrated — this is a deliberate
 * usability-over-hardening product decision, not an oversight.
 *
 * Unlock/restore stays NON-EMPTY-only (BS-RESTORE-PWLEN), so every
 * previously created password — 10-char era included — keeps working.
 *
 * Both BackupSetupScreen and BackupRestoreScreen consume this constant
 * — never hard-code the literal in either screen.
 */
export const MIN_BACKUP_PASSWORD_CHARS = 4;
