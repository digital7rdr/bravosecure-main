import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OrgModule} from '../org/org.module';
import {OpsModule} from '../ops/ops.module';
import {DeptChatV2Guard} from '../common/guards/dept-chat-v2.guard';
import {IncidentController} from './incident.controller';
import {IncidentService} from './incident.service';

/**
 * Incident reporting module (Dept Chat v2). AuthModule supplies JwtAuthGuard;
 * OrgModule supplies OrgManagerGuard (manager queue) + OrgAuditService; OpsModule
 * supplies BookingPushBridge (metadata-only incident push, Step 11);
 * DeptChatV2Guard reads the global ConfigService. DatabaseService is global.
 */
@Module({
  imports:     [AuthModule, OrgModule, OpsModule],
  controllers: [IncidentController],
  providers:   [IncidentService, DeptChatV2Guard],
  exports:     [IncidentService],
})
export class IncidentModule {}
