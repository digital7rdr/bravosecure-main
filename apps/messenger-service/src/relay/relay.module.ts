import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {BackupModule} from '../backup/backup.module';
import {PushModule} from '../push/push.module';
import {EnvelopeStore} from './envelope.store';
import {EnvelopeService} from './envelope.service';
import {EnvelopeController} from './envelope.controller';
import {RelayCron} from './relay.cron';
import {RecipientPurgeGuard} from './recipient-purge.guard';

@Module({
  // Audit PUSH-B1 — PushModule so the HTTP send path can fire a chat-wake
  // (group fan-out + outbox re-sends all use HTTP). PushModule imports only
  // AuthModule, so this introduces no circular dependency.
  imports:     [AuthModule, BackupModule, PushModule],
  controllers: [EnvelopeController],
  // Audit P1-T2 — RecipientPurgeGuard depends on JwtService from AuthModule.
  providers:   [EnvelopeStore, EnvelopeService, RelayCron, RecipientPurgeGuard],
  exports:     [EnvelopeService],
})
export class RelayModule {}
