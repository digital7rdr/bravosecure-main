import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl, TouchableOpacity} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import type {AgentStackParamList} from '@navigation/types';
import {incidentApi, orgApi, type IncidentReportDto, type IncidentSeverityDto, type IncidentStatusDto, type IncidentCategoryDto} from '@services/api';
import {OB, ObHeader, Card, ErrorState, loadErrorText} from './_obsidian';
import {INCIDENT_CATEGORIES, INCIDENT_CATEGORY_META, INCIDENT_STATUS_META, severityColor} from './incidentMeta';
import {fmtTime} from './geo';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
const FILTERS: ({key: 'all'} | {key: IncidentSeverityDto})[] = [
  {key: 'all'}, {key: 'critical'}, {key: 'high'}, {key: 'medium'}, {key: 'low'},
];
// PDF p.14 — status filter row (server-side; severity row above it).
const STATUS_FILTERS: Array<'all' | IncidentStatusDto> = [
  'all', 'submitted', 'received', 'under_review', 'action_assigned', 'resolved', 'closed',
];
// Item H (A8) — the remaining server-accepted filters, finally wired:
// category, from/to (as presets), department. All server-side; a scoped
// manager's own branch FORCES the department param regardless of the chip
// (the controller overrides it), so the branch row is honest for unscoped
// managers and inert-but-harmless for scoped ones.
const DATE_PRESETS = [
  {key: 'all', label: 'All time', days: 0},
  {key: '7d', label: '7 days', days: 7},
  {key: '30d', label: '30 days', days: 30},
  {key: '90d', label: '90 days', days: 90},
] as const;
type DatePreset = (typeof DATE_PRESETS)[number]['key'];

export default function IncidentQueueScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [items, setItems] = useState<IncidentReportDto[]>([]);
  const [filter, setFilter] = useState<'all' | IncidentSeverityDto>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | IncidentStatusDto>('all');
  const [catFilter, setCatFilter] = useState<'all' | IncidentCategoryDto>('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [departments, setDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // F15 — a manager denied the queue must not read it as "no incidents".
  const [loadError, setLoadError] = useState<string | null>(null);

  // Stale-response guard, same class as MonthlyRoster's: five filter axes
  // now race their loads, and whichever response resolved LAST would win.
  const reqRef = React.useRef(0);
  const load = useCallback(async (
    sev: 'all' | IncidentSeverityDto, st: 'all' | IncidentStatusDto,
    cat: 'all' | IncidentCategoryDto, preset: DatePreset, dept: string,
  ) => {
    const req = ++reqRef.current;
    try {
      const days = DATE_PRESETS.find(p => p.key === preset)?.days ?? 0;
      const {data} = await incidentApi.queue({
        ...(sev === 'all' ? {} : {severity: sev}),
        ...(st === 'all' ? {} : {status: st}),
        ...(cat === 'all' ? {} : {category: cat}),
        ...(days > 0 ? {from: new Date(Date.now() - days * 86_400_000).toISOString()} : {}),
        ...(dept === 'all' ? {} : {department: dept}),
      });
      if (req !== reqRef.current) {return;}
      setItems(data);
      setLoadError(null);
    } catch (e) {
      if (req !== reqRef.current) {return;}
      setItems([]);
      setLoadError(loadErrorText(e));
    } finally {
      if (req === reqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load(filter, statusFilter, catFilter, datePreset, deptFilter);
  }, [load, filter, statusFilter, catFilter, datePreset, deptFilter]));

  // Branch chips from the roster — its OWN focus effect (empty filter deps),
  // or every chip tap refetched the whole roster alongside the queue. Roster
  // departments are the same grouping every other manager surface uses — no
  // team entity exists. Best-effort: the row degrades to absent.
  useFocusEffect(useCallback(() => {
    void orgApi.listCpos().then(({data}) => {
      const seen = [...new Set(data.map(m => m.department).filter((d): d is string => !!d))].sort();
      setDepartments(seen);
    }).catch(() => { /* keep whatever we had */ });
  }, []));

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Incident Queue" onBack={() => navigation.goBack()} pill={`${items.length}`} />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterScroll} contentContainerStyle={s.filterRow}>
        {FILTERS.map(f => {
          const on = filter === f.key;
          const color = f.key === 'all' ? OB.accentSoft : severityColor(f.key);
          return (
            <TouchableOpacity
              key={f.key}
              style={[s.chip, s.statusChip, on && {backgroundColor: color + '1F', borderColor: color}]}
              activeOpacity={0.8}
              onPress={() => { setFilter(f.key); setLoading(true); }}>
              <Text style={[s.chipText, on && {color}]} numberOfLines={1}>{f.key === 'all' ? 'All' : f.key[0].toUpperCase() + f.key.slice(1)}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.statusScroll} contentContainerStyle={s.statusRow}>
        {STATUS_FILTERS.map(st => {
          const on = statusFilter === st;
          const label = st === 'all' ? 'All' : INCIDENT_STATUS_META[st]?.label ?? st;
          return (
            <TouchableOpacity
              key={st}
              style={[s.chip, s.statusChip, on && {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.55)'}]}
              activeOpacity={0.8}
              onPress={() => { setStatusFilter(st); setLoading(true); }}>
              <Text style={[s.chipText, on && {color: OB.accentSoft}]} numberOfLines={1}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Item H (A8) — category row. Same B-190 shape as its siblings:
          horizontal, own height, gap in marginBottom, flexShrink:0 chips. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.catScroll} contentContainerStyle={s.catRow}>
        {(['all', ...INCIDENT_CATEGORIES] as Array<'all' | IncidentCategoryDto>).map(c => {
          const on = catFilter === c;
          const label = c === 'all' ? 'All categories' : INCIDENT_CATEGORY_META[c]?.label ?? c;
          return (
            <TouchableOpacity
              key={c}
              style={[s.chip, s.statusChip, on && {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.55)'}]}
              activeOpacity={0.8}
              onPress={() => { setCatFilter(c); setLoading(true); }}>
              <Text style={[s.chipText, on && {color: OB.accentSoft}]} numberOfLines={1}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Date presets + branch, one row — presets beat raw pickers here (two
          taps to any answer a manager actually asks for). */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.rangeScroll} contentContainerStyle={s.rangeRow}>
        {DATE_PRESETS.map(p => {
          const on = datePreset === p.key;
          return (
            <TouchableOpacity
              key={p.key}
              style={[s.chip, s.statusChip, on && {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.55)'}]}
              activeOpacity={0.8}
              onPress={() => { setDatePreset(p.key); setLoading(true); }}>
              <Text style={[s.chipText, on && {color: OB.accentSoft}]} numberOfLines={1}>{p.label}</Text>
            </TouchableOpacity>
          );
        })}
        {departments.length > 0 && (
          <>
            <View style={s.rangeDivider} />
            {(['all', ...departments]).map(d => {
              const on = deptFilter === d;
              return (
                <TouchableOpacity
                  key={d}
                  style={[s.chip, s.statusChip, on && {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.55)'}]}
                  activeOpacity={0.8}
                  onPress={() => { setDeptFilter(d); setLoading(true); }}>
                  <Text style={[s.chipText, on && {color: OB.accentSoft}]} numberOfLines={1}>{d === 'all' ? 'All branches' : d}</Text>
                </TouchableOpacity>
              );
            })}
          </>
        )}
      </ScrollView>

      {/* Managers can also file their own report (submit() is gated only by
          JwtAuthGuard) — without this they'd have to drop to a member surface. */}
      <View style={{paddingHorizontal: 20, paddingBottom: 12}}>
        <TouchableOpacity style={s.reportBtn} activeOpacity={0.85} onPress={() => navigation.navigate('ReportIncidentCategory')}>
          <Icon name="alert-octagon-outline" size={16} color={OB.accentSoft} />
          <Text style={s.reportText}>Report an Incident</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 32}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(filter, statusFilter, catFilter, datePreset, deptFilter); }} tintColor={OB.accentSoft} />}>
        {loading ? (
          <LoadingView compact label="Loading incidents…" />
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => { setLoading(true); void load(filter, statusFilter, catFilter, datePreset, deptFilter); }} />
        ) : items.length === 0 ? (
          <Card><Text style={s.empty}>No incidents in this view.</Text></Card>
        ) : (
          <View style={{gap: 10}}>
            {items.map(it => {
              const cat = INCIDENT_CATEGORY_META[it.category];
              const sevC = severityColor(it.severity);
              const st = INCIDENT_STATUS_META[it.status];
              return (
                <Card key={it.id} onPress={() => navigation.navigate('IncidentDetail', {incidentId: it.id, ref: it.ref})} style={{gap: 11}}>
                  <View style={s.rowTop}>
                    <View style={[s.sevBar, {backgroundColor: sevC}]} />
                    <Icon name={cat?.icon ?? 'alert-octagon-outline'} size={18} color={OB.glow} />
                    <Text style={s.cat} numberOfLines={1}>{cat?.label ?? it.category}</Text>
                    <Text style={s.ref}>{it.ref ?? '—'}</Text>
                  </View>
                  <View style={s.rowBottom}>
                    <View style={[s.tag, {backgroundColor: sevC + '1A', borderColor: sevC + '4D'}]}>
                      <Text style={[s.tagText, {color: sevC}]}>{it.severity.toUpperCase()}</Text>
                    </View>
                    <View style={[s.tag, {backgroundColor: st.color + '1A', borderColor: st.color + '4D'}]}>
                      <Text style={[s.tagText, {color: st.color}]}>{st.label}</Text>
                    </View>
                    <Text style={s.time}>{fmtTime(it.updated_at)}</Text>
                  </View>
                </Card>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  // Both filter rows scroll horizontally and NEVER wrap. The severity row used
  // to be a plain View of five flex:1 chips, which squeezed "Critical" to an
  // ellipsis at 320dp; sizing each chip to its own label and scrolling is the
  // same treatment the status row already had.
  filterRow: {flexDirection: 'row', gap: 7, paddingHorizontal: 20, alignItems: 'center'},
  chip: {alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: OB.hair},
  // Why explicit height: a horizontal ScrollView with only flexGrow:0 has no
  // intrinsic height to fall back to inside a flex-column parent on Android,
  // so it collapsed below the chip's own height and clipped the label text.
  // The gap below each row lives in marginBottom, NOT in the scrolled content:
  // a paddingBottom inside a fixed-height box eats the chip's own space and
  // clips it top and bottom (which is what folded these labels).
  filterScroll: {flexGrow: 0, height: 40, marginBottom: 10},
  statusScroll: {flexGrow: 0, height: 40, marginBottom: 12},
  statusRow: {flexDirection: 'row', gap: 7, paddingHorizontal: 20, alignItems: 'center'},
  // Item H rows — same explicit-height + marginBottom rules as their pinned
  // siblings above (the B-190 clipping class).
  catScroll: {flexGrow: 0, height: 40, marginBottom: 10},
  catRow: {flexDirection: 'row', gap: 7, paddingHorizontal: 20, alignItems: 'center'},
  rangeScroll: {flexGrow: 0, height: 40, marginBottom: 12},
  rangeRow: {flexDirection: 'row', gap: 7, paddingHorizontal: 20, alignItems: 'center'},
  rangeDivider: {width: 1, height: 20, backgroundColor: OB.hair, marginHorizontal: 3, alignSelf: 'center'},
  // flexShrink: 0 — without it, a longer label ("Submitted", "Under review")
  // inside a horizontal ScrollView row got squeezed narrower than its own
  // text needed and wrapped to two lines, while shorter labels happened to
  // fit and never revealed the bug.
  statusChip: {flexShrink: 0, paddingHorizontal: 12, alignSelf: 'center'},
  chipText: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 11.5},
  reportBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 12, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)'},
  reportText: {color: OB.accentSoft, fontFamily: BravoFont.bold, fontSize: 13},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  rowTop: {flexDirection: 'row', alignItems: 'center', gap: 10},
  sevBar: {width: 3, height: 18, borderRadius: 2},
  cat: {flex: 1, color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  ref: {color: OB.glow, fontFamily: BravoFont.mono, fontSize: 11, fontWeight: '700', letterSpacing: 0.5},
  rowBottom: {flexDirection: 'row', alignItems: 'center', gap: 8},
  tag: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1},
  tagText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8},
  time: {flex: 1, textAlign: 'right', color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 10.5},
}));
