/**
 * Channels vs2 P3 — ONE users.id MAY NOT BE BOTH TENANTS.
 *
 * The whole phase keys real behaviour on `org_workspaces.owner_user_id`:
 * whether a new org seeds default channels, whether creating a channel
 * auto-adds a #broadcast, and whether that #broadcast can be archived or
 * deleted. A dual-tenant account would silently get the wrong tenant's rules on
 * every one of them — and, worse, get DIFFERENT answers from the service and
 * from the DB trigger, which read the same table at different moments.
 *
 * The exclusivity was only half-enforced when this phase started:
 * `workspace.service` refused a company agent creating a workspace, but
 * `agent.service.create` had no matching refusal, so the same user could become
 * both by going the other way round. This file pins BOTH directions, because a
 * one-directional guarantee is not a guarantee.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/** CRLF-normalised, comments stripped — the prose in both services discusses
 *  the very rule under test. */
function source(rel: string[]): string {
  return readFileSync(join(process.cwd(), 'src', ...rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

describe('the workspace/agency tenant split is exclusive in BOTH directions', () => {
  it('a company agent cannot create a workspace', () => {
    const src = source(['org', 'workspace.service.ts']);
    expect(src).toMatch(/FROM agents WHERE user_id = \$1 AND type = 'company'/);
    expect(src).toMatch(/provider_account_cannot_own_workspace/);
  });

  it('a workspace owner cannot become a company agent', () => {
    // THE HALF THAT WAS MISSING. Added by vs2 P3 before anything was allowed to
    // depend on the discriminator.
    const src = source(['agents', 'agent.service.ts']);
    expect(src).toMatch(/FROM public\.org_workspaces WHERE owner_user_id = \$1/);
    expect(src).toMatch(/workspace_owner_cannot_be_provider/);
  });

  it('the refusal comes BEFORE the agents row is written', () => {
    // A guard that runs after the INSERT is not a guard. Order matters more
    // than presence here, and presence is all a naive scan would check.
    const src = source(['agents', 'agent.service.ts']);
    const fn = src.slice(src.indexOf('async create(userId: string'),
      src.indexOf('async submit('));
    const guard = fn.indexOf('workspace_owner_cannot_be_provider');
    const insert = fn.indexOf('INSERT INTO agents');
    expect(guard).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(insert);
  });

  it('the service and the DB trigger read the SAME discriminator', () => {
    // They must agree. The service decides whether to create a #broadcast; the
    // trigger decides whether it can ever be deleted. Keyed on two different
    // notions of "workspace", an org could get an undeletable channel the
    // service never intended it to have.
    const svc = source(['department', 'department.service.ts']);
    expect(svc).toMatch(/FROM public\.org_workspaces WHERE owner_user_id = \$1/);
    const mig = readFileSync(
      join(process.cwd(), '..', '..', 'supabase', 'migrations',
        '20260811160000_workspace_broadcast_removable.sql'), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    expect(mig).toMatch(/FROM public\.org_workspaces w WHERE w\.owner_user_id = OLD\.org_id/);
    // …and the agency side of the rule survives in the trigger.
    expect(mig).toMatch(/broadcast_channel_cannot_be_deleted/);
  });
});
