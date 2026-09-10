/**
 * B-695 — the call screen's peer name, resolved the way the rest of the app
 * resolves names, against the CANONICAL conversation row.
 *
 * The founder's repro (2026-08-29, "when i call someone it show name but when
 * i minimise the call and return it show CONTACT"): CallScreen navigates with
 * whatever conversationId the launch site held. Mid-call, the B-18 merge can
 * DELETE that row (a synthetic `direct:<peer>` slot dies the moment the
 * server-UUID row for the same peer materializes — messengerStore
 * upsertConversation), so the return-to-call remount looked up a dead id,
 * found nothing, and rendered the bare `?? 'Contact'` fallback — while the
 * avatar, keyed by userId, kept the right face.
 *
 * Two fixes in one place:
 *  1. CANONICALIZE: a missed id falls back to the peer's canonical row
 *     (`resolveDirectConversationIdFromState` — the same rule send/receive/
 *     navigation agree on).
 *  2. THE B-411 LADDER: never render a raw store name that other surfaces
 *     would refuse — `resolveNotifTitle` walks name → directory name → phone,
 *     so 'Contact' survives only for a peer the app genuinely knows nothing
 *     about.
 *
 * Pure and store-shape-typed so the node Jest project can pin it directly
 * (CallScreen itself is unimportable there — the source-scan trap).
 */
import type {LocalConversation} from '../store/types';
import {resolveDirectConversationIdFromState} from '../store/messengerStore';
import {resolveNotifTitle} from '../contacts/notifTitle';

export interface CallPeerNameState {
  conversations: Record<string, LocalConversation>;
  directoryNames?: Record<string, string | undefined>;
}

/** The canonical conversation row for this call, surviving a mid-call B-18 merge. */
export function resolveCallConversation(
  s: CallPeerNameState,
  conversationId: string | undefined,
  remoteUserId: string | undefined,
): LocalConversation | undefined {
  const direct = conversationId ? s.conversations[conversationId] : undefined;
  if (direct) {return direct;}
  if (!remoteUserId) {return undefined;}
  return s.conversations[resolveDirectConversationIdFromState(s, remoteUserId)];
}

export function resolveCallPeerName(
  s: CallPeerNameState,
  conversationId: string | undefined,
  remoteUserId: string | undefined,
): string {
  const convo = resolveCallConversation(s, conversationId, remoteUserId);
  const peerUserId = remoteUserId ?? convo?.peer?.userId;
  const {displayName} = resolveNotifTitle({
    name:           convo?.name,
    name_source:    convo?.name_source,
    is_custom_name: convo?.is_custom_name,
    phoneE164:      convo?.phoneE164,
    peerUserId,
    directoryName:  peerUserId ? s.directoryNames?.[peerUserId] : undefined,
  });
  return displayName ?? 'Contact';
}
