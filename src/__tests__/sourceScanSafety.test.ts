/**
 * THE SOURCE-SCAN STRIPPER EATS REAL CODE — 10 files, up to 241 lines each.
 *
 * Found 2026-08-05 while pinning the department post-mode rule: an assertion
 * that targeted a line plainly present in `DepartmentChatScreen.tsx` failed,
 * because the scan never saw that line.
 *
 * ── THE MECHANISM ────────────────────────────────────────────────────────────
 *
 * ~138 test files in this repo strip comments with the house-style
 *
 *     .replace(/\/\*[\s\S]*?\*\//g, '')
 *
 * before asserting. CLAUDE.md mandates the stripping, and it is right to: prose
 * containing the banned word is this repo's most common false pass.
 *
 * But that regex believes ANY `/*`, including one that is not a comment opener
 * at all. Two real sources in this codebase:
 *
 *   1. a MIME wildcard in a string — `getDocumentAsync({type: '*' + '/*'})`;
 *   2. a URL glob inside a `//` LINE comment — `/push/*`, `/auth/vault-reset/*`.
 *      The block-comment strip runs BEFORE the `//` filter, so a line comment
 *      can open a block comment. That one is genuinely hard to see.
 *
 * Either way the "comment" runs to the next `*` + `/` anywhere below and the
 * stripper deletes every line in between.
 *
 * ── WHY IT MATTERS MORE THAN IT LOOKS ────────────────────────────────────────
 *
 * A PRESENCE assertion over a swallowed span fails loudly, so you find it. An
 * ABSENCE assertion — `expect(SRC).not.toMatch(/bannedThing/)` — passes
 * SILENTLY while the banned code sits right there in the file. Absence
 * assertions are exactly what this repo uses to pin its "never do X again"
 * rules, and several of them scan files on the list below.
 *
 * ── WHAT THIS TEST DOES ──────────────────────────────────────────────────────
 *
 * It does not try to fix 138 test files. It stops the blast radius GROWING:
 * a new file that starts swallowing code fails here, named, with the opener
 * quoted. The allowlist is the debt as measured today. Shrink it, never extend
 * it — and when you touch a scan over one of these files, use the line-anchored
 * stripper below instead.
 *
 *     .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
 *
 * Every JSDoc/banner block in this repo starts its own line; a MIME type in a
 * string or a glob in a line comment never does.
 */
import {execSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

/**
 * Files where a non-comment `/*` already swallows 3+ lines of real code.
 * Measured 2026-08-05. Each entry is debt, not permission.
 *
 * JSX comments (`{/* … *​/}`) are excluded by the detector, not allowlisted —
 * they are genuine comments and removing them is correct.
 */
const KNOWN_HAZARDS = new Set([
  'src/services/api.ts',
  // VaultOTPVerifyScreen.tsx left this list 2026-08-29 — the B-696 rebuild
  // removed its vault-reset-wildcard-in-a-line-comment hazard.
  'src/screens/messenger/DepartmentChatScreen.tsx',
  'src/screens/messenger/ChatScreen.tsx',
  'src/modules/messenger/webrtc/useGroupCall.ts',
  'src/screens/messenger/VaultScreen.tsx',
  'src/modules/messenger/push/fcmBootstrap.ts',
  'apps/messenger-service/src/backup/backup.service.ts',
  'apps/auth-service/src/config/configuration.ts',
  'apps/ops-console/src/middleware.ts',
]);

function sourceFiles(): string[] {
  const tracked = execSync('git ls-files', {encoding: 'utf8'});
  const untracked = execSync('git ls-files --others --exclude-standard', {encoding: 'utf8'});
  return [...tracked.split('\n'), ...untracked.split('\n')]
    .map(f => f.trim())
    .filter(Boolean)
    .filter(f => /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f))
    .filter(f => /^(src|apps|packages)\//.test(f));
}

/** Spans the house stripper deletes that are NOT actually comments. */
function swallowedCodeLines(text: string): Array<{opener: string; lines: number}> {
  const out: Array<{opener: string; lines: number}> = [];
  for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
    const span = m[0];
    if (!span.includes('\n')) {continue;}                    // inline: harmless
    const lineStart = text.lastIndexOf('\n', m.index ?? 0) + 1;
    const before = text.slice(lineStart, m.index);
    if (/^[ \t]*$/.test(before)) {continue;}                 // a real block comment
    if (/\{\s*$/.test(before)) {continue;}                   // a JSX {/* … */} comment
    const codeLines = span.split(/\r?\n/).filter(l => {
      const s = l.trim();
      return !!s && !s.startsWith('*') && !s.startsWith('//')
        && /[;{}()=]/.test(s) && /[a-zA-Z_$]/.test(s);
    });
    if (codeLines.length >= 3) {out.push({opener: before.trim().slice(-48), lines: codeLines.length});}
  }
  return out;
}

describe('source scans must not silently delete the code they assert on', () => {
  it('no NEW file swallows real code under the house-style stripper', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      let text: string;
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      if (!text.includes('/*')) {continue;}
      const hits = swallowedCodeLines(text);
      if (hits.length === 0) {continue;}
      const key = f.replace(/\\/g, '/');
      if (KNOWN_HAZARDS.has(key)) {continue;}
      const worst = hits.sort((a, b) => b.lines - a.lines)[0];
      offenders.push(`${key} — ${worst.lines} code lines eaten, opened by ${JSON.stringify(worst.opener)}`);
    }
    // A new entry here means any source scan over that file may now be VACUOUS —
    // most dangerously its `not.toMatch` assertions, which report "clean" for
    // code that is present. Fix the file (rename the literal, split the glob) or
    // switch that scan to the line-anchored stripper documented above.
    expect(offenders).toEqual([]);
  });

  it('the allowlist is debt that shrinks — every entry must still be real', () => {
    // A stale entry hides a file that has since been fixed, and makes the guard
    // look like it covers more than it does.
    const stillHazardous = [...KNOWN_HAZARDS].filter(f => {
      try { return swallowedCodeLines(readFileSync(f, 'utf8')).length > 0; }
      catch { return false; }
    });
    expect(stillHazardous.sort()).toEqual([...KNOWN_HAZARDS].sort());
  });
});
