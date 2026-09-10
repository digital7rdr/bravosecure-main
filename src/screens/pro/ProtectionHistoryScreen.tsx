/**
 * User Mission History (spec §3, Final Flow → User View). The customer's own
 * protection sessions — read-only. Each card expands to the role-filtered
 * timeline (internal ops/cpo detail never reaches the user, §7). States:
 * loading / empty / error+retry / loaded / pagination. Mission Status
 * (Completed/Aborted/Expired) shown distinctly from Protection Status.
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
import {useProPlanGate} from '@hooks/useProPlanGate';
import {protectionApi, type ProtectionSessionHistoryEntry, type ProtectionEvent} from '@services/api';

const D = {
  bg: '#07090D', card: 'rgba(22,27,37,0.72)', text: '#F2F4F8',
  textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.06)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80', amber: '#F5C76B', danger: '#F87171',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold', fMono: 'monospace',
};
const PAGE = 20;
const EVENT_LABEL: Record<string, string> = {
  created: 'Requested', activated: 'Protection started', protect: 'Protection engaged', sos: 'SOS raised',
  note: 'Message', ended: 'Ended', aborted: 'Aborted', timeout: 'Ended (time limit)', reassigned: 'Officer changed',
};

function missionLabel(s: ProtectionSessionHistoryEntry): {text: string; color: string} {
  switch (s.status) {
    case 'ACTIVE': case 'REQUESTED': case 'ENDING': return {text: 'Live', color: D.signal};
    case 'COMPLETED': return {text: s.end_reason === 'timeout' ? 'Expired' : 'Completed', color: D.textDim};
    case 'ABORTED': return {text: 'Not started', color: D.amber};
    default: return {text: String(s.status), color: D.textDim};
  }
}
function fmt(iso: string | null): string {
  if (!iso) {return '—';}
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'});
}

export default function ProtectionHistoryScreen() {
  useProPlanGate();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const {contentBottom} = useBottomInset();
  const [sessions, setSessions] = useState<ProtectionSessionHistoryEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, ProtectionEvent[] | 'loading' | 'error'>>({});

  const load = useCallback(async () => {
    setError(false);
    try {
      const {data} = await protectionApi.history(PAGE);
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
      const {data} = await protectionApi.history(PAGE, sessions[sessions.length - 1].created_at);
      setSessions(prev => [...(prev ?? []), ...data.sessions]);
      setHasMore(data.sessions.length === PAGE);
    } catch { /* keep what we have */ }
    finally { setLoadingMore(false); }
  }, [loadingMore, hasMore, sessions]);

  useEffect(() => { void load(); }, [load]);
  const onRefresh = useCallback(() => { setRefreshing(true); void load().finally(() => setRefreshing(false)); }, [load]);

  const toggle = useCallback((id: string) => {
    setOpenId(cur => (cur === id ? null : id));
    if (events[id] && events[id] !== 'error') {return;}
    setEvents(e => ({...e, [id]: 'loading'}));
    void protectionApi.timeline(id)
      .then(r => setEvents(e => ({...e, [id]: r.data.events})))
      .catch(() => setEvents(e => ({...e, [id]: 'error'})));
  }, [events]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}
          accessibilityRole="button" accessibilityLabel="Go back" hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>PROTECTION HISTORY</Text>
        <View style={{width: 40}} />
      </View>

      {sessions === null && !error && <View style={s.center}><ActivityIndicator color={D.accent} /></View>}
      {error && sessions === null && (
        <View style={s.center}>
          <Icon name="wifi-off" size={30} color={D.textMute} />
          <Text style={s.dim}>Couldn't load your history.</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => { void load(); }} activeOpacity={0.85}>
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {sessions !== null && (
        <ScrollView style={{flex: 1}}
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
              <Icon name="shield-outline" size={34} color={D.textMute} />
              <Text style={s.dim}>No protection sessions yet.</Text>
            </View>
          )}

          {sessions.map(sn => {
            const ml = missionLabel(sn);
            const ev = events[sn.id];
            const open = openId === sn.id;
            return (
              <View key={sn.id} style={s.card}>
                <TouchableOpacity onPress={() => toggle(sn.id)} activeOpacity={0.85}
                  accessibilityRole="button" accessibilityLabel={`Toggle ${sn.cpo_name ?? 'session'} history`}>
                  <View style={s.cardTop}>
                    <Text style={s.cardName} numberOfLines={1}>Officer {sn.cpo_name ?? '—'}</Text>
                    {sn.sos_active ? <View style={s.sosPill}><Text style={s.sosPillText}>SOS</Text></View> : null}
                    <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={D.textMute} />
                  </View>
                  <View style={s.tagRow}>
                    <View style={[s.tag, {borderColor: ml.color + '55'}]}><Text style={[s.tagText, {color: ml.color}]}>{ml.text}</Text></View>
                    <View style={[s.tag, {borderColor: sn.protection_status === 'active' ? D.signal : D.hair2}]}>
                      <Text style={[s.tagText, {color: sn.protection_status === 'active' ? D.signal : D.textDim}]}>
                        {sn.protection_status === 'active' ? 'Protection active' : sn.protection_status === 'ended' ? 'Protection ended' : 'Not activated'}
                      </Text>
                    </View>
                  </View>
                  <Text style={s.cardDate}>{fmt(sn.created_at)}</Text>
                </TouchableOpacity>

                {open && (
                  <View style={s.timeline}>
                    {ev === 'loading' && <ActivityIndicator color={D.accent} style={{marginVertical: 8}} />}
                    {ev === 'error' && (
                      <TouchableOpacity onPress={() => toggle(sn.id)} activeOpacity={0.8}>
                        <Text style={[s.dim, {color: D.amber}]}>Couldn't load — tap to retry</Text>
                      </TouchableOpacity>
                    )}
                    {Array.isArray(ev) && ev.length === 0 && <Text style={s.dim}>No activity recorded.</Text>}
                    {Array.isArray(ev) && [...ev].reverse().map(e => (
                      <View key={e.id} style={s.eventRow}>
                        <View style={s.eventDot} />
                        <View style={{flex: 1, minWidth: 0}}>
                          <Text style={s.eventLabel}>{EVENT_LABEL[e.event_type] ?? e.event_type}{e.comment ? ` — ${e.comment}` : ''}</Text>
                          <Text style={s.eventTime}>{fmt(e.created_at)}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </View>
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
  cardName: {flex: 1, minWidth: 0, fontFamily: D.fBold, fontSize: 14.5, color: D.text},
  tagRow: {flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap'},
  tag: {paddingVertical: 4, paddingHorizontal: 9, borderRadius: 99, borderWidth: 1},
  tagText: {fontFamily: D.fSemi, fontSize: 10.5},
  cardDate: {fontFamily: D.fMono, fontSize: 11, color: D.textMute, marginTop: 8},
  timeline: {marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: D.hair, gap: 9},
  eventRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 10},
  eventDot: {width: 7, height: 7, borderRadius: 4, marginTop: 5, backgroundColor: D.accentSoft},
  eventLabel: {fontFamily: D.fSans, fontSize: 13, color: D.text, lineHeight: 18},
  eventTime: {fontFamily: D.fMono, fontSize: 10, color: D.textMute, marginTop: 2},
  sosPill: {paddingVertical: 3, paddingHorizontal: 8, borderRadius: 7, backgroundColor: 'rgba(248,113,113,0.14)', borderWidth: 1, borderColor: 'rgba(248,113,113,0.4)'},
  sosPillText: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 1, color: D.danger},
}));
