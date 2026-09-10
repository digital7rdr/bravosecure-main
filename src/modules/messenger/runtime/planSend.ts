// B-145 — one cap for the quoted preview, enforced on both sides of the
// wire. Value import (not `import type`) so send and receive cannot drift.
import {REPLY_PREVIEW_MAX_CHARS} from './inboundMessageBuilder';
import {isDirectPrefixed, peerFromDirectSlot} from '../conversationIds';
import type {SendTextOptions} from './runtime';

/**
 * Seam W27 — the pure planner for `sendText`.
 *
 * Everything `sendText` decides BEFORE either branch does any work: which slot
 * the message belongs in, whether that slot is a group, what id the bubble and
 * the wire will share, and the TTL / reply metadata. All of it is derivable from
 * (state, conversationId, opts), so all of it belongs in a function that can be
 * tested without a runtime.
 *
 * PURE ON PURPOSE. It performs no writes, no I/O and no clock/id access of its
 * own — `makeId` and `now` are injected. That is what lets the tests pin things
 * like "the wire id equals the bubble id" as facts rather than as source-scan
 * approximations.
 *
 * Three decisions in here are load-bearing and each has a bug behind it:
 *
 *  1. **Canonicalisation.** ChatScreen may hand us the synthetic `direct:<peer>`
 *     id (NewChat / push tap / incoming call) or the server UUID (Home list tap /
 *     `/conversations/mine`). The INBOUND path canonicalises to server-UUID when
 *     one exists, so the outbound path must agree or the bubble lands in a slot
 *     ChatScreen is not subscribed to and simply never appears. Groups skip it —
 *     they always carry a server UUID already.
 *
 *  2. **Topology comes from the shared rule, never a local copy.** `sendText`
 *     used to inline its own predicate; the copies drifted (this one lacked the
 *     `direct` veto on the GroupState clause), so a stray call key filed at a 1:1
 *     id reclassified that chat as a group forever — B-124/B-125, CRITICAL data
 *     loss. The caller's `opts.isGroup` hint still wins when set, which is the
 *     one remaining override and is why it is surfaced explicitly in the plan.
 *
 *  3. **`clientMsgId === msgId`.** The wire id MUST equal the local bubble id so
 *     that reactions and replies others place — keyed by `clientMsgId` — land on
 *     the AUTHOR's own copy too. The group path used to mint a separate
 *     `clientMsgId`, so a group author never saw reactions on their own messages
 *     and reply-jump missed (BS-REACT-AUTHOR).
 *
 * See docs/runbooks/MESSAGE_LOOP.md W27 / M2 / M3.
 */

export interface SendPlan {
  /** Canonicalised — write the bubble HERE, not at the id the caller passed. */
  conversationId: string;
  /** Set only when canonicalisation moved us, so the caller can log the hop. */
  canonicalisedFrom?: string;
  isGroup:      boolean;
  /** Local bubble id AND wire clientMsgId — deliberately the same value. */
  msgId:        string;
  clientMsgId:  string;
  sentAt:       string;
  expiresAtSec: number | undefined;
  replyMeta:    {msgId: string; preview: string} | undefined;
}

export interface PlanSendDeps {
  /** `resolveDirectConversationIdFromState` bound to the current state. */
  resolveDirect:       (peerUserId: string) => string;
  /** `messagingLogic.isGroupConversation` bound to the current state. */
  isGroupConversation: (conversationId: string) => boolean;
  makeId:              () => string;
  /** Injected so the plan is deterministic under test. */
  now:                 () => number;
}

/** Normalises the legacy `(conversationId, text, peer)` overload. */
export function normaliseSendOptions(
  peerOrOpts: SendTextOptions | {userId: string; deviceId: number} | undefined,
): SendTextOptions {
  return peerOrOpts && 'userId' in peerOrOpts ? {peer: peerOrOpts} : peerOrOpts ?? {};
}

export function planSend(
  conversationId: string,
  opts: SendTextOptions,
  deps: PlanSendDeps,
): SendPlan {
  // 1. Canonicalise before ANY other decision — topology is looked up by id, so
  // resolving afterwards could classify the wrong slot.
  let target = conversationId;
  let canonicalisedFrom: string | undefined;
  if (isDirectPrefixed(target)) {
    const canonical = deps.resolveDirect(peerFromDirectSlot(target));
    if (canonical !== target) {
      canonicalisedFrom = target;
      target = canonical;
    }
  }

  // 2. Topology: caller hint first, then the ONE shared rule.
  const isGroup = opts.isGroup === true || deps.isGroupConversation(target);

  // P2-12 — reuse the bubble sendMedia already appended so status, outbox and
  // reactions all key off one id; otherwise mint a fresh one.
  const msgId = opts.existingMsgId ?? deps.makeId();

  const expiresAtSec = opts.ttlSeconds
    ? Math.floor(deps.now() / 1000) + opts.ttlSeconds
    : undefined;

  // A reply to an empty / media-only / disappeared message can arrive with
  // `preview` undefined. `.slice()` on that used to throw and surface a red
  // "Cannot read property 'slice' of undefined" banner on the chat surface, so
  // coerce: the worst case is an empty preview, not a dead send.
  const replyMeta = opts.replyTo
    ? {msgId: opts.replyTo.messageId, preview: (opts.replyTo.preview ?? '').slice(0, REPLY_PREVIEW_MAX_CHARS)}
    : undefined;

  return {
    conversationId: target,
    ...(canonicalisedFrom ? {canonicalisedFrom} : {}),
    isGroup,
    msgId,
    clientMsgId: msgId,
    sentAt: new Date(deps.now()).toISOString(),
    expiresAtSec,
    replyMeta,
  };
}
