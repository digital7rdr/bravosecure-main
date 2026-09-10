/**
 * B-90 T-07 — booking-map warm-up ("preload like Uber").
 *
 * The location picker's WebView cold-loads mapbox-gl JS/CSS, the style
 * JSON and the first tiles from the network on every mount — the
 * dominant share of its time-to-ready. Mounting this invisible 1×1
 * WebView once per app session (from BookingHomeScreen, where booking
 * intent is likely) pre-populates the WebView's HTTP cache with those
 * responses, so the real picker boots warm.
 *
 * Deliberately conservative:
 *  - renders nothing when the Mapbox token is missing;
 *  - ONE attempt per app session, success or failure — no retries, no
 *    persistent map instance (the picker's B-77 recovery machinery
 *    assumes per-screen WebViews);
 *  - tears itself down on `ready`/`err` or a 25s cap to free the
 *    renderer process.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {Platform, View} from 'react-native';
import {mapHtmlSource} from '@/modules/maps/mapWebViewSource';
import {WebView, type WebViewMessageEvent} from 'react-native-webview';
import {buildLocationPickerHtml} from './bravoLocationPickerMapHtml';
import {COVERAGE_ZONES} from './coverageZones';
import {MAPBOX_TOKEN, MAPBOX_TOKEN_MISSING} from '@/modules/maps/mapToken';

let attemptedThisSession = false;

export function MapPrewarm({countryCode = 'AE'}: {countryCode?: string}) {
  const [active, setActive] = useState(
    () => !attemptedThisSession && !MAPBOX_TOKEN_MISSING,
  );

  useEffect(() => {
    if (!active) {return undefined;}
    attemptedThisSession = true;
    const cap = setTimeout(() => setActive(false), 25_000);
    return () => clearTimeout(cap);
  }, [active]);

  const html = useMemo(() => {
    const zone = COVERAGE_ZONES.find(z => z.countryCode === countryCode) ?? COVERAGE_ZONES[0];
    return buildLocationPickerHtml({
      mapboxToken:  MAPBOX_TOKEN,
      initial:      {lat: zone?.lat ?? 25.2048, lng: zone?.lng ?? 55.2708},
      zones:        [],
      countryCode,
      initialStyle: 'dark',
    });
  }, [countryCode]);

  if (!active) {return null;}

  return (
    <View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      style={{position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden'}}>
      <WebView
        source={mapHtmlSource(html)}
        style={{width: 1, height: 1}}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="compatibility"
        originWhitelist={['*']}
        androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
        onMessage={(e: WebViewMessageEvent) => {
          try {
            const msg = JSON.parse(e.nativeEvent.data) as {type?: string};
            if (msg.type === 'ready' || msg.type === 'err') {setActive(false);}
          } catch { /* warm-up only — ignore */ }
        }}
        onError={() => setActive(false)}
        onRenderProcessGone={() => setActive(false)}
        onContentProcessDidTerminate={() => setActive(false)}
      />
    </View>
  );
}
