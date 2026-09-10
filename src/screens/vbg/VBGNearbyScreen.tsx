import React, {useEffect, useMemo, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, Linking, Platform} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {vbgApi, type VbgKeyPoint} from '@/services/api';
import LoadingView from '@components/LoadingView';
import {retryTransient} from './vbgRetry';
import {useVbgLocation} from './useVbgLocation';
import {
  VBG, VbgScreen, VbgCard, SectionLabel, RiskBadge, IconButton,
} from './vbgUi';
import {VbgFooter} from './VbgFooter';
import {VbgKeyPointsMap} from './VbgKeyPointsMap';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

const KIND_COLOR: Record<VbgKeyPoint['kind'], string> = {
  police: VBG.accent, hospital: VBG.signal, embassy: VBG.amber, fire: '#FF7A5C',
};
const KIND_LABEL: Record<VbgKeyPoint['kind'], string> = {
  police: 'Police', hospital: 'Hospital', embassy: 'Embassy', fire: 'Fire',
};

export default function VBGNearbyScreen() {
  const navigation = useNavigation<Nav>();
  const {fix, ready} = useVbgLocation();
  const [keypoints, setKeypoints] = useState<VbgKeyPoint[]>([]);
  const [region, setRegion] = useState<string | null>(null);
  const [criticalCount, setCriticalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!ready) {return;}
    let alive = true;
    setLoading(true);
    setRetrying(false);
    // Why: Overpass transiently returns empty/429 on first hit — self-retry
    // before conceding "No key points found" (an empty final answer stands).
    retryTransient(
      () => vbgApi.keypoints(fix ?? {}).then(res => res.data.keypoints),
      {
        isEmpty: kps => kps.length === 0,
        onRetry: () => { if (alive) {setRetrying(true);} },
      },
    )
      .then(kps => { if (alive) {setKeypoints(kps);} })
      .catch(() => { if (alive) {setKeypoints([]);} })
      .finally(() => { if (alive) { setLoading(false); setRetrying(false); } });
    vbgApi.threats(fix ?? {})
      .then(res => { if (alive) { setRegion(res.data.region); setCriticalCount(res.data.counts.critical); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [ready, fix]);

  // Open a key point in the device maps app (geo: on Android, Apple Maps on iOS).
  const openInMaps = (kp: VbgKeyPoint) => {
    const label = encodeURIComponent(kp.label);
    const url = Platform.select({
      ios: `http://maps.apple.com/?q=${label}&ll=${kp.lat},${kp.lng}`,
      android: `geo:${kp.lat},${kp.lng}?q=${kp.lat},${kp.lng}(${label})`,
      default: `https://maps.google.com/?q=${kp.lat},${kp.lng}`,
    });
    Linking.openURL(url).catch(() => {});
  };

  // B-91 M2 R5 — category filter + nearest-first sort. The SAME filtered set
  // feeds the map and the list so they can never diverge (spec p.19).
  const [kindFilter, setKindFilter] = useState<VbgKeyPoint['kind'] | 'all'>('all');
  const visible = useMemo(
    () => keypoints
      .filter(kp => kindFilter === 'all' || kp.kind === kindFilter)
      .sort((a, b) => a.distanceKm - b.distanceKm),
    [keypoints, kindFilter],
  );

  const noFix = ready && !fix;
  const empty = !loading && visible.length === 0;

  return (
    <VbgScreen footer={<VbgFooter />}>
      {/* back nav */}
      <View style={styles.header}>
        <IconButton onPress={() => goBackOnce(navigation)}>
          <Svg width={9} height={15} viewBox="0 0 9 15"><Path d="M8 1L1.5 7.5 8 14" stroke={VBG.text} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
        </IconButton>
        <SectionLabel color={VBG.text} style={{fontSize: 12, letterSpacing: 2}}>Nearby Key Points</SectionLabel>
      </View>

      <View style={styles.body}>
        <Text style={styles.intro}>Locate nearby key points for quick access and emergencies.</Text>

        <View style={styles.badgeRow}>
          <RiskBadge level="critical">{criticalCount} Active Alerts</RiskBadge>
          <RiskBadge level="elevated">{region ?? 'Region'} · {criticalCount >= 3 ? 'Elevated' : 'Monitored'}</RiskBadge>
        </View>

        {/* real interactive map — centred on the principal; shows the SAME
            filtered set as the list below */}
        <VbgKeyPointsMap
          centre={fix}
          points={visible}
          onTapPoint={openInMaps}
          onExpand={() => navigation.navigate('VBGMap',
            fix ? {centre: fix, points: visible} : undefined)}
          style={styles.map}
        />

        {/* legend doubles as the category filter (spec p.19) */}
        <View style={styles.legend}>
          <FilterChip c={VBG.textDim} label="All" on={kindFilter === 'all'} onPress={() => setKindFilter('all')} />
          <FilterChip c={VBG.accent} label="Police" on={kindFilter === 'police'} onPress={() => setKindFilter('police')} />
          <FilterChip c={VBG.signal} label="Hospital" on={kindFilter === 'hospital'} onPress={() => setKindFilter('hospital')} />
          <FilterChip c={VBG.amber} label="Embassy" on={kindFilter === 'embassy'} onPress={() => setKindFilter('embassy')} />
          <FilterChip c="#FF7A5C" label="Fire" on={kindFilter === 'fire'} onPress={() => setKindFilter('fire')} />
        </View>

        {/* key-points list — nearest first, tap to open in maps */}
        <SectionLabel style={{marginLeft: 2, marginTop: 2, marginBottom: 2}}>
          {visible.length > 0 ? `${visible.length} Nearby Points · nearest first` : 'Nearby Points'}
        </SectionLabel>

        {loading ? (
          <View style={styles.state}>
            <LoadingView compact label={retrying ? 'Still looking — retrying…' : 'Locating safe points…'} />
          </View>
        ) : noFix ? (
          <View style={styles.state}>
            <Text style={styles.stateTitle}>Location unavailable</Text>
            <Text style={styles.stateText}>Enable GPS / location permission to find nearby police, hospitals and embassies.</Text>
          </View>
        ) : empty ? (
          <View style={styles.state}>
            <Text style={styles.stateTitle}>No key points found nearby</Text>
            <Text style={styles.stateText}>We couldn't locate safe points for this area right now.</Text>
          </View>
        ) : (
          <VbgCard pad={4} radius={16}>
            {visible.map((kp, i, arr) => (
              <TouchableOpacity
                key={`${kp.kind}-${i}`}
                activeOpacity={0.7}
                onPress={() => openInMaps(kp)}
                style={[styles.kpRow, i < arr.length - 1 && styles.kpBorder]}>
                <View style={[styles.kpDot, {backgroundColor: KIND_COLOR[kp.kind], shadowColor: KIND_COLOR[kp.kind]}]} />
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={styles.kpLabel} numberOfLines={1}>{kp.label}</Text>
                  <Text style={styles.kpKind}>{KIND_LABEL[kp.kind]}</Text>
                </View>
                <Text style={styles.kpDist}>{kp.distanceKm.toFixed(1)}<Text style={styles.kpUnit}> km</Text></Text>
                <Svg width={7} height={12} viewBox="0 0 8 14" style={{marginLeft: 8}}><Path d="M1 1l6 6-6 6" stroke={VBG.textMute} strokeWidth={1.7} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
              </TouchableOpacity>
            ))}
          </VbgCard>
        )}
      </View>
    </VbgScreen>
  );
}

function FilterChip({c, label, on, onPress}: {c: string; label: string; on: boolean; onPress: () => void}) {
  return (
    <TouchableOpacity
      style={[styles.legendItem, on && styles.legendItemOn]}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityState={{selected: on}}
      accessibilityLabel={`Filter ${label}`}
      hitSlop={{top: 8, bottom: 8, left: 4, right: 4}}
      onPress={onPress}>
      <View style={[styles.legendDot, {backgroundColor: c, shadowColor: c}]} />
      <Text style={[styles.legendLabel, on && styles.legendLabelOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 16},
  body: {paddingHorizontal: 18, gap: 13},
  intro: {fontSize: 12.5, lineHeight: 18, color: VBG.textDim, letterSpacing: -0.05},
  badgeRow: {flexDirection: 'row', gap: 8, flexWrap: 'wrap'},

  map: {height: 300},

  legend: {flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap', paddingHorizontal: 2},
  legendItem: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingHorizontal: 9, paddingVertical: 5, borderRadius: 99,
    borderWidth: 1, borderColor: 'transparent',
  },
  legendItemOn: {borderColor: 'rgba(91,141,239,0.45)', backgroundColor: 'rgba(91,141,239,0.10)'},
  legendDot: {width: 9, height: 9, borderRadius: 5, shadowOpacity: 0.8, shadowRadius: 5, shadowOffset: {width: 0, height: 0}},
  legendLabel: {fontSize: 11.5, color: VBG.textDim, fontWeight: '500'},
  legendLabelOn: {color: VBG.text, fontWeight: '700'},

  state: {alignItems: 'center', paddingVertical: 26, gap: 7},
  stateTitle: {fontSize: 13, fontWeight: '700', color: VBG.text},
  stateText: {fontSize: 11, color: VBG.textMute, textAlign: 'center', paddingHorizontal: 24, lineHeight: 16},

  kpRow: {flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 12, paddingVertical: 12},
  kpBorder: {borderBottomWidth: 1, borderBottomColor: VBG.hair},
  kpDot: {width: 9, height: 9, borderRadius: 5, shadowOpacity: 0.8, shadowRadius: 5, shadowOffset: {width: 0, height: 0}},
  kpLabel: {fontSize: 13.5, fontWeight: '600', color: VBG.text, letterSpacing: -0.2},
  kpKind: {fontSize: 10, color: VBG.textMute, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.6},
  kpDist: {fontSize: 14, fontWeight: '700', color: VBG.text},
  kpUnit: {fontSize: 10, color: VBG.textMute, fontWeight: '500'},
}));
