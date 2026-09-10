import React, {useCallback, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, StatusBar,
  RefreshControl } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {AgentStackParamList} from '@navigation/types';
import {attendanceApi, type ShiftSessionDto, type ShiftDto} from '@services/api';
import {
  OB, ObHeader, SectionLabel, Card, PrimaryButton,
  attendanceStatusMeta, reviewReasonLabel,
} from '@screens/deptchat/_obsidian';
import {getGeo, fmtTime, fmtWindow} from '@screens/deptchat/geo';
import {endShiftLabel, useShowOrgLabels, orgLabelFor} from '@screens/deptchat/crossOrgLabel';
import LoadingView from '@components/LoadingView';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

const isToday = (iso?: string | null): boolean => {
  if (!iso) {return false;}
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
};

export default function AttendanceScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const [shifts, setShifts] = useState<ShiftSessionDto[]>([]);
  const [todayShift, setTodayShift] = useState<ShiftDto | null>(null);
  // Whether the verified (Dept Chat v2) flow is live for this account. False
  // means the server gated /attendance/my-shift/today off (flag off) → the
  // screen falls back to the legacy plain clock-in, byte-for-byte unchanged.
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const showOrgLabels = useShowOrgLabels();
  const openShift = shifts.find(s => s.status === 'open') ?? null;
  const todaySession = shifts.find(s => isToday(s.clock_in_at)) ?? null;

  const load = useCallback(async () => {
    try {
      const {data} = await attendanceApi.myShifts();
      setShifts(data);
    } catch {
      setShifts([]);
    }
    try {
      const {data} = await attendanceApi.myTodayShift();
      setTodayShift(data ?? null);
      setVerified(true);
    } catch (e: unknown) {
      const status = (e as {response?: {status?: number}})?.response?.status;
      // 404 = the v2 surface is gated off → legacy mode. Any other error: keep
      // verified as-is and just show no shift card.
      if (status === 404) {setVerified(false);}
      setTodayShift(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const onCheckOut = async () => {
    if (busy) {return;}
    // Verified (v2) mode: check-out goes through the same face + location
    // verification screen as check-in (PDF p.5). Legacy mode keeps the direct
    // geotagged clock-out.
    if (verified && openShift?.shift_id) {
      navigation.navigate('VerifyAttendance', {
        mode: 'checkout',
        siteLabel: todayShift?.site_label ?? null,
      });
      return;
    }
    setBusy(true);
    try {
      const geo = await getGeo();
      await attendanceApi.clockOut(geo ? {lat: geo.lat, lng: geo.lng} : {});
      await load();
    } catch (e: unknown) {
      Alert.alert('Attendance', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const onLegacyClockIn = async () => {
    if (busy) {return;}
    setBusy(true);
    try {
      const geo = await getGeo();
      await attendanceApi.clockIn(geo ?? {});
      await load();
    } catch (e: unknown) {
      Alert.alert('Attendance', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const goVerify = () => {
    if (!todayShift) {return;}
    navigation.navigate('VerifyAttendance', {shiftId: todayShift.id, siteLabel: todayShift.site_label});
  };

  const statusMeta = attendanceStatusMeta(todaySession?.attendance_status);
  const noShift = verified && !todayShift && !openShift;

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />

      <ObHeader
        title="Attendance"
        onBack={() => navigation.goBack()}
        pill={openShift ? 'ON SHIFT' : noShift ? 'NO SHIFT' : 'OFF'}
        pillTone={openShift ? 'good' : 'warn'}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); void load(); }}
            tintColor={OB.accentSoft}
          />
        }>

        {/* Status hero */}
        <Card style={{marginTop: 8}}>
          <View style={s.heroRow}>
            <LinearGradient
              colors={['rgba(91,141,239,0.2)', 'rgba(47,91,224,0.08)']}
              start={{x: 0.2, y: 0}}
              end={{x: 0.9, y: 1}}
              style={s.heroIcon}>
              <Icon
                name={openShift ? 'shield-check' : noShift ? 'shield-off-outline' : 'shield-outline'}
                size={26}
                color={openShift ? OB.signal : OB.glow}
              />
            </LinearGradient>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.heroTitle}>
                {openShift ? 'On shift' : noShift ? 'No active shift' : 'Off shift'}
              </Text>
              <Text style={s.heroSub} numberOfLines={2}>
                {openShift
                  ? `Checked in ${fmtTime(openShift.clock_in_at)}`
                  : noShift
                    ? 'No shift assigned to you today.'
                    : verified
                      ? "Today's shift is ready — verify to check in."
                      : 'Tap below to record your attendance.'}
              </Text>
            </View>
            {todaySession?.attendance_status ? (
              <View style={[s.chip, {backgroundColor: statusMeta.color + '1A', borderColor: statusMeta.color + '4D'}]}>
                <Text style={[s.chipText, {color: statusMeta.color}]}>{statusMeta.label}</Text>
              </View>
            ) : null}
          </View>

          {todayShift ? (
            <View style={s.shiftBox}>
              <View style={s.shiftRow}>
                <Icon name="map-marker-radius" size={15} color={OB.accentSoft} />
                <Text style={s.shiftText} numberOfLines={1}>
                  {todayShift.site_label ?? 'Assigned site'}
                  {todayShift.department ? ` · ${todayShift.department}` : ''}
                </Text>
              </View>
              <View style={s.shiftRow}>
                <Icon name="clock-outline" size={15} color={OB.accentSoft} />
                <Text style={s.shiftText}>{fmtWindow(todayShift.start_at, todayShift.end_at)}</Text>
              </View>
              <View style={s.shiftRow}>
                <Icon name="target" size={15} color={OB.accentSoft} />
                <Text style={s.shiftText}>Within {todayShift.approved_radius_m} m of site</Text>
              </View>
            </View>
          ) : null}
        </Card>

        {/* Recent shifts */}
        <View style={{marginTop: 22}}>
          <SectionLabel
            right={<Text style={s.viewAll} onPress={() => navigation.navigate('MyAttendance')}>Full history</Text>}>
            RECENT SHIFTS
          </SectionLabel>
          {loading ? (
            <LoadingView compact label="Loading shifts…" />
          ) : shifts.length === 0 ? (
            <Card><Text style={s.empty}>No shifts recorded yet.</Text></Card>
          ) : (
            <View style={{gap: 10}}>
              {shifts.slice(0, 8).map(sh => {
                const meta = attendanceStatusMeta(sh.attendance_status ?? (sh.status === 'open' ? null : 'present'));
                const reason = sh.review_status === 'pending' ? reviewReasonLabel(sh.review_reason) : null;
                return (
                  <Card key={sh.id} style={s.histCard}>
                    <View style={s.histLeft}>
                      <Icon name={meta.icon} size={18} color={meta.color} />
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={s.histIn}>{fmtTime(sh.clock_in_at)}</Text>
                        <Text style={s.histOut} numberOfLines={1}>
                          {sh.clock_out_at ? `→ ${fmtTime(sh.clock_out_at)}` : '→ open'}
                          {reason ? ` · ${reason}` : ''}
                          {/* Same cross-org list as My Attendance — same label. */}
                          {orgLabelFor(sh, showOrgLabels) ? ` · ${orgLabelFor(sh, showOrgLabels)}` : ''}
                        </Text>
                      </View>
                    </View>
                    <View style={[s.chip, {backgroundColor: meta.color + '14', borderColor: meta.color + '4D'}]}>
                      <Text style={[s.chipText, {color: meta.color}]}>{meta.label}</Text>
                    </View>
                  </Card>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Sticky action */}
      <View style={[s.footer, {paddingBottom: bottomPad(12)}]}>
        {openShift ? (
          /* vs2 item 4 — NAME THE SHIFT. The one-open-session rule is per PERSON,
             not per organisation, so from inside one company this button can
             legitimately end a shift belonging to another. Correct — one body,
             one shift — but unreadable unless it says which. Unconditional, not
             gated on multi-org: it is a state change, not a list. */
          <PrimaryButton
            /**
             * From the SESSION being closed, not from `todayShift`.
             *
             * `clockOut` is `WHERE cpo_user_id = $1 AND status = 'open'` — it
             * closes `openShift`. `todayShift` is a different object: an
             * ASSIGNMENT, filtered `end_at >= NOW()`. At the normal moment
             * somebody clocks out — just after their shift ends — that filter
             * has already excluded it, so the label named the NEXT shift in the
             * 12h lead window (another employer's, for a consultant) or
             * vanished entirely. It would have confidently named the wrong
             * company at exactly the moment the naming matters.
             *
             * The site only comes from `todayShift` when it is provably the
             * same shift.
             */
            label={endShiftLabel({
              org_name: openShift.org_name,
              site_label: todayShift && todayShift.id === openShift.shift_id ? todayShift.site_label : null,
            })}
            icon="logout"
            busy={busy}
            onPress={() => { void onCheckOut(); }}
          />
        ) : verified ? (
          todayShift ? (
            <PrimaryButton label="Verify & Check In" icon="face-recognition" onPress={goVerify} />
          ) : (
            <PrimaryButton label="No Active Shift" icon="shield-off-outline" disabled />
          )
        ) : (
          <PrimaryButton label="Clock In" icon="login" busy={busy} onPress={() => { void onLegacyClockIn(); }} />
        )}
      </View>
    </View>
  );
}

function errMsg(e: unknown): string {
  return (e as {response?: {data?: {message?: string}}})?.response?.data?.message
    ?? (e as Error)?.message
    ?? 'Please try again.';
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},

  heroRow: {flexDirection: 'row', alignItems: 'center', gap: 14},
  heroIcon: {
    width: 52, height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
  },
  heroTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 18, letterSpacing: -0.3},
  heroSub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, marginTop: 3, lineHeight: 17},

  shiftBox: {
    marginTop: 14, paddingTop: 14, gap: 9,
    borderTopWidth: 1, borderTopColor: OB.hair,
  },
  shiftRow: {flexDirection: 'row', alignItems: 'center', gap: 9},
  shiftText: {flex: 1, color: OB.textDim, fontFamily: BravoFont.medium, fontSize: 12.5},

  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  viewAll: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 12.5},

  histCard: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 13},
  histLeft: {flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minWidth: 0},
  histIn: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 13},
  histOut: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},

  chip: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7, borderWidth: 1},
  chipText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8},

  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
}));
