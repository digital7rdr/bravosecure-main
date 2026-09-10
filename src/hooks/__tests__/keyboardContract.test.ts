/**
 * sqa.md bug register — this suite pins: B-204.
 *
 * B-204 (the composer did not sit flush above the keyboard — device-verified on the
 * founder's Redmi phone in v1.0.132) is a consequence of the app-wide rule this contract
 * scan enforces: the bottom-most element of a surface owns the keyboard inset and pads by
 * bottomPad(gap), which REPLACES the safe-area inset rather than stacking on it. The bans
 * here (KeyboardAvoidingView, keyboardVerticalOffset, Keyboard.addListener outside the rule
 * module, a kbHeight variable, behavior=Platform.OS===ios?padding:undefined) are what keep
 * a hand-rolled formula from reintroducing it.
 */
/**
 * B-184 — the keyboard-inset CONTRACT, enforced by source scan.
 *
 * The unit suite (`useKeyboardLayout.test.tsx`) proves the arithmetic. This
 * suite proves the arithmetic is the ONLY one in the app: no screen may
 * hand-roll keyboard avoidance again, because every previous attempt to fix
 * "the keyboard covers my input" produced a NEW per-screen formula and the
 * formulas disagreed — B-84 fixed 17 screens with three different idioms and
 * the founder still hit blind space on iOS and a cut-off composer on Android.
 *
 * Why a source scan and not a render test: these screens import native modules
 * (op-sqlite, WebRTC, callkeep) that the node Jest project cannot load, so
 * there is no way to mount them. The scan is the gate.
 *
 * Scanning rules this file obeys (CLAUDE.md, learned the hard way):
 *   • Comments are STRIPPED before any absence assertion — prose naming a
 *     banned symbol is the most common false result in this repo.
 *   • Sources are CRLF. Never anchor on a bare \n.
 *
 * If one of these ever needs to change, change it DELIBERATELY with the
 * reason in the diff — do not delete an assertion to make a red run green.
 */
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative, sep} from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const RULE_MODULE = join(SRC, 'hooks', 'useKeyboardLayout.ts');

/** Strip block and line comments so prose can't trip an absence assertion. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Only a `//` that is NOT part of a `://` URL starts a line comment.
    .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === '__mocks__' || entry === 'node_modules') {continue;}
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = walk(SRC).map(path => ({
  path,
  rel: relative(ROOT, path).split(sep).join('/'),
  code: stripComments(readFileSync(path, 'utf8')),
}));

function offenders(pattern: RegExp, allow: string[] = []): string[] {
  return SOURCES.filter(f => !allow.includes(f.rel) && pattern.test(f.code)).map(f => f.rel);
}

describe('B-184 — one keyboard rule, no hand-rolled copies', () => {
  it('the rule module exists and exports the whole surface', () => {
    expect(existsSync(RULE_MODULE)).toBe(true);
    const code = readFileSync(RULE_MODULE, 'utf8');
    for (const symbol of [
      'export function computeKeyboardOverlap',
      'export function useKeyboardOverlap',
      'export function useKeyboardLayout',
      'export function useKeyboardBottomPad',
      'export function useRevealOnKeyboard',
    ]) {
      expect(code).toContain(symbol);
    }
  });

  it('the superseded useKeyboardHeight hook is gone and unreferenced', () => {
    expect(existsSync(join(SRC, 'hooks', 'useKeyboardHeight.ts'))).toBe(false);
    expect(offenders(/useKeyboardHeight/)).toEqual([]);
  });

  it('NOTHING renders a KeyboardAvoidingView', () => {
    // KAV measures frame.y from onLayout (PARENT-relative, so wrong the moment
    // it is nested), inflates padding by keyboardVerticalOffset, leaves ghost
    // space with behavior="height", and is a plain no-op with behavior=undefined.
    expect(offenders(/KeyboardAvoidingView/)).toEqual([]);
  });

  it('NOTHING passes a keyboardVerticalOffset', () => {
    // insets.top + 10 on ChatScreen's KAV was ~69 pt of pure blind space on a
    // notched iPhone: the prop is added to the computed padding one-for-one.
    expect(offenders(/keyboardVerticalOffset/)).toEqual([]);
  });

  it('the rule module is the ONLY keyboard-event subscriber', () => {
    // A second subscriber means a second formula. That is how B-84's fix drifted.
    expect(offenders(/Keyboard\s*\.\s*addListener/, ['src/hooks/useKeyboardLayout.ts'])).toEqual([]);
  });

  it('the rule module subscribes to the keyboard-controller WindowInsets source (K4)', () => {
    // The letter→emoji in-place resize fires NO RN event on Android — only the
    // WindowInsetsAnimation source sees it. If this subscription is removed the
    // emoji keyboard covers the composer again. Load-bearing: without it the
    // arithmetic pin in useKeyboardLayout.test passes vacuously (the source
    // that FIRES the taller height is gone).
    const code = stripComments(readFileSync(RULE_MODULE, 'utf8'));
    expect(code).toMatch(/from 'react-native-keyboard-controller'/);
    expect(code).toMatch(/useKeyboardHandler\s*\(/);
  });

  it('the keyboard-controller onEnd actually FEEDS the overlap (not an empty handler)', () => {
    // Guts-check: useKeyboardHandler({}, []) — no onEnd, no runOnJS, no feed —
    // would leave the whole seam decorative and every arithmetic pin vacuous.
    // Pin the executing chain onEnd → runOnJS(onKeyboardControllerHeight) →
    // applyOverlap(keyboardControllerOverlap(...)).
    const code = stripComments(readFileSync(RULE_MODULE, 'utf8'));
    expect(code).toMatch(/onEnd\s*:/);
    expect(code).toMatch(/runOnJS\s*\(\s*onKeyboardControllerHeight\s*\)/);
    expect(code).toMatch(/applyOverlap\(\s*keyboardControllerOverlap\(/);
  });

  it('keyboard-controller has no SECOND consumer under src/ (single inset source)', () => {
    // Same discipline as the RN listener: a second consumer is a second inset
    // formula. The KeyboardProvider mount lives in App.tsx (repo root, outside
    // this src/ scan) — every screen reads the inset through @hooks/useKeyboardLayout.
    expect(offenders(/react-native-keyboard-controller/, ['src/hooks/useKeyboardLayout.ts'])).toEqual([]);
  });

  it('the old hand-rolled kbHeight variable stays dead', () => {
    expect(offenders(/\bkbHeight\b/)).toEqual([]);
  });

  it('no screen re-adds the platform branch the rule exists to delete', () => {
    // `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` was on 12+
    // screens and did NOTHING on Android, the primary platform.
    expect(offenders(/behavior\s*=\s*\{\s*Platform\.OS\s*===\s*'ios'/)).toEqual([]);
  });
});

describe('B-184 — the surfaces that own a keyboard inset still inherit it', () => {
  // Every file here renders a bottom-anchored input, sheet, composer or form.
  // Dropping the import means that surface went back to hand-rolled padding.
  const INHERITORS = [
    'src/components/KeyboardAvoidingScreen.tsx',
    'src/components/ScreenContainer.tsx',
    'src/screens/agent/AgentLiveTrackerScreen.tsx',
    'src/screens/agent/AgentRegistrationScreen.tsx',
    'src/screens/agent/JobDetailScreen.tsx',
    'src/screens/agent/OrgComplianceScreen.tsx',
    'src/screens/agent/OrgCreateCpoScreen.tsx',
    'src/screens/auth/LoginScreen.tsx',
    'src/screens/auth/ProfileCompletionScreen.tsx',
    'src/screens/booking/CreditPaywallScreen.tsx',
    'src/screens/booking/LocationPickerScreen.tsx',
    'src/screens/cpo/CpoActivationScreen.tsx',
    'src/screens/deptchat/AdminAttendanceScreen.tsx',
    'src/screens/deptchat/DayStatusScreen.tsx',
    'src/screens/deptchat/IncidentDetailScreen.tsx',
    'src/screens/deptchat/MyAttendanceScreen.tsx',
    'src/screens/deptchat/ReportIncidentDetailsScreen.tsx',
    'src/screens/messenger/BackupRestoreScreen.tsx',
    'src/screens/messenger/BackupSetupScreen.tsx',
    'src/screens/messenger/ChatInfoScreen.tsx',
    'src/screens/messenger/ChatScreen.tsx',
    'src/screens/messenger/DepartmentChatScreen.tsx',
    'src/screens/messenger/GroupCallScreen.tsx',
    'src/screens/messenger/NewChatScreen.tsx',
    'src/screens/settings/IndividualProfileScreen.tsx',
    'src/screens/settings/ProfileScreen.tsx',
    'src/screens/vbg/NextOfKinModal.tsx',
    'src/screens/vbg/vbgUi.tsx',
    'src/screens/wallet/CreditsScreen.tsx',
  ];

  it.each(INHERITORS)('%s imports the rule', rel => {
    const file = SOURCES.find(f => f.rel === rel);
    expect(file).toBeDefined();
    expect(file!.code).toMatch(/from '@hooks\/useKeyboardLayout'/);
  });

  it('nothing STACKS the safe-area inset on top of a keyboard pad', () => {
    // bottomPad() already REPLACES insets.bottom while the IME is up. Adding
    // the inset again on the same node is exactly the iOS blind space.
    const stacked: string[] = [];
    for (const file of SOURCES) {
      for (const line of file.code.split(/\r?\n/)) {
        if (/bottomPad\s*\(/.test(line) && /insets\s*\.\s*bottom/.test(line)) {
          stacked.push(`${file.rel}: ${line.trim()}`);
        }
        if (/paddingBottom\s*:\s*[^,}]*keyboardOverlap/.test(line) && /insets\s*\.\s*bottom/.test(line)) {
          stacked.push(`${file.rel}: ${line.trim()}`);
        }
      }
    }
    expect(stacked).toEqual([]);
  });
});

describe('B-184 — the founder-reported chat composer specifically', () => {
  // The exact repro: iOS showed a gap between the composer and the keyboard,
  // Android showed the composer sliced in half. Both came from this one node.
  const chat = readFileSync(join(SRC, 'screens', 'messenger', 'ChatScreen.tsx'), 'utf8');
  const chatCode = stripComments(chat);

  it('the composer pads with bottomPad(8), on EXACTLY ONE node, with no inset stacked', () => {
    // The rule is "the BOTTOM-MOST element of a surface owns the keyboard
    // inset", and which element that is can legitimately change: the composer
    // grew an @-mention picker and an edit banner that sit ABOVE the input bar,
    // so the pad moved from `styles.inputBar` to the column that wraps all
    // three. Pinning the literal `styles.inputBar` line would have forced the
    // pad to stay on a node that is no longer bottom-most — which would leave
    // the picker and the banner covered by the keyboard, i.e. exactly the bug
    // this contract exists to prevent.
    //
    // So the assertion is on the PROPERTY, not the node: one bottomPad(8) in
    // the file, and nothing stacks an inset onto it.
    const lines = chatCode.split(/\r?\n/);
    const pads = lines.filter(l => /paddingBottom\s*:\s*bottomPad\(/.test(l));
    expect(pads).toHaveLength(1);
    expect(pads[0]).toMatch(/bottomPad\(\s*8\s*\)/);
    expect(pads[0]).not.toMatch(/insets\s*\.\s*bottom/);
  });

  it('the padded node is an ANCESTOR of the input bar, not a sibling above it', () => {
    // Cheap structural check: the bottomPad node must open BEFORE the input bar
    // in source order. If someone re-adds a pad below the composer, or moves the
    // input bar out of the padded column, this goes red.
    const padAt = chatCode.search(/paddingBottom\s*:\s*bottomPad\(/);
    const barAt = chatCode.search(/styles\.inputBar/);
    expect(padAt).toBeGreaterThan(-1);
    expect(barAt).toBeGreaterThan(-1);
    expect(padAt).toBeLessThan(barAt);
  });

  it('the chat column no longer wraps the list in a keyboard-avoiding view', () => {
    expect(chatCode).not.toMatch(/KeyboardAvoidingView/);
    expect(chatCode).toMatch(/from '@hooks\/useKeyboardLayout'/);
  });
});
