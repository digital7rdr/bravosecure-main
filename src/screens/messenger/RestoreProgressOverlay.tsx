/**
 * Full-screen restore-progress splash. Renders ON TOP of
 * BackupRestoreScreen while a restore is in flight. Mounted as an
 * overlay (absolute-positioned, covers the whole viewport) so the
 * underlying password input is masked but the screen lifecycle
 * (back-button trap, biometric prompt) stays intact.
 *
 * Three modes, driven by the `state` prop:
 *   - 'progress' — animated logo + step label + indeterminate bar +
 *                  count-up of restored messages (premium feel).
 *   - 'success'  — green checkmark + restored stats + Continue button.
 *   - 'error'    — red banner + retry message + Close button.
 *
 * The completion modes replace the legacy `Alert.alert('Restore
 * complete', ...)` so users get a styled hand-off into MessengerHome
 * instead of a system dialog.
 */
import React, {useEffect, useRef} from 'react';
import {BACKUP_BASE} from './backupPalette';
import {
  View, Text, StyleSheet, Animated, Easing, TouchableOpacity, StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

const C = {...BACKUP_BASE, surf: '#0B2040', ok: '#00E085', glow: '#7ED6FF'};

export type RestoreProgressState =
  | {kind: 'progress'; step: string; current?: number}
  | {kind: 'success'; messages: number; conversations: number; skipped: number}
  | {kind: 'error'; message: string};

export interface RestoreProgressOverlayProps {
  state: RestoreProgressState;
  onContinue?: () => void;
  onClose?: () => void;
}

export default function RestoreProgressOverlay({
  state, onContinue, onClose,
}: RestoreProgressOverlayProps): React.ReactElement {
  const insets = useSafeAreaInsets();
  const pulse  = useRef(new Animated.Value(0)).current;
  const sweep  = useRef(new Animated.Value(0)).current;
  const fadeIn = useRef(new Animated.Value(0)).current;
  const checkScale = useRef(new Animated.Value(0)).current;
  const countAnim  = useRef(new Animated.Value(0)).current;
  const [displayedCount, setDisplayedCount] = React.useState(0);
  const [showCancel, setShowCancel] = React.useState(false);

  // Stable progress count — avoids a conditional expression inside a hook
  // dependency array (Finding 17) and gives the reset/count-up effects a
  // single value to key on.
  const progressCurrent = state.kind === 'progress' ? (state.current ?? 0) : 0;
  const prevProgress = useRef<{active: boolean; current: number}>({active: false, current: 0});

  // Mount fade-in.
  useEffect(() => {
    Animated.timing(fadeIn, {
      toValue: 1, duration: 250, easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [fadeIn]);

  // Progress mode — logo pulse + indeterminate bar sweep.
  useEffect(() => {
    if (state.kind !== 'progress') {return;}
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true}),
        Animated.timing(pulse, {toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true}),
      ]),
    );
    const sweepLoop = Animated.loop(
      Animated.timing(sweep, {toValue: 1, duration: 1400, easing: Easing.inOut(Easing.cubic), useNativeDriver: false}),
    );
    pulseLoop.start();
    sweepLoop.start();
    return () => {
      pulseLoop.stop();
      sweepLoop.stop();
      pulse.setValue(0);
      sweep.setValue(0);
    };
  }, [state.kind, pulse, sweep]);

  // Finding 17 — reset the counter to 0 when a NEW restore run begins
  // (a fresh entry into progress mode, or the count regressing on a
  // retry after an error) so we don't briefly flash the previous run's
  // total. Runs before the count-up effect below so the animation starts
  // from a clean 0.
  useEffect(() => {
    const active = state.kind === 'progress';
    const prev = prevProgress.current;
    if (active && (!prev.active || progressCurrent < prev.current)) {
      countAnim.stopAnimation();
      countAnim.setValue(0);
      setDisplayedCount(0);
    }
    prevProgress.current = {active, current: progressCurrent};
  }, [state.kind, progressCurrent, countAnim]);

  // Animated count-up of restored messages. Springs from the previous
  // count to the new one so the number doesn't strobe on each batch.
  useEffect(() => {
    if (state.kind !== 'progress' || typeof state.current !== 'number') {return;}
    Animated.timing(countAnim, {
      toValue: progressCurrent, duration: 400,
      easing: Easing.out(Easing.cubic), useNativeDriver: false,
    }).start();
    const sub = countAnim.addListener(({value}) => setDisplayedCount(Math.round(value)));
    return () => { countAnim.removeListener(sub); };
  }, [state.kind, progressCurrent, countAnim]);

  // H-14 — after a grace period, reveal a subtle escape hatch so a
  // stalled restore can't trap the user on a non-dismissible overlay.
  // Keyed on kind only, so the timer isn't reset by each progress batch.
  useEffect(() => {
    if (state.kind !== 'progress') { setShowCancel(false); return; }
    setShowCancel(false);
    const t = setTimeout(() => setShowCancel(true), 20000);
    return () => clearTimeout(t);
  }, [state.kind]);

  // Success mode — checkmark pop-in.
  useEffect(() => {
    if (state.kind !== 'success') {return;}
    Animated.spring(checkScale, {
      toValue: 1, friction: 6, tension: 80, useNativeDriver: true,
    }).start();
    return () => { checkScale.setValue(0); };
  }, [state.kind, checkScale]);

  const pulseScale = pulse.interpolate({inputRange: [0, 1], outputRange: [1, 1.08]});
  const pulseOpacity = pulse.interpolate({inputRange: [0, 1], outputRange: [0.65, 1]});
  const sweepLeft = sweep.interpolate({inputRange: [0, 1], outputRange: ['-40%', '100%']});

  return (
    <Animated.View
      pointerEvents="auto"
      style={[styles.root, {opacity: fadeIn, paddingTop: insets.top, paddingBottom: insets.bottom}]}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      {state.kind === 'progress' && (
        <View style={styles.content}>
          <Animated.View style={[styles.logoRing, {transform: [{scale: pulseScale}], opacity: pulseOpacity}]}>
            <Icon name="shield-lock" size={56} color={C.glow} />
          </Animated.View>
          <Text style={styles.title}>Restoring your messages</Text>
          <Text style={styles.subtitle}>End-to-end encrypted. Only you can read these.</Text>

          {typeof state.current === 'number' && state.current > 0 && (
            <View style={styles.countWrap}>
              <Text style={styles.countNumber}>{displayedCount.toLocaleString()}</Text>
              <Text style={styles.countUnit}>{displayedCount === 1 ? 'message' : 'messages'} restored</Text>
            </View>
          )}

          <View
            style={styles.progressTrack}
            accessibilityRole="progressbar"
            accessibilityLabel="Restore progress">
            <Animated.View style={[styles.progressBar, {left: sweepLeft}]} />
          </View>
          <Text style={styles.stepLabel} accessibilityLiveRegion="polite">{state.step}</Text>

          <View style={styles.note}>
            <Icon name="lock-check" size={16} color={C.tx2} />
            <Text style={styles.noteTxt}>Keep the app open — restore can take a moment</Text>
          </View>

          {showCancel && (
            <TouchableOpacity
              style={styles.cancelLink}
              onPress={onClose}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Cancel restore">
              <Text style={styles.cancelLinkTxt}>Taking too long? Cancel</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {state.kind === 'success' && (
        <View style={styles.content}>
          <Animated.View style={[styles.successCircle, {transform: [{scale: checkScale}]}]}>
            <Icon name="check-bold" size={48} color={C.bg} />
          </Animated.View>
          <Text style={styles.title} accessibilityLiveRegion="polite">Restore complete</Text>
          <Text style={styles.subtitle}>Your secure history is back.</Text>

          <View style={styles.statsCard}>
            <View style={styles.statRow}>
              <Text style={styles.statNumber}>{state.messages.toLocaleString()}</Text>
              <Text style={styles.statLabel}>{state.messages === 1 ? 'message' : 'messages'}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statRow}>
              <Text style={styles.statNumber}>{state.conversations.toLocaleString()}</Text>
              <Text style={styles.statLabel}>{state.conversations === 1 ? 'conversation' : 'conversations'}</Text>
            </View>
            {state.skipped > 0 && (
              <>
                <View style={styles.statDivider} />
                <View style={styles.statRow}>
                  <Text style={[styles.statNumber, {color: C.warn}]}>{state.skipped.toLocaleString()}</Text>
                  <Text style={styles.statLabel}>skipped</Text>
                </View>
              </>
            )}
          </View>

          {state.skipped > 0 && (
            <Text style={styles.skipNote}>
              Some older messages couldn&apos;t be decrypted — likely encrypted under a previous backup password or sent during your reinstall window.
            </Text>
          )}

          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={onContinue}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Open Messenger">
            <Text style={styles.primaryBtnTxt}>OPEN MESSENGER</Text>
            <Icon name="arrow-right" size={18} color={C.bg} style={{marginLeft: 8}} />
          </TouchableOpacity>
        </View>
      )}

      {state.kind === 'error' && (
        <View style={styles.content}>
          <View style={styles.errCircle}>
            <Icon name="alert" size={48} color={C.bg} />
          </View>
          <Text style={styles.title}>Restore failed</Text>
          <Text style={[styles.subtitle, {color: C.err}]} accessibilityLiveRegion="polite">{state.message}</Text>
          <Text style={styles.errHint}>You can retry below.</Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={onClose}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Close">
            <Text style={styles.primaryBtnTxt}>CLOSE</Text>
          </TouchableOpacity>
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    maxWidth: 360,
  },
  logoRing: {
    width: 120, height: 120, borderRadius: 60,
    borderWidth: 2, borderColor: C.glow,
    backgroundColor: 'rgba(126, 214, 255, 0.08)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 28,
    shadowColor: C.glow, shadowOpacity: 0.4, shadowRadius: 20, shadowOffset: {width: 0, height: 0},
    elevation: 8,
  },
  title: {
    color: C.tx1, fontSize: 22, fontWeight: '700',
    textAlign: 'center', marginBottom: 8, letterSpacing: 0.3,
  },
  subtitle: {
    color: C.tx2, fontSize: 14, lineHeight: 20,
    textAlign: 'center', marginBottom: 32,
  },
  countWrap: {
    alignItems: 'center',
    marginBottom: 28,
  },
  countNumber: {
    color: C.glow, fontSize: 48, fontWeight: '800',
    letterSpacing: -1, lineHeight: 56,
  },
  countUnit: {
    color: C.tx3, fontSize: 13, marginTop: 4, fontWeight: '500',
  },
  progressTrack: {
    width: '100%', height: 4, borderRadius: 2,
    backgroundColor: 'rgba(126, 214, 255, 0.12)',
    overflow: 'hidden',
    marginBottom: 14,
  },
  progressBar: {
    position: 'absolute', top: 0, bottom: 0,
    width: '40%',
    backgroundColor: C.glow,
    borderRadius: 2,
  },
  stepLabel: {
    color: C.tx2, fontSize: 13, fontWeight: '500',
    textAlign: 'center', marginBottom: 32, minHeight: 18,
  },
  note: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8,
    backgroundColor: C.surf,
    borderWidth: 1, borderColor: C.bd2,
  },
  noteTxt: {color: C.tx2, fontSize: 12, fontWeight: '500'},

  cancelLink: {
    marginTop: 24, paddingVertical: 8, paddingHorizontal: 12,
  },
  cancelLinkTxt: {
    color: C.tx3, fontSize: 13, fontWeight: '500',
    textAlign: 'center', textDecorationLine: 'underline',
  },

  successCircle: {
    width: 110, height: 110, borderRadius: 55,
    backgroundColor: C.ok,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 28,
    shadowColor: C.ok, shadowOpacity: 0.4, shadowRadius: 20, shadowOffset: {width: 0, height: 0},
    elevation: 8,
  },
  statsCard: {
    width: '100%',
    backgroundColor: C.surf,
    borderRadius: 14, borderWidth: 1, borderColor: C.bd,
    paddingVertical: 18, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
    marginBottom: 16,
  },
  statRow: {alignItems: 'center', flex: 1},
  statNumber: {color: C.tx1, fontSize: 26, fontWeight: '800', letterSpacing: -0.5},
  statLabel: {color: C.tx3, fontSize: 11, marginTop: 2, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5},
  statDivider: {width: 1, height: 30, backgroundColor: C.bd2},
  skipNote: {
    color: C.tx3, fontSize: 12, lineHeight: 18, textAlign: 'center',
    marginBottom: 20, paddingHorizontal: 12,
  },

  errCircle: {
    width: 110, height: 110, borderRadius: 55,
    backgroundColor: C.err,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 28,
  },
  errHint: {
    color: C.tx3, fontSize: 13, lineHeight: 19,
    textAlign: 'center', marginBottom: 28,
  },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.glow,
    paddingVertical: 16, paddingHorizontal: 24,
    borderRadius: 12, marginTop: 8,
    minWidth: 240,
    shadowColor: C.glow, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: {width: 0, height: 4},
    elevation: 6,
  },
  primaryBtnTxt: {color: C.bg, fontWeight: '800', fontSize: 14, letterSpacing: 1.2},
});
