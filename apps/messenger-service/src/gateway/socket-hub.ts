import {Injectable} from '@nestjs/common';
import type {Server} from 'socket.io';
import type {SessionAddress} from './protocol';

/**
 * Thin singleton that holds the live socket.io Server reference. The
 * gateway sets it in `afterInit`; anything else that needs to broadcast
 * (EnvelopeService, future group / channel services) reads it from here
 * rather than injecting the gateway directly — keeps module wiring acyclic.
 *
 * Room keys:
 *   `u:{userId}:{deviceId}` — targets one specific signal device
 *   `u:{userId}`            — targets every device a user is connected on
 *
 * All emits go through `server.to(room).emit(...)` so the Redis adapter
 * fans them out across every replica.
 */
@Injectable()
export class SocketHub {
  server: Server | null = null;

  deviceRoom(addr: SessionAddress): string {
    return `u:${addr.userId}:${addr.deviceId}`;
  }

  userRoom(userId: string): string {
    return `u:${userId}`;
  }

  emitToDevice(addr: SessionAddress, event: string, data: unknown): void {
    this.server?.to(this.deviceRoom(addr)).emit(event, data);
  }

  emitToUser(userId: string, event: string, data: unknown): void {
    this.server?.to(this.userRoom(userId)).emit(event, data);
  }

  /**
   * Cross-node membership probe — returns true if at least one socket is
   * in the device room on any replica. Used to distinguish "peer offline"
   * from "peer on another node". Async because the Redis adapter has to
   * ask its peers.
   */
  async deviceIsOnline(addr: SessionAddress): Promise<boolean> {
    if (!this.server) return false;
    const sockets = await this.server.in(this.deviceRoom(addr)).fetchSockets();
    return sockets.length > 0;
  }
}
