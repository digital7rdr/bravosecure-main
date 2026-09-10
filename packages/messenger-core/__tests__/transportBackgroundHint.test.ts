/**
 * B-354 — background (headless) sockets must declare themselves in the
 * handshake so the gateway can keep them out of user-visible presence.
 *
 * The killed-app message drain boots the full runtime in a headless VM; its
 * socket connecting used to paint the user green "Online"/"Active now" to
 * every watcher seconds after a message arrived — while the app was killed.
 * The transport now sends `bg:'1'` in the socket.io auth payload when
 * constructed with `background: true` (the headless-drain config lane), and
 * sends nothing extra otherwise, so old servers and interactive sockets are
 * byte-identical to before.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

const ioCalls: Array<{opts: {auth?: Record<string, unknown>}}> = [];

jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: jest.fn((_base: string, opts: {auth?: Record<string, unknown>}) => {
    ioCalls.push({opts});
    return {
      connected: true,
      on() { /* not needed */ },
      onAny() { /* not needed */ },
      removeAllListeners() { /* no-op */ },
      emit() { /* not needed */ },
      disconnect() { /* no-op */ },
      io: {on() { /* no-op */ }, off() { /* no-op */ }},
    };
  }),
}));

import {TransportClient} from '../src/transport/client';

function tokenExpiringIn(secondsFromNow: number): string {
  const payload = {exp: Math.floor(Date.now() / 1000) + secondsFromNow, sub: 'u1'};
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
  return `header.${b64}.sig`;
}

function buildClient(background?: boolean): TransportClient {
  return new TransportClient({
    url: 'http://localhost:3100',
    signalDeviceId: 1,
    getToken: async () => tokenExpiringIn(15 * 60),
    ...(background === undefined ? {} : {background}),
    onFrame: () => { /* ignored */ },
  });
}

describe('TransportClient — background presence hint (B-354)', () => {
  beforeEach(() => { ioCalls.length = 0; });
  afterEach(() => { jest.clearAllMocks(); });

  it('background: true → the handshake auth payload carries bg:"1"', async () => {
    await buildClient(true).connect();
    expect(ioCalls).toHaveLength(1);
    expect(ioCalls[0].opts.auth?.bg).toBe('1');
  });

  it('background: false → no bg field at all (byte-identical to legacy)', async () => {
    await buildClient(false).connect();
    expect(ioCalls[0].opts.auth).not.toHaveProperty('bg');
  });

  it('background omitted → no bg field (every existing caller unchanged)', async () => {
    await buildClient(undefined).connect();
    expect(ioCalls[0].opts.auth).not.toHaveProperty('bg');
  });
});
