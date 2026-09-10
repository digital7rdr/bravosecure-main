/**
 * MyIncidentDetailScreen (Dept Chat v2 — Step 23) — a member's READ-ONLY view of
 * an incident THEY submitted. Built entirely from the IncidentReportDto already
 * in the list (passed as a param) — it makes NO request to the manager `detail`
 * endpoint, so internal manager notes, the assignee, and the status workflow can
 * never leak to a member (Step 9 stop-condition). No mutations here.
 */
import React from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {DeptIncidentStackParamList} from '@navigation/types';
import {OB, ObHeader, SectionLabel, Card} from './_obsidian';
import {INCIDENT_CATEGORY_META, INCIDENT_STATUS_META, severityColor} from './incidentMeta';
import {fmtTime} from './geo';
import {EvidenceSection} from './EvidenceSection';

type Nav = NativeStackNavigationProp<DeptIncidentStackParamList>;
type Rt = RouteProp<DeptIncidentStackParamList, 'MyIncidentDetail'>;
type IconName = React.ComponentProps<typeof Icon>['name'];

export default function MyIncidentDetailScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {report} = useRoute<Rt>().params;
  const cat = INCIDENT_CATEGORY_META[report.category];
  const st = INCIDENT_STATUS_META[report.status];
  const sev = severityColor(report.severity);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="My Report" onBack={() => navigation.goBack()} pill={report.ref ?? undefined} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 28}}>

        {/* Status hero */}
        <Card style={[s.hero, {marginTop: 8}]}>
          <View style={[s.heroIcon, {borderColor: (st?.color ?? OB.accentSoft) + '66', backgroundColor: (st?.color ?? OB.accentSoft) + '14'}]}>
            <Icon name={cat?.icon ?? 'alert-circle-outline'} size={26} color={st?.color ?? OB.accentSoft} />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.heroCat}>{cat?.label ?? report.category}</Text>
            <Text style={[s.heroStatus, {color: st?.color ?? OB.accentSoft}]}>{st?.label ?? report.status}</Text>
          </View>
          <View style={[s.sevChip, {borderColor: sev + '4D', backgroundColor: sev + '1A'}]}>
            <Text style={[s.sevText, {color: sev}]}>{report.severity.toUpperCase()}</Text>
          </View>
        </Card>

        {/* Details */}
        <View style={{marginTop: 22}}>
          <SectionLabel>DETAILS</SectionLabel>
          <Card style={{gap: 12}}>
            <Row icon="text-box-outline" label="What happened" value={report.description} />
            {report.location_label ? <Row icon="map-marker-outline" label="Location" value={report.location_label} /> : null}
            <Row icon="clock-outline" label="Submitted" value={fmtTime(report.created_at)} />
            {report.updated_at && report.updated_at !== report.created_at ? (
              <Row icon="update" label="Updated" value={fmtTime(report.updated_at)} />
            ) : null}
          </Card>
          <Text style={s.note}>Your manager reviews every report. You will be notified when the status changes.</Text>
        </View>

        {/* Your own encrypted photo evidence (Step 10) — decrypts on this device. */}
        <EvidenceSection incidentId={report.id} />
      </ScrollView>
    </View>
  );
}

function Row({icon, label, value}: {icon: IconName; label: string; value: string}) {
  return (
    <View style={s.row}>
      <Icon name={icon} size={16} color={OB.accentSoft} style={{marginTop: 2}} />
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={s.rowLabel}>{label}</Text>
        <Text style={s.rowValue}>{value}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  hero: {flexDirection: 'row', alignItems: 'center', gap: 14},
  heroIcon: {width: 52, height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center', borderWidth: 1},
  heroCat: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 17, letterSpacing: -0.3},
  heroStatus: {fontFamily: BravoFont.semiBold, fontSize: 13, marginTop: 3},
  sevChip: {paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1},
  sevText: {fontFamily: BravoFont.mono, fontSize: 9, fontWeight: '700', letterSpacing: 1},
  row: {flexDirection: 'row', alignItems: 'flex-start', gap: 11},
  rowLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9.5, letterSpacing: 1.2, textTransform: 'uppercase'},
  rowValue: {color: OB.text, fontFamily: BravoFont.regular, fontSize: 13.5, lineHeight: 19, marginTop: 3},
  note: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 16, marginTop: 12, paddingHorizontal: 2},
}));
