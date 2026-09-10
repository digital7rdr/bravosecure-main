/**
 * Audit P0-G1 — regression-lock: the mobile mirror at
 * `src/modules/messenger/groups/groupClient.ts` MUST be a thin re-export
 * of `@bravo/messenger-core` (which mirror policy designates as the
 * single source of truth for crypto-adjacent code). The two copies had
 * silently drifted: the package had `planAddAndRekey`, `planLeaveAndRekey`,
 * `isGroupMember`, `verifyGroupIdDerivation`, the `leave` admin action,
 * and the `transcriptHash` chain — the mobile copy had none of those, so
 * any consumer hitting the mobile barrel got a strict subset of the
 * security checks and a stale `GroupAdminAction` union that didn't even
 * include `leave`.
 *
 * This test pins the dedup by reference-equality: every export the package
 * ships from `groups/groupClient` must be the SAME object on the mobile
 * side. Future divergence (someone "patching" mobile-only) fails here.
 */

import * as mobileGroups from '../groups';
import * as coreGroups from '@bravo/messenger-core';

describe('audit P0-G1 — mobile groupClient re-exports package (no divergence allowed)', () => {
  const surface = [
    'broadcastToGroup',
    'parseGroupMessage',
    'applyAdminAction',
    'makeNewGroup',
    'makeAssignedGroup',
    'deriveGroupId',
    'genFreshGroupMasterKey',
    'planRemoveAndRekey',
    'planAddAndRekey',
    'planLeaveAndRekey',
    'isGroupMember',
    'verifyGroupIdDerivation',
    'signGroupCreate',
    'verifyGroupCreateSignature',
    'canonicalCreateBytes',
  ] as const;

  for (const name of surface) {
    it(`mobile ${name} === package ${name} (same reference)`, () => {
      const mobileFn = (mobileGroups as Record<string, unknown>)[name];
      const coreFn = (coreGroups as Record<string, unknown>)[name];
      expect(mobileFn).toBeDefined();
      expect(coreFn).toBeDefined();
      expect(mobileFn).toBe(coreFn);
    });
  }

  it('mobile GroupAdminAction includes `leave` (post-P0-G1 dedup)', () => {
    // Compile-time: the `leave` arm must be on the union. If the mobile
    // types.ts drifts again, this assignment fails to typecheck.
    const leave: import('../groups').GroupAdminAction = {
      type: 'leave',
      atEpoch: 0,
    };
    expect(leave.type).toBe('leave');
  });
});
