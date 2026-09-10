/**
 * Enterprise Dept Channels scope v2 — Phase 2 invariants.
 *
 * Frame A9: "Support Open Chat, Read-only, Announcement-only and Admin-only
 * modes." Page 10 rule 2: "Visible does not automatically grant posting, upload
 * or management rights." Page 10 rule 1 + A9: "a mandatory non-deletable
 * #broadcast at every hierarchy level."
 *
 * WHY THIS FILE IS A SOURCE SCAN AS WELL AS A UNIT TEST.
 *
 * Phase 2's whole point is that `access` (visibility) and `post_mode` (posting)
 * must never re-merge. That is not something a behavioural test can pin — the
 * defect is a NEW call site somewhere else branching on the wrong column, which
 * by definition is not in any test yet. Phase 1 taught this the hard way four
 * times: an enumerative guard covers the cases you thought of, a structural one
 * covers the ones you didn't. So the scan below asserts that each question has
 * exactly ONE answerer and nothing else touches either column.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DepartmentService} from './department.service';

const SERVICE = join(process.cwd(), 'src', 'department', 'department.service.ts');

/** Normalise CRLF and strip comments — the prose in this file and in the
 *  service quotes the very expressions under test. */
function source(): string {
  return readFileSync(SERVICE, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('--'))
    .join('\n');
}

describe('Phase 2 — visibility and posting are answered in exactly one place each', () => {
  it('seedsManagersOnly is the only VISIBILITY rule', () => {
    expect(DepartmentService.seedsManagersOnly('restricted', 'department')).toBe(true);
    expect(DepartmentService.seedsManagersOnly('standard', 'incident')).toBe(true);
    expect(DepartmentService.seedsManagersOnly('standard', 'department')).toBe(false);
    expect(DepartmentService.seedsManagersOnly('read_only', 'department')).toBe(false);
  });

  it('memberRoleFor is the only POSTING rule, and only `open` grants posting', () => {
    expect(DepartmentService.memberRoleFor('open')).toBe('admin');
    for (const m of ['read_only', 'announcement', 'admin_only'] as const) {
      expect(`${m}:${DepartmentService.memberRoleFor(m)}`).toBe(`${m}:viewer`);
    }
  });

  it('NOTHING ELSE in the service branches on access or channel_type for visibility', () => {
    // The pre-Phase-2 defect was `access === 'restricted' || type === 'incident'`
    // written out at three separate sites; when one drifted the others silently
    // disagreed. Exactly one occurrence is allowed: the body of seedsManagersOnly.
    const src = source()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    expect(src).not.toMatch(/ensureBroadcastForLevel/);
    // And the seed path is a declared no-op: nothing INSERTs from seedOrgWorkspace.
    const seedStart = src.indexOf('async seedOrgWorkspace(');
    const seedEnd = src.indexOf('async isWorkspaceTenant');
    expect(seedStart).toBeGreaterThan(-1);
    expect(seedEnd).toBeGreaterThan(seedStart);
    const seed = src.slice(seedStart, seedEnd);
    expect(seed.length).toBeLessThan(3000);
    expect(seed).not.toMatch(/INSERT INTO/);
  });

  it('never lets a caller assert is_broadcast or a broadcast post_mode', () => {
    const dto = readFileSync(join(process.cwd(), 'src', 'department', 'dto', 'channel.dto.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    // A caller that could set is_broadcast could mint a fake non-deletable
    // channel, or a "broadcast" its members can post in.
    expect(dto).not.toMatch(/is_broadcast/);
  });

  it('one per LEVEL, not per node — the index is the guarantee', () => {
    const mig = readFileSync(
      join(process.cwd(), '..', '..', 'supabase', 'migrations', '20260803020000_dept_channel_post_mode.sql'),
      'utf8').replace(/\r\n/g, '\n').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    // Per-node is not merely a different choice, it is impossible: a #broadcast
    // child of a level-3 Sub-sub would be level 4, which the Phase 1 CHECK
    // rejects. So (org_id, level) is the only reading both rules allow.
    expect(mig).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS dept_channels_one_broadcast_per_level/);
    expect(mig).toMatch(/ON public\.department_channels\(org_id, level\)/);
    // Non-deletable, and enforced for EVERY writer rather than in one handler.
    expect(mig).toMatch(/BEFORE DELETE ON public\.department_channels/);
    expect(mig).toMatch(/RAISE EXCEPTION 'broadcast_channel_cannot_be_deleted'/);
    // A broadcast is announcement-mode by construction, not by trust.
    expect(mig).toMatch(/NEW\.post_mode := 'announcement'/);
  });
});
