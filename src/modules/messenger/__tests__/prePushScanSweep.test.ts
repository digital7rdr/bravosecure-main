import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, extname} from 'node:path';

/**
 * W7 — the pre-push gate must run the static-scan suites.
 *
 * `jest --changedSince=origin/main` (what `.husky/pre-push` runs) selects a test
 * only when that test TRANSITIVELY IMPORTS the changed file. A scanner reads its
 * target with `readFileSync`, which creates no module-graph edge — so the suites
 * that exist specifically to guard `productionRuntime.ts` are exactly the suites
 * a `productionRuntime.ts`-only diff does NOT select. Measured at W6: such a diff
 * selects 37 suites, and none of the five guards is among them. That is the hole
 * B-106 shipped through.
 *
 * Three alternatives were measured and all fail to create the edge: a shared path
 * constant imported by both files, `require.resolve()`, and `jest.mock()` with a
 * factory. Only a real executed import works, and no test can import
 * `productionRuntime.ts` (it pulls in react-native and dies in the node project —
 * which is the whole reason the scanners read it as text). The module graph
 * therefore cannot express this dependency, so the hook sweeps unconditionally.
 *
 * This file pins the sweep. Without it the hook step is one silent deletion away
 * from restoring the hole, and nothing would fail.
 *
 * See docs/runbooks/MESSAGE_LOOP.md W7.
 */

const HOOK = join(process.cwd(), '.husky', 'pre-push');

/** Every test file that reads source as TEXT — i.e. is invisible to `--changedSince`. */
function scannerSuites(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules') {continue;}
        walk(full);
        continue;
      }
      if (!/\.test\.tsx?$/.test(name)) {continue;}
      if (extname(name) !== '.ts' && extname(name) !== '.tsx') {continue;}
      if (readFileSync(full, 'utf8').includes('readFileSync')) {out.push(full);}
    }
  };
  walk(join(process.cwd(), 'src'));
  return out;
}

describe('W7 — pre-push runs the suites that --changedSince cannot select', () => {
  it('the hook has a static-scan sweep step', () => {
    const hook = readFileSync(HOOK, 'utf8');
    expect(hook).toMatch(/static-scan sweep/i);
    // It must actually SELECT by readFileSync, not hard-code a path list — a
    // list is one more thing that goes stale, and a stale list silently shrinks
    // the sweep back toward the hole it was added to close.
    expect(hook).toMatch(/grep -rl ["']readFileSync["']/);
  });

  it('the sweep cannot degrade into running the whole suite', () => {
    // `jest` with an empty file list runs EVERYTHING. A failed grep would turn a
    // push into a multi-minute full run, and the natural "fix" for that is to
    // delete the step. Guarding the empty case keeps the sweep cheap and honest.
    //
    // W7b (2026-07-27) — the guard changed shape: the sweep outgrew a single
    // Windows command line (80+ scanners > cmd's ~8k arg limit) and now chunks
    // through xargs. The COUNT gate before the pipeline is what keeps the
    // empty case from ever reaching xargs (which, with empty stdin and no -r,
    // would run bare `jest` = the whole suite — the exact degradation this
    // test exists to forbid).
    const hook = readFileSync(HOOK, 'utf8');
    expect(hook).toMatch(/if \[ "\$SCANNER_COUNT" -gt 0 \]/);
    expect(hook).toMatch(/xargs -n \d+ npx jest --silent --passWithNoTests/);
  });

  it('this suite is itself swept (it reads source as text, like the rest)', () => {
    // Self-check: the sweep's selector must match this file, or the pin that
    // protects the sweep is itself outside the sweep.
    expect(scannerSuites().some(f => f.endsWith('prePushScanSweep.test.ts'))).toBe(true);
  });

  it('the guards that pin productionRuntime.ts are all swept', () => {
    // These are the suites a productionRuntime.ts-only diff provably does NOT
    // select. If one stops being a text scanner it must gain a real import edge
    // instead — do not just drop it from this list.
    const swept = scannerSuites().map(f => f.replace(/\\/g, '/'));
    for (const guard of [
      'messageTopologyInvariants.test.ts',
      'receivePersistenceInvariants.test.ts',
      'receivePathParity.test.ts',
      'logAudit.test.ts',
    ]) {
      expect(swept.some(f => f.endsWith(guard))).toBe(true);
    }
  });
});
