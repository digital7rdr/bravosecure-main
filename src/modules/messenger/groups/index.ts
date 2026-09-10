/**
 * Audit P0-G1 — barrel re-export. After dedup, every symbol lives in
 * `@bravo/messenger-core`; this barrel stays as a stable import path for
 * the small number of mobile-side consumers that still import from
 * `../groups` (e.g. test fixtures, screen modules) so they don't have
 * to be touched in the dedup commit.
 */
export * from './types';
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
} from './groupClient';
