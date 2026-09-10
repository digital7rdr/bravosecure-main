import React from 'react';
import {View, StyleSheet} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import {Bravo} from '@/theme/bravo';

/**
 * Full-screen atmospheric background — deep obsidian base + a cool
 * cobalt glow at the top of the viewport and a softer reinforcing
 * glow below the fold. Matches the `AmbientBg` from the Claude Design
 * handoff bundle. Renders in a single absolute-positioned layer so
 * screens can stack their content on top without worrying about
 * z-ordering.
 *
 * `variant="alert"` switches the top glow to a muted red — reserved
 * for screens that want to signal something's wrong (incoming SOS,
 * security alert). Default is the platinum-cobalt tone.
 */
export function AmbientBg({variant = 'default', bg}: {variant?: 'default' | 'alert'; bg?: string}) {
  const topGlow = variant === 'alert'
    ? ['rgba(255,93,93,0.08)', 'rgba(255,93,93,0)']
    : ['rgba(91,141,239,0.09)', 'rgba(91,141,239,0)'];
  // `bg` overrides the base fill — Command Home passes obsidian (#07090D)
  // to match its design tokens; other screens default to the app-wide
  // Command Navy. The cobalt glow layers stay identical either way.
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, {backgroundColor: bg ?? Bravo.bg}]} />
      {/* Top radial glow — 500×400 ellipse centered above the fold. */}
      <LinearGradient
        colors={topGlow as [string, string]}
        start={{x: 0.5, y: 0}}
        end={{x: 0.5, y: 1}}
        style={styles.topGlow}
      />
      {/* Bottom reinforcing glow — keeps the lower half from reading flat. */}
      <LinearGradient
        colors={['rgba(47,91,224,0.06)', 'rgba(47,91,224,0)']}
        start={{x: 0.5, y: 1}}
        end={{x: 0.5, y: 0}}
        style={styles.bottomGlow}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  topGlow: {
    position: 'absolute',
    top: -120, left: '10%', right: '10%', height: 400,
    borderRadius: 500,
  },
  bottomGlow: {
    position: 'absolute',
    bottom: -200, left: -60, right: -60, height: 400,
    borderRadius: 500,
  },
});
