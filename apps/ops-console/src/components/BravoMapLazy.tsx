'use client';

/**
 * Code-split entry for BravoMap. mapbox-gl is ~1.5 MB minified and CJS
 * (webpack can't tree-shake inside it), so the only way to keep it out
 * of a route's first-load JS is to split it into its own chunk and pull
 * it in after hydration. Import BravoMap from HERE in pages; import
 * `./BravoMap` directly only for types (erased at compile time).
 */

import dynamic from 'next/dynamic';

export type {BravoMarker, BravoRouteOption, BravoMapStyleId} from './BravoMap';

export const BravoMap = dynamic(
  () => import('./BravoMap').then(m => m.BravoMap),
  {
    // mapbox-gl touches window/WebGL at module scope — never SSR it.
    ssr: false,
    loading: () => (
      <div
        style={{
          width: '100%', height: '100%', minHeight: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--surf-2)', border: '1px solid var(--bd-2)',
          borderRadius: 8, color: 'var(--tx-3)',
          fontFamily: 'JetBrains Mono', fontSize: 10.5, letterSpacing: 0.6,
        }}>
        LOADING MAP…
      </div>
    ),
  },
);
