import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, TouchableOpacity,
  ScrollView, Linking, Platform,
} from 'react-native';
import {Alert} from '@utils/alert';
import Svg, {Path, Circle} from 'react-native-svg';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {scaleTextStyles} from '@utils/scaling';
import {vbgApi} from '@/services/api';
import LoadingView from '@components/LoadingView';
import {VBG} from './vbgUi';

interface Fix {lat: number; lng: number; recordedAt: string}

/** "x ago" for a recorded fix timestamp. */
function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) {return '';}
  const m = Math.floor(ms / 60000);
  if (m < 1) {return 'just now';}
  if (m < 60) {return `${m}m ago`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h ago`;}
  return `${Math.floor(h / 24)}d ago`;
}

/** HH:MM local time from an ISO stamp. */
function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '--:--';}
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Location History bottom sheet — lists the principal's recently recorded GPS
 * fixes from the encrypted telemetry stream (vbgApi.track → /vbg/track). Opened
 * from the Home "Location History" button. Read-only; has loading, empty and
 * error states so the button always does something sensible.
 */
export function LocationHistoryModal({visible, onClose}: {visible: boolean; onClose: () => void}) {
  const insets = useSafeAreaInsets();
  const [fixes, setFixes] = useState<Fix[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      // Last 24h of recorded positions.
      const res = await vbgApi.track(24 * 3600);
      // Newest first.
      const sorted = [...res.data.fixes].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
      setFixes(sorted);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (visible) { void load(); } }, [visible, load]);

  // Founder 2026-08-01 — tapping a recorded coordinate offers to open that
  // position in the maps app (same geo:/Apple-Maps URL shape as the
  // key-points "open in maps" path).
  const viewOnMap = (f: Fix) => {
    const label = encodeURIComponent(`Recorded ${clock(f.recordedAt)}`);
    const url = Platform.select({
      ios:     `http://maps.apple.com/?q=${label}&ll=${f.lat},${f.lng}`,
      android: `geo:${f.lat},${f.lng}?q=${f.lat},${f.lng}(${label})`,
    });
    Alert.alert(
      'View on map',
      `Open ${f.lat.toFixed(4)}, ${f.lng.toFixed(4)} (recorded ${clock(f.recordedAt)}) in your maps app?`,
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'View on Map', onPress: () => { if (url) {Linking.openURL(url).catch(() => {});} }},
      ],
    );
  };

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, {paddingBottom: insets.bottom + 18}]}>
        <View style={styles.grabber} />
        <View style={styles.head}>
          <View style={{flex: 1}}>
            <Text style={styles.title}>Location History</Text>
            <Text style={styles.sub}>Your recorded positions over the last 24 hours.</Text>
          </View>
          <TouchableOpacity style={styles.refreshBtn} activeOpacity={0.8} onPress={() => { void load(); }} disabled={loading}>
            <Svg width={15} height={15} viewBox="0 0 24 24"><Path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.6L4 16M4 20v-4h4" stroke={VBG.accentSoft} strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.center}>
            <LoadingView compact label="Loading history…" />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.errTitle}>Couldn’t load history</Text>
            <Text style={styles.errHint}>Check your connection and try again.</Text>
            <TouchableOpacity style={styles.retry} onPress={() => { void load(); }} activeOpacity={0.8}>
              <Text style={styles.retryText}>RETRY</Text>
            </TouchableOpacity>
          </View>
        ) : fixes.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.errTitle}>No history yet</Text>
            <Text style={styles.errHint}>Enable live monitoring on the Security Assessment screen to start recording your location trail.</Text>
          </View>
        ) : (
          <ScrollView style={{maxHeight: 380}} showsVerticalScrollIndicator={false}>
            {fixes.map((f, i) => (
              <TouchableOpacity
                key={`${f.recordedAt}-${i}`}
                style={styles.row}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={`View position recorded ${clock(f.recordedAt)} on the map`}
                onPress={() => viewOnMap(f)}>
                <View style={styles.timeline}>
                  <View style={[styles.dot, i === 0 && styles.dotLive]} />
                  {i < fixes.length - 1 ? <View style={styles.line} /> : null}
                </View>
                <View style={styles.rowBody}>
                  <View style={styles.rowTop}>
                    <Text style={styles.coords}>{f.lat.toFixed(4)}, {f.lng.toFixed(4)}</Text>
                    {i === 0 ? <View style={styles.liveTag}><Text style={styles.liveTagText}>LATEST</Text></View> : null}
                  </View>
                  <Text style={styles.meta}>{clock(f.recordedAt)} · {ago(f.recordedAt)}</Text>
                </View>
                <Svg width={14} height={14} viewBox="0 0 24 24" style={{marginTop: 2}}>
                  <Path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7Z" stroke={VBG.accentSoft} strokeWidth={1.5} fill="none" strokeLinejoin="round" />
                  <Circle cx={12} cy={9} r={2} stroke={VBG.accentSoft} strokeWidth={1.4} fill="none" />
                </Svg>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  backdrop: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)'},
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#0B0E14', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderWidth: 1, borderColor: VBG.hair2, paddingHorizontal: 20, paddingTop: 12,
  },
  grabber: {alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', marginBottom: 16},
  head: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 14},
  title: {fontSize: 18, fontWeight: '700', color: VBG.text, letterSpacing: -0.3},
  sub: {fontSize: 11.5, lineHeight: 16, color: VBG.textDim, marginTop: 4},
  refreshBtn: {width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.1)', borderWidth: 1, borderColor: VBG.accentGlow},

  center: {alignItems: 'center', paddingVertical: 34, gap: 8},
  errTitle: {color: VBG.text, fontSize: 13, fontWeight: '700'},
  errHint: {color: VBG.textMute, fontSize: 10.5, textAlign: 'center', paddingHorizontal: 24, lineHeight: 15},
  retry: {marginTop: 10, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: VBG.accent, backgroundColor: 'rgba(91,141,239,0.1)'},
  retryText: {color: VBG.accentSoft, fontSize: 9, fontWeight: '800', letterSpacing: 2},

  row: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 2},
  timeline: {alignItems: 'center', width: 14},
  dot: {width: 9, height: 9, borderRadius: 5, backgroundColor: VBG.textMute, marginTop: 4},
  dotLive: {backgroundColor: VBG.signal, shadowColor: VBG.signal, shadowOpacity: 0.9, shadowRadius: 5},
  line: {flex: 1, width: 1.5, minHeight: 22, backgroundColor: VBG.hair, marginTop: 2},
  rowBody: {flex: 1, paddingBottom: 14},
  rowTop: {flexDirection: 'row', alignItems: 'center', gap: 8},
  coords: {fontSize: 13, fontWeight: '600', color: VBG.text, letterSpacing: -0.1},
  liveTag: {paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5, backgroundColor: 'rgba(74,222,128,0.14)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)'},
  liveTagText: {fontSize: 7.5, fontWeight: '800', color: VBG.signal, letterSpacing: 0.8},
  meta: {fontSize: 10.5, color: VBG.textMute, marginTop: 2},
}));
