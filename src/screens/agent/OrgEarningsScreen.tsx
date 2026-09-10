/**
 * OrgEarningsScreen (F6) — the agency's consolidated earnings. The dashboard's
 * "Org Earnings" row previously opened the INDIVIDUAL CPO EarningsScreen
 * (personal wallet, personal stats) — the org roll-up endpoint existed but was
 * never called. Totals + one row per settled/settling escrow split, with the
 * platform-fee line visible. Obsidian theme, matching OrgMissionsScreen.
 */
import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, FlatList, TouchableOpacity, StatusBar, RefreshControl} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {orgApi} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type Earnings = Awaited<ReturnType<typeof orgApi.getEarnings>>['data'];

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)', hair: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80', amber: '#F5C76B', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

function fmtDate(iso: string | null): string {
  if (!iso) {return '—';}
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', timeZone: 'UTC'});
}

function holdTint(status: string): string {
  if (status === 'RELEASED' || status === 'PARTIAL') {return D.signal;}
  if (status === 'DISPUTED') {return D.alert;}
  return D.amber; // PENDING_RELEASE
}

export default function OrgEarningsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<{goBack: () => void}>();
  const [data, setData] = useState<Earnings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await orgApi.getEarnings();
      setData(res.data);
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Failed to load earnings');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="chevron-left" size={22} color={D.text} />
        </TouchableOpacity>
        <View style={s.accentBar} />
        <Text style={s.headerTitle}>ORG EARNINGS</Text>
      </View>

      {!data && !error ? (
        <View style={s.center}><LoadingView compact label="Loading earnings…" /></View>
      ) : error ? (
        <View style={s.center}><Text style={s.error}>{error}</Text></View>
      ) : data ? (
        <FlatList
          data={data.rows}
          keyExtractor={r => r.booking_id}
          contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 24, gap: 9}}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={D.accent}
            onRefresh={() => { setRefreshing(true); void load(); }} />}
          ListHeaderComponent={
            <View style={{gap: 10, marginBottom: 12}}>
              <View style={s.heroCard}>
      <ImageryBackdrop source={Imagery.orgFinance} variant="hero" radius={18} />
                <Text style={s.heroLabel}>NET EARNED</Text>
                <Text style={s.heroVal}>{data.total_net_credits.toLocaleString()} <Text style={s.heroUnit}>BC</Text></Text>
                <View style={s.heroRow}>
                  <Text style={s.heroSub}>Gross {data.total_gross_credits.toLocaleString()}</Text>
                  <Text style={s.heroSub}>Fees −{data.total_fee_credits.toLocaleString()}</Text>
                  <Text style={[s.heroSub, {color: D.amber}]}>Pending {data.pending_credits.toLocaleString()}</Text>
                </View>
              </View>
              <Text style={s.sectionLabel}>MISSIONS · {data.total_missions}</Text>
            </View>
          }
          ListEmptyComponent={
            <View style={s.center}>
              <Icon name="wallet-outline" size={26} color={D.textMute} />
              <Text style={s.emptyText}>Completed missions settle here after the dispute window.</Text>
            </View>
          }
          renderItem={({item: r}) => (
            <View style={s.row}>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.rowTitle} numberOfLines={1}>{r.short_code ?? r.booking_id.slice(0, 8).toUpperCase()}</Text>
                <Text style={s.rowMeta} numberOfLines={1}>{r.region_label} · {fmtDate(r.ended_at)}</Text>
              </View>
              <View style={{alignItems: 'flex-end', gap: 2}}>
                <Text style={[s.rowAmt, {color: holdTint(r.hold_status)}]}>
                  {(r.to_provider_credits ?? r.gross_credits).toLocaleString()} BC
                </Text>
                <Text style={s.rowStatus}>
                  {r.hold_status === 'PENDING_RELEASE' ? 'SETTLING'
                    : r.hold_status === 'DISPUTED' ? 'DISPUTED'
                    : (r.platform_fee_credits ?? 0) > 0 ? `fee −${(r.platform_fee_credits ?? 0).toLocaleString()}` : 'SETTLED'}
                </Text>
              </View>
            </View>
          )}
        />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 20, paddingVertical: 14},
  backBtn: {width: 42, height: 42, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: D.hair, alignItems: 'center', justifyContent: 'center'},
  accentBar: {width: 3, height: 17, borderRadius: 2, backgroundColor: D.accent},
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 13, letterSpacing: 2.2, color: D.text},
  center: {alignItems: 'center', justifyContent: 'center', paddingVertical: 42, gap: 10, paddingHorizontal: 32},
  error: {color: D.alert, fontSize: 12, textAlign: 'center', fontFamily: D.fSans},
  emptyText: {fontFamily: D.fSans, fontSize: 12.5, color: D.textDim, textAlign: 'center', lineHeight: 18},
  heroCard: {borderRadius: 18, padding: 18, gap: 6, backgroundColor: 'rgba(91,141,239,0.08)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.24)'},
  heroLabel: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.6, color: D.textMute},
  heroVal: {fontFamily: D.fBold, fontSize: 30, letterSpacing: -0.6, color: D.text},
  heroUnit: {fontSize: 15, color: D.accentSoft},
  heroRow: {flexDirection: 'row', gap: 14, marginTop: 2},
  heroSub: {fontFamily: D.fSemi, fontSize: 11, color: D.textDim},
  sectionLabel: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.5, color: D.textMute, marginLeft: 2},
  row: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair},
  rowTitle: {fontFamily: D.fBold, fontSize: 13, color: D.text, letterSpacing: 0.3},
  rowMeta: {fontFamily: D.fSans, fontSize: 11.5, color: D.textMute, marginTop: 1},
  rowAmt: {fontFamily: D.fBold, fontSize: 13.5},
  rowStatus: {fontFamily: D.fSemi, fontSize: 9, letterSpacing: 0.8, color: D.textMute},
}));
