import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {RedisModule} from '../redis/redis.module';
import {SenderCertController} from './sender-cert.controller';
import {SenderCertService} from './sender-cert.service';

@Module({
  imports:     [AuthModule, RedisModule],
  controllers: [SenderCertController],
  providers:   [SenderCertService],
  exports:     [SenderCertService],
})
export class SenderCertModule {}
