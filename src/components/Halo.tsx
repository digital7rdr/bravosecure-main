import React from 'react';
import {Animated, StyleSheet} from 'react-native';
import Svg, {Circle, Defs, RadialGradient, Stop} from 'react-native-svg';

interface Props {
  size: number;
  color: string;
  innerOpacity?: number;
  midOpacity?: number;
  style?: React.ComponentProps<typeof Animated.View>['style'];
}

// Soft radial pulse halo.
// Renders as a colour-at-centre / transparent-at-edge radial gradient inside
// an Animated.View, so scaling + opacity animations have no visible bounding
// rectangle even when the halo is rendered over a clipped parent.
export function Halo({
  size,
  color,
  innerOpacity = 0.5,
  midOpacity = 0.18,
  style,
}: Props) {
  // Each Halo needs a unique gradient id so multiple halos on one screen
  // don't collide inside React Native SVG's shared defs registry.
  const id = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <Animated.View
      pointerEvents="none"
      style={[{width: size, height: size}, styles.absCentre, style]}>
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
            <Stop offset="0%"  stopColor={color} stopOpacity={innerOpacity} />
            <Stop offset="55%" stopColor={color} stopOpacity={midOpacity} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  absCentre: {position: 'absolute'},
});
