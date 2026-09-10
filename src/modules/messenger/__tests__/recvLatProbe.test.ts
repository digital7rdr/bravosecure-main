/**
 * F-0 (B-693) — the delivery-latency probes exist and stay wired.
 *
 * The receive side shipped with ZERO latency probes while the send side has
 * had [send.total] since B-285 — that blindness is why every delivery-latency
 * theory in docs/qa/MESSAGE_DELIVERY_LATENCY_2026-08-29.md is still a
 * hypothesis. These pins keep the instruments from silently rotting the way
 * the 120 ms send1v1 threshold did (never fired on device, B-285).
 *
 * productionRuntime.ts cannot be imported by this project (react-native) —
 * comment-stripped source scan. The file is CRLF: nothing here is
 * `\n`-anchored, and anchors sit inside function slices, never whole-file.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function strip(rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const runtime = strip(['src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts']);

/** Slice between two unique anchors; both must exist and be ordered. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('B-693 F-0 — [recv.total] in the WS deliver path', () => {
  const deliverInner = slice(runtime, 'async function handleDeliverInner', 'async function handleIncoming');

  it('emits one [recv.total] line with the stage split and the chain gauge', () => {
    expect(deliverInner).toContain("'[LAGDIAG] [recv.total] ms='");
    expect(deliverInner).toContain("' chainWait='");
    expect(deliverInner).toContain("' qdepth='");
    expect(deliverInner).toContain("' txn='");
  });

  it('samples qdepth at ARRIVAL, before this envelope enqueues its own frame', () => {
    const at = deliverInner.indexOf('chainPendingCount()');
    expect(at).toBeGreaterThan(-1);
    // Must precede the first handleIncoming call (which appends the frame).
    expect(at).toBeLessThan(deliverInner.indexOf('await handleIncoming('));
  });

  it('threads recvPerf into BOTH handleIncoming calls (first pass + rotation retry)', () => {
    const passes = deliverInner.match(/recvPerf,/g) ?? [];
    expect(passes).toHaveLength(2);
  });

  it('the line fires BEFORE the ack decision, not inside it', () => {
    const probeAt = deliverInner.indexOf("'[LAGDIAG] [recv.total] ms='");
    const ackGate = deliverInner.indexOf('if (!leaveOnRelay) {');
    expect(probeAt).toBeGreaterThan(-1);
    expect(ackGate).toBeGreaterThan(probeAt);
  });
});

describe('B-693 F-0 — chain-wait / in-txn split inside handleIncoming', () => {
  const handleIncoming = slice(runtime, 'async function handleIncoming', 'async function runDecryptRecovery');

  it('stamps chainWaitMs on frame ENTRY and txnMs after doHandleIncoming, inside the txn closure', () => {
    const waitAt = handleIncoming.indexOf('perf.chainWaitMs = tW0 - tQ0');
    const workAt = handleIncoming.indexOf('await doHandleIncoming(');
    const txnAt  = handleIncoming.indexOf('perf.txnMs = Date.now() - tW0');
    expect(waitAt).toBeGreaterThan(-1);
    expect(workAt).toBeGreaterThan(waitAt);
    expect(txnAt).toBeGreaterThan(workAt);
  });
});

describe('B-693 F-0 — sender-side probes', () => {
  it('[send.group] logs member count + wave wall time after the fan-out wave', () => {
    // F-2 (B-693) re-point — the flat allSettled became chunked waves; the
    // probe now sits between the wave loop and the zero-delivered branch.
    const wave = slice(
      runtime,
      'const GROUP_FANOUT_WAVE',
      'if (delivered === 0) {',
    );
    expect(wave).toContain("'[LAGDIAG] [send.group] members='");
    expect(wave).toContain("' waveMs='");
  });

  it('[send.1v1] carries the outbox leg (dead-phone plan F8) and a total', () => {
    expect(runtime).toContain("'[LAGDIAG] [send.1v1] cert='");
    expect(runtime).toContain("'ms outbox='");
  });

  it('the send1v1 per-member stage probe fires at 40 ms, not the dead 120', () => {
    // B-285: at 120 the probe NEVER fired on device — legs sat under the
    // threshold while their sum did not. Raising it back re-blinds the lane.
    expect(runtime).toContain('tWrap1 - tSes0 > 40');
    expect(runtime).not.toContain('tWrap1 - tSes0 > 120');
  });
});
