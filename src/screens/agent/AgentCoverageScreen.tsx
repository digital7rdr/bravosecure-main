/**
 * 04 / 09 — Coverage & Services
 *
 * World map card with grid + active-region glow dots, country toggles,
 * service offering toggles. Bottom CTA continues to Availability setup.
 */
import React, {useEffect, useState, useMemo} from 'react';
import {View, Text, ScrollView, TouchableOpacity, StatusBar, StyleSheet, type ViewStyle, BackHandler} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {NavHeader, ProgressRail, CTAButton, SectionLabel, BRAND} from './_shared';
import {agentApi} from '@services/api';
import {extractMsg, coverageCountriesPayload, prevStepFor} from './agentFlowHelpers';
import {coverageRegionRows} from '@utils/regions';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

interface CoverageRow {key: string; flag?: string; name: string; sub: string; on: boolean; highlight?: boolean}

// Issue 37 — DERIVED from the canonical region list, never hand-copied. The old
// hard-coded array had drifted: South Africa (the pilot region) was missing and
// USA was offered even though it is not a dispatch region at all. `key` stays
// lowercase because coverageCountriesPayload() upper-cases it for the server and
// hydration matches on `code.toLowerCase()`.
const INITIAL_COUNTRIES: CoverageRow[] = coverageRegionRows().map(r => ({
  key:  r.code.toLowerCase(),
  flag: r.badge,
  name: r.name,
  sub:  r.cities,
  on:   false,
}));

const INITIAL_SERVICES: CoverageRow[] = [
  {key: 'cp',      name: 'Close Protection', sub: 'Armed & unarmed CPO escort', on: true},
  {key: 'driving', name: 'Secure Driving',   sub: 'Protective transport · ACTIVE', on: true, highlight: true},
  {key: 'advance', name: 'Advance Team',     sub: 'Recon & route survey',        on: false},
];

// Active-region glow dot positions on the world-card (pct of card W/H).
const REGION_DOTS: {top: number; left: number; big?: boolean}[] = [
  {top: 34, left: 48, big: true},
  {top: 42, left: 52},
  {top: 56, left: 58, big: true},
  {top: 38, left: 30},
  {top: 60, left: 72, big: true},
];

export default function AgentCoverageScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [countries, setCountries] = useState<CoverageRow[]>(INITIAL_COUNTRIES);
  const [services, setServices]   = useState<CoverageRow[]>(INITIAL_SERVICES);
  const [busy, setBusy]           = useState(false);

  // Hydrate current coverage from the server.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const {data} = await agentApi.getMe();
        if (cancelled) {return;}
        const cov = (data.profile.coverage ?? {countries: [], services: []}) as {
          countries: Array<{code: string; on: boolean}>;
          services:  Array<{key: string; on: boolean}>;
        };
        setCountries(INITIAL_COUNTRIES.map(c => {
          const server = cov.countries.find(x => x.code.toLowerCase() === c.key);
          return server ? {...c, on: server.on} : c;
        }));
        setServices(INITIAL_SERVICES.map(svc => {
          const server = cov.services.find(x => x.key === svc.key);
          return server ? {...svc, on: server.on} : svc;
        }));
      } catch { /* fresh account — keep defaults */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const activeCountries = useMemo(() => countries.filter(c => c.on).length, [countries]);

  const toggle = (list: CoverageRow[], setter: (rows: CoverageRow[]) => void, key: string) =>
    setter(list.map(r => (r.key === key ? {...r, on: !r.on} : r)));

  const onSave = async () => {
    if (busy) {return;}
    setBusy(true);
    try {
      await agentApi.updateCoverage({
        countries: coverageCountriesPayload(countries),
        services:  services.map(svc => ({key: svc.key, on: svc.on})),
      });
      navigation.navigate('AgentAvailability');
    } catch (e) {
      Alert.alert('Could not save coverage', extractMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // B-98a — resume/KYC entry replaces the route, leaving nothing to pop, and
  // goBack() is then a silent release no-op (the dead 3/4 chevron). Fall back
  // to the linear previous step; replace keeps the resume stack shallow.
  const handleBack = () => {
    if (navigation.canGoBack()) {navigation.goBack(); return;}
    const prev = prevStepFor('AgentCoverage');
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
      <NavHeader title="Coverage & Services" onBack={handleBack} stepPill="3/4" />
      <ProgressRail total={4} active={3} />

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}>

        {/* World card */}
        <View style={s.world}>
          <View style={s.worldGrid} pointerEvents="none" />
          <Text style={s.worldCaption}>
            <Text style={s.worldCaptionB}>ACTIVE REGIONS</Text>
            <Text> · {activeCountries} {activeCountries === 1 ? 'country' : 'countries'}</Text>
          </Text>
          {REGION_DOTS.map((d, i) => (
            <View
              key={i}
              style={[
                s.worldDot,
                d.big ? s.worldDotBig : s.worldDotSm,
                {top: `${d.top}%`, left: `${d.left}%`},
              ]}
            />
          ))}
        </View>

        <SectionLabel>Countries</SectionLabel>
        {countries.map(c => (
          <CovRow key={c.key} row={c} onToggle={() => toggle(countries, setCountries, c.key)} />
        ))}

        <SectionLabel>Service Offering</SectionLabel>
        {services.map(svc => (
          <CovRow key={svc.key} row={svc} onToggle={() => toggle(services, setServices, svc.key)} />
        ))}
      </ScrollView>

      <CTAButton
        label={busy ? 'Saving…' : 'Save & Continue'}
        onPress={() => { void onSave(); }}
        variant={busy ? 'disabled' : 'primary'}
      />
    </View>
  );
}


function CovRow({row, onToggle}: {row: CoverageRow; onToggle: () => void}) {
  return (
    <View style={[s.cov, row.highlight && s.covHi]}>
      {row.flag && (
        <View style={s.flag}>
          <Text style={s.flagText}>{row.flag}</Text>
        </View>
      )}
      <View style={s.covBody}>
        <Text style={s.covName}>{row.name}</Text>
        <Text style={[s.covSub, row.highlight && s.covSubHi]}>{row.sub}</Text>
      </View>
      <TouchableOpacity onPress={onToggle} activeOpacity={0.8}>
        <View style={[sw.track, row.on && sw.trackOn]}>
          <View style={[sw.thumb, row.on && sw.thumbOn]} />
        </View>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  scroll: {padding: 14, paddingBottom: 24, gap: 8},

  world: {
    aspectRatio: 1.55, borderRadius: 12,
    backgroundColor: Colors.surfaceOverlay,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    overflow: 'hidden', position: 'relative',
  },
  worldGrid: {
    position: 'absolute', inset: 0,
    borderColor: 'rgba(30,136,255,0.08)',
    // Note: cross-hatched CSS grid isn't trivially achievable without SVG.
    // We fake it with a tinted mesh via a single subtle inset border.
    // TODO: tighten type — `inset` is a web CSS shorthand not in RN's ViewStyle.
  } as unknown as ViewStyle,
  worldCaption: {
    position: 'absolute', left: 10, top: 10,
    fontFamily: BravoFont.mono, fontSize: 8.5, letterSpacing: 1,
    color: Colors.textMuted,
  },
  worldCaptionB: {fontWeight: '700', color: BRAND.acc},
  worldDot: {
    position: 'absolute', borderRadius: 99,
    backgroundColor: BRAND.mapGrid,
    shadowColor: BRAND.mapGrid, shadowOpacity: 0.8, shadowRadius: 12,
    shadowOffset: {width: 0, height: 0},
  },
  worldDotBig: {width: 10, height: 10, marginLeft: -5, marginTop: -5},
  worldDotSm:  {width: 7,  height: 7,  marginLeft: -3.5, marginTop: -3.5},

  cov: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 10, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  covHi: {
    borderColor: Colors.primary,
    backgroundColor: 'rgba(30,136,255,0.08)',
  },
  flag: {
    // Issue 37 — the chip now shows the 3-letter region badge (UAE/KSA/RSA…)
    // rather than a 2-letter code, so it needs room to survive fontScale ≥ 1.3.
    minWidth: 36, minHeight: 20, borderRadius: 4, paddingHorizontal: 4,
    backgroundColor: Colors.surfaceOverlay,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  flagText: {
    fontFamily: BravoFont.extraBold, fontSize: 10, color: Colors.textPrimary,
    letterSpacing: 0.3,
  },
  covBody: {flex: 1, minWidth: 0},
  covName: {
    fontFamily: BravoFont.semiBold, fontSize: 12.5, color: Colors.textPrimary,
    letterSpacing: -0.1,
  },
  covSub: {fontSize: 9.5, color: Colors.textMuted, marginTop: 1, letterSpacing: 0.4},
  covSubHi: {color: BRAND.acc},
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
