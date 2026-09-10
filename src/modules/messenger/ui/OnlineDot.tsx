import React from 'react';
import {View, StyleSheet} from 'react-native';

/**
 * Tiny presence-state indicator — a colored dot in the bottom-right
 * corner of an avatar (or free-standing in a header). Color maps:
 *   online/active → green
 *   away          → amber
 *   offline       → hidden (returns null)
 *
 * The border color is passed in so the dot "pops" against whatever
 * background it sits on (avatar tile, chat header, etc).
 */
export type OnlineDotState = 'online' | 'active' | 'away' | 'offline';

interface Props {
  state:     OnlineDotState;
  /** pixel size; defaults to 10. */
  size?:     number;
  /** ring color so the dot reads against the surrounding surface. */
  ringColor?: string;
  /** Corner-pin to a parent with `position:relative` (the common case). */
  pinned?:   boolean;
}

export function OnlineDot({state, size = 10, ringColor = '#0A0E27', pinned = true}: Props) {
  if (state === 'offline') {return null;}
  const bg = state === 'away' ? '#F59E0B' : '#22C55E';
  const s = size;
  const dot = {
    width: s, height: s, borderRadius: s / 2,
    backgroundColor: bg,
    borderWidth: 2, borderColor: ringColor,
  };
  if (!pinned) {return <View style={dot} />;}
  return <View style={[styles.pin, {width: s, height: s, borderRadius: s / 2}, dot]} />;
}

const styles = StyleSheet.create({
  pin: {position: 'absolute', right: -1, bottom: -1},
});
