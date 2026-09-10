/**
 * 07 / 09 — Admin Approval
 *
 * Hero card with hourglass icon, tri-state status row (Submit · Approved ·
 * Rejected), and a 5-step vertical timeline: Submitted · Doc Review ·
 * KYC · Ops Assessment · Partner Approval.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, View, Text, ScrollView, StatusBar, StyleSheet, AppState, BackHandler} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {NavHeader, CTAButton, SectionLabel, BRAND} from './_shared';
import {agentApi, type AgentPortalStatus} from '@services/api';
import {mapStepState} from './agentFlowHelpers';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

type Stage = 'done' | 'inprog' | 'pending' | 'rejected';
interface StepRow {key: string; title: string; state: Stage}

const STEP_TITLES: Record<string, string> = {
  submit:  'Application Submitted',
  docs:    'Document Review',
  kyc:     'KYC Background Check',
  ops:     'Ops Team Assessment',
  partner: 'Partner Approval',
};
const STEP_ORDER = ['submit', 'docs', 'kyc', 'ops', 'partner'];

export default function AgentAdminApprovalScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const signOut = useAuthStore(s => s.signOut);
  const [status, setStatus]   = useState<AgentPortalStatus | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [steps, setSteps]     = useState<StepRow[]>(
    STEP_ORDER.map(k => ({key: k, title: STEP_TITLES[k], state: 'pending'})),
  );
  const pulse = useRef(new Animated.Value(1)).current;

  // Pulsing live-dot animation.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {toValue: 0.3, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true}),
        Animated.timing(pulse, {toValue: 1,   duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  // Poll /agents/me every 3s. When Ops flips status to APPROVED the agent
  // advances to the in-person deployment checklist; REJECTED routes to
  // the rejected screen. Paused on background so the agent's locked
  // phone isn't firing a background poll every 3s while waiting.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      try {
        const {data} = await agentApi.getMe();
        if (cancelled) {return;}
        setStatus(data.agent.status);
        setLastSync(new Date());
        setSteps(STEP_ORDER.map(k => {
          const server = data.review.find(r => r.step === k);
          return {
            key:   k,
            title: STEP_TITLES[k],
            state: server ? mapStepState(server.state) : 'pending',
          };
        }));

        // Auto-advance on terminal states.
        if (data.agent.status === 'APPROVED' || data.agent.status === 'ACTIVE') {
          if (timer) { clearInterval(timer); timer = null; }
          navigation.replace('AgentDashboard');
        } else if (data.agent.status === 'REJECTED') {
          if (timer) { clearInterval(timer); timer = null; }
          navigation.replace('AgentRejected');
        }
      } catch { /* transient — try again next tick */ }
    };

    const start = () => { if (!timer && !cancelled) {timer = setInterval(() => { void tick(); }, 3000);} };
    const stop  = () => { if (timer) { clearInterval(timer); timer = null; } };
    void tick();
    if (AppState.currentState === 'active') {start();}
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') { void tick(); start(); } else {stop();}
    });
    return () => { cancelled = true; stop(); sub.remove(); };
  }, [navigation]);

  // B-199 — this is a TERMINAL waiting state: the applicant is held here until
  // ops decides (the poll above auto-advances on APPROVED/ACTIVE/REJECTED).
  // It must NOT be a back-navigable screen — going back landed on the docs
  // screen, which re-showed a "submitted" state and let the applicant bounce
  // between the two. Swallow the hardware/gesture back so it can't pop; the
  // only labelled exit is Sign out (below). Matches the AgentRejected terminal.
  useFocusEffect(React.useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []));

  const confirmSignOut = () => {
    Alert.alert(
      'Sign out?',
      'Your application stays under review. Signing in again brings you back to this screen.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Sign out', style: 'destructive', onPress: () => { void signOut(); }},
      ],
    );
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      {/* No onBack — terminal until ops approves/rejects (NavHeader renders a
          spacer, never a dead-looking chevron). */}
      <NavHeader
        title="Admin Approval"
        stepPill="Under Review"
        stepPillTone="warn"
      />

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}>

        {/* Hero */}
        <View style={s.hero}>
      <ImageryBackdrop source={Imagery.opsBriefing} variant="hero" radius={14} />
          <View style={s.heroLine} pointerEvents="none" />
          <View style={s.heroIcon}>
            <Icon name="timer-sand" size={22} color={BRAND.warn} />
          </View>
          <Text style={s.heroTitle}>Application Under Review</Text>
          <Text style={s.heroSub}>
            Your application is being reviewed. Typically 24-48 hours.
          </Text>
          <View style={s.statusRow}>
            {(['SUBMIT', 'APPROVED', 'REJECTED'] as const).map(label => {
              const on =
                (label === 'SUBMIT'   && (status === 'SUBMITTED' || status === 'UNDER_REVIEW')) ||
                (label === 'APPROVED' && (status === 'APPROVED'  || status === 'ACTIVE')) ||
                (label === 'REJECTED' && status === 'REJECTED');
              return (
                <View key={label} style={[s.st, on && s.stOn]}>
                  <Text style={[s.stText, on && s.stTextOn]}>{label}</Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* Live indicator */}
        <View style={s.liveRow}>
          <Animated.View style={[s.liveDot, {opacity: pulse}]} />
          <Text style={s.liveText}>LIVE</Text>
          {lastSync && (
            <Text style={s.liveSub}>
              {' · last updated '}
              {lastSync.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})}
            </Text>
          )}
        </View>

        <SectionLabel>Review Pipeline</SectionLabel>

        <View style={s.timeline}>
          {steps.map((row, i) => (
            <TimelineRow key={row.key} row={row} isLast={i === steps.length - 1} />
          ))}
        </View>
      </ScrollView>

      {/* Not a "back" button — a legitimate exit that never loops to the docs
          screen. Entry resumes here on next sign-in until ops decides. */}
      <CTAButton
        label="Sign out"
        onPress={confirmSignOut}
        variant="ghost"
        trailingArrow={false}
      />
    </View>
  );
}

function TimelineRow({row, isLast}: {row: StepRow; isLast: boolean}) {
  const isDone = row.state === 'done';
  const isProg = row.state === 'inprog';

  return (
    <View style={s.tlRow}>
      <View style={s.tlDotCol}>
        <View
          style={[
            s.dot,
            isDone && s.dotDone,
            isProg && s.dotProg,
          ]}
        />
        {!isLast && <View style={[s.line, isDone && s.lineDone]} />}
      </View>
      <Text style={[s.tlText, row.state === 'pending' && s.tlTextDim]}>{row.title}</Text>
      {isDone && <Text style={s.tlEtaOk}>✓ DONE</Text>}
      {isProg && <Text style={s.tlEtaProg}>IN PROG</Text>}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  scroll: {padding: 14, paddingBottom: 24, gap: 10},

  hero: {
    padding: 18, paddingBottom: 14, borderRadius: 14,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', position: 'relative',
  },
  heroLine: {
    position: 'absolute', top: 0, left: '18%', right: '18%', height: 1,
    backgroundColor: 'rgba(126,214,255,0.35)',
  },
  heroIcon: {
    width: 48, height: 48, borderRadius: 12,
    backgroundColor: Colors.surfaceOverlay,
    borderWidth: 1, borderColor: Colors.borderDefault,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 10,
  },
  heroTitle: {
    fontFamily: BravoFont.extraBold, fontSize: 13, letterSpacing: 1.4,
    color: Colors.textPrimary, textTransform: 'uppercase',
  },
  heroSub: {
    fontSize: 11, color: Colors.textSecondary, marginTop: 6, lineHeight: 15,
    textAlign: 'center',
  },

  statusRow: {flexDirection: 'row', gap: 4, justifyContent: 'center', marginTop: 12},
  st: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5,
    backgroundColor: Colors.surfaceOverlay,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  stOn: {backgroundColor: BRAND.warn, borderColor: BRAND.warn},
  stText: {
    fontFamily: BravoFont.extraBold, fontSize: 8.5, letterSpacing: 0.8,
    color: Colors.textMuted,
  },
  stTextOn: {color: '#3B2D00'},

  liveRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6,
  },
  liveDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: BRAND.ok,
    shadowColor: BRAND.ok, shadowOpacity: 0.9, shadowRadius: 6,
    shadowOffset: {width: 0, height: 0},
  },
  liveText: {
    fontFamily: BravoFont.extraBold, fontSize: 9, letterSpacing: 1.5,
    color: BRAND.ok,
  },
  liveSub: {
    fontSize: 9, color: Colors.textMuted, fontFamily: BravoFont.mono,
  },

  timeline: {gap: 10, paddingVertical: 4},
  tlRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 10},
  tlDotCol: {alignItems: 'center', width: 10, position: 'relative'},
  dot: {
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: Colors.surfaceOverlay,
    borderWidth: 1.5, borderColor: Colors.borderDefault,
    marginTop: 4,
  },
  dotDone: {
    backgroundColor: Colors.primary, borderColor: Colors.primary,
    shadowColor: Colors.primary, shadowOpacity: 0.4, shadowRadius: 10,
    shadowOffset: {width: 0, height: 0},
  },
  dotProg: {
    backgroundColor: BRAND.warn, borderColor: BRAND.warn,
    shadowColor: BRAND.warn, shadowOpacity: 0.5, shadowRadius: 8,
    shadowOffset: {width: 0, height: 0},
  },
  line: {
    position: 'absolute', top: 15, left: 4,
    width: 2, height: 18, backgroundColor: Colors.surfaceBorder,
  },
  lineDone: {backgroundColor: Colors.primary},

  tlText: {
    flex: 1, fontFamily: BravoFont.medium, fontSize: 11.5, color: Colors.textPrimary,
    paddingTop: 2,
  },
  tlTextDim: {color: Colors.textMuted},
  tlEtaOk: {
    fontFamily: BravoFont.mono, fontSize: 9, color: BRAND.ok, letterSpacing: 0.5,
    paddingTop: 4,
  },
  tlEtaProg: {
    fontFamily: BravoFont.mono, fontSize: 9, color: BRAND.warn, letterSpacing: 0.5,
    paddingTop: 4,
  },
}));
