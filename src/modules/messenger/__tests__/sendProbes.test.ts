/**
 * W2 (MESSENGER_STABILITY_PLAN_2026-07-28) — the send-path probes.
 *
 * Why they exist: the founder's burst test measured ~150–280 ms of JS-thread
 * stall PER SEND with zero probe lines — the 2026-07-26 stage probes fire
 * only above 120 ms PER STAGE, so eight sub-threshold stages sum invisibly.
 * [send.total] gives one line per send to correlate against the JS-stall
 * timestamps; [MSGSTAT] turns the founder's "retry <1%, extreme cases only"
 * bar into a readable per-minute number.
 *
 * Pinned here:
 *  1. the wrapper lives at the API BOUNDARY — after the runtimeApi literal
 *     closes, before `return runtimeApi` — so the send pipeline's interior
 *     (the M-invariant surface MESSAGE_LOOP guards) is byte-identical;
 *  2. both tags are console.warn (release-visible; transform-remove-console
 *     strips log);
 *  3. the probe's log calls carry NUMBERS and a truncated conversation id
 *     only — never the message text (logAudit posture; `text` flows through
 *     the wrapper but may not appear inside any warn call).
 *
 * productionRuntime.ts cannot be imported by the node project — comment-
 * stripped source scan, CRLF-safe (no `\n` anchors).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\r\n]*/g, '');

function probeBlock(): string {
  const at = src.indexOf('origSendText = runtimeApi.sendText');
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf('return runtimeApi', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe('W2 — send probes at the API boundary', () => {
  it('the wrapper sits between the runtimeApi literal and its return', () => {
    // Inside-the-literal instrumentation would touch the M-invariant surface.
    const litEnd = src.indexOf('origSendText = runtimeApi.sendText');
    const ret = src.indexOf('return runtimeApi');
    expect(litEnd).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(litEnd);
  });

  it('[send.total] is a console.warn with total ms + ok flag', () => {
    const b = probeBlock();
    expect(b).toMatch(/console\.warn\(`\[LAGDIAG\] \[send\.total\] ms=\$\{ms\} ok=\$\{ok\}/);
  });

  it('[MSGSTAT] emits the per-minute reliability counts', () => {
    const b = probeBlock();
    expect(b).toMatch(/console\.warn\(`\[MSGSTAT\] window=60s sent=\$\{statSent\} failed=\$\{statFailed\}`\)/);
  });

  it('no warn in the probe references the message text', () => {
    // `text` is a wrapper parameter; it must never reach a log call.
    for (const line of probeBlock().split(/\r?\n/)) {
      if (!line.includes('console.warn')) {continue;}
      expect(line).not.toMatch(/\btext\b/);
    }
  });

  it('failures still count and still return through the original path', () => {
    const b = probeBlock();
    expect(b).toMatch(/if \(!ok\) \{statFailed \+= 1;\}/);
    // finally-based: the wrapper must not swallow the error.
    expect(b).toMatch(/finally \{/);
    expect(b).not.toMatch(/catch/);
  });
});
