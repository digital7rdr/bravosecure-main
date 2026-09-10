/**
 * Provider · CPO Mission History — a roster officer's completed/aborted-mission
 * call-log (org-scoped + IDOR-gated server-side via GET /org/cpos/:id/missions).
 * Obsidian + platinum-cobalt to match OrgRoster. Read-only; reached by tapping a
 * roster row (MISSION-HISTORY #3).
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, RefreshControl,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {orgApi} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
type Rt = RouteProp<AgentStackParamList, 'OrgCpoMissions'>;

interface MissionRow {
  mission_id: string;
  booking_id: string;
  short_code: string;
  status: string;
  role: string;
  is_lead: boolean;
  started_at: string | null;
  ended_at: string | null;
  route_distance_m: number | null;
  route_duration_s: number | null;
  pickup_address: string;
  dropoff_address: string | null;
  region_label: string | null;
  paid_credits: number | null;
}

const D = {
  bg:         '#07090D',
  card:       '#11151D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.07)',
  accent:     '#5B8DEF',
  accentSoft: '#A9C5FF',
  amber:      '#F5C76B',
  signal:     '#4ADE80',
  alert:      '#FF5D5D',
  fSans:  'Manrope_500Medium',
  fSemi:  'Manrope_600SemiBold',
  fBold:  'Manrope_700Bold',
  fMono:  'monospace',
};

function fmtDate(iso: string | null): string {
  if (!iso) {return '—';}
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  return d.toLocaleDateString(undefined, {day: '2-digit', month: 'short', year: 'numeric'});
}

export default function OrgCpoMissionsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<Rt>();
  const {memberUserId, displayName} = params;

  const [rows, setRows] = useState<MissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const {data} = await orgApi.listMemberMissions(memberUserId);
      setRows(data as MissionRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load mission history.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [memberUserId]);

  useEffect(() => { void load(); }, [load]);

  const completed = rows.filter(r => r.status === 'COMPLETED').length;

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => goBackOnce(navigation)} style={s.backBtn} activeOpacity={0.7}>
          <Icon name="chevron-left" size={26} color={D.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.title} numberOfLines={1}>{displayName ?? 'Officer'}</Text>
          <Text style={s.sub}>{completed} completed · {rows.length} total mission{rows.length === 1 ? '' : 's'}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{padding: 20, paddingBottom: insets.bottom + 24}}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); void load(); }}
            tintColor={D.accent}
          />
        }>
        {loading ? (
          <LoadingView compact label="Loading missions…" />
        ) : error ? (
          <Text style={s.empty}>{error}</Text>
        ) : rows.length === 0 ? (
          <View style={{alignItems: 'center', marginTop: 64}}>
            <Icon name="shield-check-outline" size={42} color={D.textFaint} />
            <Text style={s.empty}>No completed missions yet.</Text>
          </View>
        ) : (
          <View style={{gap: 10}}>
            {rows.map(r => {
              const aborted = r.status === 'ABORTED';
              return (
                <View key={r.mission_id} style={s.card}>
                  <View style={s.cardTop}>
                    <Text style={s.code}>{r.short_code ?? '—'}</Text>
                    <View style={[s.pill, {borderColor: aborted ? '#FF5D5D44' : '#4ADE8044'}]}>
                      <Text style={[s.pillText, {color: aborted ? D.alert : D.signal}]}>{r.status}</Text>
                    </View>
                  </View>
                  <View style={s.routeRow}>
                    <Icon name="circle-outline" size={12} color={D.accentSoft} />
                    <Text style={s.routeText} numberOfLines={1}>{r.pickup_address}</Text>
                  </View>
                  <View style={s.routeRow}>
                    <Icon name="map-marker" size={13} color={D.accent} />
                    <Text style={s.routeText} numberOfLines={1}>{r.dropoff_address ?? '—'}</Text>
                  </View>
                  <View style={s.metaRow}>
                    <Text style={s.meta}>{r.is_lead ? '★ Lead' : (r.role || 'CPO')}</Text>
                    <Text style={s.meta}>{fmtDate(r.ended_at)}</Text>
                    {r.paid_credits !== null && r.paid_credits !== undefined ? (
                      <Text style={s.credits}>+{r.paid_credits.toLocaleString()} BC</Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: D.hair,
  },
  backBtn: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  title: {fontFamily: D.fBold, fontSize: 18, color: D.text, letterSpacing: -0.3},
  sub: {fontFamily: D.fMono, fontSize: 11, color: D.textMute, marginTop: 2, letterSpacing: 0.3},
  empty: {fontFamily: D.fSans, fontSize: 13, color: D.textDim, textAlign: 'center', marginTop: 14},
  card: {
    backgroundColor: D.card, borderRadius: 16, padding: 14,
    borderWidth: StyleSheet.hairlineWidth, borderColor: D.hair, gap: 7,
  },
  cardTop: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  code: {fontFamily: D.fBold, fontSize: 13.5, color: D.text, letterSpacing: 0.4},
  pill: {borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3},
  pillText: {fontFamily: D.fSemi, fontSize: 9.5, letterSpacing: 0.8},
  routeRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  routeText: {flex: 1, fontFamily: D.fSans, fontSize: 12.5, color: D.textDim},
  metaRow: {flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 3},
  meta: {fontFamily: D.fMono, fontSize: 10.5, color: D.textMute, letterSpacing: 0.3},
  credits: {fontFamily: D.fSemi, fontSize: 11.5, color: D.signal, marginLeft: 'auto'},
}));
