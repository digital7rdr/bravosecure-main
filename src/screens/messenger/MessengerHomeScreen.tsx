import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, StatusBar, Vibration, TextInput,
  Animated, Image, BackHandler,
  type ListRenderItemInfo,
} from 'react-native';
import {Alert} from '@utils/alert';
import {Swipeable} from 'react-native-gesture-handler';
import {useShallow} from 'zustand/react/shallow';
import {LinearGradient} from 'expo-linear-gradient';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useContentWidth} from '@utils/scaling';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useFocusEffect, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {navigateOnce, NAV_GUARD_MS} from '@navigation/tapGuard';
import {sameIdSet} from '@utils/setEquals';
import {Colors} from '@theme/index';
import {Bravo, BravoFont} from '@/theme/bravo';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {UserAvatar, useUserAvatar} from '@/modules/messenger/ui/UserAvatar';
import {GroupAvatar, useGroupAvatarUri} from '@/modules/messenger/ui/GroupAvatar';
import {AvatarViewer, type AvatarViewTarget} from '@/modules/messenger/ui/AvatarViewer';
import {SponsoredSlot} from '@/modules/messenger/ui/SponsoredSlot';
import {ProfileDrawerModal} from '@components/ProfileDrawerModal';
import {useMessengerStore} from '@/modules/messenger/store';
import type {LocalConversation, LocalMessage} from '@/modules/messenger/store';
import {compareConversationsForList} from './conversationListOrder';
import {lastMessagePreview} from './conversationPreview';
// Founder 2026-08-26 — "same as channels, for Messenger too": the B-636 hit
// list (snippet + highlight) renders under the chat list, and a tap lands ON
// the message via the focusMessageId param.
import {ChannelMessageHits} from '@screens/deptchat/ChannelMessageHits';
import {channelMessageHits, type ChannelMessageHit, type ChannelRef} from '@screens/deptchat/channelMessageSearch';
import {avatarColorFor} from './avatarColors';
import {ConnectionBanner} from '@/modules/messenger/ui/ConnectionBanner';
import RestoreActivityBanner from './RestoreActivityBanner';
import NotificationPermissionBanner from '@components/NotificationPermissionBanner';
import NotificationReliabilityCard from '@components/NotificationReliabilityCard';
import {useMessenger} from '@/modules/messenger/hooks';
import {outgoingTick, type TickKind} from '@/modules/messenger/runtime/messageTicks';
import {conversationApi, tokenStore, departmentApi} from '@services/api';
import {OnlineDot, type OnlineDotState} from '@/modules/messenger/ui/OnlineDot';
import LoadingView from '@components/LoadingView';
import {useAuthStore} from '@store/authStore';
import {useProductStore} from '@store/productStore';
import {UsersHttpClient} from '@bravo/messenger-core';
import {useDiscoveredContacts} from '@/modules/messenger/contacts/useDiscoveredContacts';
import {useRegisteredNames} from '@/modules/messenger/contacts/useRegisteredNames';
import {resolveNotifTitle} from '@/modules/messenger/contacts/notifTitle';
import {drainConversationIntents} from '@/modules/messenger/orgWorkspace/conversationIntents';
import {drainDispatchRoomIntents, isOpsRoomKeyAuthority} from '@/modules/messenger/orgWorkspace/dispatchRoomIntents';
import {
  flushRosterIntents, hasPendingRosterIntent, resolveRosterOverwrite,
} from '@/modules/messenger/runtime/pendingRosterIntents';
import {API_BASE_URL, DEPT_CHAT_V2} from '@utils/constants';
import {formatListTimestamp} from '@utils/helpers';
import {scaleTextStyles} from '@utils/scaling';
import {openConversation} from './openConversation';
import {CallsLogBody} from './CallsLogScreen';
import {NewsHubBody} from '@screens/news/NewsHubScreen';
import {MessengerTabBar, MSG_TAB_HEIGHT, type MsgLocalTab as MessengerLocalTab} from './MessengerTabBar';
import {useIsDeptConversation} from './useDeptConversationFilter';
// B-661 - the shared Channels visibility rule (LITE does not get the tab).
import {canSeeChannels} from './channelsAccess';
import {clearConversationTombstone} from '@/modules/messenger/backup/conversationTombstones';
import {displayRoomName} from '@utils/missionRoomName';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;

// N1 (PDF-2) — the persistent-footer tabs that render their body INLINE (the bar
// never unmounts). Files stays a PUSH (its vault-PIN gate cannot embed) and
// Channels stays a shell exit-hop, so neither is a local tab.
// The inline tabs (Chats / Calls / News) — the type rides with the shared bar.
type MsgLocalTab = MessengerLocalTab;

// Obsidian base from the Bravo Messenger design tokens (tokens.jsx
// `bg: #07090D`). Matches Command Home — the Messenger list is part of
// the same re-skin. Local constant so we don't mutate the app-wide
// Bravo.bg (which other navy screens still use). VISUAL ONLY — no data
// or backend wiring changes on this screen.
const MSG_BG = '#07090D';

// Module-level keyExtractor so FlatList sees a stable function identity
// across renders. Inline arrows allocate a fresh closure per render and
// defeat FlatList's prop diff.
/**
 * Departmental channel group-ids from the last successful fetch, kept for the
 * lifetime of the JS context.
 *
 * Deliberately module-level, not store/persisted state: it is a cache of a
 * server answer, not user data. Seeding the filter with it means re-opening
 * Messenger no longer flashes every department channel into the list for one
 * round-trip before the focus refetch removes them again.
 */
let lastDeptGroupIds: Set<string> = new Set();

const chatListKeyExtractor = (c: LocalConversation): string => c.id;

// Stable empty set — useState bails on Object.is equality, so clearing with a
// fresh `new Set()` would re-render Home every time the search effect ran.
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();
// Same Object.is-bailout trick as EMPTY_ID_SET / the Channels box's NO_HITS.
const EMPTY_HIT_MSGS: ReadonlyArray<import('@/modules/messenger/store').LocalMessage> = [];

/**
 * B-703 MR-14 — how old a server-minted room must be before ONE absence from
 * `/conversations/mine` is allowed to destroy it. The prune is irreversible
 * (rows, media blobs and a durable tombstone, with the envelopes already
 * acked), and the race that reaches it is a list snapshot taken before the
 * server committed the room arriving after its fan-out did. Ten minutes is far
 * longer than that window and costs only one extra list round-trip to converge
 * on a room that really was deleted.
 */
const PRUNE_MIN_AGE_MS = 10 * 60_000;

export default function MessengerHomeScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  // Foldable/large-screen: center the header + chat list in a max-width column
  // so they don't stretch edge-to-edge on an unfolded inner display. Reactive
  // — reflows live on unfold (no-op on a phone, contentMaxWidth == width).
  const {width: winW, isLargeScreen, contentMaxWidth} = useContentWidth(560);
  /**
   * B-661 — the header title sizes itself from the MEASURED window.
   *
   * It used to be a fixed 16 plus `adjustsFontSizeToFit` + `minimumFontScale`.
   * That is why the founder saw "MESSENGER" render TINY on one phone and
   * correctly on another running the same build:
   *   • `minimumFontScale` is IGNORED under the New Architecture, on both
   *     platforms (facebook/react-native#50248, open), so the 0.7 floor never
   *     applied and nothing stopped the shrink;
   *   • `adjustsFontSizeToFit` on Android/Fabric has a history of collapsing
   *     text toward the minimum (#32258) or not resizing at all (#43104).
   * `newArchEnabled=true` here, so this app is in that path.
   *
   * A width band is deterministic and identical on every device. Same remedy as
   * the Secure home header.
   */
  const headerTitleSize = winW >= 430 ? 17 : winW >= 400 ? 16 : winW >= 360 ? 14.5 : 13;

  // Why: M-18 — useShallow so a store commit that leaves every conversation
  // entry identical doesn't re-render Home. The whole-map `presence` and
  // `messages` subscriptions are gone: presence is per-row (RowOnlineDot)
  // and search reads messages via getState() at filter time.
  const conversations     = useMessengerStore(useShallow(s => s.conversations));
  const conversationOrder = useMessengerStore(s => s.conversationOrder);
  const connectionState   = useMessengerStore(s => s.connection);
  // B-46 — destroyed-envelope banner count (session-scoped).
  const undecryptableDrops = useMessengerStore(s => s.undecryptableDropCount);
  const setMuted          = useMessengerStore(s => s.setConversationMuted);
  const setPinned         = useMessengerStore(s => s.setConversationPinned);
  const removeConversation = useMessengerStore(s => s.removeConversation);
  const {runtime}         = useMessenger();
  const ownPhoneE164      = useAuthStore(s => s.user?.phone_e164 ?? null);
  // B-91 M1 R9 — profile drawer (account rows + Switch Dashboard).
  const user = useAuthStore(s => s.user);
  // N4 (PDF-2) — the client reaches Messenger FROM the Secure product shell, so
  // show a "← Secure Services" back chevron that returns to the intact Secure
  // stack. Only the CLIENT shell WRITES activeProduct='secure'; agency/CPO shells
  // never do — so this is client-shell-only in practice (N4's exact scope). The
  // store is persisted and cleared only on sign-out, so the narrow secure-client→
  // provider bridge (pendingProvider, no sign-out) can transiently carry
  // activeProduct='secure' into the agency shell; the chevron then shows but its
  // navigate('SecureTab') is a benign no-op (RN drops it, no SecureTab there) and
  // clears at next sign-out. Not client-shell-only "by construction".
  const inSecureProduct = useProductStore(s => s.activeProduct === 'secure');
  // Secure home.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // N1 (PDF-2) — the footer bar is PERSISTENT: Calls/News render their body
  // INLINE via this local tab state instead of pushing a sibling screen (which
  // unmounted the bar). Chats is the default; Files/Channels are not local tabs.
  const [activeTab, setActiveTab] = useState<MsgLocalTab>('Chats');
  // The pushed Files screen hosts the same bar; a Chats/Calls/News press there
  // pops back here carrying the tab as a route param. Consumed ONCE and cleared,
  // so a later re-focus never replays it (the B-95 stale-param class).
  const route = useRoute<RouteProp<MessengerStackParamList, 'MessengerHome'>>();
  const requestedTab = route.params?.tab;
  useEffect(() => {
    if (!requestedTab) {return;}
    setActiveTab(requestedTab);
    navigation.setParams({tab: undefined});
  }, [requestedTab, navigation]);
  // Founder 2026-08-01 — WhatsApp-style chat multi-select: long-press a row
  // (RN's standard 500ms) enters selection mode, tap toggles, then batch
  // pin / mute / delete from the header toolbar. null = normal browsing.
  const [selectedChats, setSelectedChats] = useState<Set<string> | null>(null);
  const chatSelect = selectedChats !== null;
  // Founder 2026-08-01 — tapping a row's avatar opens the photo full screen.
  const [avatarView, setAvatarView] = useState<AvatarViewTarget | null>(null);
  const onViewAvatar = useCallback((t: AvatarViewTarget) => setAvatarView(t), []);
  const userInitials = (user?.full_name ?? user?.email ?? 'B')
    .split(/[\s@.]/)
    .filter(Boolean)
    .map(w => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'B';

  // WhatsApp-style background contact sync. Mounted in PASSIVE mode so
  // the system permission prompt never fires from Home — only foreground
  // surfaces (NewChatScreen) should ever ask. When the user has already
  // granted contacts permission via the New Message flow, this hook
  // silently re-pairs the address book with the directory and patches
  // any auto-created direct conversation rows whose `name` is still the
  // 8-char userId placeholder ("abc12345") with the user's saved
  // contact label ("Alice"). Without this, a peer who messages us
  // BEFORE we ever opened New Message lands as an unrecognisable UUID
  // row in the chat list — exactly the "I have to enter manually"
  // symptom users hit.
  const usersClient = useMemo(
    () => new UsersHttpClient({
      baseUrl:      API_BASE_URL,
      getToken:     () => tokenStore.get(),
      refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
    }),
    [],
  );
  useDiscoveredContacts({
    users:        usersClient,
    ownPhoneE164,
    enabled:      true,
    passive:      true,
  });
  // B-79 — resolve the peer's REGISTERED Bravo name for any direct chat still on
  // the `Bravo · <hex>` placeholder (peers NOT in the address book). Runs after
  // useDiscoveredContacts so a saved contact name still wins.
  useRegisteredNames({users: usersClient, enabled: true});
  // Track the currently-open Swipeable so opening a second row closes
  // the first — matches iOS behaviour and prevents multiple rows
  // sitting half-open at once.
  const openSwipeRef = useRef<Swipeable | null>(null);
  // Fix #35: hoist the per-row Swipeable refs into a Map keyed by
  // conversation id. Previously each row's `swipeRef` was created
  // inside `.map()` as a fresh `{current: null}` object on every
  // re-render — the ref binding was effectively useless because each
  // render replaced it before the user could open a swipe, and
  // `closeAnd` couldn't find the open Swipeable to close it. The Map
  // gives us stable identity across renders so the close-others
  // behaviour actually works.
  const swipeableMapRef = useRef<Map<string, Swipeable>>(new Map());

  // Track whether the persist middleware has finished restoring conversations
  // from AsyncStorage. Without this we flash the "No conversations yet" empty
  // state for ~50-200ms on cold boot even when history exists.
  const [hydrated, setHydrated] = useState(() => useMessengerStore.persist.hasHydrated());
  useEffect(() => {
    if (hydrated) {return;}
    const unsub = useMessengerStore.persist.onFinishHydration(() => setHydrated(true));
    // Safety — if we mounted after hydration finished, flip immediately.
    if (useMessengerStore.persist.hasHydrated()) {setHydrated(true);}
    return unsub;
  }, [hydrated]);

  // Sync conversations from the server. Without this, the local store only
  // ever holds rooms created on this device, so server-created threads
  // (mission groups, system DMs) never appear.
  //
  // ALSO prunes server-issued conversations the user is no longer a member
  // of — when ops completes a mission, the agent's `conversation_members`
  // row is removed (per ops.service.ts:completeBooking), so the mission
  // group stops appearing in /conversations/mine. Without the prune step
  // the agent's local store kept the row forever and the chat stayed
  // visible from cache. We restrict the prune to UUID-shaped ids so any
  // local-only drafts (non-UUID temp ids) survive a sync round-trip.
  //
  // B-207 — this used to be mount-only (`useEffect`, ran once when `hydrated`
  // and `runtime` first became true), so a room deleted/archived on the
  // server WHILE the app stayed open never disappeared locally: the screen
  // stays mounted in the tab navigator, so switching tabs and back never
  // re-ran it, and a founder-reported "the completed mission's room is still
  // there" turned out to be exactly this — the server-side hard delete had
  // already succeeded, the device just never re-asked. `useFocusEffect` reruns
  // on every return to this screen (same trigger MessengerHomeScreen already
  // uses for the dept-channel list and the M1 key-intent drain), so a
  // deletion/archival now surfaces on the next visit, matching the plan's own
  // acceptance criterion ("room disappears on next messenger-home visit").
  useFocusEffect(useCallback(() => {
    if (!hydrated || !runtime) {return;}
    let cancelled = false;
    void (async () => {
      try {
        const ownId = useMessengerStore.getState()._ownUserId;
        // P1-5 / P1-6 — push any locally-applied roster changes whose server
        // write failed earlier BEFORE pulling, so a successful flush means the
        // roster we pull below is already correct. Whatever stays pending is
        // consulted by the sync guard so the stale server roster can't undo a
        // local crypto add/remove/leave.
        await flushRosterIntents(ownId ?? undefined).catch(() => {});
        if (cancelled) {return;}
        const {data} = await conversationApi.listMine();
        if (cancelled) {return;}
        const upsert = useMessengerStore.getState().upsertConversation;
        const serverIds = new Set<string>();
        // B-224 — /conversations/mine returns every member's registered
        // displayName; the client used to keep it only for the DIRECT row title
        // and DISCARD it for group members, so group event lines, the member
        // list, and bubble senders fell back to a raw-id code ("Member 613949").
        // Capture them into the session directory (lowest-precedence name layer —
        // custom/contact/override still win) so every surface resolves a name.
        const memberNames: Record<string, string> = {};
        for (const c of data.conversations) {
          serverIds.add(c.id);
          /**
           * B-594 — SERVER TRUTH LIFTS A TOMBSTONE.
           *
           * The prune below evicts every UUID-shaped conversation the server
           * no longer lists, and eviction now writes a durable tombstone. That
           * is right for a mission room the server really did hard-delete, and
           * WRONG for one truncated or momentarily mis-scoped `listMine` — the
           * conversation would be skipped by every future restore on this
           * install, with no way for the user to undo it.
           *
           * The server listing it is the strongest possible statement that it
           * is live, so it self-heals here. Idempotent: a no-op for the ids
           * that were never tombstoned, which is nearly all of them.
           */
          clearConversationTombstone(c.id);
          const serverMemberIds = c.members.map(m => m.userId);
          for (const m of c.members) {
            if (m.userId && m.userId !== ownId && m.displayName) {memberNames[m.userId] = m.displayName;}
          }
          const existing = useMessengerStore.getState().conversations[c.id];
          // P1-5 / P1-6 sync guard — while a roster write is pending for this
          // conversation the local participants are authoritative (the crypto
          // change already applied). Preserve them, or skip re-creating a group
          // we just left whose self-removal hasn't landed server-side yet.
          // GF-4 — on a NON-adder device the pending-intent queue is always
          // empty (owner-scoped AsyncStorage on the device that made the
          // change), so the stale server roster used to shrink a just-added
          // member back out of `participants` — the group fan-out set. Crypto
          // membership wins whenever we hold group state.
          const cryptoState = c.kind === 'direct'
            ? undefined
            : useMessengerStore.getState().groups[c.id];
          const guard = resolveRosterOverwrite({
            hasPending:           hasPendingRosterIntent(c.id),
            existingParticipants: existing?.participants,
            serverParticipants:   serverMemberIds,
            cryptoMembers:        cryptoState ? Object.keys(cryptoState.members) : undefined,
          });
          if (guard.skip) {continue;}
          const participants = guard.participants;
          const others = participants.filter(uid => uid !== ownId);
          const peerUid = others[0] ?? c.members[0]?.userId ?? '';
          // Merge the server's authoritative member list into the local
          // row (unless the sync guard above kept the local participants).
          // The previous behaviour ("skip if existing") preserved unread
          // counters but also preserved STALE participants from earlier test
          // runs (e.g. Bob's userId from a prior dispatch), which then drove
          // sendText fan-out to encrypt to the wrong peer. Now: keep local-only
          // fields (unread, mute, pin, ttl) but overwrite the membership +
          // type from the server.
          // B-411 — provenance for the name branch actually taken below:
          // existing name wins → no flag (upsertConversation's stickiness
          // keeps the old one, since the name is unchanged); a NEW direct
          // row named from the server displayName → 'profile' (registered
          // name, so banners tag it Unsaved); generic stubs → no flag.
          const memberDisplayName = c.kind === 'direct'
            ? c.members.find(m => m.userId !== ownId)?.displayName
            : undefined;
          const nameSource = !existing?.name && !c.title && memberDisplayName
            ? ('profile' as const)
            : undefined;
          upsert({
            id: c.id,
            type: c.kind,
            name: existing?.name ?? c.title ?? (c.kind === 'direct'
              ? (memberDisplayName ?? 'Direct chat')
              : 'Group'),
            ...(nameSource ? {name_source: nameSource} : null),
            participants,
            unread_count: existing?.unread_count ?? 0,
            is_muted:     existing?.is_muted     ?? false,
            is_pinned:    existing?.is_pinned    ?? false,
            default_ttl_sec: existing?.default_ttl_sec ?? null,
            created_at:   existing?.created_at   ?? c.createdAt,
            peer: existing?.peer?.userId
              ? existing.peer
              : {userId: peerUid, deviceId: 1},
            session_state: existing?.session_state ?? 'fresh',
            last_message: existing?.last_message,
            // B-411 — this rebuild silently dropped phoneE164/is_custom_name
            // on every Home focus (same class as the B-247 roster wipe).
            phoneE164:      existing?.phoneE164,
            is_custom_name: existing?.is_custom_name,
          });
        }
        // B-224 — fold the harvested member displayNames into the directory in
        // one merge (setDirectoryNames merges, never replaces, so it can't drop
        // names resolved via /users/profiles).
        if (Object.keys(memberNames).length > 0) {
          useMessengerStore.getState().setDirectoryNames(memberNames);
        }
        // Prune local conversations the server no longer returns. Only
        // touch UUID-shaped ids so non-server local-only drafts survive.
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const localIds = Object.keys(useMessengerStore.getState().conversations);
        for (const localId of localIds) {
          if (UUID_RE.test(localId) && !serverIds.has(localId)) {
            const st = useMessengerStore.getState();
            // B-703 MR-14 — a NEWBORN room is not an absent one. This prune
            // deletes the conversation, its messages and its media blobs, and
            // tombstones the id durably; the envelopes were already acked, so
            // there is nothing left to redeliver. That is permanent data loss,
            // and one stale `/conversations/mine` response is all it takes:
            // a snapshot taken before the server committed the room, landing
            // after its fan-out reached this device, describes a room the
            // server has but the response does not.
            //
            // Server-minted rooms (mission Ops Rooms, system channels) are the
            // exposed population — client-minted groups are dashless 32-hex and
            // can never match UUID_RE — and those are exactly the rooms that
            // arrive by fan-out rather than by this list.
            //
            // A grace period costs one extra list round-trip to converge on a
            // genuinely deleted room, and buys back the only case where being
            // wrong is unrecoverable. Anything without a parseable creation
            // time is treated as new: absent evidence must not authorise a
            // destructive write.
            const createdAt = Date.parse(st.conversations[localId]?.created_at ?? '');
            const ageMs = Number.isFinite(createdAt) ? Date.now() - createdAt : 0;
            if (ageMs < PRUNE_MIN_AGE_MS) {continue;}
            // B-207 — when a mission Ops Room is HARD-DELETED server-side, its
            // local group state (and the master key cached with it) must go too.
            // removeConversation only drops the conversation row + messages; it
            // leaves groups[localId] behind, so the key would linger on-device
            // after the room is gone. Evict the crypto state first for pruned
            // UUID group rooms (removeGroupState also disposes the cached key).
            if (st.groups[localId]) {
              st.removeGroupState(localId);
            }
            st.removeConversation(localId);
          }
        }
      } catch { /* transient — try again on next visit */ }
    })();
    return () => { cancelled = true; };
  }, [hydrated, runtime]));

  // RS-02 — drain pending conversation membership intents this device
  // administers: a server-side add/remove only wrote metadata; the actual
  // group rekey (planAddAndRekey / planRemoveAndRekey) happens here, on an
  // admin device. Fire-and-forget; the drain coalesces concurrent calls and
  // leaves intents it cannot act on pending for the right device.
  useEffect(() => {
    if (!hydrated || !runtime) {return;}
    void drainConversationIntents().catch(() => {});
  }, [hydrated, runtime]);

  // M1 (B-207) — widen the mission Ops-Room intent drain beyond the AgentDashboard
  // mount: if an authority device opens the messenger but never lands on the
  // dashboard, newly-crewed managers/CPOs (and the client) stay keyless. Drain on
  // messenger-home FOCUS too.
  //
  // B-416 — widened from STRICTLY-the-owner to the ONE shared authority
  // predicate (owner OR delegated manager — isOpsRoomKeyAuthority, the
  // drain's own gate re-verifies it). The single-mint safety this trigger's
  // old owner-only comment defended (G-06 fork) moved to the SERVER'S
  // ATOMIC per-room claim inside the drain, so firing the drain from a
  // manager device is safe by construction: it stands down on any room it
  // didn't claim. B-210's is_org_manager trap remains documented in the
  // predicate itself. Coalesces with the dashboard trigger via the drain's
  // own in-flight guard, so overlap is safe.
  const isOpsRoomAuthority = isOpsRoomKeyAuthority(user);
  useFocusEffect(
    useCallback(() => {
      if (!hydrated || !runtime || !isOpsRoomAuthority) {return;}
      void drainDispatchRoomIntents().catch(() => {});
    }, [hydrated, runtime, isOpsRoomAuthority]),
  );

  const [query, setQuery] = useState('');
  // Fix #36: debounce the actual search input. Without this, every
  // keystroke ran the filter — for a 100-conversation list with the
  // last 30 messages each, that's ~3000 string ops per keystroke.
  // 150 ms swallows the burst (typical typing cadence is 100-200 ms
  // between strokes) so we filter once per word, not once per letter.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  // Hide departmental-channel groups from the Messenger list. A dept channel is an internal E2EE
  // Signal group whose conversation lives in the same store, but it must only appear in the
  // Departmental module's Channels tab — never here. Exclude any conversation whose id is a dept
  // channel's group_conversation_id (the server-authoritative set). Flag-gated; a non-dept user's
  // listChannels 403s → empty set → nothing filtered.
  const [deptGroupIds, setDeptGroupIds] = useState<Set<string>>(() => lastDeptGroupIds);
  // Refetch on every FOCUS, not just mount — a channel created while this
  // screen was already mounted (or created before it, then navigated back to)
  // used to leak into the Messenger list until the whole app remounted, since
  // a mount-only effect never learns about a group_conversation_id minted
  // after it last ran.
  useFocusEffect(
    useCallback(() => {
      if (!DEPT_CHAT_V2) {return;}
      let cancelled = false;
      void (async () => {
        try {
          const {data} = await departmentApi.listChannels();
          if (!cancelled) {
            const next = new Set(data.channels.map(c => c.group_conversation_id).filter((x): x is string => !!x));
            // NAV-18 (2026-08-26 audit) — keep the previous Set IDENTITY when
            // the ids are unchanged (the overwhelmingly common focus). An
            // unconditional setDeptGroupIds(new Set) invalidated the `ordered`
            // memo below on EVERY return to this screen, forcing a full
            // map/filter/sort + FlatList re-render while the pop animation was
            // still running.
            setDeptGroupIds(prev => {
              const chosen = sameIdSet(prev, next) ? prev : next;
              lastDeptGroupIds = chosen;
              return chosen;
            });
            // Scope v2 Phase 4 — MID-SESSION REFRESH of the vault refusal registry.
            //
            // NOT the boot arming. That lives in MainNavigator's owner-set
            // effect, because a Chat deep link passes `initial: false` and seeds
            // this screen BENEATH the pushed Chat — mounted, never focused, so
            // this effect does not run on the cold notification tap; and in the
            // Agent shell this route never mounts at all. Do not delete the
            // MainNavigator arming on the strength of this one.
            //
            // Kept because it is free: this screen already resolves exactly
            // these ids on every focus (to hide dept channels from the chat
            // list) and then discarded them. Additive and idempotent — immer
            // returns the same root reference when every id is already known, so
            // re-arming triggers no re-render.
            const store = useMessengerStore.getState();
            for (const id of next) { store.rememberDeptConversation(id); }
          }
        } catch { /* not a dept member / flag off — leave the set empty */ }
      })();
      return () => { cancelled = true; };
    }, []),
  );

  // The network set above cannot hide anything until its request lands — empty
  // on cold boot, empty all session offline, empty on a 403. This asks the
  // PERSISTED store registry instead, so channels are filtered on the very
  // first paint. Same function the notification tap uses to decide routing.
  const isDept = useIsDeptConversation();

  const ordered = useMemo<LocalConversation[]>(
    () => conversationOrder
      .map(id => conversations[id])
      .filter((c): c is LocalConversation => !!c && !deptGroupIds.has(c.id) && !isDept(c.id))
      // B-78 — sort by real last-message time (pinned first) rather than trust
      // conversationOrder's move-to-front order, which a bulk restore scrambles.
      .sort(compareConversationsForList),
    [conversationOrder, conversations, deptGroupIds, isDept],
  );

  // Fix #36 (cont.): cache each conversation's searchable haystack so
  // we don't rebuild it on every filter pass. Keyed by conversation
  // id; the cache key includes a coarse signature (name + last
  // message id + message count) so it invalidates only when something
  // search-relevant changes. Per-conversation entries also cache the
  // toLocaleLowerCase() result so the case-fold is paid once.
  const searchableCacheRef = useRef<Map<string, {sig: string; hay: string}>>(new Map());
  const searchableFor = (c: LocalConversation): string => {
    // Why: M-18 — read messages via getState() instead of subscribing;
    // subscribing re-rendered Home on every append in ANY conversation
    // while search only needs fresh data at (debounced) filter time.
    const msgs = useMessengerStore.getState().messages[c.id] ?? [];
    // Cheap signature — name + peer + count + last id. Excludes
    // message bodies so message edits to old messages don't reflect
    // until the count changes; this is a deliberate trade for speed.
    const sig = [
      c.name ?? '',
      c.peer?.userId ?? '',
      String(msgs.length),
      msgs[msgs.length - 1]?.id ?? '',
      c.last_message?.id ?? '',
    ].join('|');
    const cached = searchableCacheRef.current.get(c.id);
    if (cached && cached.sig === sig) {return cached.hay;}
    const hay = [
      c.name ?? '',
      c.peer?.userId ?? '',
      c.last_message?.content ?? '',
      ...msgs.slice(-30).map(m => m.content ?? ''),
    ].join(' ').toLocaleLowerCase();
    searchableCacheRef.current.set(c.id, {sig, hay});
    return hay;
  };

  /**
   * Founder 2026-08-24 — "search like WhatsApp": a word typed here must find
   * the CONVERSATION it was said in, however deep in history. The in-memory
   * haystack below only covers the last 30 hydrated messages per chat, so
   * this second lane asks SQLCipher for full-history body hits — the exact
   * B-636 machinery the Channels box already uses (`runtime.searchMessages` →
   * `SqlMessageStore.searchContent`, LIKE-escaped, tombstone/expiry-excluded,
   * allow-listed to the conversations THIS list shows). Results arrive as a
   * set of conversation ids that the filter unions in.
   */
  const [bodyHitIds, setBodyHitIds] = useState<ReadonlySet<string>>(EMPTY_ID_SET);
  // The matching rows themselves — rendered as a snippet hit-list under the
  // conversation results, exactly like the Channels box (founder 2026-08-26).
  const [bodyHitMsgs, setBodyHitMsgs] = useState<ReadonlyArray<LocalMessage>>(EMPTY_HIT_MSGS);
  /**
   * B-655 — the allow-list as a STABLE STRING, not `ordered`'s object identity.
   *
   * `ordered` is memoised over `conversations`, which immer replaces on every
   * store commit, so keying the effect on it re-fired a full-history SQLCipher
   * `LIKE` scan for every inbound message while a query was in the box (the
   * 150 ms `debouncedQuery` debounce gates the TEXT, not this). The set of ids
   * almost never changes; its container identity changes constantly. Same
   * pattern as `peerIdsKey` below.
   */
  const orderedIdsKey = useMemo(() => ordered.map(c => c.id).join('|'), [ordered]);
  useEffect(() => {
    const q = debouncedQuery.trim();
    // Same 2-char floor as the Channels box: a 1-char body scan is noise.
    if (q.length < 2 || !runtime?.searchMessages) {
      setBodyHitIds(prev => (prev === EMPTY_ID_SET ? prev : EMPTY_ID_SET));
      setBodyHitMsgs(prev => (prev === EMPTY_HIT_MSGS ? prev : EMPTY_HIT_MSGS));
      return;
    }
    // Why: '' .split('|') is [''] — a bogus id, not an empty allow-list. The
    // B-636 contract makes an empty list return NOTHING (never "no filter"),
    // so the distinction has to be explicit here.
    const conversationIds = orderedIdsKey ? orderedIdsKey.split('|') : [];
    if (conversationIds.length === 0) {
      setBodyHitIds(prev => (prev === EMPTY_ID_SET ? prev : EMPTY_ID_SET));
      setBodyHitMsgs(prev => (prev === EMPTY_HIT_MSGS ? prev : EMPTY_HIT_MSGS));
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const msgs = await runtime.searchMessages?.(q, {
          conversationIds,
          limit: 50,
        }) ?? [];
        if (!alive) {return;}
        setBodyHitIds(new Set(msgs.map(m => m.conversation_id)));
        setBodyHitMsgs(msgs);
      } catch {
        if (alive) {
          setBodyHitIds(EMPTY_ID_SET);
          setBodyHitMsgs(EMPTY_HIT_MSGS);
        }
      }
    })();
    return () => { alive = false; };
  }, [debouncedQuery, orderedIdsKey, runtime]);

  /**
   * Filter by name / phone / most recent message content. Case- and
   * diacritic-blind via toLocaleLowerCase so "Jóse" matches "jose".
   * Empty query short-circuits to the full list.
   */
  const filtered = useMemo<LocalConversation[]>(() => {
    const q = debouncedQuery.trim().toLocaleLowerCase();
    if (!q) {return ordered;}
    return ordered.filter(c => searchableFor(c).includes(q) || bodyHitIds.has(c.id));
    // searchableFor reads messages via getState() (deliberately not a
    // subscription); ordered + debouncedQuery are the user-visible
    // inputs that matter.
  }, [ordered, debouncedQuery, bodyHitIds]);

  // The hit list under the conversations — the SAME pure pipeline as the
  // Channels box: the ref map is the scope boundary (a row whose conversation
  // is not in `ordered` is dropped even if the SQL layer returned it), and
  // buildSnippet re-verifies the match client-side.
  const searchRefMap = useMemo<ReadonlyMap<string, ChannelRef>>(
    () => new Map(ordered.map(c => [
      c.id,
      {channelId: c.id, channelName: c.name ?? c.peer?.userId ?? 'Chat', orgId: null},
    ])),
    [ordered],
  );
  const messageHitSections = useMemo(() => {
    const hits = channelMessageHits(bodyHitMsgs, searchRefMap, debouncedQuery.trim(), 50);
    return hits.length > 0 ? [{orgId: null, hits}] : [];
  }, [bodyHitMsgs, searchRefMap, debouncedQuery]);

  const onOpenHit = useCallback((hit: ChannelMessageHit) => {
    const conv = useMessengerStore.getState().conversations[hit.conversationId];
    openConversation(navigation, {
      conversationId: hit.conversationId,
      name:           hit.channelName,
      isGroup:        conv?.type === 'group',
      focusMessageId: hit.messageId,
    });
  }, [navigation]);
  const messagesLabel = useCallback(() => 'Messages', []);

  // Subscribe to presence for every direct-chat peer so the row avatars
  // carry a live online dot. Bulk subscribe on mount + whenever the
  // conversation list changes; unsubscribe on unmount so the server
  // doesn't keep fanning out updates for chats we're not showing.
  // Fix #34: derive a STRING `peerIdsKey` (sorted, joined). The
  // subscribe effect re-fires only when the string changes — so a
  // reorder of `ordered` (e.g. unread bump moving a chat to the top)
  // doesn't re-subscribe to a presence list that's identical
  // member-wise. We also keep a ref to the current key so we can
  // bail inside the effect if the deps fired but the actual content
  // didn't change.
  const peerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of ordered) {
      if (c.type === 'direct' && c.peer?.userId) {ids.add(c.peer.userId);}
    }
    return Array.from(ids).sort();
  }, [ordered]);
  const peerIdsKey = peerIds.join('|');
  const lastSubscribedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!runtime || peerIds.length === 0) {return;}
    if (lastSubscribedKeyRef.current === peerIdsKey) {return;}
    lastSubscribedKeyRef.current = peerIdsKey;
    runtime.subscribePresence(peerIds);
    const idsForCleanup = peerIds;
    return () => {
      try { runtime.unsubscribePresence(idsForCleanup); } catch { /* ignore */ }
      lastSubscribedKeyRef.current = null;
    };
    // peerIds array identity is intentionally not in deps — the
    // string key is the cheap stable signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, peerIdsKey]);

  // A9/M9 — same reasoning as GroupsScreen: `deptGroupIds` hides dept channels
  // from the list only AFTER `listChannels` resolves (and only while
  // DEPT_CHAT_V2 is on), so the tap destination must re-ask the local store.
  // NAV-10 (2026-08-26 audit) — a rapid mash on one row queued one full
  // openConversation (store scan + dispatch) per tap; drop same-row repeats
  // inside the guard window. A tap on a DIFFERENT row always passes.
  const lastChatTapRef = useRef<{id: string; t: number} | null>(null);
  const goChat  = useCallback((id: string, name: string, isGroup = false) => {
    const now = Date.now();
    const last = lastChatTapRef.current;
    if (last && last.id === id && now - last.t < NAV_GUARD_MS) {return;}
    lastChatTapRef.current = {id, t: now};
    openConversation(navigation, {conversationId: id, name, isGroup});
  }, [navigation]);

  // Stable per-row callbacks. Each row receives the conversation id and
  // calls back here; that way the row component itself doesn't close
  // over `c` and can be memoised against changes to neighbouring rows.
  const onTogglePin   = useCallback((id: string, next: boolean) => setPinned(id, next), [setPinned]);
  const onToggleMute  = useCallback((id: string, next: boolean) => setMuted(id, next), [setMuted]);
  const onRequestDelete = useCallback((c: LocalConversation) => {
    confirmDelete(c, removeConversation);
  }, [removeConversation]);
  const registerSwipeable = useCallback((id: string, r: Swipeable | null) => {
    if (r) {swipeableMapRef.current.set(id, r);}
    else   {swipeableMapRef.current.delete(id);}
  }, []);
  const onSwipeableWillOpen = useCallback((id: string) => {
    const live = swipeableMapRef.current.get(id);
    if (openSwipeRef.current && openSwipeRef.current !== live) {
      openSwipeRef.current.close();
    }
    openSwipeRef.current = live ?? null;
    Vibration.vibrate(8);
  }, []);
  const closeRow = useCallback((id: string) => {
    const live = swipeableMapRef.current.get(id);
    live?.close();
    if (openSwipeRef.current === live) {openSwipeRef.current = null;}
  }, []);

  // ── Chat multi-select (founder 2026-08-01) ─────────────────────────
  // Hardware back exits selection mode; screen handlers register after
  // MainNavigator's root handler so this one wins while mounted+selecting.
  //
  // NAV-04 (2026-08-26 audit) — useFocusEffect, NOT useEffect. This screen
  // stays MOUNTED under every pushed messenger route (Chat, CallsLog,
  // NewsArticle, Files…), RN dispatches hardwareBackPress handlers LIFO, and
  // none of those pushed screens registers one — so a mount-scoped handler
  // here SWALLOWED the first back press on all of them (silently mutating a
  // tab the user couldn't see). Focus-scoped, it unregisters the moment a
  // screen is pushed on top.
  useFocusEffect(useCallback(() => {
    if (!chatSelect) {return;}
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelectedChats(null);
      return true;
    });
    return () => sub.remove();
  }, [chatSelect]));

  // N1 — hardware back from a non-Chats tab returns to Chats. The tab is local
  // state (no stack entry), so without this, Android back would fall through and
  // eject the user out of Messenger instead of stepping back to the chat list.
  // Conflict-free with the selection handler above: selection can only begin on
  // the Chats tab, so `chatSelect` and `activeTab !== 'Chats'` are exclusive.
  // NAV-04 — focus-scoped for the same reason as the selection handler.
  useFocusEffect(useCallback(() => {
    if (activeTab === 'Chats') {return;}
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setActiveTab('Chats');
      return true;
    });
    return () => sub.remove();
  }, [activeTab]));

  const onLongPressRow = useCallback((id: string) => {
    Vibration.vibrate(12);
    setSelectedChats(prev => prev ?? new Set([id]));
  }, []);
  const onToggleSelect = useCallback((id: string) => {
    // Founder 2026-08-01 — every toggle gives haptic feedback, matching the
    // long-press that started the selection.
    Vibration.vibrate(8);
    setSelectedChats(prev => {
      if (!prev) {return prev;}
      const next = new Set(prev);
      if (next.has(id)) {next.delete(id);} else {next.add(id);}
      return next.size === 0 ? null : next;
    });
  }, []);

  const selectedList = useMemo(
    () => (selectedChats ? ordered.filter(c => selectedChats.has(c.id)) : []),
    [ordered, selectedChats],
  );
  const allPinned = selectedList.length > 0 && selectedList.every(c => c.is_pinned);
  const allMuted  = selectedList.length > 0 && selectedList.every(c => c.is_muted);

  // Mixed selections follow the WhatsApp rule: the action applies the
  // POSITIVE state to all (pin/mute everything) unless everything already
  // has it — then it clears it from all.
  const batchPin = useCallback(() => {
    const st = useMessengerStore.getState();
    const ids = selectedChats ? [...selectedChats] : [];
    const pin = !ids.every(id => st.conversations[id]?.is_pinned);
    ids.forEach(id => st.setConversationPinned(id, pin));
    setSelectedChats(null);
  }, [selectedChats]);
  const batchMute = useCallback(() => {
    const st = useMessengerStore.getState();
    const ids = selectedChats ? [...selectedChats] : [];
    const mute = !ids.every(id => st.conversations[id]?.is_muted);
    ids.forEach(id => st.setConversationMuted(id, mute));
    setSelectedChats(null);
  }, [selectedChats]);
  const batchDelete = useCallback(() => {
    const ids = selectedChats ? [...selectedChats] : [];
    if (ids.length === 0) {return;}
    Alert.alert(
      ids.length === 1 ? 'Delete conversation?' : `Delete ${ids.length} conversations?`,
      ids.length === 1
        ? 'This removes the conversation and all its local history from this device. The peer still keeps their copy.'
        : 'This removes these conversations and all their local history from this device. The peers still keep their copies.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Delete', style: 'destructive', onPress: () => {
          const st = useMessengerStore.getState();
          ids.forEach(id => st.removeConversation(id));
          setSelectedChats(null);
        }},
      ],
    );
  }, [selectedChats]);

  const renderChatRow = useCallback(({item: c}: ListRenderItemInfo<LocalConversation>) => {
    // Why: M-18 — pass the peer id, not a presence-derived value; presence
    // frames no longer churn renderChatRow's identity or re-render the list.
    return (
      <ChatListRow
        conv={c}
        peerId={c.type === 'direct' ? c.peer?.userId : undefined}
        onPress={goChat}
        onTogglePin={onTogglePin}
        onToggleMute={onToggleMute}
        onRequestDelete={onRequestDelete}
        registerSwipeable={registerSwipeable}
        onSwipeableWillOpen={onSwipeableWillOpen}
        closeRow={closeRow}
        selecting={chatSelect}
        selected={selectedChats?.has(c.id) ?? false}
        onLongPressRow={onLongPressRow}
        onToggleSelect={onToggleSelect}
        onViewAvatar={onViewAvatar}
      />
    );
  }, [goChat, onTogglePin, onToggleMute, onRequestDelete, registerSwipeable, onSwipeableWillOpen, closeRow, chatSelect, selectedChats, onLongPressRow, onToggleSelect, onViewAvatar]);

  /**
   * B-655 — `FlatList` is a `PureComponent`, so an inline object literal here
   * fails its shallow prop compare and `VirtualizedList` re-renders (and
   * recomputes its cell window) on EVERY parent render — a tab tap, a
   * keystroke, a connection-state change. `data`/`renderItem`/`keyExtractor`
   * are all already stable; this was the one prop defeating the bail-out.
   */
  const chatListContentStyle = useMemo(
    () => ({paddingBottom: insets.bottom + MSG_TAB_HEIGHT + 144}),
    [insets.bottom],
  );

  const channelCount = ordered.length;

  return (
    <View style={[styles.root, {paddingTop: insets.top, backgroundColor: MSG_BG}]}>
      <AmbientBg bg={MSG_BG} />
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* N1 (PDF-2) — the Chats tab: banners + app bar + chat list + compose FAB.
          Calls/News render their body inline below; Files/Channels leave via the
          footer. The MessengerTabBar after this block stays mounted for all.

          ⚠️ B-655 — DO NOT re-introduce a `display:'none'` tab pane here.
          The 2026-08-24 "perf spine" mounted Chats and Calls permanently and
          toggled `display`, to avoid re-paying each tab's mount. It made the
          lag WORSE, for three measured-mechanism reasons:

            1. `display` is a YOGA property. React does not know about it — the
               hidden subtree still renders, still reconciles, and still holds
               every store subscription it declares. So `CallsLogBody`'s
               subscriptions ran on every store commit forever, including while
               the user was on Chats.
            2. Yoga SKIPS layout for a `display:'none'` subtree entirely
               (`YogaLayoutableShadowNode.cpp:729-732`), so flipping back to
               `flex:1` dirties the WHOLE subtree at once — one full layout +
               draw pass on the UI THREAD, at tap time. That is B-279's
               measured "Slow UI thread" bucket, and it is what made the tap
               itself feel slow.
            3. With no conditional, `setActiveTab` re-renders BOTH panes
               synchronously, where the conditional previously rendered `false`
               for the whole inactive one.

          The mount this conditional re-pays is now cheap because the calls log
          is virtualised (see CallsLogScreen's FlatList) — that pairing is the
          actual fix, and neither half works alone. Full audit:
          docs/audits/MESSENGER_LAG_AUDIT_2026-08-24.md */}
      {activeTab === 'Chats' && (
      <>
      {/* N-31 — surface a blocked notification permission instead of failing silent. */}
      <NotificationPermissionBanner />
      {/* P2-BR-1 — battery-optimization exemption / OEM auto-start prompt. */}
      <NotificationReliabilityCard />
      <ConnectionBanner state={connectionState} />
      {/* BR-1 — background restore progress. History streams in
          batch-by-batch underneath while the user keeps chatting. */}
      <RestoreActivityBanner />
      {/* B-46 — destroyed-envelope disclosure. Sealed sender means an
          undecryptable envelope has no known sender, so a per-thread
          placeholder is impossible; this counter banner is the ceiling
          of what the device can honestly disclose. Tap to dismiss. */}
      {undecryptableDrops > 0 && (
        <TouchableOpacity
          style={styles.dropBanner}
          onPress={() => useMessengerStore.getState().clearUndecryptableDrops()}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss undecryptable-messages notice">
          <Icon name="alert-circle-outline" size={13} color="#FBBF24" />
          <Text style={styles.dropBannerText}>
            {undecryptableDrops === 1
              ? 'A message sent while you were away couldn’t be decrypted. Ask the sender to resend it.'
              : `${undecryptableDrops} messages sent while you were away couldn’t be decrypted. Ask the senders to resend.`}
          </Text>
        </TouchableOpacity>
      )}

      {/* ── Header ───────────────────────────────────────────── */}
      {/* item 12 — the root only applies insets.top, so in landscape on a
          notched device the right action pills sat under the cutout. The header
          is the only row with controls flush to the right edge, so it carries
          the horizontal inset itself rather than re-padding the whole screen
          (which would inset the chat list too, and it does not need it). */}
      <View style={[
        styles.headerWrap,
        {paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right},
        isLargeScreen && {maxWidth: contentMaxWidth, alignSelf: 'center', width: '100%'},
      ]}>
        {chatSelect ? (
          /* Selection toolbar — replaces the app bar while chats are selected
             (founder 2026-08-01): count + batch Pin / Mute / Delete. */
          <View style={styles.headerTop}>
            <View style={styles.headerLeft}>
              <TouchableOpacity
                style={styles.iconPill}
                onPress={() => setSelectedChats(null)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Exit selection">
                <Icon name="close" size={17} color={'#F2F4F8'} />
              </TouchableOpacity>
              <View style={{marginLeft: 8}}>
                <Text style={styles.headerTitle}>{selectedList.length} SELECTED</Text>
                <Text style={styles.headerSubtitle}>PIN · MUTE · DELETE</Text>
              </View>
            </View>
            <View style={styles.headerActions}>
              <TouchableOpacity
                style={styles.iconPill}
                onPress={batchPin}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={allPinned ? 'Unpin selected chats' : 'Pin selected chats'}>
                <Icon name={allPinned ? 'pin-off-outline' : 'pin-outline'} size={17} color={'#F2F4F8'} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.iconPill}
                onPress={batchMute}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={allMuted ? 'Unmute selected chats' : 'Mute selected chats'}>
                <Icon name={allMuted ? 'bell-outline' : 'bell-off-outline'} size={17} color={'#F2F4F8'} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.iconPill, styles.iconPillDanger]}
                onPress={batchDelete}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Delete selected chats">
                <Icon name="trash-can-outline" size={18} color={'#F87171'} />
              </TouchableOpacity>
            </View>
          </View>
        ) : (
        <View style={styles.headerTop}>
          <View style={styles.headerLeft}>
            {/* N4 (PDF-2) — a client who entered Messenger from the Secure
                product gets a back chevron to that intact stack. navigate hops
                up to the Main tab nav's sibling SecureTab (a screen nav has no
                such route locally, so RN bubbles it). flexShrink:0 so it never
                eats the title's item-12 shrink (messengerHeaderFit pin). */}
            {inSecureProduct && (
              <TouchableOpacity
                style={styles.headerBackBtn}
                activeOpacity={0.7}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                accessibilityRole="button"
                accessibilityLabel="Back to Secure Services"
                onPress={() => navigateOnce(navigation, 'SecureTab' as never)}>
                <Icon name="chevron-left" size={22} color={'#F2F4F8'} />
              </TouchableOpacity>
            )}
            {/* B-91 M1 R9 — profile drawer entry (spec p.12): account rows +
                the only sanctioned cross-product switch live behind it. */}
            <TouchableOpacity
              style={styles.headerAvatarBtn}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Open profile drawer"
              onPress={() => setDrawerOpen(true)}>
              {user?.avatar_url ? (
                <Image source={{uri: user.avatar_url}} style={styles.headerAvatarImg} />
              ) : (
                <Text style={styles.headerAvatarText}>{userInitials}</Text>
              )}
            </TouchableOpacity>
            {/**
             * Client 2026-08-22 — "the entire word MESSENGER is gone", and worse
             * with the back chevron showing.
             *
             * The row is avatar + mark + title + tier chip + three action pills,
             * and only the title could shrink, so it was the one that
             * ellipsised — down to "M…". The mark is the cheapest thing to drop:
             * it is decorative (a message glyph next to the word MESSENGER) and
             * the avatar beside it already carries the visual weight. It goes
             * whenever the chevron is present, which is exactly the crowded case.
             */}
            {!inSecureProduct && (
              <View style={styles.headerMark}>
                <Icon name="message-processing" size={17} color={'#A9C5FF'} />
              </View>
            )}
            <View style={styles.headerTitleCol}>
              <View style={styles.headerTitleRow}>
                {/* item 12 — numberOfLines turns the flexShrink into an ellipsis
                    instead of a wrap. Without it a shrunk title reflows to two
                    lines and pushes the header taller rather than narrower.
                    Client 2026-08-22 — and shrink-to-fit BEFORE ellipsising, so
                    a narrow phone reads a smaller "MESSENGER" rather than "M…".
                    Same remedy the tab bar uses for its five labels. */}
                <Text
                  style={[styles.headerTitle, {fontSize: headerTitleSize}]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.2}>MESSENGER</Text>
              </View>
            </View>
          </View>
          <View style={styles.headerActions}>
            {/* N5 (PDF-2) — the Groups footer tab was dropped, so the dedicated
                groups-only list keeps a door here (its only remaining one). Group
                conversations themselves still appear in the Chats list. */}
            <TouchableOpacity
              style={styles.iconPill}
              onPress={() => navigateOnce(navigation, 'Groups')}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Group chats">
              <Icon name="account-group-outline" size={17} color={'#F2F4F8'} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconPill} onPress={() => navigateOnce(navigation, 'NewChat')} activeOpacity={0.7}>
              <Icon name="pencil-box-outline" size={17} color={'#F2F4F8'} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconPill} onPress={() => navigateOnce(navigation, 'MessengerSettings')} activeOpacity={0.7}>
              <Icon name="cog-outline" size={17} color={'#F2F4F8'} />
            </TouchableOpacity>
          </View>
        </View>
        )}

        {/* B-263 — the "AES-256 ENCRYPTED · VERIFIED" banner was removed at the
            founder's request. Encryption is unconditional here, so a permanent
            badge announcing it is chrome that costs a row of screen on every
            open and tells the user nothing that ever varies. */}

        {/* Premium search */}
        <View style={styles.search}>
          <Icon name="magnify" size={15} color={'rgba(180,188,204,0.45)'} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search secure messages…"
            placeholderTextColor={Bravo.textFaint}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 ? (
            <TouchableOpacity onPress={() => setQuery('')} activeOpacity={0.7}>
              <Icon name="close-circle" size={15} color={'rgba(180,188,204,0.45)'} />
            </TouchableOpacity>
          ) : (
            <View style={styles.kbdHint}><Text style={styles.kbdHintText}>⌘K</Text></View>
          )}
        </View>

        {/* "Recent · N" row */}
        <View style={styles.recentRow}>
          <Text style={styles.recentLabel}>{debouncedQuery ? `Results · ${filtered.length}` : `Recent · ${channelCount}`}</Text>
          <Text style={styles.recentAction}>Filter →</Text>
        </View>
      </View>

      <View style={[styles.contentCol, isLargeScreen && {maxWidth: contentMaxWidth, alignSelf: 'center'}]}>
      {!hydrated ? (
        <LoadingView label="Loading your chats…" hint="Restoring end-to-end encrypted history from secure storage." />
      ) : ordered.length === 0 ? (
        <EmptyState onStart={() => navigateOnce(navigation, 'NewChat')} />
      ) : filtered.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Icon name="magnify-close" size={32} color="#334155" />
          <Text style={styles.emptyTitle}>No matches</Text>
          <Text style={styles.emptyHint}>Nothing matches "{debouncedQuery}". Try a different phrase.</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={chatListKeyExtractor}
          renderItem={renderChatRow}
          // B-91 M1 R4 — the reserved sponsored slot sits above ALL chats
          // (user-pinned included) and cannot be dismissed. Stable component
          // reference so list re-renders don't remount it.
          ListHeaderComponent={SponsoredSlot}
          // Founder 2026-08-26 — message-body hits (snippet + highlight, the
          // Channels-box treatment) render under the conversation rows while
          // a search is active; a tap lands on the message itself.
          ListFooterComponent={debouncedQuery && messageHitSections.length > 0 ? (
            <ChannelMessageHits
              sections={messageHitSections}
              labelFor={messagesLabel}
              showOrgLabels={false}
              onOpen={onOpenHit}
            />
          ) : null}
          showsVerticalScrollIndicator={false}
          // Virtualization tuned for a chat list: rows measure ~63 dp on a
          // 1080x2400 panel, so about 9 fit between the search header and the
          // tab bar. B-279 — 10 covers that with margin instead of the old 14,
          // which mounted half a screen of rows nobody could see; windowSize 5
          // is viewport + 2 screens either side. The bottleneck here is the UI
          // thread mounting views (measured: GPU idle at 3-7 ms while "Slow UI
          // thread" drove the jank), so resident row count is the lever.
          initialNumToRender={10}
          maxToRenderPerBatch={8}
          windowSize={5}
          removeClippedSubviews
          // Clear the compose FAB when scrolled to the bottom: the FAB top
          // sits at insets.bottom + MSG_TAB_HEIGHT + 72 + 56 (bottom + height),
          // so the last row needs that + a 16 gap or the FAB covers its
          // timestamp/preview.
          contentContainerStyle={chatListContentStyle}
        />
      )}
      </View>

      <TouchableOpacity
        style={[styles.fabWrap, {bottom: insets.bottom + 72 + MSG_TAB_HEIGHT}]}
        onPress={() => navigateOnce(navigation, 'NewChat')}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Compose new message">
        <LinearGradient
          colors={['#A9C5FF', '#5B8DEF', '#2F5BE0']}
          start={{x: 0.3, y: 0.2}}
          end={{x: 0.8, y: 1}}
          style={styles.fab}>
          <View style={styles.fabInnerHighlight} pointerEvents="none" />
          <Icon name="pencil" size={22} color="#FFF" />
        </LinearGradient>
      </TouchableOpacity>
      </>
      )}

      {/* N1 — Calls / News render their body INLINE and CONDITIONALLY, so each
          unmounts on tab switch: nothing keeps subscribing or ticking
          off-screen. `bottomPad` clears the persistent bar.
          See the B-655 note above before changing this to a display toggle. */}
      {activeTab === 'Calls' && <CallsLogBody embedded bottomPad={MSG_TAB_HEIGHT} />}
      {activeTab === 'News' && <NewsHubBody embedded bottomPad={MSG_TAB_HEIGHT} />}

      {/* ── Messenger Footer Tabs (always mounted — the persistent bar) ─────── */}
      <MessengerTabBar
        navigation={navigation}
        insets={insets}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        showChannels={canSeeChannels(user)}
      />

      <ProfileDrawerModal visible={drawerOpen} onClose={() => setDrawerOpen(false)} />

      {/* Full-screen profile photo (founder 2026-08-01) */}
      <AvatarViewer target={avatarView} onClose={() => setAvatarView(null)} />
    </View>
  );
}

/**
 * One row in the chat list — memoised so a `presence` slice update for
 * one peer doesn't re-render every other row. The previous inline
 * .map() allocated a fresh JSX subtree (including its own Swipeable
 * refs and arrow handlers) per conversation on every render, which is
 * what Rank 12 flagged: keystrokes in the search box re-rendered the
 * whole list. The wrapper component closes over stable callbacks the
 * parent hands down, and the comparator below ignores fields the row
 * doesn't visibly depend on.
 */
const ChatListRow = React.memo(function ChatListRow({
  conv: c,
  peerId,
  onPress,
  onTogglePin,
  onToggleMute,
  onRequestDelete,
  registerSwipeable,
  onSwipeableWillOpen,
  closeRow,
  selecting,
  selected,
  onLongPressRow,
  onToggleSelect,
  onViewAvatar,
}: {
  conv: LocalConversation;
  peerId?: string;
  onPress: (id: string, name: string, isGroup: boolean) => void;
  onTogglePin:    (id: string, next: boolean) => void;
  onToggleMute:   (id: string, next: boolean) => void;
  onRequestDelete: (c: LocalConversation) => void;
  registerSwipeable: (id: string, r: Swipeable | null) => void;
  onSwipeableWillOpen: (id: string) => void;
  closeRow: (id: string) => void;
  selecting: boolean;
  selected: boolean;
  onLongPressRow: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onViewAvatar: (t: AvatarViewTarget) => void;
}) {
  const isGroup = c.type !== 'direct';
  // Founder 2026-08-01 — avatar tap opens the photo full screen. Both hooks
  // run unconditionally (rules of hooks); each no-ops on a null id.
  const userAvatarUri = useUserAvatar(isGroup ? undefined : peerId);
  const groupAvatarUri = useGroupAvatarUri(isGroup ? c.id : undefined);
  const rowAvatarUri = isGroup ? groupAvatarUri : userAvatarUri;
  const handleRef = useCallback((r: Swipeable | null) => registerSwipeable(c.id, r), [registerSwipeable, c.id]);
  const handleWillOpen = useCallback(() => onSwipeableWillOpen(c.id), [onSwipeableWillOpen, c.id]);
  const handlePress = useCallback(
    () => {
      if (selecting) {onToggleSelect(c.id); return;}
      onPress(c.id, c.name ?? c.peer?.userId ?? c.id, isGroup);
    },
    [selecting, onToggleSelect, onPress, c.id, c.name, c.peer?.userId, isGroup],
  );
  const handleLongPress = useCallback(() => {
    if (!selecting) {onLongPressRow(c.id);}
  }, [selecting, onLongPressRow, c.id]);
  const handlePin = useCallback(() => {
    closeRow(c.id);
    onTogglePin(c.id, !c.is_pinned);
  }, [closeRow, onTogglePin, c.id, c.is_pinned]);
  const handleMute = useCallback(() => {
    closeRow(c.id);
    onToggleMute(c.id, !c.is_muted);
  }, [closeRow, onToggleMute, c.id, c.is_muted]);
  const handleDelete = useCallback(() => {
    closeRow(c.id);
    onRequestDelete(c);
  }, [closeRow, onRequestDelete, c]);

  return (
    <Swipeable
      ref={handleRef}
      // Selection mode owns the row gestures — a half-open swipe fighting
      // the multi-select toolbar is two conflicting action surfaces.
      enabled={!selecting}
      onSwipeableWillOpen={handleWillOpen}
      friction={2.2}
      overshootFriction={10}
      leftThreshold={70}
      rightThreshold={70}
      renderLeftActions={(progress) => (
        <SwipeActionRevealSingle
          progress={progress}
          bg={'#5B8DEF'}
          icon={c.is_pinned ? 'pin-off' : 'pin'}
          label={c.is_pinned ? 'Unpin' : 'Pin'}
          onPress={handlePin}
          from="left"
        />
      )}
      renderRightActions={(progress) => (
        <View style={styles.swipeRightGroup}>
          <SwipeActionRevealSingle
            progress={progress}
            bg={'#2A3342'}
            icon={c.is_muted ? 'bell' : 'bell-off'}
            label={c.is_muted ? 'Unmute' : 'Mute'}
            onPress={handleMute}
            from="right"
            offset={0}
          />
          <SwipeActionRevealSingle
            progress={progress}
            bg={Bravo.alert}
            icon="trash-can-outline"
            label="Delete"
            onPress={handleDelete}
            from="right"
            offset={1}
          />
        </View>
      )}>
      <TouchableOpacity
        style={[
          styles.row,
          c.is_pinned && styles.rowPinned,
          c.unread_count > 0 && styles.rowActive,
          selected && styles.rowSelected,
        ]}
        onPress={handlePress}
        onLongPress={handleLongPress}
        accessibilityState={{selected}}
        activeOpacity={0.8}>
        <TouchableOpacity
          style={styles.avWrap}
          activeOpacity={0.8}
          // No photo + normal mode → stay inert so the tap falls through to
          // the row press (open the chat) instead of dying on the avatar.
          disabled={!selecting && !rowAvatarUri}
          onPress={() => {
            if (selecting) {onToggleSelect(c.id); return;}
            if (rowAvatarUri) {
              onViewAvatar({
                uri: rowAvatarUri,
                name: rowDisplayName(c),
              });
            }
          }}
          onLongPress={handleLongPress}
          accessibilityLabel={rowAvatarUri ? 'View profile photo full screen' : undefined}>
          {/* B-253 — show the peer's profile photo when they have one. Groups
              keep the initials disc: a group has no single face, and its own
              picture is a separate feature. */}
          {/* B-291 — groups now HAVE a picture, so the "separate feature" note
              above is settled: a group row resolves through GroupAvatar, a
              person's through UserAvatar, and both fall back to the same
              coloured disc this row has always drawn. */}
          {isGroup ? (
            <GroupAvatar
              groupId={c.id}
              size={46}
              fallback={
                <View style={[styles.groupAv, {backgroundColor: avatarBg(c)}]}>
                  <Text style={styles.avText}>{initialsOf(c)}</Text>
                </View>
              }
            />
          ) : (
            <UserAvatar
              userId={peerId}
              size={46}
              fallback={
                <View style={[styles.personAv, {backgroundColor: avatarBg(c)}]}>
                  <Text style={styles.avText}>{initialsOf(c)}</Text>
                </View>
              }
            />
          )}
          {/* B-263 — the verified check is gone; the avatar corner now carries
              ONLY live presence. The check was unconditional (every 1:1 row got
              one), so it conveyed nothing and, worse, sat in the same SE corner
              as the presence dot — the one badge there that does vary. */}
          {/* Selection mode borrows that same corner for the check badge —
              presence hides while selecting so the two never stack. */}
          {!isGroup && !selecting && <RowOnlineDot peerId={peerId} />}
          {selected ? (
            <View style={styles.selBadge}>
              <Icon name="check-bold" size={11} color="#FFF" />
            </View>
          ) : null}
        </TouchableOpacity>
        <ConvBody
          name={rowDisplayName(c)}
          handle={isGroup ? 'GROUP' : 'DEV'}
          preview={previewOf(c)}
          previewKind={previewKindOf(c)}
          time={timeOf(c)}
          unread={c.unread_count}
          // B-131 — the tick describes whether the PEER received/read MY last
          // message. It used to be `unread_count === 0`, which means "*I* have
          // no unread incoming" and says nothing about the peer — so every
          // conversation with a cleared badge drew a blue double tick even when
          // the chat screen correctly showed a single one. Same rule as the
          // bubble now, imported rather than re-derived.
          tick={outgoingTick(c.last_message)}
          read={c.unread_count === 0}
          muted={c.is_muted}
          pinned={c.is_pinned}
        />
      </TouchableOpacity>
    </Swipeable>
  );
}, (prev, next) => {
  // Compare only the visible bits. Presence never flows through props —
  // RowOnlineDot subscribes to its own peer's entry — so identity
  // equality on the conversation reference is the cheap first gate
  // (Zustand+immer returns a NEW conv object when any of its fields
  // change).
  if (prev.conv   !== next.conv)   {return false;}
  if (prev.peerId !== next.peerId) {return false;}
  // Multi-select visuals — a row must repaint when the mode or its own
  // selection flips.
  if (prev.selecting !== next.selecting) {return false;}
  if (prev.selected  !== next.selected)  {return false;}
  // Stable callbacks from the parent — identity check is enough.
  return (
    prev.onPress             === next.onPress &&
    prev.onTogglePin         === next.onTogglePin &&
    prev.onToggleMute        === next.onToggleMute &&
    prev.onRequestDelete     === next.onRequestDelete &&
    prev.registerSwipeable   === next.registerSwipeable &&
    prev.onSwipeableWillOpen === next.onSwipeableWillOpen &&
    prev.closeRow            === next.closeRow &&
    prev.onLongPressRow      === next.onLongPressRow &&
    prev.onToggleSelect      === next.onToggleSelect &&
    prev.onViewAvatar        === next.onViewAvatar
  );
});

function EmptyState({onStart}: {onStart: () => void}) {
  return (
    <View style={styles.emptyWrap}>
      <ImageryBackdrop source={Imagery.messengerExec} variant="card" />
      <View style={styles.emptyIconWrap}>
        <Icon name="message-lock-outline" size={44} color="#334155" />
      </View>
      <Text style={styles.emptyTitle}>No conversations yet</Text>
      <Text style={styles.emptyHint}>
        Start a new end-to-end encrypted chat. Messages never touch our servers in plaintext.
      </Text>
      <TouchableOpacity style={styles.emptyBtn} onPress={onStart} activeOpacity={0.85}>
        <Icon name="pencil-box-outline" size={16} color="#FFF" />
        <Text style={styles.emptyBtnText}>New message</Text>
      </TouchableOpacity>
    </View>
  );
}

type PreviewKind = 'text' | 'reply' | 'forward' | 'lock' | 'image' | 'file';

/**
 * B-131 — the row's delivery tick. The RULE lives in runtime/messageTicks.ts and
 * is shared with the chat bubble; only the visual mapping is local (this row is
 * smaller and single-coloured, the bubble uses the muted/glow brand tokens).
 * Keeping the rule shared is what stops the two surfaces disagreeing again.
 */
function ConvTick({kind}: {kind?: TickKind}) {
  switch (kind) {
    case 'single':
      return <Icon name="check" size={15} color={'rgba(180,188,204,0.45)'} style={{opacity: 0.85}} />;
    case 'double':
      return <Icon name="check-all" size={15} color={'rgba(180,188,204,0.45)'} style={{opacity: 0.85}} />;
    case 'double-read':
      return <Icon name="check-all" size={15} color={'#5B8DEF'} style={{opacity: 0.85}} />;
    case 'failed':
      return <Icon name="alert-circle" size={15} color={Bravo.alert} style={{opacity: 0.85}} />;
    // 'pending' and 'none' render nothing — an in-flight or incoming last
    // message has no delivery state to report.
    default:
      return null;
  }
}

function ConvBody({name, handle, preview, previewKind, time, unread, read, tick, muted, pinned}: {
  name: string; handle?: string; preview: string; previewKind?: PreviewKind; time: string;
  // `read` = *I* have nothing unread here. Drives the muted preview text only —
  // it is NOT a delivery signal. `tick` is the delivery state of MY last
  // message (B-131); the two were conflated and produced a false double tick.
  unread: number; read: boolean; tick?: TickKind;
  muted?: boolean; pinned?: boolean;
}) {
  return (
    <View style={styles.rowBody}>
      <View style={styles.rowTop}>
        <View style={styles.nameRow}>
          <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
          {handle ? <Text style={styles.rowHandle} numberOfLines={1}>· {handle}</Text> : null}
          {muted  && <Icon name="bell-off" size={12} color={'rgba(180,188,204,0.45)'} />}
          {pinned && <Icon name="pin"      size={12} color={'#5B8DEF'} />}
        </View>
        <Text style={[styles.rowTime, unread > 0 && {color: '#5B8DEF', fontWeight: '600'}]}>{time}</Text>
      </View>
      <View style={styles.rowBottom}>
        <View style={styles.previewRow}>
          <PreviewIcon kind={previewKind ?? 'text'} />
          <Text style={[styles.rowPreview, read && {color: 'rgba(180,188,204,0.45)'}]} numberOfLines={1}>{preview}</Text>
        </View>
        {unread > 0 ? (
          <View style={[styles.badge, muted && {backgroundColor: 'rgba(180,188,204,0.45)', shadowOpacity: 0}]}>
            <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
          </View>
        ) : (
          <ConvTick kind={tick} />
        )}
      </View>
    </View>
  );
}

/**
 * Animated swipe-action pill — the icon + label scale and fade in
 * proportional to how far the row has been dragged. Interpolation is
 * driven by the `progress` Animated.Value that Swipeable hands us.
 * `from='left'` mirrors the X animation for left-rendered actions.
 */
function SwipeActionRevealSingle({
  progress, bg, icon, label, onPress, from, offset = 0,
}: {
  progress: Animated.AnimatedInterpolation<number>;
  bg: string;
  icon: keyof typeof Icon.glyphMap;
  label: string;
  onPress: () => void;
  from: 'left' | 'right';
  offset?: number;  // 0 = outermost (closest to the row edge), higher = further
}) {
  // Stagger multiple right-side actions so the outermost one leads.
  const start = 0.3 + offset * 0.15;
  const scale = progress.interpolate({
    inputRange: [0, start, 1], outputRange: [0.6, 0.9, 1],
    extrapolate: 'clamp',
  });
  const opacity = progress.interpolate({
    inputRange: [0, start, 1], outputRange: [0, 0.5, 1],
    extrapolate: 'clamp',
  });
  const translate = progress.interpolate({
    inputRange: [0, 1],
    outputRange: from === 'left' ? [-30, 0] : [30, 0],
    extrapolate: 'clamp',
  });
  return (
    <Animated.View style={{
      opacity,
      transform: [{translateX: translate}, {scale}],
    }}>
      <TouchableOpacity
        style={[styles.swipeAction, {backgroundColor: bg}]}
        onPress={onPress}
        activeOpacity={0.85}>
        <Icon name={icon} size={20} color="#FFF" />
        <Text style={styles.swipeActionText}>{label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function PreviewIcon({kind}: {kind: PreviewKind}) {
  if (kind === 'reply')   {return <Icon name="reply"         size={12} color={'rgba(180,188,204,0.45)'} />;}
  if (kind === 'forward') {return <Icon name="share-outline" size={12} color={'rgba(180,188,204,0.45)'} />;}
  if (kind === 'lock')    {return <Icon name="lock-outline"  size={12} color={'#4ADE80'}    />;}
  if (kind === 'image')   {return <Icon name="image-outline" size={12} color={'rgba(180,188,204,0.45)'} />;}
  if (kind === 'file')    {return <Icon name="paperclip"     size={12} color={'rgba(180,188,204,0.45)'} />;}
  return null;
}

/**
 * Pick a preview-icon kind from a conversation's last message so
 * the chat row telegraphs what kind of content the user is catching
 * up on. Text messages get no icon (the common case).
 */
function previewKindOf(c: LocalConversation): PreviewKind {
  // `last_message` is typed as the shared `Message` but at runtime we
  // always stuff a `LocalMessage` in via appendMessage. Cast to pick up
  // the reply marker without widening the public type.
  const last = c.last_message as (typeof c.last_message & {reply_to_msg_id?: string}) | undefined;
  if (!last) {return 'lock';}
  if (last.type === 'image') {return 'image';}
  // Audit MSG-13 — audio/video previously fell through to 'text' → the row
  // showed "(encrypted)". Map to the attachment ('file') icon (a distinct
  // audio/video icon would need the row component to learn new kinds); the
  // preview TEXT below disambiguates ("🎤 Voice message" / "🎬 Video").
  if (last.type === 'file' || last.type === 'audio' || last.type === 'video') {return 'file';}
  if (last.reply_to_msg_id)  {return 'reply';}
  if ((last.content ?? '').startsWith('↪ Forwarded')) {return 'forward';}
  return 'text';
}

function confirmDelete(c: LocalConversation, remove: (id: string) => void) {
  Alert.alert(
    'Delete conversation?',
    `This removes "${c.name ?? c.peer?.userId ?? 'this conversation'}" and all its local history from this device. The peer still keeps their copy.`,
    [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Delete', style: 'destructive', onPress: () => remove(c.id)},
    ],
  );
}

/**
 * Presence dot for one chat row. Subscribes narrowly to its OWN peer's
 * presence entry (a primitive-string selector), so a presence frame for
 * peer A re-renders only A's dot — not the screen, not the other rows.
 * Surfaces the full 4-state ladder so `away` peers paint amber rather
 * than green, falling back to the legacy boolean for any record that
 * predates the wider slice. No record at all (never subscribed) hides
 * the dot.
 */
const RowOnlineDot = React.memo(function RowOnlineDot({peerId}: {peerId?: string}) {
  const dot = useMessengerStore((s): OnlineDotState => {
    const rec = peerId ? s.presence[peerId] : undefined;
    if (!rec) {return 'offline';}
    return rec.state ?? (rec.online ? 'online' : 'offline');
  });
  return <OnlineDot state={dot} ringColor={MSG_BG} />;
});

// B-411 — ONE row-title rule (shared with the notification lanes via
// resolveNotifTitle): the `Bravo · <hex>` placeholder and bare-id fragments
// never render; a direct row falls to directory name → phone → 'Bravo user'.
function rowDisplayName(c: LocalConversation): string {
  // Deck page 19 - the legacy mission-room title never reaches a client row.
  if (c.type !== 'direct') {return displayRoomName(c.name) || c.id || '—';}
  const peer = c.peer?.userId;
  const resolved = resolveNotifTitle({
    name:           c.name,
    name_source:    c.name_source,
    is_custom_name: c.is_custom_name,
    phoneE164:      c.phoneE164,
    peerUserId:     peer,
    directoryName:  peer ? useMessengerStore.getState().directoryNames[peer] : undefined,
  });
  return resolved.displayName ?? 'Bravo user';
}

function initialsOf(c: LocalConversation): string {
  // Why: a restored/synced conversation row can land with `name=null` AND
  // `peer=undefined` (group placeholder, partial restore, race against
  // contact discovery). The previous `c.name ?? c.peer.userId` crashed
  // the entire home screen render with "Cannot read property 'userId'
  // of undefined" the moment such a row existed. Walk the fallbacks
  // defensively so the worst case is just a generic placeholder.
  // B-411 — initials derive from the SAME resolved label the row shows, so
  // a placeholder row's disc doesn't spell the hex while the title says
  // the phone/'Bravo user'.
  const s = rowDisplayName(c) || (c.peer?.userId ?? c.id ?? '');
  if (!s) {return '?';}
  return s.split(/\s+/).slice(0, 2).map(p => p[0] ?? '').join('').toUpperCase() || '?';
}

// B-286 — the palette this screen used to own is now shared, so the chat header,
// the calls log and the groups list resolve the SAME colour for the same
// conversation. Why: c.id can be null on a corrupt row (restore mid-flight);
// avatarColorFor handles that rather than throwing.
function avatarBg(c: LocalConversation): string {
  return avatarColorFor(c.id);
}

function previewOf(c: LocalConversation): string {
  // B-662 — routed through the shared rule so call records and
  // delete-for-everyone tombstones read as what they are, not "(encrypted)".
  return lastMessagePreview(c.last_message) ?? 'End-to-end encrypted · start chatting';
}

function timeOf(c: LocalConversation): string {
  const last = c.last_message;
  if (!last) {return '';}
  return formatListTimestamp(last.created_at);
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor: Bravo.bg},
  contentCol: {flex: 1, width: '100%'},
  // B-655 — `tabShown`/`tabHidden` (the display-toggled panes) are GONE; the
  // tab bodies are conditional again. See the note at the Chats pane for why.
  // B-46 — destroyed-envelope disclosure strip (ConnectionBanner warn tone).
  dropBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6,
    borderBottomWidth: 1,
    backgroundColor: 'rgba(251,191,36,0.12)', borderColor: 'rgba(251,191,36,0.3)',
  },
  dropBannerText: {flex: 1, color: '#FBBF24', fontSize: 11, fontWeight: '600'},
  headerWrap: {paddingHorizontal: 16, paddingBottom: 10, paddingTop: 10},
  headerTop: {flexDirection:'row', alignItems:'center', justifyContent:'space-between'},
  /**
   * UI corrections 2026-08-15 item 12 — "The buttons at the top right of the
   * screen is cut off."
   *
   * `headerTop` is `space-between` with two children and NEITHER could shrink:
   * this row had no `flex`, so it took its full intrinsic width (34dp avatar +
   * 10 + 32 mark + 10 + "MESSENGER" at 18px with letterSpacing 1.6 + the tier
   * chip), and `headerActions` was pushed past the right edge. space-between
   * cannot help once the children already overflow — it distributes slack, and
   * there is none.
   *
   * `flex: 1` lets this side yield; `minWidth: 0` is what actually permits the
   * shrink, because a flex child's default `min-width: auto` floors it at its
   * content size and would keep the overflow. Both are required — this is the
   * §3.2 "minWidth:0 on flex children that hold text" rule in DESIGN_REVIEW_LOOP.
   *
   * NOTE both header branches (normal and batch-select) share these style
   * objects, so this is one fix for both — the batch branch is the narrower
   * case, with three action pills.
   */
  headerLeft: {flex: 1, minWidth: 0, flexDirection:'row', alignItems:'center', gap: 10},
  /** The title column inside headerLeft — same reason, one level down. */
  headerTitleCol: {flex: 1, minWidth: 0, marginLeft: 4},
  // N4 — the "← Secure Services" chevron. flexShrink:0 so it holds its width
  // and the title (flexShrink:1) is what yields under pressure — never this.
  headerBackBtn: {flexShrink: 0, alignItems: 'center', justifyContent: 'center', paddingRight: 2},
  headerAvatarBtn: {
    width: 34, height: 34, borderRadius: 17, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
  },
  headerAvatarImg: {width: 34, height: 34, borderRadius: 17},
  headerAvatarText: {color: '#A9C5FF', fontSize: 12, fontWeight: '800'},
  // B-661 - same box as iconPill (34) so every header control matches.
  headerMark: {
    width: 34, height: 34, borderRadius: 11,
    backgroundColor: 'rgba(91,141,239,0.14)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  // flexShrink so a long title yields before the action buttons do. The
  // `numberOfLines={1}` that turns the shrink into an ellipsis rather than a
  // wrap is a JSX PROP on the <Text>, not a style — a style-shape test cannot
  // see it, which is why the render test asserts the prop directly.
  headerTitle: {flexShrink: 1, fontFamily: BravoFont.display, color: '#F2F4F8', fontSize: 16, fontWeight: '700', letterSpacing: 1.1, lineHeight: 19},
  headerTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1},
  // flexShrink: 0 IS load-bearing here even though Yoga already defaults to 0 —
  // the chip sits inside a row that now shrinks, and stating it stops a later
  // "add flexShrink:1 everywhere" sweep from squashing a 4-glyph badge instead
  // of the 9-character title beside it.
  headerSubtitle: {fontFamily: BravoFont.mono, color: 'rgba(180,188,204,0.45)', fontSize: 9, letterSpacing: 1.2, marginTop: 3, textTransform: 'uppercase'},
  headerActions: {flexDirection: 'row', alignItems: 'center', gap: 8},
  // B-661 - 38 -> 34, matching headerMark. Three pills, so this hands 12dp
  // back to the title, which is where the founder needed it.
  iconPill: {
    width: 34, height: 34, borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
    alignItems: 'center', justifyContent: 'center',
  },

  search: {
    marginTop: 16,
    minHeight: 44, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 8,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
  },
  searchHint: {color:'rgba(229,233,242,0.62)', fontSize:11, fontWeight:'800', letterSpacing:2},
  searchInput: {flex:1, color: '#F2F4F8', fontSize: 14, fontFamily: BravoFont.sans, letterSpacing: 0.2, padding: 0},
  kbdHint: {
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
  },
  kbdHintText: {fontFamily: BravoFont.mono, fontSize: 10, color: 'rgba(180,188,204,0.45)', letterSpacing: 0.5},

  recentRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12},
  recentLabel: {fontFamily: BravoFont.mono, color: 'rgba(229,233,242,0.62)', fontSize: 10.5, fontWeight: '600', letterSpacing: 1.8, textTransform: 'uppercase'},
  recentAction: {fontFamily: BravoFont.sans, color: 'rgba(180,188,204,0.45)', fontSize: 11, fontWeight: '500'},

  sectionLabel: {color: 'rgba(229,233,242,0.62)', fontSize: 10.5, fontFamily: BravoFont.mono, fontWeight: '600', letterSpacing: 1.8, textTransform: 'uppercase', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6},
  // Row — more breathing room + no harsh divider. Spacing between rows
  // comes from the `marginVertical` and an optional active/pinned bg.
  row: {flexDirection:'row', alignItems:'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14, borderLeftWidth: 3, borderLeftColor: 'transparent'},
  avWrap: {position:'relative', width: 46, height: 46},
  groupAv: {width: 46, height: 46, borderRadius: 13, alignItems:'center', justifyContent:'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)'},
  personAv: {width: 46, height: 46, borderRadius: 23, alignItems:'center', justifyContent:'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)'},
  avText: {fontFamily: BravoFont.display, color: '#FFF', fontSize: 16, fontWeight: '700'},
  rowBody: {flex: 1, minWidth: 0},
  rowTop: {flexDirection: 'row', alignItems: 'baseline', gap: 6, marginBottom: 3},
  nameRow: {flexDirection: 'row', alignItems: 'baseline', gap: 6, flex: 1},
  rowName: {fontFamily: BravoFont.display, color: '#F2F4F8', fontSize: 15, fontWeight: '600', letterSpacing: -0.15, flexShrink: 1},
  rowTime: {fontFamily: BravoFont.mono, color: 'rgba(180,188,204,0.45)', fontSize: 10, letterSpacing: 0.3, flexShrink: 0},
  rowBottom: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8},
  rowPreview: {fontFamily: BravoFont.sans, color: 'rgba(229,233,242,0.62)', fontSize: 12.5, letterSpacing: -0.1, flex: 1},
  badge: {
    minWidth: 20, minHeight: 20, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2,
    backgroundColor: '#5B8DEF',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#5B8DEF', shadowOffset: {width: 0, height: 3}, shadowOpacity: 0.45, shadowRadius: 10, elevation: 4,
  },
  badgeText: {fontFamily: BravoFont.sans, color: '#FFF', fontSize: 11, fontWeight: '700'},

  emptyWrap: {alignItems:'center', paddingVertical:60, paddingHorizontal:32, gap:12, flex:1, justifyContent:'center'},
  emptyIconWrap: {width:80, height:80, borderRadius:40, backgroundColor:'rgba(91,141,239,0.08)', borderWidth:1, borderColor:'rgba(255,255,255,0.06)', alignItems:'center', justifyContent:'center', marginBottom:8},
  emptyTitle: {color:'#F2F4F8', fontSize:15, fontWeight:'700'},
  emptyHint: {color:'rgba(229,233,242,0.62)', fontSize:12, textAlign:'center', lineHeight:18, maxWidth:300},
  emptyBtn: {marginTop:12, flexDirection:'row', alignItems:'center', gap:6, paddingHorizontal:20, paddingVertical:10, borderRadius:99, backgroundColor:Colors.primary},
  emptyBtnText: {color:'#FFF', fontSize:12, fontWeight:'800', letterSpacing:1.5},

  // Wrapper carries the absolute position + drop shadow; the gradient
  // fill lives inside so the shadow doesn't clip the radial highlight.
  fabWrap: {
    position: 'absolute', right: 22,
    width: 56, height: 56, borderRadius: 28,
    shadowColor: '#5B8DEF', shadowOffset: {width: 0, height: 12}, shadowOpacity: 0.55, shadowRadius: 24, elevation: 10,
  },
  fab: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    overflow: 'hidden',
  },
  fabInnerHighlight: {
    position: 'absolute', top: 2, left: 2, right: 2, bottom: '55%',
    borderRadius: 27,
    borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.35)',
  },

  rowHandle: {flexShrink: 1, minWidth: 0, fontFamily: BravoFont.mono, color: 'rgba(180,188,204,0.45)', fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase'},
  previewRow: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0},


  // Chat-list swipe actions + active-row state
  rowActive: {
    backgroundColor: 'rgba(91,141,239,0.06)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.12)',
  },
  rowPinned: {backgroundColor:'rgba(96,165,250,0.04)'},
  swipeAction: {width:88, alignItems:'center', justifyContent:'center', gap:4, paddingHorizontal:8},
  swipeActionText: {color:'#FFF', fontSize:10, fontWeight:'800', letterSpacing:1.2, textTransform:'uppercase'},
  swipeRightGroup: {flexDirection:'row'},

  // Chat multi-select (founder 2026-08-01). The transparent left border on
  // every row keeps layout identical when selection paints the accent bar.
  rowSelected: {
    backgroundColor: 'rgba(91,141,239,0.22)',
    borderLeftColor: '#5B8DEF',
  },
  selBadge: {
    position: 'absolute', bottom: -2, right: -2, width: 18, height: 18, borderRadius: 9,
    backgroundColor: '#5B8DEF', borderWidth: 2, borderColor: MSG_BG,
    alignItems: 'center', justifyContent: 'center',
  },
  iconPillDanger: {backgroundColor: 'rgba(248,113,113,0.08)', borderColor: 'rgba(248,113,113,0.3)'},
}));

// ─── Messenger Footer Tab Bar ─────────────────────────────────────────────────

// The bar itself (MSG_TABS, MessengerTabBar, MSG_TAB_HEIGHT) lives in
// ./MessengerTabBar.tsx — shared with FilesScreen, which hosts the same bar with
// Files lit (client feedback 2026-08-22: "No Nav bar?" on Files).
