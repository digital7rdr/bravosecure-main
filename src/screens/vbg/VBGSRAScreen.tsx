import React, {useCallback, useEffect, useState} from 'react';
import {View, Text, StyleSheet, type DimensionValue} from 'react-native';
import Svg, {Path, Circle} from 'react-native-svg';
import {useNavigation} from '@react-navigation/native';
import {vbgApi, type VbgSraSnapshot} from '@/services/api';
import LoadingView from '@components/LoadingView';
import {scaleTextStyles} from '@utils/scaling';
import {useVbgLocation} from './useVbgLocation';
import {
  VBG, VbgScreen, VbgCard, SectionLabel, RiskBadge, PillButton, IconButton,
  type RiskLevel,
} from './vbgUi';
import {VbgFooter} from './VbgFooter';
import {goBackOnce} from '@navigation/tapGuard';

const SCORE_COLOR = (lvl: VbgSraSnapshot['level']): string =>
  lvl === 'CRITICAL' ? '#FF5D5D' : lvl === 'HIGH' ? '#FF7A5C' : lvl === 'MEDIUM' ? VBG.amber : VBG.signal;

export default function VBGSRAScreen() {
  const navigation = useNavigation();
  const {fix, ready} = useVbgLocation();
  const [sra, setSra] = useState<VbgSraSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const [enrolling, setEnrolling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    // Audit L-6 — the button reflects the SERVER enrollment state, not a
    // local flag that resets on remount.
    void vbgApi.monitoringStatus()
      .then(r => setEnrolled(r.data.enrolled))
      .catch(() => {});
    try {
      const res = await vbgApi.sra(fix ?? {});
      setSra(res.data);
    } catch {
      setSra(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [fix]);

  useEffect(() => { if (ready) { void load(); } }, [ready, load]);

  const handleEnable = async () => {
    if (enrolled || enrolling) {return;}
    setEnrolling(true);
    try {
      const res = await vbgApi.enrollMonitoring({intervalMin: 60, ...(fix ?? {})});
      // Persist the one-time per-device telemetry key so the 3s ping loop
      // can encrypt fixes (BE-7.1).
      if (res.data.telemetryKeyB64) {
        const {storeTelemetryKey} = await import('@/modules/vbg/telemetryCrypto');
        await storeTelemetryKey(res.data.telemetryKeyB64);
        // Start the app-wide telemetry loop right away (audit H-3) — no
        // dashboard visit needed for monitoring to begin.
        const {ensureVbgTelemetry} = await import('@/services/vbgTelemetry');
        void ensureVbgTelemetry();
      }
      setEnrolled(true);
    } catch {
      /* leave the button enabled to retry; toast layer surfaces failures */
    } finally {
      setEnrolling(false);
    }
  };

  const score = sra?.risk_score ?? 0;

  return (
    <VbgScreen footer={<VbgFooter />}>
      <View style={styles.header}>
        <IconButton onPress={() => goBackOnce(navigation)}>
          <Svg width={9} height={15} viewBox="0 0 9 15"><Path d="M8 1L1.5 7.5 8 14" stroke={VBG.text} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
        </IconButton>
        <SectionLabel color={VBG.text} style={{fontSize: 12, letterSpacing: 2}}>Security Risk Assessment</SectionLabel>
      </View>

      {loading ? (
        <View style={styles.loading}>
          <LoadingView compact label="Assessing your area…" />
        </View>
      ) : error && !sra ? (
        <View style={styles.loading}>
          <Text style={styles.errTitle}>Assessment unavailable</Text>
          <Text style={styles.errHint}>We couldn’t reach the assessment service. Check your connection and try again.</Text>
          <PillButton variant="primary" style={{marginTop: 12, paddingHorizontal: 22}} onPress={() => { void load(); }}>
            <Text style={styles.retryText}>RETRY</Text>
          </PillButton>
        </View>
      ) : (
      <View style={styles.body}>
        {/* Executive summary + risk meter */}
        <VbgCard rail={SCORE_COLOR(sra?.level ?? 'LOW')} pad={15}>
          <SectionLabel style={{marginBottom: 11}}>Executive Summary · {sra?.region ?? 'Your Area'}</SectionLabel>
          <Text style={styles.summary}>{sra?.summary ?? 'Assessment unavailable for your area.'}</Text>
          <View style={styles.scoreHead}>
            <Text style={styles.scoreLabel}>Risk Score</Text>
            <Text style={styles.scoreVal}>{score}<Text style={styles.scoreOf}>/100</Text></Text>
          </View>
          <View style={styles.scoreTrack}>
            <View style={[styles.scoreFill, {width: `${score}%` as DimensionValue, backgroundColor: SCORE_COLOR(sra?.level ?? 'LOW')}]} />
          </View>
        </VbgCard>

        {/* Potential risks */}
        <View>
          <SectionLabel style={{marginLeft: 2, marginBottom: 10}}>Potential Risks In {sra?.region ?? 'Your Area'}</SectionLabel>
          <VbgCard pad={4} radius={16}>
            {(sra?.risks ?? []).length === 0 ? (
              <View style={styles.emptyRow}><Text style={styles.emptyRowText}>No notable risks for your area right now.</Text></View>
            ) : (sra?.risks ?? []).map((r, i, arr) => (
              <View key={r.name} style={[styles.riskRow, i < arr.length - 1 && styles.riskBorder]}>
                <View style={styles.riskLeft}>
                  <View style={[styles.riskDot, {backgroundColor: dotFor(r.level), shadowColor: dotFor(r.level)}]} />
                  <Text style={styles.riskName}>{r.name}</Text>
                </View>
                <RiskBadge level={r.level as RiskLevel} small>{r.level}</RiskBadge>
              </View>
            ))}
          </VbgCard>
        </View>

        {/* Recommendations */}
        <View>
          <SectionLabel style={{marginLeft: 2, marginBottom: 10}}>Recommendations</SectionLabel>
          <VbgCard pad={15}>
            <View style={{gap: 14}}>
              {(sra?.recommendations ?? []).length === 0 ? (
                <Text style={styles.emptyRowText}>No specific recommendations — maintain routine awareness.</Text>
              ) : (sra?.recommendations ?? []).map(rec => (
                <View key={rec} style={styles.recRow}>
                  <Svg width={16} height={16} viewBox="0 0 20 20" style={{marginTop: 1}}>
                    <Circle cx={10} cy={10} r={8.5} stroke="rgba(91,141,239,0.4)" strokeWidth={1.3} fill="rgba(91,141,239,0.1)" />
                    <Path d="M6.5 10.2l2.3 2.3 4.5-4.8" stroke="#A9C5FF" strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </Svg>
                  <Text style={styles.recText}>{rec}</Text>
                </View>
              ))}
            </View>
          </VbgCard>
        </View>

        {/* Biometric monitoring */}
        <VbgCard rail={VBG.indigo} pad={15}>
          <View style={styles.bioHead}>
            <FaceScanIcon />
            <SectionLabel color="#C4B5FD">Activate Biometric Monitoring</SectionLabel>
          </View>
          <Text style={styles.bioDesc}>
            Enable hourly biometric face scans. If <Text style={{color: VBG.text, fontWeight: '600'}}>3 scans are missed</Text>:
          </Text>
          <View style={{gap: 7, marginBottom: 14}}>
            <EscRow n="1">Alert sent to Bravo Control System in-message.</EscRow>
            <EscRow n="2">If no response in 60 min, Bravo Control System will call.</EscRow>
            <EscRow n="3">If still missed, Live Action Protocol activated — reaction deployed.</EscRow>
          </View>
          <PillButton variant="primary" full height={46} onPress={() => { void handleEnable(); }}>
            <FaceScanIcon mini />
            <Text style={styles.bioBtnText}>
              {enrolled ? 'FACE SCAN MONITORING ACTIVE' : enrolling ? 'ENABLING…' : 'ENABLE FACE SCAN MONITORING'}
            </Text>
          </PillButton>
        </VbgCard>
      </View>
      )}
    </VbgScreen>
  );
}

function dotFor(level: RiskLevel): string {
  return level === 'high' || level === 'critical' ? '#FF5D5D'
    : level === 'medium' || level === 'elevated' || level === 'caution' ? VBG.amber : VBG.signal;
}

function EscRow({n, children}: {n: string; children: React.ReactNode}) {
  return (
    <View style={styles.escRow}>
      <View style={styles.escNum}><Text style={styles.escNumText} numberOfLines={1}>{n}</Text></View>
      <Text style={styles.escText}>{children}</Text>
    </View>
  );
}

function FaceScanIcon({mini}: {mini?: boolean}) {
  const s = mini ? 15 : 20;
  const c = mini ? '#fff' : '#C4B5FD';
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" stroke={c} strokeWidth={1.6} strokeLinecap="round" />
      <Circle cx={9.5} cy={11} r={0.9} fill={c} />
      <Circle cx={14.5} cy={11} r={0.9} fill={c} />
      <Path d="M9.5 14.5c.7.8 1.5 1.2 2.5 1.2s1.8-.4 2.5-1.2" stroke={c} strokeWidth={1.4} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingTop: 4, paddingBottom: 16},
  loading: {alignItems: 'center', paddingVertical: 60, gap: 10, paddingHorizontal: 28},
  errTitle: {color: VBG.text, fontSize: 14, fontWeight: '700'},
  errHint: {color: VBG.textMute, fontSize: 11, textAlign: 'center', lineHeight: 16},
  retryText: {color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 2},
  emptyRow: {paddingVertical: 14, paddingHorizontal: 12},
  emptyRowText: {color: VBG.textMute, fontSize: 11.5, lineHeight: 16},
  body: {paddingHorizontal: 18, gap: 13},

  summary: {fontSize: 13, lineHeight: 19, color: VBG.textDim, letterSpacing: -0.1},
  summaryHi: {color: '#FF8B8B', fontWeight: '600'},
  scoreHead: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 15, marginBottom: 7},
  scoreLabel: {fontSize: 9.5, color: VBG.textMute, letterSpacing: 1.4, textTransform: 'uppercase'},
  scoreVal: {fontSize: 16, fontWeight: '700', color: VBG.text},
  scoreOf: {fontSize: 11, color: VBG.textMute, fontWeight: '500'},
  scoreTrack: {height: 8, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden'},
  scoreFill: {height: '100%', borderRadius: 999, backgroundColor: VBG.amber},

  riskRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 13},
  riskBorder: {borderBottomWidth: 1, borderBottomColor: VBG.hair},
  riskLeft: {flexDirection: 'row', alignItems: 'center', gap: 11},
  riskDot: {width: 8, height: 8, borderRadius: 4, shadowOpacity: 0.8, shadowRadius: 5, shadowOffset: {width: 0, height: 0}},
  riskName: {fontSize: 13, fontWeight: '500', color: VBG.text, letterSpacing: -0.2},

  recRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 10},
  recText: {fontSize: 12.5, lineHeight: 17, color: VBG.textDim, flex: 1, letterSpacing: -0.05},

  bioHead: {flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 11},
  bioDesc: {fontSize: 12, lineHeight: 17, color: VBG.textDim, marginBottom: 11},
  escRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 9},
  escNum: {minWidth: 16, minHeight: 16, borderRadius: 8, marginTop: 1, backgroundColor: 'rgba(167,139,250,0.15)', borderWidth: 1, borderColor: 'rgba(167,139,250,0.35)', alignItems: 'center', justifyContent: 'center'},
  escNumText: {fontSize: 8.5, fontWeight: '700', color: '#C4B5FD'},
  escText: {fontSize: 11.5, lineHeight: 16, color: VBG.textDim, flex: 1},
  bioBtnText: {fontSize: 11, fontWeight: '700', letterSpacing: 1, color: '#fff'},
}));
