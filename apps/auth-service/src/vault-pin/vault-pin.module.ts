import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {VaultPinController} from './vault-pin.controller';
import {VaultPinService} from './vault-pin.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService} from '../common/services/otp.service';

// B-696 — vault PIN verifier (VAULT_DURABILITY_DESIGN_2026-08-29 §4-§5).
// PasswordService/OtpService are re-provided locally: AuthModule provides
// but does not export them (house pattern — see pro-management.module.ts).
@Module({
  imports:     [AuthModule],
  controllers: [VaultPinController],
  providers:   [VaultPinService, PasswordService, OtpService],
})
export class VaultPinModule {}
