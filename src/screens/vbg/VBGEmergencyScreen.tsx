import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {View, Text, StyleSheet, TextInput, TouchableOpacity, Linking, Keyboard, InteractionManager, FlatList} from 'react-native';
import Svg, {Path, Circle} from 'react-native-svg';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import LoadingView from '@components/LoadingView';
import {VBG, VbgScreen, VbgCard, SectionLabel, IconButton} from './vbgUi';
import {VbgFooter} from './VbgFooter';
import {UNIVERSAL_EMERGENCY, searchEmergency, type EmergencyEntry} from './emergencyNumbers';
import {getDeviceCountryIso} from './deviceCountry';
import {getLastKnownCountry, setLastKnownCountry} from './lastKnownCountry';
import {getRadioCountry} from './networkCountry';
import {getSilentFix} from './silentLocationFix';
import {
  pickEmergencyCountry, sourceLabel, countryNameFromContext, type ResolvedCountry,
} from './resolveEmergencyCountry';
import {vbgApi} from '@services/api';
import {tokenVault} from '@services/tokenVault';
import {recordEmergencyCall} from '@store/emergencyCallLog';
import {goBackOnce} from '@navigation/tapGuard';
import {alpha3} from '@utils/countryCodes';

type Rt = RouteProp<BookingStackParamList, 'VBGEmergency'>;

/** One dialable service chip — taps straight to the dialer. */
function CallChip({label, number, onCall, strong}: {label: string; number: string; onCall: (n: string, label?: string) => void; strong?: boolean}) {
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      style={[styles.chip, strong && styles.chipStrong]}
      onPress={() => onCall(number, label)}
    >
      <Svg width={13} height={13} viewBox="0 0 24 24">
        <Path d="M5 4h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5V18a2 2 0 0 1-2 2A14 14 0 0 1 5 6a2 2 0 0 1 0-2Z" stroke={strong ? '#fff' : VBG.signal} strokeWidth={1.7} fill="none" strokeLinejoin="round" />
      </Svg>
      <Text style={[styles.chipLabel, strong && styles.chipLabelStrong]}>{label}</Text>
      <Text style={[styles.chipNum, strong && styles.chipNumStrong]}>{number}</Text>
    </TouchableOpacity>
  );
}

/** All service chips for a country (only the ones that exist). */
function ServiceChips({e, onCall}: {e: EmergencyEntry; onCall: (n: string, label?: string) => void}) {
  return (
    <View style={styles.chipWrap}>
      {e.all ? <CallChip label="All" number={e.all} onCall={onCall} strong /> : null}
      {e.police ? <CallChip label="Police" number={e.police} onCall={onCall} /> : null}
      {e.ambulance ? <CallChip label="Ambulance" number={e.ambulance} onCall={onCall} /> : null}
      {e.fire ? <CallChip label="Fire" number={e.fire} onCall={onCall} /> : null}
      {!e.all && !e.police && !e.ambulance && !e.fire
        ? <CallChip label="Emergency" number={UNIVERSAL_EMERGENCY} onCall={onCall} strong /> : null}
    </View>
  );
}

/** One country row. Memoized so typing only re-renders changed rows. */
const CountryRow = React.memo(function CountryRow({e, onCall}: {e: EmergencyEntry; onCall: (n: string, label?: string) => void}) {
  return (
    <View style={styles.countryRow}>
      <View style={styles.countryHead}>
        <Text style={styles.countryName}>{e.name}</Text>
        <Text style={styles.countryIso}>{alpha3(e.iso)}</Text>
      </View>
      <ServiceChips e={e} onCall={onCall} />
    </View>
  );
});

export default function VBGEmergencyScreen() {
  const navigation = useNavigation();
  const route = useRoute<Rt>();
  const [query, setQuery] = useState('');
  // Defer the full ~180-country list until AFTER the navigation transition so
  // the push animation stays smooth (rendering all rows + their SVG call icons
  // up-front blocked the JS thread and made the screen feel laggy to open).
  // The header, universal-call button, search and pinned country render
  // immediately; the list fades in a beat later behind a small spinner.
  const [listReady, setListReady] = useState(false);
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => setListReady(true));
    return () => task.cancel();
  }, []);

  /**
   * WHERE THE PINNED COUNTRY COMES FROM.
   *
   * The ladder and its rationale live in `resolveEmergencyCountry.ts`; this is
   * only the plumbing that feeds it. Two properties matter here:
   *
   *  • **It never blocks.** The offline signals (persisted geocode, mobile
   *    network, SIM, locale) are read on mount and pin a country immediately —
   *    an emergency directory has to work with no signal, which is why the
   *    numbers ship in-app in the first place. The GPS→geocode lane is a pure
   *    UPGRADE that swaps the card when it lands.
   *  • **It never prompts.** `getSilentFix` reads a fix only when permission is
   *    already granted. A permission modal must never stand between a user in
   *    trouble and the number they came to dial; the permission-free network
   *    country covers the denied case.
   */
  const [signals, setSignals] = useState<{
    ready: boolean;
    cachedIso: string | null; cachedName: string | null; cachedAt: number | null;
    networkIso: string | null; simIso: string | null;
  }>({ready: false, cachedIso: null, cachedName: null, cachedAt: null, networkIso: null, simIso: null});
  const [gps, setGps] = useState<{iso: string | null; name: string | null}>({iso: null, name: null});

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [cached, radio] = await Promise.all([getLastKnownCountry(), getRadioCountry()]);
      if (!alive) {return;}
      setSignals({
        ready: true,
        cachedIso: cached.iso, cachedName: cached.name, cachedAt: cached.at,
        networkIso: radio.network, simIso: radio.sim,
      });
    })();
    return () => { alive = false; };
  }, []);

  // The GPS upgrade. Runs once per mount (N7 — one live run per screen); a
  // failure at any step simply leaves the offline answer standing.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const fix = await getSilentFix();
      if (!alive || !fix) {return;}
      /**
       * Skip the call entirely with no session rather than letting an emergency
       * screen drive an auth refresh: `authHttp`'s interceptor clears the vault
       * and fires authLost on a genuinely dead refresh token, which would
       * navigate a user OFF this screen. The bundled directory must keep
       * working when the session does not.
       */
      const token = await tokenVault.getAccess();
      if (!alive || !token) {return;}
      try {
        const res = await vbgApi.geocode({lat: fix.lat, lng: fix.lng});
        if (!alive) {return;}
        const iso = res.data.country?.toUpperCase() ?? null;
        // The NAME is kept, not just the ISO: this endpoint really does answer
        // `country: null` with a usable context, and dropping the name there
        // sends a LIVE location answer through to the locale guess.
        const name = countryNameFromContext(res.data.context);
        if (!iso && !name) {return;}
        setGps({iso, name});
        // Persist so the NEXT open — including one with no signal — starts from
        // a real location instead of a language guess.
        void setLastKnownCountry({iso, name});
      } catch {
        // Offline or the geocode failed: the bundled directory is the whole
        // point, and the offline ladder has already pinned a country.
      }
    })();
    return () => { alive = false; };
  }, []);

  const resolved = useMemo<ResolvedCountry | null>(() => {
    /**
     * Nothing is pinned until the offline signals land. Resolving on the first
     * render would pin the LOCALE — the exact defect this screen exists to fix
     * — and render it with LIVE dialable chips for the width of one AsyncStorage
     * read plus a bridge hop. This app has measured multi-second JS stalls, and
     * this is a screen people open under stress, so that window is not
     * theoretical: an Indian-locale phone in the US would offer Police 100.
     * A param means the caller already geocoded, so it needs no signals.
     */
    const paramIso  = route.params?.countryIso ?? null;
    const paramName = route.params?.countryName ?? null;
    // Gate on whether the param RESOLVED, never on whether one was passed. A
    // param the directory cannot match — 'Deutschland', 'Türkiye', 'Nederland',
    // all real geocoder spellings — would otherwise skip the gate, miss its own
    // rung, and land on the locale, re-opening the first-paint hole through the
    // one door that always passes params.
    const fromParam = pickEmergencyCountry({paramIso, paramName});
    if (fromParam) {return fromParam;}
    if (!signals.ready) {return null;}
    return pickEmergencyCountry({
      gpsIso:     gps.iso,
      gpsName:    gps.name,
      networkIso: signals.networkIso,
      simIso:     signals.simIso,
      cachedIso:  signals.cachedIso,
      cachedName: signals.cachedName,
      cachedAt:   signals.cachedAt,
      localeIso:  getDeviceCountryIso(),
    });
  }, [route.params?.countryIso, route.params?.countryName, gps, signals]);

  const detected = resolved?.entry ?? null;
  // Depend on the ISO STRING, never the resolved object: `resolved` is a fresh
  // object on every signal change, and an unstable `call` busts React.memo on
  // every mounted CountryRow and its SVGs — on the one screen whose list is
  // deferred precisely because mounting those rows blocks the JS thread.
  const detectedIso = detected?.iso;

  const call = useCallback((n: string, label?: string) => {
    Keyboard.dismiss();
    const sanitised = n.replace(/[^\d+*#]/g, '');
    /**
     * PDF item 08 — recorded HERE, at the hand-off, because this is the last
     * moment the app knows anything. `Linking.openURL` gives the call to the OS
     * dialler and neither platform reports back, so there is no later point at
     * which a duration or an outcome could be learned.
     *
     * Recorded BEFORE `openURL`, so a dialler that fails to launch still leaves
     * a trace of the attempt — in a security app, "I tried to call the police
     * and nothing happened" is precisely the event worth having.
     *
     * `sanitised` is passed rather than the raw `n` so the log and the dialler
     * can never disagree about which number was actually called.
     *
     * The country logged is the RESOLVED one, not the route param: every door
     * except VBG Home opens this screen param-less, so the param would have
     * left the incident record blank on exactly the calls it matters for.
     */
    recordEmergencyCall({
      sanitised,
      label,
      source: 'directory',
      countryIso: detectedIso ?? route.params?.countryIso ?? undefined,
    });
    Linking.openURL(`tel:${sanitised}`).catch(() => {});
  }, [detectedIso, route.params?.countryIso]);

  const results = useMemo(() => {
    const list = searchEmergency(query);
    // When not searching, drop the pinned country from the main list (it's
    // shown at the top) so it isn't duplicated.
    if (!query.trim() && detected) {
      return list.filter(e => e.iso !== detected.iso);
    }
    return list;
  }, [query, detected]);

  // Header chrome above the virtualized list — intro, universal-call button,
  // search box, and the pinned detected country. Kept out of the row data so
  // FlatList owns the scroll and only mounts on-screen country rows.
  const header = (
    <View style={styles.body}>
      <Text style={styles.intro}>
        Tap a number to call directly. <Text style={{color: VBG.accentSoft, fontWeight: '600'}}>{UNIVERSAL_EMERGENCY}</Text> reaches emergency services on any network worldwide.
      </Text>

      {/* Universal — always one tap away, works on any SIM/network. */}
      <TouchableOpacity activeOpacity={0.9} style={styles.universal} onPress={() => call(UNIVERSAL_EMERGENCY, 'Emergency')}>
        <View style={styles.universalIcon}>
          <Svg width={20} height={20} viewBox="0 0 24 24"><Path d="M5 4h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5V18a2 2 0 0 1-2 2A14 14 0 0 1 5 6a2 2 0 0 1 0-2Z" stroke="#fff" strokeWidth={1.7} fill="none" strokeLinejoin="round" /></Svg>
        </View>
        <View style={{flex: 1}}>
          <Text style={styles.universalTitle}>Universal Emergency</Text>
          <Text style={styles.universalSub}>Reachable on any network · no SIM needed</Text>
        </View>
        <Text style={styles.universalNum}>{UNIVERSAL_EMERGENCY}</Text>
      </TouchableOpacity>

      {/* Search */}
      <View style={styles.searchRow}>
        <Svg width={15} height={15} viewBox="0 0 24 24" fill="none">
          <Circle cx={11} cy={11} r={7} stroke={VBG.textMute} strokeWidth={1.8} fill="none" />
          <Path d="M20 20l-4-4" stroke={VBG.textMute} strokeWidth={1.8} strokeLinecap="round" />
        </Svg>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search country…"
          placeholderTextColor={VBG.textMute}
          autoCorrect={false}
          autoCapitalize="words"
          style={styles.input}
        />
        {query.length > 0 ? (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Svg width={14} height={14} viewBox="0 0 24 24"><Path d="M6 6l12 12M18 6L6 18" stroke={VBG.textMute} strokeWidth={1.8} strokeLinecap="round" /></Svg>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Detected country pinned at top (only when not searching).

          The caption states HOW the country was determined, and an INFERRED one
          (SIM / stale cache / locale) is rendered in the warning colour with a
          "confirm before dialling" caption rather than the confident green.
          B-638 settled this: a guessed country presented as fact is worse than
          no country at all, because it hides the guess behind a dialable
          number. */}
      {!query.trim() && detected && resolved ? (
        <View>
          <SectionLabel
            dot={resolved.precise ? VBG.signal : VBG.amber}
            style={{marginBottom: 8, marginLeft: 2}}
          >
            {resolved.precise ? 'Your Location' : 'Best Guess'}
          </SectionLabel>
          <VbgCard pad={14} rail={resolved.precise ? VBG.signal : VBG.amber}>
            <View style={styles.countryHead}>
              <Text style={styles.countryName}>{detected.name}</Text>
              <Text style={styles.countryIso}>{alpha3(detected.iso)}</Text>
            </View>
            <Text style={[styles.provenance, !resolved.precise && styles.provenanceWeak]}>
              {sourceLabel(resolved.source)}
            </Text>
            <ServiceChips e={detected} onCall={call} />
          </VbgCard>
        </View>
      ) : null}

      <SectionLabel style={{marginBottom: 8, marginLeft: 2, marginTop: 4}}>
        {query.trim() ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'All Countries'}
      </SectionLabel>

      {!listReady ? (
        <View style={styles.loading}>
          <LoadingView compact label="Loading directory…" />
        </View>
      ) : null}
    </View>
  );

  /**
   * Client 2026-08-22 — this page is now ALSO the Calls screen's "Emergency"
   * door (registered as `EmergencyServices` on the messenger + agency stacks),
   * so the VBG product footer must not come with it: its tabs navigate to VBG
   * routes those stacks do not register, i.e. three dead taps. The page is
   * otherwise identical, and the back chevron is its own.
   */
  return (
    <VbgScreen scroll={false} footer={route.name === 'VBGEmergency' ? <VbgFooter /> : undefined}>
      <View style={styles.header}>
        <IconButton onPress={() => goBackOnce(navigation)}>
          <Svg width={9} height={15} viewBox="0 0 9 15"><Path d="M8 1L1.5 7.5 8 14" stroke={VBG.text} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
        </IconButton>
        <SectionLabel color={VBG.text} style={{fontSize: 12, letterSpacing: 2}}>Emergency Services</SectionLabel>
      </View>

      <FlatList
        data={listReady ? results : []}
        keyExtractor={e => e.iso}
        renderItem={({item}) => (
          <View style={styles.body}><CountryRow e={item} onCall={call} /></View>
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={listReady ? (
          <View style={[styles.body, styles.empty]}>
            <Text style={styles.emptyTitle}>No match</Text>
            <Text style={styles.emptyHint}>No country found for “{query.trim()}”. Use {UNIVERSAL_EMERGENCY} above — it works everywhere.</Text>
          </View>
        ) : null}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingBottom: 120}}
        initialNumToRender={12}
        windowSize={9}
        removeClippedSubviews
      />
    </VbgScreen>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingTop: 4, paddingBottom: 16},
  body: {paddingHorizontal: 18, gap: 13},
  intro: {fontSize: 12.5, lineHeight: 18, color: VBG.textDim, letterSpacing: -0.05},

  universal: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, backgroundColor: 'rgba(255,93,93,0.10)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.34)'},
  universalIcon: {width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: VBG.alert},
  universalTitle: {fontSize: 14, fontWeight: '700', color: VBG.text, letterSpacing: -0.2},
  universalSub: {fontSize: 10.5, color: VBG.textMute, marginTop: 2},
  universalNum: {fontSize: 22, fontWeight: '800', color: '#FF8B8B', letterSpacing: -0.5},

  searchRow: {flexDirection: 'row', alignItems: 'center', gap: 9, height: 46, paddingHorizontal: 13, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: VBG.hair2},
  input: {flex: 1, color: VBG.text, fontSize: 13.5, padding: 0},

  countryRow: {paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: VBG.hair},
  countryHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9},
  countryName: {fontSize: 14, fontWeight: '600', color: VBG.text, letterSpacing: -0.2, flex: 1},
  countryIso: {fontSize: 10, fontWeight: '700', color: VBG.textMute, letterSpacing: 1, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden'},
  provenance: {fontSize: 10.5, color: VBG.textMute, marginTop: -4, marginBottom: 9},
  provenanceWeak: {color: VBG.amber},

  chipWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 7},
  chip: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: 'rgba(74,222,128,0.08)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.28)'},
  chipStrong: {backgroundColor: VBG.signal, borderColor: VBG.signal},
  chipLabel: {fontSize: 11, fontWeight: '600', color: VBG.signal},
  chipLabelStrong: {color: '#06140C'},
  chipNum: {fontSize: 11.5, fontWeight: '800', color: VBG.text, letterSpacing: 0.2},
  chipNumStrong: {color: '#06140C'},

  loading: {alignItems: 'center', paddingVertical: 30, gap: 9},
  empty: {alignItems: 'center', paddingVertical: 28, gap: 7},
  emptyTitle: {fontSize: 13, fontWeight: '700', color: VBG.text},
  emptyHint: {fontSize: 10.5, color: VBG.textMute, textAlign: 'center', paddingHorizontal: 24, lineHeight: 15},
}));
