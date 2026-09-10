/**
 * F2 BACKFILL — the deletion that stranded five live tenants.
 *
 * F2 removed "an Enterprise tier alone makes you an org manager" from both
 * mirrors (OrgManagerGuard Path 3, resolveIsOrgManager's `is_enterprise` arm).
 * Correct per PDF frame A4 — a plan is an entitlement, not authority.
 *
 * It shipped as a PURE DELETION. Users had already been created through the arm
 * it removed: before Phase 6 there was no `org_workspaces` route at all, so the
 * tier arm was the only thing making an Enterprise buyer a manager. Measured on
 * staging 2026-08-04, five active-Enterprise users owned un-archived
 * `department_channels` with no workspace row, no company agent and no manager
 * row — 403ing on channels they own, one of them with an employee sitting in an
 * approval queue nobody could reach.
 *
 * This pins the repair. It is the SAME defect class the rest of this scope keeps
 * hitting from the other side: a rule changed at the layer examined, with the
 * population that depended on the old rule left un-migrated.
 *
 * No database runs in unit tests, so the migration is read as source. Comments
 * are stripped first — this migration's prose names every column and rule under
 * test, which is the most common false green in this repo.
 */
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

// jest runs with cwd = apps/auth-service
const MIGRATIONS_DIR = join(process.cwd(), '..', '..', 'supabase', 'migrations');
const THIS_MIGRATION = '20260805010000_backfill_org_workspaces_for_channel_owners.sql';

function stripped(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .join('\n');
}

/** Comment-free, whitespace-collapsed — so assertions can pin whole clauses. */
const flat = (): string => stripped(THIS_MIGRATION).replace(/\s+/g, ' ').trim();

describe('F2 backfill: Enterprise channel owners regain their workspace', () => {
  it('the migration exists and targets org_workspaces', () => {
    expect(readdirSync(MIGRATIONS_DIR)).toContain(THIS_MIGRATION);
    expect(flat()).toMatch(/INSERT INTO public\.org_workspaces \(owner_user_id, name, created_at\)/);
  });

  /**
   * THE POPULATION. Narrower and it misses stranded owners; wider and it mints
   * org identities for people the old rule never admitted either.
   */
  it('selects exactly the owners of live channels, joined not sub-queried', () => {
    // The JOIN is what makes "owns at least one channel" the population AND
    // supplies MIN(created_at). An EXISTS instead would silently widen it to
    // every Enterprise user on the platform.
    expect(flat()).toMatch(
      /FROM public\.users u JOIN public\.department_channels c ON c\.org_id = u\.id AND c\.archived_at IS NULL/,
    );
  });

  it('is lapse-aware, matching activeEnterpriseSql', () => {
    // A lapsed owner was locked out BEFORE F2 too — Path 3 used the lapse-aware
    // effectiveTierOf. Minting for them would grant authority the old rule never
    // gave, which is a different bug wearing this fix's clothes.
    expect(flat()).toMatch(
      /WHERE u\.subscription_tier = 'enterprise' AND \(u\.pro_active_until IS NULL OR u\.pro_active_until > NOW\(\)\)/,
    );
  });

  it('skips company agents, who already reach manager another way', () => {
    expect(flat()).toMatch(
      /AND NOT EXISTS \( SELECT 1 FROM public\.agents a WHERE a\.user_id = u\.id AND a\.type = 'company' \)/,
    );
  });

  /**
   * Re-running must not disturb a workspace the owner has since created — the
   * self-heal CTA can mint one at any moment, including between this migration
   * being written and applied.
   */
  it('is idempotent and never overwrites an existing workspace', () => {
    expect(flat()).toMatch(/ON CONFLICT \(owner_user_id\) DO NOTHING/);
    // DO UPDATE would rename a workspace its owner had already named.
    expect(flat()).not.toMatch(/ON CONFLICT[^;]*DO UPDATE/);
  });

  /**
   * `org_workspaces_name_not_blank` refuses a blank name. Without the fallback
   * one account with a NULL display_name aborts the WHOLE migration on the
   * CHECK rather than skipping a row.
   */
  it('cannot violate the not-blank CHECK', () => {
    expect(flat()).toMatch(
      /COALESCE\(NULLIF\(btrim\(u\.display_name\), ''\), 'My Workspace'\)/,
    );
  });

  /**
   * account-kind.ts resolves the org name as COALESCE(orgws.name,
   * org.display_name). Seeding from display_name is what makes this migration
   * change ZERO visible strings — any other source silently renames live orgs
   * for every employee of them.
   */
  it('seeds the name from display_name so no visible string changes', () => {
    const f = flat();
    expect(f).toMatch(/NULLIF\(btrim\(u\.display_name\), ''\)/);
    expect(f).toMatch(/GROUP BY u\.id, u\.display_name/);
  });

  it('stamps creation from the oldest channel, not NOW()', () => {
    // A NOW() stamp reads as "the workspace was created after the channels it
    // contains", which is false and visible in the UI.
    expect(flat()).toMatch(/COALESCE\(MIN\(c\.created_at\), NOW\(\)\)/);
  });

  /**
   * THE LINE THIS MUST NOT CROSS. The repair is to give these users the row the
   * NEW rule asks for — not to re-admit the tier arm A4 forbids. A migration
   * that touched users.role, granted a manager row, or wrote org_members would
   * be restoring the deleted rule by other means.
   */
  it('does not re-grant authority by any other route', () => {
    const f = flat();
    expect(f).not.toMatch(/INSERT INTO public\.org_members/i);
    expect(f).not.toMatch(/UPDATE (public\.)?users/i);
    expect(f).not.toMatch(/subscription_tier\s*=\s*'(?!enterprise')/i);
    // One statement, one table.
    expect(f.match(/INSERT INTO/gi) ?? []).toHaveLength(1);
  });
});
