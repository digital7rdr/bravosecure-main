import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {WalletModule} from '../wallet/wallet.module';
import {OpsModule} from '../ops/ops.module';
import {ProApplicationsService} from './pro-applications.service';
import {ProApplicationsController} from './pro-applications.controller';
import {ProApplicationsOpsController} from './pro-applications-ops.controller';
import {ProApplicationStateMachine} from './state-machine.service';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';

/**
 * Bravo Secure Pro applications — request-and-approval custom plans.
 *
 * AuthModule supplies JwtAuthGuard; WalletModule the Bravo-Credit debit for
 * activation; OpsModule exports AdminGuard/CsrfGuard for the /ops surface plus
 * MissionEventsService (realtime frames over the messenger gateway's
 * `mission:events` Redis lane) and BookingPushBridge (opaque FCM wakes).
 * DELIBERATELY independent of the M1A subscription module — a Pro application
 * never writes users.subscription_tier.
 */
@Module({
  imports:     [AuthModule, WalletModule, OpsModule],
  controllers: [ProApplicationsController, ProApplicationsOpsController],
  providers:   [
    ProApplicationsService,
    ProApplicationStateMachine,
    // DI-resolved interceptor for @UseInterceptors() on activate.
    IdempotencyInterceptor,
  ],
})
export class ProApplicationsModule {}
