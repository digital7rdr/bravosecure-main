import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OrgModule} from '../org/org.module';
import {DeptChatV2Guard} from '../common/guards/dept-chat-v2.guard';
import {AttendanceController} from './attendance.controller';
import {AttendanceService} from './attendance.service';
import {AttendanceRollupService} from './attendance-rollup.service';
import {RosterController} from './roster.controller';
import {RosterService} from './roster.service';

/**
 * Attendance module — provider-managed CPO shift clock-in/out.
 *
 * AuthModule supplies JwtAuthGuard; OrgModule exports OrgManagerGuard (the
 * provider-scoped routes). DatabaseService is global.
 */
@Module({
  imports:     [AuthModule, OrgModule],
  controllers: [AttendanceController, RosterController],
  providers:   [AttendanceService, AttendanceRollupService, RosterService, DeptChatV2Guard],
  // RosterService deliberately NOT exported: `ensureMonth` must stay reachable
  // from exactly one route (POST month/ensure) — the single-caller invariant
  // the roster.spec scan pins. Nothing outside this module injects it.
  exports:     [AttendanceService],
})
export class AttendanceModule {}
