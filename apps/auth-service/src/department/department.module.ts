import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OrgManagerGuard} from '../org/org-manager.guard';
import {OrgAuditService} from '../org/org-audit.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {DepartmentService} from './department.service';
import {DepartmentController} from './department.controller';
import {DeptChatAccessGuard} from './dept-chat-access.guard';
import {EnterpriseJoinService} from './enterprise-join.service';
import {EnterpriseJoinController} from './enterprise-join.controller';

/**
 * Department Channels — service-provider org workspace (org-membership gated).
 *
 * Entitlement is by org membership, not individual Pro: `DeptChatAccessGuard`
 * (company account / active org member) replaced the old TierGuard. Manager
 * routes layer `OrgManagerGuard` on top and write `OrgAuditService` rows.
 *
 * OrgManagerGuard + OrgAuditService depend only on the global DatabaseService,
 * so they're provided DIRECTLY here — importing OrgModule would cycle
 * (OrgModule already imports DepartmentModule). AuthModule supplies JwtAuthGuard.
 */
@Module({
  // A11/M11A notifications ride BookingPushBridge (below), which resolves
  // NotificationsService via its @Global module — no explicit import needed.
  imports:     [AuthModule],
  // EnterpriseJoinController is separate on purpose — its applicant-facing
  // routes must NOT sit behind DeptChatAccessGuard, which admits only existing
  // members. See that file's header.
  controllers: [DepartmentController, EnterpriseJoinController],
  // BookingPushBridge is a stateless Redis publisher (RedisModule is @Global,
  // NotificationsService is @Global) — provided directly to avoid importing
  // OpsModule, the same pattern FamilyModule documents. Powers the enterprise
  // join-loop wakes (R13-2).
  providers:   [DepartmentService, EnterpriseJoinService, DeptChatAccessGuard, OrgManagerGuard, OrgAuditService, BookingPushBridge],
  // Exported so OpsModule can surface an admin oversight view of channels.
  exports:     [DepartmentService],
})
export class DepartmentModule {}
