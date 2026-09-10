import {Module, Global} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {NotificationsService} from './notifications.service';
import {NotificationsController} from './notifications.controller';

/**
 * N-20 — durable notification inbox. @Global so BookingPushBridge (declared in
 * several feature modules) can inject NotificationsService without each module
 * re-wiring it. DatabaseService is itself @Global. AuthModule supplies the
 * JwtService the controller's JwtAuthGuard needs.
 */
@Global()
@Module({
  imports:     [AuthModule],
  providers:   [NotificationsService],
  controllers: [NotificationsController],
  exports:     [NotificationsService],
})
export class NotificationsModule {}
