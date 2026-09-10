import {Module} from '@nestjs/common';
import {TotpController}  from './totp.controller';
import {TotpService}     from './totp.service';
import {AuthModule}      from '../auth/auth.module';

@Module({
  imports:     [AuthModule],
  controllers: [TotpController],
  providers:   [TotpService],
})
export class TotpModule {}
