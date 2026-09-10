import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import LoadingView from '@components/LoadingView';

/**
 * B-77 — shared "map failed to load" overlay with a RETRY affordance, so a
 * failed WebView map never leaves a silent blank rectangle. Presentational
 * only; the owning screen drives visibility from `useMapReload().status`.
 *
 * B-89 MG-04 — `variant="misconfigured"`: the build was packaged without a
 * Mapbox token, so retrying would remount the same doomed HTML; say so
 * honestly and hide RETRY. MG-11 rider: `variant="loading"` gives the three
 * screens that had no load state a visible skeleton instead of a dark void.
 */
export function MapFailedOverlay({onRetry, variant = 'connection'}: {
  onRetry: () => void;
  variant?: 'connection' | 'misconfigured' | 'loading';
}) {
  if (variant === 'loading') {
    return (
      <View style={styles.overlay} pointerEvents="none">
        <LoadingView compact />
        <Text style={styles.text}>Loading map…</Text>
      </View>
    );
  }
  if (variant === 'misconfigured') {
    return (
      <View style={styles.overlay}>
        <Icon name="map-marker-off-outline" size={24} color="#F5C76B" />
        <Text style={styles.text}>
          Map unavailable — this build was packaged without a map key. Update the app.
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.overlay}>
      <Icon name="map-marker-off-outline" size={24} color="#F5C76B" />
      <Text style={styles.text}>Map failed to load — check your connection.</Text>
      <TouchableOpacity style={styles.retry} onPress={onRetry} activeOpacity={0.85}>
        <Text style={styles.retryText}>RETRY</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#07090D',
    padding: 20,
  },
  text: {
    color: 'rgba(229,233,242,0.72)',
    fontSize: 13,
    textAlign: 'center',
    fontFamily: 'Manrope_500Medium',
  },
  retry: {
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(91,141,239,0.5)',
    backgroundColor: 'rgba(91,141,239,0.12)',
  },
  retryText: {
    color: '#A9C5FF',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontFamily: 'Manrope_700Bold',
  },
});
