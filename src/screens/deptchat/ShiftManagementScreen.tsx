/**
 * ShiftManagementScreen (Dept Chat v2 — Step 21, PDF p.5) — the manager's list of
 * the org's shifts + the entry to create a new one. Reached from the manager
 * Attend tab (AdminAttendance → "Manage shifts"). Read-only list; creating a
 * shift (with assigned CPOs) is what unblocks every CPO's check-in (G2).
 * Manager-only; GET /attendance/shifts is OrgManagerGuard-gated server-side.
 */
import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl, TouchableOpacity} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import type {DeptAttendStackParamList} from '@navigation/types';
import {attendanceApi, type ShiftDto} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, ErrorState, loadErrorText, useInDepartmentalShell} from './_obsidian';
import {fmtWindow} from './geo';
import {deptMemberNoun} from './deptNoun';

type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;

/**
 * `embedded` — rendered as a SEGMENT of AdminAttendanceScreen rather than as
 * its own route (client review vs2 item 13: the four areas must be one
 * dashboard, not "separate disconnected areas"). The host owns the safe-area
 * inset, the status bar, the backdrop and the header, so the screen suppresses
 * its own. Defaults false, so the standalone route is byte-identical to before.
 */
export default function ShiftManagementScreen({embedded = false}: {embedded?: boolean} = {}) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const inDepartmentalShell = useInDepartmentalShell();
  const [shifts, setShifts] = useState<ShiftDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // F15 — a failure must not read as "no shifts yet".
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const {data} = await attendanceApi.listShifts();
      setShifts(data);
      setLoadError(null);
    } catch (e) {
      setShifts([]);
      setLoadError(loadErrorText(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // PDF p.9 shift management: edit (audited PATCH) + archive (soft delete).
  const archive = (sh: ShiftDto) => {
    Alert.alert(
      'Archive shift',
      `Archive "${sh.site_label ?? 'this shift'}"? Assigned ${deptMemberNoun(true)} will no longer see it as today's shift.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Archive', style: 'destructive',
          onPress: () => {
            void attendanceApi.archiveShift(sh.id)
              .then(() => load())
              .catch(() => Alert.alert('Shift', 'Could not archive. Please try again.'));
          },
        },
      ],
    );
  };

  const now = Date.now();
  const upcoming = shifts.filter(sh => new Date(sh.end_at).getTime() >= now);
  const past = shifts.filter(sh => new Date(sh.end_at).getTime() < now);

  return (
    <View style={[s.root, embedded ? {backgroundColor: 'transparent'} : {paddingTop: insets.top}]}>
      {!embedded && <StatusBar barStyle="light-content" backgroundColor={OB.bg} />}
      {!embedded && <AmbientBg bg={OB.bg} />}
      {!embedded && <ObHeader title="Shifts" onBack={() => navigation.goBack()} pill={`${shifts.length}`} />}

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={OB.accentSoft} />}>

        {loading ? (
          <LoadingView compact label="Loading shifts…" />
        ) : loadError ? (
          <View style={{marginTop: 8}}>
            <ErrorState message={loadError} onRetry={() => { setLoading(true); void load(); }} />
          </View>
        ) : shifts.length === 0 ? (
          <Card style={{marginTop: 8, alignItems: 'center', gap: 8, paddingVertical: 28}}>
            <Icon name="calendar-blank-outline" size={32} color={OB.textMute} />
            <Text style={s.emptyTitle}>No shifts yet</Text>
            <Text style={s.emptySub}>Create a shift and assign {deptMemberNoun(true)} so they can check in.</Text>
          </Card>
        ) : (
          <>
            {upcoming.length > 0 && (
              <View style={{marginTop: 8}}>
                <SectionLabel>UPCOMING &amp; ACTIVE</SectionLabel>
                <View style={{gap: 10}}>
                  {upcoming.map(sh => (
                    <ShiftRow key={sh.id} sh={sh}
                      onEdit={() => navigation.navigate('ShiftEditor', {shift: sh})}
                      onArchive={() => archive(sh)} />
                  ))}
                </View>
              </View>
            )}
            {past.length > 0 && (
              <View style={{marginTop: 22}}>
                <SectionLabel>PAST</SectionLabel>
                <View style={{gap: 10}}>
                  {past.map(sh => <ShiftRow key={sh.id} sh={sh} past onArchive={() => archive(sh)} />)}
                </View>
              </View>
            )}
          </>
        )}
      </ScrollView>

      <View style={[s.footer, {paddingBottom: inDepartmentalShell ? 12 : insets.bottom + 12}]}>
        <PrimaryButton label="New Shift" icon="plus" onPress={() => navigation.navigate('ShiftEditor')} />
      </View>
    </View>
  );
}

function ShiftRow({sh, past, onEdit, onArchive}: {
  sh: ShiftDto; past?: boolean; onEdit?: () => void; onArchive?: () => void;
}) {
  return (
    <Card style={[s.row, past ? {opacity: 0.6} : null]}>
      <View style={s.rowIcon}>
        <Icon name="calendar-check" size={18} color={OB.accentSoft} />
      </View>
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {sh.site_label ?? 'Assigned site'}{sh.department ? ` · ${sh.department}` : ''}
        </Text>
        <Text style={s.rowWindow} numberOfLines={1}>{fmtWindow(sh.start_at, sh.end_at)}</Text>
        <View style={s.metaRow}>
          <Meta icon="account-group" text={`${sh.assigned_count ?? 0} assigned`} />
          {sh.site_lat !== null ? <Meta icon="target" text={`${sh.approved_radius_m} m`} /> : <Meta icon="map-marker-off-outline" text="no geofence" />}
        </View>
        {/* vs2 item 13 — "the user must be shown how to add a member TO A
            SHIFT before the attendance review can continue". A shift with
            nobody on it silently blocks every check-in, and the row said so
            only as the neutral metadata "0 assigned". This states the
            consequence and points at the fix. */}
        {(sh.assigned_count ?? 0) === 0 ? (
          <View style={s.needsAssign}>
            <Icon name="account-alert-outline" size={13} color={OB.amber} />
            <Text style={s.needsAssignText} numberOfLines={2}>
              No one assigned — nobody can check in. Tap edit to add {deptMemberNoun(true)}.
            </Text>
          </View>
        ) : null}
      </View>
      <View style={s.rowActions}>
        {onEdit ? (
          <TouchableOpacity onPress={onEdit} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="pencil-outline" size={18} color={OB.accentSoft} />
          </TouchableOpacity>
        ) : null}
        {onArchive ? (
          <TouchableOpacity onPress={onArchive} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="archive-arrow-down-outline" size={18} color={OB.textMute} />
          </TouchableOpacity>
        ) : null}
      </View>
    </Card>
  );
}

function Meta({icon, text}: {icon: React.ComponentProps<typeof Icon>['name']; text: string}) {
  return (
    <View style={s.meta}>
      <Icon name={icon} size={12} color={OB.textMute} />
      <Text style={s.metaText}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  emptyTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16, marginTop: 4},
  emptySub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, textAlign: 'center', maxWidth: 240, lineHeight: 18},
  row: {flexDirection: 'row', alignItems: 'center', gap: 13},
  rowIcon: {
    width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  rowTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  rowWindow: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12, marginTop: 2},
  metaRow: {flexDirection: 'row', gap: 14, marginTop: 6},
  needsAssign: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5},
  needsAssignText: {flex: 1, minWidth: 0, color: OB.amber, fontFamily: BravoFont.semiBold, fontSize: 11},
  meta: {flexDirection: 'row', alignItems: 'center', gap: 5},
  metaText: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10, letterSpacing: 0.3},
  rowActions: {alignItems: 'center', gap: 14, paddingLeft: 4},
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
}));
