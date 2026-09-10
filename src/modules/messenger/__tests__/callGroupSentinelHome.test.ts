/**
 * AUDIT-2026-08-13 #9 (M4-lite) — the 'Call' sentinel has ONE home.
 *
 * The ad-hoc call-key carrier's only wire-visible discriminator is the
 * group name; that comparison was re-inlined at 15 sites across 9 files
 * (the duplicate-copy class that produced B-124). The predicate now
 * lives in messagingLogic (isCallGroupName / isCallGroupState /
 * CALL_GROUP_NAME) and this scan keeps every re-inline dead. The true
 * M4 namespace (a dedicated wire field) remains ARCH-GATED — runbook
 * §10.1: host and receiver must agree on the slot, so the wire shape
 * needs owner sign-off. This slice retires the sentinel-duplication
 * class without touching the wire at all.
 */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {isCallGroupName, isCallGroupState, CALL_GROUP_NAME} from '../runtime/messagingLogic';

const MOD_ROOT = join(__dirname, '..');
const SRC_ROOT = join(MOD_ROOT, '..', '..');

function productionFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === '__stubs__' || name === 'node_modules') {continue;}
      productionFiles(p, acc);
    } else if (/\.tsx?$/.test(name)) {
      acc.push(p);
    }
  }
  return acc;
}

const stripComments = (src: string): string =>
  src.split(/\r?\n/)
    .filter(l => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');

describe('AUDIT #9 — the predicate', () => {
  it('classifies exactly the sentinel name', () => {
    expect(CALL_GROUP_NAME).toBe('Call');
    expect(isCallGroupName('Call')).toBe(true);
    expect(isCallGroupName('call')).toBe(false);   // exact-name, matching every historical site
    expect(isCallGroupName(undefined)).toBe(false);
    expect(isCallGroupName(null)).toBe(false);
    expect(isCallGroupName('')).toBe(false);
    // Edge E1 — EXACTNESS is the contract, pinned against the
    // prefix-extension drift specifically: single-homing means one
    // widened predicate (e.g. startsWith) would silently reclassify a
    // real group named "Calls with the team" as a transient key carrier
    // at all 16 sites at once — pruned from groups, skipped from the
    // inbox. One place to fix is one place to break everything.
    expect(isCallGroupName('Calls')).toBe(false);
    expect(isCallGroupName('Call ')).toBe(false);
    expect(isCallGroupName('Call with Bob')).toBe(false);
    expect(isCallGroupState({name: 'Call'})).toBe(true);
    expect(isCallGroupState({name: 'Ops'})).toBe(false);
    expect(isCallGroupState(undefined)).toBe(false);
  });
});

describe('AUDIT #9 — no production file re-inlines the sentinel', () => {
  it('comparisons against and mints of the literal live ONLY in messagingLogic', () => {
    // All three quote spellings (the #19 lesson), for every form that
    // NAMES the literal at a classification site (edge round): direct
    // comparison, object-literal mint, switch-case, array-literal
    // membership, and the string-method family (three of which are
    // SEMANTICALLY different — a silent drift, worse than duplication).
    //
    // The boundary is CHOSEN, not overlooked: `const CALL = 'Call'` then
    // compare, `{name}` shorthand, and object-key lookups launder the
    // literal through a binding a scan cannot follow without a
    // type-checker — and banning the bare string across src/ would
    // false-positive every UI label. Hoisting to dodge a known rule is
    // a review problem, not a scan problem.
    // `=== CALL_GROUP_NAME` inline also evades by design (critic N3): it
    // cannot drift in VALUE, but it re-inlines the null-handling SHAPE —
    // prefer the predicate; a scan cannot police that half.
    const FORMS = [
      /[!=]==?\s*["'`]Call["'`]/,
      /["'`]Call["'`]\s*[!=]==?/,
      /name\s*:\s*["'`]Call["'`]/,                                  // N3: tolerate space-before-colon on the MINT
      /case\s+["'`]Call["'`]/,
      /\[\s*["'`]Call["'`]\s*[\],]/,
      /\.(startsWith|endsWith|includes|localeCompare)\(\s*["'`]Call["'`]/,
      /Object\.is\([^,)]*,\s*["'`]Call["'`]/,                        // N3
      /\/\^?Call\$?\//,                                              // N3: the regex-literal family (unanchored = FORM-6 drift)
    ];
    const offenders: string[] = [];
    for (const f of productionFiles(SRC_ROOT)) {
      if (f.endsWith('messagingLogic.ts')) {continue;}
      const code = stripComments(readFileSync(f, 'utf8'));
      if (FORMS.some(r => r.test(code))) {offenders.push(f);}
    }
    expect(offenders).toEqual([]);
  });

  it('messagingLogic stays a LEAF (edge E2 — the sync-availability precondition of every importer)', () => {
    // #9 added three importers (store, webrtc, backup). Under Metro a
    // require cycle yields a partially-initialised module: the predicate
    // could be undefined at store-init call time depending on bundle
    // reach order. The prose invariant becomes a pin: imports are
    // allowlisted, and anything new must justify itself here.
    //
    // DELIBERATELY strict about `import type` too (critic N5): Babel
    // erases type-only imports so they cannot cycle — but this regex
    // cannot tell `import type {X}` from `import {X}`-where-X-is-a-type,
    // and special-casing the one spelling it CAN see teaches "type
    // imports are free here" while the fragile spelling stays unguarded.
    // A red here is resolved by editing one array; a hole is a silent
    // partial-init. If you hit this with a type-only import, that is
    // this comment working, not a regex bug.
    const src = readFileSync(join(MOD_ROOT, 'runtime', 'messagingLogic.ts'), 'utf8');
    const imports = [...src.matchAll(/^import .*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]).sort();
    expect(imports).toEqual(['../conversationIds', '@noble/hashes/sha2.js']);
  });

  it('the mint site builds from the ONE constant (the builder/predicate cannot drift apart)', () => {
    // N6 — scoped to the makeNewGroup window, whitespace-tolerant (the
    // old whole-file toContain with hard-coded alignment broke on a
    // prettier pass and stayed green if the mint moved).
    // productionRuntime has MULTIPLE makeNewGroup call sites (real-group
    // creation passes a caller-supplied name); exactly one is the Call
    // mint and it must build from the constant.
    const src = stripComments(readFileSync(join(MOD_ROOT, 'runtime', 'productionRuntime.ts'), 'utf8'));
    const windows = [...src.matchAll(/makeNewGroup\(\{/g)].map(m => src.slice(m.index!, m.index! + 400));
    expect(windows.length).toBeGreaterThan(0);
    const mintWindows = windows.filter(w => /name\s*:\s*CALL_GROUP_NAME\b/.test(w));
    expect(mintWindows).toHaveLength(1);
  });
});
