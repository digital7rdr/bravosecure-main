import {Module} from '@nestjs/common';
import {AuthModule}      from '../auth/auth.module';
import {OpsModule}       from '../ops/ops.module';
import {SosController}   from './sos.controller';
import {SosService}      from './sos.service';

@Module({
  imports:     [AuthModule, OpsModule],
  controllers: [SosController],
  providers:   [SosService],
  exports:     [SosService],
})
export class SosModule {}
