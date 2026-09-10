import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  TextInput,
  ActivityIndicator,
  Platform,
  Modal,
  Pressable,
  Image,
  AppState, Animated, Keyboard, useWindowDimensions} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {EmojiKeyboard} from 'rn-emoji-keyboard';
import * as Clipboard from 'expo-clipboard';
import {launchCamera, launchImageLibrary} from 'react-native-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import {readUriBytes} from '@/modules/messenger/media';
import {MediaPreviewTray} from '@/modules/messenger/ui/MediaPreviewTray';
import {normalizePickedAssets, withBatchCaption, MAX_PICKED_ASSETS, type PickedAsset} from '@/modules/messenger/ui/pickedAssets';
import {haptics} from '@utils/haptics';
import {useNavigation, useRoute, useFocusEffect, useIsFocused, type RouteProp} from '@react-navigation/native';
import {BravoFont, Bravo} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useAuthStore} from '@store/authStore';
import {departmentApi} from '@services/api';
import {useMessengerStore, EMPTY_MESSAGES} from '@/modules/messenger/store/messengerStore';
import type {LocalMessage} from '@/modules/messenger/store';
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {AttachmentFileViewer, type AttachmentViewTarget} from '@/modules/messenger/ui/AttachmentFileViewer';
import type {MessengerStackParamList} from '@navigation/types';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {useActiveConversation} from '@hooks/useActiveConversation';
import {tickIcon} from '@/modules/messenger/runtime/tickIcon';
import {groupSendBlockedReason, GROUP_KEY_PENDING_SEND_ERROR} from '@/modules/messenger/runtime/messagingLogic';
import {appendChannelRenamedEvent, systemEventText} from '@/modules/messenger/runtime/groupEventMessage';
import {LinkPreviewCard} from '@/modules/messenger/ui/LinkPreviewCard';
// Reused, not reimplemented — the exact functions/component ChatScreen.tsx
// (the main 1:1/group chat) already uses for reactions, reply previews and
// the forward-target picker. One rule, one place, same as the tick mapping.
import {previewForReply, ForwardList} from './ChatScreen';
// B-282 — reaction folding moved to its own module so the node Jest project can
// import it (ChatScreen.tsx pulls in react-native and cannot be imported there).
import {groupReactions} from './reactionRoster';
import {colorForSender} from './senderColors';
import {
  PanGestureHandler,
  State as GestureState,
  type PanGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import {OB} from '@screens/deptchat/_obsidian';
import {goBackOnce} from '@navigation/tapGuard';

type Rt = RouteProp<MessengerStackParamList, 'DepartmentChat'>;
type IconName = React.ComponentProps<typeof Icon>['name'];

/** Drag distance that commits a reply. Same value ChatScreen uses. */
const SWIPE_REPLY_THRESHOLD = 60;

/** How long a server-confirmed channel role is trusted before a send re-checks it. */
const ROLE_FRESH_MS = 30_000;

/**
 * Swipe-to-reply, ported from ChatScreen so departmental chat behaves
 * identically. Its own component because the message list is a .map() — hooks
 * cannot live in a loop.
 *
 * Direction depends on WHOSE message it is (founder rule): swipe RIGHT to
 * reply to someone else, LEFT to reply to your own. The pull always drags the
 * bubble away from the edge it is anchored to, so it never fights the bubble's
 * own alignment.
 *
 * The gesture writes translationX straight into panX on the UI thread
 * (Animated.event + native driver); JS only hears END/CANCEL, to fire the
 * reply and spring home. The clamp pins the opposite direction at 0 so it can
 * never read as a delete gesture, and failOffsetY lets the ScrollView keep
 * vertical intent.
 *
 * `mine` is fixed for the life of a row (a message is mine or not, forever)
 * and rows are keyed by message id, so the create-once refs may capture it.
 */
function SwipeToReplyRow({mine, onReply, children}: {mine: boolean; onReply: () => void; children: React.ReactNode}) {
  const panX = useRef(new Animated.Value(0)).current;
  const onReplyRef = useRef(onReply);
  useEffect(() => { onReplyRef.current = onReply; }, [onReply]);
  const clamped = useRef(panX.interpolate({
    inputRange:  mine ? [-120, 0] : [0, 120],
    outputRange: mine ? [-120, 0] : [0, 120],
    extrapolate: 'clamp',
  })).current;
  const onGesture = useRef(Animated.event(
    [{nativeEvent: {translationX: panX}}], {useNativeDriver: true},
  )).current;
  const onStateChange = useRef((e: PanGestureHandlerStateChangeEvent) => {
    const {state, translationX} = e.nativeEvent;
    if (state === GestureState.BEGAN) { panX.stopAnimation(); return; }
    if (state === GestureState.END) {
      const pulled = mine
        ? translationX < -SWIPE_REPLY_THRESHOLD
        : translationX >  SWIPE_REPLY_THRESHOLD;
      if (pulled) { onReplyRef.current?.(); }
      Animated.spring(panX, {toValue: 0, useNativeDriver: true, tension: 90, friction: 8}).start();
    } else if (state === GestureState.CANCELLED || state === GestureState.FAILED) {
      Animated.spring(panX, {toValue: 0, useNativeDriver: true, tension: 90, friction: 8}).start();
    }
  }).current;
  return (
    <PanGestureHandler
      activeOffsetX={mine ? -16 : 16}
      failOffsetX={mine ? 16 : -16}
      failOffsetY={[-14, 14]}
      onGestureEvent={onGesture}
      onHandlerStateChange={onStateChange}>
      <Animated.View style={{transform: [{translateX: clamped}]}}>
        {children}
      </Animated.View>
    </PanGestureHandler>
  );
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {return '?';}
  if (parts.length === 1) {return parts[0].slice(0, 2).toUpperCase();}
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
}

function sameDay(a: string, b: string): boolean {
  const da = new Date(a); const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}
function dayLabel(iso: string): string {
  const now = new Date();
  if (sameDay(iso, now.toISOString())) {return 'Today';}
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(iso, y.toISOString())) {return 'Yesterday';}
  return new Date(iso).toLocaleDateString([], {day: '2-digit', month: 'short'});
}

// @mention + announcement (area 6). Both ride INSIDE the already-E2EE message body —
// the relay never sees plaintext, and we never log the parsed token/segments
// (logAudit). A mention is `@[Display Name](userId)`; an announcement is a body that
// leads with ANNOUNCE_PREFIX, styled distinctly + (for the recipient) a megaphone.
const MENTION_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;
const ANNOUNCE_PREFIX = '​📣 '; // zero-width guard so a user typing 📣 isn't mistaken for an announcement

// Discord-style slash commands. Typing "/" at the start of the composer opens this palette;
// extend the list to add more. `/announce` ties into the existing announcement broadcast.
type SlashCmd = {cmd: string; icon: string; desc: string};
const SLASH_COMMANDS: SlashCmd[] = [
  {cmd: '/announce', icon: 'bullhorn-variant', desc: 'Post as an announcement (📣 alerts everyone)'},
];

interface Segment {text?: string; mention?: string; userId?: string}
function parseSegments(body: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body)) !== null) {
    if (m.index > last) {out.push({text: body.slice(last, m.index)});}
    out.push({mention: m[1], userId: m[2]});
    last = m.index + m[0].length;
  }
  if (last < body.length) {out.push({text: body.slice(last)});}
  return out;
}

// The composer shows plain "@Name" — never the wire form "@[Name](userId)" —
// so typing/editing a mention never shows the recipient's raw id. `pendingMentions`
// remembers what was inserted; encodeMentions expands each back to the wire form
// right before send, matched by name against text the user may have edited around
// but left the "@Name" token intact. A mention edited/deleted from the draft simply
// finds no match and is dropped — never sent as broken markup.
interface PendingMention {name: string; userId: string}
function encodeMentions(text: string, mentions: PendingMention[]): string {
  let out = text;
  for (const {name, userId} of mentions) {
    const token = `@${name}`;
    const idx = out.indexOf(token);
    if (idx === -1) {continue;}
    const endIdx = idx + token.length;
    const nextChar = out[endIdx];
    if (nextChar && /[\w]/.test(nextChar)) {continue;} // "@Name" is a prefix of a longer word — not our token
    out = `${out.slice(0, idx)}@[${name}](${userId})${out.slice(endIdx)}`;
  }
  return out;
}

export default function DepartmentChatScreen() {
  const insets = useSafeAreaInsets();
  // B-84 / KB-03 — Android keyboard covered the bottom composer (KAV has
  // no Android behavior; adjustResize is dead under edge-to-edge).
  // ChatScreen pattern: manual kb padding.
  // B-184 — one keyboard rule: the bottom-most bar owns the inset via bottomPad.
  const {bottomPad, overlap} = useKeyboardLayout();
  const {height: windowHeight} = useWindowDimensions();
  // B-281 — inline emoji panel height as a share of the window, clamped (never a
  // dp constant; same B-277 rule as ChatScreen). ~38% lands it where the IME was.
  const emojiPanelHeight = Math.max(240, Math.min(360, Math.round(windowHeight * 0.38)));
  const navigation = useNavigation();
  const route = useRoute<Rt>();
  const {channelId, channelName, channelDesc, isOwner} = route.params;

  // ChatScreen pattern (see ChatScreen.tsx) — when this screen is nested inside the
  // Departmental 5-tab shell (opened from the Channels tab), the ObsidianTabBar stays
  // mounted below it and ALSO reserves insets.bottom, so the composer's own
  // `insets.bottom` padding below double-counts the safe area and opens a large dead
  // gap above the tab bar. Hiding the parent tab bar while this screen is focused makes
  // the composer's padding the only (dynamic) safe-area reservation, same as 1:1 chat.
  /**
   * FOCUS-paired, not mount-paired.
   *
   * Mount-paired was safe only while this route could never have two instances.
   * It can now: `DepartmentChat` is registered with a per-channel `getId`, so a
   * chat→chat navigate (a push tap for another channel while you are reading
   * one) PUSHES rather than swapping params. Popping the inner instance then
   * ran this cleanup while the outer one was still mounted and focused — and
   * with deps `[navigation]` the outer never re-hid the bar. The member landed
   * back in the first channel with the tab bar showing and the composer
   * double-counting the safe area, which is the exact gap this exists to
   * prevent, and it did not heal until they left the channel entirely.
   */
  useEffect(() => {
    const tabNav = navigation.getParent();
    tabNav?.setOptions({tabBarStyle: {display: 'none'}});
    return () => tabNav?.setOptions({tabBarStyle: undefined});
  }, [navigation]);
  // D1-h — track the group id locally; route params freeze it at navigation time, so a
  // channel an admin provisions AFTER we opened it would stay stuck on "not yet active".
  const [groupConversationId, setGroupConversationId] = useState<string | null>(route.params.groupConversationId ?? null);
  // Route params freeze channelName at navigation time; keep a live copy so a
  // rename (elsewhere, or by this admin) reflects in the header without
  // having to leave and re-enter the thread.
  const [liveChannelName, setLiveChannelName] = useState(channelName);
  // Role is tracked locally + refreshed on focus AND re-verified at send time: a member just
  // downgraded to 'viewer' must lose the composer and be blocked from posting. Group sends are
  // E2EE + client-driven (no server gate on plaintext), so this client gate is the enforcement.
  const [myRole, setMyRole] = useState<'admin' | 'viewer'>(route.params.myRole === 'admin' ? 'admin' : 'viewer');
  const myId = useAuthStore(s => s.user?.id);

  // Decrypted messages come from the messenger store, keyed by the group
  // conversation id. The relay only ever held the ciphertext — decryption
  // happened in the runtime's receive path (parseGroupMessage). No channel
  // plaintext is ever fetched from the department REST API.
  const rawMessages = useMessengerStore(s =>
    groupConversationId ? (s.messages[groupConversationId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );

  /**
   * Scope v2 Phase 2 — RECEIVE-SIDE enforcement of read-only / #broadcast.
   *
   * A9 + M9 say members "cannot post" in read-only and #broadcast channels, and
   * A4 says never to rely on a UI control as the boundary. But the relay cannot
   * enforce this: channel posts are SEALED-SENDER group envelopes, so the relay
   * does not know who sent one — that is the whole point of sealed sender, and
   * teaching it channel roles is an architecture stop-condition.
   *
   * So we enforce at BOTH ends of the client instead of only the sending end.
   * A modified client that skips the send gate can still put ciphertext on the
   * relay, but every honest recipient discards it, so the message reaches
   * nobody. That is the observable promise the PDF makes, without touching
   * relay semantics.
   *
   * Deliberately fail-OPEN while the roster is unknown (empty `posters`, e.g.
   * offline or first paint): hiding real messages because a fetch failed would
   * be a far worse bug than briefly showing one that should not exist.
   */
  const [posters, setPosters] = useState<Set<string> | null>(null);
  /**
   * THE MODE IS SERVER-AUTHORITATIVE, NOT A ROUTE PARAM.
   *
   * This used to read `route.params.postMode` directly, so `enforcePosters` was
   * FALSE whenever the param was absent — and it is absent on every lane that
   * opens a thread without coming from the channel list: a notification tap, a
   * forward, a shared link. The receive-side half of "we enforce at BOTH ends"
   * simply did not run there, which is the worst place for it to be off since a
   * push is exactly how a member sees a new post first.
   *
   * The param is kept only as the first-paint SEED so the filter is armed before
   * the roster lands; the focus fetch (which this screen already makes) then
   * overwrites it. That also fixes a case the param never could: a channel
   * switched to read-only while the thread is open.
   */
  const [postMode, setPostMode] = useState<string | undefined>(route.params.postMode);
  // Unknown mode ⇒ ENFORCE. Fail-closed on the rule, and harmless when the
  // channel is in fact open: the server seeds every member of an open channel
  // with role 'admin' (memberRoleFor), so `posters` is the whole roster and the
  // filter passes everyone. The `posters.size === 0` guard below still
  // fails-OPEN while the roster is genuinely unknown.
  const enforcePosters = postMode !== 'open';
  const messages = useMemo(() => {
    if (!enforcePosters || !posters || posters.size === 0) {return rawMessages;}
    return rawMessages.filter(m => {
      const from = m.sender_id;
      if (!from || from === 'self' || from === myId) {return true;}
      return posters.has(from);
    });
  }, [rawMessages, posters, enforcePosters, myId]);
  // Member count for the header meta — sourced from the local conversation's
  // participants (hydrated on focus from the server-authoritative roster).
  const memberCount = useMessengerStore(s =>
    groupConversationId ? (s.conversations[groupConversationId]?.participants?.length ?? 0) : 0,
  );

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // When the channel role was last confirmed against the server. Sends inside
  // this window trust it and skip the round-trip (see send()).
  const roleCheckedAt = useRef(0);
  const scrollRef = useRef<ScrollView>(null);

  // When the keyboard opens, keep the newest message in view. This ScrollView
  // is NOT inverted (unlike ChatScreen's FlatList, which pins offset 0 = the
  // bottom for free), so opening the keyboard shrinks the viewport from the
  // bottom and hides the latest message behind the composer until you swipe.
  // Re-anchor to the end on every keyboard-overlap change so the dept chat
  // behaves like 1:1 chat everywhere. (B-184 rule: `overlap` is the one
  // keyboard signal; no hand-rolled kbHeight.)
  useEffect(() => {
    if (overlap > 0) {
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({animated: false}));
    }
  }, [overlap]);

  // @mention members (userId -> display name) for this channel's group, and the
  // announcement toggle. memberNames is populated by the group runtime as members
  // are keyed in; absent until then (autocomplete just shows nothing).
  const memberNames = useMessengerStore(s =>
    groupConversationId ? s.groupMemberNames[groupConversationId] : undefined,
  );
  // B-703 MR-9 — GF-5: a channel whose master key has not arrived cannot be
  // sent into (the runtime fails closed), and ChatScreen has gated its composer
  // on exactly this since GF-5 landed. Dept chat did not, so the post was typed,
  // appended, flipped 'failed' and thrown — an alert, a restored draft, and a
  // dead bubble the user then duplicates by re-typing. Boolean selector →
  // primitive equality; `true` forces the group branch (dept conversations are
  // always groups, even before /conversations/mine knows about them).
  const groupKeyPending = useMessengerStore(s =>
    !!groupConversationId && !!groupSendBlockedReason(s, groupConversationId, true),
  );
  // Photo avatars for the bubble header. Local (not vault-persisted) — refreshed
  // every focus from the same listMembers roster call below, so a member's
  // updated profile photo shows against their OLD messages too, not just new
  // ones (avatar is looked up by sender_id at render time, never snapshotted).
  const [memberAvatars, setMemberAvatars] = useState<Record<string, string>>({});
  const [announce, setAnnounce] = useState(false);
  const [pendingMentions, setPendingMentions] = useState<PendingMention[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  // Media-parity M2 — dept-chat attachments were a dead "Open" label.
  const [viewerTarget, setViewerTarget] = useState<AttachmentViewTarget | null>(null);

  // Group-chat parity — reactions, reply, action sheet, forward, attach-send.
  // Same interaction model as ChatScreen.tsx, minus voice notes and calls
  // (deliberately out of scope). `actionMsg` drives the long-press sheet;
  // `forwardSource` its Forward sub-sheet; `replyTo` the composer's reply bar.
  const [actionMsg, setActionMsg] = useState<LocalMessage | null>(null);
  // Parity with ChatScreen's thread actions (the founder's ask: departmental
  // chat should carry every messenger-group feature).
  const [editing, setEditing] = useState<{messageId: string; original: string} | null>(null);
  const [infoMsg, setInfoMsg] = useState<LocalMessage | null>(null);
  const [forwardSource, setForwardSource] = useState<LocalMessage | null>(null);
  const [replyTo, setReplyTo] = useState<{messageId: string; preview: string; fromSelf: boolean} | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pendingAssets, setPendingAssets] = useState<PickedAsset[]>([]);
  const [mediaQueue, setMediaQueue] = useState<{done: number; total: number} | null>(null);
  const mediaQueueRef     = useRef<PickedAsset[]>([]);
  const mediaQueueRunning = useRef(false);
  const queueTotalRef     = useRef(0);
  const queueDoneRef      = useRef(0);

  const onDraftChange = useCallback((t: string) => {
    setDraft(t);
    // Slash-command palette (Discord-style): active while typing the leading "/command" token.
    if (t.startsWith('/') && !/\s/.test(t)) {
      setSlashQuery(t);
      setMentionQuery(null);
      return;
    }
    setSlashQuery(null);
    // Active @mention = the token after the last '@' that starts a word, with no
    // newline/second-'@', short enough to be a name fragment.
    const at = t.lastIndexOf('@');
    if (at >= 0 && (at === 0 || /\s/.test(t[at - 1]))) {
      const after = t.slice(at + 1);
      setMentionQuery(!after.includes('\n') && !after.includes('@') && after.length <= 30 ? after : null);
    } else {
      setMentionQuery(null);
    }
  }, []);

  // @mention autocomplete: members of THIS channel whose display name matches the typed
  // keyword, TOP 5 (names are hydrated on focus from departmentApi.listMembers below).
  const suggestions = useMemo<Array<[string, string]>>(() => {
    if (mentionQuery === null || !memberNames) {return [];}
    const q = mentionQuery.trim().toLowerCase();
    return Object.entries(memberNames)
      .filter(([uid, name]) => uid !== myId && (q === '' || name.toLowerCase().includes(q)))
      .sort((a, b) => a[1].localeCompare(b[1]))
      .slice(0, 5);
  }, [mentionQuery, memberNames, myId]);

  const slashSuggestions = useMemo<SlashCmd[]>(() => {
    if (slashQuery === null) {return [];}
    const q = slashQuery.toLowerCase();
    return SLASH_COMMANDS.filter(c => c.cmd.startsWith(q));
  }, [slashQuery]);

  const insertMention = useCallback((uid: string, name: string) => {
    setDraft(prev => {
      const at = prev.lastIndexOf('@');
      return at < 0 ? prev : `${prev.slice(0, at)}@${name} `;
    });
    setPendingMentions(prev => [...prev, {name, userId: uid}]);
    setMentionQuery(null);
  }, []);

  const applySlash = useCallback((cmd: string) => {
    setSlashQuery(null);
    if (cmd === '/announce') { setAnnounce(true); setDraft(''); setPendingMentions([]); }
  }, []);

  // The conversation's placeholder peer — sendReaction/sendMedia/sendText all
  // accept it, but the runtime ignores it for a real group fan-out (it fans to
  // every participant via reactionRecipients/isGroupConversation); it only
  // needs `.userId` to be truthy. Same placeholder the focus-effect hydration
  // above already stores on this conversation.
  const storedPeer = useMessengerStore(s =>
    groupConversationId ? s.conversations[groupConversationId]?.peer : undefined,
  );
  const groupPeer = useMemo(
    () => storedPeer ?? (myId ? {userId: myId, deviceId: 1} : undefined),
    [storedPeer, myId],
  );

  /**
   * F7 — A9/M9: in a read-only or #broadcast channel a member "cannot post,
   * reply or call". A REACTION IS A POST. It is `rt.sendReaction`, which fans a
   * sealed envelope out to every member exactly like `sendText` does, and it
   * lands on everyone's screen as a chip under the message.
   *
   * The composer and `send()` were both gated on `myRole === 'admin'`; this was
   * not, so a viewer who long-pressed a broadcast message put a reaction on the
   * wire that every recipient rendered. The UI-only half of the fix (hiding the
   * quick-reaction row below) is NOT the boundary — A4 says never to rely on a
   * control being hidden — so the gate lives HERE, at the write, and the row is
   * hidden as well so the affordance matches the rule.
   *
   * Same predicate as `send()` deliberately: one rule, one place to change it.
   * It is intentionally the CACHED role, with no listMembers round-trip — the
   * send path's freshness window exists because a send is worth waiting for, and
   * paying a request per emoji tap to tighten a bound the send path itself does
   * not hold would be strictly worse.
   */
  // NAV-15 — in-flight ref guard, same as ChatScreen: one crypto seal per
  // deliberate tap, never one per queued repeat.
  const reactionInFlightRef = useRef(false);
  const reactToMessage = useCallback(async (msg: LocalMessage, emoji: string) => {
    setActionMsg(null);
    if (myRole !== 'admin') {return;}
    if (!groupConversationId || !groupPeer) {return;}
    if (reactionInFlightRef.current) {return;}
    reactionInFlightRef.current = true;
    const mine = msg.reactions?.self;
    const remove = mine === emoji;
    try {
      const rt = await getMessengerRuntime('production');
      await rt.sendReaction(groupPeer, groupConversationId, msg.id, emoji, remove);
      haptics.impact();
    } catch { /* best-effort — a failed reaction just doesn't show */ }
    finally { reactionInFlightRef.current = false; }
  }, [groupConversationId, groupPeer, myRole]);

  const copyMessage = useCallback(async (msg: LocalMessage) => {
    setActionMsg(null);
    if (!msg.content) {return;}
    try { await Clipboard.setStringAsync(msg.content); } catch { /* ignore */ }
    haptics.select();
  }, []);

  // F7 — the CHOKE POINT for reply, so the swipe gesture is covered by the same
  // rule as the action sheet. Gating only the sheet row would have left
  // `SwipeToReplyRow` arming a reply bar that the viewer has no composer to
  // send from — the same "looks like it works" shape as the ungated reaction.
  const startReply = useCallback((msg: LocalMessage) => {
    setActionMsg(null);
    if (myRole !== 'admin') {return;}
    setReplyTo({messageId: msg.id, preview: previewForReply(msg), fromSelf: msg.sender_id === 'self' || msg.sender_id === myId});
  }, [myId, myRole]);

  const startEdit = useCallback((msg: LocalMessage) => {
    setActionMsg(null);
    // Editing and replying are mutually exclusive composer modes — an armed
    // reply would attach a quote to an EDIT, which has no meaning on the wire
    // (the directive patches an existing row, it does not create one).
    setReplyTo(null);
    setEditing({messageId: msg.id, original: msg.content ?? ''});
    setDraft(msg.content ?? '');
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setDraft('');
  }, []);

  /**
   * Read-receipt rows for the Message-info sheet.
   *
   * Excludes the author: the receipts map is 'who else has seen this', so
   * listing yourself gives a permanent dash next to your own name.
   */
  const infoReaders = useMemo(() => {
    if (!infoMsg) {return [];}
    const receipts = infoMsg.receipts ?? {};
    return Object.keys(receipts)
      .filter(uid => uid && uid !== myId)
      .map(uid => {
        const r = receipts[uid];
        const read = r?.status === 'read';
        return {
          userId: uid,
          name:   memberNames?.[uid] ?? uid.slice(0, 8),
          read,
          when:   read && r?.ts
            ? new Date(r.ts).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
            : '—',
        };
      })
      .sort((a, b) => Number(b.read) - Number(a.read) || a.name.localeCompare(b.name));
  }, [infoMsg, memberNames, myId]);

  /**
   * Tap a reply quote to jump to the message it answers, WhatsApp-style.
   *
   * ChatScreen does this with scrollToIndex on its FlatList. This screen
   * renders a plain ScrollView, so there is no index to scroll to — each row
   * records its own y offset on layout and we scroll to that instead.
   */
  const msgOffsets = useRef<Record<string, number>>({});
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const jumpToMessage = useCallback((targetId: string) => {
    const y = msgOffsets.current[targetId];
    if (typeof y === 'number') {
      // 90px of lead-in so the target is not glued to the very top edge.
      scrollRef.current?.scrollTo({y: Math.max(0, y - 90), animated: true});
    }
    haptics.select();
    // Highlight regardless of whether we could scroll: if the quoted message
    // is already on screen there is nothing to scroll to, but the user still
    // needs to be shown WHICH one it was.
    setHighlightedId(targetId);
    setTimeout(() => setHighlightedId(c => (c === targetId ? null : c)), 1400);
  }, []);

  const openInfo = useCallback((msg: LocalMessage) => {
    setActionMsg(null);
    setInfoMsg(msg);
  }, []);

  const deleteMessage = useCallback((msg: LocalMessage) => {
    setActionMsg(null);
    void (async () => {
      try {
        const rt = await getMessengerRuntime('production');
        await rt.discardOutboxForMessage(msg.id);
      } catch { /* best-effort */ }
    })();
    if (groupConversationId) {useMessengerStore.getState().removeMessage(groupConversationId, msg.id);}
  }, [groupConversationId]);

  const startForward = useCallback((msg: LocalMessage) => {
    setActionMsg(null);
    setForwardSource(msg);
  }, []);

  const forwardTo = useCallback(async (targetConvId: string) => {
    const src = forwardSource;
    setForwardSource(null);
    if (!src) {return;}
    const store  = useMessengerStore.getState();
    const target = store.conversations[targetConvId];
    if (!target?.peer) {
      Alert.alert('Forward failed', 'Target conversation not found.');
      return;
    }
    const isMedia = src.type === 'image' || src.type === 'file' || src.type === 'audio' || src.type === 'video';
    const canReforwardMedia = isMedia && !!src.media_object_key && !!src.media_key && !!src.media_iv;
    try {
      const rt = await getMessengerRuntime('production');
      if (canReforwardMedia) {
        await rt.sendText(targetConvId, src.content ?? '', {
          peer: target.peer,
          attachment: {
            objectKey: src.media_object_key!,
            keyB64:    src.media_key!,
            ivB64:     src.media_iv!,
            mimeType:  src.media_mime ?? 'application/octet-stream',
            size:      (src as {media_size?: number}).media_size ?? 0,
          },
        });
      } else {
        const prefix = src.sender_id === 'self' || src.sender_id === myId ? '' : '↪ Forwarded\n';
        await rt.sendText(targetConvId, `${prefix}${src.content ?? ''}`, {peer: target.peer});
      }
      haptics.tap();
    } catch (e) {
      Alert.alert('Forward failed', (e as Error)?.message ?? 'Could not forward this message.');
    }
  }, [forwardSource, myId]);

  // ─── Encrypted media send — same call chain ChatScreen uses, just pointed
  // at this channel's group id + explicit isGroup: true. No calls, no voice
  // notes — deliberately out of scope for this port.
  const sendPickedMedia = useCallback(async (
    uri: string,
    mimeType: string,
    kind: 'image' | 'audio' | 'video' | 'file',
    meta?: {name?: string; width?: number; height?: number; durationMs?: number},
    // B-707 — pre-send caption, carried on the queue item (pickedAssets.withBatchCaption).
    caption?: string,
  ) => {
    if (!groupConversationId) {return;}
    try {
      const rt = await getMessengerRuntime('production');
      if (typeof rt.sendMedia !== 'function') {
        Alert.alert('Cannot send', 'Secure session is still initialising. Try again in a moment.');
        return;
      }
      let thumbB64: string | undefined;
      if (kind === 'image') {
        try {
          const t = await ImageManipulator.manipulateAsync(
            uri, [{resize: {width: 320}}],
            {compress: 0.35, format: ImageManipulator.SaveFormat.JPEG, base64: true},
          );
          if (t.base64 && t.base64.length <= 48 * 1024) {thumbB64 = t.base64;}
        } catch { /* thumbnail is a bonus, never a blocker */ }
      }
      // B-703 MR-9 — same gate as the text lane: a keyless channel fails closed
      // in the runtime, and an attachment does it AFTER the upload.
      if (groupKeyPending) {
        Alert.alert('Not ready yet', GROUP_KEY_PENDING_SEND_ERROR);
        return;
      }
      const bytes = await readUriBytes(uri);
      // Same 50 MB cap ChatScreen enforces, mirroring the server's ciphertext limit.
      const V2_CIPHERTEXT_OVERHEAD = 1 + 16 + 32;
      if (bytes.byteLength > 50 * 1024 * 1024 - V2_CIPHERTEXT_OVERHEAD) {
        Alert.alert('File too large', 'Attachments are limited to 50 MB.');
        return;
      }
      await rt.sendMedia(
        groupConversationId,
        {bytes, mimeType, kind, meta: {...meta, ...(thumbB64 ? {thumbB64} : {})}},
        {peer: groupPeer, isGroup: true, caption},
      );
      haptics.tap();
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({animated: true}));
    } catch (e) {
      Alert.alert('Send failed', (e as Error)?.message ?? 'Could not send the attachment.');
    }
  }, [groupConversationId, groupPeer, groupKeyPending]);

  const sendPickedMediaRef = useRef(sendPickedMedia);
  useEffect(() => { sendPickedMediaRef.current = sendPickedMedia; }, [sendPickedMedia]);

  // Serial queue — same reasoning as ChatScreen (MX-09): at most one
  // plaintext buffer resident at a time, composer stays usable meanwhile.
  const enqueueMediaAssets = useCallback((assets: PickedAsset[]) => {
    if (assets.length === 0 || !groupConversationId) {return;}
    mediaQueueRef.current.push(...assets);
    queueTotalRef.current += assets.length;
    setMediaQueue({done: queueDoneRef.current, total: queueTotalRef.current});
    if (mediaQueueRunning.current) {return;}
    mediaQueueRunning.current = true;
    void (async () => {
      try {
        for (;;) {
          const next = mediaQueueRef.current.shift();
          if (!next) {break;}
          try { await sendPickedMediaRef.current(next.uri, next.mime, next.kind, next.meta, next.caption); } catch { /* surfaced above */ }
          queueDoneRef.current += 1;
          setMediaQueue({done: queueDoneRef.current, total: queueTotalRef.current});
        }
      } finally {
        mediaQueueRunning.current = false;
        queueTotalRef.current = 0;
        queueDoneRef.current = 0;
        setMediaQueue(null);
      }
    })();
  }, [groupConversationId]);

  const captureImage = useCallback(async () => {
    setAttachOpen(false);
    try {
      const res = await launchCamera({
        mediaType: 'photo', saveToPhotos: false, includeBase64: false,
        quality: 0.8, maxWidth: 1920, maxHeight: 1920,
      });
      const asset = res.assets?.[0];
      if (res.didCancel || !asset?.uri) {return;}
      // B-707 — review + caption step, same as ChatScreen.
      setPendingAssets([{
        uri: asset.uri, mime: asset.type ?? 'image/jpeg', kind: 'image',
        meta: {name: asset.fileName ?? undefined, width: asset.width, height: asset.height},
      }]);
    } catch {
      Alert.alert('Camera unavailable', 'Could not open the camera on this device.');
    }
  }, []);

  const pickImage = useCallback(async () => {
    setAttachOpen(false);
    try {
      const res = await launchImageLibrary({
        mediaType: 'mixed', selectionLimit: MAX_PICKED_ASSETS, includeBase64: false,
        quality: 0.8, maxWidth: 1920, maxHeight: 1920,
      });
      if (res.didCancel) {return;}
      const assets = normalizePickedAssets(res.assets);
      if (assets.length === 0) {return;}
      // B-707 — every pick reviews in the tray, including a single one; that is
      // the only surface with a caption field.
      haptics.select();
      setPendingAssets(assets);
    } catch {
      Alert.alert('Picker unavailable', 'Could not open the photo library.');
    }
  }, []);

  const pickDocument = useCallback(async () => {
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
      enqueueMediaAssets([{uri: asset.uri, mime, kind, meta: {name: asset.name ?? undefined}}]);
    } catch {
      Alert.alert('Picker unavailable', 'Could not open the document picker.');
    }
  }, [enqueueMediaAssets]);

  const appendEmoji = useCallback((e: string) => {
    setDraft(prev => prev + e);
  }, []);
  // B-280 — so dismissing the emoji sheet can put the caret back and raise the
  // IME. Same fix as ChatScreen; this screen is the second copy of the composer.
  const draftInputRef = useRef<TextInput>(null);
  // B-281 — inline emoji panel toggle (ChatScreen pattern). Dismissing the IME on
  // open is LOAD-BEARING: the inline panel occupies the space the keyboard vacated,
  // so if the IME stayed up bottomPad would lift the composer AND the panel would
  // push the input off-screen.
  const toggleEmoji = useCallback(() => {
    setEmojiOpen(prev => {
      if (prev) { draftInputRef.current?.focus(); return false; }
      Keyboard.dismiss();
      return true;
    });
  }, []);
  const closeEmoji = useCallback(() => {
    setEmojiOpen(false);
    draftInputRef.current?.focus();
  }, []);

  // Pull any queued envelopes once on open.
  useEffect(() => {
    if (!groupConversationId) {return;}
    void (async () => {
      try {
        const rt = await getMessengerRuntime('production');
        await rt.pullEnvelopes();
      } catch (e) {
        console.log('[dept.chat] pull skipped:', (e as Error).message);
      }
    })();
  }, [groupConversationId]);

  // Read-receipt fan-out — mirrors ChatScreen.tsx exactly (Fix #25 / Polish #2):
  // this used to be a ONE-SHOT markRead on mount, so a message that landed
  // while the thread was already open (the normal case — an admin posts,
  // members are already sitting in the channel) never got receipted. Every
  // OTHER participant could see it on screen, but no read-receipt frame was
  // ever emitted for it, which is exactly the reported "stuck on single tick
  // even though everyone saw it" symptom. Re-run on every new message AND
  // only while the screen is actually focused + the app foregrounded (else a
  // backgrounded/unfocused screen would blue-tick messages the user hasn't
  // actually seen).
  const isFocused = useIsFocused();
  const [appActiveTick, setAppActiveTick] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') {setAppActiveTick(t => t + 1);}
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!groupConversationId || !isFocused) {return;}
    const t = setTimeout(() => {
      if (AppState.currentState !== 'active') {return;}
      void getMessengerRuntime('production').then(rt => rt.markRead(groupConversationId));
    }, 200);
    return () => clearTimeout(t);
  }, [groupConversationId, messages.length, isFocused, appActiveTick]);

  // Mark this channel active while focused so the per-channel unread badge
  // (ChannelUnread / the Home announcement badge) zeroes out — rt.markRead
  // only acks the relay, it never touches the local unread_count.
  // B-703 MR-11 — the pin/clear pair moved into the shared hook, which also
  // releases the thread when the app goes to BACKGROUND. Focus alone left a
  // channel "active" (and therefore silent) when the user pressed Home from
  // inside it.
  useActiveConversation(groupConversationId);

  useFocusEffect(
    useCallback(() => {
      if (!groupConversationId) {return;}
      void (async () => {
        // D3-a/b + D2-d — hydrate the local conversation's participants from the
        // SERVER-AUTHORITATIVE dept roster. Dept‑channel groups are never written to
        // /conversations/mine, so on a fresh login / reinstall / 2nd-admin device
        // convo.participants is empty → the group fan-out throws "no other participants"
        // (D3-a) and the key self-heal has no peer to ask for the key (D2-d). listMembers
        // IS the server's authoritative membership, so sourcing recipients from it upholds
        // the "server authoritative for membership" invariant. METADATA ONLY — this never
        // touches the master key (which lives in store.groups, keyed separately).
        try {
          const {data} = await departmentApi.listMembers(channelId);
          const memberIds = data.members.map(m => m.user_id).filter(Boolean);
          const st = useMessengerStore.getState();
          // Names for the sender label (#1) + @mention picker (#3): map userId → display name
          // from the roster so a bubble shows the REAL name, not a userId prefix.
          for (const mem of data.members) {
            st.setGroupMemberName(groupConversationId, mem.user_id, mem.display_name || mem.user_id.slice(0, 8));
          }
          setMemberAvatars(Object.fromEntries(
            data.members.filter(mem => !!mem.avatar_url).map(mem => [mem.user_id, mem.avatar_url as string]),
          ));
          // Scope v2 Phase 2 — who is ALLOWED to post here, for receive-side
          // enforcement (see `posters` below). Same roster call, no extra fetch.
          setPosters(new Set(data.members.filter(mem => mem.role === 'admin').map(mem => mem.user_id)));
          // Same call, no extra fetch — the authoritative posting rule, which
          // the route param cannot supply on a notification/forward/link lane
          // and cannot refresh while the thread is open.
          if (data.post_mode) {setPostMode(data.post_mode);}
          // Refresh my role (#2) so a downgrade to viewer hides the composer on next focus.
          setMyRole(data.my_role === 'admin' ? 'admin' : 'viewer');
          roleCheckedAt.current = Date.now();
          if (memberIds.length) {
            const existing = st.conversations[groupConversationId];
            st.upsertConversation({
              ...(existing ?? {
                unread_count: 0, is_muted: false, created_at: new Date().toISOString(),
                peer: {userId: memberIds.find(id => id !== myId) ?? memberIds[0], deviceId: 1},
                session_state: 'fresh',
              }),
              id: groupConversationId,
              type: 'group',
              name: channelName,
              participants: memberIds,
            });
          }
        } catch { /* best-effort — a roster fetch miss must not block the thread */ }
        // Self-heal — if we hold this department group but have no master key for it
        // (logged back in / reinstalled / missed the fan-out), ask the owner to re-share it
        // so messages decrypt and the thread fills in. Runs AFTER hydration so the resync
        // has participants to request from. Rate-limited inside the runtime; no-op once present.
        if (!useMessengerStore.getState().groups[groupConversationId]?.masterKeyB64) {
          try {
            const rt = await getMessengerRuntime('production');
            await rt.requestGroupKeyResync?.(groupConversationId);
          } catch { /* best-effort */ }
        }
      })();
    }, [groupConversationId, channelId, channelName, myId]),
  );

  // D1-h — re-read the channel on focus so (a) the "not yet active" state clears
  // the moment an admin provisions it, and (b) a rename elsewhere reflects in
  // the header + posts a WhatsApp-style system line, all without having to
  // leave and re-enter the thread.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        try {
          const {data} = await departmentApi.listChannels();
          const ch = data.channels.find(c => c.id === channelId);
          if (cancelled || !ch) {return;}
          if (!groupConversationId && ch.group_conversation_id) {setGroupConversationId(ch.group_conversation_id);}
          if (ch.name && ch.name !== liveChannelName) {setLiveChannelName(ch.name);}
          const gid = ch.group_conversation_id ?? groupConversationId;
          // B-206 — if this channel's group id CHANGED (the owner reactivated a
          // keyless channel, which re-mints the group id), the old message
          // history is orphaned under the previous id and the thread looks
          // wiped for EVERY member. Migrate it onto the new id the first time
          // this device sees the change; record the new mapping only AFTER the
          // migration so an interruption safely retries on the next focus.
          if (gid) {
            const orphanId = useMessengerStore.getState().deptChannelGroup(channelId);
            if (orphanId && orphanId !== gid) {
              try {
                const rt = await getMessengerRuntime('production');
                await rt.remapConversation?.(orphanId, gid);
              } catch { /* best-effort; retries next focus (map not yet updated) */ }
            }
            useMessengerStore.getState().setDeptChannelGroup(channelId, gid);
          }
          if (gid && ch.name_changed_at) {
            appendChannelRenamedEvent({
              groupId: gid, actorUserId: ch.name_changed_by ?? null,
              newName: ch.name, changedAtIso: ch.name_changed_at, selfUserId: myId,
            });
          }
        } catch { /* best-effort */ }
      })();
      return () => { cancelled = true; };
    }, [groupConversationId, channelId, liveChannelName, myId]),
  );

  const send = useCallback(async () => {
    const displayDraft = draft;
    const displayMentions = pendingMentions;
    const replySnapshot = replyTo;
    let text = encodeMentions(draft, pendingMentions).trim();
    if (!text || sending || !groupConversationId) {return;}
    // B-703 MR-9 — the composer is already disabled here (`editable`), but the
    // send can also be reached by the button and the keyboard's submit, and the
    // key can vanish between render and tap. Refuse rather than mint a bubble
    // the runtime is about to fail closed on.
    if (groupKeyPending) {
      Alert.alert('Not ready yet', GROUP_KEY_PENDING_SEND_ERROR);
      return;
    }
    // EDIT mode patches an existing row: no new bubble, no scroll-to-bottom,
    // no announcement prefix, no reply quote. Same runtime call ChatScreen
    // uses, so the wire directive is identical for a dept channel.
    if (editing) {
      const target = editing;
      setEditing(null);
      setDraft('');
      setPendingMentions([]);
      // F7 — `rt.sendMessageEdit` is the THIRD sealed fan-out on this screen,
      // and this branch RETURNS below before the `myRole` gate further down, so
      // the gate has to be repeated here. Reachable: an admin arms an edit, the
      // focus-effect roster refresh downgrades them to viewer, and the pending
      // edit still went out. Hiding the sheet row is not the boundary (A4).
      if (myRole !== 'admin') {return;}
      if (text === target.original) {return;}   // nothing changed
      if (!groupPeer) {return;}
      try {
        const rt = await getMessengerRuntime('production');
        // This screen's PendingMention is {name,userId}; the runtime wants
        // {userId,label}. Same data, different field name.
        await rt.sendMessageEdit(
          groupPeer, groupConversationId, target.messageId, text,
          pendingMentions.map(m => ({userId: m.userId, label: m.name})),
        );
      } catch (e) {
        Alert.alert('Edit failed', (e as Error).message || 'Could not edit this message.');
      }
      return;
    }
    // #4 — inline slash command: "/announce <text>" posts as an announcement.
    let isAnnounce = announce;
    if (/^\/announce\b/i.test(text)) { text = text.replace(/^\/announce\s*/i, '').trim(); isAnnounce = true; }
    if (!text) {return;} // a bare "/announce" with no body — nothing to send
    setSending(true);
    // #2 — a member JUST downgraded to viewer must not be able to post. Group sends are E2EE +
    // client-fanned-out, so there is no server gate; this is the enforcement.
    //
    // It used to AWAIT departmentApi.listMembers on every single send, which is why the send
    // button sat spinning: nothing was encrypted or transmitted until a full round-trip came
    // back, on a call that re-fetches what the focus effect above already loaded. Now the role
    // is only re-fetched when the cached one has gone STALE — so a send right after opening the
    // channel (or a burst of sends) goes straight out, and the guarantee becomes "your role is
    // never more than ROLE_FRESH_MS old" instead of "always exact". That bound is strictly
    // tighter than the old code's real behaviour anyway: it already fell back to the cached role
    // whenever the request failed, i.e. unbounded staleness offline.
    if (Date.now() - roleCheckedAt.current > ROLE_FRESH_MS) {
      try {
        const {data} = await departmentApi.listMembers(channelId);
        setMyRole(data.my_role === 'admin' ? 'admin' : 'viewer');
        roleCheckedAt.current = Date.now();
        if (data.my_role !== 'admin') {
          setSending(false);
          Alert.alert('Read-only', 'You no longer have permission to post in this channel.');
          return;
        }
      } catch { /* offline: fall back to the cached role gate below (best we can do) */ }
    }
    if (myRole !== 'admin') { setSending(false); return; }
    // Announcement rides as a prefixed body (no backend message-type needed) — the
    // renderer styles it + shows a megaphone; recipients whose name is @mentioned in
    // the body get a highlighted bubble.
    const body = isAnnounce ? `${ANNOUNCE_PREFIX}${text}` : text;
    setDraft('');
    setPendingMentions([]);
    setMentionQuery(null);
    setSlashQuery(null);
    setReplyTo(null);
    try {
      const rt = await getMessengerRuntime('production');
      // Same encrypted group fan-out every Bravo group chat uses — broadcastToGroup seals one
      // envelope per member under their pairwise Signal session, master-key-wrapped.
      await rt.sendText(groupConversationId, body, {
        peer: groupPeer, isGroup: true,
        replyTo: replySnapshot ? {messageId: replySnapshot.messageId, preview: replySnapshot.preview} : undefined,
      });
      setAnnounce(false);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({animated: true}));
    } catch (e) {
      // Surface the REAL failure (e.g. group not synced yet) and restore the draft so the
      // post isn't lost. A merely-offline channel keeps the post durably queued, not thrown.
      // Restore the DISPLAY form (plain "@Name"), not the wire-encoded text with raw ids.
      setDraft(displayDraft);
      setPendingMentions(displayMentions);
      setReplyTo(replySnapshot);
      Alert.alert('Could not post', (e as Error).message || 'Message could not be sent.');
    } finally {
      setSending(false);
    }
  }, [draft, pendingMentions, sending, myRole, groupConversationId, groupPeer, channelId, announce, replyTo, groupKeyPending]);

  // Channel exists in metadata but no Signal group has been bootstrapped yet
  // (admin hasn't opened it on a device). Honest empty state, not a fake feed.
  const notProvisioned = !groupConversationId;

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.hBtn}
          onPress={() => goBackOnce(navigation)}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={OB.text} />
        </TouchableOpacity>

        <LinearGradient
          colors={['rgba(91,141,239,0.22)', 'rgba(47,91,224,0.06)']}
          start={{x: 0, y: 0}}
          end={{x: 1, y: 1}}
          style={styles.glyphTile}>
          <Icon name="pound" size={20} color={OB.accentSoft} />
        </LinearGradient>

        <View style={styles.headerMeta}>
          <Text style={styles.headerTitle} numberOfLines={1} maxFontSizeMultiplier={1.2}>{liveChannelName}</Text>
          <View style={styles.metaRow}>
            {memberCount > 0 ? (
              <>
                <Text style={styles.metaText} numberOfLines={1}>{memberCount} {memberCount === 1 ? 'member' : 'members'}</Text>
                <View style={styles.metaDot} />
              </>
            ) : null}
            <Icon name="lock" size={11} color={OB.signal} />
            <Text style={styles.metaEnc}>Encrypted</Text>
          </View>
        </View>

        {myRole === 'admin' ? (
          <TouchableOpacity
            style={styles.hBtn}
            activeOpacity={0.7}
            hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
            /**
             * vs2 edge A4 — the SECOND door, and the honest state of it.
             *
             * `isOwner` on this route is NOT ownership: `openDepartmentChannel`
             * computes it as `created_by === userId`, i.e. CREATOR. That is
             * exactly the server's first arm, so this door can never OVER-offer
             * Delete. It systematically UNDER-offers instead — the workspace
             * owner opening a delegated-manager-created channel gets no Delete
             * here, walks to Manage Channels, and finds it. Same person, same
             * channel, two answers; and the thread is where they look first.
             *
             * It also under-offers on every push-tap entry, which omits the
             * param entirely. The fix is for `ChannelSummary` to carry the
             * server's verdict — NOT a second client derivation.
             */
            onPress={() => (navigation as any).navigate('ChannelMembers', {channelId, channelName, canDelete: isOwner, groupConversationId})}>
            <Icon name="account-multiple-outline" size={19} color={OB.accentSoft} />
          </TouchableOpacity>
        ) : (
          <View style={styles.hBtn} />
        )}
      </View>

      {/* Pinned channel description as a notice */}
      {!!channelDesc && (
        <View style={styles.notice}>
          <Icon name="pin-outline" size={13} color={OB.accentSoft} />
          <Text style={styles.noticeText} numberOfLines={2}>{channelDesc}</Text>
        </View>
      )}

      {notProvisioned ? (
        <View style={styles.loader}>
          <View style={styles.emptyIcon}>
            <Icon name="lock-clock" size={30} color={OB.textMute} />
          </View>
          <Text style={styles.emptyTitle}>Channel not yet active</Text>
          <Text style={styles.emptySub}>
            An admin needs to open this channel on their device to set up its
            encrypted group before messages can flow.
          </Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.feedScroll}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.feed}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({animated: false})}>
          {messages.length === 0 ? (
            <View style={styles.emptyInline}>
              <Text style={styles.emptySub}>No messages yet.</Text>
            </View>
          ) : (
            messages.map((m, i) => {
              const mine = m.sender_id === 'self' || m.sender_id === myId;
              // Read-tick color imported verbatim from the main messenger
              // (ChatScreen uses the SAME tickIcon function with Bravo.glow —
              // dept chat was using the generic accent blue instead of the
              // distinct "seen" blue, so read ticks didn't visually pop).
              const tick = mine ? tickIcon({status: m.status, sender_id: 'self'}, {mute: OB.textMute, read: Bravo.glow, alert: OB.alert}) : null;
              const accent = colorForSender(m.sender_id);
              // Foreground for the coloured bubble. Every colour in this palette
              // is a light pastel, so white body text on it is unreadable.

              // #1 — resolve the REAL display name from the roster (hydrated on focus); fall back
              // to any embedded sender_name, then a short id only if the name isn't known yet.
              const senderName = memberNames?.[m.sender_id]
                ?? (m as {sender_name?: string}).sender_name ?? m.sender_id.slice(0, 8);
              const rawBody = m.content ?? '';
              const isAnn = rawBody.startsWith(ANNOUNCE_PREFIX);
              const body = isAnn ? rawBody.slice(ANNOUNCE_PREFIX.length) : rawBody;
              const segs = parseSegments(body);
              const iAmMentioned = !mine && segs.some(s => s.userId === myId);

              const prev = i > 0 ? messages[i - 1] : null;
              const showDay = !prev || !sameDay(prev.created_at, m.created_at);
              // Group consecutive same-sender incoming messages under one avatar + name header.
              const showHeader = !mine && (showDay || !prev || prev.sender_id !== m.sender_id);
              // WhatsApp-style membership/rename events — a centered, ownerless
              // pill, never a chat bubble (no sender owns "X added Y").
              if (m.type === 'system') {
                return (
                  <View key={m.id}>
                    {showDay && (
                      <View style={styles.dayDivider}>
                        <View style={styles.dayLine} />
                        <Text style={styles.dayLabel}>{dayLabel(m.created_at)} · {formatTime(m.created_at)}</Text>
                        <View style={styles.dayLine} />
                      </View>
                    )}
                    <View style={styles.systemRow}>
                      {/* Resolve membership/rename names LIVE from the hydrated
                          roster so an auto-added CPO shows their real name, not
                          the frozen "Member <code>" baked at creation. */}
                      <Text style={styles.systemText}>
                        {m.event
                          ? (systemEventText(m.event, {selfUserId: myId, groupId: groupConversationId ?? undefined}) ?? m.content)
                          : m.content}
                      </Text>
                    </View>
                  </View>
                );
              }
              return (
                <View
                  key={m.id}
                  onLayout={e => { msgOffsets.current[m.id] = e.nativeEvent.layout.y; }}>
                  {showDay && (
                    <View style={styles.dayDivider}>
                      <View style={styles.dayLine} />
                      <Text style={styles.dayLabel}>{dayLabel(m.created_at)} · {formatTime(m.created_at)}</Text>
                      <View style={styles.dayLine} />
                    </View>
                  )}
                  {/* Swipe to reply — parity with the messenger thread.
                      Right for someone else's message, left for your own. */}
                  <SwipeToReplyRow mine={mine} onReply={() => startReply(m)}>
                  <View style={[styles.msgRow, mine && styles.msgRowMine]}>
                    {!mine && (
                      showHeader ? (
                        <TouchableOpacity
                          activeOpacity={0.75}
                          disabled={myRole !== 'admin'}
                          onPress={() => {
                            // Manager side only for now — OrgCpoProfile lives on
                            // AgentStackParamList (the roster-oversight profile
                            // page); a CPO viewing a teammate's profile is a
                            // separate, not-yet-built surface. Back returns here
                            // naturally — this is a normal stack push, not a reset.
                            (navigation as any).navigate('OrgCpoProfile', {memberUserId: m.sender_id, displayName: senderName});
                          }}>
                          {memberAvatars[m.sender_id] ? (
                            <Image source={{uri: memberAvatars[m.sender_id]}} style={styles.avatar} />
                          ) : (
                            <LinearGradient
                              colors={[accent, accent + '99']}
                              start={{x: 0, y: 0}}
                              end={{x: 1, y: 1}}
                              style={styles.avatar}>
                              <Text style={styles.avatarText}>{initialsFor(senderName)}</Text>
                            </LinearGradient>
                          )}
                        </TouchableOpacity>
                      ) : <View style={styles.avatarSpacer} />
                    )}
                    <View style={[styles.msgCol, mine && styles.msgColMine]}>
                      {/* The name was `color: accent`, which is now the BUBBLE
                          colour — i.e. invisible. It sits on the coloured
                          surface, so it takes the same contrast foreground,
                          dimmed slightly to stay subordinate to the body. */}
                      {showHeader && (
                        <Text
                          style={[styles.senderName, {color: accent}]}
                          numberOfLines={1}>{senderName}</Text>
                      )}
                      <Pressable
                        style={[
                          styles.bubble,
                          mine ? styles.bubbleMine : styles.bubbleIn,
                          // The WHOLE incoming bubble carries the sender's
                          // colour (was a 2px left rule). Own messages keep the
                          // app accent so "mine vs theirs" stays readable at a
                          // glance, and announcements/mentions keep their own
                          // treatment by being applied after this.
                          isAnn && styles.bubbleAnnounce,
                          iAmMentioned && styles.bubbleMentioned,
                          highlightedId === m.id && styles.bubbleJumped,
                        ]}
                        delayLongPress={350}
                        onLongPress={() => { haptics.impact(); setActionMsg(m); }}>
                        {/* A 12%-white top sheen reads as a glass edge on the dark
                            bubble but as a stray band on a saturated one. */}
                        {!mine && <View style={styles.bubbleEdge} />}
                        {!!m.reply_to_msg_id && (
                          <TouchableOpacity
                            style={styles.replyStrip}
                            activeOpacity={0.7}
                            // B-450 — same nested-touchable class as the fileCard.
                            delayLongPress={350}
                            onLongPress={() => { haptics.impact(); setActionMsg(m); }}
                            onPress={() => jumpToMessage(m.reply_to_msg_id!)}>
                            <Text style={styles.replyStripText} numberOfLines={1}>{m.reply_to_preview}</Text>
                          </TouchableOpacity>
                        )}
                        {isAnn && (
                          <View style={styles.annHead}>
                            <Icon name="bullhorn-variant" size={13} color={OB.amber} />
                            <Text style={styles.annLabel}>ANNOUNCEMENT</Text>
                          </View>
                        )}
                        {!!body && (
                          <>
                            <Text style={[
                              styles.bubbleText,
                              mine && styles.bubbleTextMine,
                            ]}>
                              {segs.map((s, si) => s.mention
                                ? <Text key={si} style={[
                                    styles.mention,
                                    s.userId === myId && styles.mentionSelf,
                                    // Both mention colours are light — they vanish
                                    // on a pastel. Underline carries the "this is a
                                    // mention" signal instead of hue, and a
                                    // self-mention keeps its extra weight via a pill.
                                  ]}>@{s.mention}</Text>
                                : <Text key={si}>{s.text}</Text>)}
                            </Text>
                            {/* Never auto-fetch a received link — merely getting a
                                message must not ping the link's host from this device. */}
                            {/* B-450 — the card is a TouchableOpacity inside the
                                bubble Pressable, so it swallowed the long-press
                                on any message whose body carries a link. */}
                            <LinkPreviewCard
                              text={body}
                              autoFetch={mine}
                              onLongPress={() => { haptics.impact(); setActionMsg(m); }}
                              delayLongPress={350}
                            />
                          </>
                        )}
                        {!!m.media_object_key && (
                          <TouchableOpacity
                            // Same reason as the link plate: the card's contents
                            // (near-white name, light-blue OPEN) assume a dark
                            // surface, and its own 0.6 alpha lets a pastel through.
                            style={styles.fileCard}
                            activeOpacity={0.85}
                            // B-450 — the card is a TouchableOpacity nested inside
                            // the bubble Pressable that owns the long-press, so it
                            // wins RN's responder negotiation and the sheet never
                            // opened on an attachment. Re-arm it here with the
                            // bubble's own handler and delay.
                            delayLongPress={350}
                            onLongPress={() => { haptics.impact(); setActionMsg(m); }}
                            onPress={() => setViewerTarget({
                              id:               m.id,
                              conversationId:   m.conversation_id,
                              name:             m.media_meta?.name || (m.media_mime ?? 'Attachment'),
                              media_object_key: m.media_object_key,
                              media_key:        m.media_key,
                              media_iv:         m.media_iv,
                              media_mime:       m.media_mime,
                              sizeBytes:        m.media_meta?.sizeBytes,
                              createdAt:        new Date(m.created_at).getTime(),
                            })}>
                            <View style={styles.fileIcon}>
                              <Icon name="file-document-outline" size={18} color={OB.accentSoft} />
                            </View>
                            <Text style={styles.fileName} numberOfLines={1}>{m.media_meta?.name || (m.media_mime ?? 'Attachment')}</Text>
                            <View style={styles.fileOpenBtn}><Text style={styles.fileOpenText}>OPEN</Text></View>
                          </TouchableOpacity>
                        )}
                      </Pressable>
                      <View style={[styles.meta, mine && styles.metaMine]}>
                        <Text style={styles.metaTime}>{formatTime(m.created_at)}</Text>
                        {tick && <Icon name={tick.name} size={13} color={tick.color} />}
                      </View>
                      {m.reactions && Object.keys(m.reactions).length > 0 && (
                        <View style={[styles.reactionsRow, mine ? {alignSelf: 'flex-end'} : {alignSelf: 'flex-start'}]}>
                          {groupReactions(m.reactions).map(({emoji, count, mine: mineReaction}) => (
                            <View key={emoji} style={[styles.reactionChip, mineReaction && styles.reactionChipMine]}>
                              <Text style={styles.reactionEmoji}>{emoji}</Text>
                              {count > 1 && <Text style={styles.reactionCount}>{count}</Text>}
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
                  </View>
                  </SwipeToReplyRow>
                </View>
              );
            })
          )}
        </ScrollView>
      )}

      {/* Composer — admins post; viewers see the read-only notice instead */}
      {myRole === 'admin' && !notProvisioned ? (
        <View>
          {/* #4 — slash-command palette (Discord-style), shown while typing "/…" */}
          {slashSuggestions.length > 0 && (
            <View style={styles.slashBar}>
              {slashSuggestions.map(c => (
                <TouchableOpacity key={c.cmd} style={styles.slashRow} activeOpacity={0.8}
                  onPress={() => applySlash(c.cmd)}>
                  <Icon name={c.icon as IconName} size={16} color={OB.accentSoft} />
                  <Text style={styles.slashCmd}>{c.cmd}</Text>
                  <Text style={styles.slashDesc} numberOfLines={1}>{c.desc}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {/* @mention autocomplete (top 5, keyword-filtered) */}
          {suggestions.length > 0 && (
            <View style={styles.mentionBar}>
              {suggestions.map(([uid, name]) => (
                <TouchableOpacity key={uid} style={styles.mentionChip} activeOpacity={0.8}
                  onPress={() => insertMention(uid, name)}>
                  <Icon name="at" size={13} color={OB.accentSoft} />
                  <Text style={styles.mentionChipText} numberOfLines={1}>{name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {/* Edit mode needs its own visible state + a way out; without the
              banner the composer silently patches an old row instead of
              posting, and there is no cancel. Mutually exclusive with reply. */}
          {editing && (
            <View style={styles.replyBar}>
              <Icon name="pencil-outline" size={16} color={OB.accentSoft} />
              <View style={styles.replyBarBody}>
                <Text style={styles.replyBarLabel} numberOfLines={1}>Editing message</Text>
                <Text style={styles.replyBarText} numberOfLines={1}>{editing.original}</Text>
              </View>
              <TouchableOpacity style={styles.replyBarClose} onPress={cancelEdit} activeOpacity={0.7}>
                <Icon name="close" size={15} color={OB.textDim} />
              </TouchableOpacity>
            </View>
          )}
          {replyTo && !editing && (
            <View style={styles.replyBar}>
              <Icon name="reply" size={16} color={OB.accentSoft} />
              <View style={styles.replyBarBody}>
                <Text style={styles.replyBarLabel} numberOfLines={1}>
                  {replyTo.fromSelf ? 'Replying to yourself' : 'Replying'}
                </Text>
                <Text style={styles.replyBarText} numberOfLines={1}>{replyTo.preview}</Text>
              </View>
              <TouchableOpacity style={styles.replyBarClose} onPress={() => setReplyTo(null)} activeOpacity={0.7}>
                <Icon name="close" size={15} color={OB.textDim} />
              </TouchableOpacity>
            </View>
          )}
          {mediaQueue && (
            <View style={styles.mediaSendingBar}>
              <Icon name="lock" size={13} color={OB.accentSoft} />
              <Text style={styles.mediaSendingText}>
                {mediaQueue.total > 1
                  ? `Encrypting & sending ${Math.min(mediaQueue.done + 1, mediaQueue.total)} of ${mediaQueue.total}…`
                  : 'Encrypting & sending attachment…'}
              </Text>
            </View>
          )}
          {/* B-184 — the padded COLUMN owns the keyboard inset; the inline emoji
              panel (B-281) sits below the composer row inside it, in the space
              Keyboard.dismiss() frees, so the input stays visible above it. */}
          <View style={{paddingBottom: bottomPad(8)}}>
          <View style={styles.composer}>
            <TouchableOpacity
              style={styles.attachBtn}
              hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}
              activeOpacity={0.7}
              onPress={() => setAttachOpen(true)}>
              <Icon name="plus" size={20} color={OB.textDim} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.annToggle, announce && styles.annToggleOn]}
              hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}
              onPress={() => setAnnounce(a => !a)}
              activeOpacity={0.8}>
              <Icon name="bullhorn-variant" size={18} color={announce ? '#1A1710' : OB.textMute} />
            </TouchableOpacity>
            <View style={styles.inputPill}>
              <Icon name="lock" size={13} color={OB.signal} />
              <TextInput
                ref={draftInputRef}
                style={styles.input}
                placeholder={groupKeyPending
                  ? 'Waiting for the group key…'
                  : (announce ? 'Post an announcement…' : `Post to ${channelName}…  @ to mention`)}
                placeholderTextColor={OB.textMute}
                value={draft}
                onChangeText={onDraftChange}
                // B-703 MR-9 — no key, no composer. Without this the user types
                // a whole post, the runtime fails closed (GF-5) with the row
                // already appended, and they get an alert plus a restored draft
                // — which they then re-type, making a visible duplicate. Same
                // rule and same words as ChatScreen; one source
                // (`groupSendBlockedReason`) so the two cannot drift.
                editable={!groupKeyPending}
                // B-281 — tapping the field while the emoji panel is up swaps back
                // to the system keyboard (WhatsApp). Guarded on emojiOpen so the
                // focus() inside closeEmoji cannot re-enter this handler.
                onFocus={() => { if (emojiOpen) { closeEmoji(); } }}
                multiline
              />
              {/* 18dp glyph + 13dp each side = a 44dp target (DESIGN_REVIEW_LOOP
                  §3.4). Its siblings already carry this; it did not, and item
                  11's taller pill leaves it in the corner of a much bigger box. */}
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={toggleEmoji}
                accessibilityRole="button"
                accessibilityState={{expanded: !!emojiOpen}}
                accessibilityLabel={emojiOpen ? 'Show keyboard' : 'Show emoji'}
                hitSlop={{top: 13, bottom: 13, left: 13, right: 13}}>
                <Icon name={emojiOpen ? 'keyboard-outline' : 'emoticon-outline'} size={18} color={OB.textMute} />
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              onPress={() => { void send(); }}
              disabled={!draft.trim() || sending}
              activeOpacity={0.85}>
              <LinearGradient
                colors={['#7FA8FF', OB.accent, OB.accentDeep]}
                start={{x: 0.3, y: 0}}
                end={{x: 0.8, y: 1}}
                hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}
                style={[styles.sendBtn, (!draft.trim() || sending) && {opacity: 0.5}]}>
                {sending
                  ? <ActivityIndicator color="#FFF" size="small" />
                  : <Icon name="send" size={18} color="#FFF" />}
              </LinearGradient>
            </TouchableOpacity>
          </View>
          {/* B-281 — the emoji keyboard INLINE and BELOW the input bar, in the
              space Keyboard.dismiss() freed. A modal sheet (the old EmojiPicker)
              is window-anchored and always covered the composer. Height is a
              fraction of the window, clamped (B-277), never a dp constant. */}
          {emojiOpen && (
            <View style={[styles.emojiPanel, {height: emojiPanelHeight}]}>
              <EmojiKeyboard
                onEmojiSelected={e => appendEmoji(e.emoji)}
                categoryPosition="top"
                // B-281 — NO search bar: it costs a row and forces a flatten over
                // the whole ~1,800-entry dataset. Categories along the top navigate.
                enableRecentlyUsed
                theme={{
                  knob: OB.accent,
                  container: '#0C1018',
                  header: '#F2F4F8',
                  skinTonesContainer: '#161B25',
                  category: {icon: '#7E8AA6', iconActive: '#F2F4F8', container: '#0C1018', containerActive: OB.accent},
                  search: {background: 'rgba(255,255,255,0.05)', text: '#F2F4F8', placeholder: '#7E8AA6', icon: '#7E8AA6'},
                }}
              />
            </View>
          )}
          </View>
        </View>
      ) : !notProvisioned ? (
        <View style={[styles.viewerBar, {paddingBottom: bottomPad(12)}]}>
          <Icon name="eye-outline" size={15} color={OB.textMute} />
          <Text style={styles.viewerText}>You are a viewer</Text>
        </View>
      ) : null}
      <AttachmentFileViewer target={viewerTarget} onClose={() => setViewerTarget(null)} />

      {/* Forward picker — reuses ChatScreen's ForwardList (all conversations,
          excluding this channel itself). */}
      <Modal visible={!!forwardSource} transparent animationType="slide" onRequestClose={() => setForwardSource(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setForwardSource(null)}>
          {/* Bottom sheets owe their own bottom inset — with a fixed pad the
              last row (here the Cancel button) sits under the gesture pill /
              home indicator. ChatScreen's sheets already do this; these did
              not, which is the inconsistency this sweep closes. */}
          <Pressable style={[styles.sheet, {maxHeight: '70%', paddingBottom: insets.bottom + 10}]}>
            <Text style={styles.sheetTitle}>Forward to…</Text>
            {groupConversationId && (
              <ForwardList currentConvId={groupConversationId} onPick={id => { void forwardTo(id); }} />
            )}
            <TouchableOpacity style={styles.sheetCancel} onPress={() => setForwardSource(null)} activeOpacity={0.7}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Long-press message action sheet — Reply / Copy / Forward / Delete,
          quick reactions above them. Same shape as ChatScreen's, minus
          "Message info" (dept channels have their own membership screen). */}
      <Modal visible={!!actionMsg} transparent animationType="fade" onRequestClose={() => setActionMsg(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setActionMsg(null)}>
          <Pressable style={[styles.sheet, styles.actionSheet, {paddingBottom: insets.bottom + 10}]}>
            {actionMsg && (
              <>
                {/* F7 — the affordance follows the same rule as the write.
                    Leaving it visible for a viewer would render a row of taps
                    that silently do nothing, which is how the ungated version
                    read as working. */}
                {myRole === 'admin' && (
                  <>
                    <View style={styles.actionReactRow}>
                      {QUICK_REACTIONS.map(emoji => {
                        const reactedMine = actionMsg.reactions?.self === emoji;
                        return (
                          <TouchableOpacity
                            key={emoji}
                            style={[styles.actionReactBtn, reactedMine && styles.actionReactBtnMine]}
                            onPress={() => { void reactToMessage(actionMsg, emoji); }}
                            activeOpacity={0.7}>
                            <Text style={styles.actionReactEmoji}>{emoji}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    <View style={styles.actionDivider} />
                  </>
                )}
                {/* F7 — A9/M9 names REPLY alongside post. Both of these open a
                    composer mode, and the composer only renders for an admin, so
                    for a viewer they were already inert: a tap that armed hidden
                    state and looked broken. Gating them makes the sheet say what
                    the channel actually allows. */}
                {myRole === 'admin' && (
                  <TouchableOpacity style={styles.sheetRow} onPress={() => startReply(actionMsg)} activeOpacity={0.7}>
                    <Icon name="reply" size={20} color={OB.accentSoft} />
                    <Text style={styles.sheetRowText}>Reply</Text>
                  </TouchableOpacity>
                )}
                {/* Edit — own text messages only. There is no such thing as
                    editing someone else's row, and an edit directive carries a
                    text body, so it cannot target media or a voice note. */}
                {myRole === 'admin' && !!actionMsg.content && (actionMsg.sender_id === 'self' || actionMsg.sender_id === myId) && (
                  <TouchableOpacity style={styles.sheetRow} onPress={() => startEdit(actionMsg)} activeOpacity={0.7}>
                    <Icon name="pencil-outline" size={20} color={OB.accentSoft} />
                    <Text style={styles.sheetRowText}>Edit</Text>
                  </TouchableOpacity>
                )}
                {!!actionMsg.content && (
                  <TouchableOpacity style={styles.sheetRow} onPress={() => { void copyMessage(actionMsg); }} activeOpacity={0.7}>
                    <Icon name="content-copy" size={20} color={OB.accentSoft} />
                    <Text style={styles.sheetRowText}>Copy</Text>
                  </TouchableOpacity>
                )}
                {/* Message info — who has read it. Only meaningful for a
                    message you sent; on a received one the receipts map is
                    every OTHER member's view, which is not yours to see. */}
                {(actionMsg.sender_id === 'self' || actionMsg.sender_id === myId) && (
                  <TouchableOpacity style={styles.sheetRow} onPress={() => openInfo(actionMsg)} activeOpacity={0.7}>
                    <Icon name="information-outline" size={20} color={OB.accentSoft} />
                    <Text style={styles.sheetRowText}>Message info</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.sheetRow} onPress={() => startForward(actionMsg)} activeOpacity={0.7}>
                  <Icon name="share-outline" size={20} color={OB.accentSoft} />
                  <Text style={styles.sheetRowText}>Forward</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.sheetRow} onPress={() => deleteMessage(actionMsg)} activeOpacity={0.7}>
                  <Icon name="trash-can-outline" size={20} color={OB.alert} />
                  <Text style={[styles.sheetRowText, {color: OB.alert}]}>Delete (this device)</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.sheetCancel} onPress={() => setActionMsg(null)} activeOpacity={0.7}>
                  <Text style={styles.sheetCancelText}>Cancel</Text>
                </TouchableOpacity>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Message info — read receipts per member, same shape as ChatScreen's.
          Names come from the channel roster hydrated on focus. */}
      <Modal visible={!!infoMsg} transparent animationType="fade" onRequestClose={() => setInfoMsg(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setInfoMsg(null)}>
          <Pressable style={[styles.actionSheet, {paddingBottom: insets.bottom + 12}]}>
            <Text style={styles.sheetTitle}>Read by</Text>
            <View style={styles.actionDivider} />
            {infoReaders.length === 0 ? (
              <View style={styles.sheetRow}>
                <Text style={[styles.sheetRowText, {color: OB.textMute}]}>No one yet</Text>
              </View>
            ) : infoReaders.map(r => (
              <View key={r.userId} style={styles.sheetRow}>
                <Icon
                  name={r.read ? 'check-all' : 'check'}
                  size={18}
                  color={r.read ? Bravo.glow : OB.textMute}
                />
                <Text style={styles.sheetRowText} numberOfLines={1}>{r.name}</Text>
                <Text style={{color: OB.textMute, fontSize: 12, marginLeft: 'auto'}}>{r.when}</Text>
              </View>
            ))}
            <TouchableOpacity style={styles.sheetCancel} onPress={() => setInfoMsg(null)} activeOpacity={0.7}>
              <Text style={styles.sheetCancelText}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Attachment sheet — Camera / Photo-or-Video / Document. No voice
          notes, no calls — deliberately out of scope for this port. */}
      <Modal visible={attachOpen} transparent animationType="slide" onRequestClose={() => setAttachOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setAttachOpen(false)}>
          <Pressable style={[styles.attachSheet, {paddingBottom: insets.bottom + 24}]}>
            <View style={styles.attachHandle} />
            <View style={styles.attachHeader}>
              <Text style={styles.attachTitle}>Attach</Text>
              <View style={styles.encBadge}>
                <Icon name="lock" size={11} color={OB.signal} />
                <Text style={styles.encBadgeText}>Encrypted</Text>
              </View>
            </View>
            <TouchableOpacity style={styles.attachRow} onPress={() => { void captureImage(); }} activeOpacity={0.7}>
              <View style={styles.attachRowIcon}><Icon name="camera-outline" size={22} color="#FFF" /></View>
              <View style={{flex: 1}}>
                <Text style={styles.attachRowTitle}>Camera</Text>
                <Text style={styles.attachRowSub}>Take a photo — encrypted before upload</Text>
              </View>
              <Icon name="chevron-right" size={20} color={OB.textMute} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachRow} onPress={() => { void pickImage(); }} activeOpacity={0.7}>
              <View style={styles.attachRowIcon}><Icon name="image-outline" size={22} color="#FFF" /></View>
              <View style={{flex: 1}}>
                <Text style={styles.attachRowTitle}>Photo or Video</Text>
                <Text style={styles.attachRowSub}>From your library — E2E encrypted</Text>
              </View>
              <Icon name="chevron-right" size={20} color={OB.textMute} />
            </TouchableOpacity>
            <TouchableOpacity style={[styles.attachRow, styles.attachRowLast]} onPress={() => { void pickDocument(); }} activeOpacity={0.7}>
              <View style={styles.attachRowIcon}><Icon name="file-outline" size={22} color="#FFF" /></View>
              <View style={{flex: 1}}>
                <Text style={styles.attachRowTitle}>Document</Text>
                <Text style={styles.attachRowSub}>Any file up to 50 MB — encrypted</Text>
              </View>
              <Icon name="chevron-right" size={20} color={OB.textMute} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachCancel} onPress={() => setAttachOpen(false)} activeOpacity={0.8}>
              <Text style={styles.attachCancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* B-281 — the composer emoji keyboard is now INLINE (rendered in the
          composer column above), not this window-anchored modal that covered the
          composer. */}

      {/* Pre-send review tray for a multi-photo pick. */}
      <MediaPreviewTray
        assets={pendingAssets}
        onRemoveAt={i => setPendingAssets(prev => prev.filter((_, idx) => idx !== i))}
        onCancel={() => setPendingAssets([])}
        onSend={caption => {
          // B-707 — stamp the caption on the batch before the state clear.
          const assets = withBatchCaption(pendingAssets, caption);
          setPendingAssets([]);
          haptics.tap();
          enqueueMediaAssets(assets);
        }}
      />
    </View>
  );
}

const QUICK_REACTIONS = ['❤️', '😂', '👍', '🔥', '😮', '😢'];

// Composer growth cap, DERIVED so it is always a whole number of lines.
//
// `lineHeight` is scaled by scaleTextStyles AND again by the OS font scale,
// while a hard-coded `maxHeight` is scaled by neither — so a literal cap slices
// the last line in half as soon as the user raises their font size. The cap is
// therefore computed from the same line height the text uses (1:1 chat writes
// the same rule down against its own composer).
const COMPOSER_MAX_LINES = 6;
const COMPOSER_LINE_H = 21;
const COMPOSER_PAD_V = 5;
const COMPOSER_MAX_H = COMPOSER_MAX_LINES * COMPOSER_LINE_H
  + (Platform.OS === 'ios' ? 14 : 8); // the input's own paddingVertical, both sides

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  loader: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 36},
  emptyIcon: {
    width: 72, height: 72, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: OB.hair2,
  },

  // Header
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 13, borderBottomWidth: 1, borderBottomColor: OB.hair},
  hBtn: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  glyphTile: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)',
  },
  headerMeta: {flex: 1, minWidth: 0},
  headerTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16, letterSpacing: -0.2},
  metaRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3},
  metaText: {flexShrink: 1, minWidth: 0, color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10},
  metaDot: {width: 3, height: 3, borderRadius: 2, backgroundColor: OB.textMute},
  metaEnc: {flexShrink: 0, color: OB.signal, fontFamily: BravoFont.mono, fontSize: 10},

  notice: {flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 16, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: OB.hair},
  noticeText: {flex: 1, color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 16},

  feedScroll: {flex: 1},
  feed: {paddingHorizontal: 16, paddingVertical: 14, gap: 14, flexGrow: 1, justifyContent: 'flex-end'},
  emptyInline: {alignItems: 'center', paddingVertical: 24},
  emptyTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16},
  emptySub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12.5, textAlign: 'center', lineHeight: 18},

  // Day divider
  dayDivider: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 28, marginBottom: 14},
  dayLine: {flex: 1, height: 1, backgroundColor: OB.hair},
  dayLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9, letterSpacing: 1.3, textTransform: 'uppercase'},

  // Ownerless system line (membership/rename events) — centered pill, WhatsApp-style.
  systemRow: {alignItems: 'center', marginVertical: 6, paddingHorizontal: 24},
  systemText: {
    color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5, textAlign: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10,
  },

  // Message row + grouping
  msgRow: {flexDirection: 'row', gap: 10, alignItems: 'flex-start'},
  msgRowMine: {justifyContent: 'flex-end'},
  avatar: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginTop: 2,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  avatarText: {color: '#FFF', fontFamily: BravoFont.bold, fontSize: 11.5},
  avatarSpacer: {width: 32},
  msgCol: {flex: 1, minWidth: 0, alignItems: 'flex-start', maxWidth: '86%'},
  msgColMine: {alignItems: 'flex-end'},
  senderName: {fontFamily: BravoFont.mono, fontSize: 10, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6, marginLeft: 2, maxWidth: 200},

  bubble: {position: 'relative', overflow: 'hidden', maxWidth: '100%', paddingHorizontal: 14, paddingTop: 10, paddingBottom: 11, gap: 8},
  bubbleIn: {backgroundColor: '#18202F', borderWidth: 1, borderColor: OB.hair2, borderRadius: 16, borderTopLeftRadius: 4},
  bubbleMine: {backgroundColor: OB.accentDeep, borderWidth: 1, borderColor: 'rgba(127,168,255,0.4)', borderRadius: 16, borderTopRightRadius: 4},
  bubbleEdge: {position: 'absolute', top: 0, left: 12, right: 12, height: 1, backgroundColor: 'rgba(255,255,255,0.12)'},
  bubbleText: {color: OB.text, fontFamily: BravoFont.regular, fontSize: 14, lineHeight: 20, letterSpacing: -0.1},
  bubbleTextMine: {color: '#F4F7FF'},

  meta: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, paddingLeft: 4},
  metaMine: {justifyContent: 'flex-end', paddingLeft: 0, paddingRight: 2},
  metaTime: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9.5},

  // @mention + announcement
  mention: {color: OB.accentSoft, fontFamily: BravoFont.semiBold},
  mentionSelf: {color: OB.amber},
  bubbleAnnounce: {borderColor: OB.amber, backgroundColor: 'rgba(226,200,147,0.08)'},
  bubbleMentioned: {borderColor: 'rgba(226,200,147,0.5)'},
  // Reply-jump flash — cobalt, matching ChatScreen's pulse.
  bubbleJumped: {backgroundColor: 'rgba(91,141,239,0.32)', borderColor: OB.accentSoft},
  annHead: {flexDirection: 'row', alignItems: 'center', gap: 5},
  annLabel: {color: OB.amber, fontFamily: BravoFont.mono, fontSize: 9, fontWeight: '800', letterSpacing: 1},

  // File card
  fileCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 11, borderRadius: 14,
    backgroundColor: 'rgba(17,21,29,0.6)', borderWidth: 1, borderColor: OB.hair2,
  },
  fileIcon: {
    width: 38, height: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
  },
  fileName: {flex: 1, color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 12.5, letterSpacing: -0.1},
  fileOpenBtn: {paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9, backgroundColor: 'rgba(91,141,239,0.13)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)'},
  fileOpenText: {color: OB.accentSoft, fontFamily: BravoFont.mono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1.2},

  // Autocomplete bars
  mentionBar: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)'},
  mentionChip: {flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)', borderRadius: 14, paddingHorizontal: 9, paddingVertical: 5, maxWidth: 150},
  mentionChipText: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 12},
  slashBar: {paddingVertical: 4, borderTopWidth: 1, borderTopColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)'},
  slashRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 9},
  slashCmd: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 13},
  slashDesc: {flex: 1, color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5},

  // Composer
  // The ROW stays centred — same as 1:1 chat's `inputBar`. Only the PILL is
  // flex-end (below). Making the row flex-end too pushed the whole 8dp
  // difference between the 46dp pill and the 38dp controls to the top, so at
  // rest — the state the composer is in almost always — the controls sat
  // visibly below the pill's centre.
  composer: {flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 14, paddingTop: 6, borderTopWidth: 1, borderTopColor: OB.hair, backgroundColor: OB.bg},
  emojiPanel: {backgroundColor: '#0C1018', borderTopWidth: 1, borderTopColor: OB.hair, overflow: 'hidden'},
  annToggle: {
    width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  annToggleOn: {backgroundColor: OB.amber, borderColor: OB.amber},
  // Item 11 — the box was minHeight 38 at fontSize 14, which the long
  // "Post to <channel>… @ to mention" placeholder wrapped to three cramped
  // lines. Now: a taller resting box, a readable body size, and room to grow to
  // COMPOSER_MAX_LINES so a longer message stays visible while it is typed.
  inputPill: {
    flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 9, minHeight: 46,
    maxHeight: COMPOSER_MAX_H + COMPOSER_PAD_V * 2 + 2,
    borderRadius: 22, paddingLeft: 14, paddingRight: 12, paddingVertical: COMPOSER_PAD_V,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  input: {
    flex: 1, color: OB.text, fontFamily: BravoFont.regular, fontSize: 15.5,
    lineHeight: COMPOSER_LINE_H,
    paddingVertical: Platform.OS === 'ios' ? 7 : 4, maxHeight: COMPOSER_MAX_H,
  },
  sendBtn: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    shadowColor: OB.accent, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.4, shadowRadius: 16, elevation: 6,
  },

  viewerBar: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)'},
  viewerText: {color: OB.textMute, fontFamily: BravoFont.semiBold, fontSize: 12.5},

  // Reply quote strip inside a bubble
  replyStrip: {
    borderLeftWidth: 2, borderLeftColor: OB.accentSoft, paddingLeft: 8, paddingVertical: 2,
    backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 4,
  },
  replyStripText: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12},

  // Reactions
  reactionsRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3},
  reactionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: OB.hair2,
  },
  reactionChipMine: {borderColor: 'rgba(91,141,239,0.4)', backgroundColor: 'rgba(91,141,239,0.12)'},
  reactionEmoji: {fontSize: 13},
  reactionCount: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 10},

  // Reply bar above the composer
  replyBar: {
    flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 14, paddingVertical: 9,
    borderTopWidth: 1, borderTopColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)',
  },
  replyBarBody: {flex: 1, minWidth: 0},
  replyBarLabel: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 11},
  replyBarText: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12, marginTop: 1},
  replyBarClose: {padding: 4},

  mediaSendingBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)',
  },
  mediaSendingText: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12},

  attachBtn: {
    width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },

  // Bottom-sheet chrome shared by the forward picker + action sheet
  sheetBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)'},
  sheet: {
    backgroundColor: '#0C1018', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 14, paddingBottom: 10, borderWidth: 1, borderColor: OB.hair2, borderBottomWidth: 0,
  },
  sheetTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 15, paddingHorizontal: 18, paddingBottom: 10},
  sheetCancel: {paddingVertical: 14, alignItems: 'center', marginTop: 4},
  sheetCancelText: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 14},

  actionSheet: {paddingHorizontal: 6},
  actionReactRow: {flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 12, paddingVertical: 10},
  actionReactBtn: {
    width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  actionReactBtnMine: {backgroundColor: 'rgba(91,141,239,0.22)'},
  actionReactEmoji: {fontSize: 22},
  actionDivider: {height: StyleSheet.hairlineWidth, backgroundColor: OB.hair, marginVertical: 4},
  sheetRow: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingVertical: 13},
  sheetRowText: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 14.5},

  // Attach sheet
  attachSheet: {
    backgroundColor: '#0C1018', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 18, paddingTop: 10, paddingBottom: 24, borderWidth: 1, borderColor: OB.hair2, borderBottomWidth: 0,
  },
  attachHandle: {alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: OB.hair2, marginBottom: 14},
  attachHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8},
  attachTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16},
  encBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 4,
    borderRadius: 999, backgroundColor: 'rgba(74,222,128,0.10)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)',
  },
  encBadgeText: {color: OB.signal, fontFamily: BravoFont.mono, fontSize: 9.5, fontWeight: '700'},
  attachRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: OB.hair,
  },
  attachRowLast: {borderBottomWidth: 0},
  attachRowIcon: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: OB.accent,
  },
  attachRowTitle: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 14.5},
  attachRowSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5, marginTop: 1},
  attachCancel: {paddingVertical: 14, alignItems: 'center', marginTop: 6},
  attachCancelText: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 14},
}));
