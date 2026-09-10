import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OpsModule} from '../ops/ops.module';
import {ProtectionService} from './protection.service';
import {ProtectionController} from './protection.controller';
import {ProtectionCpoController} from './protection-cpo.controller';
import {ProtectionOpsController} from './protection-ops.controller';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';

/**
 * Protection & Surveillance — on-demand protection sessions layered on the live
 * Pro plan→assignment substrate (spec docs/planning/PROTECTION_SESSIONS_SPEC.md).
 *
 * AuthModule supplies JwtAuthGuard; OpsModule exports OpsAuditService (ops-alert
 * feed) + the AdminGuard/CsrfGuard chain the ops surface will use. The
 * Idempotency interceptor is provided locally (DI-resolved for
 * @UseInterceptors on session create/end) — same pattern as ProApplicationsModule.
 * DELIBERATELY independent of messenger crypto and the booking dispatch paths.
 */
@Module({
  imports:     [AuthModule, OpsModule],
  controllers: [ProtectionController, ProtectionCpoController, ProtectionOpsController],
  providers:   [ProtectionService, IdempotencyInterceptor],
  exports:     [ProtectionService],
})
export class ProtectionModule {}
