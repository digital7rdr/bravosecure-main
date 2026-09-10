import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OpsModule} from './ops.module';
import {AttendanceModule} from '../attendance/attendance.module';
import {IncidentModule} from '../incident/incident.module';
import {DeptChatV2Guard} from '../common/guards/dept-chat-v2.guard';
import {OpsDeptChatController} from './ops-deptchat.controller';

/**
 * Bravo-admin oversight for Dept Chat v2 (ops-console). OpsModule supplies
 * AdminGuard + CsrfGuard + OpsAuditService; AttendanceModule / IncidentModule
 * supply the (reused) read/export services. AuthModule supplies JwtService so
 * JwtAuthGuard (used on the controller) resolves in THIS module's context —
 * OpsModule imports AuthModule but does not re-export JwtService. Separate
 * module so OpsModule's own import graph isn't grown. No cycle: nothing imports
 * this module.
 */
@Module({
  imports:     [AuthModule, OpsModule, AttendanceModule, IncidentModule],
  controllers: [OpsDeptChatController],
  providers:   [DeptChatV2Guard],
})
export class OpsDeptChatModule {}
