import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ackDispositionFor} from '../runtime/ackDisposition';

/**
 * M5 — the ack disposition is a REMOTE-DEVICE UI CONTRACT: 'discarded' flips the
 * SENDER's bubble to `undelivered` and fires a B-46 auto-resend, 'delivered' is
 * the ✓✓. It was computed inline in two places (WS + drain) with only the local
 * variable name differing. Now one shared pure function.
 */
describe('ackDispositionFor', () => {
  it("acks 'discarded' when the handler failed unrecoverably", () => {
    expect(ackDispositionFor(false, false)).toBe('discarded');
  });

  it("acks 'discarded' when the deep path left a destroyed-note, even if handled", () => {
    expect(ackDispositionFor(true, true)).toBe('discarded');
  });

  it("acks 'delivered' only when handled AND no destroyed-note", () => {
    expect(ackDispositionFor(true, false)).toBe('delivered');
  });

  it("a failed handler with a note is still 'discarded'", () => {
    expect(ackDispositionFor(false, true)).toBe('discarded');
  });
});

describe('M5 — both receive paths use the ONE shared disposition helper (static scan)', () => {
  const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

  it('neither path re-inlines the `(!handled... || destroyed) ? discarded : delivered` computation', () => {
    const src = readFileSync(RUNTIME, 'utf8');
    // The old inline form, in either variable spelling. If this reappears, the
    // contract has been forked again — extract it, do not copy it.
    expect(src).not.toMatch(/\?\s*'discarded'\s+as\s+const\s*:\s*'delivered'\s+as\s+const/);
  });

  it('both ack sites route through ackDispositionFor', () => {
    const src = readFileSync(RUNTIME, 'utf8');
    const calls = src.match(/ackDispositionFor\(/g) ?? [];
    // WS (handleDeliverInner) + HTTP (drainRelay).
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
