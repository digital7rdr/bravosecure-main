/**
 * CPO Mission History (spec §2/§9). This officer's past + present protection
 * sessions — one canonical record per mission, role-filtered by the backend.
 * Handles the required UI states: loading / empty / error+retry / loaded /
 * pagination / read-only (completed rows open a read-only session view).
 * Mission Status (Completed/Cancelled/Expired/Aborted) and Protection Status
 * (Not activated / Active / Ended) are shown as DISTINCT labels.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, ActivityIndicator, RefreshControl,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useBottomInset} from '@hooks/useBottomInset';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {cpoProtectionApi, type ProtectionHistorySession} from '@services/api';

const D = {
  bg: '#07090D', card: 'rgba(22,27,37,0.72)', text: '#F2F4F8',
  textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.06)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80', amber: '#F5C76B', danger: '#F87171', grey: '#8A93A6',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold', fMono: 'monospace',
};

const PAGE = 20;

function missionLabel(s: ProtectionHistorySession): {text: string; color: string} {
  switch (s.status) {
    case 'ACTIVE': case 'REQUESTED': case 'ENDING': return {text: 'Live', color: D.signal};
    case 'COMPLETED': return {text: s.end_reason === 'timeout' ? 'Expired' : 'Completed', color: D.textDim};
    case 'ABORTED': return {text: 'Aborted', color: D.amber};
    default: return {text: String(s.status), color: D.textDim};
  }
}
function protLabel(p: ProtectionHistorySession['protection_status']): string {
  return p === 'active' ? 'Protection active' : p === 'ended' ? 'Protection ended' : 'Not activated';
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'});
}

export default function CpoProtectionHistoryScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const {contentBottom} = useBottomInset();
  const [sessions, setSessions] = useState<ProtectionHistorySession[] | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const load = useCallback(async () => {
    setError(false);
    try {
      const {data} = await cpoProtectionApi.history(PAGE);
      setSessions(data.sessions);
      setHasMore(data.sessions.length === PAGE);
    } catch {
      setError(true);
      setSessions(prev => prev ?? null);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !sessions || sessions.length === 0) {return;}
    setLoadingMore(true);
    try {
      const before = sessions[sessions.length - 1].created_at;
      const {data} = await cpoProtectionApi.history(PAGE, before);
      setSessions(prev => [...(prev ?? []), ...data.sessions]);
      setHasMore(data.sessions.length === PAGE);
    } catch { /* keep what we have; a retry re-fires on next scroll */ }
    finally { setLoadingMore(false); }
  }, [loadingMore, hasMore, sessions]);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  }, [load]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}
          accessibilityRole="button" accessibilityLabel="Go back" hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>MISSION HISTORY</Text>
        <View style={{width: 40}} />
      </View>

      {sessions === null && !error && <View style={s.center}><ActivityIndicator color={D.accent} /></View>}

      {error && sessions === null && (
        <View style={s.center}>
          <Icon name="wifi-off" size={30} color={D.textMute} />
          <Text style={s.dim}>Couldn't load history.</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => { void load(); }} activeOpacity={0.85}>
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {sessions !== null && (
        <ScrollView
          style={{flex: 1}}
          contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(24)}}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={D.accent} />}
          onScroll={({nativeEvent}) => {
            const {layoutMeasurement, contentOffset, contentSize} = nativeEvent;
            if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 120) {void loadMore();}
          }}
          scrollEventThrottle={200}>

          {sessions.length === 0 && (
            <View style={s.center}>
              <Icon name="history" size={34} color={D.textMute} />
              <Text style={s.dim}>No protection missions yet.</Text>
            </View>
          )}

          {sessions.map(sn => {
            const ml = missionLabel(sn);
            return (
              <TouchableOpacity key={sn.id} style={s.card} activeOpacity={0.85}
                onPress={() => (navigation as unknown as {navigate: (n: string, p?: object) => void}).navigate('CpoProtectionSession', {sessionId: sn.id})}
                accessibilityRole="button" accessibilityLabel={`Open ${sn.customer_name ?? 'mission'}`}>
                <View style={s.cardTop}>
                  <Text style={s.cardName} numberOfLines={1}>{sn.customer_name ?? 'Customer'}</Text>
                  {sn.sos_active ? <View style={s.sosPill}><Text style={s.sosPillText}>SOS</Text></View> : null}
                  <Icon name="chevron-right" size={18} color={D.textMute} />
                </View>
                <View style={s.cardMetaRow}>
                  <View style={[s.tag, {borderColor: ml.color + '55'}]}><Text style={[s.tagText, {color: ml.color}]}>{ml.text}</Text></View>
                  <View style={[s.tag, {borderColor: (sn.protection_status === 'active' ? D.signal : D.hair2)}]}>
                    <Text style={[s.tagText, {color: sn.protection_status === 'active' ? D.signal : D.textDim}]}>{protLabel(sn.protection_status)}</Text>
                  </View>
                </View>
                <Text style={s.cardDate}>{fmtDate(sn.created_at)}</Text>
              </TouchableOpacity>
            );
          })}

          {loadingMore && <View style={{paddingVertical: 16}}><ActivityIndicator color={D.accent} /></View>}
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
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingTop: 80},
  dim: {fontFamily: D.fSans, fontSize: 13, color: D.textDim},
  retryBtn: {marginTop: 6, paddingVertical: 9, paddingHorizontal: 20, borderRadius: 10, backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)'},
  retryText: {fontFamily: D.fBold, fontSize: 13, color: D.accentSoft},
  card: {padding: 14, borderRadius: 16, backgroundColor: D.card, borderWidth: 1, borderColor: D.hair, marginBottom: 10},
  cardTop: {flexDirection: 'row', alignItems: 'center', gap: 8},
  cardName: {flex: 1, minWidth: 0, fontFamily: D.fBold, fontSize: 15, color: D.text},
  cardMetaRow: {flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap'},
  tag: {paddingVertical: 4, paddingHorizontal: 9, borderRadius: 99, borderWidth: 1},
  tagText: {fontFamily: D.fSemi, fontSize: 10.5},
  cardDate: {fontFamily: D.fMono, fontSize: 11, color: D.textMute, marginTop: 8},
  sosPill: {paddingVertical: 3, paddingHorizontal: 8, borderRadius: 7, backgroundColor: 'rgba(248,113,113,0.14)', borderWidth: 1, borderColor: 'rgba(248,113,113,0.4)'},
  sosPillText: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 1, color: D.danger},
}));
