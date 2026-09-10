/**
 * TrustBadgeRow (Step 18 / B3) — the agency trust signals shown to a client at the
 * "accepted" reveal: ★ rating, missions completed, and a verification badge. Composes
 * RatingStars + VerificationBadge. Wraps gracefully; scale-aware.
 */
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import RatingStars from './RatingStars';
import VerificationBadge from './VerificationBadge';
import {UI} from './tokens';
import {scaleTextStyles} from '@utils/scaling';

interface Props {
  rating?: number | null;
  jobsTotal?: number | null;
  verified?: boolean;
}

export default function TrustBadgeRow({rating, jobsTotal, verified}: Props) {
  return (
    <View style={s.row}>
      {typeof rating === 'number' && rating > 0 && <RatingStars value={rating} showvalue size={15} />}
      {typeof jobsTotal === 'number' && jobsTotal > 0 && (
        <View style={s.chip}>
          <Icon name="shield-check" size={13} color={UI.accentSoft} />
          <Text style={s.chipText}>{jobsTotal} {jobsTotal === 1 ? 'mission' : 'missions'}</Text>
        </View>
      )}
      {verified && <VerificationBadge state="verified" />}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  row: {flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap'},
  chip: {flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: UI.hair},
  chipText: {fontFamily: UI.fSemi, fontSize: 11.5, color: UI.textDim},
}));
