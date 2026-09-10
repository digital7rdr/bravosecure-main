/**
 * Provider · Compliance (BUILD_RUNBOOK Step 15) — the agency submits its licence + insurance
 * (per region, with an expiry); an admin verifies before the agency is dispatch-eligible.
 * Shows each doc's state (Pending / Verified / Rejected / Expired) + days-to-expiry + any
 * admin reject reason. Obsidian + platinum-cobalt theme, matching OrgRosterScreen.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  StatusBar, RefreshControl, ActivityIndicator } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {complianceApi, agentApi, type ComplianceDocDto} from '@services/api';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', accentDeep: '#2F5BE0',
  amber: '#F5C76B', signal: '#4ADE80', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

// Canonical region codes (incl. ZA per the 2026-06-25 decision) — must match the
// auth-service allow-list (common/regions.ts) so an SP can't pick an un-rankable region.
const REGIONS = ['AE', 'SA', 'BD', 'GB', 'ZA'] as const;
const DOC_TYPES = [
  {key: 'licence' as const, label: 'Licence'},
  {key: 'insurance' as const, label: 'Insurance'},
];

function stateTint(state: ComplianceDocDto['state']): {fg: string; bg: string; bd: string} {
  if (state === 'VERIFIED') {return {fg: D.signal, bg: 'rgba(74,222,128,0.10)', bd: 'rgba(74,222,128,0.32)'};}
  if (state === 'REJECTED' || state === 'EXPIRED') {return {fg: D.alert, bg: 'rgba(255,93,93,0.10)', bd: 'rgba(255,93,93,0.30)'};}
  return {fg: D.amber, bg: 'rgba(245,199,107,0.10)', bd: 'rgba(245,199,107,0.34)'};
}
function daysToExpiry(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export default function OrgComplianceScreen() {
  const insets = useSafeAreaInsets();
  // B-84 / KB-16 — no keyboard handling existed. kb padding shrinks the
  // ScrollView so the native scroll-to-focused-field kicks in and the
  // reference input stays reachable above the IME.
  const keyboardOverlap = useKeyboardOverlap();
  const navigation = useNavigation<Nav>();
  const [docs, setDocs] = useState<ComplianceDocDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [docType, setDocType] = useState<'licence' | 'insurance'>('licence');
  const [region, setRegion] = useState<string>('AE');
  const [reference, setReference] = useState('');
  const [years, setYears] = useState(1);
  const [submitting, setSubmitting] = useState(false);

  // Bug 3 — operating region + DPA (the two dispatch-eligibility inputs with no other UI).
  // `region` (above) is the single source for BOTH the agency's region_code AND the licence/
  // insurance region, so they can never diverge (the eligibility fn matches them).
  const [dpaAccepted, setDpaAccepted] = useState(false);
  const [savedDpaAt, setSavedDpaAt] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const {data} = await complianceApi.listMine();
      setDocs(data);
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Failed to load compliance');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Hydrate the saved operating region + DPA so a returning agency sees its state.
  useEffect(() => {
    void (async () => {
      try {
        const {data} = await agentApi.getMe();
        if (data.agent.region_code) { setRegion(data.agent.region_code); }
        if (data.agent.dpa_accepted_at) { setDpaAccepted(true); setSavedDpaAt(data.agent.dpa_accepted_at); }
      } catch { /* fresh agency — keep defaults */ }
    })();
  }, []);

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const {data} = await agentApi.setAgencyProfile({region_code: region, dpa_accepted: dpaAccepted, dpa_version: 'v1'});
      setSavedDpaAt(data.dpa_accepted_at);
      Alert.alert('Saved', 'Operating region and data agreement recorded.');
    } catch (e: unknown) {
      Alert.alert('Save failed', (e as Error).message ?? 'Could not save');
    } finally {
      setSavingProfile(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const expires = new Date();
      expires.setFullYear(expires.getFullYear() + years);
      await complianceApi.submit({doc_type: docType, region_code: region, expires_at: expires.toISOString(), reference: reference.trim() || undefined});
      setReference('');
      await load();
      Alert.alert('Submitted', 'Your document is pending admin verification.');
    } catch (e: unknown) {
      Alert.alert('Submit failed', (e as Error).message ?? 'Could not submit');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top, paddingBottom: keyboardOverlap}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={22} color={D.text} />
        </TouchableOpacity>
        <View style={s.accentBar} />
        <Text style={s.headerTitle}>COMPLIANCE</Text>
      </View>

      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={D.accent} onRefresh={() => { setRefreshing(true); void load(); }} />}>

        {/* Bug 3 — operating region + DPA: the two dispatch-eligibility inputs with no other UI. */}
        <View style={s.card}>
          <Text style={s.cardLabel}>OPERATING REGION + DATA AGREEMENT</Text>
          <Text style={s.fieldLabel}>Region you operate in (your licence + dispatch must match this)</Text>
          <View style={s.rowWrap}>
            {REGIONS.map(r => (
              <TouchableOpacity key={r} onPress={() => setRegion(r)} style={[s.chip, region === r && s.chipOn]}>
                <Text style={[s.chipText, region === r && s.chipTextOn]}>{r}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity onPress={() => setDpaAccepted(v => !v)} style={s.dpaRow} activeOpacity={0.8}>
            <Icon name={dpaAccepted ? 'checkbox-marked' : 'checkbox-blank-outline'} size={22} color={dpaAccepted ? D.signal : D.textMute} />
            <Text style={s.dpaText}>{"I accept the Data Processing Agreement — my agency will receive clients' precise pickup and live location for dispatched jobs."}</Text>
          </TouchableOpacity>
          {savedDpaAt ? <Text style={s.docMeta}>Agreement accepted {new Date(savedDpaAt).toLocaleDateString()}</Text> : null}
          <TouchableOpacity activeOpacity={0.85} disabled={savingProfile} onPress={() => void saveProfile()} style={[s.submitBtn, savingProfile && {opacity: 0.6}]}>
            {savingProfile ? <ActivityIndicator color="#fff" /> : <Text style={s.submitText}>Save region + agreement</Text>}
          </TouchableOpacity>
        </View>

        {/* Add document */}
        <View style={s.card}>
          <Text style={s.cardLabel}>SUBMIT A DOCUMENT</Text>
          <View style={s.rowWrap}>
            {DOC_TYPES.map(t => (
              <TouchableOpacity key={t.key} onPress={() => setDocType(t.key)} style={[s.chip, docType === t.key && s.chipOn]}>
                <Text style={[s.chipText, docType === t.key && s.chipTextOn]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={s.fieldLabel}>Region: {region} · set in Operating Region above</Text>
          <Text style={s.fieldLabel}>Reference (cert no.)</Text>
          <TextInput value={reference} onChangeText={setReference} placeholder="e.g. SIA-12345"
            placeholderTextColor={D.textMute} style={s.input} autoCapitalize="characters" />
          <Text style={s.fieldLabel}>Valid for</Text>
          <View style={s.rowWrap}>
            {[1, 2, 3].map(y => (
              <TouchableOpacity key={y} onPress={() => setYears(y)} style={[s.chip, years === y && s.chipOn]}>
                <Text style={[s.chipText, years === y && s.chipTextOn]}>{y} yr</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity activeOpacity={0.85} disabled={submitting} onPress={() => void submit()} style={[s.submitBtn, submitting && {opacity: 0.6}]}>
            {submitting ? <ActivityIndicator color="#fff" /> : <Text style={s.submitText}>Submit for verification</Text>}
          </TouchableOpacity>
        </View>

        <Text style={s.sectionLabel}>YOUR DOCUMENTS</Text>
        {loading ? <LoadingView compact label="Loading documents…" />
          : error ? <Text style={s.error}>{error}</Text>
          : docs.length === 0 ? <Text style={s.empty}>No documents yet. Submit your licence + insurance to become dispatch-eligible.</Text>
          : docs.map(d => {
            const tint = stateTint(d.state);
            const dte = daysToExpiry(d.expires_at);
            return (
              <View key={d.id} style={s.docRow}>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.docType}>{d.doc_type.toUpperCase()} · {d.region_code}</Text>
                  <Text style={s.docMeta}>{d.reference ? `${d.reference} · ` : ''}{dte < 0 ? 'expired' : `${dte}d left`}{d.reject_reason ? ` · ${d.reject_reason}` : ''}</Text>
                </View>
                <View style={[s.statePill, {backgroundColor: tint.bg, borderColor: tint.bd}]}>
                  <Text style={[s.statePillText, {color: tint.fg}]}>{d.state}</Text>
                </View>
              </View>
            );
          })}
        <View style={{height: insets.bottom + 20}} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 20, paddingVertical: 14},
  backBtn: {width: 42, height: 42, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2, alignItems: 'center', justifyContent: 'center'},
  accentBar: {width: 3, height: 17, borderRadius: 2, backgroundColor: D.accent},
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 13, letterSpacing: 2.2, color: D.text},
  body: {paddingHorizontal: 20, paddingTop: 4, gap: 16},
  card: {borderRadius: 18, padding: 16, gap: 10, backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair2},
  cardLabel: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.5, color: D.textMute},
  fieldLabel: {fontFamily: D.fSemi, fontSize: 11, color: D.textDim, marginTop: 4},
  rowWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2},
  chipOn: {backgroundColor: 'rgba(91,141,239,0.12)', borderColor: 'rgba(91,141,239,0.4)'},
  chipText: {fontFamily: D.fSemi, fontSize: 13, color: D.textMute},
  chipTextOn: {color: D.accentSoft},
  input: {borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2, color: D.text, fontFamily: D.fSans, fontSize: 14},
  dpaRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 8},
  dpaText: {flex: 1, fontFamily: D.fSans, fontSize: 12, lineHeight: 17, color: D.textDim},
  submitBtn: {marginTop: 8, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: D.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  submitText: {fontFamily: D.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},
  sectionLabel: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.5, color: D.textMute, marginLeft: 2, marginTop: 4},
  error: {color: D.alert, fontSize: 12, textAlign: 'center', marginTop: 18, fontFamily: D.fSans},
  empty: {color: D.textDim, fontSize: 13, lineHeight: 19, fontFamily: D.fSans, marginTop: 4},
  docRow: {flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, padding: 14, backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair2},
  docType: {fontFamily: D.fBold, fontSize: 14, color: D.text, letterSpacing: -0.2},
  docMeta: {fontFamily: D.fSans, fontSize: 11.5, color: D.textMute, marginTop: 2},
  statePill: {paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1},
  statePillText: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 1},
}));
