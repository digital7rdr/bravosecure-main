/**
 * CPO protection dashboard (spec §6). Assigned customers today + any live
 * session, with server-computed staleness. Every read is scoped server-side to
 * `cpo_user_id = caller` — a CPO can never see another CPO's customers (§9).
 * Polls the overview every 5s; the active-session screen holds the live map.
 */
import React, {useCallback, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, RefreshControl, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useBottomInset} from '@hooks/useBottomInset';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {cpoProtectionApi, type CpoProtectionCustomer, type StalenessState} from '@services/api';

const D = {
  bg: '#07090D', card: 'rgba(22,27,37,0.72)', text: '#F2F4F8',
  textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.06)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80', amber: '#F5C76B', danger: '#F87171', grey: '#8A93A6',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold', fMono: 'monospace',
};

const STALE_COLOR: Record<StalenessState, string> = {
  live: D.signal, delayed: D.amber, unavailable: D.danger, idle: D.grey,
};
const STALE_LABEL: Record<StalenessState, string> = {
  live: 'LIVE', delayed: 'DELAYED', unavailable: 'UNAVAILABLE', idle: 'IDLE',
};

function ageText(sec: number | null): string {
  if (sec === null) {return '—';}
  if (sec < 60) {return `${sec}s ago`;}
  return `${Math.floor(sec / 60)}m ago`;
}

export default function CpoProtectionScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const {contentBottom} = useBottomInset();
  const [customers, setCustomers] = useState<CpoProtectionCustomer[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const {data} = await cpoProtectionApi.overview();
      setCustomers(data.customers);
    } catch {
      setCustomers(prev => prev ?? []);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
    const t = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(t);
  }, [load]));

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  }, [load]);

  const live = (customers ?? []).filter(c => c.session_id);
  const idle = (customers ?? []).filter(c => !c.session_id);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}
          accessibilityRole="button" accessibilityLabel="Go back" hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>PROTECTION</Text>
        <TouchableOpacity style={s.back}
          onPress={() => (navigation as unknown as {navigate: (n: string) => void}).navigate('CpoProtectionHistory')}
          activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Mission history">
          <Icon name="history" size={19} color={D.accentSoft} />
        </TouchableOpacity>
      </View>

      {customers === null ? (
        <View style={s.loadingWrap}><ActivityIndicator color={D.accent} /></View>
      ) : (
        <ScrollView
          style={{flex: 1}}
          contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(24)}}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={D.accent} />}>

          {customers.length === 0 && (
            <View style={s.emptyWrap}>
              <Icon name="shield-account-outline" size={38} color={D.textMute} />
              <Text style={s.emptyText}>No assigned customers today.</Text>
            </View>
          )}

          {live.length > 0 && <Text style={s.sectionLabel}>LIVE SESSIONS</Text>}
          {live.map(c => (
            <TouchableOpacity key={c.assignment_id} style={[s.card, s.cardLive]} activeOpacity={0.85}
              onPress={() => (navigation as unknown as {navigate: (n: string, p?: object) => void})
                .navigate('CpoProtectionSession', {sessionId: c.session_id})}
              accessibilityRole="button" accessibilityLabel={`Open ${c.session_customer_name ?? c.owner_name ?? 'session'}`}>
              <View style={s.cardTop}>
                <Text style={s.cardName} numberOfLines={1}>{c.session_customer_name ?? c.owner_name ?? 'Customer'}</Text>
                {c.sos_active ? <View style={s.sosPill}><Text style={s.sosPillText}>SOS</Text></View> : null}
              </View>
              <View style={s.cardMetaRow}>
                <View style={[s.stalePill, {borderColor: STALE_COLOR[c.staleness?.state ?? 'idle'] + '66'}]}>
                  <View style={[s.staleDot, {backgroundColor: STALE_COLOR[c.staleness?.state ?? 'idle']}]} />
                  <Text style={[s.stalePillText, {color: STALE_COLOR[c.staleness?.state ?? 'idle']}]}>
                    {STALE_LABEL[c.staleness?.state ?? 'idle']}
                  </Text>
                </View>
                <Text style={s.cardMeta}>last fix {ageText(c.staleness?.age_seconds ?? null)}</Text>
                <Icon name="chevron-right" size={18} color={D.textMute} style={{marginLeft: 'auto'}} />
              </View>
            </TouchableOpacity>
          ))}

          {idle.length > 0 && <Text style={s.sectionLabel}>ASSIGNED — NO ACTIVE SESSION</Text>}
          {idle.map(c => (
            <View key={c.assignment_id} style={s.card}>
              <Text style={s.cardName} numberOfLines={1}>{c.owner_name ?? 'Customer'}</Text>
              <Text style={s.cardMeta}>Covered {c.starts_on} → {c.ends_on}</Text>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14},
  back: {width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontFamily: D.fMono, fontSize: 11, fontWeight: '700', letterSpacing: 2, color: D.accentSoft},
  loadingWrap: {paddingTop: 80, alignItems: 'center'},
  emptyWrap: {alignItems: 'center', paddingTop: 80, gap: 10},
  emptyText: {fontFamily: D.fSans, fontSize: 13, color: D.textDim},
  sectionLabel: {color: D.textDim, fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 2, textTransform: 'uppercase', marginTop: 20, marginBottom: 10},
  card: {padding: 14, borderRadius: 16, backgroundColor: D.card, borderWidth: 1, borderColor: D.hair, marginBottom: 10},
  cardLive: {borderColor: 'rgba(91,141,239,0.34)', backgroundColor: 'rgba(91,141,239,0.08)'},
  cardTop: {flexDirection: 'row', alignItems: 'center', gap: 8},
  cardName: {flex: 1, minWidth: 0, fontFamily: D.fBold, fontSize: 15, color: D.text},
  cardMetaRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10},
  cardMeta: {fontFamily: D.fMono, fontSize: 11, color: D.textDim},
  stalePill: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 99, borderWidth: 1},
  staleDot: {width: 6, height: 6, borderRadius: 3},
  stalePillText: {fontFamily: D.fBold, fontSize: 8.5, letterSpacing: 0.8},
  sosPill: {paddingVertical: 3, paddingHorizontal: 8, borderRadius: 7, backgroundColor: 'rgba(248,113,113,0.14)', borderWidth: 1, borderColor: 'rgba(248,113,113,0.4)'},
  sosPillText: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 1, color: D.danger},
}));
