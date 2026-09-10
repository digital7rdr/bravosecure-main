import {Module} from '@nestjs/common';
import {AuthController}  from './auth.controller';
import {AuthService}     from './auth.service';
import {JwtService}      from './jwt.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService}      from '../common/services/otp.service';
import {JwtAuthGuard}    from '../common/guards/jwt-auth.guard';
import {TotpCryptoService}     from '../common/services/totp-crypto.service';
import {TotpChallengeService}  from '../common/services/totp-challenge.service';

@Module({
  controllers: [AuthController],
  providers:   [AuthService, JwtService, PasswordService, OtpService, JwtAuthGuard, TotpCryptoService, TotpChallengeService],
  exports:     [AuthService, JwtService, JwtAuthGuard, TotpCryptoService, TotpChallengeService, OtpService],
})
export class AuthModule {}
