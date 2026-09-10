import {Module, Global} from '@nestjs/common';
import {RedisService} from './redis.service';
import {ReplicaGuardService} from './replica-guard.service';

@Global()
@Module({
  // AUDIT #3/#10 — ReplicaGuardService enforces the single-replica
  // constraint the call/SFU planes depend on (see its header).
  providers: [RedisService, ReplicaGuardService],
  exports:   [RedisService],
})
export class RedisModule {}
