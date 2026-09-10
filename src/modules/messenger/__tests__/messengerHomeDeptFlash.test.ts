import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * B-193 — opening Messenger flashed EVERY department channel into the list.
 *
 * `deptGroupIds` was `useState(() => new Set())` and only filled after a network
 * round-trip, so for ~one RTT every departmental channel rendered into the
 * Messenger list (and the header count jumped) before vanishing. The fix seeds
 * the state from a MODULE-level memo of the last successful fetch, so re-opening
 * Messenger — the reported path — starts from the correct set.
 *
 * `MessengerHomeScreen.tsx` pulls in React Native and cannot be imported by the
 * node `messenger-crypto` project, so the rule is pinned by a source scan — the
 * same treatment `missionOpsRoomStaticScan.test.ts` gives the sibling rules in
 * this file.
 *
 * Static-scan hygiene (CLAUDE.md): the file is CRLF, so every split is `\r?\n`
 * and every absence assertion runs on COMMENT-STRIPPED source — the fix's own
 * explanatory comment names `new Set()`, which would otherwise make the
 * regression assertion pass for the wrong reason.
 */

const HOME = join(process.cwd(), 'src', 'screens', 'messenger', 'MessengerHomeScreen.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function source(): string {
  return stripComments(readFileSync(HOME, 'utf8'));
}

/** The `deptGroupIds` useState line, CODE only. */
function seedLine(): string {
  const line = source().split(/\r?\n/).find(l => l.includes('const [deptGroupIds'));
  expect(line).toBeDefined();
  return line ?? '';
}

describe('B-193 — department channels must not flash into the Messenger list', () => {
  it('a module-level memo of the last fetched id set exists', () => {
    // Module scope, not component scope — component state dies with the screen,
    // which is precisely why re-opening Messenger flashed every time.
    expect(source()).toMatch(/^let lastDeptGroupIds\b/m);
  });

  it('deptGroupIds is SEEDED from that memo, never from an empty Set', () => {
    const line = seedLine();
    expect(line).toMatch(/lastDeptGroupIds/);
    // The regression: `useState<Set<string>>(() => new Set())` starts empty, so
    // the filter passes every dept channel through until the fetch resolves.
    expect(line).not.toMatch(/new Set\(\)/);
  });

  it('a successful fetch writes back to the memo', () => {
    // Without the write-back the seed is permanently empty and the fix is inert.
    // NAV-18 (2026-08-26) moved the write inside the functional setState so an
    // unchanged id set keeps its identity — the memo now records `chosen`
    // (prev when identical, next when different), which still satisfies B-193:
    // the memo is written on every successful fetch, with an id-equal set.
    expect(source()).toMatch(/lastDeptGroupIds\s*=\s*chosen/);
    // ...and `chosen` must derive from the fetched `next`, not something else.
    expect(source()).toMatch(/sameIdSet\(prev, next\) \? prev : next/);
  });

  it('the conversation list still filters dept channels out', () => {
    // The seed is only half the fix — the filter it feeds must survive. If this
    // goes, dept channels render in Messenger permanently rather than for one RTT.
    expect(source()).toMatch(/!deptGroupIds\.has\(/);
  });
});
