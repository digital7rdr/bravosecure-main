/**
 * CPO — Pro mission code gate + the dedicated Pro mission view.
 *
 * Founder spec: after the normal login a CPO enters the Mission Code handed
 * out by operations. Valid + assigned → this dedicated view (protected member,
 * protection window, organisation, scheduled dates). Invalid / not assigned →
 * clean denial. Pro missions carry NO payout — the assignment simply completes.
 *
 * The code is a ONE-TIME authorization, not a login credential. On entry we ask
 * the SERVER whether this officer already has a live authorized assignment, so
 * the mission survives logout, a reinstall and a new phone. Nothing about the
 * authorization is cached on the device — the backend is the only source of
 * truth, and it drops the officer the moment ops revokes or the schedule ends.
 */
import React, {useCallback, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar,
  TextInput, ActivityIndicator, Image,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {CpoRootStackParamList} from '@navigation/types';
import {proMissionApi, type ProCpoMissionView} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<CpoRootStackParamList, 'CpoProMission'>;

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
  alert:      '#FF5D5D',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

const DENIALS: Record<string, string> = {
  invalid_mission_code: 'That code is not valid for your account. Check it with operations.',
  mission_cancelled: 'This mission was cancelled by operations.',
  mission_already_completed: 'This mission is already completed.',
};

function fmtDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {return iso;}
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'});
}

export default function CpoProMissionScreen() {
  const insets = useSafeAreaInsets();
  const {contentBottom} = useBottomInset();
  const {overlap} = useKeyboardLayout();
  const navigation = useNavigation<Nav>();

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<string | null>(null);
  const [view, setView] = useState<ProCpoMissionView | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  // Set when the officer taps "enter a different code" — keeps the restore
  // from immediately re-opening the mission they just stepped out of.
  const forceGate = useRef(false);

  const resolve = useCallback(async (candidate: string, silent: boolean) => {
    setBusy(true);
    if (!silent) {setDenial(null);}
    try {
      const {data} = await proMissionApi.enterCode(candidate);
      // Server-side authorization is now stamped; no device copy is kept.
      forceGate.current = false;
      setUnreachable(false);
      setView(data);
    } catch (e) {
      const apiCode = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      if (!silent) {
        setDenial(DENIALS[apiCode ?? ''] ?? 'Access denied — you are not assigned to that mission.');
      }
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Ask the server for a live, already-authorized assignment. Runs on every
   * entry so an ops revocation takes effect immediately, and after a reinstall
   * so the officer is never asked for the code a second time.
   */
  const restore = useCallback(async () => {
    if (forceGate.current) {setRestoring(false); return;}
    setRestoring(true);
    try {
      const {data} = await proMissionApi.current();
      setUnreachable(false);
      setView(data);
    } catch (e) {
      const status = (e as {response?: {status?: number}})?.response?.status;
      if (status && status >= 400 && status < 500) {
        // Authoritative "no live authorization": never entered the code, ops
        // revoked it, or the schedule finished. Fall back to the gate.
        setUnreachable(false);
        setView(null);
      } else {
        // Network/server trouble — do NOT assume the assignment is still valid
        // (no local cache to fall back on) and do NOT imply it was revoked.
        setUnreachable(true);
        setView(null);
      }
    } finally {
      setRestoring(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void restore(); }, [restore]));

  const a = view?.assignment;

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
          <Text style={s.headerTitle}>Pro Mission</Text>
          <FitLine style={s.headerSub} text={a ? a.mission_code : 'ENTER YOUR MISSION CODE'} />
        </View>
        {a ? (
          <TouchableOpacity
            style={s.switchBtn}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Enter a different code"
            onPress={() => { forceGate.current = true; setView(null); setDenial(null); setCode(''); }}>
            <Icon name="swap-horizontal" size={17} color={D.textDim} />
          </TouchableOpacity>
        ) : null}
      </View>

      {restoring && !a ? (
        /* ── Checking the server for a live authorization ── */
        <View style={s.restoreWrap}>
          <ActivityIndicator color={D.accent} />
          <Text style={s.restoreText}>Checking your assignment…</Text>
        </View>
      ) : unreachable && !a ? (
        /* ── Offline: never restore protected data from a device cache ── */
        <View style={s.restoreWrap}>
          <Icon name="wifi-off" size={26} color={D.textMute} />
          <Text style={s.restoreText}>
            Can’t reach operations right now. Your assignment can’t be confirmed offline.
          </Text>
          <TouchableOpacity
            onPress={() => { void restore(); }}
            style={s.retryBtn}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Retry">
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : !a ? (
        /* ── The gate ── */
        <ScrollView
          style={{flex: 1}}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 40 + overlap, flexGrow: 1, justifyContent: 'center'}}>
          <View style={s.gateIcon}>
            <Icon name="shield-key-outline" size={30} color={D.accentSoft} />
          </View>
          <Text style={s.gateTitle}>Mission Code</Text>
          <Text style={s.gateSub}>
            Operations hands you a code with every Pro protection assignment. Enter it to open
            your mission view.
          </Text>
          <TextInput
            style={s.codeInput}
            value={code}
            onChangeText={t => setCode(t.toUpperCase())}
            placeholder="PMC-XXXXXX"
            placeholderTextColor={D.textMute}
            selectionColor={D.accent}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={12}
          />
          {denial ? <Text style={s.denialText}>{denial}</Text> : null}
          <TouchableOpacity
            activeOpacity={0.9}
            disabled={busy || code.trim().length < 4}
            onPress={() => { void resolve(code, false); }}
            accessibilityRole="button"
            accessibilityLabel="Unlock mission"
            accessibilityState={{disabled: busy || code.trim().length < 4}}>
            <LinearGradient
              colors={code.trim().length < 4
                ? ['rgba(91,141,239,0.35)', 'rgba(91,141,239,0.35)', 'rgba(47,91,224,0.35)']
                : ['#6E9BF5', D.accent, D.accentDeep]}
              locations={[0, 0.55, 1]}
              start={{x: 0, y: 0}}
              end={{x: 0, y: 1}}
              style={s.cta}>
              {busy ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Icon name="lock-open-variant-outline" size={18} color="#fff" importantForAccessibility="no" />
                  <Text style={s.ctaText}>Unlock Mission</Text>
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        /* ── The dedicated mission view ── */
        <ScrollView
          style={{flex: 1}}
          contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(24)}}
          showsVerticalScrollIndicator={false}>

          <LinearGradient
            colors={['rgba(20,32,60,0.78)', 'rgba(11,15,23,0.7)']}
            start={{x: 0.5, y: 0}}
            end={{x: 0.5, y: 1}}
            style={s.heroCard}>
      <ImageryBackdrop source={Imagery.svcVehicleSupport} variant="hero" radius={22} />
            <View style={s.memberRow}>
              <View style={s.avatar}>
                {a.member_avatar ? (
                  <Image source={{uri: a.member_avatar}} style={s.avatarImg} />
                ) : (
                  <Icon name="account" size={24} color={D.accentSoft} />
                )}
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.memberCap}>PROTECTED MEMBER</Text>
                <Text style={s.memberName} numberOfLines={1}>{a.member_name ?? 'Member'}</Text>
              </View>
              <View style={[s.livePill, !view.live_today && {borderColor: D.hair2, backgroundColor: 'rgba(255,255,255,0.04)'}]}>
                <View style={[s.liveDot, !view.live_today && {backgroundColor: D.textMute}]} />
                <Text style={[s.livePillText, !view.live_today && {color: D.textMute}]}>
                  {view.live_today ? 'LIVE TODAY' : 'SCHEDULED'}
                </Text>
              </View>
            </View>
            <View style={s.heroDivider} />
            <View style={s.heroGrid}>
              <View style={s.heroCell}>
                <Text style={s.heroCap}>PROTECTION FROM</Text>
                <Text style={s.heroVal}>{fmtDate(a.starts_on)}</Text>
              </View>
              <View style={s.heroCell}>
                <Text style={s.heroCap}>UNTIL</Text>
                <Text style={s.heroVal}>{fmtDate(a.ends_on)}</Text>
              </View>
              <View style={s.heroCell}>
                <Text style={s.heroCap}>ORGANISATION</Text>
                <Text style={s.heroVal} numberOfLines={1}>{a.org_name ?? '—'}</Text>
              </View>
              <View style={s.heroCell}>
                <Text style={s.heroCap}>COVERAGE AREA</Text>
                <Text style={s.heroVal} numberOfLines={2}>{a.coverage_area ?? '—'}</Text>
              </View>
            </View>
          </LinearGradient>

          {view.protection_dates.length > 0 && (
            <>
              <Text style={s.sectionLabel}>SCHEDULED PROTECTION DATES</Text>
              <View style={s.dateWrap}>
                {view.protection_dates.map(d => (
                  <View key={d} style={s.dateChip}>
                    <Text style={s.dateChipText}>{fmtDate(d)}</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          {a.note ? (
            <>
              <Text style={s.sectionLabel}>OPERATIONS NOTE</Text>
              <View style={s.noteCard}>
                <Icon name="message-text-outline" size={15} color={D.accentSoft} />
                <Text style={s.noteText}>{a.note}</Text>
              </View>
            </>
          ) : null}

          <View style={s.noteCard}>
            <Icon name="information-outline" size={15} color={D.textMute} />
            <Text style={[s.noteText, {color: D.textMute}]}>
              This is a Bravo Secure Pro assignment — it is covered by the member's plan and
              completes without a payout step. Operations closes it when the period ends.
            </Text>
          </View>
        </ScrollView>
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
  switchBtn: {
    width: 38, height: 38, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {fontFamily: D.fBold, fontSize: 21, letterSpacing: -0.5, color: D.text, lineHeight: 24},
  headerSub: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute, marginTop: 5},

  restoreWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, gap: 12},
  restoreText: {color: D.textMute, fontFamily: D.fSans, fontSize: 13, lineHeight: 19, textAlign: 'center'},
  retryBtn: {
    marginTop: 4, paddingHorizontal: 22, paddingVertical: 10, borderRadius: 999,
    borderWidth: 1, borderColor: D.hair2, backgroundColor: 'rgba(255,255,255,0.03)',
  },
  retryText: {color: D.accentSoft, fontFamily: D.fSemi, fontSize: 13},
  gateIcon: {
    width: 66, height: 66, borderRadius: 19, alignSelf: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  gateTitle: {color: D.text, fontFamily: D.fBold, fontSize: 22, textAlign: 'center', marginTop: 16},
  gateSub: {color: D.textMute, fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, textAlign: 'center', marginTop: 8, paddingHorizontal: 12},
  codeInput: {
    marginTop: 22, borderRadius: 15, paddingHorizontal: 16, paddingVertical: 15,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    color: D.text, fontFamily: D.fMono, fontSize: 19, letterSpacing: 4, textAlign: 'center', fontWeight: '700',
  },
  denialText: {color: D.alert, fontFamily: D.fSemi, fontSize: 12, textAlign: 'center', marginTop: 12, lineHeight: 17},
  cta: {
    minHeight: 54, borderRadius: 17, marginTop: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  ctaText: {fontFamily: D.fBold, fontSize: 15, letterSpacing: 0.2, color: '#fff'},

  heroCard: {borderRadius: 22, padding: 18, borderWidth: 1, borderColor: D.hair2, overflow: 'hidden'},
  memberRow: {flexDirection: 'row', alignItems: 'center', gap: 13},
  avatar: {
    width: 50, height: 50, borderRadius: 25, flexShrink: 0, overflow: 'hidden',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarImg: {width: 50, height: 50, borderRadius: 25},
  memberCap: {color: D.textMute, fontFamily: D.fMono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1.3},
  memberName: {color: D.text, fontFamily: D.fBold, fontSize: 17, marginTop: 4},
  livePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0,
    paddingVertical: 5, paddingHorizontal: 10, borderRadius: 99,
    backgroundColor: 'rgba(74,222,128,0.1)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.4)',
  },
  liveDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: D.signal},
  livePillText: {color: D.signal, fontFamily: D.fMono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1},
  heroDivider: {height: 1, backgroundColor: D.hair, marginVertical: 15},
  heroGrid: {flexDirection: 'row', flexWrap: 'wrap', rowGap: 14},
  heroCell: {width: '50%', paddingRight: 10},
  heroCap: {color: D.textMute, fontFamily: D.fMono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1.2},
  heroVal: {color: D.text, fontFamily: D.fSemi, fontSize: 13, marginTop: 4},

  sectionLabel: {
    color: D.textDim, fontFamily: D.fMono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginTop: 22, marginBottom: 10,
  },
  dateWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  dateChip: {
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 10,
    backgroundColor: 'rgba(91,141,239,0.1)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  dateChipText: {color: D.accentSoft, fontFamily: D.fMono, fontSize: 11, fontWeight: '700', letterSpacing: 0.3},

  noteCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    marginTop: 12, padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair,
  },
  noteText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 12, lineHeight: 17, color: D.textDim},
}));
