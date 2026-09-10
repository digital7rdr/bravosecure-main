/**
 * Owner-exclusive — Manager Permissions.
 *
 * Only the org owner can reach this (the server enforces it independently:
 * setManagerPermissions throws unless the caller IS the org account itself,
 * mirroring the existing promote/demote owner-only gate). Pick a manager,
 * toggle which dashboard modules they can see. The owner decides absolutely: a
 * manager the owner has granted nothing sees NO modules on their dashboard —
 * there is no baseline set, and every row here is grantable, so nothing is
 * permanently out of the owner's reach.
 */
import React, {useCallback, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  StatusBar, RefreshControl, ActivityIndicator,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {orgApi, type OrgManagerDto} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

const D = {
  bg: '#07090D', card: '#11151D', text: '#F2F4F8',
  textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.07)', accent: '#5B8DEF', accentSoft: '#A9C5FF',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

// Mirrors OrgCpoService.MANAGER_MODULES + the dashboard rows they gate. Every
// dashboard row key must appear here — a manager sees exactly what is toggled
// on, so a missing key would be a module the owner can never grant.
const MODULES: Array<{key: string; label: string; sub: string; icon: React.ComponentProps<typeof Icon>['name']}> = [
  {key: 'jobs',       label: 'Missions',      sub: 'Crew & dispatch accepted jobs',        icon: 'shield-account-outline'},
  {key: 'portal',     label: 'Job Portal',    sub: 'Browse open jobs',                     icon: 'briefcase-search-outline'},
  {key: 'compliance', label: 'Compliance',    sub: 'Licence & insurance review',           icon: 'shield-check-outline'},
  {key: 'roster',     label: 'CPO Roster',    sub: 'Add & manage officers',                icon: 'account-group-outline'},
  {key: 'orgChart',   label: 'Org Chart',     sub: 'Owner · managers · officers',          icon: 'sitemap-outline'},
  {key: 'dept',       label: 'Departmental',  sub: 'Attendance · incidents · channels',    icon: 'office-building-outline'},
  {key: 'earn',       label: 'Org Earnings',  sub: 'Consolidated payouts · escrow splits', icon: 'chart-line'},
  {key: 'msg',        label: 'Messenger',     sub: 'Secure comms · end-to-end encrypted',  icon: 'message-text-outline'},
  {key: 'intel',      label: 'Bravo Feed',    sub: 'Security news · threat alerts',        icon: 'newspaper-variant-outline'},
  {key: 'region',     label: 'Region',        sub: 'Dispatch region & coverage',           icon: 'map-marker-radius-outline'},
];

function initials(name: string | null): string {
  if (!name) {return 'MG';}
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) {return 'MG';}
  if (p.length === 1) {return p[0].slice(0, 2).toUpperCase();}
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

export default function ManagerPermissionsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [managers, setManagers] = useState<OrgManagerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const {data} = await orgApi.listManagers();
      setManagers(data);
    } catch {
      setManagers([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const toggle = async (manager: OrgManagerDto, moduleKey: string) => {
    const has = manager.permitted_modules.includes(moduleKey);
    const next = has
      ? manager.permitted_modules.filter(m => m !== moduleKey)
      : [...manager.permitted_modules, moduleKey];
    const busyId = `${manager.user_id}:${moduleKey}`;
    setBusyKey(busyId);
    // Optimistic — flip locally, roll back on failure.
    setManagers(prev => prev.map(m => m.user_id === manager.user_id ? {...m, permitted_modules: next} : m));
    try {
      await orgApi.setManagerPermissions(manager.user_id, next);
    } catch (e: unknown) {
      setManagers(prev => prev.map(m => m.user_id === manager.user_id ? manager : m));
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Permissions', msg ?? 'Could not update. Please try again.');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Manager Permissions</Text>
        <View style={s.backBtn} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{padding: 20, paddingBottom: insets.bottom + 40}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={D.accentSoft} />}>
        <Text style={s.intro}>
          A manager starts with nothing. Every module you switch on below gives them
          the same access you have for that area; everything left off stays hidden.
        </Text>

        {loading ? (
          <LoadingView compact label="Loading managers…" />
        ) : managers.length === 0 ? (
          <View style={s.empty}><Text style={s.emptyText}>No managers yet. Promote a CPO from the roster to get started.</Text></View>
        ) : (
          managers.map(m => {
            const isOpen = expanded === m.user_id;
            return (
              <View key={m.user_id} style={s.card}>
                <TouchableOpacity style={s.cardHead} activeOpacity={0.8} onPress={() => setExpanded(isOpen ? null : m.user_id)}>
                  {m.avatar_url ? (
                    <Image source={{uri: m.avatar_url}} style={s.avatar} />
                  ) : (
                    <View style={[s.avatar, s.avatarFallback]}><Text style={s.avatarText}>{initials(m.display_name)}</Text></View>
                  )}
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.name} numberOfLines={1}>{m.display_name ?? m.email ?? 'Manager'}</Text>
                    <Text style={s.sub}>{m.permitted_modules.length} of {MODULES.length} modules granted</Text>
                  </View>
                  <Icon name={isOpen ? 'chevron-up' : 'chevron-down'} size={20} color={D.textMute} />
                </TouchableOpacity>

                {isOpen && (
                  <View style={s.moduleList}>
                    {MODULES.map(mod => {
                      const granted = m.permitted_modules.includes(mod.key);
                      const busy = busyKey === `${m.user_id}:${mod.key}`;
                      return (
                        <TouchableOpacity
                          key={mod.key} style={s.moduleRow} activeOpacity={0.8}
                          disabled={busy} onPress={() => { void toggle(m, mod.key); }}>
                          <Icon name={mod.icon} size={18} color={granted ? D.accentSoft : D.textMute} />
                          <View style={{flex: 1, minWidth: 0}}>
                            <Text style={[s.moduleLabel, granted && {color: D.text}]}>{mod.label}</Text>
                            <Text style={s.moduleSub}>{mod.sub}</Text>
                          </View>
                          {busy ? (
                            <ActivityIndicator size="small" color={D.accentSoft} />
                          ) : (
                            <Icon name={granted ? 'toggle-switch' : 'toggle-switch-off-outline'} size={28} color={granted ? D.accent : D.textMute} />
                          )}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10},
  backBtn: {width: 38, height: 38, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {color: D.text, fontFamily: D.fBold, fontSize: 16},
  intro: {color: D.textMute, fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, marginBottom: 18},
  empty: {padding: 24, alignItems: 'center'},
  emptyText: {color: D.textMute, fontFamily: D.fSans, fontSize: 13, textAlign: 'center'},
  card: {backgroundColor: D.card, borderRadius: 16, borderWidth: 1, borderColor: D.hair, marginBottom: 12, overflow: 'hidden'},
  cardHead: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14},
  avatar: {width: 40, height: 40, borderRadius: 20},
  avatarFallback: {backgroundColor: 'rgba(91,141,239,0.14)', alignItems: 'center', justifyContent: 'center'},
  avatarText: {color: D.accentSoft, fontFamily: D.fBold, fontSize: 14},
  name: {color: D.text, fontFamily: D.fBold, fontSize: 14.5},
  sub: {color: D.textMute, fontFamily: D.fSans, fontSize: 11.5, marginTop: 2},
  moduleList: {borderTopWidth: 1, borderTopColor: D.hair},
  moduleRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.04)'},
  moduleLabel: {color: D.textDim, fontFamily: D.fSemi, fontSize: 13},
  moduleSub: {color: D.textMute, fontFamily: D.fSans, fontSize: 11, marginTop: 1},
}));
