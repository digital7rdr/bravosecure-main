import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OpsModule} from '../ops/ops.module';
import {OrgModule} from '../org/org.module';
import {PasswordService} from '../common/services/password.service';
import {ProManagementService} from './pro-management.service';
import {ProFleetService} from './pro-fleet.service';
import {ProManagementOpsController} from './pro-management-ops.controller';
import {ProFleetOpsController} from './pro-fleet-ops.controller';
import {CpoMissionCodeController} from './cpo-mission-code.controller';

/**
 * Ops Pro management — internal orgs, ops-created CPOs, overlap-safe
 * CPO↔Pro-member assignments, mission-code gate. Inherits the org machinery
 * (OrgModule exports OrgCpoService — the one "make a deployable officer"
 * primitive) and the /ops guard chain + realtime/push bridges from OpsModule.
 * PasswordService is provided locally (AuthModule doesn't export it — same
 * pattern as OrgModule).
 */
@Module({
  imports:     [AuthModule, OpsModule, OrgModule],
  controllers: [ProManagementOpsController, ProFleetOpsController, CpoMissionCodeController],
  providers:   [ProManagementService, ProFleetService, PasswordService],
})
export class ProManagementModule {}
