import React, {useEffect, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Easing,
  ScrollView,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';
import type {AuthScreenProps} from '@navigation/types';

type Props = AuthScreenProps<'SignupSuccess'>;

const PRIMARY     = '#1E88FF';
const BG          = '#07090D';
const SURFACE     = '#1B3A66';
const BORDER      = '#1C3B66';
const GREEN       = '#00C853';

export default function SignupSuccessScreen({route}: Props) {
  const {fullName, role, tier} = route.params;
  const {completeAuth, isLoading} = useAuthStore();

  const checkScale = useRef(new Animated.Value(0)).current;
  const cardOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.delay(120),
      Animated.spring(checkScale, {
        toValue: 1, tension: 40, friction: 6,
        useNativeDriver: true,
      }),
      Animated.timing(cardOpacity, {
        toValue: 1, duration: 320,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [checkScale, cardOpacity]);

  const tierLabel =
    role === 'corporate'
      ? 'Corporate'
      : tier === 'pro'
      ? 'Individual · Pro'
      : 'Individual · Lite';

  const perks: string[] =
    tier === 'pro'
      ? [
          'Executive protection on demand',
          'AI itinerary parsing & risk scoring',
          'Priority ops & 24/7 secure comms',
          'Bravo Credits + corporate billing',
        ]
      : [
          'Secure messenger with Signal Protocol',
          'Virtual Bodyguard personal safety',
          'Bravo Lite booking with local agents',
          'Encrypted vault for sensitive files',
        ];

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView
        style={s.flex}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}>
        <Animated.View style={[s.checkRing, {transform: [{scale: checkScale}]}]}>
          <View style={s.checkInner}>
            <Icon name="check" size={48} color="#fff" />
          </View>
        </Animated.View>

        <Text style={s.title}>You're in, {fullName.split(' ')[0]}.</Text>
        <Text style={s.subtitle}>Your secure account is ready.</Text>

        <Animated.View style={[s.card, {opacity: cardOpacity}]}>
      <ImageryBackdrop source={Imagery.authWelcome} variant="hero" radius={16} />
          <Text style={s.cardLabel}>ACCOUNT TYPE</Text>
          <Text style={s.cardTier}>{tierLabel}</Text>

          <View style={s.divider} />

          <Text style={s.cardLabel}>WHAT YOU GET</Text>
          <View style={s.perks}>
            {perks.map(p => (
              <View key={p} style={s.perkRow}>
                <View style={s.perkDot} />
                <Text style={s.perkText}>{p}</Text>
              </View>
            ))}
          </View>
        </Animated.View>

        <TouchableOpacity
          style={[s.btn, isLoading && s.btnDisabled]}
          onPress={() => { void completeAuth(); }}
          disabled={isLoading}
          activeOpacity={0.85}>
          <Text style={s.btnText}>{isLoading ? 'Opening…' : 'Go to Dashboard'}</Text>
          {!isLoading && <Icon name="arrow-right" size={19} color="#fff" />}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  safe:    {flex: 1, backgroundColor: BG},
  flex:    {flex: 1},
  // flexGrow keeps the marginTop:'auto' button pinned to the bottom on tall
  // screens while letting content scroll on short ones.
  content: {flexGrow: 1, paddingHorizontal: 24, paddingTop: 48, alignItems: 'center'},

  checkRing: {
    width: 104, height: 104, borderRadius: 52,
    backgroundColor: 'rgba(0,200,81,0.15)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 24,
  },
  checkInner: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: GREEN,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: GREEN, shadowOpacity: 0.45, shadowRadius: 20,
    shadowOffset: {width: 0, height: 10}, elevation: 10,
  },

  title:    {color: '#FFFFFF', fontSize: 24, fontWeight: '800', letterSpacing: -0.5, textAlign: 'center'},
  subtitle: {color: '#B8C7E0', fontSize: 14, marginTop: 6, textAlign: 'center', marginBottom: 28},

  card: {
    alignSelf: 'stretch',
    backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
    borderRadius: 16, padding: 18,
  },
  cardLabel: {color: '#B8C7E0', fontSize: 10, fontWeight: '800', letterSpacing: 2.5, marginBottom: 6},
  cardTier:  {color: '#FFFFFF', fontSize: 18, fontWeight: '700', letterSpacing: -0.3, marginBottom: 12},
  divider:   {height: 1, backgroundColor: BORDER, marginVertical: 10},
  perks:     {marginTop: 6, gap: 8},
  perkRow:   {flexDirection: 'row', alignItems: 'center', gap: 10},
  perkDot:   {width: 6, height: 6, borderRadius: 3, backgroundColor: PRIMARY},
  perkText:  {color: '#B8C7E0', fontSize: 13},

  btn: {
    marginTop: 'auto', marginBottom: 24,
    alignSelf: 'stretch',
    height: 56, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: PRIMARY,
    shadowColor: PRIMARY, shadowOpacity: 0.35, shadowRadius: 18,
    shadowOffset: {width: 0, height: 8}, elevation: 8,
  },
  btnDisabled: {opacity: 0.55},
  btnText: {color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 1.5},
}));
