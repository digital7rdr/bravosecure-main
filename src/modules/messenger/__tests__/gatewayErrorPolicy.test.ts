/**
 * sqa.md bug register — this suite pins: B-240, B-241.
 *
 * B-240 and B-241 are the SAME defect, numbered twice by parallel sessions: a raw gateway
 * frame surfaced in the chat UI as a red error banner reading "Error: rate_limited: event
 * typing rate-limited; retry in 32ms". A per-keystroke typing throttle is not actionable by
 * the user, so it is classified SILENT here.
 */
/**
 * B-241 — gateway `error` frames must not red-bar the chat for benign
 * flow-control codes.
 *
 * The founder's screenshot showed a persistent red
 *   "Error: rate_limited: event typing rate-limited; retry in 15ms"
 * banner on ChatScreen. The WS gateway throttles a typing/presence/send burst
 * and emits `{event:'error', data:{code:'rate_limited', …}}` per keystroke; the
 * client's `dispatchFrame` `case 'error'` red-barred every code but 'superseded'
 * and left it stuck. This pins the pure disposition policy (rate_limited →
 * silent) and the productionRuntime wire (a comment-stripped source scan, since
 * that file pulls react-native and can't be imported under the node project).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {gatewayErrorDisposition} from '../runtime/gatewayErrorPolicy';

describe('gatewayErrorDisposition', () => {
  it('SILENT — rate_limited never reaches the user (the B-241 bug)', () => {
    expect(gatewayErrorDisposition('rate_limited')).toBe('silent');
  });

  it('SILENT — superseded (a newer socket took over) stays silent', () => {
    expect(gatewayErrorDisposition('superseded')).toBe('silent');
  });

  it('AUTO-CLEAR — transient call codes show briefly then clear', () => {
    for (const c of ['peer_offline', 'busy', 'declined']) {
      expect(gatewayErrorDisposition(c)).toBe('auto-clear');
    }
  });

  it('PERSISTENT — an unknown / genuinely actionable code still red-bars', () => {
    expect(gatewayErrorDisposition('token_revoked')).toBe('persistent');
    expect(gatewayErrorDisposition('bad_request')).toBe('persistent');
    expect(gatewayErrorDisposition('unauthorized')).toBe('persistent');
    expect(gatewayErrorDisposition('anything_else')).toBe('persistent');
  });
});

describe('B-241 wiring — productionRuntime routes gateway errors through the policy', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'),
    'utf8',
  );
  // CRLF-safe, comment-stripped view for ordering/presence assertions (prose
  // containing a banned token is the classic false result here).
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');

  it('imports the disposition policy', () => {
    // Import lines are structural (a commented-out import fails the build).
    expect(src).toContain("from './gatewayErrorPolicy'");
    expect(src).toContain('gatewayErrorDisposition');
  });

  it('consults the policy in the error handler and can silence a code', () => {
    expect(code).toMatch(/gatewayErrorDisposition\(/);
    expect(code).toMatch(/[=]== 'silent'/);
  });

  it('no longer unconditionally red-bars every non-superseded code (B-241)', () => {
    // The pre-fix handler set the error for EVERY code but superseded, with no
    // silent branch. The fix gates setError behind a non-silent disposition, so
    // the silent early-return must appear BEFORE the setError in the handler.
    const errIdx    = code.indexOf("case 'error'");
    const silentIdx = code.indexOf("'silent'", errIdx);
    const setErrIdx = code.indexOf('setError(`', errIdx);
    expect(errIdx).toBeGreaterThan(-1);
    expect(silentIdx).toBeGreaterThan(-1);
    expect(setErrIdx).toBeGreaterThan(-1);
    expect(silentIdx).toBeLessThan(setErrIdx);
  });
});
