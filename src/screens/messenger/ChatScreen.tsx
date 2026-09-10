import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Platform, StatusBar,
  Modal, Pressable, Image, Animated, Easing,
  AppState, FlatList, Keyboard, useWindowDimensions,
  type ListRenderItemInfo,
} from 'react-native';
import {Alert} from '@utils/alert';
// MX-06 — swipe-to-reply runs on the UI thread: PanGestureHandler +
// Animated.event(useNativeDriver) replaces the old PanResponder, whose
// per-frame setValue crossed the JS bridge and stuttered under load.
import {
  PanGestureHandler,
  State as GestureState,
  type PanGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {useContentWidth} from '@utils/scaling';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {EmojiKeyboard} from 'rn-emoji-keyboard';
import * as Clipboard from 'expo-clipboard';
// Founder 2026-08-26 — in-conversation search: same B-636 snippet machinery
// the Channels box and MessengerHome use, scoped to THIS conversation.
import {buildSnippet} from '@screens/deptchat/channelMessageSearch';
import {formatListTimestamp} from '@utils/helpers';
import {launchCamera, launchImageLibrary} from 'react-native-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {readUriBytes, useAttachmentUri, attachmentErrorText, deleteEphemeralSource} from '@/modules/messenger/media';
import {groupSendBlockedReason} from '@/modules/messenger/runtime/messagingLogic';
import {canEditOwnMessage, canDeleteForEveryone} from '@/modules/messenger/runtime/messageMutationGate';
import {findMentionQuery, filterMentionCandidates, insertMention, reconcileMentions, mentionAllCandidate} from '@/modules/messenger/runtime/mentionText';
import {ensureDirectoryNames} from '@/modules/messenger/contacts/directoryNames';
import {isPlaceholderName, resolveNotifTitle} from '@/modules/messenger/contacts/notifTitle';
import {getSavedState, presentSaveContact, type SavedState} from '@/modules/messenger/contacts/savedContacts';
import {memberAddedContentFor, systemEventText} from '@/modules/messenger/runtime/groupEventMessage';
import {UserAvatar} from '@/modules/messenger/ui/UserAvatar';
import {GroupAvatar} from '@/modules/messenger/ui/GroupAvatar';
import {useUploadProgress} from '@/modules/messenger/media/uploadProgress';
import * as ImageManipulator from 'expo-image-manipulator';
import {FileViewer, type ViewableFile} from '@/modules/messenger/ui/FileViewer';
import {MediaPreviewTray} from '@/modules/messenger/ui/MediaPreviewTray';
import {UploadProgressRing} from '@/modules/messenger/ui/UploadProgressRing';
import {normalizePickedAssets, withBatchCaption, MAX_PICKED_ASSETS, type PickedAsset} from '@/modules/messenger/ui/pickedAssets';
import {haptics} from '@utils/haptics';
import {VoiceNoteRecorder} from '@/modules/messenger/ui/VoiceNoteRecorder';
import {Bravo, BravoFont} from '@/theme/bravo';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {PremiumBanner} from '@/modules/messenger/ui/PremiumBanner';
import type {MessengerScreenProps} from '@navigation/types';
import {useIsFocused} from '@react-navigation/native';
import {useActiveConversation} from '@hooks/useActiveConversation';
import {useMessenger} from '@/modules/messenger/hooks';
import {launchCall} from '@/modules/messenger/webrtc/launchCall';
import {useShallow} from 'zustand/react/shallow';
import {tickIcon} from '@/modules/messenger/runtime/tickIcon';
import {useMessengerStore, EMPTY_MESSAGES, selectConversation, directConversationSlots, resolveDirectConversationIdFromState} from '@/modules/messenger/store';
// Founder 2026-08-24 — the forward/share picker offers the whole CONTACT
// directory, not just chats that already exist (it "only picked up my last 2
// chats"). Same passive discovery MessengerHome runs — no permission prompt.
import {useDiscoveredContacts, type DiscoveredRow} from '@/modules/messenger/contacts/useDiscoveredContacts';
import {bucketConversations, contactsWithoutConversation, contactRowName} from './forwardTargets';
import {markLiveArrivals, isLiveArrival} from './liveArrivals';
import {UsersHttpClient} from '@bravo/messenger-core';
import {tokenStore} from '@services/api';
import {API_BASE_URL} from '@utils/constants';
import {resolveDeptConversation} from '@/modules/messenger/push/deptChannelTarget';
import {conversationApi} from '@services/api';
import type {LocalMessage} from '@/modules/messenger/store';
import {
  albumHeight,
  albumTiles,
  stepVisual,
  visualMessageIds,
  type AlbumTile,
} from '@/modules/messenger/ui/imageAlbums';
import {OnlineDot, type OnlineDotState} from '@/modules/messenger/ui/OnlineDot';
import {PeerPresencePill, PeerOfflineBanner} from '@/modules/messenger/ui/PeerPresence';
import {TypingBubble} from '@/modules/messenger/ui/TypingBubble';
import {buildInvertedChatListItems, sameDay, type ChatListItem} from '@/modules/messenger/ui/chatListItems';
import {
  resolvePeer, groupFanoutPeers, chatStatusLabel, chatEmptyStateLabel, isLoopbackMode,
  typingLabel as buildTypingLabel, messageInfoTime, previewForReply,
} from '@/modules/messenger/ui/chatScreenLogic';
import {ConnectionBanner} from '@/modules/messenger/ui/ConnectionBanner';
import {LinkPreviewCard} from '@/modules/messenger/ui/LinkPreviewCard';
import {LinkifiedText} from '@/modules/messenger/ui/LinkifiedText';
import {DEV_CONTACTS} from '@/modules/messenger/dev/devContacts';
import {useAuthStore} from '@store/authStore';
import type {SessionAddress} from '@/modules/messenger/crypto';
import {withScreenErrorBoundary} from '@modules/observability';
import {scaleTextStyles} from '@utils/scaling';
import {groupReactions, reactionRoster, reactionsA11yLabel} from './reactionRoster';
import {avatarGradientFor} from './avatarColors';
import {colorForSender} from './senderColors';
import {sendErrorText} from './sendErrorText';
import {goBackOnce, navigateOnce} from '@navigation/tapGuard';
import {displayRoomName} from '@utils/missionRoomName';
import {useOpenTransitionGate} from '@hooks/useOpenTransitionGate';
import {takeChatOpenTap} from './chatOpenPerf';

type Props = MessengerScreenProps<'Chat'>;

/**
 * Threshold under which consecutive same-sender messages are treated as
 * one "run" — they get tighter spacing + sharper corners facing each
 * other, and only the last bubble carries the timestamp. Matches the
 * feel of WhatsApp's 2-minute window.
 */
// Obsidian base from the Bravo Chat Thread design tokens (tokens.jsx
// `bg: #07090D`). Matches Command Home + the Messenger list — the thread
// is part of the same re-skin. Local constant so the app-wide Bravo.bg
// (used by other navy screens) is untouched. VISUAL ONLY — no messaging,
// crypto, or data wiring changes on this screen.
const CHAT_BG = '#07090D';

// ── Bravo DM Attach design tokens (obsidian + cobalt + signal-green) ──
// Imported from the Claude Design "Bravo — DM & Attach" screen (tokens.jsx).
// Kept LOCAL to this screen so the app-wide Command-Navy `Bravo` theme that
// every other surface depends on is untouched. VISUAL ONLY.
const DM = {
  accent:      '#5B8DEF',
  accentDeep:  '#2F5BE0',
  accentGlow:  'rgba(91,141,239,0.35)',
  accentTint:  'rgba(91,141,239,0.12)',
  accentEdge:  'rgba(91,141,239,0.30)',
  quoteBar:    '#7FA8FF',
  onAccent:    '#A9C5FF',
  signal:      '#4ADE80',
  signalTint:  'rgba(74,222,128,0.08)',
  signalEdge:  'rgba(74,222,128,0.26)',
  hair:        'rgba(255,255,255,0.06)',
  hair2:       'rgba(255,255,255,0.09)',
  text:        '#F2F4F8',
  textDim:     'rgba(229,233,242,0.62)',
  textMute:    'rgba(180,188,204,0.45)',
  textFaint:   'rgba(180,188,204,0.28)',
  recvBubble:  '#18202F',        // obsidian receive bubble (design gradient midpoint)
  glassFill:   'rgba(255,255,255,0.04)',
} as const;
// Outgoing bubble + mic gradients (top→bottom). Cobalt hero surfaces.
const SENT_GRADIENT  = ['#4C86F0', DM.accentDeep] as const;
// Obsidian receive-bubble gradient (design: rgba(30,40,58,.9)→rgba(22,29,43,.85)
// composited over the #07090D bg), straddling DM.recvBubble so both sides of
// the thread share the same lit-from-above material.
const RECV_GRADIENT  = ['#1E2A3C', '#151C29'] as const;
const MIC_GRADIENT   = ['#6E9BF5', DM.accent, DM.accentDeep] as const;
const SHEET_GRADIENT = ['#131A28', '#0C111B'] as const;
// B-286 — the header avatar used to be a FIXED purple for every conversation,
// so it could never agree with the list (which hashes the conversation id).
// The gradient now comes from the shared palette keyed on that same id.

// B-279 — the bubble gradient is painted by the bubble's OWN background
// (`experimental_backgroundImage`, RN 0.76+/Android), not by a child view. The
// `bubbleRadii` helper that used to clip a `<LinearGradient>` underlay to the
// bubble silhouette is gone with it: a background inherits the view's real
// border radii, so the run-grouping corners can no longer drift out of step
// with the StyleSheet variants they were duplicating.
const GROUP_THRESHOLD_MS = 2 * 60_000;
/** Minimum right-swipe in dp that triggers a quick-reply when released. */
const SWIPE_REPLY_THRESHOLD = 60;
/** Quick-react emoji palette shown in the action sheet. */
const QUICK_REACTIONS = ['❤️', '😂', '👍', '🔥', '😮', '😢'];

function timeDeltaMs(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime());
}

/**
 * Deterministic 4-char hex fingerprint derived from a message id — the
 * `SHA:XXXX` badge shown next to incoming bubbles. Not cryptographically
 * meaningful (the real SHA would be computed off the ciphertext at
 * decrypt time); for display it gives each incoming bubble a stable
 * identifier so the recipient can verify two bubbles are "the same".
 */

const TTL_OPTIONS: {label: string; sec: number | null}[] = [
  {label: 'Off',        sec: null},
  {label: '30 seconds', sec: 30},
  {label: '5 minutes',  sec: 300},
  {label: '1 hour',     sec: 3600},
  {label: '24 hours',   sec: 86400},
];

function ttlLabel(sec: number | null): string {
  if (!sec) {return '';}
  if (sec < 60)   {return `${sec}s`;}
  if (sec < 3600) {return `${Math.round(sec / 60)}m`;}
  if (sec < 86400) {return `${Math.round(sec / 3600)}h`;}
  return `${Math.round(sec / 86400)}d`;
}

/**
 * Module-level keyExtractor so FlatList sees a stable function
 * reference across renders. The list is a mix of messages, day
 * separators and an unread divider — each item carries its own
 * pre-computed key (built in chatListItems.ts).
 */
const listItemKeyExtractor = (item: ChatListItem): string => item.key;

/**
 * B-270 — one frozen empty array for "no mention matches".
 *
 * A fresh `[]` per render has a new identity every time, so the picker's list
 * re-rendered on every keystroke even while there was no active @token at all
 * — which is most keystrokes. A shared constant makes the common case a
 * referential no-op.
 */
const EMPTY_MENTIONS: ReadonlyArray<{userId: string; label: string}> = Object.freeze([]);

/** Visual-top breathing room (ListFooterComponent of the inverted list). */
const LIST_TOP_SPACER = <View style={{height: 8}} />;

function ChatScreenInner({navigation, route}: Props) {
  const {name, conversationId, isGroup, draft, focusMessageId} = route.params;
  const insets = useSafeAreaInsets();
  // Foldable/large-screen: cap the conversation to a centered ~720dp column so
  // it doesn't stretch edge-to-edge on an unfolded inner display. Reactive —
  // reflows live on unfold (no-op on a phone, where contentMaxWidth == width).
  const {width: winW, isLargeScreen, contentMaxWidth} = useContentWidth(720);
  /**
   * B-661 — the chat header is a FIXED-BUDGET row: back pill + avatar + two
   * call pills + gutters are all constant, so the peer name is whatever is
   * left over. On a 360dp phone that was ~124dp for a 16pt display face, which
   * is why a name clipped on a Pixel 7 and fitted on a 6a. Two levers, both
   * stepped off the real window rather than a device guess: the gutter, and the
   * name size. Deterministic breakpoints, NOT adjustsFontSizeToFit — its
   * companion minimumFontScale is ignored under the New Architecture
   * (facebook/react-native#50248), so the text collapses to unreadable.
   */
  const headerGutter = winW >= 400 ? 18 : winW >= 360 ? 14 : 12;
  const headerGap = winW >= 360 ? 12 : 8;
  const chatNameSize = winW >= 430 ? 16 : winW >= 400 ? 15 : winW >= 360 ? 14 : 13;
  // Polish #2 — drives the read-receipt foreground gate below.
  const isFocused = useIsFocused();
  // B-691 — open-transition gate. Mount SIDE EFFECTS (the unread-clear commit,
  // the relay pull, notif dismiss, group roster sync, the markRead timer) wait
  // for the 220 ms open slide to finish so their store commits stop competing
  // with the animator on the UI thread. Content is NEVER gated on this —
  // deferring the list commit was measured 2× WORSE (CLAUDE.md dead ends).
  // Fix plan F2/F3/F4: docs/qa/CHAT_OPEN_ANIMATION_LAG_2026-08-29.md.
  const transitionDone = useOpenTransitionGate(navigation, {
    onDone: ({ms, via}) => {
      const tap = takeChatOpenTap(conversationId);
      console.warn(
        `[LAGDIAG] [chat.open] conv=${conversationId.slice(0, 8)} mountToEnd=${ms}ms` +
        (tap !== null ? ` tapToEnd=${Date.now() - tap}ms` : '') + ` via=${via}`,
      );
    },
  });
  // Seed the composer with a draft passed from another screen (e.g. the
  // AgentLiveTracker message dock hands off its typed text on `Send`).
  // Falls back to empty string when no draft is passed.
  // B-159 — the draft lives in <ChatComposer>, NOT here. Holding it at this
  // level re-ran every hook and selector in this ~2,700-line component on each
  // keystroke. The screen only ever needs the SUBMITTED value plus a
  // has-text-or-not signal (for typing frames), and both arrive by callback.
  const composerRef = useRef<ChatComposerHandle>(null);
  // MI-06 — restore the persisted draft (SQLCipher-backed store slice). An
  // explicit route-param hand-off wins. useState initializer, not a selector:
  // read once at mount, so keystrokes elsewhere never re-render this screen.
  const [savedDraft] = useState(
    () => draft ?? useMessengerStore.getState().drafts[conversationId] ?? '',
  );
  const onPersistDraft = useCallback((t: string) => {
    useMessengerStore.getState().setDraft(conversationId, t);
  }, [conversationId]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  // Composer TTL: when null, falls back to the conversation's default
  // (set in ChatInfoScreen). Explicit 0 / positive value from the timer
  // picker always wins per-message.
  const [ttlSec, setTtlSec] = useState<number | null>(null);
  const [viewerMsg, setViewerMsg] = useState<LocalMessage | null>(null);
  /**
   * B-287 — page the open photo to its neighbour in the thread.
   *
   * Reads `messages` from the STORE rather than closing over the render-time
   * array: the viewer stays open across incoming messages, and a stale closure
   * would page against the thread as it looked when the photo was tapped.
   * Returning early at the ends leaves the current photo up, which is the
   * correct "nothing further that way" feedback for a gesture.
   */
  const stepViewer = useCallback((direction: -1 | 1) => {
    setViewerMsg(current => {
      if (!current) {return current;}
      const live = liveConversationMessages(useMessengerStore.getState(), conversationId);
      const nextId = stepVisual(visualMessageIds(live), current.id, direction);
      if (!nextId) {return current;}
      return live.find(m => m.id === nextId) ?? current;
    });
  }, [conversationId]);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [replyTo, setReplyTo] = useState<{messageId: string; preview: string; fromSelf: boolean} | null>(null);
  const [actionMsg, setActionMsg] = useState<LocalMessage | null>(null);
  // The message currently being edited. Non-null puts the composer in edit
  // mode: the body is preloaded, the send button commits the edit instead of
  // appending, and the attach / voice / timer affordances are hidden (none of
  // them can apply to an in-place text edit).
  const [editing, setEditing] = useState<{messageId: string; original: string} | null>(null);
  // The AUTH uuid, not the vault owner key: `_ownUserId` is `email ?? phone ??
  // id`, so for any account with an email it never equals a participants entry
  // and "was I mentioned?" would be structurally false. Same root cause as the
  // missing group blue tick (B-116).
  const selfUserId = useMessengerStore(s => s._ownAuthUserId ?? s._ownUserId) ?? null;
  // B-116 phase 2 — WhatsApp "Message info": which group members have read
  // this own message (per-member receipts recorded by recordReadReceipts).
  const [infoMsg, setInfoMsg] = useState<LocalMessage | null>(null);
  /** B-282 — the message whose reaction roster is open, or null. */
  const [reactorsMsg, setReactorsMsg] = useState<LocalMessage | null>(null);
  // B-265 — `infoMsg` is a SNAPSHOT taken when the sheet opened, so every
  // receipt that landed while it was on screen was invisible: the panel whose
  // entire job is delivery state was the one place that never updated. Re-read
  // the row from the store by id so the sheet is live. `.find` returns the same
  // object identity until that row actually changes, so this does not re-render
  // on unrelated traffic, and it falls back to the snapshot if the row is gone
  // (deleted while open) rather than blanking the sheet.
  const liveInfoMsg = useMessengerStore(s => {
    if (!infoMsg) {return null;}
    return (s.messages[conversationId] ?? []).find(m => m.id === infoMsg.id) ?? infoMsg;
  });
  const [forwardSource, setForwardSource] = useState<LocalMessage | null>(null);
  // Briefly pulse the targeted message after a reply-strip tap so the
  // user sees where we jumped to. Cleared by a timer in jumpToMessage.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // Fix #30: FlatList for virtualization (memoised MessageBubble keeps
  // the diff cheap). MX-05: the list is INVERTED — index 0 = newest
  // message = visual bottom, so opening a chat lands on the latest
  // message instantly with no scroll-to-end pass (the old non-inverted
  // list painted the OLDEST 20 rows first, then hard-snapped to the
  // bottom on 0/80/250/500 ms timers — the visible "open flash").
  // In inverted coordinates offset 0 IS the bottom, older messages page
  // in via onEndReached, and appending an older page never shifts
  // existing offsets — no jump, no anchor gymnastics.
  const scrollRef = useRef<FlatList<ChatListItem>>(null);
  const prevCountRef = useRef(0);

  const {runtime, ready, error} = useMessenger();
  // B-18 — a 1:1 (direct) conversation's history can be SPLIT across two
  // store slots: the synthetic `direct:<peer>` key and a server-UUID row.
  // `resolveDirectConversationIdFromState` (used by both sendText and the
  // inbound append) picks the server-UUID slot the moment a UUID row syncs
  // in via /conversations/mine — so a message sent before the sync lands in
  // the synthetic slot while one received after lands in the UUID slot.
  // ChatScreen stays pinned to its route-param id, so one side goes
  // invisible (the QA symptom: "receiver sees only its own sent messages").
  // Merge every direct slot that maps to this peer so both render. Groups
  // keep their single stable id; a direct chat whose history lives in ONE
  // slot returns that slot's array verbatim (stable ref → no extra renders).
  const messages        = useMessengerStore(useShallow(
    s => liveConversationMessages(s, conversationId),
  ));
  const conversation    = useMessengerStore(selectConversation(conversationId));

  // Derive peer address from conversation OR from the conversationId pattern
  // (direct:<userId>) so sends always have a target even if the conversation
  // object wasn't hydrated with a peer field.
  const resolvedPeer = useMemo(
    () => resolvePeer(conversation, conversationId),
    [conversation, conversationId],
  );
  const convTtl         = conversation?.default_ttl_sec ?? null;
  const groupNameMap    = useMessengerStore(s => s.groupMemberNames[conversationId]);
  const peerUserId      = conversation?.peer?.userId;
  const peerPresence    = useMessengerStore(
    s => (peerUserId ? s.presence[peerUserId] : undefined),
  );
  // B-411/§2 — save-contact affordance (WhatsApp parity). Trigger is the LIVE
  // address-book check (same rule as ChatInfo's chip), not the name_source
  // flag, which can be stale after an out-of-band save. 'unknown' (permission
  // denied / no phone) renders nothing — never claim "unsaved" unverified.
  const convPhone = !isGroup ? conversation?.phoneE164 : undefined;
  const [savedState, setSavedState] = useState<SavedState>('unknown');
  const savingContactRef = useRef(false);
  useEffect(() => {
    let alive = true;
    if (!convPhone) {setSavedState('unknown'); return undefined;}
    const check = (): void => {
      void getSavedState(convPhone).then(st => { if (alive) {setSavedState(st);} });
    };
    check();
    // Re-check on focus: saving via ChatInfo's chip and coming back must
    // clear the banner without a remount (savedContacts invalidates its
    // index on save, so the re-read is fresh).
    const unsubFocus = navigation.addListener('focus', check);
    return () => { alive = false; unsubFocus(); };
  }, [convPhone, navigation]);
  // B-411 — resolved header title: the `Bravo · <hex>` placeholder never
  // renders; a still-placeholder 1:1 falls to directory name → phone →
  // neutral label. Groups keep their conversation name untouched.
  const headerDisplayName = useMemo(() => {
    // Deck page 19 - a mission room synced before the rename still reads
    // "MISSION <code> ... OPS ROOM"; every other group name passes through.
    if (isGroup) {return displayRoomName(conversation?.name ?? name);}
    const resolved = resolveNotifTitle({
      name:           conversation?.name ?? name,
      name_source:    conversation?.name_source,
      is_custom_name: conversation?.is_custom_name,
      phoneE164:      conversation?.phoneE164,
      peerUserId,
      directoryName:  peerUserId ? useMessengerStore.getState().directoryNames[peerUserId] : undefined,
    });
    return resolved.displayName ?? 'Bravo user';
  }, [isGroup, conversation, name, peerUserId]);

  const handleSaveContact = useCallback(async () => {
    // Ref, not state: a double-tap lands before a re-render, and two stacked
    // system contact forms is the failure being guarded.
    if (!convPhone || savingContactRef.current) {return;}
    savingContactRef.current = true;
    try {
      await presentSaveContact({displayName: headerDisplayName, phoneE164: convPhone});
      const st = await getSavedState(convPhone);
      setSavedState(st);
      const conv = useMessengerStore.getState().conversations[conversationId];
      if (st === 'saved' && conv) {
        // Keep the current label (the user may have edited it in the system
        // sheet); the next discovery sweep syncs the real address-book name.
        useMessengerStore.getState().upsertConversation({...conv, name_source: 'contact'});
      }
    } catch (e) {
      console.warn('[ChatScreen] save contact failed:', (e as Error).message);
    } finally {
      savingContactRef.current = false;
    }
  }, [convPhone, conversationId, headerDisplayName]);
  // Group fan-out targets — every member except self. For 1:1 chats this
  // collapses to `[conversation.peer]`; for mission groups it's all CPOs +
  // ops admin minus self. Drives presence subscribe, typing fan-out, and
  // read-receipt routing so the desktop dock can show "X active /
  // Y typing…" instead of the perpetual "no one active" placeholder.
  const ownUserId = useAuthStore(s => s.user?.id);
  const groupPeers = useMemo<SessionAddress[]>(
    () => groupFanoutPeers(conversation, isGroup, ownUserId),
    [conversation, isGroup, ownUserId],
  );
  // Stable join key so the effects don't re-run on every render just
  // because the array reference changed.
  const groupPeersKey = groupPeers.map(p => p.userId).join(',');
  const peerTyping      = useMessengerStore(s => !!s.typing[conversationId]);
  const connectionState = useMessengerStore(s => s.connection);
  // GF-5 — a group we belong to but hold no master key for cannot be sent
  // into (the runtime fails closed). Same rule, one source: messagingLogic.
  // Boolean selector → primitive equality, no useShallow needed. Group keys
  // are rehydrated from SQLCipher during runtime init BEFORE setReady(true),
  // so this never flashes on a cold boot — `ready` is still false then.
  const groupKeyPending = useMessengerStore(
    s => !!groupSendBlockedReason(s, conversationId, isGroup === true),
  );
  const composerEnabled = ready && !groupKeyPending;
  // Index messages by id once per render so each bubble's reply-target
  // lookup is O(1) instead of O(N). Matters once a chat has >100 msgs
  // — the old .find() was quietly O(N²) on scroll.
  const byIdCache = useMemo(() => {
    const m = new Map<string, LocalMessage>();
    for (const msg of messages) {m.set(msg.id, msg);}
    return m;
  }, [messages]);

  // Snapshot unread BEFORE the setActive effect clears it. Drives the
  // "Unread N messages" divider — once the user has opened the chat
  // and seen the bubbles, we keep the divider anchored where it was on
  // entry, even though `conversation.unread_count` flips to 0
  // immediately. Cleared on conversationId change so re-entering a
  // chat after backing out re-snapshots from the new (likely zero)
  // unread count.
  const initialUnreadRef = useRef<number>(0);
  const snapshotConvIdRef = useRef<string | null>(null);
  if (snapshotConvIdRef.current !== conversationId) {
    snapshotConvIdRef.current = conversationId;
    const liveConv = useMessengerStore.getState().conversations[conversationId];
    initialUnreadRef.current = liveConv?.unread_count ?? 0;
  }

  // B-703 MR-11 — the pin/clear pair now lives in ONE hook, scoped to FOCUS +
  // FOREGROUND rather than to this screen's mount. Mount-scoped, a chat left
  // under a pushed screen (contact info, settings, a call) — or left open when
  // the user pressed Home — stayed "active" and was therefore silenced: no
  // banner, no sound, no unread. Fix #31's live-value cleanup guard and the
  // B-691/F3 deferred unread clear both moved into the hook with it.
  // The B-691/F3 deferred unread clear (`transitionDone` — full form, incl. the
  // L20 sibling-slot sweep) is handed to the hook rather than run here: that
  // gate opens on a 400 ms FALLBACK TIMER that keeps running while the app is
  // backgrounded and after this screen has blurred, so a local `setActive` on
  // it re-pinned a thread the hook had just released — or clobbered the pin of
  // the chat the user had already moved to.
  useActiveConversation(conversationId, {
    deferFirstUnreadClear: true,
    unreadClearReady:      transitionDone,
  });

  // Force-pull any envelopes the relay is queueing for us when the
  // user opens this chat. Belt-and-braces with the WS reconnect
  // drain — the WS may report 'connected' against a dead socket
  // (Doze can silently kill the fd) so the user opening the chat is
  // a strong signal to flush the queue regardless of WS state. Also
  // re-fires on AppState=active so flipping back from backgrounded
  // catches anything that piled up while we were frozen.
  // Fix #32: single-flight is enforced inside productionRuntime
  // (`coalescedDrain` mutex — see productionRuntime.ts:217). So even
  // if mount + AppState=active fire pullEnvelopes() within the same
  // microtask, only one drain is in-flight at a time and parallel
  // callers await the SAME Promise. We therefore don't need extra
  // dedup at this site; just call and trust the runtime.
  // Dismiss-on-read — cancel any lingering "New message" banner for this
  // conversation the moment the user opens it (WhatsApp/Signal behavior).
  // WI-4.9 — opening the thread also retires its "Missed call" banner: the
  // user is talking to them; the reminder has done its job. Its OWN effect
  // (review round 1 P2): `peerUserId` is undefined until the conversation
  // hydrates, and re-keying the pull effect below on it re-ran a second
  // pullEnvelopes on the repo's worst-measured jank path (open-a-chat).
  useEffect(() => {
    if (!transitionDone) {return;}
    void (async () => {
      try {
        const {dismissMessageNotif, dismissMissedCallNotifs} = require('@/modules/messenger/push/callNotification') as typeof import('@/modules/messenger/push/callNotification');
        await dismissMessageNotif(conversationId);
        await dismissMissedCallNotifs({conversationId, fromUserId: peerUserId});
      } catch { /* notifee unavailable in some contexts — best-effort */ }
    })();
  }, [transitionDone, conversationId, peerUserId]);

  useEffect(() => {
    if (!transitionDone) {return;}
    let cancelled = false;
    const doPull = (): void => {
      void (async () => {
        try {
          const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
          const rt = await getMessengerRuntime('production');
          if (cancelled) {return;}
          await rt.pullEnvelopes();
          // Self-heal — opening a group we belong to but hold no master key
          // for is a strong signal to ask the owner to re-share it (lost on
          // logout/reinstall, or missed the fan-out). Rate-limited inside;
          // no-op for 1:1 chats and for groups whose key is already present.
          if (!cancelled && rt.requestGroupKeyResync) {
            const g = useMessengerStore.getState().groups[conversationId];
            const convo = useMessengerStore.getState().conversations[conversationId];
            const isGroupConvo = convo?.type === 'group' || convo?.type === 'ops_channel';
            if (isGroupConvo && !g?.masterKeyB64) {
              await rt.requestGroupKeyResync(conversationId).catch(() => { /* best-effort */ });
            }
          }
        } catch (e) {
          // Runtime may not be ready right after restore — silent.
          console.log('[chat.pull] skipped:', (e as Error).message);
        }
      })();
    };
    doPull();
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') {doPull();}
    });
    return () => { cancelled = true; sub.remove(); };
  }, [transitionDone, conversationId]);

  // Group hydration — if this is a group (mission room) opened before the
  // /conversations/mine sync ran (push tap, deep link, live-tracker dock),
  // the store row may lack its membership, so the group fan-out would have
  // no recipients. Pull the authoritative roster on mount so the first send
  // already has the member list. Mirrors MessengerHomeScreen's mapping.
  useEffect(() => {
    if (!isGroup || !transitionDone) {return;}
    const have = (conversation?.participants?.length ?? 0) > 0
      && (conversation?.type === 'group' || conversation?.type === 'ops_channel');
    if (have) {return;}
    let cancelled = false;
    void (async () => {
      try {
        const {data} = await conversationApi.listMine();
        if (cancelled) {return;}
        const ownId = useMessengerStore.getState()._ownUserId;
        const upsert = useMessengerStore.getState().upsertConversation;
        const row = data.conversations.find(c => c.id === conversationId);
        if (!row) {return;}
        const cryptoState = useMessengerStore.getState().groups[conversationId];
        const memberIds = cryptoState && Object.keys(cryptoState.members).length > 0
          ? Object.keys(cryptoState.members)
          : row.members.map(m => m.userId);
        const peerUid = memberIds.find(uid => uid !== ownId) ?? memberIds[0] ?? '';
        const existing = useMessengerStore.getState().conversations[conversationId];
        upsert({
          id: conversationId,
          type: row.kind,
          name: existing?.name ?? row.title ?? 'Group',
          participants: memberIds,
          unread_count: existing?.unread_count ?? 0,
          is_muted:     existing?.is_muted     ?? false,
          is_pinned:    existing?.is_pinned    ?? false,
          default_ttl_sec: existing?.default_ttl_sec ?? null,
          created_at:   existing?.created_at   ?? row.createdAt,
          peer: existing?.peer?.userId ? existing.peer : {userId: peerUid, deviceId: 1},
          session_state: existing?.session_state ?? 'fresh',
        });
      } catch (e) {
        console.log('[chat.group-sync] skipped:', (e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [isGroup, transitionDone, conversationId, conversation?.participants?.length, conversation?.type]);

  // Read-receipt fan-out — whenever this chat is open and new inbound
  // messages arrive (or the chat is opened with a backlog), tell the
  // peer we've seen them.
  // Fix #25: debounced 200 ms. Without this, a burst of inbound
  // messages (relay backlog drain on chat open, or peer typing-bursts)
  // each triggered a separate markRead native call. Each call writes
  // to SQLCipher AND emits a `read.receipt` envelope through the
  // transport. Coalescing means one DB write + one envelope per
  // burst — same correctness (the runtime de-dupes already-receipted
  // ids server-side) at a tiny fraction of the cost.
  // Polish #2 (2026-07-02): only send read receipts when the chat is ACTUALLY
  // visible — focused screen AND app in the foreground. Previously a message
  // landing while the chat was mounted-but-backgrounded (or behind another
  // screen) marked it read, so the sender saw blue ticks the recipient never
  // saw. Re-runs on focus regain so opening the chat still receipts the backlog.
  // F8 — messages that landed while backgrounded were skipped by the
  // AppState.currentState guard below and nothing re-fired the effect on
  // foreground regain; bump a counter on 'active' so the open focused
  // chat marks/emits reads when the user returns.
  const [appActiveTick, setAppActiveTick] = useState(0);
  // B-356 — track the last OBSERVED AppState transition separately from
  // AppState.currentState. A VM that FCM started headless reports a stale
  // 'background' currentState even while the user is looking at this screen
  // (launched-from-notification), and no 'change' event has fired yet to
  // correct it — so the guard below silently swallowed the read receipts for
  // exactly the notification-opened chat (sender never got the blue tick
  // until the user backed out and re-entered). null = no transition observed
  // since mount; a focused, user-navigated screen is foreground by
  // construction, so only a CONFIRMED background transition may block.
  const observedAppStateRef = useRef<string | null>(null);
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      observedAppStateRef.current = s;
      if (s === 'active') {setAppActiveTick(t => t + 1);}
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    // B-691/F2 — transitionDone keeps the first markRead commit (a bulk status
    // flip + backup-dirty nudges + WS receipt frames) out of the open slide:
    // the old mount-anchored 200 ms timer detonated at the TAIL of the 220 ms
    // animation. Later runs (new messages, refocus) are unaffected once open.
    if (!runtime || !isFocused || !transitionDone) {return;}
    const t = setTimeout(() => {
      const observed = observedAppStateRef.current;
      const appActive = observed !== null ? observed === 'active' : true;
      if (!appActive) {
        // [RECEIPTDIAG] warn survives release stripping — if ticks ever go
        // missing again, this line names the blocked guard on device.
        console.warn('[RECEIPTDIAG] markRead blocked: observed appState=', observed);
        return;
      }
      runtime.markRead(conversationId);
    }, 200);
    return () => clearTimeout(t);
  }, [runtime, conversationId, messages.length, isFocused, appActiveTick, transitionDone]);

  // Live presence for every peer in this chat while it's open. For 1:1
  // that's a single user; for mission groups it's every CPO + ops admin
  // (minus self) so each member's chip lights up. setActivity is global
  // per-socket — fire it regardless of peer count so anyone watching us
  // sees green. Without this, group-chat surfaces never reported active
  // (the old guard required a single `peerUserId`, which is null for
  // groups since `conversation.peer` is undefined for them) and the
  // ops dock displayed a permanent "no one active".
  useEffect(() => {
    if (!runtime) {return;}
    runtime.setActivity('active');
    if (groupPeers.length > 0) {
      runtime.subscribePresence(groupPeers.map(p => p.userId));
    }
    return () => {
      if (groupPeers.length > 0) {
        runtime.unsubscribePresence(groupPeers.map(p => p.userId));
      }
      // Round 7 / presence audit fix #8 — only flip to 'away' if the
      // user is actually leaving the app. Navigating from chat back
      // to the home screen / settings is NOT idleness; the previous
      // unconditional 'away' here meant any peer watching us would
      // see amber the moment we left a chat, then we'd stay away for
      // the rest of the session because nothing else fires 'active'
      // (productionRuntime now owns the AppState-driven 'active'
      // signal; this hook should only contribute 'away' on real
      // background).
      if (AppState.currentState !== 'active') {
        runtime.setActivity('away');
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, groupPeersKey]);

  // Increment the "new messages since scrolled-up" pill on the FAB.
  // If the user is pinned to the bottom, keep counter at 0 and let the
  // ScrollView auto-follow. If they've scrolled up, accumulate until
  // they tap the FAB (scroll-to-bottom resets it).
  useEffect(() => {
    const delta = messages.length - prevCountRef.current;
    prevCountRef.current = messages.length;
    if (atBottom) {
      setNewCount(0);
      return;
    }
    if (delta > 0) {setNewCount(n => n + delta);}
  }, [messages.length, atBottom]);

  // Fix #30: atBottomRef mirror so onContentSizeChange/onScroll can be
  // stable useCallbacks. Without this, every flip of atBottom would
  // re-allocate both handlers and FlatList would re-bind them on the
  // native side. Reading the freshest value through a ref keeps the
  // callbacks identity-stable across the lifetime of the screen.
  const atBottomRef = useRef(atBottom);
  useEffect(() => { atBottomRef.current = atBottom; }, [atBottom]);

  // MX-05 — no initial-scroll pass needed: the inverted list mounts at
  // offset 0, which IS the newest message. (The old BS-CHAT-INITSCROLL
  // 4-shot scrollToEnd timer hack lived here.)

  // Round 6 / pagination — guard refs for the near-top loadOlder
  // trigger. `loadingOlder` prevents a second fire while a fetch is in
  // flight; `exhausted` latches once the runtime reports "no more
  // older". Both reset when the conversation id changes.
  const loadingOlderRef = useRef(false);
  const exhaustedOlderRef = useRef(false);
  useEffect(() => {
    loadingOlderRef.current = false;
    exhaustedOlderRef.current = false;
  }, [conversationId]);
  // Ref-mirrors so the onScroll useCallback can be lifetime-stable
  // (Fix #30 round-2 invariant) while still reading the freshest
  // runtime + conversationId + messages.length values when a
  // near-top scroll fires. Without these, including the values in
  // useCallback deps would re-allocate onScroll on every send,
  // forcing FlatList to re-bind the handler across the JNI bridge.
  const runtimeRef = useRef(runtime);
  useEffect(() => { runtimeRef.current = runtime; }, [runtime]);
  const conversationIdRef = useRef(conversationId);
  useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  const messagesLengthRef = useRef(messages.length);
  useEffect(() => { messagesLengthRef.current = messages.length; }, [messages.length]);

  // Emit typing start/stop as the user edits — debounced by the 6s
  // server-side auto-stop so we only fire on transitions, not every
  // keystroke. We send `start` on any non-empty text change; the next
  // `stop` fires on send (see `send()` below) or when the composer
  // clears to empty. For mission groups we fan to every other member;
  // the gateway forwards each frame only to that peer's connected
  // sockets so privacy is preserved.
  // Polish #1 (2026-07-02): typing fans out ONE frame per member (pairwise),
  // so an active group is O(N²) typing traffic across all members' clients.
  // Suppress typing entirely above a threshold — large groups don't benefit
  // from per-peer "is typing" and the WS churn hurts at scale (matches how
  // big-group typing is degraded in WhatsApp). 1:1 and small groups keep it.
  const TYPING_FANOUT_MAX_PEERS = 8;
  const typingActiveRef = useRef(false);
  // PRES-20 — when the last `start` was emitted. The server auto-stops
  // typing after 6s, so continued typing (text stays non-empty) must
  // re-emit `start` before that window lapses or the peer's indicator
  // goes stale mid-composition. Piggybacks on text changes; no timers.
  const lastTypingSentAtRef = useRef(0);
  // B-159 — this was a `useEffect` keyed on `text`, which is why the draft had
  // to live in the screen. It is now a plain function driven by the composer's
  // per-keystroke callback: it touches ONLY refs, so a keystroke emits the same
  // frames as before without re-rendering anything. Semantics are unchanged —
  // the old deps were [text, runtime, groupPeersKey] and all three still drive
  // it (the latter two via the effect below).
  const hasDraftRef = useRef(false);
  /**
   * B-269 — NO typing frame is ever emitted on an interaction frame.
   *
   * `emitTyping` runs from the composer's per-keystroke callback, and each
   * `sendTyping` does a store read, a pure-JS sha256 (`typingConversationTag`)
   * and a bridge `transport.send`. Fanning that out synchronously meant every
   * keystroke that flipped the typing state paid N hashes + N bridge crossings
   * before the character appeared — the "typing box feels laggy" report, and
   * the same root cause as the sluggish send tap.
   *
   * Typing indicators are advisory and the receiver's has its own timeout, so
   * one macrotask of delay is invisible to the peer and decisive for the
   * typist. The peer list is snapshot into the closure so a roster change a
   * tick later cannot redirect the frames.
   */
  const deferTypingFanout = useCallback(
    (peers: typeof groupPeers, state: 'start' | 'stop', convId: string) => {
      const rt = runtime;
      if (!rt) {return;}
      const snapshot = peers;
      setTimeout(() => {
        for (const peer of snapshot) {
          try { rt.sendTyping(peer, state, convId); } catch { /* socket not open */ }
        }
      }, 0);
    },
    [runtime],
  );
  const emitTyping = () => {
    if (!runtime || groupPeers.length === 0 || groupPeers.length > TYPING_FANOUT_MAX_PEERS) {return;}
    const shouldType = hasDraftRef.current;
    // The refs below are still written SYNCHRONOUSLY. They are the debounce
    // state, so deferring them would let a burst of keystrokes each queue their
    // own fan-out before the first one had marked typing as active.
    if (shouldType && !typingActiveRef.current) {
      typingActiveRef.current = true;
      lastTypingSentAtRef.current = Date.now();
      deferTypingFanout(groupPeers, 'start', conversationId);
    } else if (shouldType && typingActiveRef.current
        && Date.now() - lastTypingSentAtRef.current > 5_000) {
      // PRES-20 — re-emit before the server's 6s auto-stop lapses.
      lastTypingSentAtRef.current = Date.now();
      deferTypingFanout(groupPeers, 'start', conversationId);
    } else if (!shouldType && typingActiveRef.current) {
      typingActiveRef.current = false;
      deferTypingFanout(groupPeers, 'stop', conversationId);
    }
  };
  // Latest-ref indirection so the callback handed to the memoised composer has
  // a STABLE identity (a fresh closure per render would defeat React.memo and
  // re-render the composer on every screen render).
  const emitTypingRef = useRef(emitTyping);
  emitTypingRef.current = emitTyping;
  const onDraftActivity = useCallback((hasText: boolean) => {
    hasDraftRef.current = hasText;
    emitTypingRef.current();
  }, []);
  // Preserves the old effect's [runtime, groupPeersKey] legs: a runtime that
  // arrives while a draft is already typed still emits `start`.
  useEffect(() => {
    emitTypingRef.current();
  }, [runtime, groupPeersKey]);

  // Fix #33: when the user navigates between chats, fire a typing-stop
  // to the OUTGOING peer set so the previous chat doesn't show a
  // perpetual "Alice is typing…" on the recipient side. Without this,
  // a quick switch from chat A to chat B with text already in the
  // composer left the start-typing event unmatched on chat A; the
  // peer's typing indicator stuck until the 6 s server-side auto-stop
  // fired. Cleanup also resets the ref so the new chat's effect sees
  // a clean state regardless of the previous chat's draft.
  useEffect(() => {
    // Snapshot the OUTGOING peers — when this cleanup runs, groupPeers
    // refers to the chat we're leaving (the deps re-bind on
    // conversationId change so cleanup sees the OLD value via closure).
    const outgoingPeers = groupPeers;
    const outgoingRuntime = runtime;
    // SYNC-6 — snapshot the id alongside the peers so the cleanup's stop
    // frame is scoped to the chat being LEFT, not the one being entered.
    const outgoingConversationId = conversationId;
    return () => {
      if (typingActiveRef.current && outgoingRuntime && outgoingPeers.length > 0) {
        for (const peer of outgoingPeers) {
          try { outgoingRuntime.sendTyping(peer, 'stop', outgoingConversationId); } catch { /* ignore */ }
        }
      }
      typingActiveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Hide the bottom tab bar while a conversation is open — keeps the chat
  // fullscreen and prevents the tab row overlapping the input on short
  // screens. Restored when the user backs out to MessengerHome.
  useEffect(() => {
    const tabNav = navigation.getParent();
    tabNav?.setOptions({tabBarStyle: {display: 'none'}});
    return () => tabNav?.setOptions({tabBarStyle: undefined});
  }, [navigation]);

  // B-159 — LIVE-MONITOR (#9)'s `justSent` settle window, the composer clear it
  // pairs with, and the send/mic swap they drive all moved into <ChatComposer>.
  // The screen is handed the already-trimmed body.
  const send = async (trimmed: string, mentions?: Array<{userId: string; label: string}>) => {
    if (!trimmed || !runtime) {return;}
    setEmojiOpen(false);
    // Edit mode short-circuits the whole send pipeline: no bubble, no outbox
    // row, no scroll-to-bottom, no typing frames. It patches a row that is
    // already on screen, possibly far up the thread — jumping to the bottom
    // would move the user away from the message they just corrected.
    if (editing) {
      const target = editing;
      setEditing(null);
      composerRef.current?.endEdit();
      if (trimmed === target.original) {return;} // nothing changed
      if (!conversationPeer) {return;}
      haptics.tap();
      try {
        await runtime.sendMessageEdit(conversationPeer, conversationId, target.messageId, trimmed, mentions);
      } catch (e) {
        useMessengerStore.getState().setError(sendErrorText(e, 'Edit failed'));
      }
      return;
    }
    // BS-CHAT-SCROLL — when the user sends, always jump to the bottom so
    // their own message is visible (WhatsApp behaviour), even if they were
    // scrolled up reading history. Inverted list: bottom = offset 0.
    atBottomRef.current = true;
    requestAnimationFrame(() => scrollRef.current?.scrollToOffset({offset: 0, animated: true}));
    const replySnapshot = replyTo;
    setReplyTo(null);
    // B-159 — the composer just cleared itself, so the screen's view of the
    // draft must clear too. Without this a later emitTyping() (a runtime or
    // roster change) would see a stale "has draft" and emit `start` for an
    // empty composer, leaving the peer a permanent "typing…".
    hasDraftRef.current = false;
    // B-269 — the typing-STOP fan-out is deferred off the tap frame.
    //
    // It ran synchronously here, once per group member, and each call does a
    // store read, a pure-JS sha256 (`typingConversationTag`) and a bridge
    // `transport.send`. In a 30-member group that is 30 hashes and 30 bridge
    // crossings between the user's finger and the optimistic bubble — the
    // "send feels like it hangs" report. Nothing downstream depends on the
    // stop frame landing in this frame: it is advisory, the peer's indicator
    // has its own timeout, and the message that follows implies it anyway.
    //
    // `typingActiveRef` is cleared NOW, not in the callback, so a second send
    // in the same tick cannot queue the fan-out twice.
    if (typingActiveRef.current && groupPeers.length > 0) {
      typingActiveRef.current = false;
      deferTypingFanout(groupPeers, 'stop', conversationId);
    }
    haptics.tap();
    try {
      const effectiveTtl = ttlSec ?? convTtl ?? undefined;
      await runtime.sendText(conversationId, trimmed, {
        peer:      resolvedPeer,
        isGroup,
        ttlSeconds: effectiveTtl,
        replyTo: replySnapshot
          ? {messageId: replySnapshot.messageId, preview: replySnapshot.preview}
          : undefined,
        mentions,
      });
    } catch (e) {
      useMessengerStore.getState().setError(sendErrorText(e, 'Send failed'));
    }
  };

  /**
   * Tap-to-retry for a failed outbound message. P1-1 — re-runs the send
   * pipeline under the SAME bubble id (relay clientMsgId dedup makes it
   * idempotent) after flipping the row back to `sending`. The old code
   * removed the failed bubble FIRST and then re-sent under a fresh id, so a
   * re-send that rejected at the cert fetch destroyed the persisted message
   * with no bubble and no retry chip. Media is now retryable too when the
   * encrypted object was already uploaded (upload-succeeded, send-failed);
   * a failed UPLOAD persisted no bytes, so that case can't be re-shipped.
   */
  const retrySend = useCallback(async (msg: LocalMessage) => {
    if (!runtime) {return;}
    // B-46 — `undelivered` (recipient destroyed the envelope: identity
    // churn) is retryable too: the auto-resend gets one bounded attempt;
    // this chip is the manual fallback and re-runs the full send pipeline
    // (fresh session against the peer's CURRENT identity).
    if (msg.status !== 'failed' && msg.status !== 'undelivered') {return;}

    const isMedia = msg.type === 'image' || msg.type === 'video' || msg.type === 'audio' || msg.type === 'file';
    // P2-12 — re-ship an already-uploaded media object; a failed UPLOAD left no
    // object key and no persisted bytes, so it can't be retried here.
    const canReshipMedia = isMedia && !!msg.media_object_key && !!msg.media_key && !!msg.media_iv;
    if (isMedia && !canReshipMedia) {
      Alert.alert(
        'Retry not available',
        'This attachment could not finish uploading — re-attach and send the file again.',
      );
      return;
    }

    const content = msg.content ?? '';
    if (!isMedia && !content) {return;}
    const replyMeta = msg.reply_to_msg_id && msg.reply_to_preview
      ? {messageId: msg.reply_to_msg_id, preview: msg.reply_to_preview}
      : undefined;
    const ttl = msg.expires_at
      ? Math.max(1, Math.round((msg.expires_at - new Date(msg.created_at).getTime()) / 1000))
      : (convTtl ?? undefined);
    const attachment = canReshipMedia
      ? {
          objectKey: msg.media_object_key!,
          keyB64:    msg.media_key!,
          ivB64:     msg.media_iv!,
          mimeType:  msg.media_mime ?? 'application/octet-stream',
          size:      (msg as {media_size?: number}).media_size ?? 0,
          kind:      msg.type as 'image' | 'audio' | 'video' | 'file',
        }
      : undefined;

    // P1-1 — flip the EXISTING bubble to `sending` and re-send under the SAME
    // bubble id (existingMsgId). Never remove the durable row first. The
    // runtime keeps the wire clientMsgId identical when the relay never
    // accepted the original (dedup-idempotent), and mints a fresh wire id when
    // it did (B-122 — a same-id repeat is answered with the ORIGINAL accept
    // and delivers nothing).
    useMessengerStore.getState().updateMessageStatus(conversationId, msg.id, 'sending');
    haptics.select();
    try {
      await runtime.sendText(conversationId, content, {
        peer:          resolvedPeer,
        isGroup,
        ttlSeconds:    ttl,
        replyTo:       replyMeta,
        existingMsgId: msg.id,
        attachment,
        // B-122 — the recipient destroyed the original (identity churn);
        // re-wrapping against the dead cached session would repeat that.
        freshSession:  msg.status === 'undelivered',
      });
    } catch (e) {
      useMessengerStore.getState().setError(sendErrorText(e, 'Retry failed'));
    }
  }, [runtime, conversationId, resolvedPeer, convTtl, isGroup]);

  const copyMessage = async (msg: LocalMessage) => {
    setActionMsg(null);
    if (!msg.content) {return;}
    try { await Clipboard.setStringAsync(msg.content); } catch { /* ignore */ }
    haptics.select();
  };

  /**
   * B-450 — ONE definition of "open the action sheet for this message".
   *
   * The row wrapper and every media touchable inside it now arm a long-press,
   * and an album tile arms one per photo. Copying `haptics.impact(); setActionMsg(m)`
   * to each site is the duplicate-copy bug class: the copies drift and only one
   * of them ends up carrying a later change (a permission gate, say).
   */
  const longPressMessage = useCallback((msg: LocalMessage) => {
    haptics.impact();
    setActionMsg(msg);
  }, []);

  // MX-12 — stable identity: renderItem closes over this, so it must not
  // re-mint every render (setters are identity-stable).
  const startReply = useCallback((msg: LocalMessage) => {
    // Why: the sheet hides Reply for tombstones, but swipe-to-reply calls
    // this directly — without the guard it arms a quote of deleted content.
    if (msg.deleted_for_all) {return;}
    setActionMsg(null);
    setReplyTo({
      messageId: msg.id,
      preview:   previewForReply(msg),
      fromSelf:  msg.sender_id === 'self',
    });
  }, []);

  const startEdit = useCallback((msg: LocalMessage) => {
    setActionMsg(null);
    // Editing and replying are mutually exclusive composer modes — leaving a
    // reply armed would attach a quote to an EDIT, which has no meaning on the
    // wire (the directive patches an existing row, it does not create one).
    setReplyTo(null);
    setEditing({messageId: msg.id, original: msg.content ?? ''});
    composerRef.current?.beginEdit(msg.content ?? '');
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    composerRef.current?.endEdit();
  }, []);

  const deleteForEveryone = (msg: LocalMessage) => {
    setActionMsg(null);
    Alert.alert(
      'Delete for everyone?',
      'This message will be removed for everyone in this chat. This cannot be undone.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Delete for everyone',
          style: 'destructive',
          onPress: () => {
            // `conversationPeer` is declared below; this closure only runs on
            // tap, long after the render that initialises it.
            if (!runtime || !conversationPeer) {return;}
            // Drop any still-queued outbox row FIRST: a message the author is
            // retracting must not be shipped by the next reconnect drain
            // (P2-10's reasoning, one step earlier in the lifecycle).
            void runtime.discardOutboxForMessage(msg.id).catch(() => { /* best-effort */ });
            void runtime.sendDeleteForEveryone(conversationPeer, conversationId, msg.id)
              .catch(e => useMessengerStore.getState().setError(sendErrorText(e, 'Delete failed')));
            haptics.impact();
          },
        },
      ],
    );
  };

  const deleteMessage = (msg: LocalMessage) => {
    setActionMsg(null);
    // P2-10 — drop any still-queued outbox row(s) for this message so the next
    // reconnect drain doesn't ship a message the sender just deleted. For a 1:1
    // or group send the outbox key (clientMsgId) equals msg.id. Harmless no-op
    // for an already-delivered message (row already gone).
    void runtime?.discardOutboxForMessage(msg.id).catch(() => { /* best-effort */ });
    useMessengerStore.getState().removeMessage(conversationId, msg.id);
  };

  const startForward = (msg: LocalMessage) => {
    setActionMsg(null);
    setForwardSource(msg);
  };

  const forwardTo = async (targetConvId: string) => {
    const src = forwardSource;
    setForwardSource(null);
    if (!src || !runtime) {return;}

    const store   = useMessengerStore.getState();
    const target  = store.conversations[targetConvId];
    if (!target?.peer) {
      Alert.alert('Forward failed', 'Target conversation not found.');
      return;
    }

    const isMedia = src.type === 'image' || src.type === 'file' || src.type === 'audio' || src.type === 'video';
    // Audit MSG-11 — a forwardable media message ALREADY carries the encrypted
    // object key + AES key + IV, so forwarding needs NO re-upload: re-send via
    // sendText with the same attachment. sendText re-registers the media grant
    // for the new recipient (so they can download) and fans a real envelope.
    const canReforwardMedia = isMedia
      && !!src.media_object_key && !!src.media_key && !!src.media_iv;

    // Loopback mode's sendText only talks to LOOPBACK_PEER — the echo
    // fakes a round-trip locally. Real peers have no session, so we
    // can't call sendText. Instead, append a copy of the message
    // straight into the target's list.
    const isLoopback = runtime.mode !== 'production';

    // Local-fake ONLY for loopback, or for media we genuinely can't re-forward
    // (missing object key — e.g. a legacy local-only bubble).
    if (isLoopback || (isMedia && !canReforwardMedia)) {
      const forwarded: LocalMessage = {
        ...src,
        id:              Math.random().toString(36).slice(2) + Date.now().toString(36),
        conversation_id: targetConvId,
        sender_id:       'self',
        status:          isLoopback ? 'sent' : 'failed',   // honest: real send didn't happen
        created_at:      new Date().toISOString(),
        peer:            target.peer,
        // Reset reply/reactions on a forward — the quoted message belongs
        // to the source conversation, not this one.
        reply_to_msg_id:  undefined,
        reply_to_preview: undefined,
        reactions:        undefined,
        content:          src.content,
        // MM-09 — the chip replaces the old arrow-glyph body-prefix hack.
        is_forwarded:     true,
      };
      store.appendMessage(targetConvId, forwarded);
      haptics.tap();
      return;
    }

    // Production media forward — re-send the existing encrypted object.
    if (canReforwardMedia) {
      try {
        await runtime.sendText(targetConvId, src.content ?? '', {
          peer: target.peer,
          isForwarded: true,
          attachment: {
            objectKey: src.media_object_key!,
            keyB64:    src.media_key!,
            ivB64:     src.media_iv!,
            mimeType:  src.media_mime ?? 'application/octet-stream',
            size:      (src as {media_size?: number}).media_size ?? 0,
          },
        });
        haptics.tap();
      } catch (e) {
        useMessengerStore.getState().setError(sendErrorText(e, 'Forward failed'));
      }
      return;
    }

    // Production text-message forward — re-encrypt to the new peer.
    // MM-09 — the label rides the wire as `isForwarded` (chip on both ends);
    // the old arrow-glyph body prefix is gone.
    const body   = src.content ?? '';
    try {
      await runtime.sendText(
        targetConvId,
        body,
        {peer: target.peer, isForwarded: true},
      );
      haptics.tap();
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'Unknown error';
      Alert.alert('Forward failed', reason);
    }
  };

  /**
   * Scroll the chat to the message whose id matches `targetId` and
   * pulse-highlight it for ~1.2s. Called from a tap on the reply strip.
   * If we don't have a recorded position (target is offscreen far above
   * and hasn't mounted yet) we still scroll to the top as a best-effort.
   */
  const jumpToMessage = (target: string) => {
    // Audit MSG-15 (2026-07-02): prefer INDEX-based scroll. The cached
    // y-offset map assumes the list only grows at the bottom, but
    // loadOlderMessages PREPENDS a page, shifting every recorded offset — so
    // after any scroll-back a reply-jump landed at the wrong bubble. The
    // current list index is always correct; onScrollToIndexFailed (added on
    // the FlatList) covers the un-measured-offscreen case.
    let idx = listItems.findIndex(it => it.kind === 'msg' && it.msg.id === target);
    if (idx < 0) {
      // M12 — appendMessage forks an id collision to `X#n`, but the reply on
      // the other side still carries X; fall back to the forked row (same
      // rationale as findReactionTarget).
      idx = listItems.findIndex(it => it.kind === 'msg' && it.msg.id.startsWith(target + '#'));
    }
    // Highlight must use the RESOLVED id — the bubble comparator checks
    // highlightedId === msg.id, and msg.id is the forked value.
    const hit = idx >= 0 ? listItems[idx] : undefined;
    const targetId = hit && hit.kind === 'msg' ? hit.msg.id : target;
    if (idx >= 0) {
      try {
        // Inverted list: viewPosition is in flipped coordinates, so 0.7
        // places the target ~30% from the VISUAL top — comfortably in view.
        scrollRef.current?.scrollToIndex({index: idx, viewPosition: 0.7, animated: true});
      } catch {
        scrollRef.current?.scrollToEnd({animated: true});
      }
    } else {
      // Not in the currently-loaded window — jump toward the visual top
      // (inverted: end of content = oldest) so the user can scroll back.
      scrollRef.current?.scrollToEnd({animated: true});
    }
    haptics.select();
    setHighlightedId(targetId);
    setTimeout(() => setHighlightedId(curr => (curr === targetId ? null : curr)), 1200);
  };
  // F-14 — ref-mirror (same pattern as onSwipeReply in the bubble): the
  // MessageBubble memo comparator skips function props, so a bubble that
  // bails out keeps its FIRST onReplyTap closure — which would close over
  // a jumpToMessage whose listItems predate a pagination prepend and jump
  // to the wrong index. Calling through the ref always reads the latest.
  const jumpToMessageRef = useRef(jumpToMessage);
  useEffect(() => { jumpToMessageRef.current = jumpToMessage; });

  const conversationPeer = conversation?.peer;
  // NAV-15 (2026-08-26 audit) — in-flight REF guard: `setActionMsg(null)`
  // closes the sheet but is React state, so a rapid mash queued one crypto
  // seal + network fan-out per tap, and `remove` (recomputed from
  // reactions.self) made the burst toggle on/off nondeterministically.
  const reactionInFlightRef = useRef(false);
  const reactToMessage = useCallback(async (msg: LocalMessage, emoji: string) => {
    setActionMsg(null);
    if (!runtime || !conversationPeer) {return;}
    if (reactionInFlightRef.current) {return;}
    reactionInFlightRef.current = true;
    try {
      const mine = msg.reactions?.self;
      const remove = mine === emoji;
      await runtime.sendReaction(conversationPeer, conversationId, msg.id, emoji, remove);
      haptics.impact();
    } finally {
      reactionInFlightRef.current = false;
    }
  }, [runtime, conversationPeer, conversationId]);

  // ─── Encrypted media send ──────────────────────────────────────────
  // Pick → read bytes → runtime.sendMedia (AES-256-CBC encrypt, upload
  // ciphertext, ship the per-file key in-band inside the sealed envelope).
  // The runtime builds the local bubble + registers download grants.
  // MX-09 — sends run through a SERIAL queue that never blocks the
  // composer: each bubble appears immediately with a determinate upload
  // ring while the user keeps typing. Serial so an N-photo pick can't
  // hold N × ≤50 MB plaintext buffers at once.
  const [mediaQueue, setMediaQueue] = useState<{done: number; total: number} | null>(null);
  // B-87/MX-04 — assets awaiting review in the pre-send tray.
  const [pendingAssets, setPendingAssets] = useState<PickedAsset[]>([]);
  // B-450 — the armed quote, readable from the SERIAL media queue.
  //
  // The queue holds `sendPickedMediaRef` and runs long after the tap, so
  // reading `replyTo` out of the closure would take whatever value it had when
  // that closure was minted. Written during render (same shape as
  // `enqueueMediaAssetsRef` below) so the value is current before any effect runs.
  const replyToRef        = useRef(replyTo);
  replyToRef.current      = replyTo;
  /**
   * B-450 — the quote this BATCH is replying with, snapshotted once when the
   * serial runner starts and consumed by the batch's FIRST item only.
   *
   * Batch-scoped rather than read live per item: the queue drains across many
   * seconds, so a reply the user arms for their NEXT message while photo 3 of 5
   * is still uploading would otherwise attach itself to photo 4. Scoping it to
   * the run makes "the reply lands on the first attachment" true by
   * construction instead of by the clear-before-await race.
   */
  const batchReplyRef     = useRef<typeof replyTo>(null);
  const mediaQueueRef     = useRef<PickedAsset[]>([]);
  const mediaQueueRunning = useRef(false);
  const queueTotalRef     = useRef(0);
  const queueDoneRef      = useRef(0);

  const sendPickedMedia = useCallback(async (
    uri: string,
    mimeType: string,
    kind: 'image' | 'audio' | 'video' | 'file',
    // Media-parity (2026-07-03) — optional display hints from the picker
    // (filename, dimensions, duration) shipped inside the sealed envelope.
    meta?: {name?: string; width?: number; height?: number; durationMs?: number},
    // B-149 — true only for files this app produced (voice-note capture);
    // its plaintext is deleted as soon as the bytes are in memory.
    ephemeralSource?: boolean,
    // B-707 — the pre-send caption typed in MediaPreviewTray. It travels on the
    // QUEUE ITEM (pickedAssets.withBatchCaption), not a screen-level ref, so a
    // caption can never be inherited by a later, unrelated batch.
    caption?: string,
  ) => {
    const rt = runtimeRef.current;
    if (!rt || typeof rt.sendMedia !== 'function') {
      Alert.alert('Cannot send', 'Secure session is still initialising. Try again in a moment.');
      return;
    }
    // Own media send lands at the bottom — surface it (WhatsApp behavior).
    atBottomRef.current = true;
    requestAnimationFrame(() => scrollRef.current?.scrollToOffset({offset: 0, animated: true}));
    // Hoisted so the catch can see what this item actually attempted.
    let replyMeta: typeof replyTo = null;
    let rowsBefore: Set<string> | null = null;
    try {
      // Media-parity G3 — sender-side tiny JPEG thumbnail for images so
      // the recipient's bubble renders INSTANTLY from the envelope while
      // the full blob downloads. Best-effort: a manipulator failure just
      // means the old lock-box placeholder.
      let thumbB64: string | undefined;
      if (kind === 'image') {
        try {
          const t = await ImageManipulator.manipulateAsync(
            uri,
            [{resize: {width: 320}}],
            {compress: 0.35, format: ImageManipulator.SaveFormat.JPEG, base64: true},
          );
          if (t.base64 && t.base64.length <= 48 * 1024) {thumbB64 = t.base64;}
        } catch { /* thumbnail is a bonus, never a blocker */ }
      }
      const bytes = await readUriBytes(uri);
      // B-149 — the plaintext capture has served its purpose the moment
      // its bytes are in memory; everything downstream works off `bytes`,
      // never the uri. Delete it here rather than after the send so an
      // upload failure (or the size bail-out just below) cannot strand
      // the user's unencrypted audio in the cache.
      if (ephemeralSource) {await deleteEphemeralSource(uri);}
      // 50 MB cap mirrors the server's MEDIA_MAX_UPLOAD_BYTES — but the
      // server measures the CIPHERTEXT, and we cap the PLAINTEXT here.
      // v2 blob layout (aesCbc.ts): 1 version byte + PKCS#7-padded
      // AES-CBC (adds 1..16 bytes) + 32-byte HMAC tag = worst case
      // plaintext + 49 bytes, so a pick within 49 bytes of the limit
      // would pass here and 400 mid-upload (MEDIA-07 boundary).
      const V2_CIPHERTEXT_OVERHEAD = 1 + 16 + 32;
      if (bytes.byteLength > 50 * 1024 * 1024 - V2_CIPHERTEXT_OVERHEAD) {
        Alert.alert('File too large', 'Attachments are limited to 50 MB.');
        return;
      }
      // B-450 — consume the BATCH's quote (armed and cleared by
      // enqueueMediaAssets before this runner started). Taking it here means
      // only the first item of a multi-pick carries it, like WhatsApp — and
      // because it is batch-scoped, a reply armed mid-drain is untouchable from
      // here and stays armed for the user's next message.
      const replySnapshot = batchReplyRef.current;
      if (replySnapshot) {batchReplyRef.current = null;}
      // ...unless the quoted message has since been deleted for everyone. The
      // preview is PLAINTEXT of that message: shipping it would re-publish the
      // body its author just retracted, to a recipient whose own copy is
      // already a "This message was deleted" tombstone. Absence from the loaded
      // page is NOT deletion, so only an explicit flag drops it.
      const quotedNow = replySnapshot
        ? (useMessengerStore.getState().messages[conversationIdRef.current] ?? [])
            .find(m => m.id === replySnapshot.messageId)
        : undefined;
      replyMeta = replySnapshot && !quotedNow?.deleted_for_all ? replySnapshot : null;
      // Rows present before the send, so the catch below can tell a failure
      // that left a retryable bubble from one that left nothing at all.
      rowsBefore = new Set(
        (useMessengerStore.getState().messages[conversationIdRef.current] ?? []).map(m => m.id),
      );
      await rt.sendMedia!(
        conversationIdRef.current,
        {bytes, mimeType, kind, meta: {...meta, ...(thumbB64 ? {thumbB64} : {})}},
        // P1-3 — plumb the disappearing-message TTL (per-message override, then
        // the conversation default) AND the group hint, mirroring the text path.
        // Without ttlSeconds, media in a disappearing chat never expired.
        {
          peer: resolvedPeer,
          ttlSeconds: ttlSec ?? convTtl ?? undefined,
          isGroup,
          // B-707 — the caption IS the message body for an attachment: it lands
          // in `content` on the optimistic bubble and on the wire, which is why
          // the recipient's bubble renders it under the media with no further
          // plumbing.
          caption,
          replyTo: replyMeta
            ? {messageId: replyMeta.messageId, preview: replyMeta.preview}
            : undefined,
        },
      );
      haptics.tap();
    } catch (e) {
      // B-450 — sendMedia appends its optimistic bubble only AFTER its own
      // pre-flight (group-key-pending, blocked send); everything that throws
      // before that — and everything this function threw above — leaves NO row
      // at all, so the quote we consumed has nowhere to live and the user's
      // reply is gone with no retry chip to recover it (the offline
      // photo-reply case). Re-arm it, but never over a reply the user armed
      // while this was in flight.
      if (replyMeta && rowsBefore) {
        const after = useMessengerStore.getState().messages[conversationIdRef.current] ?? [];
        const left = after.some(m => !rowsBefore!.has(m.id));
        if (!left) {
          const restore = replyMeta;
          setReplyTo(cur => cur ?? restore);
        }
      }
      useMessengerStore.getState().setError(sendErrorText(e, 'Media send failed'));
      Alert.alert('Send failed', sendErrorText(e, 'Could not send the attachment.'));
    }
  }, [resolvedPeer, ttlSec, convTtl, isGroup]);

  /**
   * MX-09 — serial media queue. Every media send (library multi-pick,
   * camera, document, voice note) funnels through here so at most ONE
   * plaintext buffer is resident and the composer never locks. The chip
   * above the input bar narrates "k of n" for multi-sends.
   */
  // Ref-mirror so items enqueued MID-RUN are sent with the freshest
  // closure (TTL/peer changes during a long queue), not the one captured
  // when the runner started.
  const sendPickedMediaRef = useRef(sendPickedMedia);
  useEffect(() => { sendPickedMediaRef.current = sendPickedMedia; }, [sendPickedMedia]);

  const enqueueMediaAssets = useCallback((assets: PickedAsset[]) => {
    if (assets.length === 0) {return;}
    // One upfront readiness check — without it a 10-photo pick during
    // session boot raised 10 sequential "Cannot send" alerts.
    const rt = runtimeRef.current;
    if (!rt || typeof rt.sendMedia !== 'function') {
      Alert.alert('Cannot send', 'Secure session is still initialising. Try again in a moment.');
      return;
    }
    mediaQueueRef.current.push(...assets);
    queueTotalRef.current += assets.length;
    setMediaQueue({done: queueDoneRef.current, total: queueTotalRef.current});
    if (mediaQueueRunning.current) {return;}
    // B-450 — snapshot the armed quote ONCE, here, as this run starts, and
    // disarm the composer immediately. Deliberately NOT above the guard above:
    // items enqueued into an ALREADY-RUNNING batch must not steal a reply the
    // user armed for their next message while the queue was draining.
    batchReplyRef.current = replyToRef.current;
    if (batchReplyRef.current) {
      replyToRef.current = null;
      setReplyTo(null);
    }
    mediaQueueRunning.current = true;
    void (async () => {
      try {
        for (;;) {
          const next = mediaQueueRef.current.shift();
          if (!next) {break;}
          // sendPickedMedia surfaces its own failures (failed bubble +
          // retry chip); the queue just moves on to the next item.
          // B-149 — forward the app-owned-source flag; without it the
          // voice-note plaintext survives the queue.
          try { await sendPickedMediaRef.current(next.uri, next.mime, next.kind, next.meta, next.ephemeralSource, next.caption); } catch { /* surfaced above */ }
          queueDoneRef.current += 1;
          setMediaQueue({done: queueDoneRef.current, total: queueTotalRef.current});
        }
      } finally {
        mediaQueueRunning.current = false;
        queueTotalRef.current = 0;
        queueDoneRef.current = 0;
        setMediaQueue(null);
        // Nothing consumed the batch quote (every item bailed before the
        // consume — the 50 MB cap `return`s without throwing, so no catch runs
        // either). Give it back rather than leaving it parked in the ref, where
        // the NEXT, unrelated batch would silently inherit it.
        if (batchReplyRef.current) {
          const unused = batchReplyRef.current;
          batchReplyRef.current = null;
          setReplyTo(cur => cur ?? unused);
        }
      }
    })();
  }, []);

  const captureImage = async () => {
    setAttachOpen(false);
    try {
      // Media-parity G10 — compress camera shots (WhatsApp-comparable
      // 1920px/q0.8). Original-resolution photos were the single biggest
      // send+receive latency cost.
      const res = await launchCamera({
        mediaType: 'photo', saveToPhotos: false, includeBase64: false,
        quality: 0.8, maxWidth: 1920, maxHeight: 1920,
      });
      const asset = res.assets?.[0];
      if (res.didCancel || !asset?.uri) {return;}
      // B-707 — a camera shot gets the same review + caption step as a library
      // pick. WhatsApp shows the shot with a caption field before it sends; an
      // immediate send gave the user no way to say anything about the photo.
      setPendingAssets([{
        uri:  asset.uri,
        mime: asset.type ?? 'image/jpeg',
        kind: 'image',
        meta: {name: asset.fileName ?? undefined, width: asset.width, height: asset.height},
      }]);
    } catch {
      Alert.alert('Camera unavailable', 'Could not open the camera on this device.');
    }
  };

  const pickImage = async () => {
    setAttachOpen(false);
    try {
      // G10 — quality/max apply to photos; library videos pass through
      // untouched (transcoding is out of scope).
      // B-87/MX-04 — multi-select up to MAX_PICKED_ASSETS, reviewed in the tray
      // so a batch is a deliberate send.
      // B-707 — a SINGLE pick used to skip the tray and fire straight down the
      // queue, which is precisely why there was nowhere to type a caption. Every
      // pick now goes through the tray.
      const res = await launchImageLibrary({
        mediaType: 'mixed', selectionLimit: MAX_PICKED_ASSETS, includeBase64: false,
        quality: 0.8, maxWidth: 1920, maxHeight: 1920,
      });
      if (res.didCancel) {return;}
      const assets = normalizePickedAssets(res.assets);
      if (assets.length === 0) {return;}
      haptics.select();
      setPendingAssets(assets);
    } catch {
      Alert.alert('Picker unavailable', 'Could not open the photo library.');
    }
  };

  const pickDocument = async () => {
    setAttachOpen(false);
    try {
      const res = await DocumentPicker.getDocumentAsync({type: '*/*', copyToCacheDirectory: true});
      if (res.canceled) {return;}
      const asset = res.assets?.[0];
      if (!asset?.uri) {return;}
      const mime = asset.mimeType ?? 'application/octet-stream';
      const kind: 'image' | 'audio' | 'video' | 'file' =
        mime.startsWith('image/') ? 'image'
        : mime.startsWith('audio/') ? 'audio'
        : mime.startsWith('video/') ? 'video'
        : 'file';
      // Media-parity M14 — the original filename used to be dropped here,
      // so recipients saw a bare mime type as the document title.
      enqueueMediaAssets([{uri: asset.uri, mime, kind, meta: {name: asset.name ?? undefined}}]);
    } catch {
      Alert.alert('Picker unavailable', 'Could not open the document picker.');
    }
  };

  // B-281 — `appendEmoji` is gone with the modal. The emoji panel now lives inside
  // <ChatComposer>, so it appends to the draft directly through the composer's own
  // `appendToDraft` instead of bouncing the emoji up to the screen and back down
  // through the imperative handle. The handle's `insert` stays for its other
  // callers (a hand-off draft from AgentLiveTracker).

  // B-159 — every prop handed to the memoised composer must have a STABLE
  // identity, or the composer re-renders on each screen render and the whole
  // extraction buys nothing. `send` and `enqueueMediaAssets` are redefined per
  // render, so they are reached through a latest-ref rather than captured.
  const sendRef = useRef(send);
  sendRef.current = send;
  const enqueueMediaAssetsRef = useRef(enqueueMediaAssets);
  enqueueMediaAssetsRef.current = enqueueMediaAssets;
  const onComposerSend = useCallback(
    (body: string, mentions?: Array<{userId: string; label: string}>) => {
      void sendRef.current(body, mentions);
    },
    [],
  );
  const onVoiceComplete = useCallback((rec: {uri: string; mimeType: string; durationMs: number}) => {
    enqueueMediaAssetsRef.current([{
      uri: rec.uri, mime: rec.mimeType, kind: 'audio',
      meta: {durationMs: rec.durationMs}, ephemeralSource: true,
    }]);
  }, []);
  const openAttachSheet = useCallback(() => setAttachOpen(true), []);
  /**
   * B-281 — the emoji button SWAPS the system IME for the emoji panel and back,
   * the way WhatsApp does. It is a toggle, not an open: tapping it while the
   * panel is up puts the caret back in the field and lets the IME return.
   *
   * `Keyboard.dismiss()` matters. The panel occupies the space the IME had; if
   * the IME stayed up, `bottomPad` would lift the composer by the IME inset AND
   * the panel would sit below it, pushing the input off-screen.
   */
  const openEmojiSheet  = useCallback(() => {
    setEmojiOpen(prev => {
      if (prev) { composerRef.current?.focusInput(); return false; }
      Keyboard.dismiss();
      return true;
    });
  }, []);
  const closeEmojiPanel = useCallback(() => {
    setEmojiOpen(false);
    composerRef.current?.focusInput();
  }, []);
  const openTimerSheet  = useCallback(() => setTimerOpen(true), []);

  // MERGE: my extracted pure helper, extended with their groupKeyPending case.
  const statusLabel = useMemo(
    () => chatStatusLabel({error, ready, mode: runtime?.mode, groupKeyPending}),
    [error, ready, runtime, groupKeyPending],
  );

  const loopbackActive = isLoopbackMode(runtime?.mode);

  // B-692 NL-7 — mark newly-appended ids as live arrivals DURING render, before
  // their bubbles mount (each bubble captures its entrance decision on first
  // render), so a pipeline-delayed message still animates in instead of popping
  // (the old created_at<2s check alone skipped anything delivered late). The
  // baseline render marks nothing — opening history must not re-spring (the
  // back/forward "flash" fix stays intact) — and an in-place conversation
  // switch re-baselines.
  const seenMsgIdsRef = useRef<Set<string> | null>(null);
  const seenMsgConvRef = useRef(conversationId);
  if (seenMsgConvRef.current !== conversationId) {
    seenMsgConvRef.current = conversationId;
    seenMsgIdsRef.current = null;
  }
  useMemo(() => {
    const seen = seenMsgIdsRef.current;
    if (seen === null) {
      seenMsgIdsRef.current = new Set(messages.map(m => m.id));
      return;
    }
    const fresh: string[] = [];
    for (const m of messages) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        fresh.push(m.id);
      }
    }
    if (fresh.length > 0) {markLiveArrivals(fresh);}

  }, [messages]);

  // Rank 13 day separators + one-shot unread divider, built chronologically
  // then REVERSED for the inverted list (see chatListItems.ts). Rows are
  // identity-stable across rebuilds (MX-07) so a single status flip only
  // re-renders the one changed bubble.
  const listItems = useMemo<ChatListItem[]>(
    () => buildInvertedChatListItems(messages, initialUnreadRef.current),
    [messages],
  );

  // Fix #30: hoist ListHeader / ListFooter / ListEmpty into memoised JSX.
  // Inline JSX in `ListHeaderComponent={(...)}` re-creates the element on
  // every render, forcing FlatList to re-mount the children — most notably
  // TypingBubble, whose animated dot loop restarts each time.
  // Inverted-list role swap: ListHeaderComponent renders at the VISUAL
  // BOTTOM (typing indicator, next to the composer) and ListFooterComponent
  // at the visual top. Header/footer are counter-flipped by
  // VirtualizedList, so their content renders upright.
  // FIX-05 — "No messages yet." is a claim about the server. Until the relay
  // drain has actually settled we have no basis for it, and on a cold boot with
  // a backlog the claim reads as data loss.
  // Audit round 2 — subscribe CONDITIONALLY: the label only exists for an
  // EMPTY thread, but a bare `s => s.syncState` selector re-rendered this
  // screen (the repo's most perf-sensitive one, ~82ms/render measured) twice
  // per drain cycle — on every reconnect, resume, focus and push wake — in
  // populated chats where nothing visible changes. With messages present the
  // selector pins to 'synced', so the store flips never propagate.
  const syncState = useMessengerStore(s => (messages.length > 0 ? 'synced' : s.syncState));
  const emptySyncLabel = chatEmptyStateLabel({ready, syncState});
  const listEmpty = useMemo(() => (
    <View style={styles.emptyWrap} collapsable={false}>
      {ready ? (
        emptySyncLabel ? (
          <>
            <Icon name="sync" size={28} color={DM.accent} />
            <Text style={styles.emptyText}>{emptySyncLabel}</Text>
          </>
        ) : (
          <>
            <Icon name="shield-lock-outline" size={28} color={DM.accent} />
            <Text style={styles.emptyText}>No messages yet.</Text>
            <Text style={styles.emptyHint}>
              {loopbackActive
                ? 'Loopback mode — messages echo back through an in-process peer to verify the crypto round-trip.'
                : 'Send a message — it will be end-to-end encrypted on this device before it leaves.'}
            </Text>
          </>
        )
      ) : null}
    </View>
  ), [ready, loopbackActive, emptySyncLabel]);
  // B-117 — WhatsApp-parity named typing label for GROUPS ("Alina is
  // typing…"); 1:1 keeps the plain dots (the header already names the
  // peer). Name precedence mirrors B-115: manual group override >
  // directory name > known direct-thread name > id fragment.
  const typingUserIds = useMessengerStore(s => s.typingUsers[conversationId]);
  // The name maps are SUBSCRIBED, not read via getState() inside the memo.
  // Reading them imperatively meant the memo's deps were [typingUserIds,
  // conversationId], so a name arriving after the typing frame — the normal
  // order, since directory lookups are async — never recomputed the label and it
  // stayed stuck on the `id.slice(0, 8)` hex fallback.
  const directoryNames  = useMessengerStore(s => s.directoryNames);
  const typingLabelText = useMemo(
    () => buildTypingLabel({
      typingUserIds,
      isGroup:          conversation?.type === 'group',
      groupMemberNames: groupNameMap,
      directoryNames,
      directThreadName: (id) => useMessengerStore.getState().conversations[`direct:${id}`]?.name,
    }),
    [typingUserIds, conversation?.type, groupNameMap, directoryNames],
  );
  const listBottomAccessory = useMemo(() => (
    <>
      <View style={{height: 8}} />
      <TypingBubble visible={peerTyping} label={typingLabelText} />
    </>
  ), [peerTyping, typingLabelText]);

  /**
   * Roster for the @-mention picker.
   *
   * GROUPS ONLY — in a 1:1 there is exactly one other participant and every
   * message is already addressed to them, so a picker would be pure noise.
   *
   * Names use the same B-115 precedence the rest of this screen uses (group
   * roster > directory > the peer's own 1:1 thread name > id fragment) so a
   * mention chip reads identically to the sender label above the bubble. A
   * member whose name has not resolved yet still appears, under their id
   * fragment — omitting them would make someone unmentionable purely because a
   * directory lookup was slow.
   */
  // B-115 — the directory map is a store slice, so subscribing here is what
  // re-runs the memo (and repaints the picker) when a backfilled name lands.
  const directoryNamesForMentions = useMessengerStore(s => s.directoryNames);
  const mentionRoster = useMemo(() => {
    // Every thread gets the same feature set — a 1:1 roster is just the peer.
    // A direct row often stores no `participants` (it carries `peer` instead),
    // so fall back to the resolved peer rather than returning an empty picker.
    const fromParticipants = (conversation?.participants ?? []).filter(u => u && u !== selfUserId);
    const members = fromParticipants.length > 0
      ? fromParticipants
      : [resolvedPeer?.userId].filter((u): u is string => !!u && u !== selfUserId);
    if (members.length === 0) {return undefined;}
    // Reuse the SAME resolver the sender label above each bubble uses, rather
    // than a second weaker chain. The old inline version stopped at
    // `directoryNames` and fell straight to `uid.slice(0,8)`, so a member who
    // had never been fetched showed as a hex fragment FOREVER — nothing on this
    // screen ever asked for their profile. `resolveSenderName` ends with an
    // `ensureDirectoryNames([...])` backfill (debounced + deduped + batched), so
    // the miss now queues a lookup and the store write repaints this list with
    // the real name. It also picks up dev contacts, server-UUID direct rows and
    // a known phone before ever showing a fragment.
    //
    // A manual group-member override still wins — that is the documented B-115
    // precedence (custom > address book > group override > directory > fragment).
    const unresolved: string[] = [];
    const roster = members.map(uid => {
      const override = groupNameMap?.[uid];
      const label = override ?? resolveSenderName(uid, '');
      if (!override && label === uid.slice(0, 8)) {unresolved.push(uid);}
      return {userId: uid, label};
    });
    if (unresolved.length) {
      // resolveSenderName already queues each miss, but do it as ONE batch for
      // the whole roster so opening the picker costs a single request.
      ensureDirectoryNames(unresolved);
    }
    // B-271 — `@all`, first in the list, GROUPS ONLY. In a 1:1 it would be a
    // synonym for the one other person, so it is noise. It is a synthetic
    // entry carrying a sentinel userId; `sendText` expands it to one mention
    // per member after its final reconcile, so nothing downstream ever sees
    // the sentinel.
    return isGroup ? [mentionAllCandidate(), ...roster] : roster;
  }, [conversation?.participants, resolvedPeer?.userId, groupNameMap, selfUserId, directoryNamesForMentions, isGroup]);

  // Fix #30: stable onScroll via ref-mirror so RN doesn't re-bind the
  // native handler across the JNI bridge each render. Inverted list:
  // "at bottom" = contentOffset.y near 0. New-message auto-follow is
  // native now (maintainVisibleContentPosition.autoscrollToTopThreshold),
  // so no onContentSizeChange scroll pass is needed.
  const onScroll = useCallback((e: {nativeEvent: {contentOffset: {y: number}}}) => {
    // 48px slack so pinch-scrolls near the bottom still count as "at bottom".
    const near = e.nativeEvent.contentOffset.y <= 48;
    if (near !== atBottomRef.current) {
      atBottomRef.current = near;
      setAtBottom(near);
    }
  }, []);

  // Round 6 / pagination — inverted list puts the OLDER end at the end of
  // the data, so plain onEndReached is the pagination trigger (the old
  // non-inverted list needed an onScroll `y < 200` heuristic). Gated on a
  // loading-in-flight ref + an exhausted-latch ref so overlapping calls
  // can't spam the runtime. Appending an older page never shifts existing
  // inverted offsets, so there's no anchor jerk to compensate for.
  const onEndReached = useCallback(() => {
    if (loadingOlderRef.current || exhaustedOlderRef.current || messagesLengthRef.current === 0) {return;}
    loadingOlderRef.current = true;
    const liveRuntime = runtimeRef.current;
    const liveConvId  = conversationIdRef.current;
    void (async () => {
      try {
        const fn = liveRuntime?.loadOlderMessages;
        if (!fn) {
          // Loopback or runtime not ready — latch so we don't keep
          // probing on every scroll tick.
          exhaustedOlderRef.current = true;
          return;
        }
        const {exhausted} = await fn(liveConvId);
        if (exhausted) {exhaustedOlderRef.current = true;}
      } catch (err) {
        // Don't latch on transient errors — let the next scroll
        // try again. Quiet warn so the chat console doesn't blare.
        console.log('[chat.loadOlder] failed:', (err as Error).message);
      } finally {
        loadingOlderRef.current = false;
      }
    })();
  }, []);

  // ─── In-conversation search (founder 2026-08-26) ─────────────────────
  // A header magnify opens a sheet that queries runtime.searchMessages
  // scoped to THIS conversation; tapping a hit closes the sheet and
  // deep-jumps to the message.
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [chatSearchHits, setChatSearchHits] = useState<ReadonlyArray<LocalMessage>>([]);
  const [chatSearchBusy, setChatSearchBusy] = useState(false);
  const closeChatSearch = useCallback(() => {
    setChatSearchOpen(false);
    setChatSearchQuery('');
    setChatSearchHits([]);
  }, []);

  useEffect(() => {
    if (!chatSearchOpen) {return;}
    const q = chatSearchQuery.trim();
    // Same 2-char floor as every other B-636 surface.
    if (q.length < 2 || !runtime?.searchMessages) {
      setChatSearchHits([]);
      return;
    }
    let alive = true;
    setChatSearchBusy(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const msgs = await runtime.searchMessages?.(q, {conversationIds: [conversationId], limit: 30}) ?? [];
          if (alive) {setChatSearchHits(msgs);}
        } catch {
          if (alive) {setChatSearchHits([]);}
        } finally {
          if (alive) {setChatSearchBusy(false);}
        }
      })();
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [chatSearchOpen, chatSearchQuery, runtime, conversationId]);

  /**
   * Deep jump — land on a message even when it is OUTSIDE the loaded window.
   * `jumpToMessage` itself only scrolls within `listItems` (and must not be
   * refactored — replyJumpParity pins its shape), so this effect pages older
   * history in via the same guarded `onEndReached` loader until the target id
   * appears (or history is exhausted / 20-page bound), then hands off to
   * `jumpToMessageRef`. Object-wrapped so re-tapping the SAME hit re-fires.
   */
  const [searchTarget, setSearchTarget] = useState<{id: string} | null>(null);
  const focusConsumedRef = useRef<string | null>(null);
  const focusPagesRef = useRef(0);
  useEffect(() => {
    const target = searchTarget?.id ?? focusMessageId ?? null;
    if (!target || focusConsumedRef.current === target) {return;}
    const found = listItems.some(it =>
      it.kind === 'msg' && (it.msg.id === target || it.msg.id.startsWith(target + '#')));
    if (found) {
      focusConsumedRef.current = target;
      focusPagesRef.current = 0;
      // Let the freshly-prepended rows commit before scrolling to an index.
      const t = setTimeout(() => { jumpToMessageRef.current(target); }, 150);
      return () => clearTimeout(t);
    }
    if (focusPagesRef.current >= 20 || exhaustedOlderRef.current || loadingOlderRef.current) {return;}
    focusPagesRef.current += 1;
    // Guarded loader; when the page lands, `listItems` changes and this
    // effect re-runs — a reactivity loop with the exhausted/20-page bound.
    onEndReached();
  }, [searchTarget, focusMessageId, listItems, onEndReached]);

  // MX-12 — renderItem as a useCallback instead of a fresh inline closure
  // per ChatScreen render. Its identity now only changes when the data it
  // actually reads changes; MessageBubble's memo comparator still absorbs
  // per-row work.
  const conversationName = conversation?.name;
  const renderListItem = useCallback(({item}: ListRenderItemInfo<ChatListItem>) => {
    if (item.kind === 'day') {
      return (
        <View style={styles.dateSep}>
          <View style={styles.dateLine} />
          <Text style={styles.dateText}>{item.label}</Text>
          <View style={styles.dateLine} />
        </View>
      );
    }
    if (item.kind === 'unread') {
      return (
        <View style={styles.unreadSep}>
          <View style={styles.unreadLine} />
          <View style={styles.unreadPill}>
            <Text style={styles.unreadPillText}>
              {item.count} UNREAD {item.count === 1 ? 'MESSAGE' : 'MESSAGES'}
            </Text>
          </View>
          <View style={styles.unreadLine} />
        </View>
      );
    }
    const msg = item.msg;
    // item.index is the CHRONOLOGICAL index (display order is reversed),
    // so prev/next run-grouping reads stay unchanged.
    const i = item.index;
    const prev = messages[i - 1];
    const next = messages[i + 1];
    // Cross-day boundaries break the run regardless of time delta,
    // so a message at the start of a new day always paints with
    // its own header tick and avatar.
    const prevSameDay = prev && sameDay(prev.created_at, msg.created_at);
    const nextSameDay = next && sameDay(msg.created_at, next.created_at);
    const isFirstInGroup = !prev
      || !prevSameDay
      || prev.sender_id !== msg.sender_id
      || timeDeltaMs(prev.created_at, msg.created_at) > GROUP_THRESHOLD_MS;
    const isLastInGroup = !next
      || !nextSameDay
      || next.sender_id !== msg.sender_id
      || timeDeltaMs(msg.created_at, next.created_at) > GROUP_THRESHOLD_MS;
    const quoted = msg.reply_to_msg_id ? byIdCache.get(msg.reply_to_msg_id) : undefined;
    // Audit MSG-17 (2026-07-02): in a GROUP, attribute the quoted
    // message to its ACTUAL sender, not the group's name.
    // B-411 — the 1:1 attribution uses the RESOLVED header name, never the
    // raw route param (which can still be the `Bravo · <hex>` placeholder,
    // or undefined on a killed-tap deep link).
    const quotedSenderLabel = quoted
      ? (quoted.sender_id === 'self'
          ? 'You'
          : (isGroup && quoted.sender_id
              ? (groupNameMap?.[quoted.sender_id] ?? resolveSenderName(quoted.sender_id, name))
              : headerDisplayName))
      : msg.reply_to_msg_id
        ? headerDisplayName
        : undefined;
    // Group chat: label + color for each incoming sender. The admin
    // alias (groupNameMap) wins over the profile name so the rename
    // feature from GroupInfo reflects live in the chat.
    const senderLabel = isGroup && msg.sender_id && msg.sender_id !== 'self'
      ? (groupNameMap?.[msg.sender_id] ?? resolveSenderName(msg.sender_id, name))
      : undefined;
    const senderColor = isGroup && msg.sender_id && msg.sender_id !== 'self'
      ? senderColorFor(msg.sender_id)
      : undefined;
    // Call-record bubble renders as a centered pill, not a side-aligned
    // chat bubble. Tapping it launches a fresh call to the same peer.
    if (msg.type === 'call' && msg.call_meta) {
      return (
        <CallRecordRow
          msg={msg}
          // B-411 — resolved name, never the raw store name: a cold caller is
          // exactly the flow that mints the placeholder row AND the call
          // record, so this pill was the highest-probability leak left.
          peerName={headerDisplayName || 'Contact'}
          onPress={() => launchCall(navigation, {
            conversationId,
            callType: msg.call_meta!.kind,
          })}
        />
      );
    }
    return (
      <MessageBubble
        msg={msg}
        album={item.album}
        onOpenPhoto={setViewerMsg}
        // B-450 — a photo burst collapses to ONE row (chatListItems), so the
        // row's own onLongPress can only ever target the leader. The grid hands
        // back the tapped tile's message instead.
        onLongPressPhoto={longPressMessage}
        isFirstInGroup={isFirstInGroup}
        isLastInGroup={isLastInGroup}
        highlighted={highlightedId === msg.id}
        quotedSenderLabel={quotedSenderLabel}
        senderLabel={senderLabel}
        senderColor={senderColor}
        onOpenImage={() => setViewerMsg(msg)}
        onLongPress={() => longPressMessage(msg)}
        onSwipeReply={() => { haptics.tap(); startReply(msg); }}
        onDoubleTap={() => { void reactToMessage(msg, '❤️'); }}
        onReplyTap={() => {
          if (msg.reply_to_msg_id) {jumpToMessageRef.current(msg.reply_to_msg_id);}
        }}
        onShowReactors={() => setReactorsMsg(msg)}
        onRetry={() => { void retrySend(msg); }}
        selfUserId={selfUserId}
      />
    );
  }, [messages, byIdCache, groupNameMap, highlightedId, isGroup, name, conversationName,
      headerDisplayName, conversationId, navigation, startReply, longPressMessage,
      reactToMessage, retrySend, selfUserId]);

  return (
    <View style={[styles.root, {paddingTop: insets.top, backgroundColor: CHAT_BG}]}>
      <AmbientBg bg={CHAT_BG} />
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* ── Premium chat header ────────────────────────────── */}
      {/* PDF item 12 — "The buttons at the top right of the screen is cut off."
          The fix landed on MessengerHomeScreen and was never ported here, so the
          voice/video buttons below still ran into the display edge.

          The ROOT only applies `paddingTop: insets.top`, and `styles.header` is a
          flat `paddingHorizontal: 18` — neither of which reserves the LEFT/RIGHT
          safe area. Portrait phones have none, which is why it reads as fine and
          why this was missed; landscape and side-cutout devices have a real one,
          and the top-right actions are the last thing in the row, so they are
          what gets clipped.

          Same shape as MessengerHomeScreen: base padding PLUS the inset, never
          the inset alone (that would lose the design's 18dp gutter). */}
      <View style={[
        styles.header,
        {paddingLeft: headerGutter + insets.left, paddingRight: headerGutter + insets.right, gap: headerGap},
      ]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="chevron-left" size={17} color={Bravo.text} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.contactInfo}
          activeOpacity={0.8}
          onPress={() => navigateOnce(navigation, 'ChatInfo', {conversationId})}>
          <View style={styles.avatarWrap}>
            {/* N-07 — prefer the store's name; route `name` may be absent on a
                notification-tap deep-link. initials() also guards undefined. */}
            {/* B-259 — the chat header was the last surface still showing
                initials for a user who HAS a photo: the list, the call tiles
                and the calls log all resolve one, so opening the thread made
                the avatar appear to vanish. Groups keep the gradient disc — a
                group has no single face. */}
            {/* B-291 — a group with a photo shows it here too. Without this the
                photo would exist only on the info sheet, which reads as "the
                photo didn't save". Groups go through GroupAvatar, people through
                UserAvatar; both fall back to the same gradient disc. */}
            {isGroup ? (
              <GroupAvatar
                groupId={conversationId}
                size={40}
                fallback={
                  <LinearGradient colors={avatarGradientFor(conversationId)} start={{x: 0.1, y: 0}} end={{x: 0.9, y: 1}} style={styles.avatar}>
                    <Text style={styles.avatarText}>{initials(headerDisplayName)}</Text>
                  </LinearGradient>
                }
              />
            ) : (
              <UserAvatar
                userId={peerUserId}
                size={40}
                fallback={
                  <LinearGradient colors={avatarGradientFor(conversationId)} start={{x: 0.1, y: 0}} end={{x: 0.9, y: 1}} style={styles.avatar}>
                    <Text style={styles.avatarText}>{initials(headerDisplayName)}</Text>
                  </LinearGradient>
                }
              />
            )}
            {!isGroup && <OnlineDot state={headerDotState(peerPresence)} ringColor={CHAT_BG} />}
          </View>
          <View style={{flex:1, minWidth:0}}>
            <View style={styles.nameRow}>
              <Text
                style={[styles.contactName, {fontSize: chatNameSize}]}
                numberOfLines={1}
                maxFontSizeMultiplier={1.2}>
                {headerDisplayName}
              </Text>
              {/* B-263 — the shield-check next to the name is gone. It was
                  rendered unconditionally for every peer, so it was decoration,
                  not a verification signal, and a badge that is always true is
                  indistinguishable from one that is broken. The presence row
                  below carries the state that actually varies. */}
            </View>
            <View style={styles.presenceRow}>
              {isGroup && conversation ? (
                <GroupMemberStack participants={conversation.participants} />
              ) : (
                <PeerPresencePill presence={peerPresence} />
              )}
            </View>
          </View>
        </TouchableOpacity>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => setChatSearchOpen(true)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Search in conversation">
            <Icon name="magnify" size={17} color={DM.onAccent} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => launchCall(navigation, {conversationId, callType: 'voice'})} activeOpacity={0.7}>
            <Icon name="phone-outline" size={17} color={DM.onAccent} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => launchCall(navigation, {conversationId, callType: 'video'})} activeOpacity={0.7}>
            <Icon name="video-outline" size={17} color={DM.onAccent} />
          </TouchableOpacity>
        </View>
      </View>

      {/* B-263 — the permanent "Messages are end-to-end encrypted" banner is
          gone. Encryption is unconditional, so the banner never changed and
          cost a strip of the message area in every chat, every time.
          LOOPBACK is a genuinely exceptional state and stays — but the stack
          now renders only when it fires, otherwise its own padding would leave
          the same dead band the banner used to occupy. */}
      {loopbackActive && (
        <View style={styles.bannersStack}>
          <PremiumBanner tone="amber" label="LOOPBACK MODE" detail="Echo verification active" icon="information-outline" />
        </View>
      )}

      {/* B-411/§2 — unsaved peer with a known number: one-tap save to the
          device address book (system contact form; WhatsApp parity). */}
      {!isGroup && savedState === 'not-saved' && !!convPhone && (
        <View style={styles.bannersStack}>
          <TouchableOpacity onPress={() => { void handleSaveContact(); }} activeOpacity={0.8}
            accessibilityLabel={`Add ${headerDisplayName} to contacts`}>
            <PremiumBanner tone="signal" icon="account-plus-outline"
              label="Not in contacts" detail={`Add ${headerDisplayName}`} />
          </TouchableOpacity>
        </View>
      )}

      <ConnectionBanner state={connectionState} />

      {/* Stable slot for error / init status (hidden when nothing to say) */}
      <View style={[styles.devBanner, error && styles.devBannerError, !statusLabel && styles.devBannerHidden]}>
        {statusLabel ? (
          <>
            <Icon
              name={error ? 'alert-circle' : ready ? 'information-outline' : 'progress-clock'}
              size={12}
              color={error ? Bravo.alert : Bravo.amber}
            />
            <Text style={[styles.devBannerText, error && {color: Bravo.alert}]}>{statusLabel}</Text>
          </>
        ) : null}
      </View>

      {/*
        B-184 — no KeyboardAvoidingView. <ChatComposer> is the bottom-most
        element, so IT owns the keyboard inset (useKeyboardLayout().bottomPad).
        The composer grows by the IME overlap and this flex column shrinks the
        list by the same amount, which is what adjustResize used to do for us
        before edge-to-edge nulled it. KAV's keyboardVerticalOffset was adding
        insets.top + 10 of pure blind space on iOS.
      */}
      <View style={[styles.flex, isLargeScreen && {maxWidth: contentMaxWidth, alignSelf: 'center', width: '100%'}]}>
        {!isGroup && (
          <PeerOfflineBanner presence={peerPresence} variant="chat" peerName={headerDisplayName} />
        )}
        <FlatList
          ref={scrollRef}
          style={styles.msgList}
          contentContainerStyle={styles.msgContent}
          data={listItems}
          keyExtractor={listItemKeyExtractor}
          // MX-05 — inverted: index 0 (newest) renders at the visual
          // bottom, so the chat opens ON the latest message with zero
          // scroll passes, exactly like WhatsApp/Signal.
          inverted
          // Audit MSG-15 — jumpToMessage uses scrollToIndex; with no
          // getItemLayout an offscreen target can't be measured yet, which
          // would otherwise THROW. Nudge toward the target and let the next
          // render settle instead of crashing.
          onScrollToIndexFailed={(info) => {
            // Polish #3 (2026-07-02): the approx offset lands NEAR the target;
            // once the surrounding cells have measured (highWaterMark advanced
            // past the index), retry a PRECISE scrollToIndex so a reply-quote
            // jump lands exactly on the quoted bubble like WhatsApp, not a
            // guess. Bounded single retry — if it still can't measure we keep
            // the approximate position rather than looping.
            const approx = Math.max(0, info.averageItemLength * info.index - 80);
            scrollRef.current?.scrollToOffset({offset: approx, animated: true});
            setTimeout(() => {
              try {
                scrollRef.current?.scrollToIndex({index: info.index, viewPosition: 0.7, animated: true});
              } catch { /* still unmeasured — approximate position stands */ }
            }, 180);
          }}
          // Virtualization windows — B-279, and these numbers are MEASURED, not
          // taste. `dumpsys gfxinfo` over four open-chat/back cycles put the
          // 99th-percentile frame at 61ms with "Slow UI thread" on 64 of 419
          // frames while the GPU sat at 7ms: opening a chat was bound by the UI
          // thread MOUNTING views, not by drawing them. The old 20/20/11 set
          // mounted ~20 bubbles synchronously in the first commit (about 2.5
          // screens on a 1080x2400 panel, which holds ~8) and kept up to 11
          // screens resident.
          //
          // 10 still fills the viewport with margin, so there is no blank
          // first paint; 8 per batch keeps each incremental commit short enough
          // to land inside a frame during a fling; windowSize 5 is viewport + 2
          // screens either side, which still absorbs a normal flick.
          initialNumToRender={10}
          maxToRenderPerBatch={8}
          windowSize={5}
          // We DO NOT supply getItemLayout — bubble heights vary
          // wildly (text, images, replies, group sender labels) and
          // an incorrect layout func produces jumpy scroll positions.
          // The cost is FlatList must measure as it renders, but the
          // virtualization win still dwarfs that.
          // Polish #4 (2026-07-02): recycle offscreen cells on ANDROID so a
          // long media-heavy chat doesn't grow native-view memory / GC pressure
          // on mid-range devices (the target class). Kept OFF on iOS where the
          // measure-on-render blank-frame flicker was observed.
          removeClippedSubviews={Platform.OS === 'android'}
          // Inverted-list anchor semantics: a NEW message prepends at data
          // index 0. If the user is within autoscrollToTopThreshold of the
          // bottom (coordinate top), the native side follows it into view;
          // if they're scrolled up reading history, minIndexForVisible: 0
          // holds their anchor row still instead of jerking the viewport.
          // Older-page APPENDS never shift inverted offsets, so pagination
          // needs no anchor work at all.
          maintainVisibleContentPosition={{minIndexForVisible: 0, autoscrollToTopThreshold: 80}}
          onScroll={onScroll}
          // MX-11 — 16 ms cadence: at-bottom detection (FAB visibility)
          // tracks the finger instead of lagging ~5 frames at 80 ms. The
          // handler only mutates a ref + one boolean.
          scrollEventThrottle={16}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.6}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={listBottomAccessory}
          ListFooterComponent={LIST_TOP_SPACER}
          ListEmptyComponent={listEmpty}
          renderItem={renderListItem}
        />

        {replyTo && (
          <View style={styles.replyBar}>
            <Icon name="reply" size={16} color={DM.quoteBar} />
            <View style={styles.replyBarBody}>
              <Text style={styles.replyBarLabel} numberOfLines={1}>
                {replyTo.fromSelf ? 'Replying to yourself' : `Replying to ${headerDisplayName}`}
              </Text>
              <Text style={styles.replyBarText} numberOfLines={1}>{replyTo.preview}</Text>
            </View>
            <TouchableOpacity style={styles.replyBarClose} onPress={() => setReplyTo(null)} activeOpacity={0.7} hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
              <Icon name="close" size={15} color={DM.textDim} />
            </TouchableOpacity>
          </View>
        )}

        {mediaQueue && (
          // MX-09 — non-blocking narration: the composer stays live while
          // the serial queue encrypts + uploads (bubbles carry the ring).
          <View style={styles.mediaSendingBar}>
            <Icon name="lock" size={13} color={DM.accent} />
            <Text style={styles.mediaSendingText}>
              {mediaQueue.total > 1
                ? `Encrypting & sending ${Math.min(mediaQueue.done + 1, mediaQueue.total)} of ${mediaQueue.total}…`
                : 'Encrypting & sending attachment…'}
            </Text>
          </View>
        )}

        <ChatComposer
          ref={composerRef}
          initialDraft={savedDraft}
          composerEnabled={composerEnabled}
          groupKeyPending={groupKeyPending}
          ready={ready}
          ttlSec={ttlSec}
          onSend={onComposerSend}
          onDraftActivity={onDraftActivity}
          onPersistDraft={onPersistDraft}
          onAttach={openAttachSheet}
          onEmoji={openEmojiSheet}
          emojiOpen={emojiOpen}
          onCloseEmoji={closeEmojiPanel}
          onTimer={openTimerSheet}
          onVoiceComplete={onVoiceComplete}
          mentionRoster={mentionRoster}
          isEditing={!!editing}
          onCancelEdit={cancelEdit}
        />
      </View>

      {/* Scroll-to-bottom FAB — appears when the user has scrolled up,
          badged with unread count when new messages arrive behind them. */}
      {!atBottom && (
        <TouchableOpacity
          style={[styles.scrollFab, {bottom: insets.bottom + 88}]}
          onPress={() => {
            scrollRef.current?.scrollToOffset({offset: 0, animated: true});
            setAtBottom(true);
            setNewCount(0);
          }}
          activeOpacity={0.8}>
          <Icon name="chevron-down" size={22} color="#B8C7E0" />
          {newCount > 0 && (
            <View style={styles.scrollFabBadge}>
              <Text style={styles.scrollFabBadgeText}>{newCount > 99 ? '99+' : newCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* In-conversation search (founder 2026-08-26) */}
      {chatSearchOpen && (
      <Modal visible transparent animationType="slide" onRequestClose={closeChatSearch}>
        <Pressable style={styles.sheetBackdrop} onPress={closeChatSearch}>
          <Pressable style={[styles.sheet, {maxHeight: '75%', paddingBottom: insets.bottom + 16}]}>
            <Text style={styles.sheetTitle}>Search this chat</Text>
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 42, paddingVertical: 6,
              borderWidth: 1, borderColor: DM.hair2, borderRadius: 12,
              paddingHorizontal: 12, backgroundColor: DM.glassFill,
            }}>
              <Icon name="magnify" size={16} color={DM.textMute} />
              <TextInput
                value={chatSearchQuery}
                onChangeText={setChatSearchQuery}
                placeholder="Search messages…"
                placeholderTextColor={DM.textMute}
                autoFocus
                autoCorrect={false}
                returnKeyType="search"
                accessibilityLabel="Search in conversation"
                style={{flex: 1, color: DM.text, fontSize: 14, paddingVertical: 0}}
              />
              {chatSearchQuery.length > 0 && (
                <TouchableOpacity
                  onPress={() => setChatSearchQuery('')}
                  hitSlop={{top: 8, left: 8, right: 8, bottom: 8}}
                  accessibilityRole="button"
                  accessibilityLabel="Clear conversation search">
                  <Icon name="close-circle" size={16} color={DM.textMute} />
                </TouchableOpacity>
              )}
            </View>
            <ScrollView style={{marginTop: 12}} keyboardShouldPersistTaps="handled">
              {chatSearchQuery.trim().length < 2 ? (
                <Text style={{color: DM.textMute, fontSize: 12.5, paddingVertical: 12}}>
                  Type at least 2 characters to search this conversation.
                </Text>
              ) : chatSearchBusy && chatSearchHits.length === 0 ? (
                <Text style={{color: DM.textMute, fontSize: 12.5, paddingVertical: 12}}>Searching…</Text>
              ) : chatSearchHits.length === 0 ? (
                <Text style={{color: DM.textMute, fontSize: 12.5, paddingVertical: 12}}>
                  No messages match “{chatSearchQuery.trim()}”.
                </Text>
              ) : chatSearchHits.map(m => {
                const snip = buildSnippet(m.content ?? '', chatSearchQuery.trim());
                if (!snip) {return null;}
                return (
                  <TouchableOpacity
                    key={m.id}
                    testID={`chat-search-hit-${m.id}`}
                    onPress={() => {
                      // Reset the consumed latch so re-tapping the same hit
                      // (after scrolling away) still jumps.
                      focusConsumedRef.current = null;
                      setSearchTarget({id: m.id});
                      closeChatSearch();
                    }}
                    activeOpacity={0.75}
                    style={{paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: DM.hair}}>
                    <Text numberOfLines={1} style={{color: DM.textDim, fontSize: 13.5}}>
                      {snip.before}
                      <Text style={{color: DM.onAccent, fontWeight: '600'}}>{snip.match}</Text>
                      {snip.after}
                    </Text>
                    <Text style={{color: DM.textFaint, fontSize: 10.5, marginTop: 2}}>
                      {m.sender_id === 'self' ? 'You' : ''}{m.sender_id === 'self' ? ' · ' : ''}{formatListTimestamp(m.created_at)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
      )}

      {/* Forward picker — lists other conversations */}
      {forwardSource && (
      <Modal visible={!!forwardSource} transparent animationType="slide" onRequestClose={() => setForwardSource(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setForwardSource(null)}>
          <Pressable style={[styles.sheet, {maxHeight: '70%', paddingBottom: insets.bottom + 20}]}>
            <Text style={styles.sheetTitle}>Forward to…</Text>
            <ForwardList
              currentConvId={conversationId}
              onPick={id => { void forwardTo(id); }}
            />
            <TouchableOpacity style={styles.sheetCancel} onPress={() => setForwardSource(null)} activeOpacity={0.7}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
      )}

      {/* Long-press message action sheet */}
      {actionMsg && (
      <Modal visible={!!actionMsg} transparent animationType="fade" onRequestClose={() => setActionMsg(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setActionMsg(null)}>
          <Pressable style={[styles.sheet, styles.actionSheet, {paddingBottom: insets.bottom + 12}]}>
            {actionMsg && (
              <>
                {/* A retracted message has nothing to react to, reply to, copy,
                    forward or edit — only "remove it from this device" still
                    makes sense. Collapsing the sheet is clearer than showing
                    six rows that would all no-op. */}
                {!actionMsg.deleted_for_all && (
                <View style={styles.actionReactRow}>
                  {QUICK_REACTIONS.map(emoji => {
                    const mine = actionMsg.reactions?.self === emoji;
                    return (
                      <TouchableOpacity
                        key={emoji}
                        style={[styles.actionReactBtn, mine && styles.actionReactBtnMine]}
                        onPress={() => { void reactToMessage(actionMsg, emoji); }}
                        activeOpacity={0.7}>
                        <Text style={styles.actionReactEmoji}>{emoji}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                )}
                <View style={styles.actionDivider} />
                {!actionMsg.deleted_for_all && (
                <>
                <TouchableOpacity style={styles.sheetRow} onPress={() => startReply(actionMsg)} activeOpacity={0.7}>
                  <Icon name="reply" size={20} color={DM.onAccent} />
                  <Text style={styles.sheetRowText}>Reply</Text>
                </TouchableOpacity>
                {actionMsg.content && (
                  <TouchableOpacity style={styles.sheetRow} onPress={() => { void copyMessage(actionMsg); }} activeOpacity={0.7}>
                    <Icon name="content-copy" size={20} color={DM.onAccent} />
                    <Text style={styles.sheetRowText}>Copy</Text>
                  </TouchableOpacity>
                )}
                {/* Edit — own TEXT messages only, inside the 15-minute window.
                    The same predicate the runtime re-checks before shipping, so
                    a row that is offered here can never be refused there. */}
                {canEditOwnMessage(actionMsg) && (
                  <TouchableOpacity style={styles.sheetRow} onPress={() => startEdit(actionMsg)} activeOpacity={0.7}>
                    <Icon name="pencil-outline" size={20} color={DM.onAccent} />
                    <Text style={styles.sheetRowText}>Edit</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.sheetRow} onPress={() => startForward(actionMsg)} activeOpacity={0.7}>
                  <Icon name="share-outline" size={20} color={DM.onAccent} />
                  <Text style={styles.sheetRowText}>Forward</Text>
                </TouchableOpacity>
                {/* Message info — own message, EVERY thread. Was group-only;
                    a 1:1 has exactly one reader, which is still the delivered/
                    read detail WhatsApp shows there. */}
                {actionMsg.sender_id === 'self' && (
                  <TouchableOpacity
                    style={styles.sheetRow}
                    onPress={() => { const m = actionMsg; setActionMsg(null); setInfoMsg(m); }}
                    activeOpacity={0.7}>
                    <Icon name="information-outline" size={20} color={DM.onAccent} />
                    <Text style={styles.sheetRowText}>Message info</Text>
                  </TouchableOpacity>
                )}
                {/* Delete for everyone — own messages, inside the 48-hour
                    window. Confirmed before it fires: it is not reversible. */}
                {canDeleteForEveryone(actionMsg) && (
                  <TouchableOpacity style={styles.sheetRow} onPress={() => deleteForEveryone(actionMsg)} activeOpacity={0.7}>
                    <Icon name="delete-forever-outline" size={20} color="#F58B97" />
                    <Text style={[styles.sheetRowText, {color:'#F58B97'}]}>Delete for everyone</Text>
                  </TouchableOpacity>
                )}
                </>
                )}
                <TouchableOpacity style={styles.sheetRow} onPress={() => deleteMessage(actionMsg)} activeOpacity={0.7}>
                  <Icon name="trash-can-outline" size={20} color="#F58B97" />
                  <Text style={[styles.sheetRowText, {color:'#F58B97'}]}>Delete for me</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.sheetCancel} onPress={() => setActionMsg(null)} activeOpacity={0.7}>
                  <Text style={styles.sheetCancelText}>Cancel</Text>
                </TouchableOpacity>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
      )}

      {/* B-116 phase 2 — Message info: per-member read status for an own
          group message. Names use the B-115 precedence (manual override >
          directory > direct-thread > id fragment); members without a
          receipt show "—" (receipts-off members are indistinguishable
          from unread — same as WhatsApp). */}
      {infoMsg && (
      <Modal visible={!!infoMsg} transparent animationType="fade" onRequestClose={() => setInfoMsg(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setInfoMsg(null)}>
          <Pressable style={[styles.sheet, styles.actionSheet, {paddingBottom: insets.bottom + 12}]}>
            {liveInfoMsg && (() => {
              const st = useMessengerStore.getState();
              // The auth UUID, not the vault owner key — otherwise the author
              // never filters out and lists themselves under "Read by" with a
              // permanent dash (same root cause as the missing blue tick).
              const ownUid = st._ownAuthUserId ?? st._ownUserId;
              // B-264 — a DIRECT row often carries no `participants` array, so
              // this list came out empty and the sheet rendered a bare "Read
              // by" heading with nothing under it on every 1:1. Fall back to
              // the thread's peer, which is the entire membership of a 1:1.
              const rawMembers = (st.conversations[conversationId]?.participants ?? [])
                .filter(u => u && u !== ownUid);
              const members = rawMembers.length > 0
                ? rawMembers
                : (peerUserId && peerUserId !== ownUid ? [peerUserId] : []);
              const nameOf = (id: string): string =>
                st.groupMemberNames[conversationId]?.[id] ??
                st.directoryNames[id] ??
                st.conversations[`direct:${id}`]?.name ??
                id.slice(0, 8);
              return (
                <>
                  <Text style={styles.sheetTitle}>Read by</Text>
                  <View style={styles.actionDivider} />
                  {members.map(uid => {
                    // B-264 — read from the LIVE row, and show a time for
                    // 'delivered' too. Previously only 'read' got a timestamp
                    // and everything else collapsed to a bare dash, so a
                    // message that HAD reached someone's device looked
                    // identical to one that had gone nowhere. The two states
                    // are the whole reason this panel exists.
                    const r = liveInfoMsg.receipts?.[uid];
                    // B-683 follow-up (WhatsApp "Message info" parity) — a
                    // member whose device terminally destroyed its copy shows
                    // as Not delivered, distinct from "no receipt yet". A
                    // delivered/read receipt wins (server-impossible to have
                    // both; belt-and-braces mirrors the flip predicate).
                    const deadAt = !r ? liveInfoMsg.undeliverable_legs?.[uid] : undefined;
                    const at = r ? messageInfoTime(r.ts)
                      : deadAt !== undefined ? messageInfoTime(deadAt) : '';
                    const label = r?.status === 'read'
                      ? `Seen ${at}`
                      : r?.status === 'delivered'
                        ? `Delivered ${at}`
                        : deadAt !== undefined
                          ? `Not delivered ${at}`
                          : '—';
                    return (
                      <View key={uid} style={styles.sheetRow}>
                        <Icon
                          name={deadAt !== undefined ? 'alert-circle' : r ? 'check-all' : 'check'}
                          size={18}
                          color={deadAt !== undefined ? Bravo.alert : r?.status === 'read' ? DM.accent : DM.textMute}
                        />
                        <Text style={styles.sheetRowText} numberOfLines={1}>{nameOf(uid)}</Text>
                        <Text style={{color: DM.textMute, fontSize: 12, marginLeft: 'auto'}}>{label}</Text>
                      </View>
                    );
                  })}
                  <TouchableOpacity style={styles.sheetCancel} onPress={() => setInfoMsg(null)} activeOpacity={0.7}>
                    <Text style={styles.sheetCancelText}>Close</Text>
                  </TouchableOpacity>
                </>
              );
            })()}
          </Pressable>
        </Pressable>
      </Modal>
      )}

      {/* B-282 — "who reacted?" The store keyed reactions by the reactor's userId
          all along; `groupReactions` was collapsing that to a count and the roster
          was never shown anywhere. Tapping the reaction row opens this. */}
      {reactorsMsg && (
      <Modal visible transparent animationType="fade" onRequestClose={() => setReactorsMsg(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setReactorsMsg(null)}>
          <Pressable style={[styles.sheet, {paddingBottom: insets.bottom + 20}]}>
            <Text style={styles.sheetTitle}>Reactions</Text>
            {(() => {
              // Same name precedence the mention roster uses (B-115): a manual
              // group override wins, then the shared resolver. Misses are batched
              // into ONE directory request rather than one per reactor.
              const reactions = reactorsMsg.reactions ?? {};
              const rows = reactionRoster(reactions, uid =>
                groupNameMap?.[uid] ?? resolveSenderName(uid, ''));
              const unresolved = rows
                .filter(r => !r.isSelf && r.label.endsWith('…'))
                .map(r => r.userId);
              if (unresolved.length) { ensureDirectoryNames(unresolved); }
              return (
                <ScrollView style={styles.reactorScroll} keyboardShouldPersistTaps="always">
                  {rows.map(r => (
                    <View key={r.userId} style={styles.reactorRow}>
                      <Text style={styles.reactorEmoji}>{r.emoji}</Text>
                      <Text style={styles.reactorName} numberOfLines={1}>{r.label}</Text>
                      {r.isSelf && (
                        <Text style={styles.reactorHint}>tap the message to change</Text>
                      )}
                    </View>
                  ))}
                </ScrollView>
              );
            })()}
          </Pressable>
        </Pressable>
      </Modal>
      )}

      {/* Attachment sheet — each row opens the matching native picker,
          encrypts the bytes (AES-256-CBC) on-device, and ships the
          per-file key in-band inside the sealed envelope. */}
      {attachOpen && (
      <Modal visible={attachOpen} transparent animationType="slide" onRequestClose={() => setAttachOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setAttachOpen(false)}>
          <Pressable>
            {/* The other sheets on this screen already add insets.bottom; this
                one did not, so its last row sat under the gesture pill. */}
            <LinearGradient
              colors={SHEET_GRADIENT} start={{x: 0, y: 0}} end={{x: 0, y: 1}}
              style={[styles.attachSheet, {paddingBottom: insets.bottom + 30}]}>
              <View style={styles.attachHandle} />
              <View style={styles.attachHeader}>
                <Text style={styles.attachTitle}>Attach</Text>
                <View style={styles.encBadge}>
                  <Icon name="lock" size={11} color={DM.signal} />
                  <Text style={styles.encBadgeText}>Encrypted</Text>
                </View>
              </View>
              <TouchableOpacity style={styles.attachRow} onPress={() => { void captureImage(); }} activeOpacity={0.7}>
                <View style={styles.attachRowIcon}><Icon name="camera-outline" size={22} color={DM.onAccent} /></View>
                <View style={{flex: 1}}>
                  <Text style={styles.attachRowTitle}>Camera</Text>
                  <Text style={styles.attachRowSub}>Take a photo — encrypted before upload</Text>
                </View>
                <Icon name="chevron-right" size={20} color={DM.textFaint} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.attachRow} onPress={() => { void pickImage(); }} activeOpacity={0.7}>
                <View style={styles.attachRowIcon}><Icon name="image-outline" size={22} color={DM.onAccent} /></View>
                <View style={{flex: 1}}>
                  <Text style={styles.attachRowTitle}>Photo or Video</Text>
                  <Text style={styles.attachRowSub}>From your library — E2E encrypted</Text>
                </View>
                <Icon name="chevron-right" size={20} color={DM.textFaint} />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.attachRow, styles.attachRowLast]} onPress={() => { void pickDocument(); }} activeOpacity={0.7}>
                <View style={styles.attachRowIcon}><Icon name="file-outline" size={22} color={DM.onAccent} /></View>
                <View style={{flex: 1}}>
                  <Text style={styles.attachRowTitle}>Document</Text>
                  <Text style={styles.attachRowSub}>Any file up to 50 MB — encrypted</Text>
                </View>
                <Icon name="chevron-right" size={20} color={DM.textFaint} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.attachCancel} onPress={() => setAttachOpen(false)} activeOpacity={0.8}>
                <Text style={styles.attachCancelText}>Cancel</Text>
              </TouchableOpacity>
            </LinearGradient>
          </Pressable>
        </Pressable>
      </Modal>
      )}

      {/* B-281 — the emoji keyboard is NOT a modal sheet any more. A bottom sheet
          is anchored to the bottom of the window, so it always covered the
          composer: with B-280 keeping it open for multiple picks, the user could
          no longer see the emoji they were building. It now renders INSIDE the
          composer column, below the input bar, in the space the system IME
          vacates — the WhatsApp arrangement. See <ChatComposer emojiOpen>. */}

      {/* B-87/MX-04 — pre-send review tray for a multi-photo pick. */}
      <MediaPreviewTray
        assets={pendingAssets}
        onRemoveAt={i => setPendingAssets(prev => prev.filter((_, idx) => idx !== i))}
        onCancel={() => setPendingAssets([])}
        onSend={caption => {
          // B-707 — the caption is stamped onto the batch BEFORE the state
          // clear, so the queue owns it and the tray's own reset cannot race it.
          const assets = withBatchCaption(pendingAssets, caption);
          setPendingAssets([]);
          haptics.tap();
          enqueueMediaAssets(assets);
        }}
      />

      {/* Full-screen attachment viewer — resolves the decrypted local
          uri (downloading + AES-decrypting received blobs on demand) and
          hands off to the shared FileViewer (image / video / audio /
          file) with vault + share + delete actions. */}
      {viewerMsg && (
        <ChatAttachmentViewer
          msg={viewerMsg}
          onClose={() => setViewerMsg(null)}
          onSwipe={stepViewer}
        />
      )}

      {/* Disappearing-message timer */}
      {timerOpen && (
      <Modal visible={timerOpen} transparent animationType="fade" onRequestClose={() => setTimerOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setTimerOpen(false)}>
          <Pressable style={[styles.sheet, {paddingBottom: insets.bottom + 20}]}>
            <Text style={styles.sheetTitle}>Disappearing messages</Text>
            <Text style={styles.sheetSub}>Auto-delete on both devices + the relay</Text>
            {TTL_OPTIONS.map(opt => (
              <TouchableOpacity
                key={String(opt.sec)}
                style={styles.sheetRow}
                onPress={() => { setTtlSec(opt.sec); setTimerOpen(false); }}
                activeOpacity={0.7}>
                <Icon
                  name={ttlSec === opt.sec ? 'radiobox-marked' : 'radiobox-blank'}
                  size={20}
                  color={ttlSec === opt.sec ? Bravo.amber : '#7E8AA6'}
                />
                <Text style={styles.sheetRowText}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
      )}
    </View>
  );
}

// Round 4 / Architecture audit fix: wrap ChatScreen in a per-screen
// ErrorBoundary so a single bad bubble (decrypt failure that escapes
// the bubble's own try/catch, malformed reaction map, etc.) doesn't
// kill the whole app via the root boundary. Retry remounts the screen.
const ChatScreen = withScreenErrorBoundary(ChatScreenInner, 'Chat');
export default ChatScreen;

const BURN_DURATION_MS = 900;

/** Inner width of an image bubble: `imageBubble.maxWidth` less its 3pt padding. */
const ALBUM_WIDTH = 254;

/**
 * B-288 — one photo inside an album grid.
 *
 * Its OWN component, not a loop body, because each tile needs its own
 * `useAttachmentUri` to download and AES-decrypt its own blob — and an album's
 * size changes as a burst arrives, so calling the hook in a loop would violate
 * the rules of hooks the moment a fifth photo landed.
 */
function AlbumTileView({msg, tile, onOpen, onLongPress}: {
  msg:    LocalMessage;
  tile:   AlbumTile;
  onOpen: () => void;
  /**
   * B-450 — long-press THIS tile. A tile is its own TouchableOpacity, so it
   * wins the responder negotiation and the row wrapper's long-press never
   * fires; without this a photo in a burst had no action sheet at all.
   */
  onLongPress?: () => void;
}) {
  const attachment = useAttachmentUri(msg, {auto: true});
  const thumb = msg.media_meta?.thumbB64;
  // The envelope's inline thumbnail paints immediately, so a grid never opens
  // as four grey holes while four separate decrypts race.
  const uri = attachment.uri ?? (thumb ? `data:image/jpeg;base64,${thumb}` : null);
  const box = {left: tile.left, top: tile.top, width: tile.width, height: tile.height};
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onOpen}
      onLongPress={onLongPress}
      delayLongPress={280}
      style={[styles.albumTile, box]}
      accessibilityRole="imagebutton"
      accessibilityLabel={tile.overflow > 0
        ? `Photo, and ${tile.overflow} more`
        : 'Photo'}>
      {uri
        ? <Image source={{uri}} style={styles.albumTileImg} resizeMode="cover" />
        : <View style={[styles.albumTileImg, styles.albumTilePending]}>
            <Icon name="lock" size={16} color="#7E8AA6" />
          </View>}
      {tile.overflow > 0 && (
        <View style={styles.albumOverflow}>
          <Text style={styles.albumOverflowText}>+{tile.overflow}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

/**
 * B-288 — a burst of photos as one mosaic instead of N stacked bubbles.
 *
 * Geometry comes from `albumTiles` (pure, unit-tested); this only mounts it.
 * Absolutely positioned so the whole album is ONE container view plus one view
 * per visible tile — capped at 4 by `albumLayout`, so a 30-photo dump costs the
 * same as a 4-photo one. That cap is the point: B-279 measured this screen's
 * bottleneck as view MOUNTING, and thirty image bubbles is what it looked like.
 */
function AlbumGrid({album, onOpenPhoto, onLongPressPhoto}: {
  album: ReadonlyArray<LocalMessage>;
  onOpenPhoto: (m: LocalMessage) => void;
  /** B-450 — action sheet for the TAPPED photo, not the album's leader row. */
  onLongPressPhoto?: (m: LocalMessage) => void;
}) {
  const tiles = useMemo(() => albumTiles(album.length, ALBUM_WIDTH), [album.length]);
  const height = useMemo(() => albumHeight(album.length, ALBUM_WIDTH), [album.length]);
  return (
    <View style={{width: ALBUM_WIDTH, height}}>
      {tiles.map(tile => {
        const msg = album[tile.msgIndex];
        if (!msg) {return null;}
        return (
          <AlbumTileView
            key={msg.id}
            msg={msg}
            tile={tile}
            // Opening the LAST tile of an overflowing album jumps to that photo,
            // and the viewer's swipe covers the rest — so "+7" is reachable
            // without a separate album screen.
            onOpen={() => onOpenPhoto(msg)}
            // B-450 — each tile already knows its own message (that is how
            // onOpen targets the right photo), so the sheet targets it too:
            // replying to the 3rd photo of a burst quotes the 3rd photo.
            onLongPress={onLongPressPhoto ? () => onLongPressPhoto(msg) : undefined}
          />
        );
      })}
    </View>
  );
}

/**
 * The thread's messages, merged across every slot a 1:1 conversation can be
 * stored under (a direct chat has historically been written under both a
 * `direct:<peer>` key and a server id — M2's read-merge is what stops the
 * thread dropping half its history).
 *
 * B-287 — extracted from the inline selector so the photo pager can ask the
 * LIVE store for the same list. Duplicating the merge instead would have been
 * the exact mistake B-286 was: a second copy that drifts. Callers inside a
 * selector must still wrap it in `useShallow`, since the merge branch mints a
 * fresh array.
 */
function liveConversationMessages(
  s: Parameters<typeof directConversationSlots>[0] & {messages: Record<string, LocalMessage[]>},
  conversationId: string,
): readonly LocalMessage[] {
  // readonly: EMPTY_MESSAGES is a frozen shared singleton, and the slot-hit
  // branch hands back the store's own array — neither may be mutated by a
  // caller, and the merge branch's fresh array must not become the exception
  // that makes callers think mutation is fine.
  const slotIds = directConversationSlots(s, conversationId);
  if (slotIds.length === 1) {return s.messages[slotIds[0]] ?? EMPTY_MESSAGES;}
  const lists: LocalMessage[][] = [];
  for (const id of slotIds) {
    const m = s.messages[id];
    if (m && m.length) {lists.push(m);}
  }
  if (lists.length === 0) {return EMPTY_MESSAGES;}
  if (lists.length === 1) {return lists[0];} // single populated slot — stable store ref
  const byId = new Map<string, LocalMessage>();
  for (const list of lists) {for (const m of list) {byId.set(m.id, m);}}
  return Array.from(byId.values()).sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );
}

/**
 * Full-screen viewer wrapper for a chat attachment. Resolves the
 * decrypted local uri (downloading + AES-decrypting a received blob on
 * demand) and renders the shared FileViewer once ready. While the blob
 * is still being fetched/decrypted it shows a lightweight overlay so the
 * tap feels responsive instead of dead.
 */
function ChatAttachmentViewer({msg, onClose, onSwipe}: {
  msg: LocalMessage;
  onClose: () => void;
  onSwipe?: (direction: -1 | 1) => void;
}) {
  const {uri, state, errorReason, load} = useAttachmentUri(msg, {auto: true});
  const removeMessage = useMessengerStore(s => s.removeMessage);

  /**
   * B-294 — the last FULLY-RESOLVED (message, uri) pair.
   *
   * Paging to a photo whose bytes were not yet decrypted used to flip this
   * component to the "Decrypting…" branch, which returns a DIFFERENT <Modal>.
   * Unmounting one RN Modal and mounting another in the same frame gives a
   * blank window on Android — and a blank window has no gesture surface, so the
   * next swipe did nothing and the viewer appeared stuck on the first photo.
   *
   * So once anything has been shown, the viewer never unmounts: it keeps
   * displaying the current photo until the next one's bytes are ready, then
   * swaps message and uri together. Same idea as `maintainVisibleContentPosition`
   * — never show nothing on the way to showing something.
   */
  const shownRef = useRef<{msg: LocalMessage; uri: string} | null>(null);
  if (uri) {shownRef.current = {msg, uri};}
  const shown = shownRef.current;

  // Only the FIRST open can legitimately have nothing to show yet. Every later
  // state is covered by `shown`, including a photo that fails to resolve — the
  // previous one stays up rather than blanking the screen.
  if (!shown && (state === 'loading' || (!uri && state !== 'error'))) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <Pressable style={styles.viewerRoot} onPress={onClose}>
          <Icon name="lock" size={36} color="#7E8AA6" />
          <Text style={[styles.imageBrokenText, {marginTop: 10}]}>Decrypting…</Text>
        </Pressable>
      </Modal>
    );
  }

  if (!shown && (state === 'error' || !uri)) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <Pressable style={styles.viewerRoot} onPress={onClose}>
          <Icon name="image-broken-variant" size={36} color="#7E8AA6" />
          {/* Media-parity M17 — say WHY (no access / expired / offline)
              instead of one opaque "Attachment unavailable". */}
          <Text style={[styles.imageBrokenText, {marginTop: 10}]}>{attachmentErrorText(errorReason)}</Text>
          <TouchableOpacity onPress={load} activeOpacity={0.7} style={{marginTop: 12}}>
            <Text style={[styles.imageBrokenText, {color: DM.accent}]}>Tap to retry</Text>
          </TouchableOpacity>
        </Pressable>
      </Modal>
    );
  }

  // B-294 — everything below describes the SHOWN photo, never the requested
  // one. Mixing them would label the visible image with the incoming image's
  // filename, and would delete the wrong message.
  const shownMsg = shown!.msg;
  const file: ViewableFile = {
    id:        shownMsg.id,
    // Media-parity M14 — prefer the real filename from the envelope.
    name:      shownMsg.media_meta?.name
      || shownMsg.content
      || (shownMsg.type === 'video' ? 'Video' : shownMsg.type === 'audio' ? 'Voice message' : 'File'),
    uri:       shown!.uri,
    mimeType:  shownMsg.media_mime ?? 'application/octet-stream',
    size:      shownMsg.media_meta?.sizeBytes,
    createdAt: new Date(shownMsg.created_at).getTime(),
    // Phase 4 — provenance for the vault refusal. A dept-group conversation IS
    // reachable here (notification taps route every message to Chat), so this
    // builder is a real path for a company file.
    conversationId: shownMsg.conversation_id,
  };

  return (
    <FileViewer
      file={file}
      onClose={onClose}
      onDelete={() => { removeMessage(shownMsg.conversation_id, shownMsg.id); onClose(); }}
      onSwipe={onSwipe}
    />
  );
}

/**
 * Memoized so a new bubble at the bottom doesn't trigger a re-render
 * of every earlier bubble. Only the fields the bubble actually renders
 * are compared — status ticks and reactions can mutate in place.
 */
const MessageBubble = React.memo(MessageBubbleImpl, (prev, next) => (
  prev.msg.id              === next.msg.id &&
  prev.msg.status          === next.msg.status &&
  prev.msg.content         === next.msg.content &&
  prev.msg.expires_at      === next.msg.expires_at &&
  prev.msg.reactions       === next.msg.reactions &&
  prev.msg.reply_to_msg_id === next.msg.reply_to_msg_id &&
  prev.isFirstInGroup      === next.isFirstInGroup &&
  prev.isLastInGroup       === next.isLastInGroup &&
  prev.highlighted         === next.highlighted &&
  prev.quotedSenderLabel   === next.quotedSenderLabel &&
  prev.senderLabel         === next.senderLabel &&
  prev.senderColor         === next.senderColor &&
  // B-288 — the album is memoised on the message array's identity upstream, so
  // this reference is stable while the burst is unchanged and differs the moment
  // another photo joins it. Comparing by reference is therefore both cheap and
  // exactly right; comparing by length would miss a photo being deleted.
  prev.album               === next.album
));

function MessageBubbleImpl({
  msg,
  album,
  onOpenPhoto,
  onLongPressPhoto,
  onOpenImage,
  isFirstInGroup = true,
  isLastInGroup  = true,
  highlighted    = false,
  quotedSenderLabel,
  senderLabel,
  senderColor,
  onLongPress,
  onSwipeReply,
  onDoubleTap,
  onReplyTap,
  onShowReactors,
  onRetry,
  selfUserId,
}: {
  msg: LocalMessage;
  /**
   * B-288 — set when this photo LEADS an album; holds every photo in the burst
   * including this one. The row still carries the leader message, so the sender
   * label, timestamp, ticks, reactions and long-press menu are unchanged.
   */
  album?: ReadonlyArray<LocalMessage>;
  /** Open a specific photo of the album (the leader's own tap uses onOpenImage). */
  onOpenPhoto?: (m: LocalMessage) => void;
  /**
   * B-450 — action sheet for a specific photo of the album. Separate from
   * `onLongPress` (which targets the row's leader message) precisely because a
   * burst renders N messages inside ONE row.
   */
  onLongPressPhoto?: (m: LocalMessage) => void;
  onOpenImage: () => void;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  highlighted?:    boolean;
  quotedSenderLabel?: string;
  /** Group chat only: sender name shown above the incoming bubble. */
  senderLabel?: string;
  /** Group chat only: color used for the sender label + avatar accent. */
  senderColor?: string;
  onLongPress?: () => void;
  onSwipeReply?: () => void;
  onDoubleTap?:  () => void;
  onReplyTap?:   () => void;
  /** B-282 — open the "who reacted" roster for this message. */
  onShowReactors?: () => void;
  /** Fired when the user taps the "Tap to retry" affordance on a failed send. */
  onRetry?:      () => void;
  /** Viewing user's id, so a mention OF THEM renders emphasised. */
  selfUserId?:   string | null;
}) {
  const sent = msg.sender_id === 'self';
  const time = new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  const statusIcon = statusToIcon(msg.status);
  const expiresIn = useCountdown(msg.expires_at);
  // MX-09 — per-bubble subscription; only the uploading bubble ticks.
  const uploadProgress = useUploadProgress(msg.id);
  // Any message that carries an attachment — either the sender's local
  // pick (media_url) or a received blob reference (media_object_key).
  const hasAttachment = !!msg.media_url || !!msg.media_object_key;
  // MX-09 — while THIS device is still uploading, the row has neither
  // field yet (the object key is patched on after the PUT). Classify by
  // msg.type so the bubble renders its media chrome (thumb + progress
  // ring / % label) instead of falling through to an empty text bubble.
  const isUploading = sent && msg.status === 'sending' && uploadProgress !== null;
  // F-3 (B-693) — slow ≠ broken: a bubble stuck in 'sending' past 5s is in
  // the retry machinery (watchdog HTTP fallback, outbox backoff rung, offline
  // queue) and the only signal was a frozen clock icon the user reads as
  // "hung". One timeout per sending bubble; clears the moment status moves.
  const [sendingStalled, setSendingStalled] = useState(false);
  useEffect(() => {
    if (!(sent && msg.status === 'sending')) {
      setSendingStalled(false);
      return;
    }
    const t = setTimeout(() => setSendingStalled(true), 5_000);
    return () => clearTimeout(t);
  }, [sent, msg.status]);
  const isImage = msg.type === 'image' && (hasAttachment || isUploading);
  const isVideo = msg.type === 'video' && (hasAttachment || isUploading);
  const isAudio = msg.type === 'audio' && (hasAttachment || isUploading);
  const isFileAtt = msg.type === 'file' && (hasAttachment || isUploading);
  // Auto-fetch only image thumbnails; video/audio/file load on tap so a
  // long thread doesn't eagerly pull every clip.
  const attachment = useAttachmentUri(msg, {auto: isImage});
  const removeMessage = useMessengerStore(s => s.removeMessage);
  // B-223/B-205 — re-derive a group system line ("X added Y" / rename) from the
  // CURRENT store so a name that resolved after the row was stored replaces a
  // stale "Member <6hex>". Structured rows (msg.event, B-205) use
  // systemEventText; legacy rows without it re-derive via the sys:add id parse.
  // Null for any other message → falls back to msg.content.
  const systemAddText = msg.type === 'system'
    ? (msg.event
        ? systemEventText(msg.event, {
            selfUserId: useMessengerStore.getState()._ownUserId ?? undefined,
            groupId: msg.conversation_id,
          })
        : memberAddedContentFor(msg, useMessengerStore.getState()._ownUserId ?? undefined))
    : null;
  const [imageBroken, setImageBroken] = useState(false);
  // Media-parity G8 — one-tap open: a user-initiated download auto-opens
  // the viewer when it resolves instead of demanding a second tap on
  // "Tap to open".
  const [autoOpen, setAutoOpen] = useState(false);
  useEffect(() => {
    if (autoOpen && attachment.uri) {
      setAutoOpen(false);
      onOpenImage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, attachment.uri]);
  // Media-parity G3 — bubble geometry + instant preview from the sealed
  // envelope's metadata (persisted media_meta): correct aspect ratio the
  // moment the row lands, and a tiny thumbnail under the decrypt.
  const mMeta = msg.media_meta;
  const imageH = (() => {
    if (!mMeta?.width || !mMeta?.height) {return 254;}
    const ratio = mMeta.height / Math.max(1, mMeta.width);
    return Math.max(140, Math.min(340, Math.round(254 * ratio)));
  })();
  // MX-10 — memoised: rebuilding the data-URI string per render made RN's
  // Image source prop see a "new" uri each pass on media-heavy threads.
  const thumbB64 = mMeta?.thumbB64;
  const thumbUri = useMemo(
    () => (thumbB64 ? `data:image/jpeg;base64,${thumbB64}` : null),
    [thumbB64],
  );
  // B-263 — EVERY bubble carries its own metadata strip.
  //
  // This used to be `isLastInGroup`, collapsing a run of consecutive messages
  // from one sender down to a single timestamp + tick on the last of them. It
  // reads tidy, but delivery state is PER MESSAGE: send three in a row and the
  // first two would show no tick at all, so "delivered" for the run's last
  // message silently stood in for messages that might be `sent`, `failed` or
  // `undelivered`. The founder reported it as ticks only appearing on the last
  // message, which is exactly what it was. A tick you cannot see is
  // indistinguishable from one that never arrived — and this app has just
  // spent a day on a message that WAS lost, so a hidden delivery state is the
  // last thing it should ship.
  const showMeta = true;

  // Animate entry ONLY for freshly-arrived messages. Opening an existing
  // conversation must not re-spring every historical bubble — that's what
  // created the "flash" on back/forward nav. We compare the message's
  // created_at to the component's first-render wall clock: older = skip.
  //
  // Restore stagger: when we're inside the post-restore animation
  // window (set by markRestoredNow at the end of restoreAllMessages),
  // bubbles spring-in on first mount regardless of their age. This
  // gives the user a premium "messages flowing in" feel right after
  // restore completes. The window is short (~8s) so normal scrolling
  // is unaffected.
  const isRestoreAnim = useRef((): boolean => {
    try {
      const {isInRestoreAnimWindow} = require('@/modules/messenger/runtime/expirySweeper') as
        typeof import('@/modules/messenger/runtime/expirySweeper');
      return isInRestoreAnimWindow();
    } catch { return false; }
  }).current();
  // B-692 NL-7 — a message the pipeline delivered late is older than 2 s by
  // created_at but still JUST APPEARED; the live-arrival registry (fed by the
  // screen's render diff) catches exactly those, so they slide in instead of
  // popping. The created_at check stays as the fallback for paths the diff
  // can't see (e.g. the very first own-send before the registry entry lands).
  const isFresh = useRef(
    isRestoreAnim || isLiveArrival(msg.id) || Date.now() - new Date(msg.created_at).getTime() < 2000,
  ).current;
  const opacity    = useRef(new Animated.Value(isFresh ? 0   : 1)).current;
  const scale      = useRef(new Animated.Value(isFresh ? 0.9 : 1)).current;
  const translateY = useRef(new Animated.Value(isFresh ? 8   : 0)).current;
  const burnTint   = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isFresh) {return;}
    // Restore-mode: small random delay (0-280ms) per bubble so they
    // cascade into view instead of popping in lockstep — gives the
    // "messages flowing in" feel. Normal fresh sends don't need it.
    const delay = isRestoreAnim ? Math.floor(Math.random() * 280) : 0;
    Animated.parallel([
      Animated.spring(opacity,    {toValue: 1, useNativeDriver: true, tension: 90, friction: 10, delay}),
      Animated.spring(scale,      {toValue: 1, useNativeDriver: true, tension: 90, friction: 10, delay}),
      Animated.spring(translateY, {toValue: 0, useNativeDriver: true, tension: 90, friction: 10, delay}),
    ]).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fix #27: ref-mirror removeMessage so the timer callback always
  // hits the freshest store action. The previous closure captured the
  // first render's reference; if Zustand swapped the action (it does
  // when the store is replaced — restore-from-disk path), the timer
  // would call into a dangling function that no longer wired into the
  // current store. Mixed-driver split (useNativeDriver:false for
  // burnTint vs true for opacity/scale/translateY) is preserved
  // exactly as before — that fix is still load-bearing.
  const removeMessageRef = useRef(removeMessage);
  useEffect(() => { removeMessageRef.current = removeMessage; }, [removeMessage]);
  useEffect(() => {
    if (!msg.expires_at) {return;}
    const msUntilExpiry = msg.expires_at - Date.now();
    const burnAt = Math.max(0, msUntilExpiry - BURN_DURATION_MS);

    const timer = setTimeout(() => {
      // CRITICAL: split into TWO separate `.start()` calls so we don't
      // mix `useNativeDriver: false` (burnTint colour interpolation) with
      // `useNativeDriver: true` (opacity/scale/translateY) inside the
      // SAME `Animated.parallel`. RN crashes with `mqt_v_native FATAL:
      // Attempting to run JS driven animation on animated node that has
      // been moved to "native" earlier` whenever the parallel block
      // schedules both drivers against nodes that the mount-spring
      // already pinned to native — repro: open a chat that contains a
      // disappearing message right when its burn timer fires (e.g. nav
      // away to a group call and back). Splitting keeps each driver
      // isolated; the visual effect is identical because both timings
      // start in the same JS tick.
      Animated.timing(burnTint, {
        toValue: 1, duration: 250,
        easing: Easing.out(Easing.ease),
        useNativeDriver: false,
      }).start();
      Animated.parallel([
        Animated.timing(opacity,    {toValue: 0,    duration: BURN_DURATION_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true}),
        Animated.timing(scale,      {toValue: 0.6,  duration: BURN_DURATION_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true}),
        Animated.timing(translateY, {toValue: -18,  duration: BURN_DURATION_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true}),
      ]).start(({finished}) => {
        if (finished) {removeMessageRef.current(msg.conversation_id, msg.id);}
      });
    }, burnAt);
    return () => clearTimeout(timer);
    // removeMessage intentionally omitted — read via ref above so the
    // timer doesn't churn whenever the store action identity flips.

  }, [msg.expires_at, msg.id, msg.conversation_id, opacity, scale, burnTint, translateY]);

  const burnBorder = burnTint.interpolate({
    inputRange:  [0, 1],
    outputRange: ['rgba(249,115,22,0.6)', 'rgba(220,38,38,1)'],
  });
  const burnBg = burnTint.interpolate({
    inputRange:  [0, 1],
    outputRange: ['rgba(249,115,22,0)', 'rgba(249,115,22,0.25)'],
  });

  // Swipe-to-reply: translate the bubble on pan, fire onSwipeReply when
  // the user drags past SWIPE_REPLY_THRESHOLD and releases. We animate
  // back to rest on release regardless of whether it triggered.
  const panX = useRef(new Animated.Value(0)).current;
  const lastTap = useRef(0);

  // Pulse-highlight when parent scrolls us into view via reply-tap.
  // Drives both a background tint and a scale "pop" — keeps the
  // reference visually obvious without being a flash-bang.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!highlighted) {return;}
    Animated.sequence([
      Animated.timing(pulse, {toValue: 1, duration: 200, useNativeDriver: false}),
      Animated.delay(600),
      Animated.timing(pulse, {toValue: 0, duration: 400, useNativeDriver: false}),
    ]).start();
  }, [highlighted, pulse]);
  const pulseBg = pulse.interpolate({
    inputRange:  [0, 1],
    // Cobalt "you jumped here" flash — matches the Bravo DM accent.
    outputRange: ['rgba(91,141,239,0)', 'rgba(91,141,239,0.32)'],
  });
  // Fix #28: ref-mirror onSwipeReply so the handler (created ONCE with
  // useRef + .current) reads the latest callback at fire time. Without
  // this, the handler closed over the FIRST render's onSwipeReply — so
  // subsequent re-renders that bound a fresh onSwipeReply (parent passes
  // a different replyTo target) would be ignored.
  const onSwipeReplyRef = useRef(onSwipeReply);
  useEffect(() => { onSwipeReplyRef.current = onSwipeReply; }, [onSwipeReply]);
  // MX-06 — the gesture writes translationX straight into panX on the UI
  // thread (Animated.event + native driver); JS only hears about END /
  // CANCEL to fire the reply + spring home. The clamp pins the opposite
  // direction at 0 and caps the pull at 120 so it never reads as a delete.
  //
  // Direction depends on WHOSE message it is (founder rule): swipe RIGHT to
  // reply to someone else, LEFT to reply to your own. The reply pull always
  // drags the bubble away from the edge it is anchored to, so the gesture
  // never fights the bubble's own alignment.
  //
  // `sent` is fixed for the life of a bubble (a message is mine or not,
  // forever) and the row is keyed by message id, so capturing it in these
  // create-once refs is safe.
  const panXClamped = useRef(panX.interpolate({
    inputRange:  sent ? [-120, 0] : [0, 120],
    outputRange: sent ? [-120, 0] : [0, 120],
    extrapolate: 'clamp',
  })).current;
  const onSwipeGestureEvent = useRef(Animated.event(
    [{nativeEvent: {translationX: panX}}],
    {useNativeDriver: true},
  )).current;
  const onSwipeStateChange = useRef((e: PanGestureHandlerStateChangeEvent) => {
    const {state, translationX} = e.nativeEvent;
    if (state === GestureState.BEGAN) {
      // A re-swipe within the ~300 ms spring-home window: stop the spring
      // so it doesn't fight the incoming native event stream on panX.
      panX.stopAnimation();
      return;
    }
    if (state === GestureState.END) {
      const pulled = sent
        ? translationX < -SWIPE_REPLY_THRESHOLD
        : translationX >  SWIPE_REPLY_THRESHOLD;
      if (pulled) {onSwipeReplyRef.current?.();}
      Animated.spring(panX, {toValue: 0, useNativeDriver: true, tension: 90, friction: 8}).start();
    } else if (state === GestureState.CANCELLED || state === GestureState.FAILED) {
      Animated.spring(panX, {toValue: 0, useNativeDriver: true, tension: 90, friction: 8}).start();
    }
  }).current;

  const handleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 280) {onDoubleTap?.();}
    lastTap.current = now;
  };

  return (
    <PanGestureHandler
      // Activate only on a deliberate drag in the reply direction for this
      // bubble; vertical intent (list scroll) and the opposite drag fail fast
      // so the FlatList keeps them.
      activeOffsetX={sent ? -16 : 16}
      failOffsetX={sent ? 16 : -16}
      failOffsetY={[-14, 14]}
      onGestureEvent={onSwipeGestureEvent}
      onHandlerStateChange={onSwipeStateChange}>
    <Animated.View
      style={[
        styles.msgWrap,
        sent && styles.msgWrapSent,
        !isFirstInGroup && styles.msgWrapGrouped,
        {opacity, transform: [{scale}, {translateY}, {translateX: panXClamped}]},
      ]}>
      {/* Reply-jump highlight underlay. CRITICAL: the JS-driven
          backgroundColor pulse lives on its OWN node — it must NEVER share
          a node with the wrapper's native-driven opacity / transform /
          panX. Swipe-to-reply and scroll-steal (onPanResponderTerminate)
          move panX to the native driver; animating a JS-driven
          backgroundColor on that same node threw "Attempting to run JS
          driven animation on animated node that has been moved to native
          earlier", which the screen error boundary rendered as
          "Chat hit an error" on every reply-quote jump. Same mixed-driver
          class the burn-timer fix (above) guards against. pointerEvents
          none so it never intercepts taps meant for the bubble. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.pulseHalo, {backgroundColor: pulseBg}]}
      />
      {/* Group chat: sender callsign shown above the first bubble of a run */}
      {!sent && senderLabel && isFirstInGroup && (
        <Text style={[styles.groupSender, senderColor && {color: senderColor}]} numberOfLines={1}>
          {senderLabel}
        </Text>
      )}
      <TouchableOpacity
        activeOpacity={0.85}
        onLongPress={onLongPress}
        onPress={handleTap}
        delayLongPress={280}
        style={[
          styles.bubble,
          sent ? styles.sentBubble : styles.recvBubble,
          sent && !isLastInGroup  && styles.sentBubbleRunMid,
          sent && !isFirstInGroup && styles.sentBubbleRunTail,
          !sent && !isLastInGroup  && styles.recvBubbleRunMid,
          !sent && !isFirstInGroup && styles.recvBubbleRunTail,
          // B-279 — gradient fill for text bubbles (Bravo DM Attach): cobalt
          // outgoing, obsidian incoming. Painted as this view's OWN background
          // instead of a child `<LinearGradient>`, so a thread costs one native
          // view per message instead of two. Image bubbles stay excluded, as
          // before: the photo covers the fill and only the 3px padding ring
          // would show it.
          !isImage && (sent ? styles.sentBubbleFill : styles.recvBubbleFill),
          !sent && senderLabel && senderColor && isFirstInGroup ? {borderLeftWidth: 2, borderLeftColor: senderColor} : undefined,
          msg.expires_at ? {borderLeftWidth: 2, borderLeftColor: Bravo.amber} : undefined,
          isImage ? styles.imageBubble : undefined,
        ]}
      ><Animated.View style={[
        styles.bubbleInner,
        msg.expires_at ? {backgroundColor: burnBg as unknown as string} : undefined,
        msg.expires_at ? {borderLeftWidth: 2, borderLeftColor: burnBorder as unknown as string} : undefined,
      ]}>
        {/* "Deleted for everyone" tombstone. Rendered as an EARLY branch over
            the whole bubble body, not as one more conditional inside it: the
            row keeps its media/reply fields stripped by the store, but a future
            field added to the bubble would otherwise render for a retracted
            message by default. Fail-closed is the only acceptable direction
            here — the entire point is that the content is gone. */}
        {msg.deleted_for_all ? (
          <View style={styles.deletedRow}>
            <Icon name="cancel" size={14} color={sent ? 'rgba(255,255,255,0.55)' : DM.textMute} />
            <Text style={[styles.deletedText, sent && styles.deletedTextSent]}>
              {sent ? 'You deleted this message' : 'This message was deleted'}
            </Text>
          </View>
        ) : (
        <>
        {/* MM-09 — "Forwarded" chip (WhatsApp convention: quiet italic row
            above the body, on both the sender's and the recipient's bubble). */}
        {msg.is_forwarded && (
          <View style={styles.forwardedRow}>
            <Icon name="share" size={12} color={sent ? 'rgba(255,255,255,0.5)' : DM.textMute} />
            <Text style={[styles.forwardedText, sent && styles.forwardedTextSent]}>Forwarded</Text>
          </View>
        )}
        {msg.reply_to_msg_id && msg.reply_to_preview && (
          <TouchableOpacity
            style={[styles.replyStrip, sent && styles.replyStripSent]}
            onPress={onReplyTap}
            // B-450 — same nested-touchable class as the media bubbles: without
            // this, long-pressing the quote strip of a reply silently jumped to
            // the quoted message instead of opening the sheet.
            onLongPress={onLongPress}
            delayLongPress={280}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Jump to quoted message">
            <View style={styles.replyBody}>
              <Text style={[styles.replyAuthor, sent && styles.replyAuthorSent]} numberOfLines={1}>
                {quotedSenderLabel ?? 'Message'}
              </Text>
              <Text style={[styles.replyStripText, sent && styles.replyStripTextSent]} numberOfLines={2}>
                {msg.reply_to_preview}
              </Text>
            </View>
          </TouchableOpacity>
        )}
        {album && onOpenPhoto ? (
          // B-288 — a burst paints as one mosaic. The leader's own decrypt still
          // runs (isImage is true), but its tile comes from the grid like every
          // other member's, so no photo is fetched twice.
          <AlbumGrid album={album} onOpenPhoto={onOpenPhoto} onLongPressPhoto={onLongPressPhoto} />
        ) : isImage ? (
          // B-450 — the inner touchable wins RN's responder negotiation, so the
          // row wrapper's onLongPress never reaches a photo. Every media
          // touchable below therefore re-arms it explicitly; a text bubble
          // renders plain <Text> and is why replies worked there and only there.
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => !imageBroken && attachment.uri && onOpenImage()}
            onLongPress={onLongPress}
            delayLongPress={280}>
            {/* MX-09 — during upload there are no download keys yet, so the
                hook reports a TRANSIENT 'error'; suppress the broken tile
                (it self-heals when the object key lands and `load`'s
                identity re-fires the auto effect). */}
            {(imageBroken || attachment.state === 'error') && !isUploading ? (
              <View style={[styles.msgImage, {height: imageH}, styles.imageBrokenWrap]}>
                <Icon name="image-broken-variant" size={32} color="#7E8AA6" />
                <Text style={styles.imageBrokenText}>
                  {attachment.state === 'error' ? attachmentErrorText(attachment.errorReason) : 'Image unavailable'}
                </Text>
                {attachment.state === 'error' && msg.media_object_key && (
                  <TouchableOpacity
                    onPress={attachment.load}
                    onLongPress={onLongPress}
                    delayLongPress={280}
                    activeOpacity={0.7}>
                    <Text style={[styles.imageBrokenText, {color: DM.accent}]}>Tap to retry</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : attachment.uri ? (
              <Image
                source={{uri: attachment.uri}}
                style={[styles.msgImage, {height: imageH}]}
                resizeMode="cover"
                onError={() => {
                  // Audit MEDIA-A3 — a dead local pick uri (revoked content://
                  // after reboot, cache cleared) should fall back to the
                  // encrypted download the message also carries, not a
                  // permanently broken tile. onError() flips the hook to the
                  // download path; only give up if there's nothing to fetch.
                  if (msg.media_object_key && msg.media_key && msg.media_iv) {
                    attachment.onError();
                  } else {
                    setImageBroken(true);
                  }
                }}
              />
            ) : thumbUri ? (
              // Media-parity G3 — instant preview from the envelope's tiny
              // thumbnail while the real blob downloads/decrypts.
              <Image
                source={{uri: thumbUri}}
                style={[styles.msgImage, {height: imageH}]}
                resizeMode="cover"
                blurRadius={2}
              />
            ) : (
              <View style={[styles.msgImage, {height: imageH}, styles.imageBrokenWrap]}>
                <Icon name="lock" size={26} color="#7E8AA6" />
                <Text style={styles.imageBrokenText}>{isUploading ? 'Encrypting…' : 'Decrypting…'}</Text>
              </View>
            )}
            {/* MX-09 — determinate upload ring while this device ships the
                encrypted blob; cleared by the runtime the moment the PUT
                finishes (status stays 'sending' through seal+fan-out). */}
            {msg.status === 'sending' && uploadProgress !== null && (
              <UploadProgressRing fraction={uploadProgress} />
            )}
            {showMeta && attachment.uri && (
              <>
                {/* Gradient foot for meta legibility over photos */}
                <View style={styles.imageMetaShade} pointerEvents="none" />
                <View style={styles.imageMetaRow}>
                  <Text style={styles.imageMetaTime}>{time}</Text>
                  {msg.expires_at && (
                    <View style={styles.timerBadge}>
                      <Icon name="fire" size={11} color={Bravo.amber} />
                      <Text style={styles.timerText}>{expiresIn ?? '—'}</Text>
                    </View>
                  )}
                  {sent && statusIcon && (
                    <Icon name={statusIcon.name} size={13} color={statusIcon.color === '#7E8AA6' ? '#B8C7E0' : statusIcon.color} />
                  )}
                </View>
              </>
            )}
          </TouchableOpacity>
        ) : isVideo || isAudio || isFileAtt ? (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => {
              if (attachment.uri) {onOpenImage();}
              // Media-parity G8 — one tap: download AND open when ready.
              else if (attachment.state !== 'loading') {setAutoOpen(true); attachment.load();}
            }}
            onLongPress={onLongPress}
            delayLongPress={280}
            style={styles.fileAttachRow}>
            <View style={styles.fileAttachIcon}>
              {attachment.state === 'loading' ? (
                <Icon name="lock" size={20} color={DM.accent} />
              ) : (
                <Icon
                  name={isVideo ? 'play-circle' : isAudio ? 'music-note' : 'file-document-outline'}
                  size={22}
                  color={DM.accent}
                />
              )}
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.fileAttachName} numberOfLines={1}>
                {/* Media-parity M14 — real filename for documents; duration-
                    labelled rows for playable media. */}
                {mMeta?.name
                  ?? (isVideo ? 'Video' : isAudio ? 'Voice message' : (msg.media_mime ?? 'File'))}
              </Text>
              <Text style={styles.fileAttachSub}>
                {msg.status === 'sending' && uploadProgress !== null
                  ? `Encrypting & uploading… ${Math.round(uploadProgress * 100)}%`
                  : attachment.state === 'loading' ? (autoOpen ? 'Downloading…' : 'Decrypting…')
                  : attachment.state === 'error' ? attachmentErrorText(attachment.errorReason)
                  : attachment.uri ? (mediaSubLabel(mMeta, isVideo || isAudio) ?? 'Tap to open')
                  : (mediaSubLabel(mMeta, isVideo || isAudio) ?? 'Tap to download')}
              </Text>
            </View>
          </TouchableOpacity>
        ) : (
          <>
            {/* T-12 — URLs in the body are tappable; white on the cobalt
                outgoing gradient, soft cobalt on the obsidian incoming one.
                Mentions ride the same renderer so the body and the caption
                below cannot diverge. */}
            <LinkifiedText
              style={styles.msgText}
              linkColor={sent ? '#FFFFFF' : '#A9C5FF'}
              // On the cobalt OUTGOING bubble the tint must stay near-white to
              // stay legible, so the chip fill is what distinguishes it from
              // the body text; on the obsidian INCOMING bubble cobalt already
              // reads, and the chip reinforces it.
              mentionColor={sent ? '#FFFFFF' : DM.accent}
              mentionChipColor={sent ? 'rgba(255,255,255,0.22)' : 'rgba(91,141,239,0.20)'}
              mentions={msg.mentions}
              selfUserId={selfUserId}
              // B-450 — a tappable URL span and the preview card below are both
              // press responders, so without this a message whose body is
              // mostly a link had no reachable action sheet.
              onLongPress={onLongPress}
              text={systemAddText ?? msg.content}
            />
            {/* T-12 privacy — received links never auto-fetch; the card asks
                for a tap first so merely receiving a message can't ping the
                link's host from this device. */}
            <LinkPreviewCard text={msg.content} autoFetch={sent} onLongPress={onLongPress} delayLongPress={280} />
          </>
        )}
        {/* Optional caption under any attachment */}
        {hasAttachment && !!msg.content && (
          <LinkifiedText
            style={[styles.msgText, {marginTop: 6}]}
            linkColor={sent ? '#FFFFFF' : '#A9C5FF'}
            mentionColor={sent ? '#FFFFFF' : DM.accent}
            mentionChipColor={sent ? 'rgba(255,255,255,0.22)' : 'rgba(91,141,239,0.20)'}
            mentions={msg.mentions}
            selfUserId={selfUserId}
            // B-450 — the caption under an attachment can hold a link too.
            onLongPress={onLongPress}
            text={msg.content}
          />
        )}
        </>
        )}
      </Animated.View>
      </TouchableOpacity>
      {/* Reactions render BETWEEN the bubble and the meta row so the chips
          never overlap the timestamp / delivery ticks (the old order put
          them after meta with a negative marginTop, colliding on the
          right-aligned sent side). */}
      {!msg.deleted_for_all && msg.reactions && Object.keys(msg.reactions).length > 0 && (
        // B-282 — the row is now a button: tapping it opens the roster of who
        // reacted with what. The chips themselves stay non-interactive so a tap
        // anywhere on the row does the same thing (each chip is well under the
        // 44/48dp target on its own).
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={onShowReactors}
          accessibilityRole="button"
          accessibilityLabel={reactionsA11yLabel(msg.reactions)}
          style={[styles.reactionsRow, sent ? {alignSelf: 'flex-end'} : {alignSelf: 'flex-start'}]}>
          {groupReactions(msg.reactions).map(({emoji, count, mine}) => (
            <View key={emoji} style={[styles.reactionChip, mine && styles.reactionChipMine]}>
              <Text style={styles.reactionEmoji}>{emoji}</Text>
              {count > 1 && <Text style={styles.reactionCount}>{count}</Text>}
            </View>
          ))}
        </TouchableOpacity>
      )}
      {showMeta && (
        <View style={[styles.msgMeta, !sent && styles.msgMetaIn]}>
          {/* An edit is never silent. The marker sits BEFORE the timestamp so
              it reads as "edited 14:32", and it is suppressed on a tombstone
              where it would be noise. */}
          {msg.edited_at && !msg.deleted_for_all ? (
            <Text style={styles.editedTag}>edited</Text>
          ) : null}
          <Text style={styles.msgTime}>{time}</Text>
          {msg.expires_at && (
            <View style={styles.timerBadge}>
              <Icon name="fire" size={12} color={Bravo.amber} />
              <Text style={styles.timerText}>{expiresIn ?? '—'}</Text>
            </View>
          )}
          {/* F-3 (B-693) — non-interactive by design: the retry is automatic
              (outbox), so this is a status word, not a button. An uploading
              media bubble already narrates its own progress — skip it there. */}
          {sent && msg.status === 'sending' && !isUploading && sendingStalled && (
            <Text style={styles.retryingTag}>retrying…</Text>
          )}
          {sent && statusIcon && (
            (msg.status === 'failed' || msg.status === 'undelivered') && onRetry ? (
              <TouchableOpacity
                style={styles.retryChip}
                onPress={onRetry}
                hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Retry sending this message">
                <Icon name={statusIcon.name} size={13} color={statusIcon.color} />
                <Text style={styles.retryChipText}>Tap to retry</Text>
              </TouchableOpacity>
            ) : (
              <Icon name={statusIcon.name} size={15} color={statusIcon.color} />
            )
          )}
        </View>
      )}
    </Animated.View>
    </PanGestureHandler>
  );
}

/**
 * Fold `{userId: emoji}` into `{emoji, count, mine}[]` so the UI can
 * render one chip per distinct emoji. "Mine" is true when the current
 * user's userId is `"self"` in the map — matches how productionRuntime
 * stores the self-echo.
 */
// Fix #26: ONE module-level 1 Hz tick that every disappearing-message
// bubble subscribes to via useSyncExternalStore. Prior implementation
// created a setInterval per bubble — a chat with 60+ active timed
// messages had 60+ intervals firing at the same offset, each calling
// setState on its own bubble, each scheduling a render commit. The
// JS thread was burning ~10 ms per second just on tick handlers.
// One subscription per bubble + one shared interval means JS only
// pays for the timer once. M-13: only ARMED bubbles (real expires_at)
// subscribe — the snapshot is Date.now(), which changes every tick, so
// any subscriber re-renders every second by design; unarmed bubbles get
// a no-op subscription in useCountdown instead.
let _countdownNowMs = Date.now();
const _countdownListeners = new Set<() => void>();
let _countdownTimer: ReturnType<typeof setInterval> | null = null;
function _ensureCountdownTimer(): void {
  if (_countdownTimer) {return;}
  // Why: the timer stops whenever no armed bubble is mounted, so the
  // cached snapshot can be minutes stale when the next one subscribes —
  // refresh it here or the first rendered countdown is wildly wrong.
  _countdownNowMs = Date.now();
  _countdownTimer = setInterval(() => {
    _countdownNowMs = Date.now();
    for (const cb of _countdownListeners) {
      try { cb(); } catch { /* one bad subscriber mustn't break the rest */ }
    }
  }, 1000);
}
function _stopCountdownTimerIfIdle(): void {
  if (_countdownTimer && _countdownListeners.size === 0) {
    clearInterval(_countdownTimer);
    _countdownTimer = null;
  }
}
function _subscribeCountdown(cb: () => void): () => void {
  _countdownListeners.add(cb);
  _ensureCountdownTimer();
  return () => {
    _countdownListeners.delete(cb);
    _stopCountdownTimerIfIdle();
  };
}
function _getCountdownSnapshot(): number {
  return _countdownNowMs;
}

// M-13 — stable no-op pair for unarmed bubbles. React.memo CANNOT block
// a hook-driven self-render, so a real subscription here re-rendered
// every mounted bubble at 1 Hz regardless of expires_at.
const _noopSubscribe = (): (() => void) => () => {};
const _zeroSnapshot = (): number => 0;

function useCountdown(expiresAtMs?: number): string | null {
  // Hook call stays unconditional; only the ARGUMENTS switch, so unarmed
  // bubbles never re-render on the shared tick.
  const armed = typeof expiresAtMs === 'number' && expiresAtMs > 0;
  const now = React.useSyncExternalStore(
    armed ? _subscribeCountdown : _noopSubscribe,
    armed ? _getCountdownSnapshot : _zeroSnapshot,
  );
  if (!expiresAtMs) {return null;}
  const ms = expiresAtMs - now;
  if (ms <= 0) {return '0s';}
  const s = Math.floor(ms / 1000);
  if (s < 60) {return `${s}s`;}
  const m = Math.floor(s / 60);
  if (m < 60) {return `${m}m ${s % 60}s`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h ${m % 60}m`;}
  return `${Math.floor(h / 24)}d`;
}

/**
 * Overlapping member-avatar stack for the group chat header. Shows up to
 * 6 colored dots (one per participant, using the deterministic
 * `senderColorFor` palette) with a "+N" pill when there are more.
 */
function GroupMemberStack({participants}: {participants: string[]}) {
  const MAX = 6;
  const shown = participants.slice(0, MAX);
  const overflow = participants.length - shown.length;
  return (
    <View style={styles.memberStackRow}>
      <View style={{flexDirection: 'row', flexShrink: 0}}>
        {shown.map((uid, i) => (
          <View
            key={uid}
            style={[
              styles.memberDot,
              {backgroundColor: senderColorFor(uid), marginLeft: i === 0 ? 0 : -6},
            ]}
          />
        ))}
      </View>
      <Text style={styles.memberStackText} numberOfLines={1} maxFontSizeMultiplier={1.2}>
        {overflow > 0 ? `+${overflow}` : `${participants.length} operators`}
      </Text>
      <Icon name="shield-lock-outline" size={10} color={Bravo.signal} />
      <Text style={styles.memberStackE2e} numberOfLines={1} maxFontSizeMultiplier={1.2}>E2E</Text>
    </View>
  );
}

/**
 * Deterministic accent color used for a sender's callsign label + bubble
 * accent border inside a group. Keyed on userId so each member keeps the
 * same color across the thread.
 */
// B-286 — this was a seventh-colour COPY of `colorForSender`, same hash and
// same job, so departmental chat and group chat tinted the same person
// differently. The null hardening it added (a partial decrypt or a restored
// backup that dropped sender_id used to crash the whole chat render with
// `Cannot read property 'length' of undefined`) moved into the shared helper.
function senderColorFor(userId: string | null | undefined): string {
  return colorForSender(userId);
}

/**
 * Group-chat sender label. In direct chats the peer's name is already in
 * the header, so callers skip this. In groups we resolve via the dev
 * contacts roster (stable userId → name) and fall back to the header
 * name then a short userId stub.
 */
function resolveSenderName(senderId: string | null | undefined, _fallback: string): string {
  // Why: same hardening as senderColorFor — a missing sender_id used to
  // crash with `Cannot read property 'slice' of undefined`. Show a
  // generic placeholder instead of letting the chat-render explode.
  if (!senderId) {return '???';}
  // 1) Hardcoded dev contacts.
  const dev = DEV_CONTACTS.find(c => c.userId === senderId);
  if (dev) {return dev.name;}
  // 2) Any 1:1 conversation we already have with this user — its
  //    `name` was populated from contact discovery, so it's the user's
  //    real display name. B-411 — unless it's still the `Bravo · <hex>`
  //    placeholder, which must never render; fall through to the
  //    directory/phone chain instead.
  const directConvo = useMessengerStore.getState().conversations[`direct:${senderId}`];
  if (directConvo?.name && directConvo.name !== 'self'
      && !isPlaceholderName(directConvo.name, senderId)) {
    return directConvo.name;
  }
  // B-115 — registered directory name before any raw-id fragment; a miss
  // queues a debounced batch fetch whose store write re-renders the bubble
  // with the real name.
  const dirName = useMessengerStore.getState().directoryNames[senderId];
  if (dirName) {return dirName;}
  // B-226 — a known peer phone (E.164) beats an opaque code (WhatsApp parity);
  // we only ever hold one for a discovered contact.
  const phone = directConvo?.phoneE164
    ?? Object.values(useMessengerStore.getState().conversations).find(
      c => c.type === 'direct' && c.peer?.userId === senderId,
    )?.phoneE164;
  if (phone) {return phone;}
  try {
    // Uses the module-level import (line ~31). The local `require` that used to
    // sit here shadowed it, which is a lint error and bought nothing — the
    // module is statically imported either way.
    ensureDirectoryNames([senderId]);
  } catch { /* offline / pre-auth — fragment below is the last resort */ }
  // 3) The previous version fell back to `fallback` (the GROUP's name),
  //    which made every member's bubble show the group name instead of
  //    their own. We deliberately ignore `_fallback` here. B-411 — the
  //    last resort is a neutral label, never a raw-id fragment; the
  //    ensureDirectoryNames fetch queued above upgrades it on landing.
  return 'Bravo user';
}

/**
 * Media-parity — WhatsApp-style sub-label for playable/file rows:
 * "0:42" for audio/video with a known duration, "1.2 MB" for documents.
 * Null when the envelope carried no metadata (legacy senders).
 */
function mediaSubLabel(
  meta: LocalMessage['media_meta'],
  playable: boolean,
): string | null {
  if (!meta) {return null;}
  if (playable && typeof meta.durationMs === 'number' && meta.durationMs > 0) {
    const total = Math.round(meta.durationMs / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  if (typeof meta.sizeBytes === 'number' && meta.sizeBytes > 0) {
    const kb = meta.sizeBytes / 1024;
    return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`;
  }
  return null;
}

function statusToIcon(status: LocalMessage['status']): {name: 'check' | 'check-all' | 'alert-circle' | 'progress-clock'; color: string} | null {
  // Send-state ticks use the brand kit tokens. Sent/delivered are muted
  // (Bravo.textMute) so they sit unobtrusively under the bubble; read
  // jumps to Bravo.glow (#7ED6FF) — same cyan as the verified shield
  // and reply accent — to draw the eye when the recipient confirms.
  // B-131 — the RULE (which status means which tick) is shared with the
  // conversation-list row via runtime/messageTicks; the icon/colour mapping
  // itself is shared via runtime/tickIcon (Departmental Chat's bubble uses the
  // same function with its own obsidian tokens) so a third surface can't
  // reintroduce a divergent copy of either.
  return tickIcon({status, sender_id: 'self'}, {mute: Bravo.textMute, read: Bravo.glow, alert: Bravo.alert});
}

/**
 * Map the presence record (populated by the socket.io presence fan-out)
 * to the dot state. Round 7 / presence audit fix #7 — the server emits
 * the full 4-state ladder (online/active/away/offline); we now preserve
 * it and surface `away` peers as amber rather than the previous green
 * (which made backgrounded peers look like they were online).
 */
function headerDotState(
  rec: {state?: 'online' | 'active' | 'away' | 'offline'; online: boolean} | undefined,
): OnlineDotState {
  if (!rec) {return 'offline';}
  if (rec.state) {return rec.state;}
  // Back-compat for any record that predates the wider slice.
  return rec.online ? 'online' : 'offline';
}

// presenceTone + presenceLabel were inline helpers used by the old
// dot+text presence row; removed when we switched to PeerPresencePill.

/**
 * B-159 — the message composer, extracted out of `ChatScreenInner`.
 *
 * The draft used to be `useState` at the screen root, so every keystroke
 * re-ran every hook and selector in a ~2,700-line component. `React.memo`
 * cannot help a component that re-renders itself: the state has to MOVE. Now a
 * keystroke re-renders this input bar and nothing else.
 *
 * The screen still learns everything it needs, by callback:
 *   • `onSend(trimmed)` — the submitted body, already trimmed.
 *   • `onDraftActivity(hasText)` — fires on EVERY keystroke so the typing
 *     frames (start / 5s re-emit / stop) keep their old cadence. The screen's
 *     handler touches refs only, so this costs no render.
 *
 * Every prop must be referentially stable (the screen uses latest-refs for the
 * two closures) or the memo is defeated and we are back where we started.
 */
export interface ChatComposerHandle {
  /** Append text to the draft — used by the emoji sheet, which the screen owns. */
  insert: (s: string) => void;
  /** Load a message body for in-place editing and focus the field. */
  beginEdit: (body: string) => void;
  /** Leave edit mode and clear the field. */
  endEdit: () => void;
  /**
   * B-280 — put the caret back in the field and raise the IME. The emoji sheet
   * covers the keyboard while it is open, so dismissing it used to leave the
   * composer blurred with no keyboard: the user had to tap the field again
   * before they could keep typing.
   */
  focusInput: () => void;
}

interface ChatComposerProps {
  initialDraft:     string;
  composerEnabled:  boolean;
  groupKeyPending:  boolean;
  ready:            boolean;
  ttlSec:           number | null;
  onSend:           (trimmed: string, mentions?: Array<{userId: string; label: string}>) => void;
  onDraftActivity:  (hasText: boolean) => void;
  /**
   * MI-06 — persist the draft (debounced + on unmount) so it survives
   * leaving the chat and an app restart. Receives the full current text;
   * empty text clears the persisted draft.
   */
  onPersistDraft?:  (text: string) => void;
  onAttach:         () => void;
  /** Toggles the inline emoji panel (and swaps the system IME out for it). */
  onEmoji:          () => void;
  /**
   * B-281 — true while the inline emoji panel occupies the space the system IME
   * vacated. The panel lives INSIDE this component's padded column, below the
   * input bar, so the composer stays visible while the user picks emoji. A modal
   * bottom sheet could never do that: it is anchored to the window bottom and so
   * always covers the composer.
   */
  emojiOpen?:       boolean;
  /** Dismiss the emoji panel and hand focus back so the IME can return. */
  onCloseEmoji?:    () => void;
  onTimer:          () => void;
  onVoiceComplete:  (rec: {uri: string; mimeType: string; durationMs: number}) => void;
  /**
   * Roster for the @-mention picker: every OTHER member of this conversation.
   * Empty for a 1:1 — mentioning the only other participant is noise, so the
   * trigger stays inert there.
   */
  mentionRoster?:   ReadonlyArray<{userId: string; label: string}>;
  /** True while the composer is editing an existing message. */
  isEditing?:       boolean;
  /** Leave edit mode without sending. */
  onCancelEdit?:    () => void;
}

const ChatComposer = React.memo(React.forwardRef<ChatComposerHandle, ChatComposerProps>(
  function ChatComposerImpl(props, ref) {
    const {
      initialDraft, composerEnabled, groupKeyPending, ready, ttlSec,
      onSend, onDraftActivity, onPersistDraft, onAttach, onEmoji, onTimer, onVoiceComplete,
      mentionRoster, isEditing, onCancelEdit, emojiOpen, onCloseEmoji,
    } = props;
    // B-184 — the composer is the bottom-most element of the chat, so it owns
    // the keyboard inset for the whole screen. bottomPad REPLACES insets.bottom
    // while the IME is up (the keyboard already covers the nav bar / home
    // indicator); stacking them is what produced the iOS blind space.
    const {bottomPad} = useKeyboardLayout();
    // Match the centered message column on a large/unfolded screen.
    const {isLargeScreen, contentMaxWidth} = useContentWidth(720);
    // B-281 — reactive, so the emoji panel resizes on unfold/rotate rather than
    // keeping a height measured for the previous form factor.
    const {height: windowHeight} = useWindowDimensions();
    const [text, setText] = useState(initialDraft);
    /**
     * The SYNCHRONOUS truth for the draft.
     *
     * `onChangeText` fires synchronously from native, but `setText` only
     * applies on the next render — so anything that reads `text` in the same
     * tick as a keystroke reads a STALE value. Two founder-reported bugs came
     * out of that one gap:
     *
     *   1. Type fast, hit send → the message shipped TRUNCATED ("broken
     *      sentence"), because `submit` read the state as it was one or more
     *      keystrokes ago.
     *   2. Tap send, nothing appears to happen, tap again → TWO identical
     *      messages, because the first tap could not clear the state
     *      synchronously and the second tap still saw the old body.
     *
     * Writing here first makes both impossible: `submit` reads the ref, and
     * clearing the ref synchronously IS the double-tap guard (a second tap
     * finds it empty and bails). Every other writer of `text` must keep this
     * in step — that is asserted in composerSendRace.test.ts.
     */
    const textRef = useRef(initialDraft);
    const inputRef = useRef<TextInput>(null);
    // LIVE-MONITOR (#9) — after a send the button swaps to press-to-record at
    // the SAME position; hold a short settle window so a quick follow-up tap
    // can't arm the recorder under the finger.
    const [justSent, setJustSent] = useState(false);
    const justSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (justSentTimer.current) { clearTimeout(justSentTimer.current); } }, []);

    // MI-06 — persist the draft, debounced off `text` (one write per typing
    // pause, not per keystroke), plus a final flush on unmount so backing out
    // of the chat never loses the tail. Reads textRef (the synchronous truth),
    // so the post-send flush persists the CLEARED value, not a stale body.
    const persistDraftRef = useRef(onPersistDraft);
    persistDraftRef.current = onPersistDraft;
    useEffect(() => {
      if (!persistDraftRef.current) {return;}
      const t = setTimeout(() => persistDraftRef.current?.(textRef.current), 800);
      return () => clearTimeout(t);
    }, [text]);
    // NAV-22 (2026-08-26 audit) — the flush is DEFERRED off the unmount stack.
    // setDraft runs the store's full partialize (an O(conversations + groups)
    // spread copy — the MSG-10/P0-S3 strips, which must stay in partialize)
    // and used to run it synchronously inside the back pop's unmount commit,
    // which is exactly when the pop transition needs the JS thread. One
    // macrotask later the pop is dispatched and the same work runs unchanged;
    // the value is captured first so no later mutation can widen the window.
    useEffect(() => () => {
      const tail = textRef.current;
      setTimeout(() => persistDraftRef.current?.(tail), 0);
    }, []);

    // @-mentions picked so far in this draft. Kept as a superset and reconciled
    // against the final body on submit — the user may delete a name by hand
    // after picking it, and shipping a mention for a name that is no longer in
    // the text would push "you were mentioned" for a message that does not
    // mention them.
    const [picked, setPicked] = useState<Array<{userId: string; label: string}>>([]);
    // Caret position, so the trigger scan knows where the user is typing rather
    // than always reading the end of the string.
    const caretRef = useRef<number | null>(null);

    // B-270 — memoised. Both of these ran on EVERY composer render, which
    // means every keystroke: `findMentionQuery` rescans the body and
    // `filterMentionCandidates` walks the whole roster and allocates a fresh
    // array. The new array identity then re-rendered the picker list even when
    // the matches were identical, so a group with a large roster paid a scan +
    // a filter + a list repaint per character. That is the laggy mention
    // picker. Keyed on the caret too, because moving the cursor into a
    // different @token must re-run the scan even though `text` is unchanged.
    const caretPos = caretRef.current ?? text.length;
    const mentionToken = useMemo(
      () => (mentionRoster?.length ? findMentionQuery(text, caretPos) : null),
      [mentionRoster, text, caretPos],
    );
    const mentionMatches = useMemo(
      () => (mentionToken ? filterMentionCandidates(mentionRoster ?? [], mentionToken.query) : EMPTY_MENTIONS),
      [mentionToken, mentionRoster],
    );

    const onChangeText = (next: string) => {
      textRef.current = next; // synchronous truth — must be first
      setText(next);
      // A keystroke moves the caret to the end of the inserted text; the real
      // position arrives via onSelectionChange a moment later.
      caretRef.current = null;
      onDraftActivity(next.trim().length > 0);
    };

    /**
     * Append to the draft. The ONE path used by both the imperative `insert`
     * handle (emoji sheet on other screens, hand-off drafts) and the inline
     * emoji panel below — B-281 added a second caller, and two copies of this
     * would be two chances to forget the synchronous-ref rule below.
     *
     * Composes off the REF, not the state updater: an emoji tapped in the same
     * tick as a keystroke would otherwise append to a stale draft.
     */
    const appendToDraft = useCallback((s: string) => {
      const next = textRef.current + s;
      textRef.current = next;
      setText(next);
      onDraftActivity(next.trim().length > 0);
    }, [onDraftActivity]);

    const choose = (c: {userId: string; label: string}) => {
      if (!mentionToken) {return;}
      const out = insertMention(text, mentionToken, c);
      textRef.current = out.text;
      setText(out.text);
      caretRef.current = out.caret;
      setPicked(prev => (prev.some(p => p.userId === c.userId) ? prev : [...prev, c]));
      onDraftActivity(out.text.trim().length > 0);
      inputRef.current?.focus();
    };

    React.useImperativeHandle(ref, () => ({
      insert: appendToDraft,
      beginEdit: (body: string) => {
        textRef.current = body;
        setText(body);
        setPicked([]);
        caretRef.current = null;
        onDraftActivity(body.trim().length > 0);
        inputRef.current?.focus();
      },
      endEdit: () => {
        textRef.current = '';
        setText('');
        setPicked([]);
        inputRef.current?.clear();
        onDraftActivity(false);
      },
      focusInput: () => {
        inputRef.current?.focus();
      },
      // B-281 — `appendToDraft` is re-created each render so the handle object is
      // too. That is harmless: callers only ever invoke methods through the ref,
      // never compare its identity, and listing it keeps the closure honest rather
      // than pinning the first render's copy.
    }), [onDraftActivity, appendToDraft]);

    const submit = () => {
      // Read the REF, never the state. `setText` is async, so under fast typing
      // the state still holds the body as it was one or more keystrokes ago and
      // the message ships truncated — the "broken sentence" report.
      const trimmed = textRef.current.trim();
      if (!trimmed || !composerEnabled) {return;}
      // Drop any mention whose name the user deleted by hand after picking it.
      const mentions = picked.length ? reconcileMentions(trimmed, picked) : [];
      // Clear the ref BEFORE anything async. This is the double-send guard: a
      // second tap that lands before React has re-rendered now reads an empty
      // ref and returns above, instead of shipping the same body twice.
      textRef.current = '';
      setText('');
      setPicked([]);
      caretRef.current = null;
      // B-73 — also clear the NATIVE field imperatively. `setText('')` alone
      // must round-trip through a re-render before the native EditText updates;
      // a fast next keystroke lands on the uncleared field and onChangeText
      // reports the concatenation ("2" → "23" → "234" under rapid send).
      inputRef.current?.clear();
      onDraftActivity(false);
      setJustSent(true);
      if (justSentTimer.current) { clearTimeout(justSentTimer.current); }
      justSentTimer.current = setTimeout(() => setJustSent(false), 350);
      onSend(trimmed, mentions.length ? mentions : undefined);
    };

    const hasText = text.trim().length > 0;
    const wide = isLargeScreen ? {maxWidth: contentMaxWidth, alignSelf: 'center' as const, width: '100%' as const} : null;
    // B-281 — panel height as a share of the window, clamped. A soft keyboard is
    // roughly 35-42% of the screen on the devices this ships to, so 38% lands the
    // panel where the IME was. The clamp keeps a very short screen from losing the
    // whole thread and a tablet from opening an absurd wall of emoji.
    const emojiPanelHeight = Math.max(240, Math.min(360, Math.round(windowHeight * 0.38)));
    return (
      // B-184 — the composer COLUMN is the bottom-most element, so it owns the
      // keyboard inset for the whole screen. The inset lives on this wrapper
      // (not on the input bar) so the mention picker and the edit bar, which
      // sit ABOVE the input, ride up with it instead of being covered by the IME.
      <View style={{paddingBottom: bottomPad(8)}}>
        {/* @-mention picker. Above the input, capped in height, and scrollable
            so a large roster cannot push the composer off-screen. */}
        {mentionMatches.length > 0 && (
          <View style={[styles.mentionSheet, wide]}>
            <ScrollView keyboardShouldPersistTaps="always" style={styles.mentionScroll}>
              {mentionMatches.map(c => (
                <TouchableOpacity
                  key={c.userId}
                  style={styles.mentionRow}
                  onPress={() => choose(c)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Mention ${c.label}`}>
                  <View style={styles.mentionAvatar}>
                    <Text style={styles.mentionAvatarText}>{initials(c.label)}</Text>
                  </View>
                  <Text style={styles.mentionName} numberOfLines={1}>{c.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}
        {/* Edit-mode banner — mirrors the reply bar so the two composer modes
            read the same way. */}
        {isEditing && (
          <View style={[styles.editBar, wide]}>
            <Icon name="pencil-outline" size={16} color={DM.accent} />
            <View style={styles.editBarBody}>
              <Text style={styles.editBarTitle}>Editing message</Text>
              <Text style={styles.editBarHint} numberOfLines={1}>
                Send to save, or cancel to discard
              </Text>
            </View>
            <TouchableOpacity
              style={styles.editBarClose}
              onPress={onCancelEdit}
              activeOpacity={0.7}
              hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
              accessibilityRole="button"
              accessibilityLabel="Cancel editing">
              <Icon name="close" size={14} color={DM.textMute} />
            </TouchableOpacity>
          </View>
        )}
      <View style={[styles.inputBar, wide]}>
        {/* An in-place text edit cannot take an attachment, so the affordance
            is hidden rather than left live and failing on tap. */}
        {!isEditing && (
        <TouchableOpacity
          style={[styles.attachBtn, !composerEnabled && {opacity: 0.5}]}
          activeOpacity={0.7}
          disabled={!composerEnabled}
          onPress={onAttach}>
          <Icon name="plus" size={22} color={DM.onAccent} />
        </TouchableOpacity>
        )}
        <View style={styles.inputWrap}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder={
              isEditing ? 'Edit your message…'
              : groupKeyPending ? 'Waiting for the group key…'
              : ready ? 'Type a secure message...'
              : 'Establishing session...'
            }
            placeholderTextColor="#7E8AA6"
            value={text}
            onChangeText={onChangeText}
            onSelectionChange={e => { caretRef.current = e.nativeEvent.selection.end; }}
            // B-281 — tapping the field while the emoji panel is up swaps back to
            // the system keyboard, the way WhatsApp does. Guarded on `emojiOpen`
            // so the refocus inside onCloseEmoji cannot re-enter this handler.
            onFocus={() => { if (emojiOpen) { onCloseEmoji?.(); } }}
            editable={composerEnabled}
            multiline
          />
          {/* B-281 — the glyph flips to a keyboard while the emoji panel is up,
              so the toggle is discoverable instead of a dead-end. */}
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={onEmoji}
            accessibilityRole="button"
            accessibilityState={{expanded: !!emojiOpen}}
            accessibilityLabel={emojiOpen ? 'Show keyboard' : 'Show emoji'}>
            <Icon name={emojiOpen ? 'keyboard-outline' : 'emoticon-outline'} size={18} color="#7E8AA6" />
          </TouchableOpacity>
        </View>
        {/* A disappearing-message timer applies to a NEW message; re-arming it
            during an edit would silently change the burn deadline of a message
            already delivered. Hidden in edit mode. */}
        {!isEditing && (
        <TouchableOpacity
          style={[styles.inputIconBtn, ttlSec ? styles.inputIconBtnActive : null]}
          activeOpacity={0.7}
          hitSlop={{top: 4, bottom: 4, left: 4, right: 4}}
          onPress={onTimer}>
          <Icon name="timer-outline" size={21} color={ttlSec ? Bravo.amber : '#7E8AA6'} />
          {ttlSec ? <Text style={styles.ttlBadge}>{ttlLabel(ttlSec)}</Text> : null}
        </TouchableOpacity>
        )}
        {/* In edit mode the send button is ALWAYS the affordance — swapping to
            the mic when the field is emptied would arm the recorder inside an
            edit, and there is no such thing as editing a text into a voice
            note. `hasText` still gates whether it is enabled. */}
        {hasText || justSent || isEditing ? (
          <TouchableOpacity
            style={[styles.sendBtn, (!composerEnabled || !hasText) && {opacity: 0.5}]}
            onPress={submit}
            activeOpacity={0.85}
            disabled={!composerEnabled || !hasText}>
            <LinearGradient
              colors={MIC_GRADIENT}
              start={{x: 0, y: 0}} end={{x: 0, y: 1}}
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, styles.micGradient]}
            />
            <Icon name="send" size={18} color="#FFF" />
          </TouchableOpacity>
        ) : (
          <VoiceNoteRecorder
            onComplete={onVoiceComplete}
            onCancel={() => { /* discarded — nothing to do */ }}
            renderIdle={() => (
              <View style={styles.micBtn}>
                <LinearGradient
                  colors={MIC_GRADIENT}
                  start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                  pointerEvents="none"
                  style={[StyleSheet.absoluteFill, styles.micGradient]}
                />
                <Icon name="microphone" size={18} color="#FFF" />
              </View>
            )}
          />
        )}
      </View>

      {/* B-281 — the emoji keyboard, INSIDE the padded column and BELOW the input
          bar, occupying the space `Keyboard.dismiss()` just freed. That placement
          is the whole fix: a modal bottom sheet is anchored to the window and so
          always covered the composer, which is why the user could not see the
          emoji they were picking once B-280 kept the sheet open.

          Height is a FRACTION of the window, never a dp constant — same rule as
          B-277, because this ships to small phones, tablets and foldables. It is
          clamped so it cannot eat the thread on a short screen or float absurdly
          tall on a tablet. */}
      {emojiOpen && (
        <View style={[styles.emojiPanel, {height: emojiPanelHeight}, wide]}>
          <EmojiKeyboard
            onEmojiSelected={e => appendToDraft(e.emoji)}
            categoryPosition="top"
            // B-281 — NO search bar. It cost a row of the panel that the founder
            // wanted for emoji, and it is also the only reason the provider's memo
            // ran `emojisByCategory.map(g => g.data).flat()` over the whole
            // ~1,800-entry dataset: that branch is gated on `enableSearchBar`.
            // Dropping it buys back the row AND the flatten. Categories along the
            // top are the navigation.
            enableRecentlyUsed
            theme={{
              knob: DM.accent,
              container: '#0C1018',
              header: '#F2F4F8',
              skinTonesContainer: '#161B25',
              category: {icon: '#7E8AA6', iconActive: '#F2F4F8', container: '#0C1018', containerActive: DM.accent},
              search: {background: 'rgba(255,255,255,0.05)', text: '#F2F4F8', placeholder: '#7E8AA6', icon: '#7E8AA6'},
            }}
          />
        </View>
      )}
      </View>
    );
  },
));

/**
 * Forward picker list — excludes the current conversation so you can't
 * silently loop a message back to itself. Pressing a row fires the
 * handler; caller closes the modal.
 */
/**
 * B-655 — module-level so `FlatList` sees a stable `keyExtractor` identity.
 * An inline `i => i.key` allocates a fresh closure per render and defeats the
 * PureComponent prop diff, which re-renders the whole mounted window on every
 * keystroke in the picker's search box.
 */
const pickerItemKey = (i: {key: string}): string => i.key;

export function ForwardList({currentConvId, onPick}: {currentConvId: string; onPick: (id: string) => void}) {
  // Why: M-18 pattern — immer mints a new `conversations` map on every commit
  // that touches any conversation, so a bare selector re-rendered the open
  // picker on each inbound message anywhere.
  const conversations     = useMessengerStore(useShallow(s => s.conversations));
  const conversationOrder = useMessengerStore(s => s.conversationOrder);
  // F7 — a department channel is stored as an ordinary `type: 'group'` row, so
  // it appeared in this picker like any other chat. `forwardTo` then calls
  // `runtime.sendText(targetConvId, …)`, and sendText derives `isGroup` from the
  // store (productionRuntime `opts.isGroup === true || isGroupConversation(…)`),
  // so picking one fanned a sealed envelope out to EVERY member — a post into a
  // #broadcast channel by someone the channel forbids from posting, with no role
  // check anywhere on the path. The posting rule is enforced inside
  // `DepartmentChatScreen`; this picker is outside it and cannot evaluate the
  // caller's channel role (it has no channel id and no roster).
  //
  // So the target list excludes departmental conversations outright. Fail-closed
  // is the documented standard here (A4: never rely on a control being hidden),
  // and it costs only "forward INTO a channel", which no flow offers today —
  // `DepartmentChatScreen`'s own picker already excludes the channel you are in,
  // and forwarding OUT of a channel is untouched.
  const deptConversationIds = useMessengerStore(useShallow(s => s.deptConversationIds));
  const deptGroupByChannel  = useMessengerStore(useShallow(s => s.deptGroupByChannel));
  const upsertConversation  = useMessengerStore(s => s.upsertConversation);
  const currentUserId       = useAuthStore(s => s.user?.id ?? null);
  const ownPhoneE164        = useAuthStore(s => s.user?.phone_e164 ?? null);

  /**
   * Founder 2026-08-24 — "how can I share to other individual contacts? It's
   * only picking up my last 2 chats." The list was conversations-only, so a
   * contact you had never messaged was unreachable. INDIVIDUALS is now the
   * union: existing 1:1 chats (recent first, as before) + every discovered
   * Bravo contact without a chat yet (alphabetical, below them). Passive
   * discovery — the same mode MessengerHome runs — so opening a picker never
   * fires a contacts-permission prompt.
   */
  const usersClient = useMemo(
    () => new UsersHttpClient({
      baseUrl:      API_BASE_URL,
      getToken:     () => tokenStore.get(),
      refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
    }),
    [],
  );
  const {matches: discovered} = useDiscoveredContacts({
    users: usersClient, ownPhoneE164, enabled: true, passive: true,
  });
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  /**
   * B-655 — MEMOISED. All of this used to run in the bare render body, and
   * this component owns the search box's `query` state, so every keystroke
   * re-ran the whole model build — including `resolveDeptConversation`, which
   * allocates a fresh `Object.entries(deptGroupByChannel)` array PER
   * CONVERSATION. `rows` only depends on the conversation set, never on the
   * query, so it must not be rebuilt as the user types.
   */
  const rows = useMemo(
    () => conversationOrder
      .map(id => conversations[id])
      .filter(c => c && c.id !== currentConvId
        && !resolveDeptConversation(c.id, {deptConversationIds, deptGroupByChannel})),
    [conversationOrder, conversations, currentConvId, deptConversationIds, deptGroupByChannel],
  );
  /**
   * Client 2026-08-22 — people and groups are SEPARATE sections; the decisions
   * (buckets, contact union/dedup, search fold) are PURE in forwardTargets.ts
   * so tests execute them rather than scanning for them.
   */
  const {individuals, groups} = useMemo(
    () => bucketConversations(rows, query),
    [rows, query],
  );
  const contacts = useMemo(
    () => contactsWithoutConversation(discovered, rows, currentUserId, query),
    [discovered, rows, currentUserId, query],
  );

  // BS-NC1 — resolve to the canonical direct id (a server-UUID row wins over
  // the synthetic `direct:` key) and seed the row only when it is new. The
  // exact recipe NewChatScreen's contact tap uses; drifting from it re-opens
  // the split-brain duplicate-thread bug.
  const pickContact = (m: DiscoveredRow) => {
    const conversationId = resolveDirectConversationIdFromState(
      useMessengerStore.getState(), m.userId,
    );
    if (conversationId.startsWith('direct:')) {
      upsertConversation({
        id:             conversationId,
        type:           'direct',
        name:           m.localName || m.displayName,
        name_source:    'contact',
        participants:   [currentUserId ?? 'self', m.userId],
        unread_count:   0,
        is_muted:       false,
        created_at:     new Date().toISOString(),
        peer:           {userId: m.userId, deviceId: 1},
        phoneE164:      m.phoneE164,
        session_state:  'fresh',
      });
    }
    onPick(conversationId);
  };

  /**
   * Founder 2026-08-24 ("the scroll of people is laggy") — VIRTUALIZED. The
   * contact-directory union can be hundreds of rows, and the previous
   * ScrollView mounted every one (plus its avatar resolution) before the
   * sheet could scroll. One flat FlatList now owns all sections.
   */
  type PickerItem =
    | {t: 'header'; key: string; label: string}
    | {t: 'conv'; key: string; c: (typeof rows)[number]}
    | {t: 'contact'; key: string; m: DiscoveredRow};

  /**
   * B-655 — `data` must be a stable reference or FlatList (a PureComponent)
   * re-renders its whole mounted window on every parent render.
   *
   * ⚠️ This MUST stay ABOVE the empty-state early return below. My first pass
   * put it after, which made a hook conditional — the hook order then differs
   * between "no targets" and "some targets" renders, which is a React crash
   * waiting for the first user whose last chat disappears while the picker is
   * open. Caught by eslint `react-hooks/rules-of-hooks`, not by any test.
   */
  const items = useMemo<PickerItem[]>(() => {
    const out: PickerItem[] = [];
    if (individuals.length > 0 || contacts.length > 0) {
      out.push({t: 'header', key: 'h-ind', label: 'INDIVIDUALS'});
    }
    for (const c of individuals) {out.push({t: 'conv', key: c.id, c});}
    for (const m of contacts) {out.push({t: 'contact', key: `contact-${m.userId}`, m});}
    if (groups.length > 0) {out.push({t: 'header', key: 'h-grp', label: 'GROUPS'});}
    for (const c of groups) {out.push({t: 'conv', key: c.id, c});}
    return out;
  }, [individuals, contacts, groups]);

  // Empty state — AFTER every hook above, so hook order never varies.
  if (rows.length === 0 && contacts.length === 0 && !q) {
    return (
      <View style={{paddingVertical: 24, alignItems: 'center'}}>
        <Text style={{color:'#B8C7E0', fontSize:12}}>No other chats to forward to.</Text>
      </View>
    );
  }

  const initialsDisc = (name: string) => (
    <View style={{width:36, height:36, borderRadius:18, backgroundColor: DM.accent, alignItems:'center', justifyContent:'center'}}>
      <Text style={{color:'#FFF', fontWeight:'800', fontSize:11}}>{name.slice(0,2).toUpperCase()}</Text>
    </View>
  );

  const renderPickerItem = ({item}: {item: PickerItem}) => {
    if (item.t === 'header') {
      return (
        <Text style={{color:'rgba(180,188,204,0.45)', fontSize:10, fontWeight:'800', letterSpacing:1.4, paddingHorizontal:18, paddingTop:12, paddingBottom:6}}>
          {item.label}
        </Text>
      );
    }
    if (item.t === 'contact') {
      const name = contactRowName(item.m);
      return (
        <TouchableOpacity
          style={{flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingVertical:10}}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Send to ${name}`}
          onPress={() => pickContact(item.m)}>
          <UserAvatar userId={item.m.userId} size={36} fallback={initialsDisc(name)} />
          <View style={{flex:1}}>
            <Text style={{color:'#FFFFFF', fontSize:13, fontWeight:'700'}} numberOfLines={1}>{name}</Text>
            <Text style={{color:'#7E8AA6', fontSize:10}} numberOfLines={1}>In your contacts</Text>
          </View>
        </TouchableOpacity>
      );
    }
    const c = item.c;
    const name = c.name ?? c.peer?.userId ?? c.id ?? '—';
    const isGroup = c.type === 'group';
    return (
      <TouchableOpacity
        style={{flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingVertical:10}}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Send to ${name}`}
        onPress={() => onPick(c.id)}>
        {/* A group has no single owner, so it keeps the initials disc; a 1:1
            shows the peer's profile photo when there is one (client
            2026-08-22). */}
        {isGroup ? initialsDisc(name) : <UserAvatar userId={c.peer?.userId} size={36} fallback={initialsDisc(name)} />}
        <View style={{flex:1}}>
          <Text style={{color:'#FFFFFF', fontSize:13, fontWeight:'700'}} numberOfLines={1}>{name}</Text>
          <Text style={{color:'#7E8AA6', fontSize:10}} numberOfLines={1}>{c.last_message?.content ?? 'No messages yet'}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View>
      {/* Founder 2026-08-24 — find a contact/group without scrolling. */}
      <View style={{paddingHorizontal: 16, paddingTop: 10}}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search contacts and groups…"
          placeholderTextColor="rgba(180,188,204,0.45)"
          accessibilityLabel="Search contacts and groups"
          style={{
            color: '#F2F4F8', fontSize: 13,
            paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
            backgroundColor: 'rgba(255,255,255,0.05)',
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
          }}
        />
      </View>
      <FlatList
        style={{maxHeight: 360}}
        data={items}
        keyExtractor={pickerItemKey}
        renderItem={renderPickerItem}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        initialNumToRender={14}
        maxToRenderPerBatch={16}
        windowSize={7}
        ListEmptyComponent={q ? (
          <View style={{paddingVertical: 20, alignItems: 'center'}}>
            <Text style={{color:'#B8C7E0', fontSize:12}}>No matches for “{query.trim()}”.</Text>
          </View>
        ) : null}
      />
    </View>
  );
}

// Why: previewForReply moved to chatScreenLogic (pure, node-testable);
// re-exported so DepartmentChatScreen's existing import keeps working.
export {previewForReply};

function initials(name?: string): string {
  // N-07 — a notification-tap deep-link could omit `name`; `undefined.split`
  // threw a render-time TypeError caught by the screen boundary ("Chat hit an
  // error"). Guard so a missing name degrades to '?' instead of crashing.
  if (!name) {return '?';}
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map(s => s[0] ?? '')
    .join('')
    .toUpperCase() || '?';
}

// sameDay/formatDaySep moved to chatListItems.ts (MX-05) — the day
// interleave is built there so it stays unit-testable.

function formatCallDuration(seconds: number): string {
  if (seconds <= 0) {return '';}
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) {return `${s}s`;}
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function CallRecordRow({msg, onPress, peerName}: {
  msg: LocalMessage;
  onPress: () => void;
  peerName: string;
}) {
  const meta = msg.call_meta!;
  const isGroupCall = meta.groupCall === true;
  const time = new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  // Direction line — "You → Papai" for outgoing, "Papai → You" for
  // incoming. Mirrors WhatsApp's call-log row + makes the chat record
  // self-explanatory even without the icon. For group calls we show
  // "You" → "<group name>" because there's no single peer.
  const fromLabel = meta.direction === 'outgoing' ? 'You'      : peerName;
  const toLabel   = meta.direction === 'outgoing' ? peerName    : 'You';
  // Icon + tint encode direction × outcome at a glance:
  //   answered outgoing → phone-outgoing (green)
  //   answered incoming → phone-incoming (green)
  //   missed   incoming → phone-missed   (red)
  //   declined incoming → phone-cancel   (slate) — you tapped Decline
  //   declined outgoing → phone-cancel   (slate) — peer hung up
  //   failed             → phone-alert   (amber)
  const {icon, tint} = (() => {
    if (meta.outcome === 'failed')        {return {icon: 'phone-alert',     tint: '#F59E0B'};}
    if (meta.outcome === 'missed')        {return {icon: 'phone-missed',    tint: '#EF4444'};}
    if (meta.outcome === 'declined')      {return {icon: 'phone-cancel',    tint: '#94A3B8'};}
    if (meta.outcome === 'ended-by-host') {return {icon: 'phone-hangup',    tint: '#94A3B8'};}
    return meta.direction === 'outgoing'
      ? {icon: 'phone-outgoing', tint: '#10B981'}
      : {icon: 'phone-incoming', tint: '#10B981'};
  })();
  const label = (() => {
    const prefix = isGroupCall ? 'Group ' : '';
    if (meta.outcome === 'missed')        {return meta.kind === 'video' ? `Missed ${prefix.toLowerCase()}video call` : `Missed ${prefix.toLowerCase()}voice call`;}
    if (meta.outcome === 'declined')      {return meta.kind === 'video' ? `${prefix}Video call declined` : `${prefix}Voice call declined`;}
    if (meta.outcome === 'failed')        {return `${prefix}Call failed`;}
    if (meta.outcome === 'ended-by-host') {return `${prefix.trim() || 'Call'} ended by host`;}
    return meta.kind === 'video' ? `${prefix}Video call` : `${prefix}Voice call`;
  })();
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={[styles.callRow, meta.outcome === 'missed' && styles.callRowMissed]}>
      <View style={[styles.callIconWrap, {borderColor: tint, backgroundColor: `${tint}14`}]}>
        <Icon name={icon as React.ComponentProps<typeof Icon>['name']} size={20} color={tint} />
      </View>
      <View style={{flex: 1}}>
        <Text style={styles.callRowLabel}>{label}</Text>
        <View style={styles.callRowDirection}>
          <Text style={styles.callRowDirectionText}>{fromLabel}</Text>
          <Icon name="arrow-right" size={12} color={DM.textMute} />
          <Text style={styles.callRowDirectionText}>{toLabel}</Text>
        </View>
        <Text style={styles.callRowMeta}>
          {time}
          {/* B-59 defence-in-depth: an ANSWERED call always renders a
              duration (0:00 when it connected but logged zero seconds)
              rather than suppressing the slot — a blank length can't then
              be confused with the timestamp. Missed/declined/failed rows
              never connected, so they keep no duration. */}
          {meta.outcome !== 'missed' && meta.outcome !== 'declined' && meta.outcome !== 'failed'
            && ` · ${meta.duration > 0 ? formatCallDuration(meta.duration) : '0:00'}`}
        </Text>
      </View>
      <View style={styles.callBackBtn}>
        <Icon
          name={isGroupCall
            ? (meta.kind === 'video' ? 'video-account' : 'account-multiple')
            : (meta.kind === 'video' ? 'video-outline' : 'phone-outline')}
          size={17}
          color={DM.onAccent}
        />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor: CHAT_BG},
  flex: {flex:1},

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 18, paddingTop: 10, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: Bravo.hair,
  },
  headerLeft: {flexDirection:'row', alignItems:'center', gap:8},
  // B-661 — backBtn and iconBtn are ONE size (34) and one radius (11), the
  // same header-pill system MessengerHome uses. They were 36/r12 and 40/r20
  // with 18/16/17pt glyphs: three sizes in a single row, and the two 40s ate
  // 88dp before the name got any. Shrinking them is what buys the name room.
  backBtn: {
    width: 34, height: 34, borderRadius: 11,
    backgroundColor: DM.glassFill,
    borderWidth: 1, borderColor: DM.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  contactInfo: {flexDirection:'row', alignItems:'center', gap: 12, flex: 1, minWidth: 0},
  avatarWrap: {position:'relative'},
  // Premium double-ring avatar treatment from Bravo Chat Premium —
  // solid bg ring + outer cyan-glow ring against the navy header.
  avatarGlowOuter: {
    padding: 1,
    borderRadius: 999,
    backgroundColor: Bravo.glowSoft,
  },
  avatarGlowInner: {
    padding: 2,
    borderRadius: 999,
    backgroundColor: CHAT_BG,
  },
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#7C3AED',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: {fontFamily: BravoFont.display, color: '#FFF', fontSize: 14, fontWeight: '700'},
  // Cyan-shadowed online dot — matches premium "● Online · last seen now" cue.
  onlineDot: {
    position:'absolute', bottom:0, right:0, width:11, height:11, borderRadius:5.5,
    backgroundColor: Bravo.signal, borderWidth:2, borderColor: CHAT_BG,
    shadowColor: Bravo.signal, shadowOpacity: 0.85, shadowRadius: 4, shadowOffset: {width:0, height:0},
    elevation: 4,
  },
  nameRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  contactName: {fontFamily: BravoFont.display, color: Bravo.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2, flexShrink: 1},
  handleBadge: {fontFamily: BravoFont.mono, color: Bravo.textMute, fontSize: 9.5, letterSpacing: 0.4, textTransform: 'uppercase'},
  onlineStatus: {color: Bravo.signal, fontSize: 10, fontWeight: '700', letterSpacing: 1.6},
  // Last-seen / presence row — sits below the contact name. Premium
  // treatment: 6px dot with a subtle glow halo + sentence-case
  // text in textDim (not muted) so "Online" / "Last seen 5m ago"
  // reads as primary metadata, not buried fine print.
  presenceRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3, flexShrink: 1, minWidth: 0},
  presenceDot: {
    width: 7, height: 7, borderRadius: 3.5,
    shadowOffset: {width: 0, height: 0}, shadowOpacity: 0.7, shadowRadius: 4,
    elevation: 3,
  },
  presenceText: {fontFamily: BravoFont.medium, color: Bravo.textDim, fontSize: 11, fontWeight: '500', letterSpacing: 0.1},
  headerActions: {flexDirection: 'row', gap: 8, flexShrink: 0},
  // Header voice/video pills — premium uses a soft glow-tinted fill
  // with a 1px ring, color-matched to the cyan accent so the whole
  // header reads as one cohesive system rather than the previous
  // muted gray buttons.
  iconBtn: {
    width: 34, height: 34, borderRadius: 11,
    backgroundColor: DM.glassFill,
    borderWidth: 1, borderColor: DM.hair2,
    alignItems: 'center', justifyContent: 'center',
  },

  bannersStack: {paddingHorizontal: 14, paddingTop: 6, paddingBottom: 8, gap: 6},
  e2eBanner: {flexDirection:'row', alignItems:'center', justifyContent:'center', gap:6, paddingVertical:8, borderBottomWidth:1, borderBottomColor: DM.hair},
  e2eText: {color:'#4ade80', fontSize:10, fontWeight:'800', letterSpacing:2},

  devBanner: {flexDirection:'row', alignItems:'center', justifyContent:'center', gap:6, paddingVertical:6, paddingHorizontal:12, backgroundColor:'rgba(251, 191, 36, 0.08)', borderBottomWidth:1, borderBottomColor:'rgba(251, 191, 36, 0.25)'},
  devBannerError: {backgroundColor:'rgba(248, 113, 113, 0.1)', borderBottomColor:'rgba(248, 113, 113, 0.3)'},
  devBannerHidden: {height:0, paddingVertical:0, borderBottomWidth:0, overflow:'hidden'},
  devBannerText: {color:'#fbbf24', fontSize:10, fontWeight:'700', letterSpacing:1, flexShrink:1},

  msgList: {flex:1},
  // Inverted list: coordinate paddingBottom = VISUAL TOP (below the
  // header); the visual-bottom gap comes from the ListHeaderComponent
  // spacer. flexGrow keeps short threads hugging the composer.
  msgContent: {paddingHorizontal:16, paddingBottom:16, flexGrow:1},
  dateSep: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, marginBottom: 16, marginTop: 4},
  dateLine: {flex: 1, height: 1, backgroundColor: Bravo.hair},
  dateText: {fontFamily: BravoFont.mono, color: Bravo.textMute, fontSize: 9.5, letterSpacing: 1.3, textTransform: 'uppercase'},
  // Unread "N UNREAD MESSAGES" divider — accent-tinted line + pill so
  // the user's eye lands where they left off. Anchored once, never
  // re-positions while the chat is open.
  unreadSep: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, marginBottom: 10, marginTop: 4},
  unreadLine: {flex: 1, height: 1, backgroundColor: 'rgba(91,141,239,0.35)'},
  unreadPill: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99,
    backgroundColor: 'rgba(91,141,239,0.12)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
  },
  unreadPillText: {
    fontFamily: BravoFont.mono, color: DM.accent,
    fontSize: 9.5, letterSpacing: 1.4, fontWeight: '700',
  },
  // Failed-send retry pill — only renders when status === 'failed'.
  // Larger hit target than a bare 15-dp icon; flush against the meta
  // row so it doesn't break the bubble layout.
  retryChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99,
    backgroundColor: 'rgba(239,68,68,0.12)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)',
  },
  retryChipText: {
    fontFamily: BravoFont.mono, color: Bravo.alert,
    fontSize: 9.5, letterSpacing: 1, fontWeight: '700',
    textTransform: 'uppercase',
  },

  emptyWrap: {alignItems:'center', paddingVertical:40, gap:8},
  emptyText: {color:'#7E8AA6', fontSize:12, fontWeight:'700', letterSpacing:1, textTransform:'uppercase'},
  emptyHint: {color:'#7E8AA6', fontSize:11, textAlign:'center', maxWidth:280, lineHeight:16},

  msgWrap: {alignItems:'flex-start', marginBottom:12, maxWidth:'78%', minWidth:68},
  msgWrapSent: {alignSelf:'flex-end', alignItems:'flex-end'},
  // Inside a run of consecutive same-sender bubbles: keep them visually
  // tight (small gap) but do NOT use a negative top margin — that was
  // pulling adjacent bubbles into each other and clipping the rounded
  // corners on stacked runs (user-reported "bubbles stuck together").
  msgWrapGrouped: {marginTop:2, marginBottom:4},
  // Reply-jump highlight ring. Absolutely positioned UNDER the bubble on
  // its own node (see the crash note where it's rendered) with negative
  // insets so the cobalt tint reads as a glow ring around the message.
  pulseHalo: {position:'absolute', top:-4, bottom:-4, left:-8, right:-8, borderRadius:26},
  // `minHeight` + `justifyContent:'center'` were vertically clipping
  // multi-line text on narrow phones because `minHeight` was treated
  // as a fixed centre-anchored box. Drop both — RN auto-sizes height
  // from content, and the meta row sits OUTSIDE the bubble anyway.
  bubble: {borderRadius: 22, paddingHorizontal: 16, paddingVertical: 12},
  // Premium me-bubble: 22 / 6 corners (softer, more WhatsApp-like),
  // action-blue fill with a layered glow shadow. The shadow opacity
  // was bumped from 0.45 → 0.5 and offset Y nudged to 8 to make the
  // bubble feel "lit from below" against the deep-navy backdrop.
  sentBubble: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22, borderBottomLeftRadius: 22, borderBottomRightRadius: 6,
    // Solid cobalt base under the gradient fill: keeps the iOS glow shadow
    // (needs an opaque backing) and is the fallback if the background-image
    // gradient does not paint.
    backgroundColor: DM.accentDeep,
    shadowColor: DM.accent, shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: {width: 0, height: 8},
    elevation: 5,
  },
  // B-279 — the outgoing/incoming bubble gradients, top→bottom, as the view's
  // own background rather than an absolutely-positioned child. Same stops as
  // the SENT_GRADIENT / RECV_GRADIENT arrays the `<LinearGradient>` used, so
  // the thread is pixel-identical; it just mounts half as many native views.
  // Split out from sentBubble/recvBubble because IMAGE bubbles must keep the
  // flat fill (the photo covers it; only the padding ring would show).
  // B-285 — the `0%` / `100%` stop positions are REQUIRED here, not decoration.
  // Omitting them is valid CSS and renders identically, but RN's Android parser
  // (`style/LinearGradient.kt:65`) calls `LengthPercentage.setFromDynamic` on each
  // stop's `position`, and a missing one takes the `else ->` branch and logs
  // "Unsupported type for radius property: Null" — once per stop, per bubble, per
  // commit. Measured on device: 0 warnings before this change, 260 in ~50s after,
  // bursting 26-34 per second. Stating the positions makes the parser take the
  // numeric branch and the log goes quiet.
  sentBubbleFill: {
    experimental_backgroundImage: `linear-gradient(to bottom, ${SENT_GRADIENT[0]} 0%, ${SENT_GRADIENT[1]} 100%)`,
  },
  recvBubbleFill: {
    experimental_backgroundImage: `linear-gradient(to bottom, ${RECV_GRADIENT[0]} 0%, ${RECV_GRADIENT[1]} 100%)`,
  },
  sentBubbleRunMid:  {borderTopRightRadius: 6, borderBottomRightRadius: 6},
  sentBubbleRunTail: {borderTopRightRadius: 6},
  // Premium them-bubble: surface-2 navy with a 1px hairline border
  // and a subtle shadow so it doesn't feel flat next to the glowing
  // sent bubble. Symmetrical 22 / 6 to match the sent variant.
  recvBubble: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22, borderBottomLeftRadius: 6, borderBottomRightRadius: 22,
    // Obsidian receive bubble with a white hairline (Bravo DM Attach). Opaque
    // base under the gradient fill, same role as the sent side's.
    backgroundColor: DM.recvBubble,
    borderWidth: 1, borderColor: DM.hair2,
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: {width: 0, height: 4},
    elevation: 2,
  },
  recvBubbleRunMid:  {borderTopLeftRadius: 6, borderBottomLeftRadius: 6},
  recvBubbleRunTail: {borderTopLeftRadius: 6},
  msgText: {fontFamily: BravoFont.sans, color: Bravo.text, fontSize: 14.5, lineHeight: 20.5, letterSpacing: -0.1},
  groupSender: {fontFamily: BravoFont.mono, fontSize: 10, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4, marginLeft: 4, color: DM.onAccent},
  // B-661 — the group header subtitle row. Its siblings (the name above, the
  // call pills beside it) already shrink; this one did not, so on a narrow
  // phone — or any phone at fontScale 1.3 — "N operators · E2E" ran past the
  // header actions instead of yielding, which is the text that read as
  // overlapping. The 1:1 pill (PeerPresence) has had this since it was written.
  memberStackRow: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0},
  memberDot: {width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: CHAT_BG},
  memberStackText: {fontFamily: BravoFont.mono, fontSize: 10, color: Bravo.textMute, letterSpacing: 0.4, marginLeft: 2, flexShrink: 1},
  memberStackE2e: {fontFamily: BravoFont.mono, fontSize: 10, color: Bravo.signal, fontWeight: '700', letterSpacing: 0.6, flexShrink: 0},
  // Meta row sits OUTSIDE the bubble — small timestamp + ack ticks.
  // Uses textMute (token) instead of an rgba opacity trick so the
  // hierarchy is consistent with the rest of the app.
  msgMeta: {flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, alignSelf: 'flex-end', paddingHorizontal: 6},
  msgMetaIn: {alignSelf: 'flex-start'},
  msgTime: {fontFamily: BravoFont.mono, color: Bravo.textMute, fontSize: 10, letterSpacing: 0.4, fontVariant: ['tabular-nums']},
  msgFingerprint: {fontFamily: BravoFont.mono, color: Bravo.textFaint, fontSize: 8.5, letterSpacing: 0.5},
  // Self-destruct accent — uses Bravo.amber (warning token) instead
  // of off-palette orange so it slots into the system color scheme.
  selfDestructBubble: {borderLeftWidth: 2, borderLeftColor: Bravo.amber},
  timerBadge: {flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 4},
  timerText: {fontFamily: BravoFont.semiBold, color: Bravo.amber, fontSize: 10, fontWeight: '700'},

  // Premium call-record card — surface-2 navy with hairline border
  // and a soft drop-shadow, matching the bubble depth treatment.
  // Centered between bubbles, comfortable padding for the icon +
  // 3-line content (label, direction, duration).
  callRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    alignSelf: 'stretch',
    marginHorizontal: 8, marginVertical: 8,
    paddingVertical: 14, paddingHorizontal: 15,
    borderRadius: 18,
    backgroundColor: DM.recvBubble,
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.14)',
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: {width: 0, height: 4},
    elevation: 2,
  },
  callRowMissed: {borderColor: 'rgba(255,93,93,0.16)'},
  callIconWrap: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },
  callRowLabel: {fontFamily: BravoFont.display, color: DM.text, fontSize: 15, fontWeight: '700', letterSpacing: -0.2},
  callRowDirection: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3},
  callRowDirectionText: {fontFamily: BravoFont.sans, color: DM.textMute, fontSize: 12.5, fontWeight: '500'},
  callRowMeta:  {fontFamily: BravoFont.mono, color: DM.textFaint, fontSize: 11, marginTop: 3, letterSpacing: 0.3},
  // Round cobalt call-back button on the trailing edge of the call card.
  callBackBtn: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: DM.accentTint, borderWidth: 1, borderColor: DM.accentEdge,
  },

  inputBar: {flexDirection:'row', alignItems:'center', gap:9, paddingHorizontal:16, paddingTop:6, backgroundColor:CHAT_BG, borderTopWidth:1, borderTopColor: DM.hair2},
  inputIconBtn: {width:36, height:36, alignItems:'center', justifyContent:'center'},
  inputIconBtnActive: {backgroundColor:'rgba(255,193,7,0.1)', borderRadius:18},
  ttlBadge: {position:'absolute', bottom:2, color:Bravo.amber, fontSize:9, fontWeight:'700'},
  // Round cobalt-tinted "+" attach affordance (Bravo DM Attach).
  attachBtn: {width:40, height:40, borderRadius:20, alignItems:'center', justifyContent:'center', backgroundColor: DM.accentTint, borderWidth:1, borderColor: DM.accentEdge},
  // Composer dock pill — glass fill on obsidian, white hairline.
  //
  // radius 20, NOT 99. A stadium radius is identical at one line (the box is
  // ~38dp tall) but once the text wraps to five or six lines the end-caps
  // become huge semicircles while the text keeps its flat 14dp inset — so the
  // text visually escapes the capsule at the corners. 20 is still a pill on a
  // single line and degrades into a WhatsApp-style rounded rectangle as it
  // grows. Same value DepartmentChatScreen's inputPill already used.
  //
  // flex-end so the emoji button stays anchored to the bottom of a growing
  // box instead of floating in its vertical middle.
  inputWrap: {flex:1, flexDirection:'row', alignItems:'flex-end', backgroundColor: DM.glassFill, borderRadius:20, paddingHorizontal:14, paddingVertical:8, maxHeight:116, borderWidth:1, borderColor: DM.hair2, gap:8},
  // maxHeight caps it at ~5 lines and the TextInput scrolls internally past
  // that; lineHeight is explicit so the cap is a whole number of lines rather
  // than a clipped half-line.
  input: {flex:1, color:'#FFFFFF', fontSize:13, lineHeight:18, maxHeight:90, padding:0},
  // Primary actions (send + mic) share one cobalt-gradient hero treatment so
  // the in-place swap on typing reads as one continuous button, not a
  // gradient→flat downgrade. Opaque cobalt base keeps the iOS glow shadow.
  sendBtn: {width:38, height:38, borderRadius:19, alignItems:'center', justifyContent:'center', borderWidth:1, borderColor:'rgba(255,255,255,0.22)', backgroundColor: DM.accentDeep, shadowColor: DM.accent, shadowOffset:{width:0,height:4}, shadowOpacity:0.55, shadowRadius:12, elevation:6},
  micBtn:  {width:38, height:38, borderRadius:19, alignItems:'center', justifyContent:'center', borderWidth:1, borderColor:'rgba(255,255,255,0.22)', backgroundColor: DM.accentDeep, shadowColor: DM.accent, shadowOffset:{width:0,height:4}, shadowOpacity:0.55, shadowRadius:12, elevation:6},
  // B-282 — the "who reacted" roster. Capped height so a heavily-reacted message
  // scrolls instead of pushing the sheet past the viewport.
  reactorScroll: {maxHeight: 320, marginTop: 4},
  reactorRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: DM.hair,
  },
  reactorEmoji: {fontSize: 22},
  // minWidth:0 + flexShrink so a 40-char display name ellipsises instead of
  // shoving the "you" hint off the row (DESIGN_REVIEW_LOOP §3.2).
  reactorName: {
    flex: 1, minWidth: 0, flexShrink: 1,
    fontFamily: BravoFont.medium, color: DM.text, fontSize: 14.5,
  },
  reactorHint: {
    fontFamily: BravoFont.mono, color: DM.textMute, fontSize: 9.5,
    letterSpacing: 0.4, flexShrink: 0,
  },
  micGradient: {borderRadius:19},
  // B-281 — the inline emoji keyboard's container. A hairline on top separates it
  // from the input bar; the fill matches the composer surface so the panel reads
  // as part of the composer rather than a floating sheet.
  emojiPanel: {
    backgroundColor: '#0C1018',
    borderTopWidth: 1, borderTopColor: DM.hair,
    overflow: 'hidden',
  },
  // Disabled mic — slate fill + crossed-out icon so it reads as
  // "feature not yet shipped" rather than "tap to record".
  micBtnDisabled: {
    backgroundColor: 'rgba(71,85,105,0.25)',
    shadowOpacity: 0,
    elevation: 0,
    borderWidth: 1, borderColor: 'rgba(71,85,105,0.45)',
  },

  // Bubble inner + reply + reactions
  bubbleInner: {flexShrink: 1},
  // Premium "stitched" reply quote — translucent box that visually
  // fuses with the parent bubble (negative bottom margin). The
  // received variant uses a deeper navy + cyan accent bar; the sent
  // variant uses a white-tinted overlay + white accent bar so it
  // reads as "contained within" the blue bubble instead of looking
  // like a foreign element.
  // Quoted-reply preview inside a bubble (Bravo DM Attach "QuoteInBubble").
  // Tapping it jumps to + pulses the original message. A cobalt left bar +
  // tinted fill on the received side; a white-on-cobalt treatment on the
  // sent side so it reads as "contained within" the outgoing gradient.
  replyStrip: {
    flexDirection:'row', alignItems:'stretch',
    paddingHorizontal:10, paddingVertical:7,
    marginBottom: 7, borderRadius:12, overflow:'hidden',
    backgroundColor: DM.accentTint,
    borderLeftWidth: 3, borderLeftColor: DM.quoteBar,
  },
  replyStripSent: {
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderLeftColor: 'rgba(255, 255, 255, 0.6)',
  },
  /**
   * `flexShrink: 1`, NOT `flex: 1`.
   *
   * `flex: 1` is shorthand for `flexGrow:1; flexShrink:1; flexBasis:0%`, and
   * that `flexBasis: 0%` is the bug: it tells Yoga this column has no intrinsic
   * width, so the quote contributes NOTHING to how wide the bubble wants to be.
   * The bubble then sizes to the reply BODY instead — and a two-word reply
   * ("Ok") to a long quoted message collapsed the strip into a one-character-
   * wide vertical sliver that stretched the bubble down the screen.
   *
   * `flexShrink: 1` keeps the shrink-to-fit behaviour (so a long quote still
   * truncates at `numberOfLines={2}` inside the 78% bubble cap) while letting
   * the quote's real width drive the bubble, which is what makes a short reply
   * to a long message render at a sensible size.
   *
   * `minWidth: 0` stays — it is what allows the text to ellipsize rather than
   * force overflow once the 78% cap is hit.
   */
  replyBody:    {flexShrink:1, minWidth:0},
  replyAuthor:     {fontFamily: BravoFont.semiBold, color: DM.onAccent, fontSize: 11, fontWeight: '700', marginBottom: 1, letterSpacing: 0.1},
  replyAuthorSent: {color: 'rgba(255,255,255,0.9)'},
  replyStripText:  {fontFamily: BravoFont.sans, color: DM.textDim, fontSize: 12.5, lineHeight: 16},
  replyStripTextSent: {color: 'rgba(255, 255, 255, 0.75)'},
  // Reactions sit BETWEEN the bubble and the meta row (never overlap the
  // timestamp/ticks — a negative marginTop used to shove them up into the
  // meta row on sent messages). Obsidian chip to match DepartmentChatScreen.
  reactionsRow: {flexDirection:'row', gap:4, marginTop:3, marginHorizontal:6, flexWrap:'wrap'},
  reactionChip: {flexDirection:'row', alignItems:'center', gap:3, paddingHorizontal:7, paddingVertical:3, borderRadius:10, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth:1, borderColor: DM.hair2},
  reactionChipMine: {backgroundColor: 'rgba(91,141,239,0.12)', borderColor: 'rgba(91,141,239,0.4)'},
  reactionEmoji: {fontSize:13},
  reactionCount: {color: DM.textDim, fontSize:10, fontWeight:'700'},

  // Reply preview bar (composer) — sits above the input pill when the
  // user taps "reply" on a message. Premium treatment: surface-2 fill
  // with a thin accent bar on the LEFT and a subtle backdrop tint so
  // it reads as a "scrap" of the original message before you type.
  replyBar: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8,
    marginHorizontal: 4, marginTop: 4,
    borderLeftWidth: 3, borderLeftColor: DM.quoteBar,
  },
  replyBarBody: {flex:1, minWidth:0},
  replyBarLabel: {fontFamily: BravoFont.semiBold, color: DM.onAccent, fontSize: 12.5, fontWeight: '700', letterSpacing: 0.2},
  replyBarText:  {fontFamily: BravoFont.sans, color: DM.textDim, fontSize: 12.5, marginTop: 2},
  // Round close chip on the composer reply bar.
  replyBarClose: {width:26, height:26, borderRadius:13, alignItems:'center', justifyContent:'center', backgroundColor:'rgba(255,255,255,0.06)'},

  // Edit-mode banner — same geometry as replyBar so the two composer modes
  // read as one system, with the accent bar in cobalt rather than the quote
  // grey to distinguish "changing this message" from "quoting it".
  editBar: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8,
    marginHorizontal: 4, marginTop: 4,
    borderLeftWidth: 3, borderLeftColor: DM.accent,
  },
  editBarBody:  {flex: 1, minWidth: 0},
  editBarTitle: {fontFamily: BravoFont.semiBold, color: DM.onAccent, fontSize: 12.5, fontWeight: '700', letterSpacing: 0.2},
  editBarHint:  {fontFamily: BravoFont.sans, color: DM.textDim, fontSize: 12.5, marginTop: 2},
  editBarClose: {width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)'},

  // "edited" marker in the meta row. Deliberately quieter than the timestamp
  // beside it — it is a footnote, not a status.
  editedTag: {fontFamily: BravoFont.sans, color: Bravo.textFaint, fontSize: 10, fontStyle: 'italic', letterSpacing: 0.2},
  // F-3 (B-693) — same muted voice as editedTag: a whisper, not an alert.
  retryingTag: {fontFamily: BravoFont.sans, color: Bravo.textFaint, fontSize: 10, fontStyle: 'italic', letterSpacing: 0.2},

  // "Deleted for everyone" tombstone inside the bubble.
  deletedRow:      {flexDirection: 'row', alignItems: 'center', gap: 6},
  deletedText:     {fontFamily: BravoFont.sans, color: DM.textMute, fontSize: 14, fontStyle: 'italic'},
  deletedTextSent: {color: 'rgba(255,255,255,0.7)'},

  // MM-09 — "Forwarded" chip, same quiet-italic treatment as the tombstone.
  forwardedRow:      {flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2},
  forwardedText:     {fontFamily: BravoFont.sans, color: DM.textMute, fontSize: 12, fontStyle: 'italic'},
  forwardedTextSent: {color: 'rgba(255,255,255,0.5)'},

  // @-mention picker above the composer. maxHeight caps it at ~4 rows so a
  // 30-member channel cannot push the input off-screen; the inner ScrollView
  // reaches the rest.
  mentionSheet: {
    marginHorizontal: 8, marginBottom: 6,
    borderRadius: 14, overflow: 'hidden',
    backgroundColor: '#0C1018',
    borderWidth: 1, borderColor: DM.hair2,
  },
  mentionScroll:     {maxHeight: 208},
  // 52 tall — comfortably over the 48dp Android minimum touch target.
  mentionRow:        {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 52, paddingVertical: 8},
  mentionAvatar:     {width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(91,141,239,0.16)', alignItems: 'center', justifyContent: 'center'},
  mentionAvatarText: {fontFamily: BravoFont.semiBold, color: DM.accent, fontSize: 11, fontWeight: '700'},
  mentionName:       {flex: 1, minWidth: 0, fontFamily: BravoFont.sans, color: DM.onAccent, fontSize: 14},

  // Scroll-to-bottom FAB
  scrollFab: {position:'absolute', right:12, width:44, height:44, borderRadius:22, backgroundColor:'#0C1018', borderWidth:1, borderColor: DM.hair2, alignItems:'center', justifyContent:'center', shadowColor:'#000', shadowOffset:{width:0,height:4}, shadowOpacity:0.4, shadowRadius:8, elevation:6},
  scrollFabBadge: {position:'absolute', top:-4, right:-4, minWidth:18, minHeight:18, borderRadius:9, paddingHorizontal:4, paddingVertical:1, backgroundColor:DM.accent, alignItems:'center', justifyContent:'center'},
  scrollFabBadgeText: {color:'#FFF', fontSize:9, fontWeight:'800'},

  // Long-press action sheet
  actionSheet: {paddingBottom: 12},
  actionReactRow: {flexDirection:'row', gap:10, paddingHorizontal:20, paddingVertical:14, justifyContent:'center'},
  actionReactBtn: {width:44, height:44, borderRadius:22, backgroundColor:'rgba(255,255,255,0.04)', alignItems:'center', justifyContent:'center', borderWidth:1, borderColor: DM.hair2},
  actionReactBtnMine: {borderColor:'rgba(91,141,239,0.5)', backgroundColor:'rgba(91,141,239,0.22)'},
  actionReactEmoji: {fontSize:20},
  actionDivider: {height:1, backgroundColor: DM.hair, marginHorizontal:16},

  sheetBackdrop: {flex:1, backgroundColor:'rgba(0,0,0,0.6)', justifyContent:'flex-end'},
  // Obsidian bottom sheet (synced with DepartmentChatScreen #0C1018) — the
  // long-press action menu + "Read by" info + forward picker all share this.
  sheet: {backgroundColor:'#0C1018', borderTopLeftRadius:20, borderTopRightRadius:20, padding:20, borderTopWidth:1, borderColor: DM.hair2, gap:2},
  sheetTitle: {color: DM.text, fontSize:16, fontWeight:'700', marginBottom:4},
  sheetSub: {color: DM.textMute, fontSize:12, marginBottom:12},
  sheetRow: {flexDirection:'row', alignItems:'center', gap:14, paddingVertical:14, borderBottomWidth:1, borderBottomColor: DM.hair},
  sheetRowText: {color: DM.text, fontSize:15},
  // Visually-disabled attach row: dims the icon + label and surfaces a
  // "Coming soon" subtitle so the user reads the constraint BEFORE
  // tapping (vs. opening a picker that ends in an alert).
  sheetRowDisabled: {opacity: 0.6},
  sheetRowTextDisabled: {color: '#7E8AA6'},
  sheetRowSubtitle: {
    fontFamily: BravoFont.mono, color: '#7E8AA6',
    fontSize: 9.5, letterSpacing: 1.2, textTransform: 'uppercase', marginTop: 2,
  },
  // Cancel / Close is NEUTRAL, not destructive — no red tint (matches the
  // obsidian DepartmentChatScreen sheet).
  sheetCancel: {marginTop:6, paddingVertical:14, alignItems:'center'},
  sheetCancelText: {color: DM.textDim, fontSize:14, fontWeight:'600'},

  // ── Attach sheet (Bravo DM Attach) — gradient sheet on a scrim with an
  //    encryption badge, rounded-square cobalt row icons + chevrons. ──
  attachSheet: {
    borderTopLeftRadius: 30, borderTopRightRadius: 30,
    paddingHorizontal: 22, paddingTop: 10, paddingBottom: 30,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(255,255,255,0.08)',
  },
  attachHandle: {width: 42, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.16)', alignSelf: 'center', marginBottom: 18},
  attachHeader: {flexDirection: 'row', alignItems: 'center', marginBottom: 6},
  attachTitle: {fontFamily: BravoFont.display, color: DM.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.4, flex: 1},
  encBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999,
    backgroundColor: DM.signalTint, borderWidth: 1, borderColor: DM.signalEdge,
  },
  encBadgeText: {fontFamily: BravoFont.mono, color: DM.signal, fontSize: 9, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase'},
  attachRow: {
    flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 15,
    borderBottomWidth: 1, borderBottomColor: DM.hair,
  },
  attachRowLast: {borderBottomWidth: 0},
  attachRowIcon: {
    width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: DM.accentTint, borderWidth: 1, borderColor: DM.accentEdge,
  },
  attachRowTitle: {fontFamily: BravoFont.display, color: DM.text, fontSize: 16.5, fontWeight: '700', letterSpacing: -0.3},
  attachRowSub: {fontFamily: BravoFont.mono, color: DM.textMute, fontSize: 9.5, fontWeight: '500', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 4},
  attachCancel: {
    height: 52, marginTop: 16, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: DM.hair2,
  },
  attachCancelText: {fontFamily: BravoFont.display, color: DM.textDim, fontSize: 15.5, fontWeight: '700'},

  imageBubble: {padding:3, maxWidth:260, overflow:'hidden'},
  msgImage: {width:254, height:254, borderRadius:12, backgroundColor:DM.recvBubble},
  // B-288 — album mosaic. Absolute boxes come from `albumTiles`; only the
  // radius, fill and overflow chrome live here.
  albumTile: {position:'absolute', borderRadius:8, overflow:'hidden', backgroundColor:DM.recvBubble},
  albumTileImg: {width:'100%', height:'100%'},
  albumTilePending: {alignItems:'center', justifyContent:'center'},
  albumOverflow: {
    ...StyleSheet.absoluteFillObject,
    alignItems:'center', justifyContent:'center',
    backgroundColor:'rgba(7,9,13,0.62)',
  },
  albumOverflowText: {color:'#FFF', fontSize:22, fontWeight:'800'},
  imageBrokenWrap: {alignItems:'center', justifyContent:'center', gap:6},
  imageBrokenText: {color:'#B8C7E0', fontSize:12, fontWeight:'500'},
  fileAttachRow: {flexDirection:'row', alignItems:'center', gap:10, paddingVertical:4, minWidth:200},
  fileAttachIcon: {width:40, height:40, borderRadius:20, backgroundColor:DM.accentTint, borderWidth:1, borderColor:DM.accentEdge, alignItems:'center', justifyContent:'center'},
  fileAttachName: {color:'#E8EEF7', fontSize:14, fontWeight:'600'},
  fileAttachSub: {color:'#9FB0C9', fontSize:11, marginTop:1},
  mediaSendingBar: {flexDirection:'row', alignItems:'center', gap:7, paddingHorizontal:16, paddingVertical:7, backgroundColor:DM.accentTint, borderTopWidth:1, borderTopColor:DM.accentEdge},
  mediaSendingText: {color:DM.textDim, fontSize:12, fontWeight:'600'},
  imageMetaShade: {
    position:'absolute', left:3, right:3, bottom:3, height:40,
    borderBottomLeftRadius:12, borderBottomRightRadius:12,
    backgroundColor:'rgba(0,0,0,0.45)',
  },
  imageMetaRow: {
    position:'absolute', right:10, bottom:10,
    flexDirection:'row', alignItems:'center', gap:6,
  },
  imageMetaTime: {color:'#B8C7E0', fontSize:10, fontWeight:'600'},
  msgMetaOverImage: {paddingHorizontal:6, paddingVertical:4},

  viewerRoot: {flex:1, backgroundColor:'rgba(0,0,0,0.95)', alignItems:'center', justifyContent:'center'},
  viewerClose: {position:'absolute', top:40, right:20, width:40, height:40, borderRadius:20, backgroundColor:'rgba(255,255,255,0.15)', alignItems:'center', justifyContent:'center'},
  viewerActionBar: {position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 20, paddingTop: 18, backgroundColor: 'rgba(6,20,43,0.85)', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)'},
  viewerAction: {alignItems: 'center', gap: 6, minWidth: 70},
  viewerActionIcon: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(251,191,36,0.1)', borderWidth: 1, borderColor: 'rgba(251,191,36,0.25)'},
  viewerActionText: {fontFamily: BravoFont.sans, color: '#FFF', fontSize: 10, fontWeight: '700', letterSpacing: 0.3},
}));
