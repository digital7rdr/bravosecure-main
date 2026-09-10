import {Module, Global} from '@nestjs/common';
import {ConnectionRegistry} from './connection-registry';
import {SocketHub} from './socket-hub';
import {PresenceService} from './presence.service';
import {PresenceCron} from './presence.cron';

/**
 * ConnectionRegistry + SocketHub + PresenceService are cross-cutting:
 * the gateway populates them, other services read them for fan-out and
 * presence state. Publishing from a @Global module avoids a
 * GatewayModule ↔ RelayModule cycle without forwardRef.
 *
 * PresenceCron is registered here so it lives alongside the service it
 * sweeps; it isn't exported because nothing else needs to call it.
 */
@Global()
@Module({
  providers: [ConnectionRegistry, SocketHub, PresenceService, PresenceCron],
  exports:   [ConnectionRegistry, SocketHub, PresenceService],
})
export class ConnectionRegistryModule {}
