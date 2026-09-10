/**
 * Audit PUSH-B4 (2026-07-02) — suppress chat-wake banners for MUTED
 * conversations. Audit 2026-07-06 M-03/M-04/M-05/F9 — also resolve the
 * local direct-conversation id for a sealed-sender wake, scoped to the
 * CURRENT owner's vault slice only.
 *
 * The FCM display path runs in a headless / killed-app JS VM where the live
 * Zustand store isn't hydrated, so we read the persisted conversation state
 * straight from AsyncStorage (`messenger-store-v1`, shape
 * `{state:{_ownUserId, vaultByOwner:{<owner>:{conversations:{<id>:{is_muted, peer, name}}}}}}`).
 * Mute checks fail OPEN (show the banner) on any read/parse error so a
 * corrupt store never silences messages.
 *
 * N-33 — a single msg-wake previously parsed this (potentially multi-MB) blob
 * 2-3× (resolve + mute + tap-exists). A short-TTL module cache now shares one
 * parse across the burst of lookups a single wake makes, without holding stale
 * state long enough to matter (banners are drawn within ms of the wake).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {resolveNotifTitle, type NameSource} from '../contacts/notifTitle';

interface PersistedConvo {
  is_muted?:     boolean;
  type?:         string;
  // N-12 — locally-derived display name; safe to show in a notification title
  // (it never comes from the wire — same rationale as backgroundMessageNotifier).
  name?:         string;
  // B-411 — name provenance + phone, persisted by the same partialize; feed
  // resolveNotifTitle so a killed-app banner can tag "· Unsaved" and never
  // render the `Bravo · <hex>` placeholder.
  name_source?:    NameSource;
  is_custom_name?: boolean;
  phoneE164?:      string;
  peer?:         {userId?: string};
  // B-231 — persisted per-conversation unread (survives kill; the partialize
  // keeps it, stripping only last_message.content + masterKeyB64).
  unread_count?: number;
}

// N-33 — parse memoization keyed by the raw persisted string. The 2-3 lookups a
// single wake makes (resolve + mute + tap-exists) read identical content, so we
// re-read the (fast) AsyncStorage string each call but only re-run the
// expensive multi-MB JSON.parse when the content actually changed. This can't
// go stale (any real change to the vault produces a different raw string, which
// invalidates the memo) — unlike a time-based cache.
let parseMemo: {
  raw: string;
  convos: Record<string, PersistedConvo> | null;
  dept: PersistedDeptMaps;
} | null = null;

/** F4 — the two departmental maps the same vault slice persists (partialize
 *  writes both; see messengerStore `liveSlice`). Read for the notification-tap
 *  routing decision on a cold boot, where the live store has not hydrated. */
export interface PersistedDeptMaps {
  deptConversationIds?: Record<string, true>;
  /** vs2 edge A9 — conversationId -> owning org, read from the same slice. */
  deptOrgByConversation?: Record<string, string>;
  deptGroupByChannel?: Record<string, string>;
}

interface PersistedSlice {
  conversations?: Record<string, PersistedConvo>;
  deptConversationIds?: Record<string, true>;
  /** vs2 edge A9 — conversationId -> owning org, read from the same slice. */
  deptOrgByConversation?: Record<string, string>;
  deptGroupByChannel?: Record<string, string>;
}

// Why: F9 — vaultByOwner holds EVERY account that ever logged in on this
// device; `_ownUserId` (persisted by the same partialize that keys the live
// slice) identifies the active one. Scanning all slices leaked another
// account's mute state / conversation ids into this account's notifications.
async function readOwnerSlice(): Promise<{convos: Record<string, PersistedConvo> | null; dept: PersistedDeptMaps}> {
  const raw = await AsyncStorage.getItem('messenger-store-v1');
  if (!raw) { parseMemo = null; return {convos: null, dept: {}}; }
  if (parseMemo && parseMemo.raw === raw) {return {convos: parseMemo.convos, dept: parseMemo.dept};}
  const parsed = JSON.parse(raw) as {
    state?: {
      _ownUserId?:   string | null;
      vaultByOwner?: Record<string, PersistedSlice>;
    };
  };
  const owner = parsed?.state?._ownUserId;
  const slice = owner ? parsed?.state?.vaultByOwner?.[owner] : undefined;
  const convos = slice?.conversations ?? null;
  const dept: PersistedDeptMaps = {
    deptConversationIds: slice?.deptConversationIds,
    deptGroupByChannel:  slice?.deptGroupByChannel,
    deptOrgByConversation: slice?.deptOrgByConversation,
  };
  parseMemo = {raw, convos, dept};
  return {convos, dept};
}

async function readOwnerConversations(): Promise<Record<string, PersistedConvo> | null> {
  return (await readOwnerSlice()).convos;
}

/**
 * F4 — the current owner's persisted departmental maps, for a cold-boot
 * notification tap that must decide DepartmentChat vs Chat before the live
 * store hydrates. Empty maps on any read/parse error: an unknown answer degrades
 * to ordinary Chat routing, which is what every build did before.
 */
export async function resolvePersistedDeptMaps(): Promise<PersistedDeptMaps> {
  try {
    return (await readOwnerSlice()).dept;
  } catch {
    return {};
  }
}

export async function isConversationMuted(opts: {
  conversationId?: string;
  senderUserId?:   string;
}): Promise<boolean> {
  if (!opts.conversationId) {return false;}
  try {
    const convos = await readOwnerConversations();
    if (!convos) {return false;}
    // N-11/N-14 — mute ONLY off an explicit/resolved conversationId. The old
    // senderUserId-only fallback inverted mute semantics: muting a person's
    // DM silenced that person's GROUP messages (which resolve to no direct
    // convId, so the loop matched the muted DM anyway) and could never reach a
    // muted group's own flag. Callers pass the resolved direct convId, so 1:1
    // mutes still take effect; group-from-a-muted-contact no longer gets
    // wrongly silenced by the DM's flag.
    return !!convos[opts.conversationId]?.is_muted;
  } catch {
    return false; // fail-open — never silence a message on a read error
  }
}

/**
 * M-03/M-05 — resolve the local direct-conversation id for a sealed-sender
 * msg-wake (which carries only senderUserId). Mirrors the store's
 * resolveDirectConversationIdFromState preference (server-UUID row wins over
 * the synthetic `direct:<peer>` slot) but returns null when NO row exists —
 * a sender with no direct thread is likely a group member, and the push path
 * must never mint a phantom 1:1 thread for them.
 */
export async function resolveDirectConversationId(senderUserId: string): Promise<string | null> {
  return (await resolveDirectConversation(senderUserId))?.id ?? null;
}

/**
 * N-12 — like resolveDirectConversationId but also returns the local display
 * name so the killed/warm FCM banner can be titled with the contact's name
 * (Telegram parity) instead of the generic 'New secure message'.
 *
 * B-411 — `name` is now the RESOLVED display name (placeholder rows map to
 * phone/undefined, never the hex) — safe for call labels and Chat route
 * params; `bannerTitle` is the notification variant, which may carry the
 * "· Unsaved" tag. Undefined lets each caller fall to its own generic.
 */
export async function resolveDirectConversation(
  senderUserId: string,
): Promise<{id: string; name?: string; bannerTitle?: string} | null> {
  if (!senderUserId) {return null;}
  try {
    const convos = await readOwnerConversations();
    if (!convos) {return null;}
    let row: {id: string; c: PersistedConvo} | null = null;
    for (const [id, c] of Object.entries(convos)) {
      if (c?.type !== 'direct' || c?.peer?.userId !== senderUserId) {continue;}
      if (!id.startsWith('direct:')) { row = {id, c}; break; }
      row = row ?? {id, c};
    }
    if (!row) {return null;}
    const resolved = resolveNotifTitle({
      name:           row.c.name,
      name_source:    row.c.name_source,
      is_custom_name: row.c.is_custom_name,
      phoneE164:      row.c.phoneE164,
      peerUserId:     senderUserId,
    });
    return {id: row.id, name: resolved.displayName, bannerTitle: resolved.title};
  } catch {
    return null;
  }
}

/**
 * N-13 — resolve a caller's local display name from their direct thread, for
 * labeling the killed-app incoming-call notification (the wire carries only
 * fromUserId; the warm path already does this from the live store).
 */
export async function resolveDirectPeerName(userId: string): Promise<string | null> {
  return (await resolveDirectConversation(userId))?.name ?? null;
}

/**
 * N-07 — resolve a conversation's display name + group-ness from the persisted
 * slice so a cold-boot notification tap can pass the Chat route its REQUIRED
 * `name`/`isGroup` params (without them ChatScreen crashed on `initials(name)`).
 */
export async function resolveConversationMeta(
  conversationId: string,
): Promise<{name?: string; bannerTitle?: string; isGroup: boolean} | null> {
  if (!conversationId) {return null;}
  try {
    const convos = await readOwnerConversations();
    const c = convos?.[conversationId];
    if (!c) {return null;}
    const isGroup = c.type === 'group' || c.type === 'ops_channel';
    // B-411 — groups bypass the resolver entirely: the tag is a 1:1 concept,
    // and a group the user legitimately named "Bravo · Ops" must not be
    // suppressed by the placeholder pattern.
    if (isGroup) {return {name: c.name, bannerTitle: c.name, isGroup};}
    const resolved = resolveNotifTitle({
      name:           c.name,
      name_source:    c.name_source,
      is_custom_name: c.is_custom_name,
      phoneE164:      c.phoneE164,
      peerUserId:     c.peer?.userId,
    });
    return {name: resolved.displayName, bannerTitle: resolved.title, isGroup};
  } catch {
    return null;
  }
}

/**
 * B-231 — total unread across the current owner's persisted conversations, for
 * the launcher badge on the FCM draw lanes (killed headless, warm-direct, P2-6
 * fallback), where the live store's badge sum isn't available. Matches
 * backgroundMessageNotifier's computation exactly (sum of unread_count across
 * ALL conversations, muted included) so the two lanes agree.
 *
 * The persisted mirror is the app's last-known unread: a killed-window message
 * isn't counted until the app next foregrounds and pulls it (the warm notifier
 * then sets the true count). Returns null on any read/parse error so the caller
 * OMITS the badge (N-17 — never clobber a real launcher count with a guess).
 */
export async function resolveTotalUnread(): Promise<number | null> {
  try {
    const convos = await readOwnerConversations();
    if (!convos) {return null;}
    let total = 0;
    for (const c of Object.values(convos)) {
      total += c?.unread_count ?? 0;
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * M-05 — does a conversation exist in the current owner's persisted slice?
 * Used by the notification tap handler on cold boot, where the live store
 * hasn't hydrated yet, to decide Chat-thread vs Messenger-home navigation.
 */
export async function conversationExists(conversationId: string): Promise<boolean> {
  if (!conversationId) {return false;}
  try {
    const convos = await readOwnerConversations();
    return !!convos?.[conversationId];
  } catch {
    return false;
  }
}
