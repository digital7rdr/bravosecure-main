import {Module}            from '@nestjs/common';
import {BiometricController} from './biometric.controller';
import {BiometricService}    from './biometric.service';
import {AuthModule}          from '../auth/auth.module';

@Module({
  imports:     [AuthModule],
  controllers: [BiometricController],
  providers:   [BiometricService],
})
export class BiometricModule {}
