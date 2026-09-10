import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';

/**
 * Thin Twilio SMS sender for arbitrary message bodies — used by the VBG
 * escalation paths (panic, biometric-miss, geofence breach) to text the
 * principal / emergency contacts.
 *
 * Mirrors the Programmable-SMS branch of OtpService (which only sends
 * OTP codes). Honours the same dev bypass so local/dev builds never
 * actually hit Twilio. Best-effort: never throws into the caller — a
 * Twilio outage must not block the escalation's other channels (WS, Kafka).
 */
@Injectable()
export class SmsService {
  private readonly log = new Logger(SmsService.name);

  constructor(private readonly config: ConfigService) {}

  async sendSms(to: string, body: string): Promise<{sent: boolean}> {
    if (this.config.get<boolean>('otp.devBypass') || this.config.get<boolean>('otp.devReturnCode')) {
      this.log.log(`SMS (dev bypass) → ${maskPhone(to)}`);
      return {sent: false};
    }
    const sid  = this.config.get<string>('twilio.accountSid');
    const tok  = this.config.get<string>('twilio.authToken');
    const from = this.config.get<string>('twilio.fromNumber');
    if (!sid || !tok || !from) {
      this.log.warn('SMS not sent — Twilio FROM/credentials missing');
      return {sent: false};
    }
    try {
      const {Twilio} = await import('twilio');
      const client = new Twilio(sid, tok);
      await client.messages.create({to, from, body: body.slice(0, 480)});
      this.log.log(`SMS sent → ${maskPhone(to)}`);
      return {sent: true};
    } catch (e) {
      this.log.error(`SMS send failed → ${maskPhone(to)}: ${(e as Error).message}`);
      return {sent: false};
    }
  }
}

// Never log a full phone number.
function maskPhone(p: string): string {
  return p.length > 4 ? `${p.slice(0, 3)}***${p.slice(-2)}` : '***';
}
