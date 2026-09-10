import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {ComplianceService} from './compliance.service';
import {ComplianceController} from './compliance.controller';

/**
 * Compliance registry module (BUILD_RUNBOOK Step 15). ComplianceService injects only the
 * @Global DatabaseService, so it's a leaf — OpsModule imports this for the admin
 * verify/reject path with no cycle. AuthModule supplies JwtAuthGuard for the provider routes.
 */
@Module({
  imports: [AuthModule],
  controllers: [ComplianceController],
  providers: [ComplianceService],
  exports: [ComplianceService],
})
export class ComplianceModule {}
