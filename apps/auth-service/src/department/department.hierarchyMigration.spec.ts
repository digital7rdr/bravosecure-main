/**
 * Enterprise Dept Channels scope v2 — Phase 1, the DB half of the hierarchy.
 *
 * No database runs in unit tests, so the guarantees that live in SQL are pinned
 * by reading the migration. That is a real gate — but only as good as its
 * anchors, so every assertion below targets a specific rule, not "the file
 * mentions parent_id".
 *
 * What the SQL — not the service — must guarantee:
 *   1. `level` is DERIVED from the parent, never accepted from a caller.
 *      Otherwise a client could assert level 1 under a level-3 parent and
 *      flatten the tree while passing the depth CHECK.
 *   2. No fifth level (page 1 LOCKED RULES) — enforced by a CHECK, so it holds
 *      for psql and scripts too, not just the API.
 *   3. A parent in ANOTHER org is refused (page 10 rule 2 — tenancy).
 *   4. Deleting a parent cannot silently take its subtree ("Archive is
 *      preferred; permanent deletion is blocked when records require
 *      retention").
 *   5. Existing rows are untouched — they must keep rendering as they do today.
 *   6. Re-parenting is REFUSED while the trigger is per-row: moving a node
 *      re-levels only itself, leaving descendants stale and silently creating a
 *      fifth level.
 *
 * If one of these fails, do NOT delete the assertion — restore the guarantee,
 * or change the rule deliberately and update the plan doc.
 */
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

// jest runs with cwd = apps/auth-service
const MIGRATIONS_DIR = join(process.cwd(), '..', '..', 'supabase', 'migrations');
const THIS_MIGRATION = '20260803010000_dept_channel_hierarchy.sql';
const MIGRATION = join(MIGRATIONS_DIR, THIS_MIGRATION);

/** Normalise CRLF so `\n`-anchored patterns cannot match nothing and pass
 *  vacuously, and drop `--` comments so the prose above the SQL (which quotes
 *  the very rules under test) cannot satisfy an assertion. */
function strip(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .join('\n');
}

function sql(): string {
  return strip(readFileSync(MIGRATION, 'utf8'));
}

/**
 * THE FUNCTION BODY THE DATABASE ACTUALLY RUNS — resolved dynamically.
 *
 * WHY THIS EXISTS. Every trigger assertion below used to read `THIS_MIGRATION`.
 * The moment a later migration legitimately `CREATE OR REPLACE`s the function
 * (which 20260816000000 does, to derive a lateral's level), those assertions
 * keep passing against a body Postgres no longer runs — they do not go RED, they
 * go STALE-GREEN, and nothing tells you. A later edit that dropped the cross-org
 * check from the *new* file would leave every one of them passing. That is this
 * repo's own "security suites had pinned DEAD code" incident, reproduced.
 *
 * So: find every migration that defines the function, take the LAST by filename
 * order (which is apply order), and assert against that. Self-maintaining — the
 * next replacement is covered without touching this file.
 */
const DEFINES_FN = /CREATE\s+OR\s+REPLACE\s+FUNCTION[^;]*dept_channel_set_level/i;

function liveFunctionFile(): string {
  const defining = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .filter(f => DEFINES_FN.test(strip(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))));
  // Guards a vacuous pass: if the regex ever stops matching, every assertion
  // below would run against an empty string and several `not.toMatch` would pass.
  expect(defining.length).toBeGreaterThan(0);
  return defining[defining.length - 1];
}

/** The live body, comment-stripped. */
function liveSql(): string {
  return strip(readFileSync(join(MIGRATIONS_DIR, liveFunctionFile()), 'utf8'));
}

describe('Phase 1 migration — schema', () => {
  it('adds parent_id and level additively (existing rows keep rendering as Main)', () => {
    const s = sql();
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS parent_id UUID/);
    // DEFAULT 1 is what makes this a no-op for every pre-hierarchy channel.
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS level SMALLINT NOT NULL DEFAULT 1/);
  });

  it('blocks a fifth level in the DATABASE, not just the service', () => {
    expect(sql()).toMatch(/CHECK \(level BETWEEN 0 AND 3\)/);
  });

  it('refuses to delete a parent out from under its subtree', () => {
    // ON DELETE CASCADE here would destroy channels (and their message history)
    // that the PDF says must be archived rather than deleted.
    const s = sql();
    expect(s).toMatch(/REFERENCES public\.department_channels\(id\) ON DELETE RESTRICT/);
    expect(s).not.toMatch(/ON DELETE CASCADE/);
  });
});

describe('the trigger is the guarantee — asserted against the LIVE function body', () => {
  it('DERIVES level from the parent rather than trusting the row', () => {
    // The derivation adds 1 for a structural child and 0 for a lateral, in ONE
    // expression, so a caller can never state its own depth either way.
    expect(liveSql()).toMatch(
      /NEW\.level\s*:=\s*parent_level \+ CASE WHEN NEW\.is_lateral THEN 0 ELSE 1 END/);
    // The trigger INSTALL lives in the original migration and is never re-issued.
    expect(sql()).toMatch(/FOR EACH ROW EXECUTE FUNCTION public\.dept_channel_set_level\(\)/);
  });

  it('the derivation is REACHABLE — no early RETURN short-circuits it', () => {
    // Escape this closes: inserting `RETURN NEW;` immediately above the
    // assignment leaves the token present (so a bare toMatch stays green) while
    // making derivation dead code — level becomes whatever the caller sent.
    const s = liveSql();
    const orgCheck = s.indexOf('parent_org <> NEW.org_id');
    const derive = s.indexOf('NEW.level := parent_level + CASE WHEN NEW.is_lateral');
    expect(orgCheck).toBeGreaterThan(-1);
    expect(derive).toBeGreaterThan(orgCheck);
    expect(s.slice(orgCheck, derive)).not.toMatch(/RETURN\s+NEW/);
  });

  // ── item 04: the three rules that stop a lateral defeating the depth CHECK ──

  it('a LATERAL must have a parent', () => {
    // Parentless it takes the root default instead of a derived level, and
    // "lateral to what?" has no answer.
    const s = liveSql();
    const rootBranch = s.indexOf('IF NEW.parent_id IS NULL THEN');
    const raise = s.indexOf("RAISE EXCEPTION 'lateral_channel_needs_parent'");
    expect(rootBranch).toBeGreaterThan(-1);
    // Inside the parentless branch, not floating elsewhere in the body.
    expect(raise).toBeGreaterThan(rootBranch);
  });

  it('a LATERAL must stay a LEAF — the rule the 4-hop walk bound rests on', () => {
    // A chain of laterals would add unbounded REAL depth while `level` never
    // moves: the CHECK becomes decorative and every ancestor walk under-reaches.
    const s = liveSql();
    expect(s).toMatch(/RAISE EXCEPTION 'lateral_channel_cannot_have_children'/);
    // It must read the PARENT's flag, not the row's own.
    expect(s).toMatch(/SELECT level, org_id, is_lateral INTO parent_level, parent_org, parent_lateral/);
    expect(s).toMatch(/IF parent_lateral THEN/);
  });

  it('freezes is_lateral on UPDATE, by COERCION like level (not a raise)', () => {
    // A flip would silently re-level the row with no descendant re-level, and can
    // collide with dept_channels_one_broadcast_per_level. Coerced rather than
    // raised so it matches the level freeze it sits beside — two adjacent rules
    // that disagree about their failure mode is worse than either choice.
    const s = liveSql();
    expect(s).toMatch(/NEW\.is_lateral IS DISTINCT FROM OLD\.is_lateral/);
    expect(s).toMatch(/NEW\.is_lateral := OLD\.is_lateral/);
  });

  it('pins search_path on the replacement', () => {
    // None of the three dept_channel_* functions was covered by
    // 20260603110000_harden_function_search_path.sql; a replacement is the right
    // moment to close that rather than inherit the gap.
    expect(liveSql()).toMatch(/SET search_path = public, pg_temp/);
  });

  it('fires on EVERY update, not just when parent_id is in the SET list', () => {
    // `BEFORE INSERT OR UPDATE OF parent_id` fires only when that column appears
    // in the SET list, so `UPDATE … SET level = 2` slipped past the trigger
    // entirely while still passing the CHECK — a five-level tree with no error.
    const s = sql();
    expect(s).toMatch(/BEFORE INSERT OR UPDATE ON public\.department_channels/);
    expect(s).not.toMatch(/UPDATE OF/);
  });

  it('freezes level on UPDATE so it cannot be set directly', () => {
    const s = liveSql();
    expect(s).toMatch(/NEW\.level IS DISTINCT FROM OLD\.level/);
    expect(s).toMatch(/NEW\.level := OLD\.level/);
  });

  it('bounds a ROOT channel to Enterprise(0) or Main(1)', () => {
    // Without this a parentless row could be inserted at level 3 and then have
    // a derived child hung off it — a fifth level from a bare INSERT.
    const s = liveSql();
    expect(s).toMatch(/RAISE EXCEPTION 'root_channel_level_invalid'/);
  });

  it('refuses to move a CHILD channel between orgs', () => {
    const s = liveSql();
    expect(s).toMatch(/RAISE EXCEPTION 'cannot_move_child_channel_between_orgs'/);
  });

  /**
   * …AND FROM THE OTHER END. The guard originally tested only
   * `NEW.parent_id IS NOT NULL`, which reads symmetric and is not: moving a
   * ROOT that HAS children is silent, because a root's own parent_id is
   * NULL — and its children stay in the old org pointing at a parent that
   * has left it. The same forbidden state, reached from the opposite side.
   *
   * No API path writes org_id, so this was DDL-only. Pinned anyway: a guard
   * that is asymmetric in a way its own name does not admit is worse than no
   * guard, because the next reader trusts it.
   */
  it('refuses to move a ROOT that still HAS children between orgs', () => {
    const s = liveSql();
    const at = s.indexOf('cannot_move_child_channel_between_orgs');
    expect(at).toBeGreaterThan(-1);
    // Sliced back to the IF that raises it, so this cannot pass on some
    // other EXISTS elsewhere in the migration.
    const guard = s.slice(s.lastIndexOf('IF TG_OP', at), at);
    expect(guard).toMatch(/NEW\.parent_id IS NOT NULL/);
    expect(guard).toMatch(/EXISTS \(SELECT 1 FROM public\.department_channels/);
    expect(guard).toMatch(/WHERE parent_id = NEW\.id/);
  });

  it('installs the trigger — DROP comes BEFORE CREATE, not after', () => {
    // Escape this closes: moving the idempotency DROP below the CREATE leaves
    // both statements present (every token assertion still green) while the
    // migration ends with NO trigger installed at all.
    const s = sql();
    const drop = s.indexOf('DROP TRIGGER IF EXISTS dept_channel_set_level_trg');
    const create = s.indexOf('CREATE TRIGGER dept_channel_set_level_trg');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });

  it('refuses a parent in another Enterprise (tenancy)', () => {
    const s = liveSql();
    expect(s).toMatch(/parent_org <> NEW\.org_id/);
    expect(s).toMatch(/RAISE EXCEPTION 'parent_channel_in_other_org'/);
  });

  it('refuses a self-parent and a missing parent', () => {
    const s = liveSql();
    expect(s).toMatch(/RAISE EXCEPTION 'channel_cannot_parent_itself'/);
    expect(s).toMatch(/RAISE EXCEPTION 'parent_channel_not_found'/);
  });

  it('refuses re-parenting while the trigger cannot re-level descendants', () => {
    // The hole this closes: FOR EACH ROW re-levels only the moved node, so a
    // subtree moved down keeps stale child levels — a fifth level with no error.
    // When a move UI is built, this must become a recursive re-level in the same
    // transaction; it must NOT simply be deleted.
    const s = liveSql();
    expect(s).toMatch(/NEW\.parent_id IS DISTINCT FROM OLD\.parent_id/);
    expect(s).toMatch(/RAISE EXCEPTION 'channel_reparenting_not_supported'/);
  });

  it('is idempotent — safe to re-run', () => {
    const s = sql();
    expect(s).toMatch(/CREATE OR REPLACE FUNCTION public\.dept_channel_set_level/);
    expect(s).toMatch(/DROP TRIGGER IF EXISTS dept_channel_set_level_trg/);
    expect(s).toMatch(/CREATE INDEX IF NOT EXISTS dept_channels_parent_idx/);
  });

  it('NO LATER MIGRATION undoes the depth rule', () => {
    // The most important assertion in this file, and the one a single-file scan
    // structurally cannot make. DB state is the UNION of every migration, so a
    // later file containing
    //     DROP TRIGGER dept_channel_set_level_trg;
    //     ALTER TABLE … DROP CONSTRAINT department_channels_level_range;
    // deletes the LOCKED RULE outright while every assertion above stays green
    // — this file is still perfectly intact, it just no longer describes the DB.
    //
    // DROPPING is not the only way to undo it — and an earlier version of this
    // comment actively BLESSED the alternative, saying a future migration "must
    // CREATE OR REPLACE the function". A one-line
    //     CREATE OR REPLACE FUNCTION public.dept_channel_set_level() … RETURN NEW;
    // neuters the derivation, the root bound, the cross-org check and the
    // re-parent block at once, and `ALTER TABLE … DISABLE TRIGGER` does the same
    // without touching the function — both left every assertion here green.
    //
    // So: replacing the function is BANNED by default. If a future phase
    // genuinely needs to (the recursive re-level for a move feature is the
    // expected case), add the migration filename to ALLOWED_REPLACEMENTS below
    // AND re-assert the invariants against the new definition. Making that an
    // explicit, reviewed edit is the whole point.
    /**
     * ⚠️ ADDING A FILENAME HERE IS HALF THE JOB.
     *
     * The other half is re-asserting every invariant against the NEW body — and
     * that is now automatic: `liveSql()` resolves the last migration that defines
     * the function, so every trigger assertion above already runs against
     * whatever is listed here. Do not add a name without checking that those
     * assertions still describe the replacement.
     *
     * 20260816000000 (item 04, lateral channels) changes how `level` is DERIVED
     * — the one reason this comment always named as the expected case.
     */
    const ALLOWED_REPLACEMENTS: string[] = [
      '20260816000000_dept_channel_lateral.sql',
      // B-590 — adds the ONE legal level move (parentless 1→0 promotion) so
      // legacy workspace roots stop costing their trees a visible tier. Its
      // own pins live in the '20260820120000' describe below.
      '20260820120000_promote_legacy_workspace_roots.sql',
    ];
    const later = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql') && f > THIS_MIGRATION);
    for (const f of later) {
      const body = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(l => !l.trim().startsWith('--'))
        .join('\n');
      expect(`${f}:${/DROP\s+TRIGGER[^;]*dept_channel_set_level_trg/i.test(body)}`).toBe(`${f}:false`);
      expect(`${f}:${/DROP\s+CONSTRAINT[^;]*department_channels_level_range/i.test(body)}`).toBe(`${f}:false`);
      expect(`${f}:${/DROP\s+COLUMN[^;]*\blevel\b/i.test(body) && /department_channels/i.test(body)}`).toBe(`${f}:false`);
      expect(`${f}:${/DISABLE\s+TRIGGER[^;]*dept_channel_set_level_trg/i.test(body)}`).toBe(`${f}:false`);
      expect(`${f}:${/DISABLE\s+TRIGGER\s+ALL/i.test(body) && /department_channels/i.test(body)}`).toBe(`${f}:false`);
      if (!ALLOWED_REPLACEMENTS.includes(f)) {
        expect(`${f}:${/CREATE\s+OR\s+REPLACE\s+FUNCTION[^;]*dept_channel_set_level/i.test(body)}`)
          .toBe(`${f}:false`);
      }
    }
  });

  it('the scan is reading a real migration (guards a vacuous pass)', () => {
    // If the file is ever emptied or renamed, readFileSync throws — but a
    // truncated file would let several not.toMatch assertions pass on nothing.
    expect(sql().length).toBeGreaterThan(1500);
  });
});

/**
 * 20260820120000 — legacy root promotion (B-590). The founder's "I can't go
 * further": a pre-hierarchy channel roots at level 1, so its tree tops out one
 * visible tier short of the PDF's four. The migration promotes such roots to 0
 * and re-derives their descendants. These pins guard the two ways that could
 * rot: the trigger allowance growing wider than the one legal move, and the
 * data fix losing its tenant or collision safety.
 */
describe('20260820120000 — legacy workspace root promotion (B-590)', () => {
  const PROMOTE = '20260820120000_promote_legacy_workspace_roots.sql';
  const promoteSql = () => strip(readFileSync(join(MIGRATIONS_DIR, PROMOTE), 'utf8'));

  it('is the live trigger body — liveSql() must resolve to it', () => {
    // Every trigger assertion above already runs against THIS file. If a later
    // migration replaces the function again, this goes red as the reminder to
    // carry the promotion allowance (and these pins) forward.
    expect(liveFunctionFile()).toBe(PROMOTE);
  });

  it('the level-freeze allowance is EXACTLY the parentless 1→0 promotion', () => {
    const s = promoteSql();
    const freeze = s.indexOf('NEW.level IS DISTINCT FROM OLD.level');
    const allowance = s.indexOf('OLD.parent_id IS NULL AND NEW.parent_id IS NULL');
    const fallback = s.indexOf('NEW.level := OLD.level');
    expect(freeze).toBeGreaterThan(-1);
    // The allowance lives INSIDE the freeze branch, and the coercion survives
    // as the fallback for every other case — order proves both.
    expect(allowance).toBeGreaterThan(freeze);
    expect(fallback).toBeGreaterThan(allowance);
    expect(s).toMatch(/OLD\.level = 1 AND NEW\.level = 0/);
    // Never a #broadcast (its level is the one-per-level index key) and never
    // a lateral. OLD.*, not NEW.*: is_broadcast has no freeze, so a NEW-keyed
    // guard could be slipped by `SET is_broadcast = false, level = 0` in one
    // statement.
    expect(s).toMatch(/NOT OLD\.is_broadcast AND NOT OLD\.is_lateral/);
    expect(s).not.toMatch(/NOT NEW\.is_broadcast/);
  });

  it('the data fix is WORKSPACE-tenant-gated and only touches real tree roots', () => {
    const s = promoteSql();
    // Agencies keep level-1 roots: their #broadcast arithmetic keys on the
    // stored level, and root_channel_not_supported_for_agency exists so no
    // agency row is ever level 0.
    expect(s).toMatch(/org_workspaces w WHERE w\.owner_user_id = c\.org_id/);
    expect(s).toMatch(/c\.parent_id IS NULL AND c\.level = 1/);
    expect(s).toMatch(/NOT c\.is_broadcast AND NOT c\.is_lateral/);
    // A flat channel with no children keeps its level-1 "Main" rendering.
    expect(s).toMatch(/EXISTS \(SELECT 1 FROM public\.department_channels k WHERE k\.parent_id = c\.id\)/);
  });

  it('descendants re-derive against the trigger, and a collision rolls back only that org', () => {
    const s = promoteSql();
    // The WHERE mirrors the trigger's own derivation, so the loop converges to
    // exactly what the trigger would compute — never a second copy of the rule
    // with its own opinion.
    expect(s).toMatch(/p\.level \+ \(CASE WHEN c\.is_lateral THEN 0 ELSE 1 END\)/);
    expect(s).toMatch(/WHEN unique_violation THEN/);
    expect(s).toMatch(/re-run after the broadcast purge/);
    // …and ANY other failure is also per-org: one damaged org must never abort
    // every other workspace's promotion. A silent non-convergence would make a
    // re-run skip the org forever, so it must be loud.
    expect(s).toMatch(/WHEN OTHERS THEN/);
    expect(s).toMatch(/did NOT converge/);
  });

  it('does not weaken the depth rule to do it', () => {
    const s = promoteSql();
    expect(s).not.toMatch(/DROP CONSTRAINT/i);
    expect(s).not.toMatch(/DISABLE TRIGGER/i);
    // The CHECK is untouched — the range rule still lives in 20260803010000.
    expect(s).not.toMatch(/department_channels_level_range/);
  });
});
