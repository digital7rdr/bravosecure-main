import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {RelayModule} from '../relay/relay.module';
import {PushModule} from '../push/push.module';
import {SfuModule} from '../sfu/sfu.module';
import {MessengerGateway} from './messenger.gateway';
import {CallsController} from './calls.controller';

@Module({
  imports:     [AuthModule, RelayModule, PushModule, SfuModule],
  // P1-BR-3 — CallsController lives here (not a new module) because the
  // decline fan-out needs the gateway's call-session + pending-ring state.
  controllers: [CallsController],
  providers:   [MessengerGateway],
})
export class GatewayModule {}
