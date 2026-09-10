import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {PushService} from './push.service';
import {PushController} from './push.controller';
import {AppCheckGuard} from '../common/guards/app-check.guard';

@Module({
  imports:     [AuthModule],
  providers:   [PushService, AppCheckGuard],
  controllers: [PushController],
  exports:     [PushService],
})
export class PushModule {}
