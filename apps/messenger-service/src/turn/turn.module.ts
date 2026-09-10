import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {TurnService} from './turn.service';
import {TurnController} from './turn.controller';

@Module({
  imports:     [AuthModule],
  providers:   [TurnService],
  controllers: [TurnController],
  exports:     [TurnService],
})
export class TurnModule {}
