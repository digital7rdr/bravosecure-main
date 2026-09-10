import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {randomBytes, createCipheriv, createDecipheriv, createHash} from 'node:crypto';
import * as OTPAuth from 'otpauth';

const BACKUP_COUNT  = 10;
const BACKUP_LEN    = 8;
const BACKUP_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

@Injectable()
export class TotpCryptoService {
  constructor(private readonly config: ConfigService) {}

  private encKey(): Buffer {
    const hex = this.config.get<string>('totp.encryptionKey') ?? '';
    if (hex.length !== 64) throw new Error('TOTP_ENCRYPTION_KEY must be 64 hex chars');
    // P1-P-1 — reject the dev sentinel (64×'a') in production. Even if the
    // env var is explicitly set to the well-known placeholder, sealing every
    // TOTP secret under 32 bytes of 0xAA is worthless; fail closed so a
    // misconfigured deploy surfaces instead of silently running insecure.
    if (process.env['NODE_ENV'] === 'production' && /^a{64}$/i.test(hex)) {
      throw new Error('TOTP_ENCRYPTION_KEY is the insecure default — set a real 64-hex-char key in production');
    }
    return Buffer.from(hex, 'hex');
  }

  encryptSecret(secret: string): Buffer {
    const iv     = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey(), iv);
    const enc    = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag    = cipher.getAuthTag();
    return Buffer.concat([iv, enc, tag]);
  }

  decryptSecret(blob: Buffer): string {
    const iv      = blob.subarray(0, 12);
    const tag     = blob.subarray(blob.length - 16);
    const enc     = blob.subarray(12, blob.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey(), iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final('utf8');
  }

  generateSecret(account: string): {secret: string; uri: string} {
    const issuer = this.config.get<string>('totp.issuer') ?? 'Bravo Secure';
    const totp   = new OTPAuth.TOTP({
      issuer,
      label:     account,
      algorithm: 'SHA1',
      digits:    6,
      period:    30,
      secret:    new OTPAuth.Secret({size: 20}),
    });
    return {secret: totp.secret.base32, uri: totp.toString()};
  }

  /**
   * Audit Rev2 SEC-02 — returns the DELTA (which 30-second step matched),
   * or null when the code is invalid. It used to return a bare boolean, which
   * threw away the one piece of information needed to make a code single-use:
   * with `window: 1` the codes for t-1, t and t+1 all validate, so a caller
   * that assumed "the server's current step" would (a) leave the other two
   * steps replayable and (b) permanently lock out anyone whose authenticator
   * runs a step slow. Callers must keep testing `!== null` — delta 0 is a
   * VALID result and is falsy.
   */
  verifyCode(secret: string, code: string): number | null {
    const totp = new OTPAuth.TOTP({
      algorithm: 'SHA1', digits: 6, period: 30,
      secret:    OTPAuth.Secret.fromBase32(secret),
    });
    return totp.validate({token: code, window: 1});
  }

  generateBackupCodes(): {plain: string[]; hashes: string[]} {
    const plain: string[] = [];
    for (let i = 0; i < BACKUP_COUNT; i++) {
      const b = randomBytes(BACKUP_LEN);
      let c   = '';
      for (let j = 0; j < BACKUP_LEN; j++) c += BACKUP_CHARS[b[j] % BACKUP_CHARS.length];
      plain.push(c);
    }
    return {plain, hashes: plain.map(c => this.hashBackupCode(c))};
  }

  hashBackupCode(code: string): string {
    return createHash('sha256').update(code.toUpperCase().trim()).digest('hex');
  }
}
