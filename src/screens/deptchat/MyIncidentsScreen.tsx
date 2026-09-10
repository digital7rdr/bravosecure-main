/**
 * MyIncidentsScreen (Dept Chat v2 — Step 23, PDF p.16 "view own submitted
 * incidents") — the member root of the Departmental Incident tab: a "Report
 * incident" entry plus a read-only list of the incidents THIS member submitted
 * (incidentApi.mine, server-scoped to submitter_id). Tapping a row opens a
 * member-safe detail — internal manager notes / assignee are NEVER fetched or
 * shown here (those live only on the manager `detail` endpoint).
 */
import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import type {DeptIncidentStackParamList} from '@navigation/types';
import {incidentApi, type IncidentReportDto} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, ErrorState, loadErrorText} from './_obsidian';
import {INCIDENT_CATEGORY_META, INCIDENT_STATUS_META, severityColor} from './incidentMeta';
import {fmtTime} from './geo';
import {useShowOrgLabels, orgLabelFor} from './crossOrgLabel';

type Nav = NativeStackNavigationProp<DeptIncidentStackParamList>;

export default function MyIncidentsScreen() {
  const showOrgLabels = useShowOrgLabels();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [reports, setReports] = useState<IncidentReportDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // F15 — a failure must not read as "no reports yet".
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const {data} = await incidentApi.mine();
      setReports(data);
      setLoadError(null);
    } catch (e) {
      setReports([]);
      setLoadError(loadErrorText(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      {/* Why: this is the MEMBER root of the Incident module, and every sibling
          root has a back affordance. It mattered less while Incident was a tab
          you could tap away from; the module is now entered from a Home card
          (the bottom bar is Home + Messenger), so the header is where a user
          looks for the way out. */}
      <ObHeader
        title="Incident Reports"
        onBack={() => navigation.goBack()}
        pill={reports.length ? `${reports.length}` : undefined}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 28}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={OB.accentSoft} />}>

        <View style={{marginTop: 8, marginBottom: 22}}>
          <PrimaryButton label="Report an Incident" icon="alert-octagon-outline" onPress={() => navigation.navigate('ReportIncidentCategory')} />
        </View>

        <SectionLabel>MY REPORTS</SectionLabel>
        {loading ? (
          <LoadingView compact label="Loading reports…" />
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => { setLoading(true); void load(); }} />
        ) : reports.length === 0 ? (
          <Card style={{alignItems: 'center', gap: 8, paddingVertical: 26}}>
            <Icon name="clipboard-text-outline" size={30} color={OB.textMute} />
            <Text style={s.emptyTitle}>No reports yet</Text>
            <Text style={s.emptySub}>Incidents you submit will appear here with their status.</Text>
          </Card>
        ) : (
          <View style={{gap: 10}}>
            {reports.map(r => {
              const cat = INCIDENT_CATEGORY_META[r.category];
              const st = INCIDENT_STATUS_META[r.status];
              const sev = severityColor(r.severity);
              return (
                <Card key={r.id} style={s.row} onPress={() => navigation.navigate('MyIncidentDetail', {report: r})}>
                  <View style={s.rowIcon}>
                    <Icon name={cat?.icon ?? 'alert-circle-outline'} size={18} color={OB.accentSoft} />
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.rowTitle} numberOfLines={1}>{cat?.label ?? r.category}</Text>
                    <Text style={s.rowRef} numberOfLines={1}>
                      {r.ref ?? 'Pending ref'} · {fmtTime(r.created_at)}
                      {/* Cross-org by decision — say which company. Absent for
                          the single-org majority, where it is pure noise. */}
                      {orgLabelFor(r, showOrgLabels) ? ` · ${orgLabelFor(r, showOrgLabels)}` : ''}
                    </Text>
                    <View style={s.chipRow}>
                      <View style={[s.chip, {borderColor: sev + '4D', backgroundColor: sev + '1A'}]}>
                        <Text style={[s.chipText, {color: sev}]}>{r.severity.toUpperCase()}</Text>
                      </View>
                      <View style={[s.chip, {borderColor: (st?.color ?? OB.accentSoft) + '4D', backgroundColor: (st?.color ?? OB.accentSoft) + '1A'}]}>
                        <Text style={[s.chipText, {color: st?.color ?? OB.accentSoft}]}>{(st?.label ?? r.status).toUpperCase()}</Text>
                      </View>
                    </View>
                  </View>
                  <Icon name="chevron-right" size={18} color={OB.textMute} />
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
  emptyTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 15, marginTop: 4},
  emptySub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, textAlign: 'center', maxWidth: 250, lineHeight: 18},
  row: {flexDirection: 'row', alignItems: 'center', gap: 13},
  rowIcon: {
    width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  rowTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  rowRef: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10.5, marginTop: 2},
  chipRow: {flexDirection: 'row', gap: 8, marginTop: 8},
  chip: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7, borderWidth: 1},
  chipText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8},
}));
