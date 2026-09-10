/**
 * B-91 M2 R4 — expanded operational map (spec p.18).
 *
 * "View on Map" lands here: the key-points map fills the screen (>70%
 * visible area), Mapbox GL gestures (pinch/pan/rotate) work inside the
 * canvas, and selecting a pin opens a compact details card with name,
 * category, distance and a Navigate action that hands off to the device
 * maps app. Back returns to the Home dashboard (its scroll state survives —
 * the screen stays mounted beneath this push).
 */
import React, {useEffect, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, Linking, Platform} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {vbgApi, type VbgKeyPoint} from '@/services/api';
import {retryTransient} from './vbgRetry';
import {useVbgLocation} from './useVbgLocation';
import {VBG, SectionLabel, IconButton} from './vbgUi';
import {VbgKeyPointsMap} from './VbgKeyPointsMap';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

const KIND_LABEL: Record<VbgKeyPoint['kind'], string> = {
  police: 'Police', hospital: 'Hospital', embassy: 'Embassy', fire: 'Fire',
};
const KIND_COLOR: Record<VbgKeyPoint['kind'], string> = {
  police: VBG.accent, hospital: VBG.signal, embassy: VBG.amber, fire: '#FF7A5C',
};

function openInMaps(kp: VbgKeyPoint) {
  const label = encodeURIComponent(kp.label);
  const url = Platform.select({
    ios: `http://maps.apple.com/?q=${label}&ll=${kp.lat},${kp.lng}`,
    android: `geo:${kp.lat},${kp.lng}?q=${kp.lat},${kp.lng}(${label})`,
    default: `https://maps.google.com/?q=${kp.lat},${kp.lng}`,
  });
  Linking.openURL(url).catch(() => {});
}

export default function VBGMapScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteProp<BookingStackParamList, 'VBGMap'>>();
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const {fix, ready} = useVbgLocation();
  // Expanded from an embedded map — show the SAME analysed context (centre,
  // radius ring, points) instead of re-fetching around the live fix.
  const ctx = route.params;
  const [keypoints, setKeypoints] = useState<VbgKeyPoint[]>(ctx?.points ?? []);
  const [selected, setSelected] = useState<VbgKeyPoint | null>(null);
  // B-409 — measured header height, fed to the map so its in-map controls
  // clear this overlay. Fallback covers the frame before the first onLayout.
  const [headerH, setHeaderH] = useState(insets.top + 44);

  useEffect(() => {
    if (ctx?.points?.length) {return;}
    if (!ready) {return;}
    let alive = true;
    retryTransient(
      () => vbgApi.keypoints(fix ?? {}).then(res => res.data.keypoints),
      {isEmpty: kps => kps.length === 0},
    )
      .then(kps => { if (alive) {setKeypoints(kps);} })
      .catch(() => { if (alive) {setKeypoints([]);} });
    return () => { alive = false; };
  }, [ready, fix, ctx?.points]);

  return (
    <View style={styles.root}>
      {/* Map fills everything under the slim header — comfortably >70%. */}
      <VbgKeyPointsMap
        centre={ctx?.centre ?? fix}
        radiusKm={ctx?.radiusKm}
        points={keypoints}
        onTapPoint={setSelected}
        style={StyleSheet.absoluteFillObject}
        // B-409 — the map is absoluteFill BEHIND this header, so its in-map
        // DARK/LIGHT + HEATMAP controls landed under the status bar. Measured,
        // not a constant: the header pads by insets.top, which varies per
        // device, and its content grows with fontScale.
        topInset={headerH + 8}
      />

      <View
        style={[styles.header, {paddingTop: insets.top + 8}]}
        onLayout={e => setHeaderH(e.nativeEvent.layout.height)}>
        <IconButton onPress={() => goBackOnce(navigation)}>
          <Svg width={9} height={15} viewBox="0 0 9 15"><Path d="M8 1L1.5 7.5 8 14" stroke={VBG.text} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
        </IconButton>
        <SectionLabel color={VBG.text} style={{fontSize: 12, letterSpacing: 2}}>Live Map</SectionLabel>
      </View>

      {/* Pin details card — name, category, distance, Navigate (2 actions max
          from pin to navigation, per the spec's acceptance). */}
      {selected ? (
        <View style={[styles.card, {paddingBottom: bottomPad(14)}]}>
          <View style={styles.cardTop}>
            <View style={[styles.kindDot, {backgroundColor: KIND_COLOR[selected.kind], shadowColor: KIND_COLOR[selected.kind]}]} />
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={styles.cardTitle} numberOfLines={1}>{selected.label}</Text>
              <Text style={styles.cardSub}>
                {KIND_LABEL[selected.kind]} · {selected.distanceKm.toFixed(1)} km away
              </Text>
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Close details"
              hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
              onPress={() => setSelected(null)}>
              <Svg width={13} height={13} viewBox="0 0 14 14"><Path d="M1 1l12 12M13 1L1 13" stroke={VBG.textMute} strokeWidth={1.8} strokeLinecap="round" /></Svg>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.navBtn}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={`Navigate to ${selected.label}`}
            onPress={() => openInMaps(selected)}>
            <Text style={styles.navBtnText}>NAVIGATE</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: '#05070B'},
  header: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 18, paddingBottom: 10,
    backgroundColor: 'rgba(7,9,13,0.82)',
  },
  card: {
    position: 'absolute', left: 12, right: 12, bottom: 0,
    borderRadius: 18, padding: 14,
    backgroundColor: 'rgba(7,9,13,0.94)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  cardTop: {flexDirection: 'row', alignItems: 'center', gap: 10},
  kindDot: {width: 10, height: 10, borderRadius: 5, shadowOpacity: 0.8, shadowRadius: 5, shadowOffset: {width: 0, height: 0}},
  cardTitle: {color: VBG.text, fontSize: 14.5, fontWeight: '700'},
  cardSub: {color: VBG.textDim, fontSize: 11.5, marginTop: 2},
  navBtn: {
    marginTop: 12, height: 44, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#2F5BE0',
  },
  navBtnText: {color: '#FFF', fontSize: 12.5, fontWeight: '800', letterSpacing: 1.5},
}));
