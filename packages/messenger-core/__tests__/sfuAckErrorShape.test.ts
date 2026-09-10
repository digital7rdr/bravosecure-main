/**
 * Audit SFU-01 (2026-07-02) — client half of the event-less SFU error ack.
 *
 * The server now returns `{ok:false, data:{code,message}}` (NO `event` key)
 * on an SFU error so the NestJS socket.io adapter actually invokes the ack.
 * emitWithAck must REJECT on `ok === false` (surfacing the real reason) and
 * RESOLVE a normal success payload. It must also still reject a transitional
 * `{event:'sfu.error'}` shape for rollout safety.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock socket whose emit invokes the ack with whatever response the test set.
let mockNextAck: unknown;
const mockSockets: Array<unknown> = [];
jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: jest.fn(() => {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const sock = {
      on(event: string, cb: (...args: unknown[]) => void) {
        (handlers[event] = handlers[event] ?? []).push(cb);
      },
      onAny() { /* unused */ },
      emit(_event: string, _data: unknown, ack?: (resp: unknown) => void) {
        if (typeof ack === 'function') { ack(mockNextAck); }
      },
      disconnect() { /* unused */ },
      removeAllListeners() { /* unused */ },
      connected: true,
      id: 'sock-sfu01',
      __fire() { /* unused */ },
    };
    mockSockets.push(sock);
    return sock;
  }),
}));

import {TransportClient} from '../src/transport/client';

function newClient() {
  return new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 1,
    getToken: async () => 'jwt-token',
    onFrame: () => undefined,
  });
}

describe('emitWithAck — SFU-01 event-less error contract', () => {
  afterEach(() => { mockNextAck = undefined; mockSockets.length = 0; jest.clearAllMocks(); });

  it('rejects with the server message when the ack is {ok:false, data:{...}}', async () => {
    mockNextAck = {ok: false, data: {code: 'room_full', message: 'Call full (6/6)'}};
    const client = newClient();
    await client.connect();
    await expect(client.emitWithAck('sfu.join', {roomId: 'r1'})).rejects.toThrow('Call full (6/6)');
  });

  it('resolves a normal success payload (no ok field)', async () => {
    mockNextAck = {producerId: 'p-123'};
    const client = newClient();
    await client.connect();
    await expect(client.emitWithAck('sfu.produce', {roomId: 'r1'})).resolves.toEqual({producerId: 'p-123'});
  });

  it('resolves an explicit {ok:true} success ack', async () => {
    mockNextAck = {ok: true};
    const client = newClient();
    await client.connect();
    await expect(client.emitWithAck('sfu.producer.pause', {roomId: 'r1'})).resolves.toEqual({ok: true});
  });

  it('still rejects a transitional {event:"sfu.error"} shape (rollout safety)', async () => {
    mockNextAck = {event: 'sfu.error', data: {code: 'sfu_error', message: 'legacy path'}};
    const client = newClient();
    await client.connect();
    await expect(client.emitWithAck('sfu.consume', {roomId: 'r1'})).rejects.toThrow('legacy path');
  });
});
