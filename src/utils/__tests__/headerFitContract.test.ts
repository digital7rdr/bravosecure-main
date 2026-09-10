/**
 * B-657 — app-wide header-fit contract.
 *
 * Founder, 2026-08-24 (screenshot): the Secure home header rendered
 * "SECURE SE…". The row was ~39 dp overfull and the title was the only child
 * that could shrink, so it absorbed the whole overflow.
 *
 * Two classes came out of the sweep, and this file pins both.
 *
 * ── 1. letterSpacing must not be rounded ────────────────────────────────
 * `scaleTextStyles` ran `letterSpacing` through `scaleFont`, which ends in
 * `Math.round`. Tracking is normally sub-1 dp, so rounding it broke the type in
 * both directions AND made it device-dependent:
 *
 *     designed   360dp   393dp
 *       0.4   ->    0       0     tracking silently DELETED
 *       1.5   ->    1       2     +33%, and different per device
 *
 * On the founder's phone that added 7.5 dp to the title that the design never
 * asked for. 177 files use `scaleTextStyles`, so this one key is an app-wide
 * width regression.
 *
 * ── 2. `flex: 1` without `minWidth: 0` is INERT ─────────────────────────
 * A flex child defaults to `min-width: auto`, which floors it at its CONTENT
 * width — so the `flex` cannot shrink it and the row overflows anyway. This is
 * documented at length in `screens/messenger/__tests__/messengerHeaderFit.test.ts`
 * for the messenger header; the same pair is needed in every shared header.
 *
 * ⚠️ SOURCE SCAN. RN's test renderer runs no Yoga pass — there is no measured
 * width and nothing that can observe a clip, which is exactly why these ship.
 * ⚠️ These files are CRLF: normalise to `\n`, never anchor a regex on a bare
 * `\n`, or the scan passes VACUOUSLY.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const read = (...p: string[]): string =>
  readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');

/** Comment-stripped — the docblocks above quote the very tokens under test. */
function code(...p: string[]): string {
  return read(...p)
    .split('\n')
    .filter(l => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('B-657 — tracking is a typographic constant, not a responsive size', () => {
  it('scaleTextStyles does NOT scale letterSpacing', () => {
    const src = code('src', 'utils', 'scaling.ts');
    expect(src).toMatch(/const TEXT_KEYS = \['fontSize', 'lineHeight'\] as const/);
    // The regression, verbatim. Re-adding it silently widens every
    // letter-spaced label in the app by a device-dependent amount.
    expect(src).not.toMatch(/TEXT_KEYS = \[[^\]]*'letterSpacing'/);
  });

  it('CONTROL: fontSize and lineHeight are still scaled', () => {
    // Guards against "fixing" this by gutting scaleTextStyles entirely.
    const src = code('src', 'utils', 'scaling.ts');
    expect(src).toMatch(/'fontSize'/);
    expect(src).toMatch(/'lineHeight'/);
    expect(src).toMatch(/next\[key\] = scaleFont\(v\)/);
  });
});

describe('B-657 — shared headers can actually shrink', () => {
  /**
   * `ObHeader` in `deptchat/_obsidian.tsx` is rendered by ~27 screens, so this
   * single pair is the highest-leverage instance in the app.
   */
  it('ObHeader title pairs flex:1 with minWidth:0', () => {
    const src = code('src', 'screens', 'deptchat', '_obsidian.tsx');
    expect(src).toMatch(/headerTitle: \{\s*flex: 1, minWidth: 0,/);
    expect(src).toMatch(/<Text style=\{k\.headerTitle\} numberOfLines=\{1\}>/);
  });

  it('the two headers that CLIPPED on device now yield correctly', () => {
    // AgentHome: a long operator name pushed the LIVE pill + bell off-screen.
    const agent = code('src', 'screens', 'agent', 'AgentHomeScreen.tsx');
    expect(agent).toMatch(/headerLeft: \{[^}]*flex: 1, minWidth: 0\}/);
    expect(agent).toMatch(/headerNameCol: \{flex: 1, minWidth: 0\}/);
    expect(agent).toMatch(/headerRight: \{[^}]*flexShrink: 0\}/);
    expect(agent).toMatch(/<Text style=\{styles\.name\} numberOfLines=\{1\}>/);

    // OpsDashboard: same shape, same defect.
    const ops = code('src', 'screens', 'ops', 'OpsDashboardScreen.tsx');
    expect(ops).toMatch(/agentRow: \{[^}]*flex: 1, minWidth: 0\}/);
    expect(ops).toMatch(/agentNameCol: \{flex: 1, minWidth: 0\}/);
    expect(ops).toMatch(/headerActions: \{[^}]*flexShrink: 0\}/);
  });

  it('the Secure home title sizes from the MEASURED window, not adjustsFontSizeToFit', () => {
    /**
     * ⚠️ REVERSED from B-657, which asserted `adjustsFontSizeToFit` was
     * present. Research on the follow-up report ("still cuts on Pixel 7, not
     * on 6a") found that safety net does not exist on this stack:
     *
     *   • `minimumFontScale` is IGNORED under the New Architecture, on BOTH
     *     platforms — facebook/react-native#50248, still open. So the 0.85
     *     floor never applied and the text could shrink past legible.
     *   • `adjustsFontSizeToFit` has a long Android/Fabric history of not
     *     resizing, of rendering NOTHING (#43104, #44075), and of collapsing
     *     to the minimum on some Samsung builds (#32258).
     *
     * `android/gradle.properties` has `newArchEnabled=true`, so this app is in
     * that path — which is exactly how one build clips on one device and not
     * another. The replacement is a deterministic width band, identical on
     * both platforms and immune to both bugs.
     *
     * `maxFontSizeMultiplier` STAYS: it genuinely works, and it is load-bearing
     * because `utils/textDefaults.ts` is inert (see the sibling test).
     */
    const src = code('src', 'screens', 'booking', 'BookingHomeScreen.tsx');
    expect(src).toMatch(/const \{width: winW\} = useWindowDimensions\(\)/);
    expect(src).toMatch(/const headerTitleSize = winW >= 430/);
    expect(src).toMatch(/style=\{\[styles\.headerTitle, \{fontSize: headerTitleSize\}\]\}/);
    expect(src).toMatch(/maxFontSizeMultiplier=\{1\.2\}/);
    // The unreliable pair must NOT come back on this title.
    expect(src).not.toMatch(/adjustsFontSizeToFit/);
    expect(src).not.toMatch(/minimumFontScale/);
    // The original overfull values, verbatim — 16/1.5 was ~171dp for 15 chars.
    expect(src).not.toMatch(/headerTitle: \{[^}]*fontSize: 16, letterSpacing: 1\.5/);
  });

  it('the widest competing chrome can yield instead of pushing the title', () => {
    /**
     * The title is not the only thing in that row. The tier badge's worst case
     * is "PRO · FAMILY" — roughly 3x the width of "LITE" — which is the most
     * likely reason the same build clipped for one tester and not another: the
     * ACCOUNT TIER, not the device. And the region chip drops its text below
     * 390dp, where the flag alone still carries the meaning and the
     * accessibilityLabel still names the region in full.
     */
    const src = code('src', 'screens', 'booking', 'BookingHomeScreen.tsx');
    expect(src).toMatch(/const compactRegion = winW < 390/);
    expect(src).toMatch(/\{!compactRegion && \(/);
    expect(src).toMatch(/styles\.proBadgeText\} numberOfLines=\{1\}/);
  });

  it('the D-family micro-label shrinks via FitLine, not the broken native pair', () => {
    /**
     * `headerSub` (mono 9.5 / tracking 1.6) is COPIED into 23 screens. The
     * first fix gave every copy `adjustsFontSizeToFit`+`minimumFontScale` —
     * and that pair is exactly why the founder's second device still cut
     * (2026-08-26): under Fabric `minimumFontScale` is IGNORED (#50248) and
     * `adjustsFontSizeToFit` collapses or no-ops per device (#32258, #43104).
     * Every copy now renders through FitLine, which measures with a twin and
     * scales deterministically.
     */
    for (const p of [
      ['src', 'screens', 'executive', 'ExecScheduleScreen.tsx'],
      ['src', 'screens', 'executive', 'ExecTaskScreen.tsx'],
      ['src', 'screens', 'securepro', 'SecureServicesScreen.tsx'],
      ['src', 'screens', 'securepro', 'SecureProIntroScreen.tsx'],
    ]) {
      const src = code(...p);
      expect(src).toContain('<FitLine style={s.headerSub}');
    }
  });

  it('2026-08-26 — the broken native pair is BANNED app-wide', () => {
    /**
     * `adjustsFontSizeToFit` / `minimumFontScale` are device-NONdeterministic
     * under the New Architecture (see FitLine's docblock for the RN issues).
     * Every former use now goes through FitLine. A new use anywhere in src is
     * this class regressing — comment-stripped, so prose (like this) cannot
     * trip it.
     */
    const {readdirSync, statSync} = require('node:fs');
    const {join: j} = require('node:path');
    const root = j(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = j(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') {walk(full);}
          continue;
        }
        if (!name.endsWith('.tsx') && !name.endsWith('.ts')) {continue;}
        const stripped = require('node:fs').readFileSync(full, 'utf8')
          .replace(/\r\n/g, '\n')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n').filter((l: string) => !l.trim().startsWith('//')).join('\n');
        if (/adjustsFontSizeToFit|minimumFontScale/.test(stripped)) {offenders.push(full);}
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
