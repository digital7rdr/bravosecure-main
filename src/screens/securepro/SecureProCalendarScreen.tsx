/**
 * Bravo Secure Pro — premium period calendar (founder spec: "AI Itinerary" v1).
 *
 * A month-grid calendar spanning the plan's coverage period (e.g. Aug–Oct for
 * a 3-month plan). Mission dates are highlighted: SCHEDULED solid cobalt,
 * REQUESTED amber ring. "Request Dates" flips into select mode — tap future
 * in-coverage days, add a note, submit → the Bravo Control System schedules
 * CPOs/responsibilities for those dates (no per-mission charge, covered by
 * the plan).
 */
import React, {useCallback, useMemo, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar,
  TextInput, Modal, Pressable, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {secureProApi, type ProPlanMission} from '@services/api';
import {useSecureProStore} from '@store/secureProStore';
import {useProPlanGate} from '@hooks/useProPlanGate';
import {useProAppRealtime} from './useProAppRealtime';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {formatDateRanges} from '@utils/datetime';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureProCalendar'>;

const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.22)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  signal:     '#4ADE80',
  amber:      '#F5C76B',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** Status word leading each REQUESTS row — the legend's own labels. */
const MISSION_STATUS_LABEL: Record<ProPlanMission['status'], string> = {
  REQUESTED: 'Requested',
  SCHEDULED: 'Scheduled',
  DECLINED: 'Declined',
  COMPLETED: 'Completed',
};

function ymd(y: number, m: number, d: number): string {
  return `${y}-${`${m + 1}`.padStart(2, '0')}-${`${d}`.padStart(2, '0')}`;
}

/** Month cells (Monday-first), null = leading/trailing blank. */
function monthCells(y: number, m: number): Array<number | null> {
  const first = new Date(Date.UTC(y, m, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Mon=0
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells: Array<number | null> = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) {cells.push(d);}
  while (cells.length % 7 !== 0) {cells.push(null);}
  return cells;
}

/** [y, m] pairs spanning startIso..endIso (YYYY-MM-DD). */
function monthsBetween(startIso: string, endIso: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let y = Number(startIso.slice(0, 4));
  let m = Number(startIso.slice(5, 7)) - 1;
  const ey = Number(endIso.slice(0, 4));
  const em = Number(endIso.slice(5, 7)) - 1;
  while (y < ey || (y === ey && m <= em)) {
    out.push([y, m]);
    m += 1;
    if (m > 11) {m = 0; y += 1;}
    if (out.length > 24) {break;} // safety — plans cap well below 2 years
  }
  return out;
}

export default function SecureProCalendarScreen() {
  const insets = useSafeAreaInsets();
  const {contentBottom, bottomPad} = useBottomInset();
  // Why: the note sheet is a transparent Modal under edge-to-edge — it owns its
  // own bottom inset (nav bar when the IME is closed, keyboard when it is up).
  const {bottomPad: kbBottomPad} = useKeyboardLayout();
  useProPlanGate(); // Audit Rev2 SP-01 — activation gate (loads the app + redirects)
  const navigation = useNavigation<Nav>();
  const application = useSecureProStore(st => st.application);

  const [missions, setMissions] = useState<ProPlanMission[]>([]);
  const [loading, setLoading] = useState(true);
  const [monthIx, setMonthIx] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const appId = application?.id;
  const loadMissions = useCallback(async () => {
    if (!appId) {return;}
    try {
      const {data} = await secureProApi.missions(appId);
      setMissions(data.missions);
    } catch {
      // keep last good list
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useFocusEffect(useCallback(() => {
    void loadMissions();
  }, [loadMissions]));
  useProAppRealtime(appId, () => { void loadMissions(); });

  const proposal = application?.proposal ?? null;
  const coverageStart = proposal?.coverage_start ?? application?.start_date ?? null;
  const coverageEnd = proposal?.coverage_end ?? null;

  const months = useMemo(
    () => (coverageStart && coverageEnd ? monthsBetween(coverageStart, coverageEnd) : []),
    [coverageStart, coverageEnd],
  );
  const safeIx = Math.min(monthIx, Math.max(0, months.length - 1));

  // date → strongest status covering it (SCHEDULED > REQUESTED).
  const dateStatus = useMemo(() => {
    const map = new Map<string, 'SCHEDULED' | 'REQUESTED'>();
    for (const mi of missions) {
      if (mi.status === 'DECLINED') {continue;}
      const tag = mi.status === 'REQUESTED' ? 'REQUESTED' : 'SCHEDULED';
      for (const d of mi.mission_dates) {
        if (tag === 'SCHEDULED' || !map.has(d)) {map.set(d, tag);}
      }
    }
    return map;
  }, [missions]);

  const today = new Date().toISOString().slice(0, 10);

  const toggleDay = (iso: string) => {
    if (!selectMode) {return;}
    if (iso < today || (coverageStart && iso < coverageStart) || (coverageEnd && iso > coverageEnd)) {return;}
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(iso)) {next.delete(iso);} else if (next.size < 31) {next.add(iso);}
      return next;
    });
  };

  const submitRequest = async () => {
    if (!appId || selected.size === 0 || busy) {return;}
    setBusy(true);
    try {
      const r = await secureProApi.requestMission(appId, [...selected].sort(), note.trim() || undefined);
      setNoteOpen(false);
      setSelectMode(false);
      setSelected(new Set());
      setNote('');
      await loadMissions();
      // Dedicated-officer fast path: a covered request comes back SCHEDULED.
      if (r.data.mission.status === 'SCHEDULED') {
        Alert.alert('Protection scheduled', 'Your dedicated officer covers those dates — no further approval needed.');
      } else {
        Alert.alert('Request sent', 'The Bravo Control System will schedule your protection for those dates.');
      }
    } catch (e) {
      const code = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Could not send request',
        code === 'date_outside_coverage' ? 'One of the dates is outside your covered period.'
          : code === 'plan_not_active' ? 'Your plan is not active.'
          : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const [year, month] = months[safeIx] ?? [new Date().getFullYear(), new Date().getMonth()];
  const cells = monthCells(year, month);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View pointerEvents="none" style={s.ambient} />

      <View style={s.header}>
        <TouchableOpacity
          style={s.back}
          onPress={() => goBackOnce(navigation)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.headerTitle}>Coverage Calendar</Text>
          <FitLine style={s.headerSub} text={coverageStart && coverageEnd
              ? `${coverageStart.slice(0, 10)} → ${coverageEnd.slice(0, 10)} · BRAVO SECURE PRO`
              : 'BRAVO SECURE PRO'} />
        </View>
      </View>

      {!application || (loading && missions.length === 0) ? (
        <View style={s.centerFill}><ActivityIndicator color={D.accent} /></View>
      ) : !coverageStart || !coverageEnd ? (
        <View style={s.centerFill}>
          <Icon name="calendar-blank-outline" size={28} color={D.textMute} />
          <Text style={s.emptyTitle}>No covered period yet</Text>
          <Text style={s.emptySub}>Your calendar appears once your Pro plan is active.</Text>
        </View>
      ) : (
        <>
          <ScrollView
            style={{flex: 1}}
            contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(120)}}
            showsVerticalScrollIndicator={false}>

            {/* Month pager */}
            <View style={s.pager}>
              <TouchableOpacity
                style={[s.pagerBtn, safeIx === 0 && {opacity: 0.35}]}
                disabled={safeIx === 0}
                onPress={() => setMonthIx(i => Math.max(0, i - 1))}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="Previous month">
                <Icon name="chevron-left" size={19} color={D.text} />
              </TouchableOpacity>
              <View style={{alignItems: 'center', flex: 1, minWidth: 0}}>
                <Text style={s.pagerTitle}>{MONTHS[month]} {year}</Text>
                <View style={s.pagerDots}>
                  {months.map(([, mm], i) => (
                    <View key={`${mm}-${i}`} style={[s.pagerDot, i === safeIx && s.pagerDotOn]} />
                  ))}
                </View>
              </View>
              <TouchableOpacity
                style={[s.pagerBtn, safeIx >= months.length - 1 && {opacity: 0.35}]}
                disabled={safeIx >= months.length - 1}
                onPress={() => setMonthIx(i => Math.min(months.length - 1, i + 1))}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="Next month">
                <Icon name="chevron-right" size={19} color={D.text} />
              </TouchableOpacity>
            </View>

            {/* Grid */}
            <LinearGradient
              colors={['rgba(20,32,60,0.6)', 'rgba(11,15,23,0.55)']}
              start={{x: 0.5, y: 0}}
              end={{x: 0.5, y: 1}}
              style={s.gridCard}>
              <View style={s.dowRow}>
                {DOW.map((d, i) => (
                  <Text key={`${d}-${i}`} style={s.dowText}>{d}</Text>
                ))}
              </View>
              <View style={s.grid}>
                {cells.map((day, i) => {
                  if (day === null) {
                    return <View key={i} style={s.cell} />;
                  }
                  const iso = ymd(year, month, day);
                  const status = dateStatus.get(iso);
                  const inCoverage = iso >= coverageStart && iso <= coverageEnd;
                  const past = iso < today;
                  const isSel = selected.has(iso);
                  const isToday = iso === today;
                  return (
                    <TouchableOpacity
                      key={i}
                      style={s.cell}
                      activeOpacity={selectMode && inCoverage && !past ? 0.7 : 1}
                      onPress={() => toggleDay(iso)}
                      accessibilityRole={selectMode ? 'button' : 'text'}
                      accessibilityLabel={`${day} ${MONTHS[month]}${status ? `, ${status.toLowerCase()}` : ''}`}>
                      <View style={[
                        s.dayDot,
                        !inCoverage && {opacity: 0.25},
                        status === 'SCHEDULED' && s.dayScheduled,
                        status === 'REQUESTED' && s.dayRequested,
                        isSel && s.daySelected,
                        isToday && !status && !isSel && s.dayToday,
                      ]}>
                        <Text style={[
                          s.dayText,
                          past && !status && {color: D.textFaint},
                          (status === 'SCHEDULED' || isSel) && {color: '#fff', fontFamily: D.fBold},
                          status === 'REQUESTED' && {color: D.amber},
                        ]}>
                          {day}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </LinearGradient>

            {/* Legend */}
            <View style={s.legendRow}>
              <View style={s.legendItem}><View style={[s.legendDot, {backgroundColor: D.accent}]} /><Text style={s.legendText}>Scheduled</Text></View>
              <View style={s.legendItem}><View style={[s.legendDot, {borderWidth: 1.5, borderColor: D.amber, backgroundColor: 'transparent'}]} /><Text style={s.legendText}>Requested</Text></View>
              {selectMode && (
                <View style={s.legendItem}><View style={[s.legendDot, {backgroundColor: D.signal}]} /><Text style={s.legendText}>Selected · {selected.size}</Text></View>
              )}
            </View>

            {/* Upcoming */}
            {missions.length > 0 && (
              <>
                <Text style={s.sectionLabel}>REQUESTS</Text>
                <View style={{gap: 9}}>
                  {missions.slice(0, 6).map(mi => (
                    <View key={mi.id} style={s.missionRow}>
                      <Icon
                        name={mi.status === 'SCHEDULED' ? 'calendar-check' : mi.status === 'REQUESTED' ? 'calendar-clock' : mi.status === 'DECLINED' ? 'calendar-remove' : 'calendar-check-outline'}
                        size={17}
                        color={mi.status === 'SCHEDULED' ? D.signal : mi.status === 'REQUESTED' ? D.amber : D.textMute}
                      />
                      <Text style={s.missionText} numberOfLines={2}>
                        {mi.mission_dates.length} date{mi.mission_dates.length > 1 ? 's' : ''} · {formatDateRanges(mi.mission_dates, {prefix: MISSION_STATUS_LABEL[mi.status]})}
                      </Text>
                      <Text style={[s.missionStatus, {
                        color: mi.status === 'SCHEDULED' ? D.signal : mi.status === 'REQUESTED' ? D.amber : D.textMute,
                      }]}>
                        {mi.status}
                      </Text>
                    </View>
                  ))}
                </View>
              </>
            )}
          </ScrollView>

          {/* CTA */}
          <LinearGradient
            colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
            locations={[0, 0.5]}
            style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
            {selectMode ? (
              <View style={{flexDirection: 'row', gap: 10}}>
                <TouchableOpacity
                  style={s.ghostBtn}
                  activeOpacity={0.8}
                  onPress={() => { setSelectMode(false); setSelected(new Set()); }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel selection">
                  <Text style={s.ghostText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{flex: 1.6}}
                  activeOpacity={0.9}
                  disabled={selected.size === 0}
                  onPress={() => setNoteOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Continue with selected dates"
                  accessibilityState={{disabled: selected.size === 0}}>
                  <LinearGradient
                    colors={selected.size === 0
                      ? ['rgba(91,141,239,0.35)', 'rgba(91,141,239,0.35)', 'rgba(47,91,224,0.35)']
                      : ['#6E9BF5', D.accent, D.accentDeep]}
                    locations={[0, 0.55, 1]}
                    start={{x: 0, y: 0}}
                    end={{x: 0, y: 1}}
                    style={s.cta}>
                    <Text style={s.ctaText}>
                      {selected.size === 0 ? 'Tap dates to select' : `Request ${selected.size} date${selected.size > 1 ? 's' : ''}`}
                    </Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            ) : application.status === 'ACTIVE' ? (
              <TouchableOpacity
                activeOpacity={0.9}
                onPress={() => setSelectMode(true)}
                accessibilityRole="button"
                accessibilityLabel="Request protection dates">
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.cta}>
                  <Icon name="calendar-plus" size={18} color="#fff" importantForAccessibility="no" />
                  <Text style={s.ctaText}>Request Protection Dates</Text>
                </LinearGradient>
              </TouchableOpacity>
            ) : null}
          </LinearGradient>
        </>
      )}

      {/* Note sheet */}
      <Modal visible={noteOpen} transparent animationType="slide" onRequestClose={() => { if (!busy) {setNoteOpen(false);} }}>
        <Pressable style={s.sheetBackdrop} onPress={() => { if (!busy) {setNoteOpen(false);} }}>
          <Pressable style={[s.sheetCard, {paddingBottom: kbBottomPad(24)}]} onPress={() => {}}>
            <Text style={s.sheetTitle}>Request {selected.size} date{selected.size > 1 ? 's' : ''}</Text>
            {/* numberOfLines caps a pathological many-non-consecutive selection so
                the range summary can't push the note field off the sheet. */}
            <Text style={s.sheetSub} numberOfLines={2}>
              {formatDateRanges([...selected])}
            </Text>
            <TextInput
              style={s.sheetInput}
              value={note}
              onChangeText={setNote}
              placeholder="Anything the team should know for these dates… (optional)"
              placeholderTextColor={D.textMute}
              selectionColor={D.accent}
              multiline
              maxLength={1000}
              textAlignVertical="top"
            />
            <TouchableOpacity
              activeOpacity={0.9}
              disabled={busy}
              onPress={() => { void submitRequest(); }}
              accessibilityRole="button"
              accessibilityLabel="Send request">
              <LinearGradient
                colors={['#6E9BF5', D.accent, D.accentDeep]}
                locations={[0, 0.55, 1]}
                start={{x: 0, y: 0}}
                end={{x: 0, y: 1}}
                style={s.sheetCta}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.ctaText}>Send Request</Text>}
              </LinearGradient>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg, overflow: 'hidden'},

  ambient: {
    position: 'absolute', top: -100, alignSelf: 'center',
    width: 460, height: 280, borderRadius: 230,
    backgroundColor: 'rgba(91,141,239,0.07)',
  },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14,
  },
  back: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {fontFamily: D.fBold, fontSize: 21, letterSpacing: -0.5, color: D.text, lineHeight: 24},
  headerSub: {fontFamily: D.fMono, fontSize: 9, fontWeight: '600', letterSpacing: 1.2, color: D.textMute, marginTop: 5},

  centerFill: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40},
  emptyTitle: {color: D.textDim, fontFamily: D.fBold, fontSize: 15},
  emptySub: {color: D.textMute, fontFamily: D.fSans, fontSize: 12, textAlign: 'center', lineHeight: 17},

  pager: {flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14},
  pagerBtn: {
    width: 38, height: 38, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  pagerTitle: {color: D.text, fontFamily: D.fBold, fontSize: 17, letterSpacing: -0.3},
  pagerDots: {flexDirection: 'row', gap: 5, marginTop: 6},
  pagerDot: {width: 5, height: 5, borderRadius: 3, backgroundColor: D.hair2},
  pagerDotOn: {backgroundColor: D.accentSoft, width: 14},

  gridCard: {
    borderRadius: 20, padding: 14, borderWidth: 1, borderColor: D.hair2, overflow: 'hidden',
  },
  dowRow: {flexDirection: 'row', marginBottom: 8},
  dowText: {
    flex: 1, textAlign: 'center',
    color: D.textMute, fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1,
  },
  grid: {flexDirection: 'row', flexWrap: 'wrap'},
  cell: {width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', padding: 3},
  dayDot: {
    width: '100%', height: '100%', borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  dayText: {color: D.textDim, fontFamily: D.fSemi, fontSize: 12.5},
  dayScheduled: {
    backgroundColor: D.accent,
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 10, shadowOffset: {width: 0, height: 4}, elevation: 5,
  },
  dayRequested: {borderWidth: 1.5, borderColor: 'rgba(245,199,107,0.6)', backgroundColor: 'rgba(245,199,107,0.06)'},
  daySelected: {backgroundColor: '#2E9E5B'},
  dayToday: {borderWidth: 1, borderColor: 'rgba(91,141,239,0.5)'},

  legendRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 14, justifyContent: 'center'},
  legendItem: {flexDirection: 'row', alignItems: 'center', gap: 7},
  legendDot: {width: 11, height: 11, borderRadius: 6},
  legendText: {color: D.textMute, fontFamily: D.fSans, fontSize: 11.5},

  sectionLabel: {
    color: D.textDim, fontFamily: D.fMono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginTop: 22, marginBottom: 10,
  },
  missionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    padding: 13, borderRadius: 14,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },
  missionText: {flex: 1, minWidth: 0, color: D.text, fontFamily: D.fSemi, fontSize: 12.5},
  missionStatus: {fontFamily: D.fMono, fontSize: 9, fontWeight: '800', letterSpacing: 1},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 54, borderRadius: 17,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  ctaText: {fontFamily: D.fBold, fontSize: 15, letterSpacing: 0.2, color: '#fff'},
  ghostBtn: {
    flex: 1, minHeight: 54, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  ghostText: {color: D.textDim, fontFamily: D.fSemi, fontSize: 14},

  sheetBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)'},
  sheetCard: {
    backgroundColor: '#10151F', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 20,
  },
  sheetTitle: {color: D.text, fontFamily: D.fBold, fontSize: 17},
  sheetSub: {color: D.textMute, fontFamily: D.fMono, fontSize: 10.5, marginTop: 7, letterSpacing: 0.4},
  sheetInput: {
    marginTop: 14, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    color: D.text, fontFamily: D.fSans, fontSize: 13.5, minHeight: 84,
  },
  sheetCta: {
    minHeight: 52, borderRadius: 15, marginTop: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
}));
