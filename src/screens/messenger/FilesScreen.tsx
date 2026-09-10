import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  AppState,
  BackHandler,
  } from 'react-native';
import {launchImageLibrary} from 'react-native-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {openVault, useVaultStore, vaultHydrated, vaultPersistApi, moveBytesToVault, findVaultRow, isDepartmentConversation} from '@/modules/messenger/vault';
import {useEntitlements, showTierUpgradePrompt} from '@store/entitlements';
import {openPricing} from '@navigation/openPricing';
import {readUriBytes, resolveAttachmentFileUri} from '@/modules/messenger/media';
import {toggleSelected, selectAllVisible, runBatchVaultMove, runBatchShare, runBatchDelete} from './filesMultiSelect';
import {AlbumBar, MoveToAlbumSheet, NameAlbumModal, type AlbumFilter} from './albumUi';
import {useFileAlbumStore} from '@/modules/messenger/fileAlbums/fileAlbumStore';
import {itemsInAlbum, albumCounts, albumOf, type Album} from '@/modules/messenger/fileAlbums/fileAlbums';
import {haptics} from '@utils/haptics';
import {useMessengerStore, selectMediaMessages} from '@/modules/messenger/store';
import {useCompanyConversationIds} from '@/modules/messenger/vault/useCompanyShelf';
import {useInDepartmentalShell} from '@screens/deptchat/_obsidian';
import type {LocalMessage} from '@/modules/messenger/store';
import {AttachmentFileViewer, type AttachmentViewTarget} from '@/modules/messenger/ui/AttachmentFileViewer';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {Halo} from '@components/Halo';
import Svg, {Rect} from 'react-native-svg';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {OB} from '@screens/deptchat/_obsidian';
import {goBackOnce} from '@navigation/tapGuard';
import {findNavigatorWithRoute, navigateVia} from '@navigation/departmentalEntry';
import {MessengerTabBar} from './MessengerTabBar';
// B-661 — the SAME Channels rule MessengerHome uses. One rule, two callers: the
// bar itself must not read the auth store (see channelsAccess.ts for why).
import {canSeeChannelsFor} from './channelsAccess';

type Nav = NativeStackNavigationProp<MessengerStackParamList, 'Files'>;

type FileTab = 'all' | 'docs' | 'img' | 'vid' | 'voice';

// Gold — the File Vault sits apart from the blue system (design spec).
const GOLD = OB.amber; // '#E2C893'
const GOLD_BORDER = 'rgba(212,179,122,0.4)';

interface FileRow {
  id:             string;
  conversationId: string;
  name:           string;
  sizeBytes:      number;
  mimeType:       string;
  senderLabel:    string;
  source:         string;
  createdAt:      number;
  mediaUrl?:      string;
  mediaObjectKey?: string;
  mediaKey?:      string;
  mediaIv?:       string;
  tab:            Exclude<FileTab, 'all'>;
  inVault:        boolean;
}

/**
 * Derive the tab bucket from the message type + mime. `vid` and `voice`
 * are both reported as `audio`/`video` mime types the server already
 * bucketized, so we key on the leading word.
 */
function bucketFor(msg: LocalMessage): Exclude<FileTab, 'all'> | null {
  if (msg.type === 'image') {return 'img';}
  if (msg.type === 'audio') {return 'voice';}
  // `video` was missing while `selectMediaMessages` deliberately includes it
  // (audit MSG-13 fixed the selector and missed this consumer), so every video
  // fell through to `return null` and was dropped from this screen entirely.
  // Phase 4 made that bite: a video posted in a department channel was INVISIBLE
  // on the workspace Vault tab while VaultScreen's Company shelf listed it —
  // two company surfaces disagreeing about the same scope.
  if (msg.type === 'video') {return 'vid';}
  if (msg.type === 'file') {
    const mime = msg.media_mime ?? '';
    if (mime.startsWith('video/')) {return 'vid';}
    if (mime.startsWith('audio/')) {return 'voice';}
    return 'docs';
  }
  return null;
}

function humanSize(bytes: number): string {
  if (!bytes) {return '—';}
  if (bytes < 1024) {return `${bytes} B`;}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) {return 'now';}
  if (mins < 60) {return `${mins}m`;}
  const hrs = Math.round(mins / 60);
  if (hrs < 24) {return `${hrs}h`;}
  const days = Math.round(hrs / 24);
  if (days < 7) {return `${days}d`;}
  return new Date(ms).toLocaleDateString([], {day: '2-digit', month: 'short'});
}

/** Icon's own union, not `string` — the loose type made each call site a
 *  TS2322 sitting in the baseline. */
type IconName = React.ComponentProps<typeof Icon>['name'];

function iconFor(row: FileRow): {name: IconName; color: string; bg: string; border: string} {
  if (row.tab === 'img')   {return {name: 'image-outline',        color: '#A78BFA', bg: 'rgba(167,139,250,0.12)', border: 'rgba(167,139,250,0.28)'};}
  if (row.tab === 'vid')   {return {name: 'video-outline',        color: '#60A5FA', bg: 'rgba(96,165,250,0.12)',  border: 'rgba(96,165,250,0.28)'};}
  if (row.tab === 'voice') {return {name: 'microphone-outline',   color: '#F472B6', bg: 'rgba(244,114,182,0.12)', border: 'rgba(244,114,182,0.28)'};}
  if (row.mimeType.includes('pdf')) {return {name: 'file-pdf-box', color: '#f87171', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.28)'};}
  return {name: 'file-document-outline', color: '#A9C5FF', bg: 'rgba(91,141,239,0.1)', border: 'rgba(91,141,239,0.25)'};
}

const TAB_META: {key: FileTab; label: string}[] = [
  {key: 'all',   label: 'ALL'},
  {key: 'docs',  label: 'DOCS'},
  {key: 'img',   label: 'IMG'},
  {key: 'vid',   label: 'VID'},
  {key: 'voice', label: 'VOICE'},
];

export default function FilesScreen() {
  const navigation = useNavigation<Nav>();
  const entitlements = useEntitlements();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<FileTab>('all');
  // The header magnify icon shipped as decoration (no onPress, no UI behind
  // it). Real now: toggles an input that filters the visible list by name,
  // conversation, sender and mime type.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Direct device→vault upload from the empty-state tile (founder 2026-08-26).
  const [uploadBusy, setUploadBusy] = useState(false);
  const [viewerFile, setViewerFile] = useState<AttachmentViewTarget | null>(null);
  // Multi-select — null = normal browsing, a Set = selection mode.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [batchBusy, setBatchBusy] = useState<'vault' | 'share' | 'delete' | null>(null);
  const selectionMode = selected !== null;
  const conversations = useMessengerStore(s => s.conversations);
  // Round 6 / perf — narrow subscription to the media-only slice. The
  // selector is memoised on the live `messages` map identity, so every
  // call returns the same frozen array until any append/remove flips
  // the top-level reference. Previously this screen subscribed to the
  // entire `s.messages` map, so a typed-message append in any chat
  // re-rendered the file picker.
  const mediaMessages = useMessengerStore(selectMediaMessages);
  // The SAME membership answer the company shelf uses — not a second derivation.
  const companyConvIds = useCompanyConversationIds();
  const scopeToCompany = useInDepartmentalShell();
  /**
   * Scope v2 Phase 4 — TWO SOURCES, TWO QUESTIONS, deliberately.
   *
   *  - `companyConvIds` (narrow, server membership, FAILS CLOSED to empty)
   *    answers "which files may I SHOW here?".
   *  - `deptConversationIds` (wide, additive, never pruned) answers "can this
   *    file MOVE to the personal vault?" — the same source `moveBytesToVault`
   *    and `FileViewer` read.
   *
   * The affordance gates below must use the WIDE one. Reading the narrow list
   * made them disagree with the refusal in exactly the wrong direction: outside
   * the shell, on first paint and permanently whenever `listChannels` fails,
   * every company row got its shield back and an all-company selection got the
   * batch Vault action back — which resolves bytes FIRST, so it downloads and
   * decrypts the whole selection to report "0 of N moved".
   */
  // Subscribed for REACTIVITY, then answered by the SHARED predicate.
  //
  // Reading `deptConversationIds` directly re-derived the refusal's question
  // with a narrower source than the refusal: `isDepartmentConversation` also
  // falls back to the `deptGroupByChannel` pointer map, which is exactly the
  // population that fallback exists for (an install upgraded from before this
  // registry existed). On that install every company row showed a shield the
  // choke point would refuse, and disagreed with the viewer it opens — which
  // uses the full predicate. One predicate, two subscriptions to re-render on.
  useMessengerStore(s => s.deptConversationIds);
  useMessengerStore(s => s.deptGroupByChannel);
  const canMoveToVault = (conversationId: string) => !isDepartmentConversation(conversationId);
  const removeMessage = useMessengerStore(s => s.removeMessage);
  const vaultFiles    = useVaultStore(s => s.files);
  const removeFromVault = useVaultStore(s => s.removeFile);

  /**
   * B-453 — the on-device Files browser is gated by the vault PIN.
   *
   * Founder: "even the phone vault must be password protected (4 pin or
   * biometric)". This screen listed every attachment on the device behind no
   * check at all while the cloud shelf two screens deeper was locked, so the
   * lock was decorative — the same bytes were one tap away.
   *
   * The check is the one VaultScreen already runs (`guardLock`): re-checked on
   * focus and on every foreground transition, because BiometricGate relocks the
   * store on background while a mounted screen keeps rendering its list.
   *
   * ENTITLEMENT: deliberately NOT routed through `openVault()`. That helper
   * TierGates on the Cloud Vault entitlement, so a Lite user would be bounced
   * to a paywall and the phone files would stay unprotected for exactly the
   * population with no cloud vault at all. The gate reads pin/unlock state
   * only; the CLOUD lane keeps its own entitlement check (the promo below).
   */
  const gateReturn = scopeToCompany ? 'MessengerHome' : 'Files';
  // The gate's answer. False until it has run and PASSED, so the list is never
  // painted before the check — including for the frames a `replace` animates.
  /**
   * The messenger Settings door, for the vault's biometric off-ramp.
   *
   * The workspace Vault tab MOUNTS MessengerSettings but had no way to reach
   * it: that stack's `MessengerHome` route is THIS screen, not the messenger
   * home with the gear. So the off-ramp the consent prompt promises was
   * registered-but-unreachable in the CPO/workspace shell — the promise was
   * still false exactly where it is hardest to notice. The gear lives here in
   * every shell so discoverability is the same everywhere.
   *
   * RESOLVED, and HIDDEN when nothing resolves — never a compiling dead tap.
   *
   * Adjacency (checked, not assumed): this door makes "Settings locks the vault
   * while Files sits beneath" reachable. `guardLock` below re-runs on EVERY
   * trigger — focus, AppState-active, the unlockedUntil deadline and
   * onFinishHydration — so coming back here after that lock routes to the lock
   * screen rather than showing a stale list.
   */
  const settingsNav = findNavigatorWithRoute(navigation, 'MessengerSettings');

  const [gateChecked, setGateChecked] = useState(false);
  // Re-render this screen whenever the lock deadline moves, so an unlock
  // expiring or a `lock()` fired from anywhere re-runs the guard below.
  const unlockedUntil = useVaultStore(s => s.unlockedUntil);
  // One route per lock episode: focus, AppState and the deadline effect can all
  // answer in the same commit, and two `replace` calls stack two transitions.
  const gateRoutedRef = useRef(false);
  const guardLock = useCallback(() => {
    // Rehydration is ASYNC. Before it lands `pinHash` is initialState's null —
    // indistinguishable from "no PIN" — so answering here would route a
    // real-PIN user into VaultNewPin and let a fresh setupPin CLOBBER the hash
    // they cannot recover. Decline; onFinishHydration below re-runs this.
    if (!vaultHydrated()) {return;}
    const vault = useVaultStore.getState();
    if (vault.isUnlocked()) {
      gateRoutedRef.current = false;
      setGateChecked(true);
      return;
    }
    // Hide the list the instant the store relocks, not when navigation settles.
    setGateChecked(false);
    if (gateRoutedRef.current) {return;}
    gateRoutedRef.current = true;
    // A PIN keypad is meaningless with no PIN set (Issue 20) — send a
    // first-time user to setup instead, and back here once it lands.
    if (vault.hasPin()) {navigation.replace('VaultLock', {next: gateReturn});}
    else {navigation.replace('VaultNewPin', {next: gateReturn});}
  }, [navigation, gateReturn]);

  useFocusEffect(guardLock);

  useEffect(() => {
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active' && navigation.isFocused()) {guardLock();}
    });
    return () => sub.remove();
  }, [guardLock, navigation]);

  useEffect(() => {
    // AppState alone cannot carry this. BiometricGate relocks AFTER an await,
    // i.e. a later tick than the background transition, and `lock()` can be
    // fired from anywhere while this screen never loses focus. The 5-minute
    // window expiring under a user sitting here fires no event at all — hence
    // the timer to the deadline itself.
    if (!navigation.isFocused()) {return;}
    guardLock();
    if (unlockedUntil === null) {return;}
    const ms = unlockedUntil - Date.now();
    if (ms <= 0) {return;}
    const t = setTimeout(() => { if (navigation.isFocused()) {guardLock();} }, ms + 50);
    return () => clearTimeout(t);
  }, [unlockedUntil, guardLock, navigation]);

  useEffect(() => {
    const p = vaultPersistApi();
    if (!p?.onFinishHydration || p.hasHydrated?.()) {return;}
    return p.onFinishHydration(() => { if (navigation.isFocused()) {guardLock();} });
  }, [guardLock, navigation]);

  // Set of vault handles: real rows carry `sourceKey` (`msg:<id>`) while
  // legacy rows used the message id AS the objectKey — index both so the
  // dupe check stays O(1) per row.
  const vaultKeys = useMemo(
    () => new Set(vaultFiles.flatMap(f => (f.sourceKey ? [f.objectKey, f.sourceKey] : [f.objectKey]))),
    [vaultFiles],
  );

  const rows = useMemo<FileRow[]>(() => {
    const out: FileRow[] = [];
    for (const m of mediaMessages) {
      const bucket = bucketFor(m);
      if (!bucket) {continue;}
      const convId = m.conversation_id;
      // Scope v2 Phase 4 — INSIDE THE WORKSPACE this screen is the Vault tab's
      // landing route (DepartmentalNavigator names it 'MessengerHome' so
      // VaultLock's back-exit still resolves). `selectMediaMessages` spans
      // EVERY conversation on the device, so without this the first screen of
      // the company Vault listed the user's DMs and personal groups beside
      // company files — the exact "never mixed" rule this phase exists to
      // enforce, broken on the surface the plan itself assigns to A10/M11B.
      // Outside the shell the screen keeps its full personal scope.
      if (scopeToCompany && !companyConvIds.has(convId)) {continue;}
      const conv = conversations[convId];
      const source = conv?.name ?? conv?.peer?.userId ?? 'Unknown';
      out.push({
        id:             m.id,
        conversationId: convId,
        // Media-parity M14 — real filename / caption / type fallback.
        name:           m.media_meta?.name || m.content || (bucket === 'img' ? 'Photo' : 'Attachment'),
        // Media-parity — real size now travels in media_meta.
        sizeBytes:      m.media_meta?.sizeBytes ?? 0,
        mimeType:       m.media_mime ?? '',
        senderLabel:    m.sender_id === 'self' ? 'You' : source,
        source,
        createdAt:      new Date(m.created_at).getTime(),
        mediaUrl:       m.media_url,
        // Carry the encrypted-attachment fields so the Files tab can
        // actually OPEN a received attachment (M2). Before, canView was
        // gated on media_url which is only set for the sender's own picks.
        mediaObjectKey: m.media_object_key,
        mediaKey:       m.media_key,
        mediaIv:        m.media_iv,
        tab:            bucket,
        inVault:        vaultKeys.has(`msg:${m.id}`),
      });
    }
    // mediaMessages is already sorted newest-first by the selector.
    return out;
    // `companyConvIds` and `scopeToCompany` are load-bearing deps: without them
    // the memo keeps a list built under the PREVIOUS membership answer, so a
    // removed member's files stay on screen until some other input changes.
  }, [mediaMessages, conversations, vaultKeys, companyConvIds, scopeToCompany]);

  const counts = useMemo(() => ({
    all:   rows.length,
    docs:  rows.filter(r => r.tab === 'docs').length,
    img:   rows.filter(r => r.tab === 'img').length,
    vid:   rows.filter(r => r.tab === 'vid').length,
    voice: rows.filter(r => r.tab === 'voice').length,
  }), [rows]);

  // ---- Albums (founder 2026-08-08) -------------------------------------
  const albums = useFileAlbumStore(st => st.albums);
  const assignments = useFileAlbumStore(st => st.assignments);
  const albumActions = useFileAlbumStore.getState;
  const [albumFilter, setAlbumFilter] = useState<AlbumFilter>(undefined);
  /**
   * Has the user picked a chip themselves? Until they do, the default is
   * DERIVED (below) rather than stored, so it can still settle once the
   * persisted album store hydrates.
   */
  const [filterTouched, setFilterTouched] = useState(false);
  /**
   * B-607 r2 — once folders exist, the browser opens on UNFILED, not All.
   *
   * Founder, twice: "moving files into a folder only creates a duplicate, it
   * doesn't move them." Nothing is duplicated — `assignments` is single-valued
   * and the founder's own screenshot proves it (`All 2 · Test 1 2 ·
   * Unfiled 0`). But All lists every file whatever its folder, so a move left
   * the rows exactly where they were and put the same count on two chips,
   * which reads as four files and as a copy.
   *
   * A screen called Files, with a folder icon and the word "move", promises
   * folder semantics: filing something must take it OUT of where you were.
   * That is only true if the default view excludes filed files. All stays one
   * tap away as the flat library view.
   *
   * Derived, not initial state: albums arrive from a persisted store, so an
   * initialiser would read an empty list on the first render and stick on All.
   * With no folders yet, Unfiled IS the whole library, so the default stays
   * All and nothing changes for a user who has never made one.
   */
  const effectiveFilter: AlbumFilter =
    filterTouched ? albumFilter : (albums.length > 0 ? null : undefined);
  /** Every chip press is a user choice — it pins the filter against the default. */
  const chooseFilter = useCallback((next: AlbumFilter) => {
    setFilterTouched(true);
    setAlbumFilter(next);
  }, []);
  /**
   * `fileSelection` is the ORIGIN of a create, not a re-derivation of state.
   * Only the move sheet's create lane may file the live selection into the new
   * album; the album bar's "+ New" is a plain create and must never move the
   * user's files as a side effect. Today the bar is only rendered outside
   * selection mode, so reading `selected` at the decision site happens to be
   * right — but that is a RENDERING accident, and the day the bar is shown in
   * selection mode "+ New" would silently file everything with no way back.
   */
  const [namingAlbum, setNamingAlbum] = useState<
    {mode: 'create'; fileSelection: boolean} | {mode: 'rename'; album: Album} | null
  >(null);
  const [movePicker, setMovePicker] = useState(false);

  const filesAlbumState = useMemo(() => ({albums, assignments}), [albums, assignments]);
  const albumNameById = useMemo(() => new Map(albums.map(a => [a.id, a.name])), [albums]);

  /**
   * B-451 / B-452 — assignments are dropped ONLY for the files we just deleted.
   *
   * This replaces a view-driven sweep (`prune(rows.map(r => r.id))` on every
   * `rows` change) that DELETED every assignment outside the current list and
   * persisted it immediately. `rows` is never the whole album key space:
   *
   *   - it is empty on a cold boot until SQLCipher message hydration lands,
   *     which wiped the entire map on launch;
   *   - the store hydrates at most MAX_HYDRATE_PER_CONVO (200) messages per
   *     conversation, so older files silently lost their album;
   *   - inside the workspace shell this screen filters to company
   *     conversations (and `companyConvIds` fails closed to empty), so merely
   *     focusing the Vault tab unfiled every PERSONAL file.
   *
   * That is what "moved 4, only 1 stuck" and "it copies instead of moving"
   * actually were. No view can safely authorise a delete here, so none does:
   * an ORPHANED assignment is invisible (every read in `fileAlbums.ts` is
   * existence-aware) and costs a few bytes, while a DESTROYED one is silent,
   * unrecoverable loss of the user's own organisation.
   *
   * `move(ids, null)` is the unfile primitive — it touches exactly these ids.
   */
  const forgetAlbumAssignments = (ids: readonly string[]) => {
    if (ids.length > 0) {albumActions().move(ids, null);}
  };

  const counts2 = useMemo(() => albumCounts(filesAlbumState, rows.map(r => r.id)), [filesAlbumState, rows]);

  // Album filter is applied BEFORE the type tab, so the DOCS/IMG/VID counts
  // above keep describing the whole library rather than the open album.
  const visible = useMemo(() => {
    const byTab = rows.filter(r => tab === 'all' ? true : r.tab === tab);
    const byAlbum = effectiveFilter === undefined
      ? byTab
      : (() => {
          const keep = new Set(itemsInAlbum(filesAlbumState, effectiveFilter, byTab.map(r => r.id)));
          return byTab.filter(r => keep.has(r.id));
        })();
    // Search runs LAST so the tab counts and album counts keep describing the
    // whole library, matching how the album filter already composes with tabs.
    const q = query.trim().toLocaleLowerCase();
    if (!searchOpen || q.length === 0) {return byAlbum;}
    return byAlbum.filter(r =>
      r.name.toLocaleLowerCase().includes(q) ||
      r.source.toLocaleLowerCase().includes(q) ||
      r.senderLabel.toLocaleLowerCase().includes(q) ||
      r.mimeType.toLocaleLowerCase().includes(q));
  }, [rows, tab, effectiveFilter, filesAlbumState, searchOpen, query]);

  // An album the user deletes (or that never existed) must not strand the list
  // on an empty filter with no way back.
  useEffect(() => {
    if (typeof albumFilter === 'string' && !albums.some(a => a.id === albumFilter)) {
      setAlbumFilter(undefined);
      setFilterTouched(false);
    }
  }, [albums, albumFilter]);

  // Hardware back exits selection mode instead of leaving the screen.
  // NAV-05 (2026-08-26 audit) — useFocusEffect, NOT useEffect: this screen
  // stays mounted under pushed routes, and a mount-scoped handler here ate the
  // first back press on every screen above it while a selection was active
  // (the beforeRemove companion below was already correctly route-scoped —
  // this now matches it).
  useFocusEffect(useCallback(() => {
    if (!selectionMode) {return;}
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelected(null);
      return true;
    });
    return () => sub.remove();
  }, [selectionMode]));

  // B-368 — the hardware-key handler above never fires on iOS (no hardware
  // back) nor for the native-stack swipe gesture on Android (BS-022
  // mechanism), so a swipe-back popped the screen with the selection still
  // active. beforeRemove is the only cross-platform intercept: back-shaped
  // removals (GO_BACK / POP — the gesture, the header arrow, goBack) exit
  // selection instead; programmatic removals (RESET / REPLACE, e.g.
  // sign-out) pass through untouched. No overlap with the BackHandler:
  // when it consumes the key, no nav action is dispatched at all.
  useEffect(() => {
    if (!selectionMode) {return;}
    return navigation.addListener('beforeRemove', e => {
      const t = e.data?.action?.type;
      if (t !== 'GO_BACK' && t !== 'POP') {return;}
      e.preventDefault();
      setSelected(null);
    });
  }, [selectionMode, navigation]);

  // Plaintext bytes for a row — the cached encrypted blob (decrypt) for
  // received attachments, or the sender's local pick.
  const resolveRowBytes = async (r: FileRow): Promise<Uint8Array | null> => {
    if (r.mediaObjectKey && r.mediaKey && r.mediaIv) {
      const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
      const rt = await getMessengerRuntime('production');
      if (rt.downloadMedia) {
        return (await rt.downloadMedia({objectKey: r.mediaObjectKey, keyB64: r.mediaKey, ivB64: r.mediaIv})) ?? null;
      }
      return null;
    }
    if (r.mediaUrl) {
      return readUriBytes(r.mediaUrl);
    }
    return null;
  };

  // B-86 — one MFA-gated move at a time (proofs are single-use).
  const vaultBusyRef = useRef(false);
  const pushToVault = (r: FileRow) => {
    const row = findVaultRow(vaultFiles, `msg:${r.id}`);
    if (row) {
      Alert.alert(
        'Already in vault',
        'Remove it from the vault?',
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Remove', style: 'destructive', onPress: () => removeFromVault(row.objectKey)},
        ],
      );
      return;
    }
    if (vaultBusyRef.current) {return;}
    vaultBusyRef.current = true;
    // B-86 — real pipeline (audit S1 stub retired): resolve the plaintext
    // bytes (cached encrypted blob → decrypt, or the sender's local pick),
    // then biometric ceremony → single-use MFA action token → VaultClient
    // encrypt-and-upload. Fails CLOSED with an honest alert; the store
    // refuses key-less rows (M-02) as defense in depth.
    void (async () => {
      try {
        const bytes = await resolveRowBytes(r);
        if (!bytes) {
          Alert.alert('Not moved to vault', 'No local or downloadable copy of this file is available.');
          return;
        }
        const res = await moveBytesToVault({
          sourceKey: `msg:${r.id}`,
          name:      r.name,
          mimeType:  r.mimeType || 'application/octet-stream',
          bytes,
          conversationId: r.conversationId,
        });
        if (res.ok) {
          haptics.impact();
        } else if (res.reason === 'tier') {
          // B-591 — a lapsed Pro is a billing state, not an MFA failure.
          showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
        } else if (res.reason !== 'cancelled') {
          Alert.alert('Not moved to vault', res.message);
        }
      } catch (e) {
        Alert.alert('Not moved to vault', e instanceof Error ? e.message : 'Could not read the file.');
      } finally {
        vaultBusyRef.current = false;
      }
    })();
  };

  /**
   * The selected ids RESOLVED to rows — deliberately a different authority from
   * `selected`, and only for the three actions that need a row's bytes.
   *
   * Delete, share and move-to-vault must read `mediaObjectKey` / `mediaKey` /
   * `mediaIv` / `conversationId` off the row, so an id with no row in view is
   * not actionable by them and dropping it is correct. Everything that is pure
   * METADATA — the header count, the move sheet's count, and the album move
   * itself — reads `selected` instead, because an album assignment needs no
   * bytes and silently filing three of four files is B-452.
   */
  const selectedRows = useMemo(
    () => (selected ? rows.filter(r => selected.has(r.id)) : []),
    [rows, selected],
  );

  /**
   * Direct device→vault upload (founder 2026-08-26) — the same real pipeline
   * VaultScreen uses: read bytes → biometric ceremony → single-use MFA token →
   * encrypt → R2. Uploads always write the PERSONAL vault, so the entry point
   * is hidden inside the workspace shell (same rule as VaultScreen's header
   * button). The uploaded row lives in the vault index, not this message-
   * derived list — the success alert offers the jump.
   */
  const uploadOneToVault = async (
    asset: {uri: string; name: string; mimeType: string},
    index: number,
  ): Promise<{ok: true} | {ok: false; cancelled?: boolean; tier?: boolean; message?: string}> => {
    try {
      const bytes = await readUriBytes(asset.uri);
      const res = await moveBytesToVault({
        // Index keeps a same-millisecond batch from collapsing into one row.
        sourceKey: `local:${Date.now()}:${index}`,
        name:      asset.name,
        mimeType:  asset.mimeType,
        bytes,
        conversationId: null,
      });
      if (res.ok) {return {ok: true};}
      if (res.reason === 'tier') {return {ok: false, tier: true};}
      return res.reason === 'cancelled'
        ? {ok: false, cancelled: true}
        : {ok: false, message: res.message};
    } catch (e) {
      return {ok: false, message: e instanceof Error ? e.message : 'Could not read the file.'};
    }
  };

  const uploadManyToVault = async (assets: Array<{uri: string; name: string; mimeType: string}>) => {
    if (uploadBusy || assets.length === 0) {return;}
    setUploadBusy(true);
    const failed: string[] = [];
    let saved = 0;
    let tierBlocked = false;
    try {
      for (const [i, asset] of assets.entries()) {
        const res = await uploadOneToVault(asset, i);
        if (res.ok) {
          saved += 1;
        } else if (res.tier === true) {
          // One upgrade ask; never another biometric ceremony for the rest.
          tierBlocked = true;
          break;
        } else if (res.cancelled !== true) {
          failed.push(asset.name);
        }
      }
    } finally {
      setUploadBusy(false);
    }
    if (tierBlocked) {
      showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
      return;
    }
    if (failed.length > 0) {
      Alert.alert(
        saved > 0 ? 'Some files not saved' : 'Upload failed',
        `${saved} of ${assets.length} saved to your vault.\n\nNot saved:\n• ${failed.join('\n• ')}\n\nTry those again.`,
      );
    } else if (saved > 0) {
      haptics.impact();
      Alert.alert(
        saved === 1 ? 'Saved to your File Vault' : `${saved} files saved to your File Vault`,
        'Encrypted on this device before upload.',
        [
          {text: 'Open Vault', onPress: () => { openVault(navigation); }},
          {text: 'Done', style: 'cancel'},
        ],
      );
    }
  };

  const pickUploadDocument = async () => {
    try {
      // Why the join: a literal any-mime glob contains the block-comment
      // opener, and sourceScanSafety forbids NEW files whose strings get
      // eaten by comment-stripping source scans.
      const anyMime = ['*', '*'].join('/');
      const res = await DocumentPicker.getDocumentAsync({type: anyMime, copyToCacheDirectory: true, multiple: true});
      if (res.canceled) {return;}
      const picked = (res.assets ?? []).filter(a => typeof a.uri === 'string' && a.uri.length > 0);
      if (picked.length === 0) {return;}
      await uploadManyToVault(picked.map((a, i) => ({
        uri: a.uri, name: a.name ?? `document-${i + 1}`, mimeType: a.mimeType ?? 'application/octet-stream',
      })));
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Could not open document picker');
    }
  };

  const pickUploadImage = async () => {
    try {
      const res = await launchImageLibrary({mediaType: 'photo', selectionLimit: 0, includeBase64: false});
      if (res.didCancel === true) {return;}
      const picked = (res.assets ?? []).filter(a => typeof a.uri === 'string' && a.uri.length > 0);
      if (picked.length === 0) {return;}
      await uploadManyToVault(picked.map((a, i) => ({
        uri: a.uri as string, name: a.fileName ?? `photo-${i + 1}.jpg`, mimeType: a.type ?? 'image/jpeg',
      })));
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Could not open image picker');
    }
  };

  const promptUpload = () => {
    if (scopeToCompany || uploadBusy) {return;}
    if (!entitlements.hasCloudVault) {
      showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
      return;
    }
    Alert.alert('Add to File Vault', 'Pick from this device — files encrypt locally before upload.', [
      {text: 'Choose document', onPress: () => { void pickUploadDocument(); }},
      {text: 'Choose photos', onPress: () => { void pickUploadImage(); }},
      {text: 'Cancel', style: 'cancel'},
    ]);
  };

  const batchVault = () => {
    if (batchBusy !== null || selectedRows.length === 0) {return;}
    if (!entitlements.hasCloudVault) {
      showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
      return;
    }
    if (vaultBusyRef.current) {return;}
    vaultBusyRef.current = true;
    setBatchBusy('vault');
    void (async () => {
      try {
        const out = await runBatchVaultMove(selectedRows, {
          resolveBytes: resolveRowBytes,
          moveToVault:  moveBytesToVault,
          // Provenance per row — the batch lane is one of the four ways a
          // company file could have been copied into the personal vault.
        });
        if (out.fatalReason === 'tier') {
          // B-591 — one honest upgrade ask, never a security-sounding alert.
          showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
        } else if (out.fatal) {
          Alert.alert('Not moved to vault', out.fatal);
        } else if (out.failed.length > 0) {
          Alert.alert(
            out.moved > 0 ? 'Some files not moved' : 'Not moved to vault',
            `${out.moved} of ${selectedRows.length} moved to your vault.\n\nNot moved:\n• ${out.failed.join('\n• ')}`,
          );
        } else if (out.moved > 0 && !out.cancelled) {
          haptics.impact();
          setSelected(null);
        } else if (out.moved === 0 && out.alreadyInVault > 0 && !out.cancelled) {
          Alert.alert('Already in vault', 'Every selected file is already in your vault.');
        }
      } finally {
        vaultBusyRef.current = false;
        setBatchBusy(null);
      }
    })();
  };

  const batchShare = () => {
    if (batchBusy !== null || selectedRows.length === 0) {return;}
    setBatchBusy('share');
    void (async () => {
      try {
        if (!(await Sharing.isAvailableAsync())) {
          Alert.alert('Sharing unavailable', 'This device has no app to share to.');
          return;
        }
        const out = await runBatchShare(selectedRows, {
          resolveUri: async r => {
            if (r.mediaUrl) {return r.mediaUrl;}
            if (r.mediaObjectKey && r.mediaKey && r.mediaIv) {
              return resolveAttachmentFileUri({
                id:               r.id,
                media_object_key: r.mediaObjectKey,
                media_key:        r.mediaKey,
                media_iv:         r.mediaIv,
                media_mime:       r.mimeType || undefined,
                media_meta:       {sizeBytes: r.sizeBytes},
              });
            }
            return null;
          },
          // expo-sharing has no multi-file intent — one sheet per file, in order.
          share: (uri, f) => Sharing.shareAsync(uri, {mimeType: f.mimeType || undefined, dialogTitle: f.name}),
        });
        if (out.failed.length > 0) {
          Alert.alert('Not all files shared', `Could not share:\n• ${out.failed.join('\n• ')}`);
        } else if (out.shared > 0) {
          setSelected(null);
        }
      } finally {
        setBatchBusy(null);
      }
    })();
  };

  const batchDelete = () => {
    if (batchBusy !== null || selectedRows.length === 0) {return;}
    const n = selectedRows.length;
    Alert.alert(
      n === 1 ? 'Delete file?' : `Delete ${n} files?`,
      n === 1
        ? 'This removes it from this device. Any recipient who already received it keeps their copy.'
        : 'This removes them from this device. Any recipient who already received them keeps their copy.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Delete', style: 'destructive', onPress: () => {
          runBatchDelete(selectedRows, {
            removeMessage,
            vaultObjectKeyFor: f => findVaultRow(vaultFiles, `msg:${f.id}`)?.objectKey ?? null,
            removeVaultRow:    removeFromVault,
          });
          // The only place a Files row is knowingly destroyed — the one moment
          // an album assignment may be dropped (see forgetAlbumAssignments).
          forgetAlbumAssignments(selectedRows.map(r => r.id));
          haptics.heavy();
          setSelected(null);
        }},
      ],
    );
  };

  // The gate has not passed (yet, or any more). Paint the surface and nothing
  // else: every frame the `replace` transition animates would otherwise show a
  // fully readable index of every attachment on the device — which is the exact
  // thing the PIN exists to withhold.
  if (!gateChecked) {
    return (
      <View style={[styles.root, {paddingTop: insets.top}]}>
        <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
        <AmbientBg bg={OB.bg} />
      </View>
    );
  }

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />

      {/* Header — swaps to the selection toolbar in selection mode */}
      <View style={styles.header}>
        {selectionMode ? (
          <>
            <TouchableOpacity
              onPress={() => setSelected(null)}
              activeOpacity={0.7}
              hitSlop={{top: 10, left: 10, right: 10, bottom: 10}}
              accessibilityRole="button"
              accessibilityLabel="Exit selection"
              style={styles.hBtn}>
              <Icon name="close" size={20} color={OB.text} />
            </TouchableOpacity>
            {/* ONE authority for "how many are selected": the same `selected`
                set the move sheet counts and files. `selectedRows` is `rows`
                filtered by the company scope, so inside the workspace shell the
                header read a smaller number than the move sheet acted on — the
                user was told "1 SELECTED" and four files moved. */}
            <Text style={[styles.wordmark, styles.selTitle]} numberOfLines={1}>
              {selected?.size ?? 0} SELECTED
            </Text>
            <TouchableOpacity
              onPress={() => setSelected(prev => selectAllVisible(prev ?? new Set<string>(), visible.map(v => v.id)))}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Select all"
              style={[styles.hBtn, styles.hBtnAccent]}>
              <Icon name="checkbox-multiple-marked-outline" size={19} color={OB.accentSoft} />
            </TouchableOpacity>
          </>
        ) : (
          <>
            <TouchableOpacity
              onPress={() => goBackOnce(navigation)}
              activeOpacity={0.7}
              hitSlop={{top: 10, left: 10, right: 10, bottom: 10}}
              style={styles.hBtn}>
              <Icon name="chevron-left" size={20} color={OB.text} />
            </TouchableOpacity>
            <Text style={styles.wordmark} numberOfLines={1}>FILES</Text>
            {settingsNav ? (
              <TouchableOpacity
                onPress={() => navigateVia(settingsNav, 'MessengerSettings')}
                activeOpacity={0.7}
                hitSlop={{top: 10, left: 10, right: 10, bottom: 10}}
                accessibilityRole="button"
                accessibilityLabel="Messenger settings"
                style={[styles.hBtn, styles.hBtnAccent]}>
                <Icon name="cog-outline" size={19} color={OB.accentSoft} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              onPress={() => {
                if (searchOpen) {setQuery('');}
                setSearchOpen(!searchOpen);
              }}
              activeOpacity={0.7}
              hitSlop={{top: 10, left: 10, right: 10, bottom: 10}}
              accessibilityRole="button"
              accessibilityLabel={searchOpen ? 'Close file search' : 'Search files'}
              style={[styles.hBtn, styles.hBtnAccent, searchOpen && styles.hBtnActive]}>
              <Icon name={searchOpen ? 'close' : 'magnify'} size={19} color={OB.accentSoft} />
            </TouchableOpacity>
          </>
        )}
      </View>

      {searchOpen && !selectionMode && (
        <View style={styles.searchRow}>
          <Icon name="magnify" size={16} color={OB.textDim} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search files, folders, chats…"
            placeholderTextColor={OB.textDim}
            autoFocus
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Search files"
            style={styles.searchInput}
          />
          {query.length > 0 && (
            <TouchableOpacity
              onPress={() => setQuery('')}
              hitSlop={{top: 8, left: 8, right: 8, bottom: 8}}
              accessibilityRole="button"
              accessibilityLabel="Clear file search">
              <Icon name="close-circle" size={16} color={OB.textDim} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Filter tabs */}
      <View style={styles.tabRow}>
        {TAB_META.map(t => {
          const on = tab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={styles.tab}
              onPress={() => setTab(t.key)}
              activeOpacity={0.8}>
              <Text style={[styles.tabName, on && styles.tabNameActive]} numberOfLines={1}>{t.label}</Text>
              <Text style={[styles.tabCount, on && styles.tabCountActive]}>{counts[t.key]}</Text>
              {on ? <View style={styles.tabUnderline} /> : null}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Albums — hidden in selection mode, where the header is already a
          toolbar and the destination picker is the batch action instead. */}
      {!selectionMode && (
        <AlbumBar
          albums={albums}
          counts={counts2}
          total={rows.length}
          active={effectiveFilter}
          onSelect={chooseFilter}
          onCreate={() => setNamingAlbum({mode: 'create', fileSelection: false})}
          onManage={album => setNamingAlbum({mode: 'rename', album})}
        />
      )}

      <ScrollView
        style={{flex: 1}}
        // Why: when the Messenger footer hosts beneath this list it already pads
        // the safe-area inset — adding it here again is the B-245 double-count
        // (a dead gap the height of the nav bar above the footer).
        contentContainerStyle={[styles.scroll, {paddingBottom: (!scopeToCompany && !selectionMode ? 0 : insets.bottom) + 24}]}
        showsVerticalScrollIndicator={false}>

        {visible.length === 0 ? (
          <View style={styles.emptyWrap}>
            <TouchableOpacity
              style={styles.dropTile}
              onPress={promptUpload}
              disabled={scopeToCompany || uploadBusy}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Upload a file to your vault">
              {/* Dashed drop-zone ring via SVG — RN's borderStyle:'dashed' renders
                  solid on Android when combined with borderRadius, so draw it here. */}
              <Svg width={116} height={116} style={StyleSheet.absoluteFill}>
                <Rect
                  x={1.5}
                  y={1.5}
                  width={113}
                  height={113}
                  rx={28.5}
                  ry={28.5}
                  fill="none"
                  stroke="rgba(91,141,239,0.45)"
                  strokeWidth={1.5}
                  strokeDasharray="6 5"
                />
              </Svg>
              {uploadBusy
                ? <ActivityIndicator size="small" color="#A9C5FF" />
                : <Icon name="folder-outline" size={46} color="#A9C5FF" />}
              {!scopeToCompany && !uploadBusy && (
                <View style={styles.dropTilePlus}>
                  <Icon name="plus" size={14} color="#07090D" />
                </View>
              )}
            </TouchableOpacity>
            {/* B-607 r2 — "Unfiled is empty" is a DIFFERENT state from "you
                have no files", and showing the send-an-attachment copy to
                someone whose files are all in folders reads as data loss.
                Name the real situation and point at the folders. */}
            {searchOpen && query.trim().length > 0 ? (
              <>
                <Text style={styles.emptyTitle}>No matches</Text>
                <Text style={styles.emptyHint}>
                  No file, folder or chat matches “{query.trim()}”.
                </Text>
              </>
            ) : effectiveFilter === null && albums.length > 0 && rows.length > 0 ? (
              <>
                <Text style={styles.emptyTitle}>Everything is filed</Text>
                <Text style={styles.emptyHint}>
                  {rows.length === 1 ? 'Your file is' : `All ${rows.length} files are`} in a folder above.
                  Tap a folder to open it, or All to see everything at once.
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.emptyTitle}>No files yet</Text>
                <Text style={styles.emptyHint}>
                  {scopeToCompany
                    ? 'Send an attachment from any chat — it encrypts locally, uploads to R2, and appears here.'
                    : 'Tap the folder to upload from this device, or send an attachment from any chat — everything encrypts locally before upload.'}
                </Text>
              </>
            )}
            <View style={styles.chipRow}>
              <TrustChip label="End-to-end encrypted" fg={OB.accentSoft} border="rgba(91,141,239,0.3)" />
              <TrustChip label="R2 storage" fg={OB.textDim} border={OB.hair2} />
            </View>
          </View>
        ) : (
          <>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionLabel}>Recent Files · {visible.length}</Text>
              {!scopeToCompany && !selectionMode && (
                <TouchableOpacity
                  onPress={promptUpload}
                  disabled={uploadBusy}
                  hitSlop={{top: 8, left: 8, right: 8, bottom: 8}}
                  accessibilityRole="button"
                  accessibilityLabel="Upload a file to your vault"
                  style={styles.uploadLink}>
                  {uploadBusy
                    ? <ActivityIndicator size="small" color={OB.accentSoft} />
                    : (
                      <>
                        <Icon name="plus" size={13} color={OB.accentSoft} />
                        <Text style={styles.uploadLinkText}>UPLOAD</Text>
                      </>
                    )}
                </TouchableOpacity>
              )}
            </View>
            {visible.map(f => {
              const iconConf = iconFor(f);
              // Media-parity M2 — openable when we have EITHER the local pick
              // (sender) OR the encrypted object reference (received).
              const canView = !!f.mediaUrl || !!(f.mediaObjectKey && f.mediaKey && f.mediaIv);
              const isSel = selected?.has(f.id) ?? false;
              // B-451 — no row ever showed its album, so a successful move
              // changed nothing on screen and read as "it made a copy". A file
              // filed under a DELETED album resolves to nothing, matching
              // `itemsInAlbum`'s Unfiled rule rather than showing a dead id.
              const albumName = albumNameById.get(albumOf(filesAlbumState, f.id) ?? '') ?? null;
              return (
                <TouchableOpacity
                  key={f.id}
                  style={[styles.fileRow, isSel && styles.fileRowSelected]}
                  activeOpacity={0.8}
                  accessibilityState={{selected: isSel}}
                  onLongPress={() => {
                    if (!selectionMode) {
                      haptics.tap();
                      setSelected(new Set([f.id]));
                    }
                  }}
                  onPress={() => {
                    if (selectionMode) {
                      setSelected(prev => (prev ? toggleSelected(prev, f.id) : prev));
                      return;
                    }
                    if (!canView) {return;}
                    setViewerFile({
                      id:               f.id,
                      conversationId:   f.conversationId,
                      name:             f.name,
                      media_url:        f.mediaUrl,
                      media_object_key: f.mediaObjectKey,
                      media_key:        f.mediaKey,
                      media_iv:         f.mediaIv,
                      media_mime:       f.mimeType || (f.tab === 'img' ? 'image/jpeg' : f.tab === 'vid' ? 'video/mp4' : f.tab === 'voice' ? 'audio/mp4' : 'application/octet-stream'),
                      sizeBytes:        f.sizeBytes,
                      createdAt:        f.createdAt,
                    });
                  }}>
                  <View style={[styles.fileIcon, {backgroundColor: iconConf.bg, borderColor: iconConf.border}]}>
                    <Icon name={iconConf.name} size={20} color={iconConf.color} />
                  </View>
                  <View style={styles.fileInfo}>
                    <Text style={styles.fileName} numberOfLines={1}>{f.name}</Text>
                    <Text style={styles.fileMeta} numberOfLines={1}>{f.sizeBytes ? humanSize(f.sizeBytes) + ' · ' : ''}{f.senderLabel}</Text>
                    <Text style={styles.fileSource} numberOfLines={1}>{f.source}</Text>
                    {albumName ? <Text style={styles.fileAlbum} numberOfLines={1}>{albumName}</Text> : null}
                  </View>
                  <View style={styles.fileRight}>
                    {selectionMode ? (
                      <View style={[styles.selRing, isSel && styles.selRingOn]}>
                        {isSel ? <Icon name="check-bold" size={13} color="#0B0E14" /> : null}
                      </View>
                    ) : (
                      <>
                        <Text style={styles.fileTime}>{relativeTime(f.createdAt)}</Text>
                        {/* Scope v2 Phase 4 — no vault shield on a COMPANY row.
                            `moveBytesToVault` refuses these, so the button could
                            only ever fail; and inside the workspace shell EVERY
                            row is a company row, so it would be a dead
                            affordance on 100% of the list. Derived from the row,
                            matching FileViewer's own rule. */}
                        {canMoveToVault(f.conversationId) && <TouchableOpacity
                          style={[styles.vaultPushBtn, f.inVault && styles.vaultPushBtnActive]}
                          activeOpacity={0.7}
                          onPress={() => pushToVault(f)}
                          accessibilityRole="button"
                          accessibilityLabel={f.inVault ? 'Remove from vault' : 'Move to vault'}>
                          <Icon
                            name={f.inVault ? 'shield-check' : 'shield-plus-outline'}
                            size={16}
                            color={f.inVault ? OB.signal : GOLD}
                          />
                        </TouchableOpacity>}
                      </>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </>
        )}

        {/* File Vault promo — gold, stands apart from the blue system.
            B-91 M1 R7 — first-time entry shows the Cloud/Drive Vault prompt
            (spec p.10, exact copy): free 100MB, paid plans, or cancel. Once
            a PIN exists the vault opens directly as before. */}
        <VaultPromo
          count={vaultFiles.length}
          // Is there any row here the shield is actually offered on? On the
          // workspace Vault tab there is not — every row is a company file.
          canPushRows={rows.some(r => canMoveToVault(r.conversationId))}
          onOpen={() => {
            // M1A rule 12 — Cloud Vault is Pro+: a Lite tap gets the upgrade
            // ask, never the 100MB-free prompt (that free tier belongs to
            // paid plans; openVault would gate anyway — this keeps the first
            // dialog honest instead of a two-step dead end).
            if (!entitlements.hasCloudVault) {
              showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
              return;
            }
            if (!useVaultStore.getState().hasPin()) {
              Alert.alert(
                'Use Cloud/Drive Vault',
                'Store your files securely in the cloud. Your first 100MB is free.',
                [
                  {text: 'Continue with 100MB Free', onPress: () => { openVault(navigation); }},
                  {text: 'View Storage Plans', onPress: () => navigation.navigate('FileVaultPurchase')},
                  {text: 'Cancel', style: 'cancel'},
                ],
              );
              return;
            }
            openVault(navigation);
          }}
        />

      </ScrollView>

      {/* Batch action bar — visible only in selection mode */}
      {selectionMode ? (
        <View style={[styles.batchBar, {paddingBottom: insets.bottom + 10}]}>
          {/* Scope v2 Phase 4 — the same rule the row shield follows. Company
              files are refused by `moveBytesToVault`, and the batch lane
              RESOLVES BYTES FIRST (download + AES-decrypt per file) and only
              then hits the refusal — so an all-company selection would download
              everything to report "0 of N moved". Inside the workspace shell
              every visible row is a company row, so this is the whole list.
              Hidden only when nothing in the selection could move; a mixed
              selection keeps it and the company rows fail individually. */}
          {selectedRows.some(r => canMoveToVault(r.conversationId)) && <BatchAction
            icon="shield-plus-outline"
            label="Vault"
            color={GOLD}
            busy={batchBusy === 'vault'}
            disabled={batchBusy !== null}
            onPress={batchVault}
          />}
          <BatchAction
            icon="folder-move-outline"
            label="Album"
            color={OB.accentSoft}
            busy={false}
            disabled={batchBusy !== null}
            onPress={() => setMovePicker(true)}
          />
          <BatchAction
            icon="share-variant-outline"
            label="Share"
            color={OB.accentSoft}
            busy={batchBusy === 'share'}
            disabled={batchBusy !== null}
            onPress={batchShare}
          />
          <BatchAction
            icon="trash-can-outline"
            label="Delete"
            color={OB.alert}
            busy={batchBusy === 'delete'}
            disabled={batchBusy !== null}
            onPress={batchDelete}
          />
        </View>
      ) : null}

      {/* Client feedback 2026-08-22 ("No Nav bar?") — Files is still a PUSH
          (its vault-PIN gate above uses navigation.replace and cannot embed in
          MessengerHome), but it now hosts the SAME persistent Messenger footer
          with Files lit, so the bar never vanishes inside Messenger. A
          Chats/Calls/News press pops back to MessengerHome carrying the tab as
          a route param (consumed once there). Not inside the Departmental
          workspace shell — that shell's own 5-tab bar already sits beneath this
          screen (it is the Vault tab root), and two footers would stack. Hidden
          during multi-select, where the batch action bar owns the bottom. */}
      {!scopeToCompany && !selectionMode ? (
        <MessengerTabBar
          navigation={navigation}
          insets={insets}
          activeTab="Files"
          onSelectTab={next => navigation.navigate('MessengerHome', {tab: next})}
          showChannels={canSeeChannelsFor(entitlements)}
        />
      ) : null}

      {/* Move a multi-selection into an album. Purely local metadata — it does
          NOT touch bytes, the vault, or the underlying chat message. */}
      <MoveToAlbumSheet
        visible={movePicker}
        count={selected?.size ?? 0}
        albums={albums}
        onClose={() => setMovePicker(false)}
        onPick={albumId => {
          // B-452 — file the ACTUAL selection. `selectedRows` is `rows` filtered
          // by the company scope, so any selected id that fell out of the view
          // between the tap and the move was dropped without a word: the user
          // selected four images and one arrived.
          const ids = Array.from(selected ?? []);
          // Close BEFORE the Alert below — on Android an Alert raised behind an
          // open Modal is invisible, which is how a failed move looked like a
          // silent no-op. (The same rule is NOT satisfiable in NameAlbumModal's
          // onSubmit: that modal closes only after onSubmit RETURNS, so its
          // failure Alert is raised behind it. Tracked, not fixed here.)
          setMovePicker(false);
          const error = albumActions().move(ids, albumId);
          if (error) {
            Alert.alert('Not moved', 'That album no longer exists. Create it again and try once more.');
            return;
          }
          setSelected(null);
          // Why: land IN the destination. The default view is `albumFilter ===
          // undefined` = All, which lists every file whatever its album, so a
          // move that worked left the rows exactly where they were and read as
          // "it copied them into the folder and left the originals" (founder,
          // 2026-08-21). The move sheet is a folder affordance; following it is
          // what makes the label model behave like the folder it looks like.
          chooseFilter(albumId);
          haptics.select();
        }}
        onCreate={() => { setMovePicker(false); setNamingAlbum({mode: 'create', fileSelection: true}); }}
      />

      <NameAlbumModal
        visible={namingAlbum !== null}
        title={namingAlbum?.mode === 'rename' ? 'Rename album' : 'New album'}
        initial={namingAlbum?.mode === 'rename' ? namingAlbum.album.name : ''}
        onClose={() => setNamingAlbum(null)}
        onSubmit={name => {
          if (namingAlbum?.mode === 'rename') {
            return albumActions().rename(namingAlbum.album.id, name);
          }
          const {id, error} = albumActions().create(name);
          // Creating FROM THE MOVE SHEET files the selection straight away —
          // otherwise the user names an album and lands back on an unchanged
          // list wondering whether it worked. Creating from the album bar is a
          // plain create and must move nothing, which is why the origin is
          // carried in `namingAlbum` rather than re-derived from `selected`.
          // B-452 — same rule as the picker above: the SELECTION, not the
          // scope-filtered view of it.
          if (id && namingAlbum?.mode === 'create' && namingAlbum.fileSelection
              && selected && selected.size > 0) {
            const moveError = albumActions().move(Array.from(selected), id);
            if (moveError) {
              Alert.alert('Album created, files not moved', 'Open the album picker and try again.');
            } else {
              setSelected(null);
              // Same rule as the picker above — follow the move into the album
              // that was just created, or the list looks unchanged.
              chooseFilter(id);
            }
          }
          return error;
        }}
      />

      {/* Shared image/video/audio viewer — action bar wires into vault +
          removes the underlying chat message on Delete. */}
      <AttachmentFileViewer
        target={viewerFile}
        onClose={() => setViewerFile(null)}
        onDelete={t => { removeMessage(t.conversationId, t.id); forgetAlbumAssignments([t.id]); }}
      />
    </View>
  );
}

function BatchAction({icon, label, color, busy, disabled, onPress}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  color: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.batchBtn, disabled && !busy && styles.batchBtnDisabled]}
      activeOpacity={0.7}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}>
      {busy
        ? <ActivityIndicator size="small" color={color} />
        : <Icon name={icon} size={20} color={color} />}
      <Text style={[styles.batchLabel, {color}]}>{label.toUpperCase()}</Text>
    </TouchableOpacity>
  );
}

function TrustChip({label, fg, border}: {label: string; fg: string; border: string}) {
  return (
    <View style={[styles.chip, {borderColor: border}]}>
      <View style={[styles.chipDot, {backgroundColor: fg}]} />
      <Text style={[styles.chipText, {color: fg}]}>{label}</Text>
    </View>
  );
}

function VaultPromo({count, onOpen, canPushRows}: {count: number; onOpen: () => void; canPushRows: boolean}) {
  return (
    <LinearGradient
      colors={['rgba(46,39,24,0.7)', 'rgba(20,20,17,0.6)']}
      start={{x: 0, y: 0}}
      end={{x: 1, y: 1}}
      style={styles.promo}>
      {/* gold corner glow */}
      <Halo size={140} color={GOLD} innerOpacity={0.14} midOpacity={0.04} style={styles.promoGlow} />
      <View style={styles.promoRow}>
        <View style={styles.promoIcon}>
          <Icon name="shield-lock-outline" size={24} color={GOLD} />
        </View>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={styles.promoTitle} numberOfLines={2}>{count} {count === 1 ? 'file' : 'files'} in your File Vault</Text>
          {/* The shield is hidden on company rows, so on the workspace Vault
              tab (where every row is one) this instruction was impossible to
              follow — the consumer of the affordance the shield gating
              removed. */}
          <Text style={styles.promoSub}>{canPushRows
            ? 'Tap the shield on any row to move it here · MFA per session'
            : 'Company files stay in your workspace · MFA per session'}</Text>
        </View>
      </View>
      <TouchableOpacity activeOpacity={0.85} onPress={onOpen} accessibilityRole="button" accessibilityLabel="Open File Vault">
        <LinearGradient
          colors={['#EBD9AE', GOLD, '#C9AB6F']}
          locations={[0, 0.6, 1]}
          start={{x: 0, y: 0}}
          end={{x: 0, y: 1}}
          style={styles.promoBtn}>
          <Icon name="shield-outline" size={16} color="#1A1710" />
          <Text style={styles.promoBtnText}>OPEN VAULT</Text>
        </LinearGradient>
      </TouchableOpacity>
    </LinearGradient>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},

  header: {flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16},
  hBtn: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  hBtnAccent: {backgroundColor: 'rgba(91,141,239,0.10)', borderColor: 'rgba(91,141,239,0.28)'},
  hBtnActive: {backgroundColor: 'rgba(91,141,239,0.22)', borderColor: 'rgba(91,141,239,0.5)'},
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginBottom: 10, paddingHorizontal: 12, minHeight: 40, paddingVertical: 6,
    borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1, borderColor: OB.hair2,
  },
  searchInput: {
    flex: 1, color: OB.text, fontFamily: BravoFont.regular, fontSize: 13.5,
    paddingVertical: 0,
  },
  sectionRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  uploadLink: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  uploadLinkText: {
    fontFamily: BravoFont.mono, fontSize: 9, fontWeight: '700', letterSpacing: 1.6,
    color: OB.accentSoft,
  },
  dropTilePlus: {
    position: 'absolute', right: 26, bottom: 24, width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#A9C5FF',
  },
  wordmark: {flex: 1, color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 24, letterSpacing: 3},

  tabRow: {flexDirection: 'row', paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: OB.hair},
  tab: {flex: 1, alignItems: 'center', paddingTop: 4, paddingBottom: 12, position: 'relative'},
  tabName: {textAlign: 'center', fontFamily: BravoFont.mono, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, color: OB.textMute},
  tabNameActive: {color: OB.text},
  tabCount: {fontFamily: BravoFont.bold, fontSize: 12, fontWeight: '700', color: OB.textMute, marginTop: 4},
  tabCountActive: {color: OB.accentSoft},
  tabUnderline: {
    position: 'absolute', bottom: -1, left: '22%', right: '22%', height: 2.5, borderRadius: 2,
    backgroundColor: OB.accent,
    shadowColor: OB.accent, shadowOffset: {width: 0, height: 0}, shadowOpacity: 0.9, shadowRadius: 6, elevation: 3,
  },

  scroll: {flexGrow: 1, paddingHorizontal: 20, paddingTop: 4},

  sectionLabel: {
    fontFamily: BravoFont.mono, fontSize: 9.5, fontWeight: '700', letterSpacing: 2.5,
    textTransform: 'uppercase', color: OB.textMute, paddingTop: 12, paddingBottom: 8,
  },

  fileRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: OB.hair},
  fileRowSelected: {backgroundColor: 'rgba(91,141,239,0.07)'},
  fileIcon: {width: 42, height: 42, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  fileInfo: {flex: 1, minWidth: 0},
  fileName: {fontFamily: BravoFont.bold, fontSize: 14, color: OB.text},
  fileMeta: {fontFamily: BravoFont.regular, fontSize: 11, color: OB.textDim, marginTop: 2},
  fileSource: {fontFamily: BravoFont.regular, fontSize: 11, color: OB.textDim, marginTop: 1},
  // The album a row is filed under — same row rhythm, accent colour so it
  // reads as a folder tag rather than a third piece of conversation metadata.
  fileAlbum: {fontFamily: BravoFont.mono, fontSize: 10, color: OB.accentSoft, letterSpacing: 0.5, marginTop: 2},
  fileRight: {alignItems: 'center', gap: 8, flexShrink: 0},
  fileTime: {fontFamily: BravoFont.mono, fontSize: 10, color: OB.textDim},
  vaultPushBtn: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(226,200,147,0.08)', borderWidth: 1, borderColor: 'rgba(226,200,147,0.25)',
  },
  vaultPushBtnActive: {backgroundColor: 'rgba(74,222,128,0.10)', borderColor: 'rgba(74,222,128,0.3)'},

  // Multi-select
  selTitle: {fontSize: 18, letterSpacing: 2},
  selRing: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: OB.textMute,
    alignItems: 'center', justifyContent: 'center',
  },
  selRingOn: {backgroundColor: OB.accent, borderColor: OB.accent},
  batchBar: {
    flexDirection: 'row', paddingTop: 10, paddingHorizontal: 12,
    borderTopWidth: 1, borderTopColor: OB.hair2, backgroundColor: 'rgba(12,16,24,0.98)',
  },
  batchBtn: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 6},
  batchBtnDisabled: {opacity: 0.45},
  batchLabel: {fontFamily: BravoFont.mono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1.5},

  // Empty state
  emptyWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 40, paddingBottom: 24},
  dropTile: {
    width: 116, height: 116, borderRadius: 30, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: OB.hair,
    overflow: 'hidden',
  },
  emptyTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 22, letterSpacing: -0.5, marginTop: 24},
  emptyHint: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 13.5, textAlign: 'center', lineHeight: 21, maxWidth: 290, marginTop: 8},
  chipRow: {flexDirection: 'row', gap: 8, marginTop: 24, justifyContent: 'center', flexWrap: 'wrap'},
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 6, paddingHorizontal: 12,
    borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1,
  },
  chipDot: {width: 5, height: 5, borderRadius: 3},
  chipText: {fontFamily: BravoFont.mono, fontSize: 9.5, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase'},

  // Gold File Vault promo
  promo: {borderRadius: 20, padding: 18, marginTop: 24, borderWidth: 1, borderColor: 'rgba(212,179,122,0.34)', overflow: 'hidden'},
  promoGlow: {position: 'absolute', top: -40, right: -30},
  promoRow: {flexDirection: 'row', alignItems: 'center', gap: 16},
  promoIcon: {
    width: 50, height: 50, borderRadius: 15, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    backgroundColor: 'rgba(212,179,122,0.12)', borderWidth: 1, borderColor: GOLD_BORDER,
  },
  promoTitle: {color: '#F4EAD4', fontFamily: BravoFont.extraBold, fontSize: 15.5, letterSpacing: -0.2},
  promoSub: {color: 'rgba(226,200,147,0.7)', fontFamily: BravoFont.regular, fontSize: 12, marginTop: 3, lineHeight: 17},
  promoBtn: {
    height: 46, marginTop: 16, borderRadius: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
    shadowColor: GOLD, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.24, shadowRadius: 12, elevation: 5,
  },
  promoBtnText: {color: '#1A1710', fontFamily: BravoFont.extraBold, fontSize: 13.5, letterSpacing: 2},
}));
