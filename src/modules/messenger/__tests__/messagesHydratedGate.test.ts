/**
 * B-703 MR-12 — the drain waits for the message map, at EVERY kick site.
 *
 * The drain records a send store-first (`updateMessageStatus('sent')`,
 * `updateMessageEnvelopeId`) while `markDelivered` durably deletes the outbox
 * row. Ship before hydration and both writes hit an empty map, the row is gone,
 * and the MSG-07 boot sweep reds a message the relay accepted.
 *
 * Moving the boot kick below the hydrate closed ONE door of six: the WS connect
 * starts long before the SQLCipher block, and the connected / NetInfo /
 * AppState / server-signal / background kicks all gate on `sqlOutbox` alone —
 * which exists BEFORE the hydrate, with `loadRecent(200)` in between.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  areMessagesHydrated,
  awaitMessagesHydrated,
  markMessagesHydrated,
  resetMessagesHydratedGate,
} from '../runtime/messagesHydratedGate';

beforeEach(() => resetMessagesHydratedGate());

describe('the gate itself', () => {
  it('starts closed and opens once', () => {
    expect(areMessagesHydrated()).toBe(false);
    markMessagesHydrated();
    expect(areMessagesHydrated()).toBe(true);
    markMessagesHydrated(); // idempotent
    expect(areMessagesHydrated()).toBe(true);
  });

  it('a waiter parked before hydration is released by it', async () => {
    let released = false;
    const p = awaitMessagesHydrated(5_000).then(v => { released = true; return v; });
    await Promise.resolve();
    expect(released).toBe(false);
    markMessagesHydrated();
    expect(await p).toBe(true);
  });

  it('resolves immediately once already hydrated', async () => {
    markMessagesHydrated();
    expect(await awaitMessagesHydrated(5_000)).toBe(true);
  });

  it('FAILS OPEN — a hung hydrate must not stop sending forever', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await awaitMessagesHydrated(20)).toBe(false);
      expect(warn.mock.calls.flat().join(' ')).toContain('proceeding without hydration');
    } finally { warn.mockRestore(); }
  });

  it('a reset releases parked waiters instead of stranding them until timeout', async () => {
    const p = awaitMessagesHydrated(60_000);
    await Promise.resolve();
    resetMessagesHydratedGate();
    // Released, and the gate is closed again for the next owner.
    expect(await p).toBe(true);
    expect(areMessagesHydrated()).toBe(false);
  });
});

describe('every outbox kick goes through the gate (MR-12 — one rule, six doors)', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  it('no kick site calls the ungated drain directly', () => {
    // `void drainOutbox(` is the kick shape; the ONLY ungated call left must be
    // the gate's own tail call, which is a `return`, not a `void`.
    expect(src).not.toMatch(/void drainOutbox\(/);
    expect(src).toMatch(/return drainOutbox\(outbox, relay, isOurEpoch, reseal\);/);
  });

  it('the gate re-checks the epoch AFTER waiting', () => {
    const fn = src.slice(src.indexOf('async function drainOutboxWhenReady'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const wait = body.indexOf('await awaitMessagesHydrated()');
    expect(wait).toBeGreaterThan(-1);
    // Hydration can take seconds; a logout inside that window must not let a
    // dead runtime ship on the new owner's socket.
    expect(body.indexOf('isOurEpoch()', wait)).toBeGreaterThan(wait);
  });

  it('hydration is marked on BOTH the success and the failure path', () => {
    const marks = src.match(/markMessagesHydrated\(\);/g) ?? [];
    expect(marks.length).toBeGreaterThanOrEqual(2);
    // ...and the runtime teardown closes it again for the next owner.
    expect(src).toContain('resetMessagesHydratedGate()');
  });
});
