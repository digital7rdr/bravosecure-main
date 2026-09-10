/**
 * Channels vs2 items 2 / 6 / 8 — the organisation-grouping rule has exactly ONE
 * implementation.
 *
 * WHY A SOURCE SCAN AND NOT A UNIT TEST.
 *
 * This repo's most-shipped bug shape is one behaviour with N drifted copies —
 * an avatar colour had six. A unit test can only exercise the copy it imports;
 * it is structurally incapable of seeing copy N+1, which is precisely the
 * defect. Three surfaces need this rule (the invite picker now, the member
 * directory and the admin create/manage dashboard in P3), so the pressure to
 * re-derive "which rows are organisations?" locally is real and imminent.
 *
 * The scan therefore bans the FORMULA, not the name: a second site that decides
 * organisation-ness from `parent_hidden` / `visible_ancestor_id` without going
 * through the helper.
 */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

const SCREENS = join(process.cwd(), 'src', 'screens');
const HELPER = join(process.cwd(), 'src', 'screens', 'deptchat', 'organisationTree.ts');

/** Every .ts/.tsx under src/screens, excluding tests and the helper itself. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__') {continue;}
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(entry) && p !== HELPER) {
      out.push(p);
    }
  }
  return out;
}

/**
 * CRLF-normalised, comments stripped LINE-ANCHORED.
 *
 * Both halves matter. A `\n`-anchored regex matches nothing on this repo's CRLF
 * files and an absence scan then passes VACUOUSLY; and prose quoting the banned
 * expression is the commonest false positive.
 *
 * The block-comment strip is deliberately line-anchored (`^\s*\/\*` … `\*\/\s*$`)
 * rather than the greedy `/\/\*[\s\S]*?\*\//g` used elsewhere. This scan walks
 * EVERY file under src/screens, four of which are on the KNOWN_HAZARDS list in
 * `src/__tests__/sourceScanSafety.test.ts` — files where the greedy form eats
 * real code, because a `/*` appears inside a string literal or a line comment.
 * Deleting real code ahead of an ABSENCE assertion is how a scan passes over a
 * violation that is right there in the file.
 */
function strip(path: string): string {
  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (inBlock) {
      if (t.endsWith('*/')) {inBlock = false;}
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.endsWith('*/')) {inBlock = true;}
      continue;
    }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(line);
  }
  return out.join('\n');
}

describe('the grouping rule lives in exactly one module', () => {
  it('no screen decides organisation-ness from the tree fields itself', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(SCREENS)) {
      const src = strip(f);
      // Reading the fields is fine (a row may be passed around); BRANCHING on
      // them is the re-derivation. These are the two shapes a second copy takes.
      if (/if\s*\([^)]*\bparent_hidden\b/.test(src)
        || /\bparent_hidden\b\s*(===|!==|\?)/.test(src)
        || /filter\([^)]*\bvisible_ancestor_id\b/.test(src)) {
        offenders.push(f.replace(process.cwd(), ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the invite picker consumes the helper rather than its own list', () => {
    // The positive half. Banning copies is worthless if the one consumer
    // quietly stopped using the original.
    const src = strip(join(SCREENS, 'deptchat', 'InviteMemberScreen.tsx'));
    expect(src).toMatch(/from '\.\/organisationTree'/);
    for (const sym of ['topLevelOf', 'subtreeOf', 'mintDisabled', 'hasHierarchy']) {
      expect(`${sym}:${new RegExp(`\\b${sym}\\(`).test(src)}`).toBe(`${sym}:true`);
    }
  });

  it('the whole-workspace label is ONE constant, shared with Approvals', () => {
    // Two literals would have an admin pick "Whole workspace (all
    // organisations)" on the invite form and read it back one screen later as
    // "No specific team" — the same grant described two ways, and understated,
    // since with more than one root it really is every organisation.
    const helper = strip(HELPER);
    expect(helper).toMatch(/export const WHOLE_WORKSPACE_LABEL/);
    for (const f of sourceFiles(SCREENS)) {
      const src = strip(f);
      // The literal itself may appear ONLY in the helper.
      expect(`${f.split(/[\\/]/).pop()}:${/Whole workspace \(all organisations\)/.test(src)}`)
        .toBe(`${f.split(/[\\/]/).pop()}:false`);
    }
    // THE POSITIVE HALF, and the reason this test previously could not fail:
    // banning the literal everywhere is satisfied by a screen that renders a
    // DIFFERENT string. Both readers must consume the symbol, and the old
    // wording must be gone from the read-back site.
    for (const screen of ['InviteMemberScreen.tsx', 'ApprovalsScreen.tsx']) {
      const src = strip(join(SCREENS, 'deptchat', screen));
      expect(`${screen}:${/WHOLE_WORKSPACE_LABEL/.test(src)}`).toBe(`${screen}:true`);
      expect(`${screen}:${/'No specific team'/.test(src)}`).toBe(`${screen}:false`);
    }
  });
});
