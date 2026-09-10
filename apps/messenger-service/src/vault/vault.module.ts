import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {VaultService} from './vault.service';
import {VaultController} from './vault.controller';
import {VaultIndexController} from './vault-index.controller';
import {VaultIndexService} from './vault-index.service';
import {VaultAuditLog} from './audit.log';
import {MfaGuard} from './mfa.guard';

// B-696 Phase D — VaultIndexController is registered SEPARATELY from
// VaultController on purpose: the latter's class-level MfaGuard must not
// leak onto the E2E-encrypted index blob lane (see vault-index.controller).
@Module({
  imports:     [AuthModule],
  controllers: [VaultController, VaultIndexController],
  providers:   [VaultService, VaultIndexService, VaultAuditLog, MfaGuard],
  exports:     [VaultService, MfaGuard],
})
export class VaultModule {}
