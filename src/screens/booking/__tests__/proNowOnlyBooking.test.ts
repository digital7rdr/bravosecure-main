/**
 * Founder 2026-08-26 — an ACTIVE Pro member books NOW only in the ad-hoc
 * Secure flow. Scheduled protection is the Pro plan's own product (Booking
 * Requests → ops approval), so 'Book Later' there duplicates it.
 *
 * Source scan (the screen mounts pickers + animated pills that make a render
 * test heavyweight), anchored at the decision sites per the CLAUDE.md scan
 * rules: comments stripped, CRLF-safe, and the anchors are the executing
 * expressions — not merely "the token appears somewhere".
 */
import fs from 'fs';
import path from 'path';

const SCREEN = path.resolve(
  __dirname, '..', 'BookingDateTimeScreen.tsx',
);

function code(): string {
  return fs
    .readFileSync(SCREEN, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

describe('Pro members are now-only in the Secure booking flow', () => {
  const src = code();

  it('derives Pro from the STORE, not the redirecting gate hook', () => {
    // useProPlanGate replaces non-Pro users off the screen — using it here
    // would eject every ordinary booker. The screen must read the store.
    expect(src).toMatch(/useSecureProStore\(st => st\.application\)/);
    expect(src).not.toMatch(/useProPlanGate/);
    // …and loads it, because nothing else on this route does.
    expect(src).toMatch(/void loadProApplication\(\)/);
  });

  it('gates the WHOLE toggle on proActive — hidden, never a no-op', () => {
    // A rendered "Book Later" that snaps back reads as broken (the B-590
    // hidden-door rule). The ternary must wrap the toggle container itself.
    expect(src).toMatch(/\{proActive \? \(/);
    const gated = src.slice(src.indexOf('{proActive ? ('));
    expect(gated).toMatch(/s\.proNowOnly\}/);          // the explanation card
    expect(gated).toMatch(/\) : \(\s*<View style=\{s\.toggle\}/); // else-arm = the toggle
  });

  it('a stale later draft (or mid-flow activation) is forced back to now', () => {
    expect(src).toMatch(/if \(proActive && mode === 'later'\) \{setMode\('now'\);\}/);
  });

  it('the copy points Pro members at Booking Requests', () => {
    expect(src).toMatch(/Schedule protection dates via Booking Requests/);
  });
});
