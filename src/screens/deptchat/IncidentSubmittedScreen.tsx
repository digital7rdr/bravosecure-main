import React from 'react';
import {View, Text, StyleSheet, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {AgentStackParamList, DeptIncidentStackParamList} from '@navigation/types';
import {OB, Card, PrimaryButton, useInDepartmentalShell} from './_obsidian';
import {severityColor, INCIDENT_SEVERITIES} from './incidentMeta';

// Registered ONLY in the Departmental Incident stack (DepartmentalNavigator).
// The param list below is the Agent one for historical reasons; MyIncidents
// lives only on the Departmental stack, so it is named explicitly. Mounting
// this screen in another host would make those navigates silent dead taps.
type Nav = NativeStackNavigationProp<DeptIncidentStackParamList>;
type Rt = RouteProp<AgentStackParamList, 'IncidentSubmitted'>;

export default function IncidentSubmittedScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const inDepartmentalShell = useInDepartmentalShell();
  const {params} = useRoute<Rt>();
  const sevColor = severityColor(params.severity);
  const sevLabel = INCIDENT_SEVERITIES.find(s => s.key === params.severity)?.label ?? params.severity;

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />

      <View style={s.body}>
        <LinearGradient
          colors={['rgba(74,222,128,0.28)', 'rgba(74,222,128,0.06)']}
          start={{x: 0.2, y: 0}}
          end={{x: 0.9, y: 1}}
          style={s.badge}>
          <Icon name="check-decagram" size={62} color={OB.signal} />
        </LinearGradient>

        <Text style={s.title}>Incident Submitted</Text>
        <Text style={s.sub}>
          Your report has been sent to your manager. You can follow its status in your submitted reports.
        </Text>

        <Card style={s.card}>
          <Text style={s.refLabel}>REFERENCE</Text>
          <Text style={s.ref}>{params.ref ?? 'Pending'}</Text>
          <View style={s.chipRow}>
            <View style={[s.chip, {backgroundColor: OB.accentSoft + '1A', borderColor: OB.accentSoft + '4D'}]}>
              <Text style={[s.chipText, {color: OB.accentSoft}]}>SUBMITTED</Text>
            </View>
            <View style={[s.chip, {backgroundColor: sevColor + '1A', borderColor: sevColor + '4D'}]}>
              <Text style={[s.chipText, {color: sevColor}]}>{sevLabel.toUpperCase()}</Text>
            </View>
          </View>
        </Card>
      </View>

      <View style={[s.footer, {paddingBottom: inDepartmentalShell ? 12 : insets.bottom + 12}]}>
        {/* Step 19 — this screen lives only inside the Departmental Incident
            tab, so it returns to that tab rather than a hard 'AgentDashboard'.
            Client review vs2 item 15 then made the member's tab root the
            CATEGORY GRID, so a bare popToTop would land someone who just filed
            a report on a blank new report — while this screen's own copy tells
            them to follow its status in their submitted reports. Pop to the
            root, then open My Reports: back from there is the grid, which is
            the module root either way. */}
        <PrimaryButton
          label="Done"
          icon="check"
          onPress={() => { navigation.popToTop(); navigation.navigate('MyIncidents'); }}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  body: {flex: 1, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', gap: 14},
  badge: {width: 130, height: 130, borderRadius: 65, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'rgba(74,222,128,0.5)'},
  title: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 26, letterSpacing: -0.6, marginTop: 4},
  sub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 13.5, textAlign: 'center', lineHeight: 20, paddingHorizontal: 6},
  card: {width: '100%', marginTop: 8, alignItems: 'center', gap: 8, paddingVertical: 20},
  refLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9.5, letterSpacing: 2},
  ref: {color: OB.glow, fontFamily: BravoFont.mono, fontSize: 24, fontWeight: '800', letterSpacing: 1.5},
  chipRow: {flexDirection: 'row', gap: 9, marginTop: 6},
  chip: {paddingHorizontal: 11, paddingVertical: 5, borderRadius: 8, borderWidth: 1},
  chipText: {fontFamily: BravoFont.mono, fontSize: 9, fontWeight: '700', letterSpacing: 1},
  footer: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 24, paddingTop: 12},
}));
