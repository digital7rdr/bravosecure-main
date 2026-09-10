import {Injectable, Logger} from '@nestjs/common';

/**
 * Structured audit log for Vault file accesses. Every attempt — both
 * granted and denied — is written exactly once, with no body content.
 *
 * In Phase 1 this emits a structured Nest log line. M12 routes it to
 * Kafka via the auth-service audit topic so the security team can
 * correlate across services.
 *
 * NEVER include the plaintext content, decryption key, or derived
 * URL inside the log — only the caller identity, the object hash,
 * and the outcome. The log audit test in M11 enforces this.
 */

export interface VaultAuditEntry {
  /** Unix ms */
  at:        number;
  userId:    string;
  /** JWT `device_id` (auth-service session id — not the Signal device id). */
  authDeviceId: string;
  /** SHA-256 hash of the object key — NOT the key itself. */
  fileHash:  string;
  ip:        string;
  outcome:   'granted' | 'denied';
  reason?:   string;
}

@Injectable()
export class VaultAuditLog {
  private readonly logger = new Logger('VaultAudit');

  record(entry: VaultAuditEntry): void {
    // Structured log line — defer Kafka/ES shipping to M12 infra.
    this.logger.log(
      `vault.${entry.outcome} sub=${entry.userId} dev=${entry.authDeviceId} ` +
      `file=${entry.fileHash} ip=${entry.ip}` +
      (entry.reason ? ` reason=${entry.reason}` : ''),
    );
  }
}
