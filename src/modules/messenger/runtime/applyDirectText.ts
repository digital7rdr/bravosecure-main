import type {SessionAddress} from '@bravo/messenger-core';
import {buildInboundMessage, sentAtFromAad} from './inboundMessageBuilder';
import type {LocalMessage} from '../store/types';

/**
 * Seam S5 — the 1:1 TEXT lane of `doHandleIncoming`.
 *
 * Sibling of `applyGroupText`. Same two drops, and they are DELIBERATELY in the
 * opposite order:
 *
 *   group : tombstone (M-08) -> blocked (P2-9)
 *   1:1   : blocked  (M-07)  -> tombstone (M-08)
 *
 * That divergence is preserved verbatim rather than "tidied" during the move. It
 * is currently harmless — both branches drop, neither notes the envelope, so the
 * only observable difference is which log line is emitted — but a move is not
 * the place to change behaviour, and the tests below pin BOTH orders so the
 * difference is now visible and deliberate instead of accidental. If the drops
 * ever gain different consequences (one noting the envelope, say), this is
 * where that latent inconsistency would turn into a real bug.
 *
 * No membership gate here: 1:1 has no membership concept, and the conversation
 * id is resolved FROM the peer, so a peer cannot address someone else's thread.
 *
 * Everything react-native-tainted is injected, so this module is Tier A and the
 * node jest project can load it — the reason these gates are testable at all.
 *
 * See docs/runbooks/MESSAGE_LOOP.md W24/S5.
 */

export type DirectTextOutcome =
  | {kind: 'dropped'; reason: 'blocked' | 'tombstoned'}
  /** `committedId` is null when the store deduped the row away. */
  | {kind: 'appended'; committedId: string | null};

export interface DirectTextDeps {
  isPeerBlocked:       (userId: string) => boolean;
  isRestoreTombstoned: (msgId: string) => boolean;
  appendMessage:       (conversationId: string, msg: LocalMessage) => string | null;
  upsert:              ((msg: LocalMessage) => Promise<void>) | null;
  makeId:              () => string;
  log:                 (msg: string) => void;
}

export interface DirectTextArgs {
  env:            {aad?: unknown; body?: string};
  conversationId: string;
  peer:           SessionAddress;
  content:        string;
  envelopeId:     string | undefined;
  /**
   * OM-02 — the relay's accept time, used to clamp a sender whose clock is in
   * the FUTURE. The inline lane this replaced clamped via orderingCreatedAt;
   * passing it keeps that behaviour instead of silently dropping it.
   */
  refTsMs?:       number;
}

/**
 * Async for the same reason as `applyGroupText`: the append and the upsert must
 * not be split across the seam, or M8/M12 comes straight back (the caller used
 * to persist the pre-append object while the store had forked the id).
 */
export async function applyDirectText(
  args: DirectTextArgs,
  deps: DirectTextDeps,
): Promise<DirectTextOutcome> {
  const {env, conversationId, peer, content, envelopeId, refTsMs} = args;

  const msg: LocalMessage = buildInboundMessage({
    env:       env as Parameters<typeof buildInboundMessage>[0]['env'],
    conversationId, peer, content,
    createdAt: sentAtFromAad(env.aad as {ts?: number} | undefined, refTsMs),
    envelopeId,
    makeId:    deps.makeId,
  });

  // M-07 — without this, appendMessage would RESURRECT the conversation the user
  // just blocked. That is why the gate is here and not only in the UI.
  if (deps.isPeerBlocked(peer.userId)) {
    deps.log('[recv.text.append.blocked] peer=' + peer.userId.slice(0, 8));
    return {kind: 'dropped', reason: 'blocked'};
  }
  // M-08 — a message the user deleted before reinstalling, being re-delivered by
  // the sealed-archive replay.
  if (deps.isRestoreTombstoned(msg.id)) {
    deps.log('[recv.text.append.tombstoned] msgId=' + msg.id.slice(0, 8));
    return {kind: 'dropped', reason: 'tombstoned'};
  }

  // M8/M12 — persist the row the store COMMITTED, not the one we built.
  const committedId = deps.appendMessage(conversationId, msg);
  if (committedId && deps.upsert) {
    await deps.upsert({...msg, id: committedId});
  }
  return {kind: 'appended', committedId};
}
