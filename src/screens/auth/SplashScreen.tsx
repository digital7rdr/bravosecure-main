import React, {useEffect, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  StatusBar,
  Platform,
  useWindowDimensions,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Svg, {Defs, RadialGradient, Stop, Rect} from 'react-native-svg';
import BravoMark from '@components/BravoMark';
import {Halo} from '@components/Halo';
import type {AuthScreenProps} from '@navigation/types';

// Palette — from the "Bravo Secure Splash" design (premium redesign)
const ACCENT = '#2F6FE0';
const BG_TOP = '#0B1830';
const BG_MID = '#0A1428';
const BG_BOT = '#070C18';
const MONO = Platform.select({ios: 'Menlo', android: 'monospace', default: 'monospace'});

const TILE = 132; // logo tile size

const BAR_DURATION = 2000; // B-91 M0 — spec: 2s splash, then the product selector

type Props = AuthScreenProps<'Splash'>;

export default function SplashScreen({navigation}: Props) {
  // Reactive dims — a foldable unfold mid-splash must re-span the halo,
  // vignette and loader, so no module-scope Dimensions.get freeze here.
  const {width, height} = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const HALO = Math.round(width * 1.7);
  // ambient + brand motion
  const halo = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  // entrance
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.9)).current;
  const textRise = useRef(new Animated.Value(0)).current;
  const loaderRise = useRef(new Animated.Value(0)).current;
  // progress
  const barWidth = useRef(new Animated.Value(0)).current;
  const navigated = useRef(false);

  useEffect(() => {
    const anims: Animated.CompositeAnimation[] = [];

    // ambient center halo — pulse opacity + scale
    const haloLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(halo, {toValue: 1, duration: 2500, useNativeDriver: true}),
        Animated.timing(halo, {toValue: 0, duration: 2500, useNativeDriver: true}),
      ]),
    );
    haloLoop.start();
    anims.push(haloLoop);

    // logo tile float
    const floatLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, {toValue: 1, duration: 2250, useNativeDriver: true}),
        Animated.timing(float, {toValue: 0, duration: 2250, useNativeDriver: true}),
      ]),
    );
    floatLoop.start();
    anims.push(floatLoop);

    // pulse rings (staggered)
    const ringLoop = (v: Animated.Value) =>
      Animated.loop(Animated.timing(v, {toValue: 1, duration: 2600, useNativeDriver: true}));
    const ring1Loop = ringLoop(ring1);
    ring1Loop.start();
    anims.push(ring1Loop);
    let ring2Loop: Animated.CompositeAnimation | null = null;
    const ring2Timer = setTimeout(() => {
      ring2Loop = ringLoop(ring2);
      ring2Loop.start();
    }, 1300);

    // entrance: logo, then wordmark/tagline, then loader
    const entrance = Animated.sequence([
      Animated.delay(150),
      Animated.parallel([
        Animated.timing(logoOpacity, {toValue: 1, duration: 600, useNativeDriver: true}),
        Animated.spring(logoScale, {toValue: 1, tension: 55, friction: 8, useNativeDriver: true}),
      ]),
      Animated.timing(textRise, {toValue: 1, duration: 500, useNativeDriver: true}),
      Animated.timing(loaderRise, {toValue: 1, duration: 500, useNativeDriver: true}),
    ]);
    entrance.start();
    anims.push(entrance);

    // progress bar fills (ease-out, matching the design), then advance once
    const barAnim = Animated.timing(barWidth, {
      toValue: 1,
      duration: BAR_DURATION,
      easing: Easing.out(Easing.poly(2.2)),
      useNativeDriver: false,
    });
    barAnim.start(({finished}) => {
      if (finished && !navigated.current) {
        navigated.current = true;
        navigation.replace('Onboarding');
      }
    });
    anims.push(barAnim);

    return () => {
      navigated.current = true; // guard against navigating after unmount
      clearTimeout(ring2Timer);
      anims.forEach(a => a.stop());
      ring2Loop?.stop();
    };
    // mount-only splash sequence; refs + navigation are stable for this screen's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const haloOpacity = halo.interpolate({inputRange: [0, 1], outputRange: [0.5, 0.85]});
  const haloScale = halo.interpolate({inputRange: [0, 1], outputRange: [1, 1.06]});
  const floatY = float.interpolate({inputRange: [0, 1], outputRange: [0, -7]});
  const ring1Scale = ring1.interpolate({inputRange: [0, 1], outputRange: [0.85, 1.5]});
  const ring1Opacity = ring1.interpolate({inputRange: [0, 1], outputRange: [0.6, 0]});
  const ring2Scale = ring2.interpolate({inputRange: [0, 1], outputRange: [0.85, 1.5]});
  const ring2Opacity = ring2.interpolate({inputRange: [0, 1], outputRange: [0.6, 0]});
  const textTranslate = textRise.interpolate({inputRange: [0, 1], outputRange: [14, 0]});
  const loaderTranslate = loaderRise.interpolate({inputRange: [0, 1], outputRange: [14, 0]});
  const barWidthPct = barWidth.interpolate({inputRange: [0, 1], outputRange: ['6%', '100%']});

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={BG_TOP} translucent />

      {/* background gradient */}
      <LinearGradient
        colors={[BG_TOP, BG_MID, BG_BOT]}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />

      {/* ambient center halo (reuses the shared Halo component) */}
      <Halo
        size={HALO}
        color={ACCENT}
        innerOpacity={0.16}
        midOpacity={0.05}
        style={{
          left: width / 2 - HALO / 2,
          top: height * 0.42 - HALO / 2,
          opacity: haloOpacity,
          transform: [{scale: haloScale}],
        }}
      />

      {/* edge vignette */}
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width={width} height={height}>
        <Defs>
          <RadialGradient id="vig" cx="50%" cy="42%" rx="75%" ry="75%">
            <Stop offset="0.4" stopColor="#04070E" stopOpacity="0" />
            <Stop offset="1" stopColor="#04070E" stopOpacity="0.55" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={width} height={height} fill="url(#vig)" />
      </Svg>

      {/* center block */}
      <View style={styles.center} pointerEvents="none">
        {/* logo tile (floats) */}
        <Animated.View
          style={[
            styles.tileWrap,
            {opacity: logoOpacity, transform: [{translateY: floatY}, {scale: logoScale}]},
          ]}>
          {/* pulse rings */}
          <Animated.View
            style={[styles.ring, {opacity: ring1Opacity, transform: [{scale: ring1Scale}]}]}
          />
          <Animated.View
            style={[styles.ring, {opacity: ring2Opacity, transform: [{scale: ring2Scale}]}]}
          />
          {/* tile */}
          <LinearGradient
            colors={['rgba(30,52,96,0.9)', 'rgba(14,24,44,0.85)']}
            start={{x: 0.17, y: 0}}
            end={{x: 0.83, y: 1}}
            style={styles.tile}>
            {/* top edge highlight */}
            <LinearGradient
              colors={['transparent', 'rgba(255,255,255,0.4)', 'transparent']}
              start={{x: 0, y: 0}}
              end={{x: 1, y: 0}}
              style={styles.tileHighlight}
            />
            {/* official Bravo mark — kept intact */}
            <BravoMark size={92} primary="#FFFFFF" accent="#0084FE" />
          </LinearGradient>
        </Animated.View>

        {/* wordmark + tagline */}
        <Animated.View
          style={{opacity: textRise, transform: [{translateY: textTranslate}], alignItems: 'center'}}>
          <Text style={styles.wordmark}>BRAVO SECURE</Text>
          <Text style={styles.tagline}>ENTERPRISE SECURITY PLATFORM</Text>
        </Animated.View>
      </View>

      {/* bottom loader */}
      <Animated.View
        style={[styles.loader, {bottom: 92 + insets.bottom, opacity: loaderRise, transform: [{translateY: loaderTranslate}]}]}>
        <View style={styles.barTrack}>
          <Animated.View style={[styles.barFill, {width: barWidthPct}]}>
            <LinearGradient
              colors={['#1E4FB0', ACCENT, '#7FA8FF']}
              locations={[0, 0.7, 1]}
              start={{x: 0, y: 0}}
              end={{x: 1, y: 0}}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        </View>
        <View style={styles.loaderRow}>
          <View style={styles.loaderDot} />
          <Text style={styles.loaderLabel}>LOADING · MAX 2S</Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: BG_BOT, overflow: 'hidden'},

  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 40,
  },

  tileWrap: {
    width: TILE,
    height: TILE,
    marginBottom: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },

  ring: {
    position: 'absolute',
    top: -6,
    left: -6,
    right: -6,
    bottom: -6,
    borderRadius: 34,
    borderWidth: 1,
    borderColor: ACCENT,
  },

  tile: {
    width: TILE,
    height: TILE,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(127,168,255,0.34)',
    // Why: iOS renders the accent glow; Android has no colored shadow, the
    // SVG halo + border carry the effect there.
    shadowColor: ACCENT,
    shadowOffset: {width: 0, height: 0},
    shadowOpacity: 0.4,
    shadowRadius: 30,
    elevation: 12,
  },

  tileHighlight: {
    position: 'absolute',
    top: 0,
    left: 20,
    right: 20,
    height: 1,
  },

  wordmark: {
    color: '#F4F7FF',
    fontSize: 33,
    fontWeight: '800',
    letterSpacing: 8,
    textAlign: 'center',
  },

  tagline: {
    color: 'rgba(150,172,214,0.62)',
    fontFamily: MONO,
    fontSize: 11.5,
    fontWeight: '500',
    letterSpacing: 5,
    textAlign: 'center',
    marginTop: 16,
  },

  loader: {
    position: 'absolute',
    left: 40,
    right: 40,
    bottom: 92,
  },
  barTrack: {
    height: 3,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 3,
    overflow: 'hidden',
    shadowColor: ACCENT,
    shadowOffset: {width: 0, height: 0},
    shadowOpacity: 0.9,
    shadowRadius: 7,
  },
  loaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 22,
  },
  loaderDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: ACCENT,
    shadowColor: ACCENT,
    shadowOffset: {width: 0, height: 0},
    shadowOpacity: 1,
    shadowRadius: 4,
  },
  loaderLabel: {
    color: 'rgba(150,172,214,0.72)',
    fontFamily: MONO,
    fontSize: 10.5,
    fontWeight: '600',
    letterSpacing: 3.5,
  },
});
