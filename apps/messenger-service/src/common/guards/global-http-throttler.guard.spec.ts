import 'reflect-metadata';
import {Test} from '@nestjs/testing';
import {ExecutionContext, UseGuards} from '@nestjs/common';
import {ThrottlerException, ThrottlerModule} from '@nestjs/throttler';
import {GlobalHttpThrottlerGuard} from './global-http-throttler.guard';
import {UserThrottlerGuard} from './user-throttler.guard';

// ── Fixture controllers ──────────────────────────────────────────────
// A bare controller (the vault/push/sfu/turn shape the audit flagged —
// no throttler guard of its own) and one that already binds
// UserThrottlerGuard (the relay/media/backup shape).
class BareController {
  handle(): string { return 'ok'; }
}

@UseGuards(UserThrottlerGuard)
class SelfThrottledController {
  handle(): string { return 'ok'; }
}

function httpCtx(
  cls: {new (): unknown},
  handler: (...args: unknown[]) => unknown,
  ip = '10.0.0.1',
): ExecutionContext {
  const req = {ip, ips: [ip], headers: {}};
  const res = {header: jest.fn()};
  return {
    getType:      () => 'http',
    getClass:     () => cls,
    getHandler:   () => handler,
    switchToHttp: () => ({getRequest: () => req, getResponse: () => res}),
  } as unknown as ExecutionContext;
}

function wsCtx(): ExecutionContext {
  return {
    getType:    () => 'ws',
    getClass:   () => BareController,
    getHandler: () => BareController.prototype.handle,
  } as unknown as ExecutionContext;
}

async function makeGuard(limit = 3): Promise<GlobalHttpThrottlerGuard> {
  const moduleRef = await Test.createTestingModule({
    imports:   [ThrottlerModule.forRoot([{name: 'default', ttl: 10_000, limit}])],
    providers: [GlobalHttpThrottlerGuard],
  }).compile();
  await moduleRef.init();
  return moduleRef.get(GlobalHttpThrottlerGuard);
}

describe('GlobalHttpThrottlerGuard (P2-2 / P2-16)', () => {
  it('throttles a previously-unguarded HTTP route once the limit is exceeded', async () => {
    const guard = await makeGuard(3);
    const ctx = () => httpCtx(BareController, BareController.prototype.handle);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow(ThrottlerException);
  });

  it('tracks callers independently (a second IP is not affected by the first bucket)', async () => {
    const guard = await makeGuard(2);
    const a = () => httpCtx(BareController, BareController.prototype.handle, '10.0.0.1');
    const b = () => httpCtx(BareController, BareController.prototype.handle, '10.0.0.2');
    await guard.canActivate(a());
    await guard.canActivate(a());
    await expect(guard.canActivate(a())).rejects.toThrow(ThrottlerException);
    await expect(guard.canActivate(b())).resolves.toBe(true);
  });

  it('skips non-HTTP (WS gateway) contexts entirely', async () => {
    const guard = await makeGuard(1);
    // Way past the limit — must never throw or touch storage for ws.
    for (let i = 0; i < 5; i++) {
      await expect(guard.canActivate(wsCtx())).resolves.toBe(true);
    }
  });

  it('skips routes whose controller already binds a ThrottlerGuard subclass', async () => {
    const guard = await makeGuard(1);
    const ctx = () => httpCtx(SelfThrottledController, SelfThrottledController.prototype.handle);
    // Limit is 1, but the controller-level UserThrottlerGuard owns this
    // route — the global guard must not double-count it.
    for (let i = 0; i < 5; i++) {
      await expect(guard.canActivate(ctx())).resolves.toBe(true);
    }
  });
});
