/**
 * Audit P0-G1 — single source of truth. This module used to carry a
 * second copy of the group client that silently drifted from the package:
 * the package gained `planAddAndRekey`, `planLeaveAndRekey`, the `leave`
 * admin action, `isGroupMember`, `verifyGroupIdDerivation`, and the
 * P1-G1 transcript-hash chain, while the mobile copy stayed at the
 * pre-P1-N4 baseline. Any consumer that imported from `../groups` got a
 * strict subset of the security checks.
 *
 * The dedup makes this file a thin re-export of `@bravo/messenger-core`
 * so the two surfaces are now reference-equal. The `groupClientMirror`
 * test regression-locks the equality so future divergence fails fast.
 *
 * Per CLAUDE.md mirror policy: `packages/messenger-core/src/groups/**` is
 * the authoritative location. New group primitives land THERE first.
 */
export {
  broadcastToGroup,
  parseGroupMessage,
  applyAdminAction,
  makeNewGroup,
  makeAssignedGroup,
  deriveGroupId,
  verifyGroupIdDerivation,
  isGroupMember,
  genFreshGroupMasterKey,
  planRemoveAndRekey,
  planAddAndRekey,
  planLeaveAndRekey,
  deriveRekeyMasterKey,
  signGroupCreate,
  verifyGroupCreateSignature,
  canonicalCreateBytes,
  type BroadcastParams,
  type BroadcastResult,
  type ParseGroupResult,
} from '@bravo/messenger-core';
