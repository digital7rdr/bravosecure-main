/**
 * F5 — EVERY EXISTING ORG MUST GET ITS #broadcast.
 *
 * Frame A9: "Create a mandatory non-deletable #broadcast at every hierarchy
 * level." Page 10 rule 1: "#broadcast exists at each level."
 *
 * THE DEFECT. `ensureBroadcastForLevel` has exactly two callers and neither one
 * can fire for an org that already exists:
 *
 *   - `seedOrgWorkspace` early-returns when the org has ANY channel, so the
 *     ensure-call at the bottom of it is unreachable for every org seeded before
 *     Phase 2 shipped;
 *   - `createChannel` only covers channels made from now on.
 *
 * Measured on staging: of ~18 orgs with channels, exactly ONE had a row with
 * is_broadcast = true. The rule reads "every level of every org" and the code
 * satisfied it only going forward — the classic "a rule enforced over a
 * narrower surface than the code actually has".
 *
 * No database runs in unit tests, so the backfill is pinned by reading the
 * migration. Comments are stripped first: this migration's own prose quotes the
 * rules and the column names under test, which is the single most common source
 * of a false green in this repo.
 */
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

// jest runs with cwd = apps/auth-service
const MIGRATIONS_DIR = join(process.cwd(), '..', '..', 'supabase', 'migrations');
const THIS_MIGRATION = '20260805000000_backfill_dept_broadcast_channels.sql';

function stripped(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .join('\n');
}

const sql = (): string => stripped(THIS_MIGRATION);

/**
 * Comment-free SQL with every whitespace run collapsed to one space.
 *
 * WHY THIS EXISTS. The first version of this file asserted things like
 * `toMatch(/'admin'/)` and `toMatch(/'viewer'/)` — token presence ANYWHERE in
 * the migration. Three mutations that break the backfill outright passed it
 * GREEN: inverting the role CASE (every ordinary employee becomes a POSTER in
 * #broadcast, the exact thing F8 forbids), deleting the `owner_seed` CTE (the
 * org account gets no membership row), and neutering the org_members JOIN (the
 * channel is invisible to every employee — the failure this file's own comment
 * says it exists to prevent). CLAUDE.md names this trap: assert the DECISION
 * SITE, not that a token exists somewhere in the file.
 */
const flat = (): string => sql().replace(/\s+/g, ' ').trim();

describe('F5 — the #broadcast backfill migration exists and is real', () => {
  it('is present in supabase/migrations', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));
    expect(files).toContain(THIS_MIGRATION);
  });

  it('the scan is reading actual SQL (guards a vacuous pass)', () => {
    // Every not.toMatch below would pass on an empty file.
    expect(sql().length).toBeGreaterThan(800);
    expect(sql()).toMatch(/INSERT INTO public\.department_channels/);
  });

  it('does NOT edit an existing migration — the two Phase 1/2 files are separate', () => {
    // The rule for this repo is new files only; a backfill written INTO
    // 20260803020000 would silently not re-run on an already-migrated database.
    const post = stripped('20260803020000_dept_channel_post_mode.sql');
    expect(post).not.toMatch(/INSERT INTO public\.department_channels/);
  });
});

describe('F5 — it creates the same row createChannel would', () => {
  it('matches the ensureBroadcastForLevel shape exactly', () => {
    // THE WHOLE PROJECTION, in order, not five independent token searches.
    // ensureBroadcastForLevel writes ($1, '#broadcast', NULL, 'board',
    // 'standard', $1, $2, TRUE) into the same column list; `level` is the one
    // addition, because (org, level) is this statement's unit of work.
    expect(flat()).toContain(
      'INSERT INTO public.department_channels ' +
      '(org_id, name, department, channel_type, access, created_by, parent_id, is_broadcast, level) ' +
      "SELECT p.org_id, '#broadcast', NULL, 'board', 'standard', p.org_id, p.parent_id, TRUE, p.level",
    );
  });

  /**
   * post_mode IS THE TRIGGER'S JOB. `dept_channel_broadcast_mode` pins it to
   * 'announcement' on any is_broadcast row; a migration that also wrote it would
   * be asserting a rule it does not own, and would silently diverge the day that
   * trigger changes. Going THROUGH the trigger is what makes a backfilled row
   * indistinguishable from a service-made one.
   */
  it('never writes post_mode — the broadcast_mode trigger owns it', () => {
    expect(sql()).not.toMatch(/post_mode/);
  });

  it('seeds the ORG ACCOUNT as channel admin (the owner_seed CTE must exist)', () => {
    // A data-modifying CTE runs even though nothing references it, which is the
    // only reason this works — and is also why deleting it is invisible unless
    // the whole statement is named here.
    expect(flat()).toContain(
      'owner_seed AS ( INSERT INTO public.department_channel_members ' +
      "(channel_id, user_id, role, role_label) SELECT i.id, i.org_id, 'admin', NULL " +
      'FROM inserted i ON CONFLICT DO NOTHING RETURNING 1 )',
    );
  });

  it('seeds MEMBERSHIP, or the backfilled channel is invisible to everyone', () => {
    // listChannels JOINs department_channel_members, so a channel with no member
    // rows is fixed in the table and unchanged in the app. The JOIN predicate is
    // pinned WHOLE: a single extra conjunct silently matches nothing, and the
    // migration then "succeeds" while seeding zero employees.
    expect(flat()).toContain(
      'FROM inserted i JOIN public.org_members om ' +
      "ON om.org_user_id = i.org_id AND om.status = 'active' " +
      'WHERE om.member_user_id <> i.org_id',
    );
  });

  it('SEC: a manager is the admin and everyone ELSE is a viewer — never inverted', () => {
    // Inverting this CASE makes every ordinary employee a POSTER in #broadcast,
    // which is precisely what page 10 rule 1 forbids and what F8's
    // assertBroadcastPostingAllowed refuses on the API. A backfill that writes
    // the state the API refuses is the same defect with a different writer.
    expect(flat()).toContain(
      "CASE WHEN om.member_role = 'manager' THEN 'admin' ELSE 'viewer' END",
    );
    // A7.3 — only the tenant-independent 'Manager' is persisted; everyone else
    // gets NULL so each client derives its own live noun.
    expect(flat()).toContain(
      "CASE WHEN om.member_role = 'manager' THEN 'Manager' ELSE NULL END",
    );
  });
});

describe('F5 — per (org, level), idempotent, and index-safe', () => {
  it('targets a LEVEL of an ORG, not a channel — one broadcast per level', () => {
    const s = sql();
    // The unit of work must be the same key the unique index uses.
    expect(s).toMatch(/DISTINCT\s+a\.org_id,\s*a\.level/);
  });

  it('SKIPS any (org, level) that already has a live broadcast (re-runnable)', () => {
    const s = sql();
    expect(s).toMatch(/NOT EXISTS/);
    expect(s).toMatch(/b\.org_id = a\.org_id AND b\.level = a\.level AND b\.is_broadcast/);
  });

  it('only considers ACTIVE channels, matching the partial unique index', () => {
    // dept_channels_one_broadcast_per_level is `WHERE is_broadcast AND
    // archived_at IS NULL`, so an archived broadcast must NOT count as present —
    // otherwise a level whose broadcast was archived stays permanently without
    // one, which is exactly the state this migration exists to end.
    expect(sql()).toMatch(/archived_at IS NULL/);
  });

  it('defers to the unique index rather than racing it', () => {
    expect(sql()).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it('places a level > 1 broadcast under a REAL parent, never a fabricated one', () => {
    const s = sql();
    // A broadcast at level L must hang off a level-(L-1) node in the same org.
    // Reusing the parent an existing level-L channel already has is the only
    // choice guaranteed to satisfy the hierarchy trigger.
    expect(s).toMatch(/a2\.parent_id IS NOT NULL/);
    expect(s).toMatch(/a2\.level\s+= m\.level/);
    // Levels 0 and 1 are roots — parentless by definition.
    expect(s).toMatch(/WHEN m\.level <= 1 THEN NULL/);
    // …and a level that has no resolvable parent is SKIPPED, not forced.
    expect(s).toMatch(/t\.level <= 1 OR t\.parent_id IS NOT NULL/);
  });
});

describe('F5 — the backfill covered the PAST; the FUTURE is clean by design', () => {
  it('no service path auto-creates a broadcast any more (client 2026-08-26)', () => {
    /**
     * FLIPPED. F5 used to pin `ensureBroadcastForLevel` on both creation paths
     * so "the next level created months from now" would get its broadcast. The
     * 2026-08-26 unification ends per-level broadcasts for every tenant — the
     * backfill remains as history (the SQL pins above still read the immutable
     * migration file), but the service must never mint one again.
     */
    const svc = readFileSync(join(process.cwd(), 'src', 'department', 'department.service.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    expect(svc).not.toMatch(/ensureBroadcastForLevel/);
  });
});
