/**
 * Static source-scan regression for Issue 40 (Testing Issues V2, PDF p.45) —
 * "New Job Notification Opens an Unexpected Error Screen".
 *
 * Reported as a slow load. It is a CRASH.
 *
 *   fcmBootstrap routed a 'dispatch-offer' wake to `{name: 'IncomingOffer'}`
 *   with NO params, and IncomingOfferScreen did
 *       const {offerId} = useRoute<...>().params;
 *   Destructuring `undefined` throws `TypeError: Cannot destructure property
 *   'offerId' of undefined`, which the app's ErrorBoundary renders as the
 *   literal string "Something went wrong". The job appeared moments later only
 *   because IncomingOfferWatcher polls and re-navigates WITH params.
 *
 * The server wake genuinely cannot supply an offer id — booking-push-bridge
 * publishes `{kind:'dispatch-offer', bookingId}` and nothing else — so the
 * screen has to resolve the live offer itself. Both halves are pinned here:
 * the producer always passes a params object, and the consumer never assumes one.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const SCREEN = join(ROOT, 'src', 'screens', 'agent', 'IncomingOfferScreen.tsx');
const BOOTSTRAP = join(ROOT, 'src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts');

/** CRLF-normalised, comments stripped — these files are CRLF, so a `\n`-anchored
 *  regex matches nothing and every assertion would pass VACUOUSLY. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('Issue 40 — a dispatch-offer push tap must not crash IncomingOfferScreen', () => {
  // NOTE: the type argument contains '>' (RouteProp<A, 'B'>), so a `[^>]*` class
  // stops at the FIRST '>' and never reaches `.params` — such a pattern matches
  // nothing and passes vacuously. Use a non-greedy [\s\S]*? instead.
  it('IncomingOfferScreen never destructures useRoute().params without a fallback', () => {
    const src = code(SCREEN);
    // The exact crash: `const {x} = useRoute<...>().params;` with no `??`.
    expect(src).not.toMatch(/const\s*\{[\s\S]*?\}\s*=\s*useRoute<[\s\S]*?>\(\)\.params\s*;/);
  });

  it('IncomingOfferScreen defends the params read with ?? {}', () => {
    expect(code(SCREEN)).toMatch(/useRoute<[\s\S]*?>\(\)\.params\s*\?\?\s*\{\}/);
  });

  it('IncomingOfferScreen can resolve the offer id when the push supplied none', () => {
    const src = code(SCREEN);
    // It already polls dispatchApi.getCurrentOffer(); arriving without an id must
    // adopt whatever live offer this provider holds rather than showing an error.
    expect(src).toContain('getCurrentOffer');
    expect(src).toMatch(/setOfferId\(/);
  });

  it('accept and decline refuse to fire without a resolved offer id', () => {
    const src = code(SCREEN);
    for (const fn of ['const accept = useCallback', 'const declineWith = useCallback']) {
      const start = src.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('}, [offerId', start));
      // A bare `dispatchApi.accept(undefined)` would 400 and read as a server fault.
      expect(body).toMatch(/if\s*\(!offerId\)/);
    }
  });

  it('fcmBootstrap always hands IncomingOffer a params object', () => {
    const src = code(BOOTSTRAP);
    const start = src.indexOf("kind === 'dispatch-offer'");
    expect(start).toBeGreaterThan(-1);
    const branch = src.slice(start, src.indexOf('} else if', start));
    expect(branch).toContain("name: 'IncomingOffer'");
    expect(branch).toContain('params:');
    // The regression shape — a bare candidate with no params at all.
    expect(branch).not.toMatch(/\{\s*name:\s*'IncomingOffer'\s*\}/);
  });

  it('the IncomingOffer route type marks offerId optional, matching the push path', () => {
    const types = code(join(ROOT, 'src', 'navigation', 'types.ts'));
    const line = types.split('\n').find(l => l.includes('IncomingOffer:'));
    expect(line).toBeDefined();
    // `offerId: string` (required) is what let the producer/consumer disagree
    // without the compiler noticing.
    expect(line).toMatch(/offerId\?:/);
  });
});
