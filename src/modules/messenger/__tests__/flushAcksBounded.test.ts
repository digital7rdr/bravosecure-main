/**
 * B-703 MR-5 — the shared, bounded ack flush both background wake lanes use.
 *
 * The delivered receipt (the sender's second tick) IS the relay ack, and acks
 * ride a 200 ms batcher that foreground callers fire and forget. A background
 * task that resolves without waiting lets Android freeze the process with the
 * POST unsent: the sender's tick stays single until the recipient opens the app.
 *
 * The bound is the other half of the contract — the ack queue can outlast any
 * wake budget (its 429 arm sleeps 10 s inside the run; a batchless relay acks
 * one POST per envelope), and waiting for that does not deliver the acks any
 * sooner while it DOES push the killed lane past its notify budget into the
 * generic fallback banner.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ACK_FLUSH_BUDGET_MS, flushAcksBounded} from '../push/flushAcksBounded';

describe('flushAcksBounded', () => {
  it('awaits a normal flush', async () => {
    let done = false;
    const rt = {flushAcks: async () => { await Promise.resolve(); done = true; }};
    await flushAcksBounded(rt, 'test');
    expect(done).toBe(true);
  });

  it('returns at the bound when the flush hangs — the budget is not burnt', async () => {
    const rt = {flushAcks: () => new Promise<void>(() => { /* never settles */ })};
    const t0 = Date.now();
    await flushAcksBounded(rt, 'test', 40);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('swallows a rejecting flush — an unacked envelope is redelivered, not fatal', async () => {
    const rt = {flushAcks: async () => { throw new Error('network down'); }};
    await expect(flushAcksBounded(rt, 'test')).resolves.toBeUndefined();
  });

  it('a runtime without flushAcks warns rather than failing silently', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await flushAcksBounded({}, 'test-tag');
      await flushAcksBounded(null, 'test-tag');
      await flushAcksBounded(undefined, 'test-tag');
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls.flat().join(' ')).toContain('no flushAcks');
    } finally { warn.mockRestore(); }
  });

  it('the default bound fits inside the killed lane 8s notify budget', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmHeadless.ts'), 'utf8');
    const m = /HEADLESS_DRAIN_BUDGET_MS = (\d+)/.exec(src);
    expect(m).not.toBeNull();
    expect(ACK_FLUSH_BUDGET_MS).toBeLessThan(Number(m![1]));
  });
});

describe('both background wake lanes flush (one rule, no drifted copies)', () => {
  const push = (f: string) =>
    readFileSync(join(process.cwd(), 'src', 'modules', 'messenger', 'push', f), 'utf8');

  it('the killed lane flushes after classifying, so a slow flush cannot delay the probe', () => {
    const src = push('headlessDrain.ts');
    const classify = src.indexOf('const verdict = classifyPullReport(report);');
    const flush = src.indexOf("await flushAcksBounded(runtime, 'headless drain');");
    expect(classify).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(classify);
  });

  it('the WARM lane flushes too — it OVERRIDES the headless handler when the app is alive', () => {
    // fcmBootstrap re-registers setBackgroundMessageHandler at module scope, so
    // this is the lane most wakes actually take. It pulled without ever
    // flushing, which is the same stuck tick one layer up.
    const src = push('fcmBootstrap.ts');
    const pull = src.indexOf('.pullEnvelopes(); pulled = true;');
    const flush = src.indexOf("await flushAcksBounded(rt, 'warm msg-wake');");
    expect(pull).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(pull);
  });
});
