import {Injectable, OnModuleDestroy, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {Kafka, type Producer, CompressionTypes} from 'kafkajs';

export type AuditEventType =
  | 'auth.register'    | 'auth.login'         | 'auth.verify'
  | 'auth.refresh'     | 'auth.session.revoked'| 'auth.keys.upload'
  // Audit Rev2 CLI-01 — a Signal identity-key rotation on /auth/keys/upload
  // (the stolen-token takeover amplifier). Distinct so it can be alerted on.
  | 'auth.keys.identity_rotated'
  | 'auth.keys.fetch'  | 'auth.keys.fetch_devices' | 'auth.totp.setup' | 'auth.totp.verify'
  | 'auth.biometric.assert' | 'auth.admin_register'
  // B-696 — vault PIN verifier lifecycle (set/replace, verify, OTP reset).
  | 'auth.vault_pin.set' | 'auth.vault_pin.verify' | 'auth.vault_pin.reset'
  // Audit P0-A5 — credential rotation.
  | 'auth.password.changed' | 'auth.password.change_denied'
  // Audit fix 0.7 — client-raised SOS events.
  | 'client.sos.raise' | 'client.sos.cancel';

export interface AuditEvent {
  event_type: AuditEventType;
  user_id:    string | null;
  device_id:  string | null;
  ip:         string | null;
  outcome:    'success' | 'failure';
  detail?:    string;
  timestamp:  string;
}

// BE-7.3/7.4 — escalation event shape (geofence breach, biometric miss,
// panic). Lands on the escalation-events topic for dispatch/pager surfaces.
export interface EscalationEvent {
  type:     'geofence_breach' | 'biometric_missed' | 'panic';
  user_id:  string;
  detail?:  string;
  lat?:     number;
  lng?:     number;
  zone_id?: string;
}

@Injectable()
export class AuditService implements OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private producer: Producer | null = null;
  private topic!: string;
  private escalationTopic!: string;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const brokers = this.config.get<string[]>('kafka.brokers') ?? [];
    this.topic    = this.config.get<string>('kafka.auditTopic') ?? 'audit-events';
    this.escalationTopic = this.config.get<string>('kafka.escalationTopic') ?? 'escalation-events';
    if (!brokers.length) {
      this.logger.warn('KAFKA_BROKERS not set — audit events go to stdout only');
      return;
    }
    const kafka   = new Kafka({clientId: 'auth-service', brokers});
    this.producer = kafka.producer();
    await this.producer.connect();
    this.logger.log('Kafka audit producer connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer?.disconnect();
  }

  async emit(event: Omit<AuditEvent, 'timestamp'>): Promise<void> {
    const payload: AuditEvent = {...event, timestamp: new Date().toISOString()};
    this.logger.log(JSON.stringify(payload));
    if (!this.producer) return;
    try {
      await this.producer.send({
        topic:       this.topic,
        messages:    [{key: payload.user_id ?? 'anon', value: JSON.stringify(payload)}],
        compression: CompressionTypes.None,
      });
    } catch (err) {
      this.logger.error('Kafka send failed', (err as Error).message);
    }
  }

  /** BE-7 — emit a VBG escalation onto the escalation-events topic. */
  async emitEscalation(event: EscalationEvent): Promise<void> {
    const payload = {...event, timestamp: new Date().toISOString()};
    this.logger.log(`escalation ${event.type} user=${event.user_id.slice(0, 8)}`);
    if (!this.producer) return;
    try {
      await this.producer.send({
        topic:       this.escalationTopic,
        messages:    [{key: event.user_id, value: JSON.stringify(payload)}],
        compression: CompressionTypes.None,
      });
    } catch (err) {
      this.logger.error('Kafka escalation send failed', (err as Error).message);
    }
  }
}
