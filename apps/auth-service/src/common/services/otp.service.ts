import {HttpException, HttpStatus, Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {randomInt, createHash} from 'node:crypto';
import {RedisService} from '../../redis/redis.service';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redis:  RedisService,
  ) {}

  generate(): string {
    const len = this.config.get<number>('otp.length') ?? 6;
    const max = 10 ** len;
    return String(randomInt(0, max)).padStart(len, '0');
  }

  hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  async send(to: string, code: string): Promise<void> {
    const ttl = this.config.get<number>('otp.ttlMinutes') ?? 10;

    if (this.config.get<boolean>('otp.devBypass')) {
      // DEV ONLY — OTP send is a no-op. Any code will pass check(). See configuration.ts.
      return;
    }

    if (this.config.get<boolean>('otp.devReturnCode')) {
      // Dev mode: OTP is returned in the API response body — no logging, no SMS.
      return;
    }

    // Audit Rev2 API-01 — per-destination send cap. Sits in send() (not
    // register) deliberately: send() has TWO callers (register AND login), so a
    // counter in register alone would leave login-triggered sends unmetered.
    // This is the number-rotation defence the IP throttler can't provide — it
    // bounds a flood aimed at ONE number/email regardless of source IP. Keyed
    // on the normalized destination (phone_e164 / lowercased email).
    const maxPerHour = this.config.get<number>('otp.maxSendsPerHour') ?? 5;
    const destination = to.trim().toLowerCase();
    // Fail OPEN on a Redis blip: a per-destination CAP must never take down
    // register/login (both call this). Twilio's own per-number abuse guard and
    // the IP throttler still apply, so a limiter outage degrades to "allow",
    // not a 500. Only a live counter over the ceiling blocks.
    let sends = 0;
    try {
      sends = await this.redis.incrOtpSends(destination);
    } catch (e) {
      this.logger.warn(`otp send-cap check skipped (redis unavailable): ${(e as Error).message}`);
    }
    if (sends > maxPerHour) {
      throw new HttpException('otp_send_rate_limited', HttpStatus.TOO_MANY_REQUESTS);
    }

    const sid      = this.config.get<string>('twilio.accountSid');
    const tok      = this.config.get<string>('twilio.authToken');
    const verifySid = this.config.get<string>('twilio.verifySid');

    if (sid && tok && verifySid) {
      // Twilio Verify API — preferred: delivers and manages OTP lifecycle via Twilio.
      const {Twilio} = await import('twilio');
      const client = new Twilio(sid, tok);
      await client.verify.v2.services(verifySid).verifications.create({
        to,
        channel: 'sms',
      });
      return;
    }

    // Fallback: Programmable SMS when Verify service SID not provisioned.
    const from = this.config.get<string>('twilio.fromNumber');
    if (!sid || !tok || !from) {
      throw new Error('Twilio credentials not configured (need TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM or TWILIO_VERIFY_SID)');
    }
    const {Twilio} = await import('twilio');
    const client = new Twilio(sid, tok);
    await client.messages.create({
      to,
      from,
      body: `Your Bravo Secure code: ${code}. Valid for ${ttl} minutes.`,
    });
  }

  /**
   * Check a user-submitted OTP against Twilio Verify.
   * Returns true if Twilio marks the verification "approved".
   * Only used when TWILIO_VERIFY_SID is configured (the spec-mandated path).
   */
  async check(to: string, code: string): Promise<boolean> {
    if (this.config.get<boolean>('otp.devBypass')) {
      // DEV ONLY — any non-empty 4-8 digit code passes.
      return /^\d{4,8}$/.test(code);
    }

    const sid       = this.config.get<string>('twilio.accountSid');
    const tok       = this.config.get<string>('twilio.authToken');
    const verifySid = this.config.get<string>('twilio.verifySid');
    if (!sid || !tok || !verifySid) {
      throw new Error('Twilio Verify not configured (TWILIO_VERIFY_SID required for OTP check)');
    }
    const {Twilio} = await import('twilio');
    const client = new Twilio(sid, tok);
    try {
      const res = await client.verify.v2
        .services(verifySid)
        .verificationChecks.create({to, code});
      return res.status === 'approved';
    } catch (e: unknown) {
      // Twilio returns 404 when the verification has expired or already been consumed —
      // treat as a failed check (not a server error).
      const err = e as {status?: number};
      if (err?.status === 404) return false;
      throw e;
    }
  }
}
