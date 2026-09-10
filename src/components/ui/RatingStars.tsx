/**
 * RatingStars (Step 18 / B3) — five-star rating in display OR input mode. Display: read-only
 * (supports halves). Input: tap a star to set `value` via `onChange`. Text-scale-aware; the
 * star row is symmetric so it reads correctly under RTL without reordering.
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {UI} from './tokens';
import {scaleTextStyles} from '@utils/scaling';

interface Props {
  value: number;          // 0..5 (halves allowed in display mode)
  onChange?: (v: number) => void;  // presence => input mode
  size?: number;
  showvalue?: boolean;    // append the numeric value (display mode)
}

export default function RatingStars({value, onChange, size = 16, showvalue = false}: Props) {
  const input = !!onChange;
  const stars = [1, 2, 3, 4, 5];
  return (
    <View style={s.row}>
      {stars.map(n => {
        const name = value >= n ? 'star' : value >= n - 0.5 ? 'star-half-full' : 'star-outline';
        const star = <Icon name={name} size={size} color={value >= n - 0.5 ? UI.amber : UI.textMute} />;
        return input ? (
          <TouchableOpacity key={n} onPress={() => onChange(n)} hitSlop={{top: 6, bottom: 6, left: 3, right: 3}} activeOpacity={0.7}>
            {star}
          </TouchableOpacity>
        ) : (
          <View key={n}>{star}</View>
        );
      })}
      {showvalue && value > 0 && <Text style={[s.value, {fontSize: size * 0.8}]}>{value.toFixed(1)}</Text>}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  row: {flexDirection: 'row', alignItems: 'center', gap: 2},
  value: {fontFamily: UI.fBold, color: UI.text, marginLeft: 5},
}));
