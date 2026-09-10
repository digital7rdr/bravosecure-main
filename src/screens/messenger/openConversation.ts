/**
 * The ONE in-app door from a conversation LIST into a conversation thread.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * PDF A9 / M9 is a locked rule: "No phone/call button appears in Department
 * Channel chat; calls remain in Messenger." The rule is satisfied structurally —
 * department channels have their own screen, `DepartmentChatScreen`, which has
 * no call affordance at all, while `ChatScreen` renders phone and video buttons
 * unconditionally. So the rule is really a ROUTING rule: it holds exactly as
 * long as no path opens a department conversation in `ChatScreen`.
 *
 * A department channel's conversation is stored with `type: 'group'`, exactly
 * like an ordinary group, so the conversation type cannot tell them apart. Every
 * navigate site therefore has to ASK — which is why this is one helper and not a
 * check copied into each screen. It is the repo's most common bug shape (ONE
 * behaviour, N drifted copies, and the fix lands only on the copy that was
 * examined): the notification lane was closed first, and `LinksScreen` was still
 * a live second door into the banned surface.
 *
 * ── WHY THE LIST FILTERS ARE NOT ENOUGH ─────────────────────────────────────
 *
 * `MessengerHomeScreen` and `GroupsScreen` already hide department channels from
 * their lists, using a `deptGroupIds` set fetched from `departmentApi.listChannels()`
 * on focus. That is a VISIBILITY mitigation with a real gap on both ends:
 *
 *   - the set starts EMPTY and is filled by a network round-trip, so every
 *     department channel is listed and tappable until it resolves (and stays
 *     tappable for the whole session if the call fails or the device is offline);
 *   - both are gated on the `DEPT_CHAT_V2` flag, so with the flag off nothing is
 *     filtered at all;
 *   - `LinksScreen` has no such filter in the first place — its rows come
 *     straight from `loadLinkMessages`, which scans every message on the device.
 *
 * This helper reads the LOCAL store instead, so it answers correctly before any
 * network call resolves, and it answers at the moment of the tap rather than at
 * the moment the list was built.
 *
 * ── WHY THE TWO ARMS NAVIGATE DIFFERENTLY ───────────────────────────────────
 *
 * The ordinary arm keeps the caller's plain in-shell `navigate('Chat', …)`
 * verbatim: that path works today in every shell that mounts these screens, and
 * changing it would be an unforced behaviour change on the flow this fix is not
 * about.
 *
 * The DEPARTMENTAL arms must go through `navigateToMessengerScreen`, because
 * `DepartmentChat` / `DepartmentChannels` are NOT registered on
 * `AgentNavigator`'s root stack — and `GroupsScreen` and `MessengerHomeScreen`
 * are both mounted there. A bare `navigate('DepartmentChat')` from the agency
 * shell is the documented "a screen in 2 shells, a route in 1 -> navigate
 * silently DROPPED" failure. `messengerRouteFor` already classifies both routes
 * as `AGENCY_WORKSPACE_ROUTES` and rewrites them through the Departmental
 * workspace, so using it is reuse, not a new mechanism.
 *
 * Shape deliberately mirrors `navigateToThread` in
 * `src/modules/messenger/push/fcmBootstrap.ts` — same three destinations, same
 * order, same degrade — so the notification lane and the in-app lane cannot
 * drift. If you change one, change the other.
 */
import {navigateToMessengerScreen} from '@navigation/messengerDeepLink';
import {resolveDeptConversation} from '@/modules/messenger/push/deptChannelTarget';
import {useMessengerStore} from '@/modules/messenger/store';
import {markChatOpenTap} from './chatOpenPerf';

/**
 * The shape actually used, kept as documentation for the cast below.
 *
 * The PARAMETER is `unknown`, not this, on purpose. React Navigation's
 * `navigate` is an overloaded generic keyed on each navigator's param list, and
 * TypeScript will not widen it to a `(name: string, params?: unknown)` call
 * signature — passing a typed `NativeStackNavigationProp` at a `NavLike`
 * parameter is a TS2345, which is exactly why the pre-existing `NavLike` call
 * sites in `ChatScreen` and `ChatInfoScreen` sit in the typecheck baseline. This
 * helper is deliberately cross-shell (its whole point is that the three shells
 * register different route sets), so there is no single param list to type it
 * against; it takes `unknown` and casts, the same way
 * `navigateToMessengerScreen(nav as never, …)` already does.
 */
interface NavLike {
  isReady?: () => boolean;
  navigate: (name: string, params?: unknown) => void;
}

export interface ConversationTarget {
  conversationId: string;
  name?: string;
  isGroup: boolean;
  /** Prefilled composer text (mission dock). Ordinary-chat only — a department
   *  channel is opened by channel id and has no draft param. */
  draft?: string;
  /** Land on this message (search hit) — ChatScreen pages older history in
   *  until the id is loaded, then scroll-and-highlights it. */
  focusMessageId?: string;
}

/**
 * Open a conversation from a list row, routing department channels to the
 * departmental surface instead of `ChatScreen`.
 *
 * Three destinations, matching `deptChannelTarget`'s three states:
 *   not departmental          -> Chat (unchanged)
 *   departmental + channel id -> DepartmentChat
 *   departmental, id unknown  -> the DepartmentChannels directory
 *
 * The third is a DEGRADE, not a fallback to Chat: a channel this device has
 * never opened has no `deptGroupByChannel` pointer row, and opening it in
 * ChatScreen would put the banned call buttons on screen — the whole bug. One
 * tap from the directory reopens it with the full param set the screen wants.
 */
export function openConversation(nav: unknown, target: ConversationTarget): void {
  const dept = resolveDeptConversation(target.conversationId, useMessengerStore.getState());
  if (dept?.channelId) {
    navigateToMessengerScreen(nav as never, 'DepartmentChat', {
      channelId:           dept.channelId,
      channelName:         target.name ?? '',
      channelDesc:         '',
      groupConversationId: target.conversationId,
    }, {initial: false});
    return;
  }
  if (dept) {
    navigateToMessengerScreen(nav as never, 'DepartmentChannels', {}, {initial: false});
    return;
  }
  // B-691/F4 — stamp the tap so ChatScreen's [chat.open] bracket can report
  // true tap→transitionEnd, not just mount→transitionEnd.
  markChatOpenTap(target.conversationId);
  (nav as NavLike).navigate('Chat', {
    conversationId: target.conversationId,
    name:           target.name ?? '',
    isGroup:        target.isGroup,
    ...(target.draft === undefined ? {} : {draft: target.draft}),
    ...(target.focusMessageId === undefined ? {} : {focusMessageId: target.focusMessageId}),
  });
}
