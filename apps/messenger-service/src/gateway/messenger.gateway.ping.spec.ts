/**
 * B-05 — `ping` handler must BOTH emit a `pong` event (fire-and-forget RTT
 * listener in productionRuntime) AND return an event-less value so NestJS
 * invokes the socket.io ack (emitWithAck keepalive in useGroupCall).
 * A regression to an event-shaped return reintroduces `ack_timeout:ping`.
 *
 * handlePing uses no instance state, so we invoke it off the prototype with a
 * fake socket — no need to build the full gateway (Redis/registry/presence).
 */
import type {Socket} from 'socket.io';
import {MessengerGateway} from './messenger.gateway';

function fakeSocket() {
  return {emit: jest.fn()} as unknown as Socket & {emit: jest.Mock};
}

describe('B-05 — handlePing emits pong AND acks', () => {
  const handlePing = MessengerGateway.prototype.handlePing;

  test('returns an event-LESS object so Nest routes it to the ack', () => {
    const sock = fakeSocket();
    const ret = handlePing.call({}, {ts: 123}, sock) as Record<string, unknown>;
    expect(ret).toEqual({ts: 123});
    expect(ret.event).toBeUndefined(); // must NOT be WsResponse-shaped
  });

  test('emits a `pong` event for the fire-and-forget RTT listener path', () => {
    const sock = fakeSocket();
    handlePing.call({}, {ts: 123}, sock);
    expect(sock.emit).toHaveBeenCalledWith('pong', {ts: 123});
  });

  test('falls back to a server ts when the client omits one', () => {
    const sock = fakeSocket();
    const ret = handlePing.call({}, undefined, sock) as {ts: number};
    expect(typeof ret.ts).toBe('number');
    expect(sock.emit).toHaveBeenCalledWith('pong', {ts: ret.ts});
  });
});
