import React, {useCallback, useMemo, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, ActivityIndicator, TouchableOpacity, Modal, Image} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, useFocusEffect, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import {drainMembershipIntents} from '@/modules/messenger/orgWorkspace/membershipIntents';
import type {MessengerStackParamList} from '@navigation/types';
import {departmentApi, orgApi, type DepartmentMemberDto, type RosterMember} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, ErrorState, loadErrorText, useInDepartmentalShell} from './_obsidian';
import {deptMemberNoun} from './deptNoun';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;
type Rt = RouteProp<MessengerStackParamList, 'ChannelMembers'>;

function initialOf(name?: string | null): string {
  const trimmed = name?.trim();
  return (trimmed ? trimmed[0] : '?').toUpperCase();
}

export default function ChannelMembersScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const inDepartmentalShell = useInDepartmentalShell();
  const {params} = useRoute<Rt>();
  const {channelId, channelName, canDelete, groupConversationId} = params;
  const myId = useAuthStore(st => st.user?.id);

  const [members, setMembers] = useState<DepartmentMemberDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  // F15 — listMembers 403s for a non-member. "No members yet." made that
  // indistinguishable from an empty channel, on the one screen whose whole
  // subject is membership.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const {data} = await departmentApi.listMembers(channelId);
      setMembers(data.members);
      setLoadError(null);
    } catch (e) {
      setMembers([]);
      setLoadError(loadErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const memberIds = useMemo(() => new Set(members.map(m => m.user_id)), [members]);
  const addable = roster.filter(r => r.status === 'active' && !memberIds.has(r.member_user_id));

  const openPicker = async () => {
    setPicker(true);
    try {
      const {data} = await orgApi.listCpos();
      setRoster(data);
    } catch {
      setRoster([]);
    }
  };

  const add = async (r: RosterMember) => {
    setBusyId(r.member_user_id);
    try {
      await departmentApi.addMember(
        channelId, r.member_user_id,
        r.member_role === 'manager' ? 'admin' : 'viewer',
        // A7.3 — never PERSIST the tenant-dependent staff noun. `role_label` is
        // a custom display badge ("CPO Surveillance"); storing the derived noun
        // froze it at write time, and the read below prefers the stored copy
        // (`m.role_label ?? …`), so renaming the noun would have left an
        // Enterprise roster reading "Employee" and "Member" side by side
        // forever. undefined → NULL → the row derives the live noun at render.
        // 'Manager' is tenant-independent, so it stays.
        r.member_role === 'manager' ? 'Manager' : undefined,
      );
      // So the "X added Y" system line (appendMemberAddedEvent) can resolve a
      // real name instead of falling back to "Member <code>" — the roster
      // knows this name now; the E2EE admin envelope never carries it.
      if (groupConversationId && r.display_name) {
        useMessengerStore.getState().setGroupMemberName(groupConversationId, r.member_user_id, r.display_name);
      }
      setPicker(false);
      await load();
      // Key the new member in NOW rather than waiting for the admin to revisit the
      // channel list — drainMembershipIntents broadcasts the add+rekey so they can
      // decrypt subsequent posts (audit D2-a). D2-b — AWAIT it (the row stays busy) so the
      // rekey lands before the admin can post: a message sent before the rekey would never
      // reach the new member (sealed-sender has no replay). Best-effort: a not-yet-provisioned
      // channel is skipped server+client and re-drained on the next list focus.
      await drainMembershipIntents().catch(() => {});
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Add member', msg ?? 'Could not add.');
    } finally {
      setBusyId(null);
    }
  };

  const remove = (m: DepartmentMemberDto) => {
    Alert.alert('Remove member', `Remove ${m.display_name} from "${channelName}"? They are rekeyed out.`, [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Remove', style: 'destructive', onPress: () => { void doRemove(m); }},
    ]);
  };
  const doRemove = async (m: DepartmentMemberDto) => {
    setBusyId(m.user_id);
    try {
      await departmentApi.removeMember(channelId, m.user_id);
      await load();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Remove', msg ?? 'Could not remove.');
    } finally {
      setBusyId(null);
    }
  };

  // Flip a member between viewer (read-only) and admin (can post). Metadata-only
  // on the server (no rekey — they already hold the key).
  const toggleAccess = async (m: DepartmentMemberDto) => {
    setBusyId(m.user_id);
    try {
      await departmentApi.updateMemberRole(channelId, m.user_id, m.role === 'admin' ? 'viewer' : 'admin');
      await load();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Access', msg ?? 'Could not change access.');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = () => {
    /**
     * vs2 edge A4 — THE COPY WAS FALSE, and A4 is what made it reachable.
     *
     * "This removes it for everyone" describes a teardown that does not
     * happen. `deleteChannel` deletes the directory row and writes an audit
     * entry — nothing else. The Signal group named by `group_conversation_id`
     * stays live on the relay and in every member's local store, key included;
     * the client-side registries are additive and never pruned, so members can
     * keep posting and those posts still fan out and raise push. What the
     * button actually does is remove the channel from the directory and make
     * every server call about it 404.
     *
     * Say that, and say it is irreversible. The full teardown is a separate,
     * larger change (logged in sqa.md against this bug); until it lands, the
     * confirm must not promise it.
     */
    Alert.alert(
      'Delete channel',
      `Delete "${channelName}"? It disappears from the directory and cannot be restored. `
      + 'Existing members may still see the conversation on their devices — archive it instead '
      + 'if you want it closed rather than removed.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Delete', style: 'destructive', onPress: () => { void doDelete(); }},
      ]);
  };
  const doDelete = async () => {
    setBusyId('__delete__');
    try {
      await departmentApi.deleteChannel(channelId);
      /**
       * vs2 edge A4 — do NOT land back on the editor for a channel that no
       * longer exists.
       *
       * `goBack()` was right while the chat header was the only door. A4 added
       * the manage door, and that one pops to `ChannelEditor`, still holding
       * the dead row's params and still showing Save and Archive — both of
       * which then fail with `channel_not_found`, a code that form does not map.
       * Skip past it; `ManageChannels` refetches on focus and self-heals.
       */
      const nav = navigation as unknown as {
        getState?: () => {routes?: Array<{name?: string}>} | undefined;
        pop?: (n: number) => void;
        goBack: () => void;
      };
      const routes = nav.getState?.()?.routes ?? [];
      const previous = routes[routes.length - 2]?.name;
      if (previous === 'ChannelEditor' && nav.pop) {nav.pop(2);} else {nav.goBack();}
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      // vs2 edge A4 — these were rendered as RAW SERVER CODES. `only_creator_
      // can_delete` in particular is user-visible on the chat-header door,
      // which still offers Delete from a client-side owner guess rather than
      // the server's verdict.
      const copy: Record<string, string> = {
        // Deliberately does NOT assert the rule. During a rolling auth deploy
        // the list can come from a NEW instance (which says the workspace owner
        // may delete) while the DELETE lands on an OLD one that still refuses —
        // and telling that owner "only the creator can delete it" would be a
        // confident lie about a rule that no longer exists.
        only_creator_can_delete:
          'That was refused. You may not have permission to delete this channel — '
          + 'try again, or archive it instead.',
        channel_has_sub_channels:
          'This channel still has channels inside it. Move or delete those first.',
        broadcast_channel_cannot_be_deleted:
          'Announcement channels cannot be deleted. Archive it instead.',
        channel_not_found: 'This channel no longer exists.',
      };
      Alert.alert('Delete', (msg && copy[msg]) || msg || 'Could not delete.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Members" onBack={() => navigation.goBack()} pill={`${members.length}`} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}>
        <Text style={s.sub}>{channelName}</Text>
        <View style={{height: 14}} />
        <SectionLabel>MEMBERS</SectionLabel>
        {loading ? (
          <LoadingView compact label="Loading members…" />
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => { setLoading(true); void load(); }} />
        ) : members.length === 0 ? (
          <Card><Text style={s.empty}>No members yet.</Text></Card>
        ) : (
          <View style={{gap: 10}}>
            {members.map(m => {
              const isMe = m.user_id === myId;
              const busy = busyId === m.user_id;
              const isAdmin = m.role === 'admin';
              // B-205 — only offer the access/remove controls the caller is
              // actually allowed to use. The server returns `manageable=false`
              // for a target the caller does not strictly outrank (e.g. a
              // manager looking at the OWNER, or at a peer manager), so a
              // manager can no longer even TAP "Make viewer" on the owner.
              // `!== false` keeps the controls when an older server omits it.
              const canManage = !isMe && m.manageable !== false;
              return (
                <Card key={m.user_id} style={s.row}>
                  {m.avatar_url ? (
                    <Image source={{uri: m.avatar_url}} style={s.avatar} />
                  ) : (
                    <View style={s.avatar}><Text style={s.avatarText}>{initialOf(m.display_name)}</Text></View>
                  )}
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.name} numberOfLines={1}>{m.display_name}{isMe ? ' (you)' : ''}</Text>
                    <Text style={s.role}>{(m.role_label ?? (isAdmin ? 'Admin' : deptMemberNoun()))} · {isAdmin ? 'can post' : 'read only'}</Text>
                  </View>
                  {canManage && (
                    <View style={s.rowActions}>
                      <TouchableOpacity style={s.accessBtn} activeOpacity={0.8} disabled={busy} onPress={() => { void toggleAccess(m); }}>
                        {busy ? <ActivityIndicator size="small" color={OB.accentSoft} />
                              : <Text style={s.accessBtnText}>{isAdmin ? 'Make viewer' : 'Allow post'}</Text>}
                      </TouchableOpacity>
                      <TouchableOpacity style={s.removeBtn} activeOpacity={0.8} disabled={busy} onPress={() => remove(m)}>
                        <Icon name="account-remove-outline" size={18} color={OB.alert} />
                      </TouchableOpacity>
                    </View>
                  )}
                </Card>
              );
            })}
          </View>
        )}
      </ScrollView>

      <View style={[s.footer, {paddingBottom: inDepartmentalShell ? 14 : insets.bottom + 14}]}>
        <PrimaryButton label="Add member" icon="account-plus-outline" onPress={() => { void openPicker(); }} />
        {canDelete && (
          <TouchableOpacity style={s.deleteBtn} activeOpacity={0.8}
            disabled={busyId === '__delete__'} onPress={confirmDelete}>
            {busyId === '__delete__'
              ? <ActivityIndicator size="small" color={OB.alert} />
              : <>
                  <Icon name="trash-can-outline" size={16} color={OB.alert} />
                  <Text style={s.deleteText}>Delete channel</Text>
                </>}
          </TouchableOpacity>
        )}
      </View>

      <Modal visible={picker} transparent animationType="slide" onRequestClose={() => setPicker(false)}>
        <View style={s.modalWrap}>
          <View style={[s.sheet, {paddingBottom: insets.bottom + 16}]}>
            <View style={s.sheetHandle} />
            <Text style={s.sheetTitle} numberOfLines={1}>Add to {channelName}</Text>
            <ScrollView style={{maxHeight: 360}} showsVerticalScrollIndicator={false}>
              {/* Item E — the picker lists the EXISTING roster; this row is the
                  door for someone not on it yet. Pre-selects this channel as
                  the invite's team. */}
              <TouchableOpacity style={s.pickRow} activeOpacity={0.8}
                accessibilityRole="button" accessibilityLabel="Invite someone new by phone or email"
                onPress={() => {
                  setPicker(false);
                  navigation.navigate('InviteMember', {channelId});
                }}>
                <View style={s.avatar}><Icon name="account-plus-outline" size={18} color={OB.accentSoft} /></View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.name} numberOfLines={1}>Invite someone new…</Text>
                  <Text style={s.role}>By phone number or email</Text>
                </View>
                <Icon name="chevron-right" size={18} color={OB.textMute} />
              </TouchableOpacity>
              {addable.length === 0 ? (
                <Text style={[s.empty, {paddingVertical: 18}]}>Everyone active is already a member.</Text>
              ) : addable.map(r => {
                const busy = busyId === r.member_user_id;
                return (
                  <TouchableOpacity key={r.member_user_id} style={s.pickRow} activeOpacity={0.8} disabled={busy} onPress={() => { void add(r); }}>
                    <View style={s.avatar}><Text style={s.avatarText}>{initialOf(r.display_name)}</Text></View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={s.name} numberOfLines={1}>{r.display_name ?? r.email ?? deptMemberNoun()}</Text>
                      <Text style={s.role}>{r.member_role === 'manager' ? 'Manager' : deptMemberNoun()}</Text>
                    </View>
                    {busy ? <ActivityIndicator size="small" color={OB.accentSoft} /> : <Icon name="plus" size={18} color={OB.accentSoft} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={s.closeBtn} activeOpacity={0.8} onPress={() => setPicker(false)}>
              <Text style={s.closeText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  sub: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 13, marginTop: 4},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12},
  avatar: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: OB.hair2,
  },
  avatarText: {color: OB.accentSoft, fontFamily: BravoFont.bold, fontSize: 15},
  name: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  role: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
  removeBtn: {
    width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,139,151,0.10)', borderWidth: 1, borderColor: 'rgba(245,139,151,0.35)',
  },
  rowActions: {flexDirection: 'row', alignItems: 'center', gap: 8},
  accessBtn: {
    paddingHorizontal: 10, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: OB.hair2,
  },
  accessBtnText: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 11},
  deleteBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, marginTop: 10},
  deleteText: {color: OB.alert, fontFamily: BravoFont.semiBold, fontSize: 13},
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
  modalWrap: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)'},
  sheet: {
    backgroundColor: '#11151D', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 10, borderTopWidth: 1, borderColor: OB.hair2,
  },
  sheetHandle: {alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: OB.hair2, marginBottom: 14},
  sheetTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 15, marginBottom: 10},
  pickRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10},
  closeBtn: {alignItems: 'center', justifyContent: 'center', height: 50, marginTop: 8, borderTopWidth: 1, borderTopColor: OB.hair},
  closeText: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 14},
}));
