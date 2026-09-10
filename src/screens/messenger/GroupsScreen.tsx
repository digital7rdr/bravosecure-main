import React, {useMemo, useState, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {useMessengerStore, selectLastMessageByConv} from '@/modules/messenger/store';
import {useIsDeptConversation} from './useDeptConversationFilter';
import {lastMessagePreview} from './conversationPreview';
import type {LocalConversation} from '@/modules/messenger/store';
import {departmentApi} from '@services/api';
import {DEPT_CHAT_V2} from '@utils/constants';
import {formatListTimestamp} from '@utils/helpers';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {sameIdSet} from '@utils/setEquals';
import {avatarColorFor} from './avatarColors';
import {openConversation} from './openConversation';

type Nav = NativeStackNavigationProp<MessengerStackParamList, 'Groups'>;

interface GroupItem {
  id: string;
  name: string;
  lastMsg: string;
  time: string;
  avatarBg: string;
  avatarIcon?: string;
  avatarIconColor?: string;
  initials?: string;
  unread?: number;
  activeMission?: boolean;
  memberCount?: string;
}

function conversationToGroupItem(c: LocalConversation, lastMsgText: string, lastTime: string): GroupItem {
  const name = c.name ?? 'Unnamed group';
  // Defensive: restored conversations from a v1.0.4-or-earlier mirror
  // can have `participants` undefined. v1.0.5+ writes a real array, but
  // we still need to handle pre-existing local rows from older builds
  // without crashing the entire Groups screen.
  const participantCount = c.participants?.length ?? 0;
  const unreadCount      = c.unread_count ?? 0;
  return {
    id:         c.id,
    name,
    lastMsg:    lastMsgText,
    time:       lastTime,
    avatarBg:   avatarBgFor(c.id),
    initials:   initialsOf(name),
    unread:     unreadCount > 0 ? unreadCount : undefined,
    memberCount: participantCount > 0 ? `${participantCount} members` : undefined,
  };
}

// B-286 — shared with the conversation list and the chat header so a group
// keeps one colour across every surface that shows it.
function avatarBgFor(seed: string): string {
  return avatarColorFor(seed);
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '·';
}

function GroupRow({item, onPress}: {item: GroupItem; onPress: () => void}) {
  return (
    <TouchableOpacity style={styles.groupRow} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.avatarWrap}>
        <View style={[
          styles.avatar,
          {backgroundColor: item.avatarBg === 'linear' ? '#5B8DEF' : item.avatarBg},
        ]}>
          {item.avatarIcon
            ? <Icon name={item.avatarIcon} size={22} color={item.avatarIconColor ?? '#FFF'} />
            : <Text style={styles.avatarText}>{item.initials}</Text>
          }
        </View>
        {item.activeMission && <View style={styles.missionDot} />}
      </View>
      <View style={styles.groupInfo}>
        <View style={styles.groupTopRow}>
          <Text style={styles.groupName} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.groupTime}>{item.time}</Text>
        </View>
        <View style={styles.groupBottomRow}>
          <Text style={styles.groupLastMsg} numberOfLines={1}>{item.lastMsg}</Text>
          {item.unread
            ? <View style={styles.unreadBadge}><Text style={styles.unreadText}>{item.unread > 99 ? '99+' : item.unread}</Text></View>
            : item.memberCount
            ? <Text style={styles.memberCount}>{item.memberCount}</Text>
            : null
          }
        </View>
      </View>
    </TouchableOpacity>
  );
}

export default function GroupsScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const conversations = useMessengerStore(s => s.conversations);
  // Round 6 / perf — subscribe to the last-message-per-conversation
  // map only. This screen never reads anything but the LAST bubble of
  // each group; previously it took the entire `s.messages` map and
  // re-rendered on every append in every chat (group OR direct).
  // selectLastMessageByConv is memoised on the live messages map, so
  // an append that moves a group's last message produces a fresh
  // outer reference (re-render); an append to a direct chat we don't
  // display still flips the WeakMap key but the screen's downstream
  // useMemo bails because no group's lastMsg changed.
  const lastByConv = useMessengerStore(selectLastMessageByConv);

  // Hide departmental-channel groups here too — they belong only in the Departmental module's
  // Channels tab, not the messenger Groups list. (Same server-authoritative exclusion set as
  // MessengerHomeScreen.) Flag-gated; a non-dept user's listChannels 403s → empty set.
  const [deptGroupIds, setDeptGroupIds] = useState<Set<string>>(() => new Set());
  // B-593 — on FOCUS, not mount, matching MessengerHomeScreen. A channel
  // provisioned while this screen was already mounted (the admin self-heal
  // sweep does exactly that, from a sibling tab) never reached a mount-only
  // effect, so it leaked into the Groups list until the whole app remounted.
  useFocusEffect(
    useCallback(() => {
      if (!DEPT_CHAT_V2) {return undefined;}
      let cancelled = false;
      void (async () => {
        try {
          const {data} = await departmentApi.listChannels();
          if (!cancelled) {
            const next = data.channels.map(c => c.group_conversation_id).filter((x): x is string => !!x);
            // NAV-19 (2026-08-26 audit) — keep the previous Set identity when
            // unchanged, or every focus invalidates the `groups` memo below and
            // re-sorts the whole conversation map mid-transition (same fix as
            // MessengerHomeScreen NAV-18).
            const nextSet = new Set(next);
            setDeptGroupIds(prev => (sameIdSet(prev, nextSet) ? prev : nextSet));
            // Feed the PERSISTED registry too — the same free arming
            // MessengerHomeScreen does, so the first paint after a restart is
            // filtered without waiting for any fetch.
            const store = useMessengerStore.getState();
            for (const id of next) { store.rememberDeptConversation(id); }
          }
        } catch { /* not a dept member / flag off */ }
      })();
      return () => { cancelled = true; };
    }, []),
  );

  // WhatsApp parity: groups sorted by LAST ACTIVITY (newest message
  // first), with creation date as the fallback when there are no
  // messages yet. Previously sorted purely by created_at, so a group
  // you actively chat in would sink under a freshly-created empty one.
  // The network set above is mount-only and empty until it lands (and forever,
  // offline or on a 403), so it cannot be the filter. The persisted store
  // registry answers on the first paint — same predicate the messenger list and
  // the notification tap use.
  const isDept = useIsDeptConversation();

  const groups = useMemo<GroupItem[]>(() => {
    const arr = Object.values(conversations)
      .filter(c => c.type === 'group' && !deptGroupIds.has(c.id) && !isDept(c.id))
      .map(c => {
        const last = lastByConv[c.id];
        // B-662 — shared preview rule: call records / tombstones / media all
        // get a human label instead of falling through to "(encrypted)".
        const lastText = lastMessagePreview(last) ?? 'End-to-end encrypted · tap to start';
        const lastTime = last ? formatListTimestamp(last.created_at) : '';
        const sortKey = last ? Date.parse(last.created_at) :
          c.created_at ? Date.parse(c.created_at) : 0;
        return {item: conversationToGroupItem(c, lastText, lastTime), sortKey};
      });
    arr.sort((a, b) => b.sortKey - a.sortKey);
    return arr.map(x => x.item);
  }, [conversations, lastByConv, deptGroupIds, isDept]);

  // A9/M9 — the `deptGroupIds` filter above is a VISIBILITY mitigation, not a
  // routing guard: it starts empty and is filled by a network round-trip, so
  // every dept channel is listed and tappable until `listChannels` resolves (and
  // for the whole session if it fails or DEPT_CHAT_V2 is off). The destination
  // has to ask the LOCAL store as well, or that window opens ChatScreen — with
  // its unconditional call buttons — on a department channel.
  const openGroup = (g: GroupItem) => {
    openConversation(navigation, {conversationId: g.id, name: g.name, isGroup: true});
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => goBackOnce(navigation)}
          activeOpacity={0.7}
          hitSlop={{top: 8, left: 8, right: 8, bottom: 8}}
          style={{paddingRight: 12}}>
          <Icon name="arrow-left" size={20} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, {flex: 1}]}>Groups</Text>
        <TouchableOpacity
          style={styles.newGroupBtn}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('NewChat')}>
          <Icon name="plus" size={14} color="#5B8DEF" />
          <Text style={styles.newGroupText}>New Group</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={[{paddingBottom: insets.bottom + 80}]}
        showsVerticalScrollIndicator={false}>

        {/* Founder 2026-08-05 — the Departmental Chat banner MOVED to the
            profile drawer (ProfileDrawerModal). It is a workspace-level
            destination rather than one of "your groups", and sitting above the
            list it pushed the actual groups down the screen. The drawer row
            keeps the identical two-branch behaviour (resolve against the
            mounted shell; fall back to the Enterprise upsell only when there is
            genuinely no door) — this was a move, not a behaviour change.
            Dept channels are still filtered OUT of the group list below by the
            deptGroupIds effect, which is unrelated and stays. */}

        {groups.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Icon name="account-group-outline" size={44} color="#5B8DEF" />
            <Text style={styles.emptyTitle}>No groups yet</Text>
            <Text style={styles.emptyHint}>
              Groups broadcast as N pairwise sealed Signal envelopes — the
              server never sees membership. Tap below to start one.
            </Text>
            <TouchableOpacity
              style={styles.emptyCta}
              activeOpacity={0.85}
              onPress={() => navigation.navigate('NewChat')}>
              <Icon name="plus" size={16} color="#FFF" />
              <Text style={styles.emptyCtaText}>Create Group</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <Text style={styles.sectionLabel}>Your Groups · {groups.length}</Text>
            {groups.map(g => (
              <GroupRow key={g.id} item={g} onPress={() => openGroup(g)} />
            ))}
          </>
        )}

      </ScrollView>

      {/* FAB */}
      <TouchableOpacity
        style={[styles.fab, {bottom: insets.bottom + 16}]}
        activeOpacity={0.85}
        onPress={() => navigation.navigate('NewChat')}>
        <Icon name="account-multiple-plus" size={22} color="#FFF" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.09)'},
  headerTitle: {fontSize: 17, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 3, color: '#F2F4F8'},
  newGroupBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99, backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)'},
  newGroupText: {fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.5, color: '#5B8DEF'},

  sectionLabel: {fontSize: 9, fontWeight: '800', letterSpacing: 3, textTransform: 'uppercase', color: 'rgba(180,188,204,0.45)', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6},


  groupRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)'},
  avatarWrap: {position: 'relative', flexShrink: 0},
  avatar: {width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center'},
  avatarText: {fontSize: 13, fontWeight: '800', color: '#FFF'},
  missionDot: {position: 'absolute', top: -4, right: -4, width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444', shadowColor: '#ef4444', shadowOffset: {width: 0, height: 0}, shadowOpacity: 0.6, shadowRadius: 4},
  groupInfo: {flex: 1, minWidth: 0},
  groupTopRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3},
  groupName: {fontSize: 13, fontWeight: '700', color: '#F2F4F8', flex: 1},
  groupTime: {fontSize: 10, color: 'rgba(180,188,204,0.45)', flexShrink: 0, marginLeft: 8},
  groupBottomRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  groupLastMsg: {fontSize: 11, color: 'rgba(229,233,242,0.62)', flex: 1},
  unreadBadge: {minWidth: 18, minHeight: 18, borderRadius: 9, paddingVertical: 1, backgroundColor: '#5B8DEF', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, marginLeft: 8},
  unreadText: {fontSize: 10, fontWeight: '800', color: '#FFF'},
  memberCount: {fontSize: 10, color: 'rgba(180,188,204,0.45)', marginLeft: 8},

  fab: {position: 'absolute', right: 20, width: 52, height: 52, borderRadius: 26, backgroundColor: '#5B8DEF', alignItems: 'center', justifyContent: 'center', shadowColor: '#5B8DEF', shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.5, shadowRadius: 16, elevation: 8},

  emptyWrap: {alignItems: 'center', paddingVertical: 60, paddingHorizontal: 32, gap: 10},
  emptyTitle: {color: 'rgba(229,233,242,0.62)', fontSize: 14, fontWeight: '700', marginTop: 8},
  emptyHint: {color: 'rgba(180,188,204,0.45)', fontSize: 11, textAlign: 'center', lineHeight: 16, maxWidth: 300},
  emptyCta: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 99, backgroundColor: '#5B8DEF'},
  emptyCtaText: {color: '#FFF', fontSize: 13, fontWeight: '700', letterSpacing: 0.5},
}));
