/**
 * Channels vs2 item 2 — the tree fields, against a REAL Postgres.
 *
 * WHY THIS FILE EXISTS.
 *
 * `src/department/channelTreeFields.spec.ts` mocks the DB, so every assertion
 * there is a claim about the SQL *text*: that a column is projected, that a
 * clause is present. None of it can tell you whether the walk returns the
 * nearest visible ancestor, whether COALESCE picks the topmost one on a
 * four-level tree, or — the one that matters most — whether `root_id` stays
 * NULL for a caller whose parent is visible. That last one is a disclosure
 * boundary: emitted too widely it hands out the uuid of a channel the caller
 * cannot see, which is the exact leak the parent_id mask exists to close.
 *
 * This repo has shipped a defect of precisely this shape before: a query
 * selecting a column that does not exist, swallowed by a bare catch, green
 * suite, broken in production — because no test executed SQL. The harness for
 * executing it already existed and was not used.
 *
 * ⚠️ THIS FILE HAS NEVER EXECUTED, AND TWO THINGS BLOCK IT BEYOND DOCKER.
 *
 * Docker was unavailable on the machine that wrote it, so every case below is
 * reasoned, not observed. Before anyone reports these as green, note that the
 * harness itself is currently non-functional:
 *
 *   1. `@testcontainers/postgresql` is NOT a dependency of
 *      `apps/auth-service/package.json`, so `bootIntegrationDb()` throws on its
 *      `require`, sets `bootError`, and every `describeIfDb` in the project
 *      silently collapses to `describe.skip` — including this one. A "pass" in
 *      that state means nothing ran.
 *   2. `20260416000000_init_phase1.sql` declares
 *      `public.users.id REFERENCES auth.users(id)`, and nothing in this repo
 *      creates the `auth` schema, so on a vanilla Postgres image that migration
 *      very likely rolls back wholesale — taking `public.users` and
 *      `department_channels` with it.
 *
 * So the disclosure boundary asserted here has NO executable verification
 * today. That is a statement of fact, not a to-do hidden in a docstring:
 * `npm run test:integration` will need both of the above resolved first.
 */
import {bootIntegrationDb, getPool, shouldSkipIntegration, teardownIntegrationDb} from './harness';
import {DepartmentService} from '../../src/department/department.service';
import type {DatabaseService} from '../../src/database/database.service';
import type {OrgAuditService} from '../../src/org/org-audit.service';

const describeIfDb = shouldSkipIntegration() ? describe.skip : describe;

const ORG = '11111111-1111-1111-1111-111111111111';
const MEMBER = '22222222-2222-2222-2222-222222222222';
const SASFA = 'aaaaaaaa-0000-0000-0000-000000000001';
const RSA = 'aaaaaaaa-0000-0000-0000-000000000002';
const FORT = 'aaaaaaaa-0000-0000-0000-000000000003';
const SQUAD = 'aaaaaaaa-0000-0000-0000-000000000004';
const CORTAC = 'bbbbbbbb-0000-0000-0000-000000000001';
const CAPE = 'bbbbbbbb-0000-0000-0000-000000000002';

describeIfDb('vs2 item 2 — listChannels tree fields (real DB)', () => {
  let booted = false;
  let svc: DepartmentService;

  beforeAll(async () => {
    booted = await bootIntegrationDb();
    if (!booted) {return;}
    const pool = getPool();
    // Thin adapter over the real pool with the two methods the service uses.
    const db = {
      q: async <T>(sql: string, params?: unknown[]) =>
        (await pool.query(sql, params as never)).rows as T[],
      qOne: async <T>(sql: string, params?: unknown[]) =>
        ((await pool.query(sql, params as never)).rows[0] ?? null) as T | null,
    } as unknown as DatabaseService;
    svc = new DepartmentService(db, {log: async () => undefined} as unknown as OrgAuditService);
  }, 180_000);

  afterAll(async () => {
    if (booted) {await teardownIntegrationDb();}
  }, 30_000);

  /**
   * SASFA (level 0, inserted EXPLICITLY — see below)
   *   └─ RSA (1)
   *        └─ Fort Hunter (2)
   *             └─ Alpha Squad (3)
   * CORTAC (level 1 — the shape production actually has)
   *   └─ Cape Town (2)
   *
   * WHY SASFA'S LEVEL IS SUPPLIED AND CORTAC'S IS NOT.
   *
   * `level` DEFAULTS to 1, and the trigger only derives it for a child
   * (parent_level + 1); no INSERT in the service ever supplies it, so every
   * root created through the API is level 1 and the deepest real chain is three
   * tiers. An earlier draft of this file assumed roots were level 0 and seeded
   * four tiers on top of a defaulted root — Alpha Squad then computed level 4
   * and tripped `department_channels_level_range CHECK (level BETWEEN 0 AND 3)`.
   * `ON CONFLICT DO NOTHING` does not absorb a CHECK violation, so seed() threw
   * and every test in this file errored, including the disclosure-boundary one
   * it exists for.
   *
   * A parentless row MAY be level 0 (the trigger only refuses level > 1 there),
   * so both shapes are seeded deliberately: CORTAC is the production shape, and
   * the explicit level-0 SASFA chain is the only way to exercise the third
   * ancestor hop (`a3`) at all.
   *
   * SEEDED PER TEST, not once in beforeAll. The container is SHARED across the
   * whole integration project and sibling suites call
   * `resetWriteableTables()` in their own `beforeEach` — which TRUNCATEs
   * `public.users … CASCADE`, and `department_channels.org_id` is
   * `REFERENCES users(id) ON DELETE CASCADE`. A one-time seed would therefore
   * be deleted out from under this file whenever Jest interleaves it with
   * another suite, producing a failure that looks like a query bug and moves
   * between runs. Every insert is ON CONFLICT DO NOTHING, so re-seeding is
   * cheap when nothing was wiped.
   */
  async function seed() {
    const pool = getPool();
    // role MUST be one of individual | agent | service_provider
    // (`20260707120000_tighten_users_role_taxonomy.sql`). 'company' is an
    // `agents.type` value, not a users.role — an org owner is a
    // service_provider. And display_name is NOT NULL with no default
    // (`20260416000000_init_phase1.sql`). Getting either wrong makes seed()
    // throw, which errors EVERY test in this file rather than failing one.
    for (const [id, email, name] of [
      [ORG, 'org@test.invalid', 'Test Org'],
      [MEMBER, 'member@test.invalid', 'Test Member'],
    ]) {
      await pool.query(
        `INSERT INTO public.users (id, email, display_name, role, subscription_tier)
         VALUES ($1, $2, $3, 'service_provider', 'pro') ON CONFLICT (id) DO NOTHING`,
        [id, email, name]);
    }
    const mk = async (id: string, name: string, parent: string | null, level?: number) =>
      (level === undefined
        ? pool.query(
          `INSERT INTO public.department_channels (id, org_id, name, parent_id, created_by)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
          [id, ORG, name, parent, ORG])
        : pool.query(
          `INSERT INTO public.department_channels (id, org_id, name, parent_id, created_by, level)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
          [id, ORG, name, parent, ORG, level]));
    await mk(SASFA, 'SASFA', null, 0);
    await mk(RSA, 'RSA', SASFA);
    await mk(FORT, 'Fort Hunter', RSA);
    await mk(SQUAD, 'Alpha Squad', FORT);
    await mk(CORTAC, 'CORTAC', null);
    await mk(CAPE, 'Cape Town', CORTAC);
    // Assert the shape rather than assume it. If the level derivation ever
    // changes, this must fail HERE with a readable message — not later as a
    // CHECK violation inside an INSERT, and above all not as a PASSING test
    // over a tree that is not the one described above.
    const {rows} = await pool.query<{id: string; level: number}>(
      'SELECT id, level FROM public.department_channels WHERE org_id = $1', [ORG]);
    const level = new Map(rows.map(r => [r.id, Number(r.level)]));
    expect([level.get(SASFA), level.get(RSA), level.get(FORT), level.get(SQUAD)])
      .toEqual([0, 1, 2, 3]);
    expect(level.get(CORTAC)).toBe(1);
  }

  /** Undo any per-test archiving. Deliberately OUTSIDE the read path. */
  afterEach(async () => {
    if (!booted) {return;}
    await getPool().query(
      'UPDATE public.department_channels SET archived_at = NULL WHERE org_id = $1', [ORG]);
  });

  /** Re-seed the tree and set MEMBER's memberships to exactly `ids`. */
  async function seedMemberships(ids: string[]) {
    const pool = getPool();
    await seed();
    await pool.query('DELETE FROM public.department_channel_members WHERE user_id = $1', [MEMBER]);
    for (const id of ids) {
      await pool.query(
        `INSERT INTO public.department_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'viewer')`, [id, MEMBER]);
    }
  }

  /** Re-seed MEMBER's memberships to exactly `ids`, then read their list. */
  async function asMemberOf(ids: string[]) {
    const pool = getPool();
    await seed();
    await pool.query('DELETE FROM public.department_channel_members WHERE user_id = $1', [MEMBER]);
    for (const id of ids) {
      await pool.query(
        `INSERT INTO public.department_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'viewer')`, [id, MEMBER]);
    }
    const page = await svc.listChannels(MEMBER);
    return new Map(page.channels.map(c => [c.id, c]));
  }

  it('an ordinary child sees its parent and NO synthetic key', async () => {
    if (!booted) {return;}
    const rows = await asMemberOf([SASFA, RSA]);
    const rsa = rows.get(RSA)!;
    expect(rsa.parent_id).toBe(SASFA);
    expect(rsa.parent_hidden).toBe(false);
    expect(rsa.root_id).toBeNull();
  });

  it('THE DISCLOSURE BOUNDARY — a visible parent never leaks an invisible root', async () => {
    // Member of Fort Hunter and RSA, but NOT of the root SASFA. parent_id is
    // legitimately RSA; root_id must stay NULL. Emitting SASFA's uuid here
    // would prove to this caller that a channel they cannot see exists — the
    // leak the parent_id mask was written to close, one hop further up.
    if (!booted) {return;}
    const rows = await asMemberOf([RSA, FORT]);
    const fort = rows.get(FORT)!;
    expect(fort.parent_id).toBe(RSA);
    expect(fort.parent_hidden).toBe(false);
    expect(fort.root_id).toBeNull();
  });

  it('a masked orphan reports its NEAREST visible ancestor', async () => {
    // Member of SASFA and Fort Hunter; the middle rung RSA is invisible.
    if (!booted) {return;}
    const rows = await asMemberOf([SASFA, FORT]);
    const fort = rows.get(FORT)!;
    expect(fort.parent_id).toBeNull();
    expect(fort.parent_hidden).toBe(true);
    expect(fort.visible_ancestor_id).toBe(SASFA);
    // Still gated: an ancestor IS visible, so the synthetic key is not needed.
    expect(fort.root_id).toBeNull();
  });

  it('nearest really means nearest — the deeper of two visible ancestors wins', async () => {
    if (!booted) {return;}
    const rows = await asMemberOf([SASFA, RSA, SQUAD]);
    const squad = rows.get(SQUAD)!;
    expect(squad.parent_hidden).toBe(true);
    expect(squad.visible_ancestor_id).toBe(RSA);
  });

  it('with NO visible ancestor, root_id is the TOPMOST ancestor', async () => {
    // The only shape that consumes root_id. Alpha Squad is level 3, so the
    // COALESCE has to climb all three hops to SASFA.
    if (!booted) {return;}
    const rows = await asMemberOf([SQUAD]);
    const squad = rows.get(SQUAD)!;
    expect(squad.parent_id).toBeNull();
    expect(squad.parent_hidden).toBe(true);
    expect(squad.visible_ancestor_id).toBeNull();
    expect(squad.root_id).toBe(SASFA);
  });

  it('two orphans under different roots get DIFFERENT keys', async () => {
    // The reason root_id exists at all: merging these under one header would
    // assert a parent relationship that is false.
    if (!booted) {return;}
    const rows = await asMemberOf([FORT, CAPE]);
    expect(rows.get(FORT)!.root_id).toBe(SASFA);
    expect(rows.get(CAPE)!.root_id).toBe(CORTAC);
  });

  it('a genuine root reports itself as an organisation', async () => {
    if (!booted) {return;}
    const rows = await asMemberOf([SASFA]);
    const sasfa = rows.get(SASFA)!;
    expect(sasfa.parent_id).toBeNull();
    expect(sasfa.parent_hidden).toBe(false);
    expect(sasfa.visible_ancestor_id).toBeNull();
    expect(sasfa.root_id).toBeNull();
  });

  it('an ARCHIVED parent is not treated as visible', async () => {
    // The row list is filtered to archived_at IS NULL, so a parent_id pointing
    // at an archived channel names a row the caller never receives — the child
    // would be classified as an ordinary child and render under a parent that
    // is not in the list, i.e. nowhere. Reachable only through a race today
    // (archiveChannel is a check-then-write with no row lock), which is exactly
    // why it is pinned rather than argued away.
    if (!booted) {return;}
    const pool = getPool();
    // Memberships FIRST, then archive, then read. An earlier draft archived RSA
    // and then called asMemberOf(), whose seed() un-archived the whole org
    // before the read — so the test silently exercised the un-archived tree and
    // could never fail. The un-archive now lives in afterEach, outside the
    // read path.
    await seedMemberships([SASFA, RSA, FORT]);
    await pool.query('UPDATE public.department_channels SET archived_at = NOW() WHERE id = $1', [RSA]);

    const page = await svc.listChannels(MEMBER);
    const rows = new Map(page.channels.map(c => [c.id, c]));
    expect(rows.has(RSA)).toBe(false);
    const fort = rows.get(FORT)!;
    expect(fort.parent_id).toBeNull();
    expect(fort.parent_hidden).toBe(true);
    // …and it falls through to the live grandparent rather than vanishing.
    expect(fort.visible_ancestor_id).toBe(SASFA);
  });
});
