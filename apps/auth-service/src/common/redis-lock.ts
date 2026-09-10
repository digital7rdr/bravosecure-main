import * as crypto from 'node:crypto';

/**
 * FSM-3 — fenced sweep locks.
 *
 * Every Redis-locked sweep runs `SET key <token> PX <ttl> NX` and MUST release with
 * releaseRedisLock, which deletes the key ONLY if it still holds OUR token. A bare
 * `DEL key` is unsafe: if a sweep's batch outran its lock TTL and a second pod
 * re-acquired the lock, the slow pod's `DEL` would free the NEW holder's lock and a
 * third pod could enter — mutual exclusion collapses exactly under load. The
 * compare-and-delete is atomic via a Lua script (GET==token ? DEL : 0).
 *
 * acquire also fails SAFE: a Redis error at lock time returns null ("not acquired"),
 * so the sweep skips this tick instead of throwing (complements the INFRA-1 guard).
 */
export interface RedisLockClient {
  set(key: string, value: string, mode: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Acquire a fenced lock. Returns the token to release with, or null if held / unreachable. */
export async function acquireRedisLock(
  client: RedisLockClient, key: string, ttlMs: number,
): Promise<string | null> {
  const token = crypto.randomUUID();
  try {
    const got = await client.set(key, token, 'PX', ttlMs, 'NX');
    return got === 'OK' ? token : null;
  } catch {
    return null; // Redis unreachable — treat as not-acquired; skip this tick.
  }
}

/** Release a fenced lock — deletes the key only if it still holds our token. Best-effort. */
export async function releaseRedisLock(
  client: RedisLockClient, key: string, token: string,
): Promise<void> {
  try {
    await client.eval(RELEASE_LUA, 1, key, token);
  } catch {
    /* best-effort — the lock TTL is the backstop if the release can't run */
  }
}
