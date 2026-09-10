import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {EventsController} from './events.controller';

/**
 * A2 — the push-wake hydration route. RedisService is provided globally
 * (@Global RedisModule); AuthModule supplies JwtService for the JwtAuthGuard.
 */
@Module({
  imports:     [AuthModule],
  controllers: [EventsController],
})
export class EventsModule {}
