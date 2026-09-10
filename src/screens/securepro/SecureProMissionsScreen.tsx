/**
 * Bravo Secure Pro — Booking Requests (in-plan missions).
 *
 * Every multi-date protection request under the plan with its Bravo Control
 * System outcome (scheduled team / declined note). New requests are made on
 * the coverage calendar (multi-date select). Realtime + focus refresh.
 */
import React, {useCallback, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {secureProApi, type ProPlanMission} from '@services/api';
import {useSecureProStore} from '@store/secureProStore';
import {useProPlanGate} from '@hooks/useProPlanGate';
import {useProAppRealtime} from './useProAppRealtime';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureProMissions'>;

const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  signal:     '#4ADE80',
  amber:      '#F5C76B',
  alert:      '#FF5D5D',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

const STATUS_META: Record<ProPlanMission['status'], {label: string; color: string; icon: string}> = {
  REQUESTED: {label: 'Awaiting schedule', color: D.amber, icon: 'calendar-clock'},
  SCHEDULED: {label: 'Scheduled', color: D.signal, icon: 'calendar-check'},
  DECLINED:  {label: 'Declined', color: D.alert, icon: 'calendar-remove'},
  COMPLETED: {label: 'Completed', color: D.textMute, icon: 'calendar-check-outline'},
};

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {return iso;}
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', timeZone: 'UTC'});
}

export default function SecureProMissionsScreen() {
  const insets = useSafeAreaInsets();
  const {contentBottom, bottomPad} = useBottomInset();
  useProPlanGate(); // Audit Rev2 SP-01 — activation gate (loads the app + redirects)
  const navigation = useNavigation<Nav>();
  const application = useSecureProStore(st => st.application);

  const [missions, setMissions] = useState<ProPlanMission[]>([]);
  const [loading, setLoading] = useState(true);

  const appId = application?.id;
  const load = useCallback(async () => {
    if (!appId) {setLoading(false); return;}
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
    void load();
  }, [load]));
  useProAppRealtime(appId, () => { void load(); });

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
          <Text style={s.headerTitle}>Booking Requests</Text>
          <FitLine style={s.headerSub} text={'IN-PLAN PROTECTION · NO EXTRA CHARGE'} />
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(110)}}
        showsVerticalScrollIndicator={false}>
        {loading ? (
          <View style={{paddingVertical: 48, alignItems: 'center'}}>
            <ActivityIndicator color={D.accent} />
          </View>
        ) : missions.length === 0 ? (
          <View style={s.emptyCard}>
      <ImageryBackdrop source={Imagery.proBookingRequests} variant="card" radius={18} />
            <Icon name="calendar-plus" size={26} color={D.textMute} />
            <Text style={s.emptyTitle}>No requests yet</Text>
            <Text style={s.emptySub}>
              Pick the dates you need protection on — the Bravo Control System schedules your
              team for them, covered by your plan.
            </Text>
          </View>
        ) : (
          <View style={{gap: 11}}>
            {missions.map(mi => {
              const meta = STATUS_META[mi.status];
              return (
                <View key={mi.id} style={s.card}>
                  <View style={s.cardHead}>
                    <View style={[s.cardIcon, {borderColor: meta.color + '55'}]}>
                      <Icon name={meta.icon as never} size={17} color={meta.color} />
                    </View>
                    <Text style={s.cardTitle} numberOfLines={1}>
                      {mi.mission_dates.length} date{mi.mission_dates.length > 1 ? 's' : ''}
                    </Text>
                    <View style={[s.pill, {backgroundColor: meta.color + '14', borderColor: meta.color + '4D'}]}>
                      <Text style={[s.pillText, {color: meta.color}]}>{meta.label.toUpperCase()}</Text>
                    </View>
                  </View>
                  <View style={s.dateWrap}>
                    {mi.mission_dates.slice(0, 8).map(d => (
                      <View key={d} style={s.dateChip}>
                        <Text style={s.dateChipText}>{fmtDay(d)}</Text>
                      </View>
                    ))}
                    {mi.mission_dates.length > 8 && (
                      <View style={s.dateChip}>
                        <Text style={s.dateChipText}>+{mi.mission_dates.length - 8}</Text>
                      </View>
                    )}
                  </View>
                  {mi.note ? <Text style={s.noteText} numberOfLines={2}>“{mi.note}”</Text> : null}
                  {mi.status === 'SCHEDULED' && mi.assigned_team.length > 0 && (
                    <View style={s.teamRow}>
                      <Icon name="account-group" size={14} color={D.accentSoft} />
                      <Text style={s.teamText} numberOfLines={2}>
                        {mi.assigned_team.map(t => `${t.count}× ${t.role}${t.label ? ` (${t.label})` : ''}`).join(' · ')}
                      </Text>
                    </View>
                  )}
                  {mi.ops_note ? (
                    <View style={s.opsNoteRow}>
                      <Icon name="message-text-outline" size={14} color={D.textMute} />
                      <Text style={s.opsNoteText} numberOfLines={3}>{mi.ops_note}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      {application?.status === 'ACTIVE' && (
        <LinearGradient
          colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
          locations={[0, 0.5]}
          style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => navigation.navigate('SecureProCalendar')}
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
        </LinearGradient>
      )}
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
  headerSub: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute, marginTop: 5},

  emptyCard: {
    alignItems: 'center', gap: 9, borderRadius: 18, padding: 26,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },
  emptyTitle: {color: D.textDim, fontFamily: D.fBold, fontSize: 14.5},
  emptySub: {color: D.textMute, fontFamily: D.fSans, fontSize: 12, lineHeight: 17, textAlign: 'center'},

  card: {
    borderRadius: 16, padding: 14,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },
  cardHead: {flexDirection: 'row', alignItems: 'center', gap: 11},
  cardIcon: {
    width: 34, height: 34, borderRadius: 10, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  cardTitle: {flex: 1, minWidth: 0, color: D.text, fontFamily: D.fBold, fontSize: 14},
  pill: {flexShrink: 0, paddingVertical: 4, paddingHorizontal: 9, borderRadius: 7, borderWidth: 1},
  pillText: {fontFamily: D.fMono, fontSize: 8, fontWeight: '800', letterSpacing: 0.9},

  dateWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 11},
  dateChip: {
    paddingVertical: 5, paddingHorizontal: 10, borderRadius: 8,
    backgroundColor: 'rgba(91,141,239,0.1)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  dateChipText: {color: D.accentSoft, fontFamily: D.fMono, fontSize: 10, fontWeight: '700', letterSpacing: 0.3},

  noteText: {color: D.textDim, fontFamily: D.fSans, fontSize: 12, lineHeight: 17, marginTop: 10, fontStyle: 'italic'},
  teamRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 10},
  teamText: {flex: 1, minWidth: 0, color: D.textDim, fontFamily: D.fSemi, fontSize: 11.5, lineHeight: 16},
  opsNoteRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 10,
    padding: 10, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair,
  },
  opsNoteText: {flex: 1, minWidth: 0, color: D.textMute, fontFamily: D.fSans, fontSize: 11.5, lineHeight: 16},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 54, borderRadius: 17,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaText: {fontFamily: D.fBold, fontSize: 15, letterSpacing: 0.2, color: '#fff'},
}));
