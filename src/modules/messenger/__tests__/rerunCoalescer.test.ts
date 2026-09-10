import {createRerunCoalescer, MAX_COALESCER_RERUNS} from '../runtime/rerunCoalescer';

function deferred(): {promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void} {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

const flush = () => new Promise<void>(res => setImmediate(res));

/** A `run` whose Nth pass resolves/rejects only when the Nth gate is settled. */
function gatedRun(gates: Array<{promise: Promise<void>}>) {
  let pass = 0;
  return jest.fn(() => {
    const g = gates[pass++];
    return g ? g.promise : Promise.resolve();
  });
}

describe('OR-4 createRerunCoalescer', () => {
  it('preserves single-flight and collapses mid-pass triggers into ONE re-run', async () => {
    const gates = [deferred(), deferred()];
    const run = gatedRun(gates);
    const coalescer = createRerunCoalescer(run);

    const p1 = coalescer();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);

    const p2 = coalescer();
    const p3 = coalescer();
    const p4 = coalescer();
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    expect(p4).toBe(p1);
    expect(run).toHaveBeenCalledTimes(1);

    gates[0].resolve();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);

    gates[1].resolve();
    await p1;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not re-run when no trigger arrives mid-pass', async () => {
    const run = jest.fn(async () => {});
    const coalescer = createRerunCoalescer(run);
    await coalescer();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('coalesces 5 mid-pass callers into exactly 2 total passes', async () => {
    const gates = [deferred()];
    const run = gatedRun(gates);
    const coalescer = createRerunCoalescer(run);

    const p = coalescer();
    await flush();
    for (let i = 0; i < 5; i++) { void coalescer(); }
    gates[0].resolve();
    await p;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('bounds a self-retriggering chain at MAX_COALESCER_RERUNS + 1 passes', async () => {
    let coalescer!: () => Promise<void>;
    const run = jest.fn(async () => { void coalescer(); });
    coalescer = createRerunCoalescer(run);

    await coalescer();
    expect(run).toHaveBeenCalledTimes(MAX_COALESCER_RERUNS + 1);
  });

  it('runs the latched re-run even when the first pass throws, and resolves if it recovers', async () => {
    const gates = [deferred()];
    const run = gatedRun(gates);
    const coalescer = createRerunCoalescer(run);

    const p = coalescer();
    await flush();
    void coalescer();
    gates[0].reject(new Error('pass1 boom'));
    await expect(p).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects with the LAST pass error when the re-run fails', async () => {
    const gates = [deferred(), deferred()];
    const run = gatedRun(gates);
    const coalescer = createRerunCoalescer(run);

    const p = coalescer();
    await flush();
    void coalescer();
    gates[0].resolve();
    await flush();
    gates[1].reject(new Error('pass2 boom'));
    await expect(p).rejects.toThrow('pass2 boom');
  });

  it('propagates a lone failure with no latch', async () => {
    const run = jest.fn(async () => { throw new Error('solo boom'); });
    const coalescer = createRerunCoalescer(run);
    await expect(coalescer()).rejects.toThrow('solo boom');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('releases the slot before the rejection is observed', async () => {
    let calls = 0;
    const run = jest.fn(async () => { calls++; if (calls === 1) { throw new Error('boom'); } });
    const coalescer = createRerunCoalescer(run);

    await coalescer().catch(() => coalescer());
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('resets its latch state between cycles', async () => {
    const gates = [deferred()];
    const run = gatedRun(gates);
    const coalescer = createRerunCoalescer(run);

    const p1 = coalescer();
    await flush();
    void coalescer();
    gates[0].resolve();
    await p1;
    expect(run).toHaveBeenCalledTimes(2);

    const p2 = coalescer();
    expect(p2).not.toBe(p1);
    await p2;
    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe('OR-2 — wall-clock ownership (stuckMs)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('without stuckMs a never-settling run latches the slot (legacy shape)', async () => {
    let calls = 0;
    const coalescer = createRerunCoalescer(async () => {
      calls += 1;
      await new Promise(() => { /* never settles — frozen abort timer */ });
    });
    void coalescer();
    await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(10 * 60_000);
    void coalescer();
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1);
  });

  it('a trigger past stuckMs SUPERSEDES the wedged run and starts fresh', async () => {
    let calls = 0;
    const ctxs: Array<{superseded(): boolean}> = [];
    const coalescer = createRerunCoalescer(async (ctx) => {
      calls += 1;
      ctxs.push(ctx);
      if (calls === 1) {
        await new Promise(() => { /* wedged */ });
      }
    }, 2, 45_000);
    void coalescer();
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1);

    // Inside the window: still latched.
    jest.advanceTimersByTime(44_999);
    void coalescer();
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1);

    // Past the window: takeover.
    jest.advanceTimersByTime(2);
    const p = coalescer();
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(2);
    // The wedged run learns it lost the slot; the live run has not.
    expect(ctxs[0].superseded()).toBe(true);
    expect(ctxs[1].superseded()).toBe(false);
    await p;
  });

  it('heartbeat() defers the takeover — a slow-but-alive run keeps its slot', async () => {
    let calls = 0;
    let release!: () => void;
    let heartbeat!: () => void;
    const coalescer = createRerunCoalescer(async (ctx) => {
      calls += 1;
      heartbeat = () => ctx.heartbeat();
      await new Promise<void>(res => { release = res; });
    }, 2, 45_000);
    void coalescer();
    await Promise.resolve(); await Promise.resolve();

    // 40s in, the run reports progress (a row shipped).
    jest.advanceTimersByTime(40_000);
    heartbeat();
    // 40s later again — 80s since start but only 40s since progress.
    jest.advanceTimersByTime(40_000);
    void coalescer();
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1); // no takeover: it latched a re-run instead

    release();
    await Promise.resolve(); await Promise.resolve();
  });

  it("a superseded run's settle does not release the successor's slot", async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const coalescer = createRerunCoalescer(async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>(res => { releaseFirst = res; });
      } else {
        await new Promise(() => { /* live run in flight */ });
      }
    }, 2, 45_000);
    void coalescer();
    await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(45_001);
    void coalescer();
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(2);

    // The wedged run finally settles — the successor still owns the slot,
    // so a fresh trigger must LATCH (single-flight), not start a third run.
    releaseFirst();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    void coalescer();
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(2);
  });
});
