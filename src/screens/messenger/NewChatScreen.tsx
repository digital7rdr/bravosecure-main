import React, {useMemo, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, StatusBar, ActivityIndicator, Linking,
  Modal, TextInput, Share,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {Colors} from '@theme/index';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {useAuthStore} from '@store/authStore';
import {DEV_CONTACTS, isDevMode, otherDevContacts} from '@/modules/messenger/dev/devContacts';
import {useMessengerStore, resolveDirectConversationIdFromState} from '@/modules/messenger/store';
import {UsersHttpClient} from '@bravo/messenger-core';
import {
  useDiscoveredContacts,
  type DiscoveredRow,
} from '@/modules/messenger/contacts/useDiscoveredContacts';
import {normalizeBatch, regionFromOwnPhone} from '@/modules/messenger/contacts/phoneNormalize';
import {filterContacts} from '@/modules/messenger/contacts/contactSearch';
import {recentDirectPeers} from '@/modules/messenger/contacts/recentPeers';
import {API_BASE_URL} from '@utils/constants';
import {tokenStore} from '@services/api';
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {writeServerRosterOrQueue} from '@/modules/messenger/runtime/pendingRosterIntents';
import {scaleTextStyles} from '@utils/scaling';
import LoadingView from '@components/LoadingView';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;

export default function NewChatScreen() {
  const insets = useSafeAreaInsets();
  // B-84 / KB-11 — Android Modal windows don't resize for the IME.
  const keyboardOverlap = useKeyboardOverlap();
  const navigation = useNavigation<Nav>();
  // BS-GROUP-ADD — when launched from ChatInfo's "Add member", these are set
  // and picking a contact adds them to the existing group instead of opening
  // a new chat.
  const route = useRoute<RouteProp<MessengerStackParamList, 'NewChat'>>();
  const addToGroupId = route.params?.addToGroupId ?? null;
  const addGroupName = route.params?.groupName ?? null;
  const currentUser = useAuthStore(s => s.user);
  const upsertConversation = useMessengerStore(s => s.upsertConversation);

  // BS-INVITE — invite a non-Bravo contact via the native share sheet.
  // The user picks the recipient + channel (SMS / WhatsApp / etc.) in
  // their OS share UI, so we don't need to enumerate non-Bravo contacts.
  const inviteToBravo = async () => {
    const inviter = currentUser?.full_name ? `${currentUser.full_name} ` : '';
    const link = 'https://bravosecure.com/get'; // Why: public install/landing link.
    try {
      await Share.share({
        message: `${inviter}invited you to Bravo Secure — private, end-to-end encrypted messaging & calls. Get the app: ${link}`,
      });
    } catch { /* user dismissed the share sheet — no-op */ }
  };

  // Group-creation state. When groupMode is on, tapping a contact toggles
  // selection (WhatsApp-style multi-select) instead of opening a chat.
  const [groupMode, setGroupMode] = useState(false);
  // The search bar used to be a decorative <Text> — it looked like an
  // input but held no state and filtered nothing, so typing did nothing.
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /**
   * SN-10 — add-to-group reuses the SAME multi-select UX as group creation.
   *
   * Previously a single tap added one person and popped the screen, so adding
   * three people meant re-entering the picker three times — and because the
   * success path was silent (see addMemberToGroup) it read as "nothing
   * happened", which drove users to re-tap and hit the duplicate gate.
   *
   * Declared AFTER groupMode's useState: reading it above would be a
   * temporal-dead-zone ReferenceError at render.
   */
  const selectMode = groupMode || !!addToGroupId;
  /** Busy guard for the sequential add loop (mirrors the `creating` guard). */
  const [addingMembers, setAddingMembers] = useState(false);
  const [groupNameModalOpen, setGroupNameModalOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  // Busy guard: createGroupChat is async (broadcastToGroup fans out
  // sealed envelopes to every member). Without this guard, each rapid
  // re-tap of the Create button kicked off a fresh group creation —
  // user reported "tapped 4-5 times, 5 groups created". The guard
  // keeps the button visibly disabled + ignores presses until the
  // first call resolves (success or failure).
  const [creating, setCreating] = useState(false);

  const showDevContacts = isDevMode();
  const devContacts = otherDevContacts(currentUser?.id);
  const seederReady = DEV_CONTACTS.every(c => c.userId !== 'REPLACE_WITH_SEEDED_UUID');

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {next.delete(id);} else {next.add(id);}
      return next;
    });
  };

  const exitGroupMode = () => {
    setGroupMode(false);
    setSelectedIds(new Set());
  };

  const openGroupNamePrompt = () => {
    if (selectedIds.size === 0) {return;}
    setGroupName('');
    setGroupNameModalOpen(true);
  };

  const confirmCreateGroup = async () => {
    if (creating) {
      console.log('[group-create] tap ignored — already in flight');
      return;
    }
    const name = groupName.trim();
    const memberIds = Array.from(selectedIds);
    console.log('[group-create] tap Create — name =', JSON.stringify(name), 'members =', memberIds);
    if (!name || selectedIds.size === 0) {
      console.warn('[group-create] aborted — name empty or no members selected');
      return;
    }
    setCreating(true);
    try {
      console.log('[group-create] resolving runtime…');
      const runtime = await getMessengerRuntime();
      console.log('[group-create] runtime mode =', runtime.mode);
      // The runtime owns:
      //   - GroupState construction (groupId + master key)
      //   - upsertConversation for the local row
      //   - admin "create" envelope fan-out via E2E sealed envelopes
      //     so other members' clients call setGroupState +
      //     upsertConversation themselves and the chat appears in
      //     their inbox.
      const {conversationId, groupId} = await runtime.createGroupChat({name, members: memberIds});
      console.log('[group-create] OK conversationId =', conversationId, 'groupId =', groupId);
      setGroupNameModalOpen(false);
      exitGroupMode();
      navigation.navigate('Chat', {conversationId, name, isGroup: true});
    } catch (e) {
      console.warn('[group-create] FAILED:', (e as Error).message);
      // Surface to the user — without this they tap Create and nothing
      // happens visibly when the network is down or peers can't be
      // reached. The screen itself doesn't have an error banner today;
      // a short alert is the simplest stopgap.

      const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
      Alert.alert('Could not create group', (e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  // Build UsersHttpClient once — the RN token store gives us the
  // currently-signed-in user's JWT; API_BASE_URL points at auth-service
  // (http://10.0.2.2:3001 in dev, prod host otherwise).
  const usersClient = useMemo(
    () => new UsersHttpClient({
      baseUrl:      API_BASE_URL,
      getToken:     () => tokenStore.get(),
      // Round 2: 401 mid-session = expired access token. Drive the
      // single-flight refresh chain instead of failing the lookup.
      refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
    }),
    [],
  );

  const {permission, loading, error, matches, refresh} = useDiscoveredContacts({
    users:        usersClient,
    ownPhoneE164: currentUser?.phone_e164 ?? null,
    enabled:      true,
  });

  // Live filtering for the search bar. Matching rules (name fragments,
  // digits-only phone comparison so "0552…" finds "+971552…") live in
  // contactSearch so they are unit-tested independently of this screen.
  const searching = query.trim().length > 0;
  const visibleMatches = useMemo(() => filterContacts(matches, query), [matches, query]);
  const visibleDevContacts = useMemo(() => filterContacts(devContacts, query), [devContacts, query]);

  // BS-RECENTS — peers you already chat with (e.g. reached via "Message by
  // Number") are not in the address book, so contact discovery can never list
  // them; they were unpickable for groups. Derived from store conversations,
  // deliberately independent of contacts permission/loading state, and deduped
  // against the sections above so nobody renders twice.
  const conversations = useMessengerStore(s => s.conversations);
  const recentPeers = recentDirectPeers(conversations, [
    ...matches.map(m => m.userId),
    ...devContacts.map(d => d.userId),
    ...(currentUser?.id ? [currentUser.id] : []),
  ]);
  const visibleRecents = filterContacts(recentPeers, query);

  const startDevChat = (peer: typeof DEV_CONTACTS[number]) => {
    // BS-NC1 — resolve to the CANONICAL direct conversation id. If a
    // server-UUID row already exists for this peer (created by an earlier
    // /conversations/mine sync), reuse it instead of minting a duplicate
    // `direct:<peer>` row. Without this, tapping a contact opens an empty
    // synthetic thread while history + new inbound route to the UUID row.
    const conversationId = resolveDirectConversationIdFromState(
      useMessengerStore.getState(), peer.userId,
    );
    // Only seed/refresh the row when it's the synthetic key (no UUID row
    // yet); never overwrite an existing canonical row's metadata.
    if (conversationId.startsWith('direct:')) {
      upsertConversation({
        id:             conversationId,
        type:           'direct',
        name:           peer.name,
        name_source:    'contact',
        participants:   [currentUser?.id ?? 'self', peer.userId],
        unread_count:   0,
        is_muted:       false,
        created_at:     new Date().toISOString(),
        peer:           {userId: peer.userId, deviceId: peer.deviceId},
        session_state:  'fresh',
      });
    }
    navigation.navigate('Chat', {conversationId, name: peer.name, isGroup: false});
  };

  // BS-GROUP-ADD — add the picked contact to the existing group via the
  // runtime (which rekeys the group epoch + fans the new member's add
  // envelope out). On success, pop back to the group's ChatInfo.
  const addMemberToGroup = async (row: DiscoveredRow) => {
    if (!addToGroupId) {return;}
    const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
    try {
      const runtime = await getMessengerRuntime();
      if (!runtime.addGroupMember) {
        Alert.alert('Unavailable', 'Adding members isn’t supported in this mode.');
        return;
      }
      await runtime.addGroupMember({
        groupId:   addToGroupId,
        newMember: {userId: row.userId, deviceId: 1},
      });
      // P1-6 — the local add+rekey above gave the new member the group key, but
      // the server `conversation_members` roster is unchanged: the next
      // /conversations/mine sync would overwrite participants and silently drop
      // them from future fan-out (and prune the thread on their device). Write
      // the roster now; a failed write is durably queued + retried while the
      // Home sync guard keeps the local (grown) participants authoritative.
      const ownerKey = useMessengerStore.getState()._ownUserId ?? undefined;
      const res = await writeServerRosterOrQueue({
        conversationId: addToGroupId, memberUserId: row.userId, action: 'add', ownerKey,
      });
      // SN-08 — ALWAYS confirm. The success path used to be silent unless the
      // roster write queued, which never happens for a locally-derived group
      // id (the write is skipped). Users read the silence as "nothing
      // happened", re-opened the group and added the same person again — which
      // is what manufactured most of the "already a member" reports.
      Alert.alert(
        'Member added',
        res.queued
          ? `${row.localName} now has the group key. The member list will finish syncing when you reconnect.`
          : `${row.localName} was added to ${addGroupName ?? 'the group'}.`,
      );
      navigation.goBack();
    } catch (e) {
      // SN-08 — map runtime codes to human copy. The old code rendered
      // e.message verbatim, so a correct duplicate rejection surfaced as
      // "<account-uuid> is already a member of <32-hex group id>" — two
      // opaque ids that appear nowhere else in the UI. Reporters reasonably
      // read that as a DIFFERENT group in another profile and filed it as a
      // cross-scope bug (ISSUE 02). The validation was right; the copy wasn't.
      const code = (e as {code?: string} | null)?.code;
      const where = addGroupName ?? 'this group';
      const msg =
        code === 'ALREADY_MEMBER'  ? `${row.localName} is already in ${where}.`
        : code === 'NOT_ADMIN'     ? `Only group admins can add members to ${where}.`
        : code === 'GROUP_FULL'    ? `${where} has reached the 250-member limit.`
        : code === 'CANNOT_ADD_SELF' ? 'You are already in this group.'
        : e instanceof Error && /transport not open|network/i.test(e.message)
          ? 'No connection — check your internet and try again.'
        : 'Please try again.';
      Alert.alert('Could not add member', msg);
    }
  };

  /**
   * SN-10 — add every selected contact in one pass, then report ONCE.
   *
   * Adds are sequential on purpose: each one advances the group epoch and
   * rekeys (planAddAndRekey), so firing them concurrently would race the
   * per-group admin lock and interleave epochs.
   */
  const confirmAddMembers = async () => {
    if (!addToGroupId || selectedIds.size === 0 || addingMembers) {return;}
    const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
    const pick = (d: {userId: string; localName?: string; displayName?: string}) =>
      ({userId: d.userId, name: d.localName ?? d.displayName ?? 'Member'});
    const rows = [
      ...visibleMatches.filter(r => selectedIds.has(r.userId)).map(pick),
      // BS-RECENTS — recents are selectable, so the confirm pass MUST read
      // them too or a selected recent-chat peer is silently dropped here.
      ...visibleRecents.filter(r => selectedIds.has(r.userId)).map(pick),
      ...visibleDevContacts.filter(d => selectedIds.has(d.userId)).map(pick),
    ];
    if (rows.length === 0) {return;}

    setAddingMembers(true);
    const added: string[] = [];
    const alreadyIn: string[] = [];
    const failed: string[] = [];
    try {
      const runtime = await getMessengerRuntime();
      if (!runtime.addGroupMember) {
        Alert.alert('Unavailable', 'Adding members isn’t supported in this mode.');
        return;
      }
      const ownerKey = useMessengerStore.getState()._ownUserId ?? undefined;
      for (const r of rows) {
        try {
          await runtime.addGroupMember({groupId: addToGroupId, newMember: {userId: r.userId, deviceId: 1}});
          // P1-6 — mirror the crypto add onto the server roster, else the next
          // /conversations/mine sync drops them from fan-out.
          await writeServerRosterOrQueue({
            conversationId: addToGroupId, memberUserId: r.userId, action: 'add', ownerKey,
          });
          added.push(r.name);
        } catch (e) {
          const code = (e as {code?: string} | null)?.code;
          if (code === 'ALREADY_MEMBER') {alreadyIn.push(r.name);}
          else if (code === 'NOT_ADMIN') {
            Alert.alert('Could not add members', `Only group admins can add members to ${addGroupName ?? 'this group'}.`);
            return;
          } else if (code === 'GROUP_FULL') {
            Alert.alert('Group is full', `${addGroupName ?? 'This group'} has reached the 250-member limit.`);
            return;
          } else {failed.push(r.name);}
        }
      }
    } finally {
      setAddingMembers(false);
    }

    const parts: string[] = [];
    if (added.length)     {parts.push(`Added ${added.join(', ')}.`);}
    if (alreadyIn.length) {parts.push(`${alreadyIn.join(', ')} ${alreadyIn.length === 1 ? 'was' : 'were'} already in the group.`);}
    if (failed.length)    {parts.push(`Could not add ${failed.join(', ')} — please try again.`);}
    Alert.alert(
      added.length ? 'Members added' : 'No members added',
      parts.join(' ') || 'Please try again.',
    );
    setSelectedIds(new Set());
    navigation.goBack();
  };

  const startRealChat = (row: DiscoveredRow) => {
    // BS-GROUP-ADD — in add-to-group mode, picking a contact adds them to
    // the group rather than opening a 1:1 chat.
    if (addToGroupId) { void addMemberToGroup(row); return; }
    // `localName` is how the user has the contact saved on their phone —
    // always beats display_name for a friendly UI. Phase-1 peers live on
    // signal deviceId=1; multi-device arrives with auth-service M12.
    // BS-NC1 — resolve to the canonical id (see startDevChat) to avoid
    // the split-brain duplicate-thread bug.
    const conversationId = resolveDirectConversationIdFromState(
      useMessengerStore.getState(), row.userId,
    );
    if (conversationId.startsWith('direct:')) {
      upsertConversation({
        id:             conversationId,
        type:           'direct',
        name:           row.localName,
        name_source:    'contact',
        participants:   [currentUser?.id ?? 'self', row.userId],
        unread_count:   0,
        is_muted:       false,
        created_at:     new Date().toISOString(),
        peer:           {userId: row.userId, deviceId: 1},
        phoneE164:      row.phoneE164,
        session_state:  'fresh',
      });
    }
    navigation.navigate('Chat', {conversationId, name: row.localName, isGroup: false});
  };

  // ── Message-by-number ──────────────────────────────────────────────────────
  // Reach someone who isn't in your address book: type their number, we
  // normalise + look it up on the directory, and open a chat if they're a
  // Bravo user. Uses the same /users/lookup the contact sweep uses.
  const [byNumberOpen, setByNumberOpen] = useState(false);
  const [numberInput, setNumberInput] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const startChatByNumber = async () => {
    setLookupError(null);
    const callingCode = regionFromOwnPhone(currentUser?.phone_e164 ?? null);
    const [e164] = normalizeBatch([numberInput], callingCode);
    // B-246 — send the NATIONAL form alongside the E.164 one. Two searches
    // used to dead-end here: a few accounts predate E.164 normalisation and
    // store the number nationally (the server rescues those, but only if it is
    // given the national digits to compare), and a searcher whose OWN phone is
    // one of those rows gets no calling code back, so normalizeBatch returns
    // null and a perfectly good local number was rejected outright.
    const national = numberInput.replace(/[^\d]/g, '').replace(/^0+/, '');
    const candidates = [
      ...(e164 ? [e164] : []),
      ...(national.length >= 8 && national !== e164?.slice(1) ? [national] : []),
    ];
    if (candidates.length === 0) {
      setLookupError('Enter a valid phone number (with country code).');
      return;
    }
    if (e164 && e164 === currentUser?.phone_e164) {
      setLookupError("That's your own number.");
      return;
    }
    setLookupBusy(true);
    try {
      const hits = await usersClient.lookup(candidates);
      // Prefer an exact E.164 hit: the server only falls back to national
      // matching for candidates that matched nothing, but a batch can carry
      // both kinds and the exact one is always the more trustworthy.
      const hit = hits.find(h => h.phone === e164) ?? hits[0];
      if (!hit) {
        setLookupError('No Bravo account is registered to that number.');
        return;
      }
      if (hit.userId === currentUser?.id) {
        setLookupError("That's your own number.");
        return;
      }
      // BS-RECENTS — in add-to-group mode a resolved number is ADDED to the
      // group (WhatsApp parity) instead of opening a 1:1 chat. addMemberToGroup
      // owns the alerts (incl. friendly ALREADY_MEMBER copy) and the goBack.
      if (addToGroupId) {
        setByNumberOpen(false);
        setNumberInput('');
        await addMemberToGroup({
          userId:      hit.userId,
          displayName: hit.displayName ?? '',
          avatarUrl:   null,
          phoneE164:   hit.phone ?? e164 ?? '',
          localName:   hit.displayName || hit.phone || numberInput.trim(),
        });
        return;
      }
      const conversationId = resolveDirectConversationIdFromState(
        useMessengerStore.getState(), hit.userId,
      );
      if (conversationId.startsWith('direct:')) {
        upsertConversation({
          id:             conversationId,
          type:           'direct',
          // B-411 — a by-number hit is the OUTBOUND unsaved case: the label
          // is their registered name, so banners tag it "· Unsaved". A hit
          // with NO display name falls to the bare phone, which renders
          // plain (no flag — tagging a phone number is noise).
          name:           hit.displayName || hit.phone || numberInput.trim(),
          ...(hit.displayName ? {name_source: 'profile' as const} : null),
          participants:   [currentUser?.id ?? 'self', hit.userId],
          unread_count:   0,
          is_muted:       false,
          created_at:     new Date().toISOString(),
          peer:           {userId: hit.userId, deviceId: 1},
          phoneE164:      hit.phone ?? e164 ?? undefined,
          session_state:  'fresh',
        });
      }
      setByNumberOpen(false);
      setNumberInput('');
      navigation.navigate('Chat', {conversationId, name: hit.displayName || hit.phone || numberInput.trim(), isGroup: false});
    } catch (e) {
      setLookupError((e as Error).message || 'Lookup failed. Try again.');
    } finally {
      setLookupBusy(false);
    }
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => groupMode ? exitGroupMode() : navigation.goBack()}
          activeOpacity={0.7}
          hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
          <Icon name={groupMode ? 'close' : 'arrow-left'} size={20} color="#FFFFFF" />
        </TouchableOpacity>
        {/* B-657 - minWidth:0 or the flex is inert (min-width:auto floors a
            flex child at content size) and a long group name overflows. */}
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {addToGroupId ? `Add to ${addGroupName ?? 'group'}` : groupMode ? 'Select Members' : 'New Message'}
          </Text>
          {groupMode && (
            <Text style={styles.headerSubtitle}>
              {selectedIds.size === 0 ? 'Tap contacts to add them' : `${selectedIds.size} selected`}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchBar}>
          <Icon name="magnify" size={17} color="rgba(180,188,204,0.45)" />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search name or number…"
            placeholderTextColor="rgba(180,188,204,0.45)"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="never"
            accessibilityLabel="Search contacts by name or number"
          />
          {query.length > 0 && (
            <TouchableOpacity
              onPress={() => setQuery('')}
              hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
              accessibilityRole="button"
              accessibilityLabel="Clear search">
              <Icon name="close-circle" size={17} color="rgba(180,188,204,0.45)" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingBottom: insets.bottom + 24, flexGrow: 1}}>

        {/* New Group — only shown when NOT already selecting members */}
        {!groupMode && !searching && (
          <TouchableOpacity style={styles.newGroupRow} activeOpacity={0.8}
            onPress={() => setGroupMode(true)}>
            <View style={styles.newGroupIcon}>
              <Icon name="account-group" size={20} color="#5B8DEF" />
            </View>
            <View style={styles.newGroupInfo}>
              <Text style={styles.newGroupTitle}>New Group</Text>
              <Text style={styles.newGroupSub}>Sealed-sender broadcast, pairwise E2E</Text>
            </View>
            <Icon name="chevron-right" size={18} color="rgba(180,188,204,0.45)" />
          </TouchableOpacity>
        )}

        {/* Message by number — reach someone not in your contacts. In
            add-to-group mode the same lookup ADDS the number to the group. */}
        {!groupMode && (
          <TouchableOpacity style={styles.newGroupRow} activeOpacity={0.8}
            onPress={() => { setLookupError(null); setByNumberOpen(true); }}>
            <View style={styles.newGroupIcon}>
              <Icon name="dialpad" size={20} color="#5B8DEF" />
            </View>
            <View style={styles.newGroupInfo}>
              <Text style={styles.newGroupTitle}>{addToGroupId ? 'Add by Number' : 'Message by Number'}</Text>
              <Text style={styles.newGroupSub}>
                {addToGroupId
                  ? `Add any Bravo number to ${addGroupName ?? 'this group'}`
                  : 'Start a chat with any Bravo number'}
              </Text>
            </View>
            <Icon name="chevron-right" size={18} color="rgba(180,188,204,0.45)" />
          </TouchableOpacity>
        )}

        {showDevContacts && (
          <DevContactsSection
            seederReady={seederReady}
            devContacts={visibleDevContacts}
            onPick={startDevChat}
            groupMode={selectMode}
            selectedIds={selectedIds}
            onToggle={toggleSelect}
          />
        )}
        {/* BS-RECENTS — before the contacts section ON PURPOSE: it must render
            even when contact discovery is denied/loading/failed, or a chat
            peer outside the address book stays unpickable. */}
        <RecentChatsSection
          rows={visibleRecents}
          onPick={startRealChat}
          groupMode={selectMode}
          selectedIds={selectedIds}
          onToggle={toggleSelect}
        />
        <RealContactsSection
          permission={permission}
          loading={loading}
          error={error}
          matches={visibleMatches}
          searching={searching}
          onPick={startRealChat}
          onRetry={refresh}
          groupMode={selectMode}
          selectedIds={selectedIds}
          onToggle={toggleSelect}
          byNumberLabel={addToGroupId ? 'Add by Number' : 'Message by Number'}
        />

        {/* BS-INVITE — invite non-Bravo contacts. Always available; the
            native share sheet lets the user pick who + how to send. */}
        {!groupMode && !addToGroupId && (
          <TouchableOpacity style={styles.inviteRow} onPress={() => void inviteToBravo()} activeOpacity={0.8}>
            <View style={styles.inviteIcon}>
              <Icon name="account-plus-outline" size={20} color={'#5B8DEF'} />
            </View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={styles.inviteTitle}>Invite a friend to Bravo</Text>
              <Text style={styles.inviteSub}>Send an install link to someone not on Bravo yet</Text>
            </View>
            <Icon name="share-variant" size={18} color={Colors.textMuted ?? '#7E8AA6'} />
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* SN-10 — confirm button for add-to-group multi-select. Separate from
          the group-creation FAB below: that one opens the name prompt, this
          one commits the adds directly. */}
      {addToGroupId && selectedIds.size > 0 && (
        <TouchableOpacity
          style={[styles.nextFab, {bottom: insets.bottom + 20}, addingMembers && {opacity: 0.5}]}
          disabled={addingMembers}
          onPress={() => { void confirmAddMembers(); }}
          activeOpacity={0.85}>
          <Icon name="check" size={22} color="#FFF" />
        </TouchableOpacity>
      )}

      {/* Floating "Next" button when members are selected */}
      {groupMode && selectedIds.size > 0 && (
        <TouchableOpacity
          style={[styles.nextFab, {bottom: insets.bottom + 20}]}
          onPress={openGroupNamePrompt}
          activeOpacity={0.85}>
          <Icon name="arrow-right" size={22} color="#FFF" />
        </TouchableOpacity>
      )}

      {/* Group-name modal — WhatsApp-style name prompt after selection */}
      <Modal
        visible={groupNameModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setGroupNameModalOpen(false)}>
        {/* B-184 — one rule, both platforms: the backdrop shrinks by the IME
            overlap so the centered card re-centres above the keyboard. */}
        <View style={[styles.modalOverlay, {paddingBottom: keyboardOverlap}]}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Group name</Text>
            <Text style={styles.modalSub}>{selectedIds.size} {selectedIds.size === 1 ? 'member' : 'members'}</Text>
            <TextInput
              style={styles.modalInput}
              value={groupName}
              onChangeText={setGroupName}
              placeholder="e.g. Ops Team"
              placeholderTextColor="rgba(180,188,204,0.45)"
              autoFocus
              maxLength={40}
              returnKeyType="done"
              onSubmitEditing={() => { void confirmCreateGroup(); }}
            />
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setGroupNameModalOpen(false)} activeOpacity={0.8}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalCreate, (!groupName.trim() || creating) && {opacity: 0.4}]}
                disabled={!groupName.trim() || creating}
                onPress={() => { void confirmCreateGroup(); }}
                activeOpacity={0.85}>
                {creating
                  ? <ActivityIndicator color="#FFF" />
                  : <Text style={styles.modalCreateText}>Create</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Message-by-number modal */}
      <Modal
        visible={byNumberOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setByNumberOpen(false)}>
        {/* B-184 — one rule, both platforms: the backdrop shrinks by the IME
            overlap so the centered card re-centres above the keyboard. */}
        <View style={[styles.modalOverlay, {paddingBottom: keyboardOverlap}]}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{addToGroupId ? 'Add by number' : 'Message by number'}</Text>
            <Text style={styles.modalSub}>
              {addToGroupId
                ? `They'll be added to ${addGroupName ?? 'the group'} if they're on Bravo`
                : 'Enter a phone number with country code'}
            </Text>
            <TextInput
              style={styles.modalInput}
              value={numberInput}
              onChangeText={t => { setNumberInput(t); setLookupError(null); }}
              placeholder="+971 50 123 4567"
              placeholderTextColor="rgba(180,188,204,0.45)"
              autoFocus
              keyboardType="phone-pad"
              returnKeyType="go"
              onSubmitEditing={() => { void startChatByNumber(); }}
            />
            {lookupError && <Text style={styles.lookupError}>{lookupError}</Text>}
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => { setByNumberOpen(false); setNumberInput(''); }} activeOpacity={0.8}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalCreate, (!numberInput.trim() || lookupBusy) && {opacity: 0.4}]}
                disabled={!numberInput.trim() || lookupBusy}
                onPress={() => { void startChatByNumber(); }}
                activeOpacity={0.85}>
                {lookupBusy
                  ? <ActivityIndicator color="#FFF" />
                  : <Text style={styles.modalCreateText}>{addToGroupId ? 'Add' : 'Message'}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Dev-contacts section (unchanged) ──────────────────────────────────

function DevContactsSection(props: {
  seederReady: boolean;
  devContacts: ReturnType<typeof otherDevContacts>;
  onPick: (c: typeof DEV_CONTACTS[number]) => void;
  groupMode: boolean;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  const {seederReady, devContacts, onPick, groupMode, selectedIds, onToggle} = props;
  return (
    <>
      <View style={styles.devBanner}>
        <Icon name="information-outline" size={12} color="#fbbf24" />
        <Text style={styles.devBannerText}>
          DEV BUILD — dev contacts shown below. Production builds load peers from the contacts API.
        </Text>
      </View>
      <Text style={styles.sectionLabel}>Dev Contacts</Text>
      {!seederReady ? (
        <SeederNeeded />
      ) : devContacts.length === 0 ? (
        <EmptyDevContacts />
      ) : (
        devContacts.map(c => {
          const selected = selectedIds.has(c.userId);
          return (
            <TouchableOpacity key={c.userId} style={[styles.row, selected && styles.rowSelected]}
              onPress={() => groupMode ? onToggle(c.userId) : onPick(c)} activeOpacity={0.8}>
              <View style={styles.avWrap}>
                <View style={[styles.av, {backgroundColor: c.bg}]}>
                  <Text style={styles.avText}>{c.initials}</Text>
                </View>
                {groupMode && selected && (
                  <View style={styles.selectTick}>
                    <Icon name="check" size={12} color="#FFF" />
                  </View>
                )}
              </View>
              <View style={styles.rowInfo}>
                <View style={styles.nameRow}>
                  <Text style={styles.name}>{c.name}</Text>
                </View>
                <Text style={styles.phone}>{c.phoneE164}</Text>
              </View>
              {groupMode ? (
                <View style={[styles.checkbox, selected && styles.checkboxOn]}>
                  {selected && <Icon name="check" size={14} color="#FFF" />}
                </View>
              ) : (
                <Icon name="chevron-right" size={18} color="rgba(180,188,204,0.45)" />
              )}
            </TouchableOpacity>
          );
        })
      )}
    </>
  );
}

// ─── Shared picker row (real contacts + recent chats) ─────────────────
// One markup for both sections — a drifted second copy is exactly the
// duplicate-copy bug class this repo keeps re-finding.

function PickerRow(props: {
  row:       DiscoveredRow;
  groupMode: boolean;
  selected:  boolean;
  onPress:   () => void;
}) {
  const {row, groupMode, selected, onPress} = props;
  return (
    <TouchableOpacity style={[styles.row, selected && styles.rowSelected]}
      onPress={onPress} activeOpacity={0.8}>
      <View style={styles.avWrap}>
        <View style={[styles.av, {backgroundColor: avatarColor(row.userId)}]}>
          <Text style={styles.avText}>{initialsOf(row.localName)}</Text>
        </View>
        {groupMode && selected && (
          <View style={styles.selectTick}>
            <Icon name="check" size={12} color="#FFF" />
          </View>
        )}
      </View>
      <View style={styles.rowInfo}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>{row.localName}</Text>
        </View>
        {!!row.phoneE164 && <Text style={styles.phone}>{row.phoneE164}</Text>}
      </View>
      {groupMode ? (
        <View style={[styles.checkbox, selected && styles.checkboxOn]}>
          {selected && <Icon name="check" size={14} color="#FFF" />}
        </View>
      ) : (
        <Icon name="chevron-right" size={18} color="rgba(180,188,204,0.45)" />
      )}
    </TouchableOpacity>
  );
}

// ─── Recent-chats section (BS-RECENTS) ────────────────────────────────
// People with an existing 1:1 thread who are NOT in the sections around it
// (already deduped by the caller). No permission/loading/error states of its
// own — the store is always available, which is the point: this section is
// what keeps a "Message by Number" peer pickable when contact discovery
// can't see them (or is denied outright).

function RecentChatsSection(props: {
  rows:       DiscoveredRow[];
  onPick:     (row: DiscoveredRow) => void;
  groupMode:  boolean;
  selectedIds: Set<string>;
  onToggle:   (id: string) => void;
}) {
  const {rows, onPick, groupMode, selectedIds, onToggle} = props;
  if (rows.length === 0) {return null;}
  return (
    <>
      <Text style={styles.sectionLabel}>Recent chats · {rows.length}</Text>
      {rows.map(r => (
        <PickerRow key={r.userId} row={r} groupMode={groupMode}
          selected={selectedIds.has(r.userId)}
          onPress={() => groupMode ? onToggle(r.userId) : onPick(r)} />
      ))}
    </>
  );
}

// ─── Real-contacts section (new: permission + lookup + render) ────────

function RealContactsSection(props: {
  permission: 'unknown' | 'granted' | 'denied' | 'unavailable';
  loading:    boolean;
  error:      string | null;
  matches:    DiscoveredRow[];
  /** True when a search query is narrowing the list (changes the empty state). */
  searching:  boolean;
  onPick:     (row: DiscoveredRow) => void;
  onRetry:    () => Promise<void>;
  groupMode:  boolean;
  selectedIds: Set<string>;
  onToggle:   (id: string) => void;
  /** BS-RECENTS — the by-number row is "Add by Number" in add-to-group mode;
   *  the empty-search hint must name the row the user actually sees. */
  byNumberLabel: string;
}) {
  const {permission, loading, error, matches, searching, onPick, onRetry, groupMode, selectedIds, onToggle, byNumberLabel} = props;

  if (loading && matches.length === 0) {
    return (
      <View style={styles.blockWrap}>
        <LoadingView compact label="Finding your Bravo contacts…" />
        <Text style={styles.blockHint}>Reading your address book and checking which numbers are on Bravo.</Text>
      </View>
    );
  }

  if (permission === 'denied') {
    return (
      <View style={styles.blockWrap}>
        <Icon name="book-lock-outline" size={32} color="#A9C5FF" />
        <Text style={styles.blockTitle}>Contacts access needed</Text>
        <Text style={styles.blockHint}>
          Grant contacts permission to see which of your saved numbers are on Bravo. We only
          send phone numbers to match against existing users — nothing else leaves your device.
        </Text>
        <TouchableOpacity style={styles.actionBtn} activeOpacity={0.85}
          onPress={() => { void Linking.openSettings(); }}>
          <Text style={styles.actionBtnText}>Open Settings</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (permission === 'unavailable') {
    return (
      <View style={styles.blockWrap}>
        <Icon name="cellphone-off" size={32} color="#A9C5FF" />
        <Text style={styles.blockTitle}>Not supported here</Text>
        <Text style={styles.blockHint}>
          Contact discovery isn't available in this build. Sign in on a physical device.
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.blockWrap}>
        <Icon name="alert-circle-outline" size={32} color="#f87171" />
        <Text style={styles.blockTitle}>Lookup failed</Text>
        <Text style={styles.blockHint}>{error}</Text>
        <TouchableOpacity style={styles.actionBtn} activeOpacity={0.85}
          onPress={() => { void onRetry(); }}>
          <Text style={styles.actionBtnText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (matches.length === 0) {
    // A search that found nothing is a different situation from having no
    // Bravo contacts at all — saying "none of your contacts are on Bravo"
    // while the user is mid-search would be plainly wrong.
    if (searching) {
      return (
        <View style={styles.blockWrap}>
          <Icon name="magnify-close" size={32} color="#A9C5FF" />
          <Text style={styles.blockTitle}>No contacts match</Text>
          <Text style={styles.blockHint}>
            Try a different name or number. To reach someone who isn&apos;t in your
            contacts, use “{byNumberLabel}”.
          </Text>
        </View>
      );
    }
    return (
      <>
        <Text style={styles.sectionLabel}>Contacts on Bravo</Text>
        <View style={styles.blockWrap}>
          <Icon name="account-search-outline" size={32} color="#A9C5FF" />
          <Text style={styles.blockTitle}>No matches yet</Text>
          <Text style={styles.blockHint}>
            None of your saved contacts are on Bravo. Invite them to join — anyone with
            a Bravo account will appear here automatically.
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Text style={styles.sectionLabel}>Contacts on Bravo · {matches.length}</Text>
      {matches.map(m => (
        <PickerRow key={m.userId} row={m} groupMode={groupMode}
          selected={selectedIds.has(m.userId)}
          onPress={() => groupMode ? onToggle(m.userId) : onPick(m)} />
      ))}
    </>
  );
}

function SeederNeeded() {
  return (
    <View style={styles.blockWrap}>
      <Icon name="account-cog-outline" size={32} color="#A9C5FF" />
      <Text style={styles.blockTitle}>Run the dev seeder</Text>
      <Text style={styles.blockHint}>
        No dev users yet. Start auth-service with OTP_DEV_BYPASS=true and run:{'\n'}
      </Text>
      <View style={styles.codeBlock}>
        <Text style={styles.codeText}>node scripts/seed-dev-users.mjs</Text>
      </View>
      <Text style={styles.blockHint}>
        Paste the printed UUIDs into{' '}
        <Text style={styles.codeInline}>src/modules/messenger/dev/devContacts.ts</Text>
        {' '}and rebuild.
      </Text>
    </View>
  );
}

function EmptyDevContacts() {
  return (
    <View style={styles.blockWrap}>
      <Icon name="account-question-outline" size={32} color="#A9C5FF" />
      <Text style={styles.blockTitle}>No peers to message</Text>
      <Text style={styles.blockHint}>
        You're signed in as the only seeded user. Sign in as a different dev user on another device to start chatting.
      </Text>
    </View>
  );
}

/** Deterministic avatar color from the userId — stable across renders. */
function avatarColor(seed: string): string {
  const palette = ['#1E88FF', '#0EA5E9', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6', '#14B8A6'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) {h = (h * 31 + seed.charCodeAt(i)) >>> 0;}
  return palette[h % palette.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '·';
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:Colors.background},

  header: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingTop:8, paddingBottom:12, borderBottomWidth:1, borderBottomColor:'rgba(255,255,255,0.06)'},
  backBtn: {width:32, height:32, borderRadius:16, alignItems:'center', justifyContent:'center'},
  // B-657 - letterSpacing 3 added ~3dp PER CHARACTER; a 33-char group name
  // ('Add to Global Security Operations') spent 99dp on tracking alone and
  // ellipsised. 1.5 still reads as a tracked uppercase title.
  headerTitle: {flex:1, minWidth:0, color:'#F2F4F8', fontSize:13, fontWeight:'800', letterSpacing:1.5, textTransform:'uppercase'},

  searchWrap: {paddingHorizontal:16, paddingVertical:12, borderBottomWidth:1, borderBottomColor:'rgba(255,255,255,0.06)'},
  searchBar: {flexDirection:'row', alignItems:'center', gap:8, height:40, backgroundColor:'rgba(255,255,255,0.04)', borderRadius:12, paddingHorizontal:12, borderWidth:1, borderColor:'rgba(255,255,255,0.09)'},
  // Why: the input must fill the bar so the whole pill is tappable, and
  // padding is zeroed because Android TextInput ships its own and would
  // push the text off-centre inside the fixed-height bar.
  searchInput: {flex:1, color:'#F2F4F8', fontSize:13, fontWeight:'600', padding:0, margin:0},

  newGroupRow: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingVertical:12, borderBottomWidth:1, borderBottomColor:'rgba(255,255,255,0.06)'},
  newGroupIcon: {width:44, height:44, borderRadius:22, backgroundColor:'rgba(91,141,239,0.15)', borderWidth:1, borderColor:'rgba(91,141,239,0.25)', alignItems:'center', justifyContent:'center'},
  newGroupInfo: {flex:1},
  newGroupTitle: {color:'#5B8DEF', fontSize:13, fontWeight:'700'},
  newGroupSub: {color:'rgba(180,188,204,0.45)', fontSize:11, marginTop:2},

  devBanner: {flexDirection:'row', alignItems:'center', gap:6, paddingHorizontal:16, paddingVertical:8, backgroundColor:'rgba(251,191,36,0.08)', borderBottomWidth:1, borderBottomColor:'rgba(251,191,36,0.2)'},
  devBannerText: {color:'#fbbf24', fontSize:10, fontWeight:'600', flex:1, lineHeight:14},

  sectionLabel: {color:'rgba(180,188,204,0.45)', fontSize:9, fontWeight:'800', letterSpacing:3, textTransform:'uppercase', paddingHorizontal:16, paddingTop:12, paddingBottom:8},

  row: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingVertical:12, borderBottomWidth:1, borderBottomColor:'rgba(255,255,255,0.06)'},
  avWrap: {position:'relative', width:44, height:44, flexShrink:0},
  av: {width:44, height:44, borderRadius:22, alignItems:'center', justifyContent:'center'},
  avText: {color:'#FFF', fontSize:11, fontWeight:'800'},
  rowInfo: {flex:1, minWidth:0},
  nameRow: {flexDirection:'row', alignItems:'center', gap:5},
  name: {color:'#F2F4F8', fontSize:13, fontWeight:'700', flexShrink:1},
  phone: {color:'rgba(180,188,204,0.45)', fontSize:10, marginTop:2},

  // BS-INVITE — invite-a-friend row.
  inviteRow: {flexDirection:'row', alignItems:'center', gap:12, marginHorizontal:16, marginTop:16, paddingHorizontal:16, paddingVertical:12, borderRadius:14, borderWidth:1, borderColor:'rgba(255,255,255,0.09)', backgroundColor:'rgba(22,27,37,0.72)'},
  inviteIcon: {width:40, height:40, borderRadius:20, alignItems:'center', justifyContent:'center', backgroundColor:'rgba(91,141,239,0.12)', flexShrink:0},
  inviteTitle: {color:'#F2F4F8', fontSize:13, fontWeight:'700'},
  inviteSub: {color:'rgba(180,188,204,0.45)', fontSize:11, marginTop:2},

  blockWrap: {paddingHorizontal:32, paddingVertical:40, alignItems:'center', gap:10},
  blockTitle: {color:'#F2F4F8', fontSize:13, fontWeight:'700', marginTop:4},
  blockHint: {color:'rgba(180,188,204,0.45)', fontSize:11, textAlign:'center', lineHeight:16, maxWidth:300},
  codeBlock: {backgroundColor:'#0C1018', borderRadius:8, paddingHorizontal:12, paddingVertical:8, borderWidth:1, borderColor:'rgba(255,255,255,0.09)'},
  codeText: {color:'rgba(229,233,242,0.62)', fontSize:11, fontFamily:'monospace'},
  codeInline: {color:'rgba(229,233,242,0.62)', fontFamily:'monospace', fontSize:11},

  actionBtn: {marginTop:12, paddingHorizontal:18, paddingVertical:10, borderRadius:10, backgroundColor:'rgba(91,141,239,0.15)', borderWidth:1, borderColor:'rgba(91,141,239,0.35)'},
  actionBtnText: {color:'#5B8DEF', fontSize:12, fontWeight:'700'},

  // ─── Group-selection UI ─────────────────────────────────────────
  headerSubtitle: {color:'rgba(180,188,204,0.45)', fontSize:10, marginTop:2, letterSpacing:0.5},
  rowSelected: {backgroundColor:'rgba(91,141,239,0.08)'},
  selectTick: {position:'absolute', right:-2, bottom:-2, width:18, height:18, borderRadius:9, backgroundColor:'#5B8DEF', alignItems:'center', justifyContent:'center', borderWidth:2, borderColor:Colors.background},
  checkbox: {width:22, height:22, borderRadius:11, borderWidth:1.5, borderColor:'rgba(255,255,255,0.09)', alignItems:'center', justifyContent:'center'},
  checkboxOn: {backgroundColor:'#5B8DEF', borderColor:'#5B8DEF'},
  nextFab: {position:'absolute', right:20, width:56, height:56, borderRadius:28, backgroundColor:'#5B8DEF', alignItems:'center', justifyContent:'center', shadowColor:'#5B8DEF', shadowOffset:{width:0,height:4}, shadowOpacity:0.5, shadowRadius:10, elevation:6},

  // ─── Group-name modal ────────────────────────────────────────────
  modalOverlay: {flex:1, backgroundColor:'rgba(7,9,13,0.85)', alignItems:'center', justifyContent:'center', paddingHorizontal:24},
  modalCard: {width:'100%', maxWidth:380, backgroundColor:'#0C1018', borderRadius:16, padding:20, borderWidth:1, borderColor:'rgba(255,255,255,0.09)'},
  modalTitle: {color:'#F2F4F8', fontSize:16, fontWeight:'800', letterSpacing:0.3},
  modalSub: {color:'rgba(180,188,204,0.45)', fontSize:11, marginTop:4, fontWeight:'600'},
  modalInput: {marginTop:18, backgroundColor:'rgba(255,255,255,0.04)', borderWidth:1, borderColor:'rgba(255,255,255,0.09)', borderRadius:10, paddingHorizontal:14, paddingVertical:12, color:'#F2F4F8', fontSize:14},
  lookupError: {color:'#FF6B6B', fontSize:11, marginTop:8, fontWeight:'600'},
  modalRow: {flexDirection:'row', justifyContent:'flex-end', gap:8, marginTop:18},
  modalCancel: {paddingHorizontal:18, paddingVertical:10, borderRadius:8},
  modalCancelText: {color:'rgba(229,233,242,0.62)', fontSize:13, fontWeight:'700'},
  modalCreate: {paddingHorizontal:22, paddingVertical:10, borderRadius:8, backgroundColor:'#5B8DEF'},
  modalCreateText: {color:'#FFF', fontSize:13, fontWeight:'800'},
}));
