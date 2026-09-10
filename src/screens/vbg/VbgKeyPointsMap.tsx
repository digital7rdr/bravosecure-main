import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {View, StyleSheet, TouchableOpacity, type ViewStyle} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {WebView, type WebViewMessageEvent} from 'react-native-webview';
import type {VbgKeyPoint} from '@/services/api';
import {buildVbgKeyPointsMapHtml} from './vbgKeyPointsMapHtml';
import {useMapReload} from '@/modules/maps/useMapReload';
import {MapFailedOverlay} from '@/modules/maps/MapFailedOverlay';
import {MAPBOX_TOKEN, MAPBOX_TOKEN_MISSING} from '@/modules/maps/mapToken';
import {mapHtmlSource} from '@/modules/maps/mapWebViewSource';

/**
 * Real interactive Mapbox-GL map (in a WebView) for the Key Points screen.
 * Centers on the principal and pins every key point at its true coordinate.
 * Tapping a pin calls `onTapPoint` so the screen can open it in maps.
 */
export function VbgKeyPointsMap({
  centre,
  points,
  radiusKm,
  onTapPoint,
  onExpand,
  style,
  plain,
  topInset,
}: {
  centre: {lat: number; lng: number} | null;
  points: VbgKeyPoint[];
  /** When set, draws a radius circle (km) centered on `centre`. */
  radiusKm?: number;
  onTapPoint?: (p: VbgKeyPoint) => void;
  /** When set, shows a corner expand button (embedded cards → fullscreen map). */
  onExpand?: () => void;
  style?: ViewStyle;
  /** Plain embed (booking zone map): no HEATMAP chip, markers always shown. */
  plain?: boolean;
  /**
   * B-409 — dp of host chrome covering the TOP of the map. A host that renders
   * this full-bleed behind its own header (VBGMapScreen) must pass the header's
   * measured height, or the DARK/LIGHT segment and HEATMAP chip render under
   * the status bar and are unusable. Omit for embedded cards with clear space.
   */
  topInset?: number;
}) {
  const webRef = useRef<WebView>(null);
  const map = useMapReload();
  const html = useMemo(() => buildVbgKeyPointsMapHtml(MAPBOX_TOKEN, {heatChip: !plain}), [plain]);
  const webSource = useMemo(() => mapHtmlSource(html), [html]);

  const push = useCallback(() => {
    if (!centre) {return;}
    const payload = JSON.stringify({centre, points, radiusKm: radiusKm ?? 0});
    webRef.current?.injectJavaScript(
      `try { var d=${payload}; window.updateKeyPoints(d.centre, d.points, d.radiusKm); } catch(e){} true;`,
    );
  }, [centre, points, radiusKm]);

  // Why: the WebView is NOT remounted between analysis runs, so load/ready
  // alone left the first run's data on screen forever — re-push on any change.
  useEffect(() => { push(); }, [push]);

  // B-409 — push the host's top chrome height in as a CSS var rather than
  // rebuilding the html (which would change `source` and remount the map).
  const pushInset = useCallback(() => {
    if (!Number.isFinite(topInset)) {return;}
    webRef.current?.injectJavaScript(
      `try{document.documentElement.style.setProperty('--chrome-top','${Math.round(topInset as number)}px');}catch(e){} true;`,
    );
  }, [topInset]);
  useEffect(() => { pushInset(); }, [pushInset]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as {type?: string; point?: VbgKeyPoint; reason?: string};
      // B-409 — re-push the chrome inset on ready too: the effect above can
      // fire before the page exists, and a WebView remount resets the var.
      if (msg.type === 'ready') {map.onReady(); push(); pushInset();}
      if (msg.type === 'error') {
        // MG-11 — fast-fail ONLY on definitely-fatal boot errors (WebGL
        // init, token 401/403, gl-unsupported); recoverable pre-load tile
        // blips must not burn the auto-retry (review m-2).
        console.warn('[VbgKeyPointsMap] map error:', msg.reason);
        if (/401|403|unauthorized|forbidden|access token|gl-unsupported|WebGL/i.test(String(msg.reason ?? ''))) {
          map.onError();
        }
      }
      if (msg.type === 'gl-unsupported') {map.onError();}
      if (msg.type === 'tap' && msg.point && onTapPoint) {onTapPoint(msg.point);}
    } catch {
      /* ignore */
    }
  };

  // On load, force a resize (the map mounts in a scroll card whose height can
  // be 0 at first paint → blank tiles) then push the data.
  const onLoad = () => {
    webRef.current?.injectJavaScript('try{window.dispatchEvent(new Event("resize"));}catch(e){} true;');
    push();
  };

  // MG-04 — a build without a baked token can never load GL; mounting the
  // WebView would just loop the watchdog. Say so instead.
  if (MAPBOX_TOKEN_MISSING) {
    return (
      <View style={[styles.wrap, style]}>
        <MapFailedOverlay onRetry={() => {}} variant="misconfigured" />
      </View>
    );
  }

  return (
    <View style={[styles.wrap, style]}>
      <WebView
        key={`vbg-map-${map.reloadKey}`}
        ref={webRef}
        source={webSource}
        onMessage={onMessage}
        onLoadEnd={onLoad}
        style={styles.web}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="compatibility"
        originWhitelist={['*']}
        androidLayerType="hardware"
        scrollEnabled={false}
        bounces={false}
        onRenderProcessGone={map.retry}
        onContentProcessDidTerminate={map.retry}
      />
      {/* Corner button only — never an overlay across the canvas, so map
          gestures and pin taps keep working inside embedded cards. */}
      {onExpand ? (
        <TouchableOpacity
          style={styles.expandBtn}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Open fullscreen map"
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          onPress={onExpand}>
          <Svg width={12} height={12} viewBox="0 0 14 14">
            <Path d="M8.5 1h4.5v4.5M13 1L8 6M5.5 13H1V8.5M1 13l5-5" stroke="#F2F4F8" strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </TouchableOpacity>
      ) : null}
      {/* MG-11 rider — visible load state instead of a dark void. */}
      {map.status === 'loading' && <MapFailedOverlay onRetry={map.retry} variant="loading" />}
      {map.status === 'failed' && <MapFailedOverlay onRetry={map.retry} />}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {overflow: 'hidden', borderRadius: 18, backgroundColor: '#07090D', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)'},
  web: {flex: 1, backgroundColor: '#07090D'},
  // Top-left, mirroring the in-map chrome (style segment / heat chip sit top-right).
  expandBtn: {
    position: 'absolute', top: 10, left: 10, width: 28, height: 28,
    borderRadius: 9, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(7,12,22,0.85)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
});
