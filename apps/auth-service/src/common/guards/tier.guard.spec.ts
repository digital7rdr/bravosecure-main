import {ForbiddenException} from '@nestjs/common';
import type {ExecutionContext} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {TierGuard, effectiveTierOf, tierSatisfies} from './tier.guard';
import type {DatabaseService} from '../../database/database.service';

/**
 * M1A — lite < pro < enterprise. The rank rule (enterprise satisfies a
 * 'pro' requirement) plus the lapse-aware effective tier are the entire
 * entitlement arithmetic; every server gate routes through these two.
 */
describe('effectiveTierOf', () => {
  const future = new Date(Date.now() + 86_400_000);
  const past   = new Date(Date.now() - 86_400_000);

  it.each([
    [null,                                                        'lite'],
    [undefined,                                                   'lite'],
    [{subscription_tier: 'lite',       pro_active_until: null},   'lite'],
    [{subscription_tier: 'pro',        pro_active_until: null},   'pro'],        // RS-17 comp grant
    [{subscription_tier: 'enterprise', pro_active_until: null},   'enterprise'], // RS-17 comp grant
    [{subscription_tier: 'pro',        pro_active_until: future}, 'pro'],
    [{subscription_tier: 'enterprise', pro_active_until: future}, 'enterprise'],
    [{subscription_tier: 'pro',        pro_active_until: past},   'lite'],       // RS-19 lapse
    [{subscription_tier: 'enterprise', pro_active_until: past},   'lite'],       // RS-19 lapse
    [{subscription_tier: 'garbage',    pro_active_until: future}, 'lite'],       // unknown value fails closed
  ] as const)('%j → %s', (row, expected) => {
    expect(effectiveTierOf(row as never)).toBe(expected);
  });
});

describe('tierSatisfies', () => {
  it.each([
    ['lite', 'lite', true],  ['lite', 'pro', false],       ['lite', 'enterprise', false],
    ['pro', 'lite', true],   ['pro', 'pro', true],         ['pro', 'enterprise', false],
    ['enterprise', 'lite', true], ['enterprise', 'pro', true], ['enterprise', 'enterprise', true],
  ] as const)('%s satisfies %s → %s', (actual, required, expected) => {
    expect(tierSatisfies(actual, required)).toBe(expected);
  });
});

describe('TierGuard', () => {
  const mkCtx = (): ExecutionContext =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({getRequest: () => ({user: {sub: 'u-1'}})}),
    }) as unknown as ExecutionContext;

  const mk = (required: string | undefined, row: unknown) => {
    const db = {qOne: jest.fn().mockResolvedValue(row)} as unknown as DatabaseService;
    const reflector = {getAllAndOverride: jest.fn().mockReturnValue(required)} as unknown as Reflector;
    return new TierGuard(db, reflector);
  };

  it('passes an un-gated handler without touching the DB', async () => {
    const guard = mk(undefined, null);
    await expect(guard.canActivate(mkCtx())).resolves.toBe(true);
  });

  it('rejects a Lite caller on a pro-gated handler', async () => {
    const guard = mk('pro', {subscription_tier: 'lite', pro_active_until: null});
    await expect(guard.canActivate(mkCtx())).rejects.toThrow(ForbiddenException);
  });

  it('passes an Enterprise caller on a pro-gated handler (superset rule)', async () => {
    const guard = mk('pro', {subscription_tier: 'enterprise', pro_active_until: null});
    await expect(guard.canActivate(mkCtx())).resolves.toBe(true);
  });

  it('rejects a Pro caller on an enterprise-gated handler', async () => {
    const guard = mk('enterprise', {subscription_tier: 'pro', pro_active_until: null});
    await expect(guard.canActivate(mkCtx())).rejects.toThrow(ForbiddenException);
  });

  it('rejects a lapsed Enterprise caller on an enterprise-gated handler (RS-19)', async () => {
    const guard = mk('enterprise', {
      subscription_tier: 'enterprise',
      pro_active_until: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(guard.canActivate(mkCtx())).rejects.toThrow(ForbiddenException);
  });
});
