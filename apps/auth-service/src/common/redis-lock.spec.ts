/**
 * FSM-3 — fenced sweep locks. The release MUST be a token-guarded compare-and-delete
 * (Lua), never a bare DEL: a slow pod whose lock TTL expired must not be able to free
 * the NEW holder's lock. Acquire fails safe (null) on a Redis error.
 */
import {acquireRedisLock, releaseRedisLock} from './redis-lock';

function mkClient(setReply: string | null) {
  return {
    set: jest.fn().mockResolvedValue(setReply),
    eval: jest.fn().mockResolvedValue(1),
  };
}

describe('fenced redis lock (FSM-3)', () => {
  it('acquire returns a token on OK and null when the key is already held', async () => {
    expect(await acquireRedisLock(mkClient('OK') as never, 'k', 1000)).toEqual(expect.any(String));
    expect(await acquireRedisLock(mkClient(null) as never, 'k', 1000)).toBeNull();
  });

  it('acquire fails SAFE (null) when the SET rejects (Redis unreachable)', async () => {
    const c = {set: jest.fn().mockRejectedValue(new Error('down')), eval: jest.fn()};
    expect(await acquireRedisLock(c as never, 'k', 1000)).toBeNull();
  });

  it('release is a token-guarded compare-and-delete on OUR key — never a bare DEL', async () => {
    const c = mkClient('OK');
    const token = await acquireRedisLock(c as never, 'lock:x', 1000);
    await releaseRedisLock(c as never, 'lock:x', token as string);
    expect(c.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('del'"), 1, 'lock:x', token);
    expect((c as {del?: unknown}).del).toBeUndefined(); // no bare-DEL path exists
  });

  it('release swallows a Redis error (best-effort; the lock TTL is the backstop)', async () => {
    const c = {set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockRejectedValue(new Error('down'))};
    await expect(releaseRedisLock(c as never, 'k', 'tok')).resolves.toBeUndefined();
  });
});
