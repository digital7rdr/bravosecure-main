import {Injectable, Logger} from '@nestjs/common';
import type {Socket} from 'socket.io';

/**
 * In-memory registry of authenticated socket.io connections on THIS
 * replica. Keyed by `${userId}:${deviceId}` — a single user may connect
 * from multiple devices (phone + tablet), and envelopes fan out to ALL
 * of a recipient's devices (Signal's "all-devices" semantic).
 *
 * Cross-replica fanout is handled by `SocketHub` + the socket.io Redis
 * adapter (`server.to(room).emit(...)`). This registry stays local-only
 * and is used for:
 *   - supersession of stale sessions on the same (user, device, node)
 *   - per-node bookkeeping (size, lastSeenMs telemetry)
 */

export interface Connection {
  userId:   string;
  /**
   * Signal device id (numeric). This is NOT the same as the JWT's
   * `device_id` claim — JWT device_id is auth-service's session tracking
   * uuid. The SIGNAL device id is what recipient addresses target on
   * the wire, keyed here for O(1) fan-out lookup.
   */
  deviceId: number;
  socket:   Socket;
  /** Monotonic id for disambiguating reconnects on the same (user,device). */
  sessionId: string;
  /** JWT device_id claim — carried through for audit log correlation only. */
  authDeviceId: string;
  /** Last time the client sent any frame (ping, message, etc). Used by heartbeat. */
  lastSeenMs: number;
}

@Injectable()
export class ConnectionRegistry {
  private readonly logger = new Logger(ConnectionRegistry.name);
  private readonly byDevice = new Map<string, Connection>();
  private readonly byUser   = new Map<string, Set<number>>();

  /**
   * Returns `true` when this connection SUPERSEDED an existing live
   * session on the same (user, device) slot — the caller MUST then skip
   * `presence.onConnect` so the per-user device counter isn't
   * double-incremented. The evicted socket's `onDisconnect` is skipped
   * (see `remove`), so a second INCR here would leak the counter and
   * pin the user `online` forever (B-11 secondary symptom).
   */
  add(conn: Connection): boolean {
    const k = key(conn.userId, conn.deviceId);
    const existing = this.byDevice.get(k);
    let superseded = false;
    if (existing && existing.sessionId !== conn.sessionId) {
      // Same (user,device) reconnected — disconnect the stale socket so
      // the client gets a clear signal that its previous session was
      // evicted. We emit an `error` frame first so the client knows why.
      superseded = true;
      try {
        existing.socket.emit('error', {code: 'superseded', message: 'newer session took over'});
      } catch { /* ignore */ }
      try { existing.socket.disconnect(true); } catch { /* ignore */ }
    }
    this.byDevice.set(k, conn);
    let set = this.byUser.get(conn.userId);
    if (!set) { set = new Set(); this.byUser.set(conn.userId, set); }
    set.add(conn.deviceId);
    this.logger.log(`+conn ${conn.userId}/${conn.deviceId} (total=${this.byDevice.size}${superseded ? ' superseded' : ''})`);
    return superseded;
  }

  /**
   * Returns `true` when this call actually evicted the session (i.e. it
   * was the live owner of the slot). Returns `false` when a newer
   * sessionId has already taken over — in that case the caller MUST
   * skip presence.onDisconnect, otherwise a supersession reconnect
   * causes a spurious offline → online flicker on every watcher.
   * Round 7 / presence audit fix #4.
   */
  remove(userId: string, deviceId: number, sessionId: string): boolean {
    const k = key(userId, deviceId);
    const existing = this.byDevice.get(k);
    if (!existing || existing.sessionId !== sessionId) return false;
    this.byDevice.delete(k);
    const set = this.byUser.get(userId);
    if (set) {
      set.delete(deviceId);
      if (set.size === 0) this.byUser.delete(userId);
    }
    this.logger.log(`-conn ${userId}/${deviceId} (total=${this.byDevice.size})`);
    return true;
  }

  get(userId: string, deviceId: number): Connection | undefined {
    return this.byDevice.get(key(userId, deviceId));
  }

  listForUser(userId: string): Connection[] {
    const devs = this.byUser.get(userId);
    if (!devs) return [];
    const out: Connection[] = [];
    for (const d of devs) {
      const c = this.byDevice.get(key(userId, d));
      if (c) out.push(c);
    }
    return out;
  }

  touch(userId: string, deviceId: number): void {
    const c = this.byDevice.get(key(userId, deviceId));
    if (c) c.lastSeenMs = Date.now();
  }

  size(): number {
    return this.byDevice.size;
  }
}

function key(userId: string, deviceId: number): string {
  return `${userId}:${deviceId}`;
}
