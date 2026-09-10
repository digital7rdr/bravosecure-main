/**
 * Audit P0-G1 — single source of truth. Group types previously diverged
 * between this file and `packages/messenger-core/src/groups/types.ts`
 * (mobile was missing `saltB64`, `transcriptHash`, the `leave` admin
 * action, etc.). The mobile mirror now thin-re-exports the package so a
 * future change to either side can only happen in ONE place.
 *
 * Per CLAUDE.md mirror policy: `packages/messenger-core/src/**` is the
 * authoritative location for platform-agnostic crypto and group code.
 */
export {
  type GroupState,
  type GroupAdminAction,
  type GroupMessageEnvelope,
  type GroupMemberAddress,
  memberToAddress,
} from '@bravo/messenger-core';
