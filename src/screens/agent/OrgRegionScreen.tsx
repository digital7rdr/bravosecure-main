/**
 * Provider · Region — the agency's single operating region (`agents.region_code`),
 * the hard filter the auto-dispatch ranker matches a client request against
 * (`a.region_code = booking.region_code`). On open we default-assign the region the
 * device's GPS falls in (when none is set yet). Changing it is GUARDED: a provider may
 * only select a region they are physically located in right now — we reverse-geocode the
 * current fix and reject a mismatch ("region not matched"), so an agency can't claim a
 * region it can't actually serve. Obsidian/cobalt theme, matching OrgComplianceScreen.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {agentApi} from '@services/api';
import {getGeo, reverseGeocodeCountry} from '@screens/deptchat/geo';
import {
  REGIONS, regionName, detectRegion, isSupportedRegion, REGION_NA,
} from '@utils/regions';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';
import {alpha3} from '@utils/countryCodes';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', accentDeep: '#2F5BE0',
  amber: '#F5C76B', signal: '#4ADE80', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

export default function OrgRegionScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();

  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<string | null>(null);
  const [dpaAccepted, setDpaAccepted] = useState(false);
  const [detecting, setDetecting] = useState(true);
  const [detected, setDetected] = useState<string | null>(null); // detected region, N/A, or null = unavailable
  const [savingCode, setSavingCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Persist the region (no guard — caller has already verified the match, or this is
  // the GPS default-assign of the region we just detected). Company-only on the server.
  const commitRegion = useCallback(async (code: string, opts?: {silent?: boolean}) => {
    setSavingCode(code);
    try {
      // Why: COALESCE keeps the first DPA acceptance, so re-passing the agency's existing
      // consent state never resets it and a region save never silently accepts the DPA.
      const {data} = await agentApi.setAgencyProfile({region_code: code, dpa_accepted: dpaAccepted, dpa_version: 'v1'});
      setCurrent(data.region_code ?? code);
      if (!opts?.silent) {
        Alert.alert('Region updated', `Your dispatch region is now ${regionName(code)}. You'll receive requests from clients in this region.`);
      }
    } catch (e: unknown) {
      const server = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      const msg = server ?? (e as Error).message ?? 'Could not save region';
      Alert.alert('Save failed',
        msg.includes('company') ? 'Only an agency account or its manager can set a dispatch region.'
          : msg === 'unsupported_region' ? 'That region is not supported yet.'
            : msg);
    } finally {
      setSavingCode(null);
    }
  }, [dpaAccepted]);

  // Initial load: saved region + DPA state, then detect the device's region and
  // default-assign when none is set. Self-contained + runs once — it must NOT depend
  // on commitRegion (whose identity changes when dpaAccepted lands), or it would re-run
  // and re-fire GPS detection + the default-assign alert.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let savedRegion: string | null = null;
      let dpa = false;
      try {
        const {data} = await agentApi.getMe();
        savedRegion = data.agent.region_code ?? null;
        dpa = !!data.agent.dpa_accepted_at;
        if (!cancelled) {
          setCurrent(savedRegion);
          setDpaAccepted(dpa);
        }
      } catch (e: unknown) {
        if (!cancelled) {setError((e as Error).message ?? 'Failed to load profile');}
      } finally {
        if (!cancelled) {setLoading(false);}
      }

      // Detect current region from a single GPS fix (reverse-geocode → country → region,
      // bounding-box fallback when offline).
      const fix = await getGeo();
      const det = fix ? detectRegion(await reverseGeocodeCountry(fix.lat, fix.lng), fix.lat, fix.lng).region : null;
      if (cancelled) {return;}
      setDetected(det);
      setDetecting(false);

      // Default-assign: if no region is set yet and we located the device inside a
      // supported region, set it automatically so the agency is dispatchable out of the box.
      // Pass the DPA state read straight from /agents/me; COALESCE on the server keeps the
      // first acceptance, so this never accepts or resets the agreement.
      if (!savedRegion && det && isSupportedRegion(det)) {
        setSavingCode(det);
        try {
          const {data} = await agentApi.setAgencyProfile({region_code: det, dpa_accepted: dpa, dpa_version: 'v1'});
          if (!cancelled) {
            setCurrent(data.region_code ?? det);
            Alert.alert('Region set', `We set your dispatch region to ${regionName(det)} based on your current location. You can change it any time you're in another supported region.`);
          }
        } catch { /* leave unset — the user can pick manually below */ } finally {
          if (!cancelled) {setSavingCode(null);}
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Guarded change: a provider may only pick the region they are physically in now.
  const onPickRegion = useCallback(async (code: string) => {
    if (code === current || savingCode) {return;}
    setSavingCode(code);
    const fix = await getGeo();
    if (!fix) {
      setSavingCode(null);
      Alert.alert('Location needed', 'We couldn\'t read your current location. Enable location access and try again — you can only set a region you\'re currently in.');
      return;
    }
    const det = detectRegion(await reverseGeocodeCountry(fix.lat, fix.lng), fix.lat, fix.lng).region;
    setDetected(det);
    if (det !== code) {
      setSavingCode(null);
      const where = det && det !== REGION_NA ? regionName(det) : 'outside our supported regions';
      Alert.alert(
        'Region not matched',
        `Your current location is in ${where}, not ${regionName(code)}. You can only operate in the region you're physically located in. Travel to ${regionName(code)} to switch.`,
      );
      return;
    }
    setSavingCode(null);
    await commitRegion(code);
  }, [current, savingCode, commitRegion]);

  const detectedLabel = detecting
    ? 'Detecting…'
    : detected === null
      ? 'Location unavailable'
      : detected === REGION_NA
        ? 'Outside supported regions'
        : regionName(detected);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={22} color={D.text} />
        </TouchableOpacity>
        <View style={s.accentBar} />
        <Text style={s.headerTitle}>REGION</Text>
      </View>

      {loading ? (
        <LoadingView compact label="Loading region…" />
      ) : (
        <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
          {error ? <Text style={s.error}>{error}</Text> : null}

          <View style={s.card}>
            <Text style={s.cardLabel}>YOUR DISPATCH REGION</Text>
            <Text style={s.lead}>
              Client requests are matched to agencies in the same region, then routed to the
              nearest one. Pick the region you operate in — you can only select a region you
              are physically located in right now.
            </Text>
            <View style={s.locRow}>
              <Icon name="crosshairs-gps" size={15} color={D.accentSoft} />
              <Text style={s.locText}>Current location: <Text style={s.locStrong}>{detectedLabel}</Text></Text>
            </View>
          </View>

          <View style={{gap: 10}}>
            {REGIONS.map(r => {
              const selected = current === r.code;
              const inHere = !detecting && detected === r.code;
              const busy = savingCode === r.code;
              return (
                <TouchableOpacity
                  key={r.code}
                  activeOpacity={0.85}
                  disabled={!!savingCode}
                  onPress={() => void onPickRegion(r.code)}
                  style={[s.regionRow, selected && s.regionRowOn]}>
                  <View style={[s.regionFlag, selected && s.regionFlagOn]}>
                    <Text style={[s.regionCode, selected && s.regionCodeOn]}>{alpha3(r.code)}</Text>
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.regionName}>{r.name}</Text>
                    <Text style={s.regionSub}>{r.currency}{inHere ? ' · you are here' : ''}</Text>
                  </View>
                  {busy
                    ? <ActivityIndicator color={D.accent} />
                    : selected
                      ? <Icon name="check-circle" size={22} color={D.signal} />
                      : <Icon name="circle-outline" size={20} color={D.textMute} />}
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={s.footnote}>
            Set the wrong region and you won't receive nearby requests. If you've moved your
            agency to a new region, travel there and update it here.
          </Text>
          <View style={{height: insets.bottom + 24}} />
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 20, paddingVertical: 14},
  backBtn: {width: 42, height: 42, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2, alignItems: 'center', justifyContent: 'center'},
  accentBar: {width: 3, height: 17, borderRadius: 2, backgroundColor: D.accent},
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 13, letterSpacing: 2.2, color: D.text},
  body: {paddingHorizontal: 20, paddingTop: 4, gap: 16},
  card: {borderRadius: 18, padding: 16, gap: 10, backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair2},
  cardLabel: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.5, color: D.textMute},
  lead: {fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, color: D.textDim},
  locRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2},
  locText: {fontFamily: D.fSans, fontSize: 12.5, color: D.textDim},
  locStrong: {fontFamily: D.fSemi, color: D.accentSoft},
  regionRow: {flexDirection: 'row', alignItems: 'center', gap: 13, borderRadius: 16, padding: 14, backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair2},
  regionRowOn: {backgroundColor: 'rgba(91,141,239,0.10)', borderColor: 'rgba(91,141,239,0.4)'},
  regionFlag: {width: 46, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  regionFlagOn: {backgroundColor: 'rgba(91,141,239,0.16)', borderColor: 'rgba(91,141,239,0.45)'},
  regionCode: {fontFamily: D.fBold, fontSize: 15, letterSpacing: 0.5, color: D.textDim},
  regionCodeOn: {color: D.accentSoft},
  regionName: {fontFamily: D.fBold, fontSize: 14.5, color: D.text, letterSpacing: -0.2},
  regionSub: {fontFamily: D.fSans, fontSize: 11.5, color: D.textMute, marginTop: 2},
  footnote: {fontFamily: D.fSans, fontSize: 11.5, lineHeight: 17, color: D.textMute, marginTop: 4},
  error: {color: D.alert, fontSize: 12, fontFamily: D.fSans},
}));
