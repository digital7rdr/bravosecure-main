/**
 * 05 / 09 — Availability Setup
 *
 * 2×2 deployment-mode card grid (Full Time · Part Time · On Call · Project)
 * + loadout/equipment toggles (Armed Ops · Armoured Vehicle · SIA UK).
 */
import React, {useEffect, useState} from 'react';
import {View, Text, ScrollView, TouchableOpacity, StatusBar, StyleSheet, BackHandler} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {NavHeader, ProgressRail, CTAButton, SectionLabel} from './_shared';
import {agentApi} from '@services/api';
import {extractMsg, prevStepFor} from './agentFlowHelpers';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

type Mode = 'full' | 'part' | 'oncall' | 'project';
interface ModeDef {id: Mode; icon: string; title: string; sub: string}

const MODES: ModeDef[] = [
  {id: 'full',    icon: 'flash',           title: 'Full Time',  sub: '40+ hrs / week'},
  {id: 'part',    icon: 'clock-outline',   title: 'Part Time',  sub: '16-24 hrs / week'},
  {id: 'oncall',  icon: 'lightning-bolt-circle', title: 'On Call',    sub: 'Always available'},
  {id: 'project', icon: 'calendar-blank-outline', title: 'Project',    sub: 'Per-engagement'},
];

interface LoadoutRow {key: string; name: string; sub: string; on: boolean}
const INITIAL_LOADOUT: LoadoutRow[] = [
  {key: 'armed',    name: 'Armed Ops',        sub: 'Firearms cert required', on: false},
  {key: 'armoured', name: 'Armoured Vehicle', sub: 'B4 / B6 rating',         on: true},
  {key: 'sia',      name: 'SIA UK',           sub: 'Front line licence',     on: true},
];

export default function AgentAvailabilityScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [mode, setMode] = useState<Mode>('full');
  const [loadout, setLoadout] = useState<LoadoutRow[]>(INITIAL_LOADOUT);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const {data} = await agentApi.getMe();
        if (cancelled) {return;}
        const av = (data.profile.availability ?? {mode: 'full', loadout: []}) as {
          mode: string; loadout: string[];
        };
        if (['full','part','oncall','project'].includes(av.mode)) {setMode(av.mode as Mode);}
        setLoadout(INITIAL_LOADOUT.map(l => ({...l, on: av.loadout.includes(l.key)})));
      } catch { /* fresh account */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleLoad = (k: string) =>
    setLoadout(prev => prev.map(l => (l.key === k ? {...l, on: !l.on} : l)));

  const onSave = async () => {
    if (busy) {return;}
    setBusy(true);
    try {
      await agentApi.updateAvailability({
        mode,
        loadout: loadout.filter(l => l.on).map(l => l.key),
      });
      navigation.navigate('AgentDocsUpload');
    } catch (e) {
      Alert.alert('Could not save availability', extractMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // B-98a — resume/KYC entry replaces the route, leaving nothing to pop, and
  // goBack() is then a silent release no-op (the dead 3/4 chevron). Fall back
  // to the linear previous step; replace keeps the resume stack shallow.
  const handleBack = () => {
    if (navigation.canGoBack()) {navigation.goBack(); return;}
    const prev = prevStepFor('AgentAvailability');
    // Why the cast: this stack's typed replace() demands a params arg even
    // for param-less routes; the runtime accepts the single-arg form.
    if (prev) {(navigation as unknown as {replace: (name: string) => void}).replace(prev);}
  };

  // B-98a — hardware back mirrors the header chevron (all three affordances
  // agree: button, gesture, hardware key). Focus-scoped so covered screens
  // don't intercept.
  // NAV-07 (2026-08-26 audit) — read through a ref, matching
  // AgentRegistrationWizardScreen: the []-deps callback froze the FIRST
  // render's handleBack behind a suppressed lint rule.
  const handleBackRef = React.useRef(handleBack);
  handleBackRef.current = handleBack;
  useFocusEffect(React.useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleBackRef.current();
      return true;
    });
    return () => sub.remove();
  }, []));


  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      <NavHeader title="Availability" onBack={handleBack} stepPill="4/4" />
      <ProgressRail total={4} active={4} />

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}>

        <SectionLabel>Deployment Mode</SectionLabel>

        <View style={s.grid}>
          {MODES.map(m => {
            const on = mode === m.id;
            return (
              <TouchableOpacity
                key={m.id}
                onPress={() => setMode(m.id)}
                activeOpacity={0.85}
                style={[s.card, on && s.cardOn]}>
                <View style={[s.icon, on && s.iconOn]}>
                  <Icon
                    name={m.icon as React.ComponentProps<typeof Icon>['name']}
                    size={18}
                    color={on ? Colors.primary : Colors.textSecondary}
                  />
                </View>
                <Text style={s.title}>{m.title}</Text>
                <Text style={s.sub}>{m.sub}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <SectionLabel>Loadout & Equipment</SectionLabel>

        {loadout.map(l => (
          <View key={l.key} style={s.row}>
            <View style={{flex: 1}}>
              <Text style={s.rowName}>{l.name}</Text>
              <Text style={s.rowSub}>{l.sub}</Text>
            </View>
            <TouchableOpacity onPress={() => toggleLoad(l.key)} activeOpacity={0.8}>
              <View style={[sw.track, l.on && sw.trackOn]}>
                <View style={[sw.thumb, l.on && sw.thumbOn]} />
              </View>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>

      <CTAButton
        label={busy ? 'Saving…' : 'Save · Upload Documents'}
        onPress={() => { void onSave(); }}
        variant={busy ? 'disabled' : 'primary'}
      />
    </View>
  );
}


const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  scroll: {padding: 14, paddingBottom: 24, gap: 8},

  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  card: {
    width: '48.5%',
    padding: 10, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', gap: 4,
  },
  cardOn: {
    borderColor: Colors.primary,
    backgroundColor: 'rgba(30,136,255,0.08)',
  },
  icon: {
    width: 34, height: 34, borderRadius: 9,
    backgroundColor: Colors.surfaceOverlay,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  iconOn: {
    backgroundColor: Colors.backgroundDepth, borderColor: Colors.primary,
  },
  title: {
    fontFamily: BravoFont.extraBold, fontSize: 11, letterSpacing: 1.2,
    color: Colors.textPrimary, textTransform: 'uppercase', marginTop: 2,
  },
  sub: {fontSize: 9.5, color: Colors.textMuted, textAlign: 'center', letterSpacing: 0.2},

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 10, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  rowName: {
    fontFamily: BravoFont.semiBold, fontSize: 12.5, color: Colors.textPrimary,
    letterSpacing: -0.1,
  },
  rowSub: {fontSize: 9.5, color: Colors.textMuted, marginTop: 1, letterSpacing: 0.4},
}));

const sw = StyleSheet.create(scaleTextStyles({
  track: {
    width: 34, height: 19, borderRadius: 999,
    backgroundColor: Colors.surfaceOverlay,
    borderWidth: 1, borderColor: Colors.borderDefault,
    padding: 1,
  },
  trackOn: {
    backgroundColor: Colors.primary, borderColor: Colors.primary,
    shadowColor: Colors.primary, shadowOpacity: 0.3, shadowRadius: 10,
    shadowOffset: {width: 0, height: 0},
  },
  thumb: {
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: Colors.textMuted,
  },
  thumbOn: {backgroundColor: '#fff', transform: [{translateX: 15}]},
}));
