import {
  BadRequestException, ConflictException,
  type CallHandler, type ExecutionContext,
} from '@nestjs/common';
import {of, throwError, firstValueFrom, type Observable} from 'rxjs';
import {IdempotencyInterceptor} from './idempotency.interceptor';
import type {RedisService} from '../../redis/redis.service';

// Mirrors the interceptor's private IN_PROGRESS sentinel.
const IN_PROGRESS = 'idem:in-progress';

const client = {get: jest.fn(), set: jest.fn(), del: jest.fn()};
const redis = {client} as unknown as RedisService;

function reqWith(idempotencyKey?: string): Record<string, unknown> {
  const headers: Record<string, string | undefined> = {'idempotency-key': idempotencyKey};
  return {
    header: (n: string) => headers[n.toLowerCase()],
    method: 'post',
    route: {path: '/dispatch/offers/:id/accept'},
    user: {sub: 'mgr-1'},
  };
}

function ctxFor(req: unknown): ExecutionContext {
  return {switchToHttp: () => ({getRequest: () => req})} as unknown as ExecutionContext;
}

function handlerReturning(value: unknown): {handler: CallHandler; calls: () => number} {
  const handle = jest.fn(() => of(value) as Observable<unknown>);
  return {handler: {handle} as unknown as CallHandler, calls: () => handle.mock.calls.length};
}

describe('IdempotencyInterceptor', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    client.set.mockResolvedValue('OK');   // reservation wins by default
    client.del.mockResolvedValue(1);
  });

  it('400s when the Idempotency-Key header is missing (acceptance f)', async () => {
    const i = new IdempotencyInterceptor(redis);
    await expect(i.intercept(ctxFor(reqWith(undefined)), handlerReturning({}).handler))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s on a malformed key (too short / illegal chars)', async () => {
    const i = new IdempotencyInterceptor(redis);
    await expect(i.intercept(ctxFor(reqWith('short')), handlerReturning({}).handler)).rejects.toBeInstanceOf(BadRequestException);
    await expect(i.intercept(ctxFor(reqWith('has spaces and !!')), handlerReturning({}).handler)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reserves the slot atomically (SET NX) BEFORE running the handler, then overwrites with the result', async () => {
    client.set.mockResolvedValue('OK');   // NX reservation wins
    const {handler, calls} = handlerReturning({offer_id: 'o1', status: 'CONFIRMED'});
    const i = new IdempotencyInterceptor(redis);
    const result = await firstValueFrom(await i.intercept(ctxFor(reqWith('accept-offer-1')), handler));
    expect(result).toEqual({offer_id: 'o1', status: 'CONFIRMED'});
    expect(calls()).toBe(1);
    // The reservation is NX and happens first...
    expect(client.set).toHaveBeenNthCalledWith(1, expect.stringMatching(/^idem:/), IN_PROGRESS, 'EX', expect.any(Number), 'NX');
    // ...then the marker is overwritten with the real (serialized) response.
    expect(client.set).toHaveBeenCalledWith(expect.stringMatching(/^idem:/), JSON.stringify({offer_id: 'o1', status: 'CONFIRMED'}), 'EX', expect.any(Number));
  });

  it('on a completed HIT returns the cached response and does NOT re-run the handler (acceptance e: single side-effect)', async () => {
    client.set.mockResolvedValue(null);   // NX reservation LOSES — key already exists
    client.get.mockResolvedValue(JSON.stringify({offer_id: 'o1', status: 'CONFIRMED'}));
    const {handler, calls} = handlerReturning({offer_id: 'SHOULD_NOT_RUN'});
    const i = new IdempotencyInterceptor(redis);
    const result = await firstValueFrom(await i.intercept(ctxFor(reqWith('accept-offer-1')), handler));
    expect(result).toEqual({offer_id: 'o1', status: 'CONFIRMED'});
    expect(calls()).toBe(0);              // handler never invoked on replay
  });

  it('INFRA-11: a concurrent double-tap (sibling still in-flight) gets 409 and does NOT run the handler', async () => {
    // The winner holds the reservation; a second identical request loses the NX
    // race and finds the IN_PROGRESS marker — it must NOT execute the money handler.
    client.set.mockResolvedValue(null);   // NX loses
    client.get.mockResolvedValue(IN_PROGRESS);
    const {handler, calls} = handlerReturning({offer_id: 'DOUBLE_TAP'});
    const i = new IdempotencyInterceptor(redis);
    await expect(i.intercept(ctxFor(reqWith('accept-offer-1')), handler))
      .rejects.toMatchObject({message: 'idempotency_key_in_progress'});
    expect(calls()).toBe(0);
  });

  it('INFRA-11: a corrupt cached row surfaces a retryable conflict and drops the bad row (never silently re-runs)', async () => {
    client.set.mockResolvedValue(null);   // NX loses
    client.get.mockResolvedValue('{not-valid-json');
    const {handler, calls} = handlerReturning({offer_id: 'X'});
    const i = new IdempotencyInterceptor(redis);
    await expect(i.intercept(ctxFor(reqWith('accept-offer-1')), handler))
      .rejects.toBeInstanceOf(ConflictException);
    expect(calls()).toBe(0);
    expect(client.del).toHaveBeenCalledWith(expect.stringMatching(/^idem:/));
  });

  it('releases the reservation on handler error so the same key can be retried', async () => {
    client.set.mockResolvedValue('OK');   // reservation wins
    const handle = jest.fn(() => throwError(() => new Error('boom')) as Observable<unknown>);
    const i = new IdempotencyInterceptor(redis);
    const obs = await i.intercept(ctxFor(reqWith('accept-offer-1')), {handle} as unknown as CallHandler);
    await expect(firstValueFrom(obs)).rejects.toThrow('boom');
    // The 24h marker must NOT persist after a failure — retry with the same key runs.
    expect(client.del).toHaveBeenCalledWith(expect.stringMatching(/^idem:/));
  });
});
