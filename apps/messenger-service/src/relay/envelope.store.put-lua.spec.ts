/**
 * AUDIT-2026-08-13 #20 — the PRODUCTION put path (Lua cap) is pinned.
 *
 * Every other relay spec forces `RELAY_DISABLE_LUA_CAP=true` (ioredis-mock
 * cannot run real Lua), so the EVAL call — the script bytes, the
 * KEYS/ARGV order, and the 0-result → 429 contract — was exercised by
 * NOTHING. This spec drives `put()` down the eval path against a stub
 * client that interprets the arguments exactly as the script's declared
 * contract reads them, importing the REAL script constant (never a copy —
 * the B-129 class).
 */
import {EnvelopeStore, PendingQueueFullError, PUT_WITH_CAP_LUA} from './envelope.store';
import type {StoredEnvelope} from './envelope.types';

type EvalArgs = [script: string, numKeys: number, ...rest: (string | number)[]];

function makeStore(evalImpl: (...args: EvalArgs) => Promise<unknown>) {
  const evalMock = jest.fn(evalImpl);
  const client = {eval: evalMock};
  const store = new EnvelopeStore({client} as never);
  return {store, evalMock};
}

const env = (id: string): StoredEnvelope => ({
  envelopeId: id,
  recipient: {userId: 'u-r', deviceId: 1},
  outerSealed: 'sealed-bytes',
  timestamp: 1_700_000_000_000,
} as never);

describe('AUDIT #20 — put() production Lua path', () => {
  beforeEach(() => {
    delete process.env['RELAY_DISABLE_LUA_CAP'];
    process.env['RELAY_MAX_PENDING_PER_DEVICE'] = '5';
  });
  afterEach(() => {
    delete process.env['RELAY_MAX_PENDING_PER_DEVICE'];
  });

  it('sends the REAL script with the KEYS/ARGV order the script declares', async () => {
    const {store, evalMock} = makeStore(async () => 1);
    await store.put(env('env-1'), 3600);
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, numKeys, ...rest] = evalMock.mock.calls[0] as EvalArgs;
    // The exact production script — the import IS the pin.
    expect(script).toBe(PUT_WITH_CAP_LUA);
    expect(numKeys).toBe(2);
    const [ekey, pkey, payload, ttl, score, member, cap] = rest as string[];
    // KEYS[1] = env key, KEYS[2] = pending index for the RECIPIENT.
    expect(String(ekey)).toContain('env-1');
    expect(String(pkey)).toContain('u-r');
    expect(String(pkey)).toContain('1');
    // ARGV in the script's declared order: payload, ttl, score, member, cap.
    expect(JSON.parse(String(payload)).envelopeId).toBe('env-1');
    expect(String(ttl)).toBe('3600');
    expect(String(score)).toBe('1700000000000');
    expect(String(member)).toBe('env-1');
    expect(String(cap)).toBe('5');
  });

  it('a 0 result — numeric OR the string form some clients return — maps to PendingQueueFullError', async () => {
    const numeric = makeStore(async () => 0);
    await expect(numeric.store.put(env('e'), 60)).rejects.toBeInstanceOf(PendingQueueFullError);
    const stringy = makeStore(async () => '0');
    await expect(stringy.store.put(env('e'), 60)).rejects.toBeInstanceOf(PendingQueueFullError);
    // Nothing persisted, submitter may retry — the error carries the cap.
    try {
      await makeStore(async () => 0).store.put(env('e'), 60);
    } catch (e) {
      expect((e as PendingQueueFullError).limit).toBe(5);
      expect((e as PendingQueueFullError).message).toBe('pending_queue_full');
    }
  });

  it('semantic parity: an interpreter reading the args AS THE SCRIPT DOES enforces the cap atomically', async () => {
    // A minimal Lua interpretation driven by the same positions the
    // script reads (ZCARD gate → SET+ZADD). It derives every decision
    // from the ARGS, so an arg-order regression in put() breaks the
    // behavior here, not just a shape assertion.
    const strings = new Map<string, string>();
    const zsets = new Map<string, Map<string, number>>();
    const {store} = makeStore(async (_script, _n, ...a) => {
      const [ekey, pkey, payload, _ttl, score, member, cap] = a.map(String);
      const z = zsets.get(pkey) ?? new Map<string, number>();
      if (z.size >= Number(cap)) {return 0;}
      strings.set(ekey, payload);
      z.set(member, Number(score));
      zsets.set(pkey, z);
      return 1;
    });
    for (let i = 0; i < 5; i++) {
      await store.put(env(`e-${i}`), 60);
    }
    await expect(store.put(env('e-overflow'), 60)).rejects.toBeInstanceOf(PendingQueueFullError);
    // The refused put persisted NOTHING (the script gates before writing).
    expect([...strings.keys()].some(k => k.includes('e-overflow'))).toBe(false);
    expect([...zsets.values()][0].size).toBe(5);
  });

  it('the script itself still gates BEFORE writing (source pin on the real constant)', () => {
    // Order matters: ZCARD → early return 0 → only then SET/ZADD. A
    // reordered script would admit the write before the cap check.
    const zcardAt = PUT_WITH_CAP_LUA.indexOf("ZCARD");
    const returnZeroAt = PUT_WITH_CAP_LUA.indexOf('return 0');
    const setAt = PUT_WITH_CAP_LUA.indexOf("'SET'");
    const zaddAt = PUT_WITH_CAP_LUA.indexOf("'ZADD'");
    expect(zcardAt).toBeGreaterThan(-1);
    expect(returnZeroAt).toBeGreaterThan(zcardAt);
    expect(setAt).toBeGreaterThan(returnZeroAt);
    expect(zaddAt).toBeGreaterThan(setAt);
  });

  it("the gate's COMPARISON is pinned (edge — the fake reimplements it, so only a source pin can catch a flip)", () => {
    // The semantic fake hard-codes `>=` independently of the script; an
    // inverted or off-by-one gate in the Lua (`>` admits cap+1; `<`
    // rejects EVERYTHING under cap = total relay outage) passed every
    // behavioral test. The one decision the script makes must be read
    // from the script.
    expect(PUT_WITH_CAP_LUA).toMatch(/if\s+cur\s*>=\s*tonumber\(ARGV\[5\]\)\s+then/);
  });
});
