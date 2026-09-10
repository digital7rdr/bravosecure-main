import {Module} from '@nestjs/common';
import {AuthModule}        from '../auth/auth.module';
import {WalletModule}      from '../wallet/wallet.module';
import {FamilyModule}      from '../family/family.module';
import {SettlementModule}  from '../settlement/settlement.module';
import {BookingService}    from './booking.service';
import {BookingController} from './booking.controller';
import {PricingService}    from './pricing.service';
import {BookingStateMachine} from './state-machine.service';
import {CpoAssignmentService} from './assignment/cpo-assignment.service';
import {VehiclePoolService}   from './assignment/vehicle-pool.service';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {PaymentPendingExpiryService} from './payment-pending-expiry.service';
import {EscrowReleaseSweepService} from './escrow-release-sweep.service';
import {EscrowReconciliationService} from './escrow-reconciliation.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {InvoiceService} from './invoice.service';

/**
 * Lite Booking module — REST endpoints backing the 5-step Lite wizard.
 *
 * Future evolution (from Master Build Prompt 2.3):
 * - Move into its own `apps/booking-service/` NestJS microservice
 * - WebSocket gateway (`/booking` namespace) for live status pushes
 * - Kafka audit topics (booking.submitted / approved / confirmed / ...)
 * - Redis-backed payment-enabled TTL
 */
@Module({
  imports:     [AuthModule, WalletModule, FamilyModule, SettlementModule],
  controllers: [BookingController],
  providers:   [
    BookingService,
    PricingService,
    BookingStateMachine,
    CpoAssignmentService,
    VehiclePoolService,
    // DI-resolved interceptor for @UseInterceptors() on pay-with-credits.
    IdempotencyInterceptor,
    // Sweep stale PAYMENT_PENDING bookings so a stalled top-up doesn't
    // permanently block the user's "one mission at a time" slot.
    PaymentPendingExpiryService,
    // Step 11 — Redis-locked escrow release sweep (pays the agency after the
    // dispute window). Ships dark on AUTO_DISPATCH_ENABLED.
    EscrowReleaseSweepService,
    // Step 11 — daily read-only reconciliation sweep (asserts the money invariant).
    EscrowReconciliationService,
    // LM-B2 — stateless Redis publisher (RedisModule is @Global), provided directly
    // like AgentModule does with MissionEventsService to avoid an OpsModule cycle.
    BookingPushBridge,
    // F1 — numbered receipt / credit-note issuance.
    InvoiceService,
  ],
  exports:     [BookingService, BookingStateMachine, CpoAssignmentService, VehiclePoolService, PricingService],
})
export class BookingModule {}
