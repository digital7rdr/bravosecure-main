/**
 * B-316 — inbound expiry must tolerate device clock skew.
 *
 * The gate's unit contract, plus a source scan pinning that
 * `productionRuntime.ts` actually routes its M7 expiry drop through the gate
 * (the raw zero-tolerance compare destroyed short-TTL messages on any
 * fast-clocked receiver and acked them `delivered`).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  EXPIRY_CLOCK_SKEW_GRACE_MS,
  shouldDropExpiredPayload,
} from '../runtime/expiredEnvelopeGate';

describe('B-316 — shouldDropExpiredPayload', () => {
  const now = 1_800_000_000_000; // fixed epoch ms

  it('no TTL ⇒ never drops', () => {
    expect(shouldDropExpiredPayload(undefined, now)).toBe(false);
    expect(shouldDropExpiredPayload(null, now)).toBe(false);
    expect(shouldDropExpiredPayload(0, now)).toBe(false);
  });

  it('a live payload is kept', () => {
    expect(shouldDropExpiredPayload(now / 1000 + 30, now)).toBe(false);
  });

  it('expired WITHIN the skew grace is kept (the B-316 case)', () => {
    // Receiver clock 4 min fast relative to the sender: a 30 s TTL message
    // arrives "expired by ~3.5 min" — inside the grace, must render.
    const expiresAtSec = (now - 3.5 * 60_000) / 1000;
    expect(shouldDropExpiredPayload(expiresAtSec, now)).toBe(false);
  });

  it('expired beyond the grace still drops (offline backlog, M7)', () => {
    const expiresAtSec = (now - EXPIRY_CLOCK_SKEW_GRACE_MS - 1000) / 1000;
    expect(shouldDropExpiredPayload(expiresAtSec, now)).toBe(true);
  });

  it('the boundary is exact: expiry + grace == now drops', () => {
    const expiresAtSec = (now - EXPIRY_CLOCK_SKEW_GRACE_MS) / 1000;
    expect(shouldDropExpiredPayload(expiresAtSec, now)).toBe(true);
  });

  it('grace default is 5 minutes', () => {
    expect(EXPIRY_CLOCK_SKEW_GRACE_MS).toBe(5 * 60_000);
  });
});

describe('B-316 — productionRuntime routes the M7 drop through the gate', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');

  it('the gate is called on the receive path', () => {
    expect(src).toMatch(/shouldDropExpiredPayload\(unwrapped\.expiresAtSec, Date\.now\(\)\)/);
  });

  it('the raw zero-tolerance compare is gone', () => {
    // The exact pre-B-316 expression. Comments are stripped, so prose cannot
    // false-positive this.
    expect(src).not.toMatch(/expiresAtSec \* 1000 <= Date\.now\(\)/);
  });

  it('the drop line is release-visible (warn, not log)', () => {
    const at = src.indexOf('shouldDropExpiredPayload(unwrapped.expiresAtSec');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 400);
    expect(block).toMatch(/console\.warn\(/);
  });
});
