import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {SfuService} from './sfu.service';
import {SfuController} from './sfu.controller';
import {SfuWorkerPool} from './sfuWorkerPool';
import {RoomTokenService} from './room-token.service';

/**
 * SFU module (M9 group calls).
 *
 * SfuWorkerPool boots one mediasoup Worker per CPU core during module
 * init. SfuService creates Routers on those workers + tracks rooms /
 * participants / producers / consumers. The gateway wires the
 * `sfu.*` WebSocket frames against SfuService and binds fanout via
 * `bindFanout()` so SfuService doesn't have to import the gateway.
 *
 * Audit P0-C2 — RoomTokenService is exported so the gateway can
 * verify a per-recipient HMAC room-access token before admitting a
 * caller to `sfu.join`. Without this, knowing the roomId was enough.
 */
@Module({
  imports:     [AuthModule],
  providers:   [SfuWorkerPool, SfuService, RoomTokenService],
  controllers: [SfuController],
  exports:     [SfuService, SfuWorkerPool, RoomTokenService],
})
export class SfuModule {}
