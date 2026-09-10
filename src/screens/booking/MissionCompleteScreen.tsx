/**
 * MissionCompleteScreen (F2) — the "trip finished" moment. COMPLETED previously
 * popToTop'd the client silently home; now they land here: confirmation tick,
 * fare total, crew call-signs, and the two actions that matter — Rate the agency
 * and View invoice. Obsidian + cobalt, mirroring AgencyAcceptedScreen's layout.
 */
import React, {useEffect, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {BookingStackParamList} from '@navigation/types';
import {bookingApi, assignmentApi} from '@services/api';
import MissionStepper from '@components/mission/MissionStepper';
import {UI} from '@components/ui/tokens';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

export default function MissionCompleteScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const {bookingId} = useRoute<RouteProp<BookingStackParamList, 'MissionComplete'>>().params;
  const [total, setTotal] = useState<number | null>(null);
  const [alreadyRated, setAlreadyRated] = useState(false);
  const [crew, setCrew] = useState<Array<{call_sign: string; role: string}>>([]);

  useEffect(() => {
    let alive = true;
    void bookingApi.getById(bookingId)
      .then(({data}) => {
        if (!alive) {return;}
        setTotal(Number((data as {total_eur?: number}).total_eur ?? (data as {estimated_price?: number}).estimated_price ?? 0));
        setAlreadyRated(typeof (data as {rating?: number | null}).rating === 'number');
      })
      .catch(() => undefined);
    void assignmentApi.getTeam(bookingId)
      .then(({data}) => { if (alive) {setCrew((data.cpos ?? []).map(c => ({call_sign: c.call_sign, role: c.role})));} })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [bookingId]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <View style={s.center}>
        <View style={s.tick}><Icon name="flag-checkered" size={38} color={UI.signal} importantForAccessibility="no" /></View>
        <Text style={s.kicker}>MISSION COMPLETE</Text>
        <Text style={s.title}>You’re safely delivered</Text>
        {total !== null && total > 0 && (
          <Text style={s.fare} numberOfLines={1} ellipsizeMode="tail">{Math.round(total).toLocaleString()} BC</Text>
        )}
        {crew.length > 0 && (
          <Text style={s.crewLine} numberOfLines={2}>
            Your detail: {crew.map(c => c.call_sign).filter(Boolean).join(' · ')}
          </Text>
        )}
        <View style={s.stepperWrap}>
          <MissionStepper booking={{status: 'COMPLETED'}} mission={{status: 'COMPLETED'}} />
        </View>
      </View>

      <View style={[s.footer, {paddingBottom: bottomPad(16)}]}>
        {!alreadyRated && (
          <TouchableOpacity style={s.primaryBtn} activeOpacity={0.85} accessibilityRole="button"
            onPress={() => navigation.navigate('RateAgency', {bookingId})}>
            <Icon name="star" size={17} color="#fff" importantForAccessibility="no" />
            <Text style={s.primaryText}>Rate the agency</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={s.secondaryBtn} activeOpacity={0.85} accessibilityRole="button"
          onPress={() => navigation.navigate('Invoice', {bookingId})}>
          <Icon name="file-document-outline" size={16} color={UI.accentSoft} importantForAccessibility="no" />
          <Text style={s.secondaryText}>View invoice</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.doneBtn} activeOpacity={0.85} accessibilityRole="button" onPress={() => navigation.popToTop()}>
          <Text style={s.doneText}>Done</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 34, gap: 8},
  tick: {width: 88, height: 88, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 8,
    backgroundColor: 'rgba(74,222,128,0.10)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.30)'},
  kicker: {fontFamily: UI.fSemi, fontSize: 10, letterSpacing: 2, color: UI.textMute},
  title: {fontFamily: UI.fBold, fontSize: 23, color: UI.text, letterSpacing: -0.4, textAlign: 'center', marginTop: 2},
  fare: {fontFamily: UI.fBold, fontSize: 18, color: UI.accentSoft, marginTop: 8},
  crewLine: {fontFamily: UI.fSans, fontSize: 12.5, color: UI.textDim, textAlign: 'center', marginTop: 6, maxWidth: '92%'},
  stepperWrap: {alignSelf: 'stretch', marginTop: 18},
  footer: {paddingHorizontal: 22, gap: 10},
  primaryBtn: {flexDirection: 'row', gap: 8, height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: UI.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  primaryText: {fontFamily: UI.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},
  secondaryBtn: {flexDirection: 'row', gap: 8, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)'},
  secondaryText: {fontFamily: UI.fBold, fontSize: 14, color: UI.accentSoft},
  doneBtn: {height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: UI.hair},
  doneText: {fontFamily: UI.fBold, fontSize: 14, color: UI.textDim, letterSpacing: 0.2},
}));
