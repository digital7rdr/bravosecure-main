import React from 'react';
import {Text, StyleSheet} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {OB} from './_obsidian';

/**
 * THE unread badge. One component, because three had already drifted.
 *
 * `ChannelRow` drew it as a `LinearGradient`; the organisation drill-in row
 * reused that same StyleSheet entry on a plain `View` and therefore rendered a
 * bare white numeral with NO fill — the style deliberately carries no
 * `backgroundColor` because the gradient was supplying it — and no shadow
 * either, since a transparent view casts none on iOS and Android derives its
 * elevation outline from the background. Next to a filled pill in the same
 * list that reads as a rendering fault. The tree screen then grew a third
 * version at a different size and radius.
 *
 * The count clamps at 99+; a four-digit pill would push the row's name column
 * off a 320dp screen.
 */
export function UnreadPill({count}: {count: number}) {
  if (count <= 0) {return null;}
  return (
    <LinearGradient
      colors={['#6E9BF5', OB.accentDeep]}
      start={{x: 0, y: 0}}
      end={{x: 0, y: 1}}
      style={s.pill}>
      <Text style={s.pillText}>{count > 99 ? '99+' : String(count)}</Text>
    </LinearGradient>
  );
}

const s = StyleSheet.create({
  pill: {
    minWidth: 24, minHeight: 24, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: OB.accent, shadowOffset: {width: 0, height: 3}, shadowOpacity: 0.5, shadowRadius: 10, elevation: 4,
  },
  ...scaleTextStyles({
    pillText: {color: '#FFF', fontFamily: BravoFont.extraBold, fontSize: 12},
  }),
});
