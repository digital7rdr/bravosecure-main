import {OpsApprovedDispatchService} from './ops-approved-dispatch.service';
import {OPS_APPROVED_DISPATCH_CHANNEL} from '../ops/ops.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {DispatchService} from './dispatch.service';

type Handler = (channel: string, raw: string) => void;

function harness(flagOn = true) {
  const handlers: Record<string, Handler[]> = {};
  const sub = {
    on: jest.fn((event: string, fn: Handler): void => {
      (handlers[event] ??= []).push(fn);
    }),
    subscribe: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue('OK'),
  };
  const client = {
    duplicate: jest.fn().mockReturnValue(sub),
    set: jest.fn().mockResolvedValue('OK'), // lock acquired by default
  };
  const redis = {client} as unknown as RedisService;
  const config = {get: jest.fn().mockReturnValue(flagOn)} as unknown as ConfigService;
  const dispatch = {start: jest.fn().mockResolvedValue(undefined)} as unknown as DispatchService;
  const svc = new OpsApprovedDispatchService(redis, config, dispatch);
  const emit = (channel: string, raw: string) => {
    for (const fn of handlers['message'] ?? []) fn(channel, raw);
  };
  return {svc, sub, client, dispatch, emit};
}

const flush = () => new Promise(r => setImmediate(r));

describe('OpsApprovedDispatchService (ops-approved → dispatch.start handoff)', () => {
  it('ships dark: does not subscribe when AUTO_DISPATCH_ENABLED is off', () => {
    const {svc, client} = harness(false);
    svc.onApplicationBootstrap();
    expect(client.duplicate).not.toHaveBeenCalled();
  });

  it('subscribes a duplicated connection to dispatch:ops-approved on bootstrap', async () => {
    const {svc, sub, client} = harness();
    svc.onApplicationBootstrap();
    await flush();
    expect(client.duplicate).toHaveBeenCalledTimes(1);
    expect(sub.subscribe).toHaveBeenCalledWith(OPS_APPROVED_DISPATCH_CHANNEL);
  });

  it('a published frame starts the dispatch for that booking', async () => {
    const {svc, dispatch, emit} = harness();
    svc.onApplicationBootstrap();
    await flush();
    emit(OPS_APPROVED_DISPATCH_CHANNEL, JSON.stringify({bookingId: 'b1'}));
    await flush();
    expect(dispatch.start).toHaveBeenCalledWith('b1');
    expect(dispatch.start).toHaveBeenCalledTimes(1);
  });

  it('multi-pod: two deliveries of the same frame start the dispatch exactly once (SET NX lock)', async () => {
    const {svc, client, dispatch} = harness();
    // First pod wins the lock, second pod's SET NX returns null.
    client.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    await svc.handleMessage(JSON.stringify({bookingId: 'b1'}));
    await svc.handleMessage(JSON.stringify({bookingId: 'b1'}));
    expect(client.set).toHaveBeenCalledTimes(2);
    expect(client.set).toHaveBeenCalledWith('lock:ops-approved-dispatch:b1', expect.any(String), 'PX', 30_000, 'NX');
    expect(dispatch.start).toHaveBeenCalledTimes(1);
  });

  it('a failed start() is swallowed (warn) — the frame never throws out of the handler', async () => {
    const {svc, dispatch} = harness();
    (dispatch.start as jest.Mock).mockRejectedValueOnce(new Error('booking_state_changed_concurrently'));
    await expect(svc.handleMessage(JSON.stringify({bookingId: 'b1'}))).resolves.toBeUndefined();
    expect(dispatch.start).toHaveBeenCalledWith('b1');
  });

  it('ignores malformed frames and frames without a bookingId (no start, no lock)', async () => {
    const {svc, client, dispatch} = harness();
    await svc.handleMessage('not-json');
    await svc.handleMessage(JSON.stringify({nope: true}));
    expect(client.set).not.toHaveBeenCalled();
    expect(dispatch.start).not.toHaveBeenCalled();
  });

  it('ignores messages on other channels', async () => {
    const {svc, dispatch, emit} = harness();
    svc.onApplicationBootstrap();
    await flush();
    emit('push:events', JSON.stringify({bookingId: 'b1'}));
    await flush();
    expect(dispatch.start).not.toHaveBeenCalled();
  });

  it('a lock-acquire error fails closed (skip) — start() is never double-run on a flaky Redis', async () => {
    const {svc, client, dispatch} = harness();
    client.set.mockRejectedValueOnce(new Error('conn reset'));
    await expect(svc.handleMessage(JSON.stringify({bookingId: 'b1'}))).resolves.toBeUndefined();
    expect(dispatch.start).not.toHaveBeenCalled();
  });
});
