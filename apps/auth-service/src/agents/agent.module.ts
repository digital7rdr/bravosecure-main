import {Module} from '@nestjs/common';
import {AuthModule}          from '../auth/auth.module';
import {BookingModule}       from '../booking/booking.module';
import {WalletModule}        from '../wallet/wallet.module';
import {DepartmentModule}    from '../department/department.module';
import {AgentController}     from './agent.controller';
import {AgentService}        from './agent.service';
import {AgentStateMachine}   from './state-machine.service';
import {MissionLeadService}  from './mission-lead.service';
import {ProofOfCompletionService} from './proof-of-completion.service';
import {MissionEventsService} from '../ops/mission-events.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {CpoSessionGuard} from '../common/guards/cpo-session.guard';
import {TelemetryModule} from '../telemetry/telemetry.module';

/**
 * Agent Portal module — 9-screen onboarding + partner lifecycle.
 *
 * Future evolution:
 * - Move to its own `apps/agent-service/` NestJS microservice
 * - WebSocket gateway for live KYC/review status pushes
 * - Kafka audit topics: agent.submitted / approved / rejected / activated
 */
@Module({
  // BookingModule (CpoAssignmentService) + WalletModule (WalletService)
  // power the audit-C1 agent-complete payout. Both are cycle-free: neither
  // imports AgentModule, so this does not create a DI cycle even though
  // OpsModule imports all three.
  // TelemetryModule — B-89 MG-01: MissionLeadService mirrors each CPO fix
  // into the client-facing telemetry stores (Redis + mission_telemetry_last).
  // TelemetryModule imports only AuthModule, so no DI cycle.
  imports:     [AuthModule, BookingModule, WalletModule, DepartmentModule, TelemetryModule],
  controllers: [AgentController],
  // MissionEventsService + BookingPushBridge are stateless Redis publishers
  // (RedisModule is @Global), so providing second instances here is harmless and
  // avoids importing OpsModule (which imports AgentModule → would cycle). Lets
  // MissionLeadService/AgentService emit realtime mission.status frames + the
  // LM-N4 completion wake on the auto-dispatch lead path (CLIENT-TRACKING #13).
  providers:   [AgentService, AgentStateMachine, MissionLeadService, ProofOfCompletionService, MissionEventsService, BookingPushBridge, IdempotencyInterceptor, CpoSessionGuard],
  exports:     [AgentService, AgentStateMachine, MissionLeadService],
})
export class AgentModule {}
