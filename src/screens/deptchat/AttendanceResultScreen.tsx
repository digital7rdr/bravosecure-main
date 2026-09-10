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
import type {AgentStackParamList} from '@navigation/types';
import {OB, Card, PrimaryButton, attendanceStatusMeta, reviewReasonLabel, useInDepartmentalShell} from './_obsidian';
import {fmtTime} from './geo';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
type Rt = RouteProp<AgentStackParamList, 'AttendanceResult'>;

export default function AttendanceResultScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const inDepartmentalShell = useInDepartmentalShell();
  const {params} = useRoute<Rt>();
  const pending = params.status === 'pending_review';
  const checkout = params.mode === 'checkout';
  const meta = attendanceStatusMeta(params.status);
  const reason = reviewReasonLabel(params.reviewReason);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />

      <View style={s.body}>
        <LinearGradient
          colors={[meta.color + '33', meta.color + '0A']}
          start={{x: 0.2, y: 0}}
          end={{x: 0.9, y: 1}}
          style={[s.badge, {borderColor: meta.color + '66'}]}>
          <Icon name={pending ? 'shield-alert-outline' : meta.icon} size={64} color={meta.color} />
        </LinearGradient>

        <Text style={s.title}>{pending ? 'Pending Review' : checkout ? 'Checked Out' : 'Checked In'}</Text>
        <View style={[s.chip, {backgroundColor: meta.color + '1A', borderColor: meta.color + '4D'}]}>
          <Text style={[s.chipText, {color: meta.color}]}>{meta.label}</Text>
        </View>

        <Text style={s.sub}>
          {pending
            ? `Your ${checkout ? 'check-out' : 'check-in'} was recorded and sent to an admin to confirm. You have NOT been marked absent.`
            : 'Your attendance has been recorded against your shift.'}
        </Text>

        <Card style={s.card}>
          {reason ? (
            <Row icon="information-outline" label="Reason" value={reason} tint={OB.amber} />
          ) : null}
          <Row icon="clock-check-outline" label="Time" value={fmtTime(params.clockInAt)} />
          {params.siteLabel ? <Row icon="map-marker-radius" label="Site" value={params.siteLabel} /> : null}
        </Card>
      </View>

      <View style={[s.footer, {paddingBottom: inDepartmentalShell ? 12 : insets.bottom + 12}]}>
        {/* Step 19 — lives only inside the Departmental Attend tab; popToTop
            returns to that tab's root (member: Attendance; manager: Admin) for
            either party, instead of a hard 'Attendance' target. */}
        <PrimaryButton
          label="Done"
          icon="check"
          onPress={() => navigation.popToTop()}
        />
      </View>
    </View>
  );
}

function Row({icon, label, value, tint}: {icon: React.ComponentProps<typeof Icon>['name']; label: string; value: string; tint?: string}) {
  return (
    <View style={s.row}>
      <Icon name={icon} size={16} color={tint ?? OB.accentSoft} />
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, tint ? {color: tint} : null]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  body: {flex: 1, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', gap: 14},
  badge: {
    width: 132, height: 132, borderRadius: 66, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5,
  },
  title: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 26, letterSpacing: -0.6, marginTop: 4},
  chip: {paddingHorizontal: 11, paddingVertical: 5, borderRadius: 8, borderWidth: 1},
  chipText: {fontFamily: BravoFont.mono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1},
  sub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 13.5, textAlign: 'center', lineHeight: 20, paddingHorizontal: 4},
  card: {width: '100%', marginTop: 8, gap: 12},
  row: {flexDirection: 'row', alignItems: 'center', gap: 10},
  rowLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', width: 48},
  rowValue: {flex: 1, color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 13, textAlign: 'right'},
  footer: {paddingHorizontal: 24, paddingTop: 12},
}));
