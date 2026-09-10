import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Module-wide safe-area contract for `src/screens/messenger/**`.
 *
 * The sweep this pins fixed a class, not a screen: the module had grown two
 * conventions for the same problem. `ChatScreen`'s sheets added
 * `insets.bottom`; the identical sheets in `CallScreen`, `GroupCallScreen`,
 * `VaultScreen` and `DepartmentChatScreen` used a fixed pad, so on a gesture-nav
 * device their last row sat under the home indicator — where the touch target
 * also competes with the system back-swipe. `FloatingCallOverlay` hard-coded
 * `paddingTop: 44` (an iPhone-notch constant) for the status bar, and
 * `FileVaultPurchaseScreen` — registered `headerShown: false` — had no
 * safe-area handling at all, so the "‹ Back" control B-98b added to keep the
 * paywall escapable rendered under the status bar.
 *
 * A test is the only thing that keeps a class dead. Each rule below is written
 * to be mechanical, so a NEW screen inherits it without anyone remembering.
 *
 * TRAP: line endings. On a CRLF checkout a bare `\n` anchor matches nothing and
 * these scans pass VACUOUSLY, so `read()` normalizes CRLF away.
 */

const SCREENS = join(process.cwd(), 'src', 'screens', 'messenger');

function files(): string[] {
  return readdirSync(SCREENS).filter(f => f.endsWith('.tsx'));
}

// Why: the sweep must read identically on a CRLF and an LF checkout.
function normalizeEol(src: string): string {
  return src.replace(/\r\n/g, '\n');
}

function read(f: string): string {
  return normalizeEol(readFileSync(join(SCREENS, f), 'utf8'));
}

/**
 * Comment-stripped source — prose is the most common false result here.
 *
 * LINE comments are stripped FIRST, and the order is load-bearing. Doing the
 * block pass first meant a line comment that merely MENTIONS a path with a
 * wildcard — `// /auth/vault-reset/* route exists today`, real, in
 * VaultOTPVerifyScreen — opened a block comment that swallowed the next 130
 * lines of real code, and the screen was reported as missing an inset it
 * plainly had. A stripper that eats source is worse than no stripper: it
 * fails in the direction of false ALARMS here, but the same bug in an absence
 * assertion would fail silently green.
 */
function code(f: string): string {
  return read(f)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('line endings cannot make these scans pass vacuously', () => {
  it('CRLF is normalized away, so a bare \\n anchor matches on either checkout', () => {
    expect(normalizeEol('a\r\nb')).toBe('a\nb');
    expect(files().every(f => !read(f).includes('\r'))).toBe(true);
  });
});

describe('no hard-coded safe-area constants', () => {
  it('no screen pads for a notch or a home indicator with a magic number', () => {
    // 44 / 34 / 47 / 59 are the iPhone notch + home-indicator constants that
    // get pasted in. They are wrong on every Android status bar and wrong on
    // the next iPhone. FloatingCallOverlay shipped with `paddingTop: 44`.
    const offenders: string[] = [];
    for (const f of files()) {
      const c = code(f);
      for (const m of c.matchAll(/padding(?:Top|Bottom):\s*(\d+)/g)) {
        if (['34', '44', '47', '59'].includes(m[1])) {offenders.push(`${f}: ${m[0]}`);}
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('every bottom sheet clears the gesture area', () => {
  /**
   * A style name ending in "Sheet" (or exactly `sheet`) that declares a
   * paddingBottom is a bottom-anchored surface. Its LAST row is the one that
   * lands on the gesture pill, so the pad must be inset-aware — either at the
   * style or, more commonly here, composed at the call site.
   */
  it('no sheet style relies on a fixed paddingBottom alone', () => {
    const offenders: string[] = [];
    for (const f of files()) {
      const c = code(f);
      // Find `<name>Sheet: {...}` / `sheet: {...}` blocks that set paddingBottom.
      for (const m of c.matchAll(/(\w*[Ss]heet):\s*\{([^}]*)\}/g)) {
        const [, name, body] = m;
        if (!/paddingBottom:\s*\d+/.test(body)) {continue;}
        // Acceptable when every render site composes an inset onto it.
        const rendered = new RegExp(`styles?\\.${name}\\b|\\bs\\.${name}\\b`, 'g');
        const sites = [...c.matchAll(rendered)];
        const guarded = sites.every(site => {
          const window = c.slice(site.index ?? 0, (site.index ?? 0) + 220);
          // All three are inset-aware and all three come from the ONE rule:
          //   insets.bottom — a sheet outside any keyboard-lifted container;
          //   bottomPad(g)  — a sheet that OWNS the keyboard inset itself;
          //   safeBottom    — a sheet INSIDE an already-lifted container, where
          //                   it is 0 while the IME is up so the two never
          //                   stack (GroupCallScreen's in-call chat).
          return /insets\.bottom|bottomPad\(|safeBottom/.test(window);
        });
        if (sites.length > 0 && !guarded) {offenders.push(`${f}:${name}`);}
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * B-460 — the magic-constant rule above cannot see a MISSING composition.
 *
 * `FloatingCallOverlay` has two render sites for `styles.audioBar`. The 1:1 one
 * got `paddingTop: insets.top + 8` in the sweep that killed the hard-coded 44;
 * the GROUP one was missed entirely — the component never called
 * `useSafeAreaInsets`. No constant, no offender, and a bar rendering at top:0
 * inside the status-bar strip, where SystemUI eats the touches: on a tall-cutout
 * device the entire bar (tap area AND hangup) is untappable.
 *
 * The mechanical rule: a style pinned to the top edge (`position:'absolute'` +
 * `top:0`) is under the status bar by construction, so EVERY render site of it
 * must compose a top inset. Scoped to this file — repo-wide it would drag in
 * legitimate full-bleed backdrops that deliberately paint behind the bar.
 */
describe('a top-pinned overlay bar composes its inset at EVERY render site', () => {
  const OVERLAY = 'FloatingCallOverlay.tsx';

  it('CONTROL: the scan finds a real top-pinned style in that file', () => {
    const c = code(OVERLAY);
    expect(c.length).toBeGreaterThan(2000);
    expect([...c.matchAll(/(\w+):\s*\{([^}]*)\}/g)]
      .some(([, , body]) => /position:\s*'absolute'/.test(body) && /\btop:\s*0\b/.test(body)))
      .toBe(true);
  });

  it('no render site of a top-pinned style is missing insets.top', () => {
    const c = code(OVERLAY);
    const offenders: string[] = [];
    for (const [, name, body] of c.matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
      if (!/position:\s*'absolute'/.test(body)) {continue;}
      if (!/\btop:\s*0\b/.test(body)) {continue;}
      // Already inset-aware in the style itself — nothing to compose.
      if (/insets\.top/.test(body)) {continue;}
      for (const site of c.matchAll(new RegExp(`styles\\.${name}\\b`, 'g'))) {
        const at = site.index ?? 0;
        // The composition sits in the same style array as the reference, so a
        // tight window is correct: a wide one would let a NEIGHBOURING site's
        // inset vouch for this one, which is exactly the bug being pinned.
        const window = c.slice(at - 60, at + 120);
        if (!/insets\.top/.test(window)) {offenders.push(`${OVERLAY}:${name}`);}
      }
    }
    expect(offenders).toEqual([]);
  });

  it('and the group bar in particular reads the inset it never used to', () => {
    // Named explicitly: the generic rule above is only as good as its regex,
    // and this is the site that shipped broken.
    const c = code(OVERLAY);
    const group = c.slice(c.indexOf('function GroupOverlay'));
    expect(group).toContain('const insets = useSafeAreaInsets();');
    expect(group).toMatch(/<View style=\{\[styles\.audioBar, \{paddingTop: insets\.top \+ 8\}\]\}/);
  });
});

describe('every headerless screen owns its top inset', () => {
  it('a screen that renders its own back control also reads insets.top', () => {
    // `headerShown: false` means nothing draws the status-bar gap for you.
    // FileVaultPurchaseScreen rendered its "Go back" row straight under the
    // clock because it never called useSafeAreaInsets at all.
    const offenders: string[] = [];
    for (const f of files()) {
      const c = code(f);
      if (!/accessibilityLabel="Go back"|styles\.backBtn|styles\.backRow/.test(c)) {continue;}
      if (!/insets\.top/.test(c)) {offenders.push(f);}
    }
    expect(offenders).toEqual([]);
  });
});

describe('every screen that reads a top inset also handles the bottom', () => {
  it('no screen applies insets.top and then ignores insets.bottom', () => {
    // An asymmetric screen is the tell: someone thought about the notch and not
    // about the gesture bar. Screens whose content is vertically CENTERED are
    // exempt — nothing of theirs reaches the bottom edge.
    const offenders: string[] = [];
    for (const f of files()) {
      const c = code(f);
      if (!/insets\.top/.test(c)) {continue;}
      if (/insets\.bottom|bottomPad\(/.test(c)) {continue;}
      // Centered layouts never collide with the gesture area.
      if (/justifyContent:\s*'center'/.test(c)) {continue;}
      offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the keyboard rule is not re-implemented anywhere in the module', () => {
  it('no messenger screen hand-rolls keyboard avoidance', () => {
    // Repo-wide this is enforced by keyboardContract.test.ts; keeping a local
    // copy means a regression is attributed to this module rather than to a
    // list of 200 files.
    const offenders: string[] = [];
    for (const f of files()) {
      const c = code(f);
      if (/KeyboardAvoidingView|keyboardVerticalOffset|\bkbHeight\b/.test(c)) {offenders.push(f);}
    }
    expect(offenders).toEqual([]);
  });

  it('every screen with a bottom-anchored composer uses bottomPad, not a raw inset', () => {
    // `bottomPad` REPLACES insets.bottom while the IME is up. Adding the two is
    // the iOS "blind space"; using the raw inset alone under-lifts on Android
    // API >= 30 edge-to-edge. Both are B-184.
    for (const f of ['ChatScreen.tsx', 'DepartmentChatScreen.tsx']) {
      const c = code(f);
      expect(c).toMatch(/paddingBottom:\s*bottomPad\(/);
      // ...and never `bottomPad(x) + insets.bottom`, which double-counts.
      expect(c).not.toMatch(/bottomPad\([^)]*\)\s*\+\s*insets\.bottom/);
    }
  });
});
