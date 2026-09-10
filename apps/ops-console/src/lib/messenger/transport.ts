/**
 * Authenticated socket.io client for the messenger-service WS gateway.
 *
 * Web mirror of `packages/messenger-core/src/transport/client.ts` (the LIVE
 * client both mobile and this console track; AUDIT-2026-08-13 #8 — the old
 * pointer here named the mobile transport/client.ts ORPHAN, now a tombstone) —
 * same connection state machine, same frame shape. socket.io 4.x +
 * Redis adapter on the server means any replica can service this
 * connection transparently.
 *
 * The runtime owns one of these per unlocked vault. Frames go in via
 * `send()`, come out via the `onFrame` callback. Reconnects are
 * handled by socket.io itself; the wrapper just maps lifecycle events
 * to UI-friendly states.
 */

import {io, type Socket} from 'socket.io-client';
import type {ClientFrame, ServerFrame} from '@bravo/messenger-core';

export type TransportState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unauthorized';

export interface TransportOptions {
  /** Messenger-service base URL — e.g. `http://localhost:3100`. */
  url: string;
  /** Signal device id — required by the server to route envelopes. */
  signalDeviceId: number;
  /** Called before every connect attempt. Return null to abort with `unauthorized`. */
  getToken: () => Promise<string | null>;
  /** Fires for every server frame. */
  onFrame: (frame: ServerFrame) => void;
  /** Optional — receive state transitions for UI surfaces. */
  onStateChange?: (state: TransportState) => void;
  /** Max backoff between reconnect attempts. Defaults to 30s. */
  maxBackoffMs?: number;
}

export class TransportClient {
  private socket: Socket | null = null;
  private _state: TransportState = 'disconnected';
  private closedByUser = false;

  constructor(private readonly opts: TransportOptions) {}

  get state(): TransportState { return this._state; }

  async connect(): Promise<void> {
    this.closedByUser = false;
    await this.open();
  }

  send(frame: ClientFrame): void {
    if (!this.socket || !this.socket.connected) {
      throw new Error('transport not open');
    }
    this.socket.emit(frame.event, (frame as {data?: unknown}).data ?? {});
  }

  subscribePresence(userIds: string[]): void {
    if (userIds.length === 0) return;
    this.send({event: 'presence.subscribe', data: {userIds}});
  }

  unsubscribePresence(userIds: string[]): void {
    if (userIds.length === 0) return;
    this.send({event: 'presence.unsubscribe', data: {userIds}});
  }

  setActivity(state: 'active' | 'away'): void {
    this.send({event: 'presence', data: {state}});
  }

  sendTyping(to: {userId: string; deviceId: number}, state: 'start' | 'stop'): void {
    try { this.send({event: 'typing', data: {to, state}}); } catch { /* socket not open */ }
  }

  sendReadReceipt(to: {userId: string; deviceId: number}, envelopeIds: string[]): void {
    if (envelopeIds.length === 0) return;
    try { this.send({event: 'read-receipt', data: {to, envelopeIds}}); }
    catch { /* socket not open — best-effort */ }
  }

  ackEnvelope(envelopeId: string): void {
    try { this.send({event: 'envelope.ack', data: {envelopeId}}); } catch { /* fall back to HTTP ack */ }
  }

  close(): void {
    this.closedByUser = true;
    if (this.socket) {
      try { this.socket.disconnect(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.setState('disconnected');
  }

  private async open(): Promise<void> {
    if (this.closedByUser) return;
    this.setState('connecting');

    const token = await this.opts.getToken();
    if (!token) { this.setState('unauthorized'); return; }

    const maxBackoff = this.opts.maxBackoffMs ?? 30_000;
    // socket.io-client treats anything after the host as a namespace,
    // so strip a trailing `/ws`. The handshake path is set via `path`.
    const base = this.opts.url.replace(/\/ws\/?$/, '');
    const socket = io(base, {
      path:                 '/ws',
      transports:           ['websocket'],
      reconnection:         true,
      reconnectionAttempts: Infinity,
      reconnectionDelay:    500,
      reconnectionDelayMax: maxBackoff,
      randomizationFactor:  0.5,
      autoConnect:          true,
      forceNew:             true,
      // Audit P0-W4 — token + deviceId travel in the Socket.IO `auth`
      // object (carried inside the WS upgrade body) instead of the
      // query string. The query form was logged by every reverse-proxy
      // / CDN edge / browser history entry along the way. Server
      // (extractHandshakeParams) prefers auth and falls back to query
      // for one rollout release.
      auth: {
        token,
        signalDeviceId: this.opts.signalDeviceId,
      },
    });
    this.socket = socket;

    socket.on('connect',           () => this.setState('connected'));
    socket.on('reconnect_attempt', () => this.setState('reconnecting'));
    socket.on('connect_error',     () => {
      if (!this.closedByUser) this.setState('reconnecting');
    });

    socket.onAny((event: string, data: unknown) => {
      // The server's `error` frame carries `{code, message}`. Auth
      // failures arrive as `error` immediately before the disconnect.
      if (event === 'error' && isErrorPayload(data) && data.code === 'unauthorized') {
        this.closedByUser = true;
        this.setState('unauthorized');
        try { socket.disconnect(); } catch { /* ignore */ }
        return;
      }
      const frame = {event, data} as ServerFrame;
      this.opts.onFrame(frame);
    });

    socket.on('disconnect', (reason: string) => {
      if (this.closedByUser) { this.setState('disconnected'); return; }
      // `io server disconnect` is server-issued (auth / supersession);
      // socket.io will NOT auto-reconnect. Anything else gets retried.
      if (reason === 'io server disconnect') {
        this.setState('disconnected');
        return;
      }
      this.setState('reconnecting');
    });
  }

  private setState(next: TransportState): void {
    if (this._state === next) return;
    this._state = next;
    this.opts.onStateChange?.(next);
  }
}

function isErrorPayload(v: unknown): v is {code: string; message?: string} {
  return !!v && typeof v === 'object' && typeof (v as {code?: unknown}).code === 'string';
}
