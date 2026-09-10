import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, Linking} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {useNavigation} from '@react-navigation/native';
import {vbgApi, type VbgThreat} from '@/services/api';
import LoadingView from '@components/LoadingView';
import {scaleTextStyles} from '@utils/scaling';
import {ShareNewsSheet, type ShareableNews} from '@/modules/news/ShareNewsSheet';
import {useVbgLocation} from './useVbgLocation';
import {
  VBG, VbgScreen, VbgCard, SectionLabel, RiskBadge, Chip, IconButton, ShareIcon,
  type RiskLevel,
} from './vbgUi';
import {VbgFooter} from './VbgFooter';
import {goBackOnce} from '@navigation/tapGuard';

type FilterKey = 'all' | 'critical' | 'caution' | 'information';
const FILTERS: {label: string; key: FilterKey}[] = [
  {label: 'All', key: 'all'},
  {label: 'Critical', key: 'critical'},
  {label: 'Caution', key: 'caution'},
  {label: 'Information', key: 'information'},
];

const LEVEL_FOR: Record<VbgThreat['severity'], RiskLevel> = {
  critical: 'critical', caution: 'caution', information: 'info',
};

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) {return '';}
  const m = Math.floor(ms / 60000);
  if (m < 1) {return 'now';}
  if (m < 60) {return `${m}m ago`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h ago`;}
  return `${Math.floor(h / 24)}d ago`;
}

export default function VBGOSINTScreen() {
  const navigation = useNavigation();
  const {fix, ready} = useVbgLocation();
  const [filter, setFilter] = useState<FilterKey>('all');
  const [data, setData] = useState<{region: string; threats: VbgThreat[]; counts: {critical: number; caution: number; information: number}} | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Founder 2026-08-08 — VBG news joins the 2026-08-05 share-to-Bravo rule:
  // every news link shareable to internal chats/groups, never the OS sheet.
  const [shareItem, setShareItem] = useState<ShareableNews | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await vbgApi.threats(fix ?? {});
      setData({region: res.data.region, threats: res.data.threats, counts: res.data.counts});
    } catch {
      setError('Threat feed unreachable');
    } finally {
      setLoading(false);
    }
  }, [fix]);

  // Wait for the one-shot GPS attempt to settle before the first fetch so
  // the region is resolved from the device fix when available.
  useEffect(() => { if (ready) { void load(); } }, [ready, load]);

  const shown = useMemo(
    () => (data?.threats ?? []).filter(t => filter === 'all' || t.severity === filter),
    [data, filter],
  );

  return (
    <VbgScreen footer={<VbgFooter />}>
      <View style={styles.header}>
        <IconButton onPress={() => goBackOnce(navigation)}>
          <Svg width={9} height={15} viewBox="0 0 9 15"><Path d="M8 1L1.5 7.5 8 14" stroke={VBG.text} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
        </IconButton>
        <SectionLabel color={VBG.text} style={{fontSize: 12, letterSpacing: 2}}>OSINT Threat Feed</SectionLabel>
      </View>

      <View style={styles.body}>
        <Text style={styles.intro}>
          Live open-source intelligence for{data?.region ? <Text style={{color: VBG.accentSoft, fontWeight: '600'}}> {data.region}</Text> : ' your area'} — situational awareness and threat updates.
        </Text>

        {/* banners — region counts + the rolling-window indicator (B-91 M2
            R6: the server enforces the 72h cutoff at query level; this label
            makes the time scope obvious per spec p.20). */}
        <View style={styles.badgeRow}>
          <RiskBadge level="critical">{data?.counts.critical ?? 0} Active Alerts</RiskBadge>
          <RiskBadge level="elevated">{data?.region ?? 'Region'} · {(data?.counts.critical ?? 0) >= 3 ? 'Elevated' : 'Monitored'}</RiskBadge>
          <View style={styles.windowChip}>
            <Text style={styles.windowChipText}>LAST 72 HOURS</Text>
          </View>
        </View>

        {/* filter chips */}
        <View style={styles.chips}>
          {FILTERS.map(f => (
            <Chip key={f.key} active={filter === f.key} onPress={() => setFilter(f.key)}>{f.label}</Chip>
          ))}
        </View>

        {loading ? (
          <View style={styles.center}>
            <LoadingView compact label="Scanning region…" />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.errTitle}>Feed unreachable</Text>
            <Text style={styles.errHint}>{error}</Text>
            <TouchableOpacity style={styles.retry} onPress={() => { void load(); }} activeOpacity={0.8}>
              <Text style={styles.retryText}>RETRY</Text>
            </TouchableOpacity>
          </View>
        ) : shown.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.errTitle}>No relevant updates in the last 72 hours</Text>
            <Text style={styles.errHint}>No {filter === 'all' ? '' : `${filter} `}items for {data?.region ?? 'this region'} in the rolling window.</Text>
            <TouchableOpacity style={styles.retry} onPress={() => { void load(); }} activeOpacity={0.8}>
              <Text style={styles.retryText}>REFRESH</Text>
            </TouchableOpacity>
          </View>
        ) : (
          shown.map((t, i) => (
            <TouchableOpacity key={`${t.url}-${i}`} activeOpacity={t.url ? 0.85 : 1} disabled={!t.url}
              onPress={() => { if (t.url) {Linking.openURL(t.url).catch(() => {});} }}>
              <VbgCard rail={t.severity === 'critical' ? '#FF5D5D' : t.severity === 'caution' ? VBG.amber : VBG.accent} pad={14}>
                <View style={styles.threatTop}>
                  <RiskBadge level={LEVEL_FOR[t.severity]} small>{t.severity}</RiskBadge>
                  <Text style={styles.threatTime}>{ago(t.seenAt)}</Text>
                </View>
                <Text style={styles.threatTitle}>{t.title}</Text>
                <View style={styles.threatFoot}>
                  <Text style={styles.threatLoc}>{t.theme.toUpperCase()}</Text>
                  <View style={styles.footDot} />
                  <Text style={styles.threatSrc} numberOfLines={1}>{t.source}</Text>
                  {t.url ? (
                    <TouchableOpacity
                      onPress={() => setShareItem({title: t.title, url: t.url, source: t.source})}
                      hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
                      accessibilityRole="button"
                      accessibilityLabel={`Share: ${t.title}`}
                      style={styles.shareBtn}>
                      <ShareIcon />
                    </TouchableOpacity>
                  ) : null}
                </View>
              </VbgCard>
            </TouchableOpacity>
          ))
        )}
      </View>

      <ShareNewsSheet item={shareItem} onClose={() => setShareItem(null)} />
    </VbgScreen>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingTop: 4, paddingBottom: 16},
  body: {paddingHorizontal: 18, gap: 13},
  intro: {fontSize: 12.5, lineHeight: 18, color: VBG.textDim, letterSpacing: -0.05},
  badgeRow: {flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center'},
  windowChip: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: 99, borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)', backgroundColor: 'rgba(91,141,239,0.1)'},
  windowChipText: {color: VBG.accentSoft, fontSize: 8.5, fontWeight: '800', letterSpacing: 1.5},
  chips: {flexDirection: 'row', gap: 7, flexWrap: 'wrap'},

  center: {alignItems: 'center', paddingVertical: 36, gap: 8},
  errTitle: {color: VBG.text, fontSize: 13, fontWeight: '700'},
  errHint: {color: VBG.textMute, fontSize: 10, textAlign: 'center', paddingHorizontal: 24, lineHeight: 15},
  retry: {marginTop: 8, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: VBG.accent, backgroundColor: 'rgba(91,141,239,0.1)'},
  retryText: {color: VBG.accentSoft, fontSize: 9, fontWeight: '800', letterSpacing: 2},

  threatTop: {flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 9},
  threatTime: {fontSize: 9.5, color: VBG.textMute, letterSpacing: 0.4},
  threatTitle: {fontSize: 15, fontWeight: '700', color: VBG.text, letterSpacing: -0.2, lineHeight: 20},
  threatFoot: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 11, paddingTop: 10, borderTopWidth: 1, borderTopColor: VBG.hair},
  threatLoc: {fontSize: 9.5, color: VBG.textMute, letterSpacing: 0.5, fontWeight: '600'},
  footDot: {width: 5, height: 5, borderRadius: 3, backgroundColor: VBG.textMute},
  threatSrc: {fontSize: 9.5, color: VBG.textFaint, flexShrink: 1},
  shareBtn: {marginLeft: 'auto', paddingLeft: 7},
}));
