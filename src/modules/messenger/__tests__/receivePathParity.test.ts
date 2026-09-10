import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Static source-scan for M5 — WS/HTTP receive-path parity.
 *
 * There are two independent implementations of "receive one envelope and decide
 * how to ack it": `handleDeliverInner` (WebSocket) and `drainRelay` (HTTP
 * catch-up — the path users actually hit after being offline). Every
 * delivery-semantics fix has to be made twice, and historically the second copy
 * drifted. `productionRuntime.ts` is 8k lines and no test can import it (see
 * bootGroupStashDrain.test.ts:12), so this pins the parity by reading the
 * source, the same way messageTopologyInvariants.test.ts pins the send-path
 * invariants and groupCreateEpochBootstrap.test.ts pins the create-epoch guard.
 *
 * D1 — the persistent-dedup read must be fault-tolerant on BOTH paths.
 *      A throw from wasSeen() (SQLCipher not yet open on a fresh-install race,
 *      migration in progress, native bridge blip) was caught on WS but bare on
 *      the drain. There it does not skip one envelope: it unwinds the envelope
 *      loop AND the page loop out of drainRelay into a warn-only .catch, so up
 *      to a full page (1000 on bootstrap) plus every later page is abandoned
 *      unacked and silent. Degrading to "re-decrypt" is safe — libsignal's
 *      message-key dedup already covers a duplicate decrypt attempt.
 *
 * If this fails, do NOT relax it — restore the guard. See
 * docs/runbooks/MESSAGE_LOOP.md M5 / W8.
 */

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

function sliceBody(startNeedle: string, endNeedle: string): string {
  const src = readFileSync(RUNTIME, 'utf8');
  const start = src.indexOf(startNeedle);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endNeedle, start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The WebSocket receive path. */
function wsBody(): string {
  return sliceBody('async function handleDeliverInner(', '\nasync function ');
}

/** The HTTP catch-up path. */
function drainBody(): string {
  return sliceBody('async function drainRelay(', '\nfunction ');
}

describe('M5 — WS and HTTP receive paths validate identically (static source scan)', () => {
  it('both paths read the dedup store, so both can be hit by a store hiccup', () => {
    expect(wsBody()).toMatch(/wasSeen\(/);
    expect(drainBody()).toMatch(/wasSeen\(/);
  });

  it.each([
    ['WS (handleDeliverInner)', wsBody],
    ['HTTP (drainRelay)', drainBody],
  ])('D1: %s guards wasSeen() in a try/catch', (_label, body) => {
    const src = body();
    // The call must sit inside a try block that opens shortly before it.
    // A bare `await …wasSeen(` used as a condition is the regression.
    expect(src).toMatch(/try\s*\{[\s\S]{0,160}?wasSeen\(/);
    expect(src).not.toMatch(/if\s*\([^)]*await\s+[A-Za-z.]*seenEnvelopes\.wasSeen\(/);
  });

  it.each([
    ['WS (handleDeliverInner)', wsBody],
    ['HTTP (drainRelay)', drainBody],
  ])('D1: %s recovers to a local flag rather than throwing out of the loop', (_label, body) => {
    // Both paths must decide from a plain boolean they control, so a failed
    // read degrades to "process it" instead of unwinding.
    expect(body()).toMatch(/let\s+alreadySeen\s*=\s*false/);
    expect(body()).toMatch(/if\s*\(alreadySeen\)/);
  });

  it.each([
    ['WS (handleDeliverInner)', wsBody],
    ['HTTP (drainRelay)', drainBody],
  ])('D5: %s admits the sender cert through the ONE shared decision', (_label, body) => {
    // Each path used to carry its own ~60-line copy of the v3 cert admission —
    // two implementations of a SECURITY decision, already drifted in logging,
    // in the no-keys branch shape, and in the trust anchor consulted.
    expect(body()).toMatch(/admitSenderCert\(/);
  });

  it.each([
    ['WS (handleDeliverInner)', wsBody],
    ['HTTP (drainRelay)', drainBody],
  ])('D5: %s does not re-inline the PRE-DECRYPT verifySenderCert', (_label, body) => {
    // Scoped to verifySenderCert on purpose. Both paths legitimately still call
    // refreshPeerIdentityIfRotated further down, in the POST-handleIncoming
    // handler — that one reacts to a mismatch thrown by the DECRYPT, which is a
    // different event from the pre-decrypt cert admission and is not part of
    // this extraction.
    expect(body()).not.toMatch(/verifySenderCert\(/);
  });

  it('the shared admission never acks — acking stays the caller\'s job', () => {
    // The two paths ack differently (WS returns, the drain continues a loop).
    // Burying a relay call in the decision function would hide an ack inside
    // something named "admit", and would make the verdict untestable.
    const admit = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'senderCertAdmit.ts'),
      'utf8',
    );
    expect(admit).not.toMatch(/relay\.ack\(/);
    expect(admit).toMatch(/'leave-on-relay'/);
    expect(admit).toMatch(/'ack-discard'/);
  });
});
