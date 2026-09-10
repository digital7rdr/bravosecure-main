import {Module} from '@nestjs/common';
import {BookingModule} from '../booking/booking.module';
import {OpsModule} from '../ops/ops.module';
import {AuthModule} from '../auth/auth.module';
import {OrgModule} from '../org/org.module';
import {WalletModule} from '../wallet/wallet.module';
import {SosModule} from '../sos/sos.module';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {DispatchService} from './dispatch.service';
import {DispatchController} from './dispatch.controller';
import {DispatchJobsController} from './dispatch-jobs.controller';
import {DispatchAdminController} from './dispatch-admin.controller';
import {ClientArrivalController} from './client-arrival.controller';
import {ClientDispatchController} from './client-dispatch.controller';
import {DispatchRoomIntentsModule} from './dispatch-room-intents.module';
import {DispatchRoomIntentsController} from './dispatch-room-intents.controller';
import {OfferExpiryService} from './offer-expiry.service';
import {RelistTimeoutService} from './relist-timeout.service';
import {CrewSlaService} from './crew-sla.service';
import {ArrivalNoShowService} from './arrival-noshow.service';
import {DispatchPrivacyPurgeService} from './dispatch-privacy-purge.service';
import {ScheduledDispatchService} from './scheduled-dispatch.service';
import {OpsApprovedDispatchService} from './ops-approved-dispatch.service';
import {DispatchSloService} from './dispatch-slo.service';
import {BookingReminderService} from './booking-reminder.service';

/**
 * Auto-dispatch matchmaker + agency offer endpoints + watchdogs + escrow (Steps 6–9).
 *
 * DatabaseService, RedisService, and ConfigService are @Global. BookingModule
 * exports BookingStateMachine; OpsModule exports OpsAuditService + BookingPushBridge;
 * AuthModule supplies JwtAuthGuard; OrgModule exports OrgManagerGuard (the IDOR
 * scope guard). IdempotencyInterceptor is provided so Nest can inject RedisService
 * into it for the @UseInterceptors on accept. OfferExpiryService + CrewSlaService
 * are the Step 8 Redis-locked sweeps (self-driving setInterval, gated dark by
 * AUTO_DISPATCH_ENABLED). WalletModule (Step 9) exports WalletService for the escrow
 * hold on accept + the no-show refund in the crew-SLA sweep.
 */
@Module({
  imports: [BookingModule, OpsModule, AuthModule, OrgModule, WalletModule, DispatchRoomIntentsModule, SosModule],
  controllers: [DispatchController, DispatchJobsController, DispatchAdminController, DispatchRoomIntentsController, ClientArrivalController, ClientDispatchController],
  providers: [DispatchService, IdempotencyInterceptor, OfferExpiryService, RelistTimeoutService, CrewSlaService, ArrivalNoShowService, DispatchPrivacyPurgeService, ScheduledDispatchService, OpsApprovedDispatchService, DispatchSloService, BookingReminderService],
  exports: [DispatchService],

})
export class DispatchModule {}
