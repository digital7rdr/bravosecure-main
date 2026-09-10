import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {DepartmentModule} from '../department/department.module';
import {OpsModule} from '../ops/ops.module';
import {AgentModule} from '../agents/agent.module';
import {DispatchRoomIntentsModule} from '../dispatch/dispatch-room-intents.module';
import {OrgController} from './org.controller';
import {OrgInviteController} from './org-invite.controller';
import {WorkspaceController} from './workspace.controller';
import {WorkspaceService} from './workspace.service';
import {OrgCpoService} from './org-cpo.service';
import {OrgMissionService} from './org-mission.service';
import {OrgManagerGuard} from './org-manager.guard';
import {OrgAuditService} from './org-audit.service';
import {PasswordService} from '../common/services/password.service';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';

/**
 * Service-provider org module — managed-CPO roster + (Step 13) the agency mission board
 * + crew assignment.
 *
 * AuthModule supplies JwtAuthGuard (the first guard on every route). PasswordService is
 * provided locally (AuthModule does not export it). OpsModule exports SystemMessengerService
 * (Ops Room) + BookingPushBridge (CPO wake) for crew-assign. DispatchRoomIntentsModule is
 * the standalone home of the Ops-Room intent queue — imported here AND by DispatchModule,
 * so OrgModule never imports DispatchModule (which imports OrgModule → would cycle).
 * DatabaseService is global.
 */
@Module({
  // AgentModule (exports AgentService) powers the LM-C7 org confirm-complete —
  // cycle-free: AgentModule never imports OrgModule.
  imports:     [AuthModule, DepartmentModule, OpsModule, AgentModule, DispatchRoomIntentsModule],
  controllers: [OrgController, OrgInviteController, WorkspaceController],
  providers:   [OrgCpoService, OrgMissionService, OrgManagerGuard, OrgAuditService, PasswordService, IdempotencyInterceptor, WorkspaceService],
  exports:     [OrgCpoService, OrgManagerGuard, OrgAuditService],
})
export class OrgModule {}
