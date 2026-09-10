/**
 * AUDIT-2026-08-13 D-5 + C-3 — regression pins.
 *
 * D-5: `urate:*` INCR-then-conditional-EXPIRE leaked untouched keys
 * forever when the EXPIRE leg never ran; the fix is one atomic MULTI.
 * C-3: a last-socket disconnect racing a same-user reconnect broadcast a
 * transient `offline`; the fix defers the flip behind a re-check.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {MessengerGateway} from './messenger.gateway';
import {PresenceService} from './presence.service';

describe('AUDIT D-5 — userRateExceeded is one atomic MULTI', () => {
  function makeGw(execResult: unknown) {
    const exec = jest.fn().mockResolvedValue(execResult);
    const expire = jest.fn().mockReturnValue({exec});
    const incr = jest.fn().mockReturnValue({expire});
    const multi = jest.fn().mockReturnValue({incr});
    const gw = Object.create(MessengerGateway.prototype) as MessengerGateway;
    (gw as never as {redis: unknown}).redis = {client: {multi}};
    return {gw, multi, incr, expire, exec};
  }
  const call = (gw: MessengerGateway): Promise<boolean> =>
    (gw as never as {userRateExceeded(u: string, v: string, p: number): Promise<boolean>})
      .userRateExceeded('u1', 'typing', 5);

  it('INCR and EXPIRE ride ONE MULTI (no leak window between two RTTs)', async () => {
    const {gw, multi, incr, expire, exec} = makeGw([[null, 3], [null, 1]]);
    await expect(call(gw)).resolves.toBe(false); // 3 <= 5
    expect(multi).toHaveBeenCalledTimes(1);
    expect(incr).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledWith(expect.stringContaining('urate:typing:u1:'), 120);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('over the cap rejects; a per-command error slot fails OPEN (ioredis resolves errors into slots)', async () => {
    const over = makeGw([[null, 6], [null, 1]]);
    await expect(call(over.gw)).resolves.toBe(true);
    const errSlot = makeGw([[new Error('OOM'), null], [null, 1]]);
    await expect(call(errSlot.gw)).resolves.toBe(false);
    const nullRes = makeGw(null);
    await expect(call(nullRes.gw)).resolves.toBe(false);
  });
});

describe('AUDIT C-3 — the offline flip is deferred behind a re-check', () => {
  it('confirmOffline: gone only when counter AND lease are both absent/zero', async () => {
    const mk = (mget: (string | null)[]) => {
      const svc = Object.create(PresenceService.prototype) as PresenceService;
      (svc as never as {redis: unknown}).redis = {client: {mget: jest.fn().mockResolvedValue(mget)}};
      return svc;
    };
    await expect(mk([null, null]).confirmOffline('u1')).resolves.toBe(true);
    await expect(mk(['0', null]).confirmOffline('u1')).resolves.toBe(true);
    // The reconnect landed while the grace ran — NOT offline:
    await expect(mk(['1', null]).confirmOffline('u1')).resolves.toBe(false);
    await expect(mk([null, '1']).confirmOffline('u1')).resolves.toBe(false);
  });

  it('handleDisconnect sets offline only INSIDE the deferred confirmOffline guard (source pin)', () => {
    const src = readFileSync(join(__dirname, 'messenger.gateway.ts'), 'utf8');
    const code = src.split(/\r?\n/)
      .filter(l => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
      .join('\n');
    // The disconnect block reaches its offline set through the guard…
    const guarded = /if \(await this\.presence\.confirmOffline\(uid\)\) \{\s*await this\.presence\.set\(uid, 'offline'\);/;
    expect(guarded.test(code)).toBe(true);
    // …behind the grace timer…
    expect(code).toContain('OFFLINE_FLIP_GRACE_MS');
    expect(/const OFFLINE_FLIP_GRACE_MS = 3_000;/.test(code)).toBe(true);
    // …and the OLD immediate shape is dead in the disconnect block.
    expect(code).not.toMatch(/onDisconnect\(claims\.sub\)\) \{\s*await this\.presence\.set\(claims\.sub, 'offline'\);/);
  });
});
