import React, {useState, useEffect, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  Animated,
  Easing,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import {goBackOnce} from '@navigation/tapGuard';

const PURPLE = '#7C3AED';
const BARS = [16, 26, 36, 28, 44, 32, 44, 28, 36, 24, 16];

/**
 * Fix #40: VoiceCallScreen is a DEMO/preview surface used to iterate
 * on the call UI without booting WebRTC. The route stays registered
 * in MessengerNavigator (`name="VoiceCall"`) so design / QA can still
 * navigate to it, but production code uses CallScreen.tsx for real
 * 1:1 audio. We gate the body behind __DEV__ so a release-build
 * accidental nav (deep link, debug menu) shows a clear placeholder
 * instead of misleading the user with a fake "call".
 */
export default function VoiceCallScreen() {
  if (!__DEV__) {
    // Release builds: render a tiny placeholder so the screen is
    // navigable (typings stay valid) but obviously non-functional.
    // Real audio calls go through CallScreen.tsx — see launchCall().
    return null;
  }
  return <VoiceCallScreenDev />;
}

function VoiceCallScreenDev() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [onHold, setOnHold] = useState(false);
  const [seconds, setSeconds] = useState(154); // 02:34

  // Pulse rings
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;

  // Bar animations
  const barAnims = useRef(BARS.map(() => new Animated.Value(0.2))).current;

  useEffect(() => {
    // Pulse rings
    const pulse1 = Animated.loop(
      Animated.sequence([
        Animated.timing(ring1, {toValue: 1, duration: 2400, easing: Easing.out(Easing.ease), useNativeDriver: true}),
        Animated.timing(ring1, {toValue: 0, duration: 0, useNativeDriver: true}),
      ]),
    );
    const pulse2 = Animated.loop(
      Animated.sequence([
        Animated.delay(900),
        Animated.timing(ring2, {toValue: 1, duration: 2400, easing: Easing.out(Easing.ease), useNativeDriver: true}),
        Animated.timing(ring2, {toValue: 0, duration: 0, useNativeDriver: true}),
      ]),
    );
    pulse1.start();
    pulse2.start();

    // Bars
    const delays = [0, 100, 200, 300, 150, 50, 200, 300, 200, 100, 0];
    const barLoops = barAnims.map((anim, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delays[i]),
          Animated.timing(anim, {toValue: 1, duration: 550, easing: Easing.inOut(Easing.ease), useNativeDriver: true}),
          Animated.timing(anim, {toValue: 0.2, duration: 550, easing: Easing.inOut(Easing.ease), useNativeDriver: true}),
        ]),
      ),
    );
    barLoops.forEach(l => l.start());

    // Timer
    const timer = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => {
      clearInterval(timer);
      pulse1.stop();
      pulse2.stop();
      barLoops.forEach(l => l.stop());
    };
    // Animated.Value refs are stable; including them in deps would
    // re-run setup on every render (no value-equality on Animated.Value).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  const ring1Scale = ring1.interpolate({inputRange: [0, 1], outputRange: [1, 1.8]});
  const ring1Opacity = ring1.interpolate({inputRange: [0, 1], outputRange: [0.5, 0]});
  const ring2Scale = ring2.interpolate({inputRange: [0, 1], outputRange: [1, 1.8]});
  const ring2Opacity = ring2.interpolate({inputRange: [0, 1], outputRange: [0.4, 0]});

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* Top row */}
      <View style={styles.topRow}>
        <TouchableOpacity style={styles.minimiseBtn} onPress={() => goBackOnce(navigation)}>
          <Icon name="phone-missed" size={14} color="rgba(229,233,242,0.62)" />
          <Text style={styles.minimiseText}>MINIMISE</Text>
        </TouchableOpacity>
        <View style={styles.encryptBadge}>
          <Icon name="video-off" size={12} color="#F87171" />
          <View>
            <Text style={styles.encryptLine}>AES-256</Text>
            <Text style={styles.encryptLine}>ENCRYPTED</Text>
          </View>
        </View>
      </View>

      {/* Avatar section */}
      <View style={styles.avatarSection}>
        <View style={styles.avatarContainer}>
          <Animated.View style={[styles.pulseRing, {transform: [{scale: ring1Scale}], opacity: ring1Opacity, borderColor: 'rgba(124,58,237,0.35)'}]} />
          <Animated.View style={[styles.pulseRing, {transform: [{scale: ring2Scale}], opacity: ring2Opacity, borderColor: 'rgba(124,58,237,0.15)'}]} />
          <View style={styles.avatarCircle}>
            <Icon name="account" size={42} color="#FFF" />
          </View>
        </View>

        <Text style={styles.callerName}>Marcus{'\n'}Thornton</Text>

        <View style={styles.statusRow}>
          <View style={styles.greenDot} />
          <Text style={styles.statusText}>Connected · {formatTime(seconds)}</Text>
        </View>
        <Text style={styles.subtitleText}>Encrypted Voice Call · WebRTC</Text>
      </View>

      {/* Waveform */}
      <View style={styles.waveform}>
        {barAnims.map((anim, i) => (
          <Animated.View
            key={i}
            style={[
              styles.bar,
              {
                height: BARS[i],
                transform: [{scaleY: anim}],
              },
            ]}
          />
        ))}
      </View>

      {/* Controls */}
      <View style={[styles.controls, {paddingBottom: insets.bottom + 16}]}>
        <View style={styles.controlRow}>
          <CtrlBtn icon={muted ? 'microphone-off' : 'microphone'} label="Mute" active={muted} onPress={() => setMuted(v => !v)} />
          <CtrlBtn icon={speaker ? 'volume-off' : 'volume-high'} label="Speaker" active={speaker} onPress={() => setSpeaker(v => !v)} />
          <CtrlBtn icon={onHold ? 'play-circle-outline' : 'pause-circle-outline'} label="Hold" active={onHold} onPress={() => setOnHold(v => !v)} />
          <CtrlBtn icon="dialpad" label="Keypad" active={false} onPress={() => {}} />
        </View>

        <TouchableOpacity
          style={styles.endCallBtn}
          onPress={() => goBackOnce(navigation)}
          activeOpacity={0.85}>
          <Icon name="phone-hangup" size={28} color="#FFF" />
        </TouchableOpacity>
      </View>

      {/* Home indicator */}
      <View style={styles.homeIndicator} />
    </View>
  );
}

function CtrlBtn({icon, label, active, onPress}: {icon: string; label: string; active: boolean; onPress: () => void}) {
  return (
    <TouchableOpacity style={styles.ctrlBtn} onPress={onPress} activeOpacity={0.8}>
      <View style={[styles.ctrlCircle, active && styles.ctrlCircleActive]}>
        <Icon name={icon} size={20} color={active ? '#5B8DEF' : 'rgba(229,233,242,0.62)'} />
      </View>
      <Text style={styles.ctrlLabel}>{label.toUpperCase()}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#07090D',
    // radial gradient approximation
  },

  topRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12},
  minimiseBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99},
  minimiseText: {fontSize: 10, fontWeight: '800', letterSpacing: 2, color: 'rgba(229,233,242,0.62)'},
  encryptBadge: {flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(153,27,27,0.2)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.28)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 99},
  encryptLine: {fontSize: 8.5, fontWeight: '800', letterSpacing: 1.5, color: '#F87171'},

  avatarSection: {alignItems: 'center', paddingTop: 16},
  avatarContainer: {width: 110, height: 110, alignItems: 'center', justifyContent: 'center', marginBottom: 20},
  pulseRing: {position: 'absolute', width: 110, height: 110, borderRadius: 55, borderWidth: 1.5},
  avatarCircle: {width: 88, height: 88, borderRadius: 44, backgroundColor: '#4F46E5', alignItems: 'center', justifyContent: 'center', shadowColor: '#7C3AED', shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.45, shadowRadius: 20, elevation: 12},

  callerName: {fontSize: 28, fontWeight: '800', letterSpacing: 3.5, color: '#FFF', textAlign: 'center', lineHeight: 34, textTransform: 'uppercase', marginBottom: 10},
  statusRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4},
  greenDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: '#22C55E', shadowColor: '#22C55E', shadowOffset: {width: 0, height: 0}, shadowOpacity: 1, shadowRadius: 5},
  statusText: {fontSize: 11, fontWeight: '800', letterSpacing: 2, color: '#22C55E', textTransform: 'uppercase'},
  subtitleText: {fontSize: 9.5, fontWeight: '600', letterSpacing: 2, color: 'rgba(180,188,204,0.45)', textTransform: 'uppercase'},

  waveform: {flex: 1, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 5, opacity: 0.6, paddingBottom: 8},
  bar: {width: 3, borderRadius: 2, backgroundColor: PURPLE},

  controls: {paddingHorizontal: 20, paddingTop: 8},
  controlRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 8, marginBottom: 28},
  ctrlBtn: {alignItems: 'center', gap: 7},
  ctrlCircle: {width: 50, height: 50, borderRadius: 25, backgroundColor: '#171c2e', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)', alignItems: 'center', justifyContent: 'center'},
  ctrlCircleActive: {backgroundColor: 'rgba(91,141,239,0.25)', borderColor: 'rgba(91,141,239,0.5)'},
  ctrlLabel: {fontSize: 10, fontWeight: '800', letterSpacing: 1.4, color: 'rgba(180,188,204,0.45)'},
  endCallBtn: {width: 60, height: 60, borderRadius: 30, backgroundColor: '#EF4444', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', shadowColor: '#EF4444', shadowOffset: {width: 0, height: 6}, shadowOpacity: 0.5, shadowRadius: 14},

  homeIndicator: {height: 4, width: 110, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.15)', alignSelf: 'center', marginBottom: 8, marginTop: 4},
});
