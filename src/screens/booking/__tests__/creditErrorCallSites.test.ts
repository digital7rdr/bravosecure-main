/**
 * Issue 25 — every place that can be handed an "insufficient credits" failure
 * must use the ONE shared rule (creditErrors.ts), not a hand-rolled copy.
 *
 * Four copies of this check existed and three were wrong for at least one error
 * shape. That drift IS the bug: CustomizeAddOnsScreen only matched the local
 * pre-check's typed throw, so a server-side rejection fell through to a generic
 * alert that printed the raw `insufficient_credits` code.
 *
 * These are RN screens / a Zustand store the node `booking` project cannot
 * import, so the rule is pinned by reading the source — same pattern as
 * liveTrackerDockSend.test.ts.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

const CALL_SITES = [
  ['CustomizeAddOnsScreen', join(ROOT, 'src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx')],
  ['AddOnsScreen', join(ROOT, 'src', 'screens', 'booking', 'AddOnsScreen.tsx')],
  ['OpsRoomReviewScreen', join(ROOT, 'src', 'screens', 'ops', 'OpsRoomReviewScreen.tsx')],
  ['bookingStore', join(ROOT, 'src', 'store', 'bookingStore.ts')],
  ['proPaywallFlow', join(ROOT, 'src', 'screens', 'pro', 'proPaywallFlow.ts')],
] as const;

/** CRLF-normalised and comment-stripped — these files are CRLF, and prose
 *  mentioning the code must not satisfy or break a CODE assertion. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('Issue 25 — the insufficient-credits rule has exactly one implementation', () => {
  it.each(CALL_SITES)('%s imports the shared helper', (_label, file) => {
    expect(code(file)).toMatch(/from '(\.\/|@screens\/booking\/)creditErrors';/);
  });

  it.each(CALL_SITES)('%s has no hand-rolled comparison against the raw code', (_label, file) => {
    const src = code(file);
    // Only creditErrors.ts may compare against the literal. A call site that
    // re-implements the check will drift again the moment the server changes shape.
    expect(src).not.toMatch(/[=]==\s*'insufficient_credits'/);
    expect(src).not.toMatch(/includes\('insufficient_credits'\)/);
  });

  it('CustomizeAddOnsScreen routes a short balance to CreditPaywall, not an alert', () => {
    const src = code(join(ROOT, 'src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx'));
    const start = src.indexOf('isInsufficientCreditsError(e)');
    expect(start).toBeGreaterThan(-1);
    // The branch body, up to its `return`.
    const branch = src.slice(start, src.indexOf('return;', start));
    expect(branch).toContain("navigation.navigate('CreditPaywall'");
    expect(branch).not.toContain('Alert.alert');
  });

  it('AddOnsScreen (legacy path) routes a short balance to CreditPaywall too', () => {
    const src = code(join(ROOT, 'src', 'screens', 'booking', 'AddOnsScreen.tsx'));
    const start = src.indexOf('isInsufficientCreditsError(e)');
    expect(start).toBeGreaterThan(-1);
    const branch = src.slice(start, src.indexOf('return;', start));
    expect(branch).toContain("navigation.navigate('CreditPaywall'");
  });

  it('bookingStore re-throws an error that PRESERVES the server code', () => {
    const src = code(join(ROOT, 'src', 'store', 'bookingStore.ts'));
    // The regression: `throw new Error(friendly)` dropped the structured body,
    // so every caller's `code` branch was dead.
    expect(src).not.toMatch(/throw new Error\(friendly\)/);
    expect(src).toMatch(/out\.code\s*=/);
    expect(src).toMatch(/throw out;/);
  });

  it('the server sends a structured body carrying required + balance', () => {
    const src = code(join(ROOT, 'apps', 'auth-service', 'src', 'booking', 'booking.service.ts'));
    const throws = [...src.matchAll(/BadRequestException\(\{[\s\S]*?\}\)/g)]
      .map(m => m[0])
      .filter(m => m.includes('insufficient_credits'));
    expect(throws.length).toBe(2); // requestAuto soft-check + payWithCredits debit
    for (const t of throws) {
      expect(t).toContain('required:');
      expect(t).toContain('balance:');
      // `message` must stay the raw code so already-shipped clients that match
      // on it keep detecting a short balance.
      expect(t).toMatch(/message:\s*'insufficient_credits'/);
    }
  });

  it('no BadRequestException still throws the bare string form', () => {
    const src = code(join(ROOT, 'apps', 'auth-service', 'src', 'booking', 'booking.service.ts'));
    expect(src).not.toMatch(/BadRequestException\('insufficient_credits'\)/);
  });
});
