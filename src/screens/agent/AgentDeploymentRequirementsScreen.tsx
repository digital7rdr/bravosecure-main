/**
 * Mission Deployment Checklist
 *
 * Shown to the agent once they are assigned to a specific mission and
 * the job has been dispatched. Polls the mission-specific deployment
 * checks every 3s so the screen updates live as the Ops supervisor
 * signs off each item on the web console.
 *
 * All 4 checks passed → CTA enables → agent enters AgentHome
 * (they are already ACTIVE at this point).
 */
import React, {useEffect, useRef, useState} from 'react';
import {
  Animated, Easing, View, Text, ScrollView,
  StatusBar, StyleSheet, TouchableOpacity, AppState,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute} from '@react-navigation/native';
import type {NativeStackNavigationProp, NativeStackScreenProps} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {NavHeader, CTAButton, AlertWarn, SectionLabel, BRAND} from './_shared';
import {agentApi} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';

type Nav  = NativeStackNavigationProp<AgentStackParamList>;
type Props = NativeStackScreenProps<AgentStackParamList, 'AgentDeploymentRequirements'>;

interface Req {
  key: string; icon: string; title: string; sub: string;
  state: 'pending' | 'passed' | 'failed';
  signed_at: string | null;
}

const REQ_META: Record<string, {icon: string; title: string; sub: string}> = {
  dress:    {icon: 'tshirt-crew-outline',    title: 'Dress Inspection',
             sub: 'Attend Bravo office in required dress code. Ops approves presentation standards.'},
  vehicle:  {icon: 'car-key',                title: 'Vehicle Collection',
             sub: 'Collect Bravo-assigned vehicle from depot. Sign receipt and condition report.'},
  equip:    {icon: 'toolbox-outline',        title: 'Equipment Check',
             sub: 'Verify: comms kit, first aid, PPE, tracking device. Signed off by Ops supervisor.'},
  briefing: {icon: 'clipboard-list-outline', title: 'Ops Briefing',
             sub: 'Mandatory briefing: client conduct standards and emergency protocols.'},
};
const ORDER = ['dress', 'vehicle', 'equip', 'briefing'];

export default function AgentDeploymentRequirementsScreen() {
  const insets     = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const route      = useRoute<Props['route']>();
  const {missionId} = route.params;

  const [reqs, setReqs]       = useState<Req[]>(
    ORDER.map(k => ({key: k, ...REQ_META[k], state: 'pending', signed_at: null})),
  );
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [dressInstructions, setDressInstructions] = useState<string | null>(null);
  const [dressAckedAt, setDressAckedAt] = useState<string | null>(null);
  const [ackBusy, setAckBusy] = useState(false);
  const [isLead, setIsLead] = useState(false);
  const pulse = useRef(new Animated.Value(1)).current;

  const allPassed = reqs.every(r => r.state === 'passed');
  const passedCount = reqs.filter(r => r.state === 'passed').length;
  const dressNeeded = !!dressInstructions && !dressAckedAt;
  const ctaReady    = allPassed && (!dressInstructions || !!dressAckedAt);

  async function onAcknowledgeDress() {
    if (ackBusy || !missionId) {return;}
    setAckBusy(true);
    try {
      const {data} = await agentApi.acknowledgeDress(missionId);
      setDressAckedAt(data.acknowledged_at);
    } catch { /* ignored */ } finally { setAckBusy(false); }
  }

  // Pulsing live dot.
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

  // Poll mission deployment checks every 3s. Paused on background so
  // the agent's locked phone isn't firing a 3s poll while waiting for
  // ops to sign the in-person checks.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      try {
        const {data} = await agentApi.getMissionDeployment(missionId);
        if (cancelled) {return;}
        setLastSync(new Date());
        setReqs(ORDER.map(k => {
          const server = data.checks.find(c => c.check_key === k);
          return {
            key: k, ...REQ_META[k],
            state: (server?.state ?? 'pending') as Req['state'],
            signed_at: server?.signed_at ?? null,
          };
        }));
        setDressInstructions(data.dress_instructions);
        setDressAckedAt(data.dress_acknowledged_at);
        setIsLead(data.crew_role?.is_lead ?? false);
      } catch { /* transient */ }
    };

    const start = () => { if (!timer && !cancelled) {timer = setInterval(() => { void tick(); }, 3000);} };
    const stop  = () => { if (timer) { clearInterval(timer); timer = null; } };
    void tick();
    if (AppState.currentState === 'active') {start();}
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') { void tick(); start(); } else {stop();}
    });
    return () => { cancelled = true; stop(); sub.remove(); };
  }, [missionId]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      <NavHeader
        title="Deployment Requirements"
        onBack={() => navigation.navigate('AgentHome')}
      />

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}>

        <AlertWarn>
          Ops must sign off all 4 checks before this mission begins.
          <Text style={s.b}> Report to your Bravo supervisor.</Text>
        </AlertWarn>

        {/* Live indicator */}
        <View style={s.liveRow}>
          <Animated.View style={[s.liveDot, {opacity: pulse}]} />
          <Text style={s.liveText}>LIVE  {passedCount}/4 PASSED</Text>
          {lastSync && (
            <Text style={s.liveSub}>
              {' · '}
              {lastSync.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})}
            </Text>
          )}
        </View>

        {dressInstructions && (
          <View style={[
            s.dressCard,
            dressAckedAt
              ? {borderColor: BRAND.ok, backgroundColor: 'rgba(0,200,83,0.06)'}
              : {borderColor: BRAND.warn, backgroundColor: 'rgba(255,193,7,0.06)'},
          ]}>
            <View style={s.dressHead}>
              <Icon name="tshirt-crew-outline" size={16} color={dressAckedAt ? BRAND.ok : BRAND.warn} />
              <Text style={[s.dressHeadText, {color: dressAckedAt ? BRAND.ok : BRAND.warn}]}>
                DRESS INSTRUCTIONS · OPS
              </Text>
            </View>
            <Text style={s.dressBody}>{dressInstructions}</Text>
            {dressAckedAt ? (
              <View style={s.dressAcked}>
                <Icon name="check-bold" size={13} color={BRAND.ok} />
                <Text style={s.dressAckedText}>
                  Confirmed at {new Date(dressAckedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                </Text>
              </View>
            ) : (
              <TouchableOpacity
                onPress={() => { void onAcknowledgeDress(); }}
                disabled={ackBusy}
                style={[s.dressBtn, ackBusy && {opacity: 0.5}]}>
                <Icon name="check-circle-outline" size={15} color="#04101F" />
                <Text style={s.dressBtnText}>{ackBusy ? 'CONFIRMING…' : "I'M KITTED UP — CONFIRM"}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <SectionLabel>Mission Checklist</SectionLabel>

        {reqs.map(r => {
          const done   = r.state === 'passed';
          const failed = r.state === 'failed';
          return (
            <View key={r.key} style={[
              s.row,
              done   && {borderColor: BRAND.ok,  backgroundColor: 'rgba(0,200,83,0.05)'},
              failed && {borderColor: BRAND.err,  backgroundColor: 'rgba(213,0,0,0.05)'},
            ]}>
              <View style={[
                s.icon,
                done   && {borderColor: BRAND.ok},
                failed && {borderColor: BRAND.err},
              ]}>
                <Icon
                  name={(done ? 'check-bold' : failed ? 'close-circle-outline' : r.icon) as React.ComponentProps<typeof Icon>['name']}
                  size={16}
                  color={done ? BRAND.ok : failed ? BRAND.err : Colors.primary}
                />
              </View>
              <View style={s.body}>
                <Text style={s.title}>{r.title}</Text>
                <Text style={s.sub}>{r.sub}</Text>
                {r.signed_at && (
                  <Text style={[s.sub, {color: done ? BRAND.ok : BRAND.err, marginTop: 4}]}>
                    Signed off {new Date(r.signed_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                  </Text>
                )}
              </View>
              <View style={[
                s.badge,
                done   && s.badgeDone,
                failed && s.badgeFail,
              ]}>
                <Text style={[
                  s.badgeText,
                  done   && {color: BRAND.ok},
                  failed && {color: BRAND.err},
                ]}>
                  {done ? 'PASSED' : failed ? 'FAILED' : 'PENDING'}
                </Text>
              </View>
            </View>
          );
        })}

        {allPassed && (
          <View style={s.readyBanner}>
            <Text style={s.readyText}>✓  Bravo Deployment Ready — Mission Cleared</Text>
          </View>
        )}
      </ScrollView>

      <CTAButton
        label={
          ctaReady
            ? (isLead ? 'Open Lead Console →' : 'Enter Agent Dashboard →')
            : dressNeeded
              ? 'Confirm dress check above'
              : 'Awaiting Ops Sign-off…'
        }
        variant={ctaReady ? 'primary' : 'disabled'}
        onPress={() => {
          if (isLead) {
            navigation.replace('AgentLiveTracker', {missionId});
          } else {
            navigation.replace('AgentHome');
          }
        }}
      />
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root:   {flex: 1, backgroundColor: Colors.background},
  scroll: {padding: 14, paddingBottom: 24, gap: 8},

  liveRow: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6},
  liveDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: BRAND.ok,
    shadowColor: BRAND.ok, shadowOpacity: 0.9, shadowRadius: 6,
    shadowOffset: {width: 0, height: 0},
  },
  liveText: {fontFamily: BravoFont.extraBold, fontSize: 9, letterSpacing: 1.5, color: BRAND.ok},
  liveSub:  {fontSize: 9, color: Colors.textMuted, fontFamily: BravoFont.mono},

  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    padding: 11, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  icon: {
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: Colors.backgroundDepth,
    borderWidth: 1, borderColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  body:  {flex: 1, minWidth: 0},
  title: {
    fontFamily: BravoFont.extraBold, fontSize: 11.5, letterSpacing: 0.5,
    color: Colors.textPrimary, textTransform: 'uppercase',
  },
  sub: {fontSize: 10, color: Colors.textSecondary, marginTop: 2, lineHeight: 14},

  badge: {
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5,
    backgroundColor: Colors.surfaceOverlay,
    borderWidth: 1, borderColor: Colors.borderDefault,
    flexShrink: 0, alignSelf: 'flex-start', marginTop: 2,
  },
  badgeDone: {backgroundColor: 'rgba(0,200,83,0.12)', borderColor: 'rgba(0,200,83,0.3)'},
  badgeFail: {backgroundColor: 'rgba(213,0,0,0.12)',  borderColor: 'rgba(213,0,0,0.3)'},
  badgeText: {
    fontFamily: BravoFont.extraBold, fontSize: 8.5, letterSpacing: 0.8,
    color: Colors.textSecondary,
  },

  readyBanner: {
    padding: 12, borderRadius: 10,
    backgroundColor: 'rgba(0,200,83,0.06)',
    borderWidth: 1, borderColor: BRAND.ok,
    alignItems: 'center', marginTop: 2,
  },
  readyText: {
    fontFamily: BravoFont.mono, fontSize: 9.5, fontWeight: '700',
    color: BRAND.ok, letterSpacing: 1.4, textTransform: 'uppercase',
  },
  b: {fontWeight: '700', color: BRAND.warn},

  dressCard: {
    padding: 12, borderRadius: 10, borderWidth: 1, gap: 8, marginTop: 4,
  },
  dressHead: {flexDirection: 'row', alignItems: 'center', gap: 6},
  dressHeadText: {
    fontFamily: BravoFont.extraBold, fontSize: 9.5, letterSpacing: 1.5,
  },
  dressBody: {
    fontSize: 12, color: Colors.textPrimary, lineHeight: 17, fontFamily: BravoFont.regular,
  },
  dressAcked: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingTop: 6, borderTopWidth: 1, borderTopColor: 'rgba(0,200,83,0.2)',
  },
  dressAckedText: {
    fontFamily: BravoFont.mono, fontSize: 10, color: BRAND.ok,
    fontWeight: '700', letterSpacing: 0.5,
  },
  dressBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 10, borderRadius: 8,
    backgroundColor: BRAND.ok, marginTop: 4,
  },
  dressBtnText: {
    fontFamily: BravoFont.extraBold, fontSize: 11, letterSpacing: 1.2,
    color: '#04101F',
  },
}));
