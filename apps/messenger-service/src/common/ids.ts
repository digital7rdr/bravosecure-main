/**
 * AUDIT-2026-08-13 #19 — flavored (weak-brand) id types for the service.
 *
 * Plain strings still assign to every flavor (zero retrofit cascade), but a
 * value TYPED with one flavor no longer assigns to a parameter demanding
 * another — the swap-compiles-fine class (`sendVoipWake(userId, callId,
 * senderUserId)`, `roomToken.issue(roomId, recipientUserId)`,
 * `storeRetractToken(token, envelopeId)`) becomes a compile error wherever
 * both sides are typed. Flavors erase at runtime.
 *
 * Tags deliberately match the mobile `src/modules/messenger/conversationIds.ts`
 * module so the shapes unify structurally if code ever moves between trees.
 */

export type UserId = string & {readonly __flavor?: 'UserId'};
export type CallId = string & {readonly __flavor?: 'CallId'};
export type RoomId = string & {readonly __flavor?: 'RoomId'};
export type EnvelopeId = string & {readonly __flavor?: 'EnvelopeId'};
export type RetractToken = string & {readonly __flavor?: 'RetractToken'};
export type ConversationId = string & {
  readonly __flavor?: 'ConversationId' | 'GroupId' | 'DirectSlotId' | 'DirectAadId';
};
