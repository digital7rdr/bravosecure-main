import {Module} from '@nestjs/common';
import {APP_GUARD} from '@nestjs/core';
import {ConfigModule} from '@nestjs/config';
import {ScheduleModule} from '@nestjs/schedule';
import {ThrottlerModule} from '@nestjs/throttler';
import {GlobalHttpThrottlerGuard} from './common/guards/global-http-throttler.guard';
import {AuthModule} from './auth/auth.module';
import {RedisModule} from './redis/redis.module';
import {ConnectionRegistryModule} from './gateway/connection-registry.module';
import {GatewayModule} from './gateway/gateway.module';
import {RelayModule} from './relay/relay.module';
import {MediaModule} from './media/media.module';
import {VaultModule} from './vault/vault.module';
import {PushModule} from './push/push.module';
import {TurnModule} from './turn/turn.module';
import {SfuModule} from './sfu/sfu.module';
import {BackupModule} from './backup/backup.module';
import {UsersModule} from './users/users.module';
import configuration from './config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({isGlobal: true, load: [configuration]}),
    ScheduleModule.forRoot(),
    // Audit P0-5 — global HTTP throttler for the relay surface.
    // Default ceiling is intentionally conservative (60 req / 10s per
    // tracker) so a misbehaving client can't loop on `POST /envelopes`
    // and torch FCM quota + sealed-archive rows in seconds. Per-route
    // overrides via `@Throttle({...})` on individual handlers; the
    // controller-level `UserThrottlerGuard` keys on `claims.sub` so
    // every device behind a NAT is tracked independently.
    //
    // Throws 429 `ThrottlerException` when breached; the standard
    // `Retry-After` header is set automatically.
    ThrottlerModule.forRoot([{
      name:  'default',
      ttl:   10_000,
      limit: 60,
    }]),
    RedisModule,
    UsersModule,
    ConnectionRegistryModule,
    AuthModule,
    RelayModule,
    MediaModule,
    VaultModule,
    PushModule,
    TurnModule,
    SfuModule,
    BackupModule,
    GatewayModule,
  ],
  providers: [
    // Audit P2-2/P2-16 — the ThrottlerModule above was INERT for any
    // controller that didn't explicitly bind UserThrottlerGuard: vault,
    // push, sfu, turn and users had no rate limit at all. This APP_GUARD
    // makes the module-level default real on every HTTP route. It skips
    // WS contexts (the gateway has its own limiter) and routes that
    // already bind a ThrottlerGuard subclass, so relay/media/backup keep
    // their tuned per-user buckets unchanged.
    {provide: APP_GUARD, useClass: GlobalHttpThrottlerGuard},
  ],
})
export class AppModule {}
