/**
 * B-333 — the "Waiting for this group's encryption key" banner must retire
 * the moment a group payload DECODES under our master key.
 *
 * Founder screenshot (2026-07-29, Ari2 freshly added to "kotiss"): the
 * message rendered fine, the red banner stayed. The only clears (B-213 /
 * B-262a) live inside drainPendingGroupInner, so any ordering where the key
 * lands without a subsequent OBSERVED drain leaves the banner stuck:
 * the drainsInFlight skip race (a pre-key drain in flight makes the
 * post-key call return without draining), or a no_key set that lands after
 * the drain's clear. A successful live decode is the strongest possible
 * "not key-blocked" signal, so the parse-ok lane must clear too.
 *
 * productionRuntime.ts cannot be imported by the node project — this is a
 * comment-stripped source scan (the file is CRLF; nothing is `\n`-anchored).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(): string {
  return readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

describe('B-333 — group-key banner clears on live decode success', () => {
  it('the parse-ok lane clears both key banners, equality-guarded, before routing', () => {
    const src = code();
    const okLaneStart = src.indexOf('const inner = parseResult.envelope;');
    expect(okLaneStart).toBeGreaterThan(-1);
    const routeAt = src.indexOf('applyGroupText(', okLaneStart);
    expect(routeAt).toBeGreaterThan(okLaneStart);
    const okLane = src.slice(okLaneStart, routeAt);
    // The clear must sit between "key provably worked" and the routing —
    // and must be equality-guarded per variant so a real, different error
    // that landed in between survives (B-213/B-262a discipline).
    expect(okLane).toMatch(/[=]== GROUP_KEY_PENDING_RECEIVE_ERROR/);
    expect(okLane).toMatch(/[=]== GROUP_KEY_DIVERGENCE_RECEIVE_ERROR/);
    expect(okLane).toMatch(/setError\(null\)/);
  });

  it('CONTROL: the drain-side clear (B-213/B-262a) still exists', () => {
    const src = code();
    const at = src.indexOf('async function drainPendingGroupInner');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, at + 6000);
    expect(fn).toMatch(/[=]== GROUP_KEY_PENDING_RECEIVE_ERROR/);
    expect(fn).toMatch(/[=]== GROUP_KEY_DIVERGENCE_RECEIVE_ERROR/);
    expect(fn).toMatch(/setError\(null\)/);
  });

  it('CONTROL: the no_key stash still sets the named constant (B-26b surface intact)', () => {
    const src = code();
    expect(src).toMatch(/setError\(GROUP_KEY_PENDING_RECEIVE_ERROR\)/);
    expect(src).toMatch(/setError\(GROUP_KEY_DIVERGENCE_RECEIVE_ERROR\)/);
  });
});
