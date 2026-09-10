import React from 'react';
import Svg, {Path, Defs, LinearGradient as SvgGradient, Stop} from 'react-native-svg';

/**
 * Bravo shield mark — crested B inside a platinum-cobalt shield.
 * Ported from the design handoff bundle. Accepts a size so it can
 * scale on the dashboard header (28px) and the messenger header (24px).
 */
export function BravoMark({size = 28}: {size?: number}) {
  const id = `bravoGrad-${size}`;
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Defs>
        <SvgGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#7FA8FF" />
          <Stop offset="1" stopColor="#2F5BE0" />
        </SvgGradient>
      </Defs>
      <Path
        d="M16 2L28 7v9c0 7-5 12-12 14C9 28 4 23 4 16V7L16 2Z"
        fill={`url(#${id})`}
        stroke="rgba(255,255,255,0.2)"
        strokeWidth={0.5}
      />
      <Path d="M11 11h6.5a3 3 0 0 1 1.5 5.5 3.2 3.2 0 0 1-1.5 6H11V11Z" fill="#fff" opacity={0.95} />
      <Path
        d="M13.5 13.5h3.5a1.2 1.2 0 0 1 0 2.5h-3.5v-2.5ZM13.5 18h4a1.3 1.3 0 0 1 0 2.5h-4V18Z"
        fill={`url(#${id})`}
      />
    </Svg>
  );
}
