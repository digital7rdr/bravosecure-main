/**
 * B-88 — the obsidian/cobalt dialog that replaces the native Android
 * AlertDialog for every `Alert.alert` call (see `@utils/alert`).
 *
 * Rendered ONCE in App.tsx. Uses a transparent RN <Modal> so it stacks
 * ABOVE any other open Modal on Android (attach sheets, viewers) — the
 * same layering the native dialog had. Hardware back / backdrop tap
 * dismiss only when the request is cancelable (RN Android semantics).
 *
 * Design system: obsidian #07090D family / cobalt #5B8DEF, 8pt grid,
 * Manrope, one primary action (variant mapping in resolveAlertLayout).
 */
import React from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, ScrollView,
  useWindowDimensions,
} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {
  currentAlert,
  dismissCurrentAlert,
  pressAlertButton,
  resolveAlertLayout,
  subscribeAlerts,
  type AlertButtonVariant,
} from '@utils/alert';

const T = {
  text:      '#F2F4F8',
  textDim:   'rgba(229,233,242,0.72)',
  hair2:     'rgba(255,255,255,0.09)',
  glassFill: 'rgba(255,255,255,0.04)',
  accent:    '#5B8DEF',
  onAccent:  '#A9C5FF',
  danger:    '#F87171',
} as const;
const CARD_GRADIENT   = ['#131A28', '#0C111B'] as const;
const FILL_GRADIENT   = ['#4C86F0', '#2F5BE0'] as const;

export function BravoAlertHost() {
  const request = React.useSyncExternalStore(subscribeAlerts, currentAlert);
  const {width, height} = useWindowDimensions();

  // B-647 — the <Modal> is mounted ONCE and driven by `visible`; it is never
  // conditionally rendered. On Fabric an Android Modal owns its own SURFACE, so
  // returning null and re-mounting it on the next alert starts and stops a
  // surface every single time. That churn is the documented source of
  // `addViewAt: failed to insert view [N] into parent [N+2]` /
  // "The specified child already has a parent" — three identical hard crashes on
  // the founder's Pixel 6a (2026-08-23 23:13, 23:35, 2026-08-24 12:22). This host
  // sits in App.tsx, so it is the one Modal that can churn on ANY screen.
  const {axis, items} = resolveAlertLayout(request?.buttons ?? []);
  const destructive = !!request?.buttons.some(b => b.style === 'destructive');
  const cancelable = request?.options?.cancelable !== false;

  return (
    <Modal
      visible={!!request}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={dismissCurrentAlert}>
      {!request ? null : (
      <Pressable
        style={styles.backdrop}
        onPress={cancelable ? dismissCurrentAlert : undefined}
        accessibilityLabel={cancelable ? 'Dismiss alert' : undefined}>
        <Pressable style={{width: Math.min(340, width - 48)}}>
          <LinearGradient
            colors={CARD_GRADIENT}
            start={{x: 0, y: 0}} end={{x: 0, y: 1}}
            style={styles.card}
            accessibilityRole="alert">
            <View style={[styles.medallion, destructive ? styles.medallionDanger : styles.medallionInfo]}>
              <Icon
                name={destructive ? 'alert-circle-outline' : 'shield-alert-outline'}
                size={22}
                color={destructive ? T.danger : T.accent}
              />
            </View>
            {!!request.title && (
              <Text style={styles.title} numberOfLines={4}>{request.title}</Text>
            )}
            {!!request.message && (
              <ScrollView
                style={{maxHeight: Math.round(height * 0.38)}}
                showsVerticalScrollIndicator={false}
                bounces={false}>
                <Text style={styles.message}>{request.message}</Text>
              </ScrollView>
            )}
            <View style={[styles.buttonZone, axis === 'row' ? styles.buttonRow : styles.buttonColumn]}>
              {items.map(({button, variant}, i) => (
                <Pressable
                  key={`${request.id}:${i}`}
                  onPress={() => pressAlertButton(request.id, button)}
                  accessibilityRole="button"
                  accessibilityLabel={button.text ?? 'OK'}
                  style={({pressed}) => [
                    styles.button,
                    axis === 'row' && styles.buttonFlex,
                    variantStyle(variant),
                    pressed && styles.buttonPressed,
                  ]}>
                  {variant === 'primary' && (
                    <LinearGradient
                      colors={FILL_GRADIENT}
                      start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                      pointerEvents="none"
                      style={[StyleSheet.absoluteFill, styles.buttonFill]}
                    />
                  )}
                  <Text
                    style={[styles.buttonText, variantTextStyle(variant)]}
                    numberOfLines={2}>
                    {button.text ?? 'OK'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </LinearGradient>
        </Pressable>
      </Pressable>
      )}
    </Modal>
  );
}

function variantStyle(v: AlertButtonVariant) {
  switch (v) {
    case 'primary':     return styles.buttonPrimary;
    case 'destructive': return styles.buttonDestructive;
    case 'cancel':      return styles.buttonCancel;
    default:            return styles.buttonSecondary;
  }
}

function variantTextStyle(v: AlertButtonVariant) {
  switch (v) {
    case 'primary':     return styles.buttonTextPrimary;
    case 'destructive': return styles.buttonTextDestructive;
    case 'cancel':      return styles.buttonTextCancel;
    default:            return styles.buttonTextSecondary;
  }
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(4,6,10,0.72)',
    padding: 24,
  },
  card: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: T.hair2,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 20,
    alignItems: 'center',
  },
  medallion: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
    marginBottom: 12,
  },
  medallionInfo:   {backgroundColor: 'rgba(91,141,239,0.12)', borderColor: 'rgba(91,141,239,0.30)'},
  medallionDanger: {backgroundColor: 'rgba(248,113,113,0.12)', borderColor: 'rgba(248,113,113,0.35)'},
  title: {
    color: T.text,
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 8,
  },
  message: {
    color: T.textDim,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  buttonZone: {alignSelf: 'stretch', marginTop: 20},
  buttonRow: {flexDirection: 'row', gap: 10},
  buttonColumn: {gap: 10},
  buttonFlex: {flex: 1},
  button: {
    minHeight: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    overflow: 'hidden',
  },
  buttonFill: {borderRadius: 14},
  buttonPressed: {transform: [{scale: 0.97}]},
  buttonPrimary: {},
  buttonSecondary: {borderWidth: 1, borderColor: 'rgba(91,141,239,0.30)', backgroundColor: 'rgba(91,141,239,0.10)'},
  buttonCancel: {borderWidth: 1, borderColor: T.hair2, backgroundColor: T.glassFill},
  buttonDestructive: {borderWidth: 1, borderColor: 'rgba(239,68,68,0.40)', backgroundColor: 'rgba(239,68,68,0.14)'},
  buttonText: {fontSize: 13, fontWeight: '800', letterSpacing: 0.2, textAlign: 'center'},
  buttonTextPrimary: {color: '#FFFFFF'},
  buttonTextSecondary: {color: T.onAccent},
  buttonTextCancel: {color: T.textDim},
  buttonTextDestructive: {color: T.danger},
});
