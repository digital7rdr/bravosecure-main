import React, {useCallback, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, StatusBar, TextInput, TouchableOpacity, Modal, Pressable,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, useFocusEffect, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useAuthStore} from '@store/authStore';
import type {AgentStackParamList} from '@navigation/types';
import {incidentApi, orgApi, type IncidentReportDto, type IncidentEventDto, type IncidentStatusDto, type RosterMember} from '@services/api';
import {OB, ObHeader, SectionLabel, Card} from './_obsidian';
import {INCIDENT_CATEGORY_META, INCIDENT_STATUS_META, INCIDENT_NEXT, severityColor} from './incidentMeta';
import {fmtTime} from './geo';
import {EvidenceSection} from './EvidenceSection';
import LoadingView from '@components/LoadingView';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
type Rt = RouteProp<AgentStackParamList, 'IncidentDetail'>;

export default function IncidentDetailScreen() {
  const insets = useSafeAreaInsets();
  const keyboardOverlap = useKeyboardOverlap();
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<Rt>();
  const [report, setReport] = useState<IncidentReportDto | null>(null);
  const [events, setEvents] = useState<IncidentEventDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  // Step 22 — assignee picker. Roster resolves assigned_to → a display name and
  // backs the "Assign owner" sheet.
  const myId = useAuthStore(s => s.user?.id);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const {data} = await incidentApi.detail(params.incidentId);
      setReport(data.report);
      setEvents(data.events);
      try {
        const r = await orgApi.listCpos();
        setRoster(r.data.filter(m => m.status === 'active'));
      } catch { /* name resolution is best-effort */ }
    } catch {
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [params.incidentId]);

  const nameFor = (uid: string | null): string | null => {
    if (!uid) {return null;}
    const m = roster.find(r => r.member_user_id === uid);
    return m?.display_name ?? m?.email ?? 'Assigned';
  };

  // NAV-17 (2026-08-26 audit) — the ref backs up the `busy` state check,
  // which needs a committed re-render and is stale for a whole mash burst.
  const busyRef = useRef(false);
  const doAssign = async (ownerId: string) => {
    setAssignOpen(false);
    if (busy || busyRef.current) {return;}
    busyRef.current = true;
    setBusy(true);
    try {
      await incidentApi.assign(params.incidentId, ownerId);
      await load();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Assign', msg ?? 'Could not assign. Please try again.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const move = (to: IncidentStatusDto) => {
    Alert.alert('Update status', `Move this incident to "${INCIDENT_STATUS_META[to].label}"?`, [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Update', onPress: () => { void doMove(to); }},
    ]);
  };

  const doMove = async (to: IncidentStatusDto) => {
    if (busy) {return;}
    setBusy(true);
    try {
      await incidentApi.updateStatus(params.incidentId, to);
      await load();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Update status', msg?.startsWith('invalid_incident_transition')
        ? 'Only an organisation admin can reopen a closed incident.'
        : msg ?? 'Could not update. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const sendNote = async () => {
    const text = note.trim();
    if (!text || busy) {return;}
    setBusy(true);
    try {
      await incidentApi.addNote(params.incidentId, text, true);
      setNote('');
      await load();
    } catch {
      Alert.alert('Note', 'Could not add the note. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={[s.root, {paddingTop: insets.top}]}>
        <AmbientBg bg={OB.bg} />
        <ObHeader title="Incident" onBack={() => navigation.goBack()} pill={params.ref ?? undefined} />
        <LoadingView compact label="Loading incident…" />
      </View>
    );
  }

  if (!report) {
    return (
      <View style={[s.root, {paddingTop: insets.top}]}>
        <AmbientBg bg={OB.bg} />
        <ObHeader title="Incident" onBack={() => navigation.goBack()} />
        <Text style={[s.empty, {marginTop: 48}]}>This incident could not be loaded.</Text>
      </View>
    );
  }

  const cat = INCIDENT_CATEGORY_META[report.category];
  const sevC = severityColor(report.severity);
  const st = INCIDENT_STATUS_META[report.status];
  const next = INCIDENT_NEXT[report.status] ?? [];
  // Only managers can work the incident queue, so only managers are assignable
  // owners (+ "Assign to me"). nameFor() still resolves ANY assigned_to id.
  const assignableManagers = roster.filter(m => m.member_role === 'manager' && m.member_user_id !== myId);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Incident" onBack={() => navigation.goBack()} pill={report.ref ?? undefined} />

      {/* B-184 — one keyboard rule: the body shrinks by the true IME overlap. */}
      <View style={{flex: 1, paddingBottom: keyboardOverlap}}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 24}}>

          {/* Record */}
          <Card style={{gap: 12, marginTop: 6}}>
            <View style={s.recTop}>
              <View style={[s.sevBar, {backgroundColor: sevC}]} />
              <Icon name={cat?.icon ?? 'alert-octagon-outline'} size={20} color={OB.glow} />
              <Text style={s.recCat} numberOfLines={1}>{cat?.label ?? report.category}</Text>
            </View>
            <View style={s.chipRow}>
              <View style={[s.tag, {backgroundColor: sevC + '1A', borderColor: sevC + '4D'}]}>
                <Text style={[s.tagText, {color: sevC}]}>{report.severity.toUpperCase()}</Text>
              </View>
              <View style={[s.tag, {backgroundColor: st.color + '1A', borderColor: st.color + '4D'}]}>
                <Text style={[s.tagText, {color: st.color}]}>{st.label}</Text>
              </View>
              <Text style={s.recTime}>{fmtTime(report.created_at)}</Text>
            </View>
            <Text style={s.desc}>{report.description}</Text>
            {report.location_label ? (
              <View style={s.locRow}>
                <Icon name="map-marker" size={14} color={OB.accentSoft} />
                <Text style={s.locText}>
                  {report.location_label}
                  {report.location_lat !== null ? ` · ${report.location_lat.toFixed(4)}, ${report.location_lng?.toFixed(4)}` : ''}
                </Text>
              </View>
            ) : null}
          </Card>

          {/* Encrypted photo evidence (Step 10) — decrypts on this device. */}
          <EvidenceSection incidentId={params.incidentId} />

          {/* Status workflow */}
          {next.length > 0 && (
            <View style={{marginTop: 20}}>
              <SectionLabel>UPDATE STATUS</SectionLabel>
              <View style={s.nextRow}>
                {next.map(to => (
                  <TouchableOpacity key={to} style={s.nextBtn} activeOpacity={0.85} disabled={busy} onPress={() => move(to)}>
                    <Text style={s.nextText}>{INCIDENT_STATUS_META[to].label}</Text>
                    <Icon name="arrow-right" size={14} color={OB.accentSoft} />
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Assignee (Step 22) */}
          <View style={{marginTop: 20}}>
            <SectionLabel>ASSIGNED TO</SectionLabel>
            <Card style={s.assignCard} onPress={() => setAssignOpen(true)}>
              <Icon name={report.assigned_to ? 'account-check' : 'account-question-outline'} size={18} color={report.assigned_to ? OB.signal : OB.textMute} />
              <Text style={s.assignName} numberOfLines={1}>{nameFor(report.assigned_to) ?? 'Unassigned'}</Text>
              <Text style={s.assignAction}>{report.assigned_to ? 'Reassign' : 'Assign'}</Text>
              <Icon name="chevron-right" size={16} color={OB.textMute} />
            </Card>
          </View>

          {/* Timeline */}
          <View style={{marginTop: 20}}>
            <SectionLabel>TIMELINE</SectionLabel>
            <View style={{gap: 10}}>
              {events.map(ev => (
                <Card key={ev.id} style={s.evt}>
                  <View style={s.evtTop}>
                    <Icon
                      name={ev.to_status ? 'swap-horizontal' : 'note-text-outline'}
                      size={15}
                      color={ev.note_internal ? OB.amber : OB.accentSoft}
                    />
                    <Text style={s.evtTitle}>
                      {ev.to_status
                        ? `${ev.from_status ? INCIDENT_STATUS_META[ev.from_status as IncidentStatusDto]?.label ?? ev.from_status : 'New'} → ${INCIDENT_STATUS_META[ev.to_status as IncidentStatusDto]?.label ?? ev.to_status}`
                        : 'Note'}
                    </Text>
                    {ev.note_internal && (
                      <View style={s.intBadge}><Text style={s.intText}>INTERNAL</Text></View>
                    )}
                    <Text style={s.evtTime}>{fmtTime(ev.created_at)}</Text>
                  </View>
                  {ev.note ? <Text style={s.evtNote}>{ev.note}</Text> : null}
                </Card>
              ))}
            </View>
          </View>

          {/* Add internal note */}
          <View style={{marginTop: 20}}>
            <SectionLabel>ADD INTERNAL NOTE</SectionLabel>
            <View style={s.noteWrap}>
              <TextInput
                style={s.noteInput}
                value={note}
                onChangeText={t => setNote(t.slice(0, 2000))}
                placeholder="Visible to managers only…"
                placeholderTextColor={OB.textMute}
                multiline
                textAlignVertical="top"
              />
              <TouchableOpacity style={[s.send, (!note.trim() || busy) && {opacity: 0.5}]} disabled={!note.trim() || busy} onPress={() => { void sendNote(); }}>
                <Icon name="send" size={16} color="#FFF" />
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </View>

      {/* Assignee picker (Step 22) — owner = the assigning manager or another manager
          (managers are the only ones who can work the queue). */}
      <Modal transparent visible={assignOpen} animationType="fade" onRequestClose={() => setAssignOpen(false)}>
        <Pressable style={s.modalBackdrop} onPress={() => setAssignOpen(false)}>
          <Pressable style={s.modalCard} onPress={() => {}}>
            <Text style={s.modalTitle}>Assign owner</Text>
            <ScrollView style={{maxHeight: 380}} showsVerticalScrollIndicator={false}>
              {myId ? (
                <TouchableOpacity style={s.pickRow} activeOpacity={0.8} onPress={() => { void doAssign(myId); }}>
                  <Icon name="account-arrow-left-outline" size={17} color={OB.accentSoft} />
                  <Text style={[s.pickName, {color: OB.accentSoft}]}>Assign to me</Text>
                </TouchableOpacity>
              ) : null}
              {assignableManagers.map(m => (
                <TouchableOpacity key={m.member_user_id} style={s.pickRow} activeOpacity={0.8} onPress={() => { void doAssign(m.member_user_id); }}>
                  <Icon name="account-tie" size={17} color={OB.textMute} />
                  <Text style={s.pickName} numberOfLines={1}>{m.display_name ?? m.email ?? 'Manager'}</Text>
                  {report.assigned_to === m.member_user_id ? <Icon name="check" size={16} color={OB.signal} /> : null}
                </TouchableOpacity>
              ))}
              {assignableManagers.length === 0 ? <Text style={s.empty}>No other managers — assign it to yourself.</Text> : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  recTop: {flexDirection: 'row', alignItems: 'center', gap: 10},
  sevBar: {width: 3, height: 20, borderRadius: 2},
  recCat: {flex: 1, color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 16},
  chipRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  tag: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1},
  tagText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8},
  recTime: {flex: 1, textAlign: 'right', color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 10.5},
  desc: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 13.5, lineHeight: 20},
  locRow: {flexDirection: 'row', alignItems: 'center', gap: 7},
  locText: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 11},
  nextRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 9},
  nextBtn: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, height: 44, borderRadius: 12, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)'},
  nextText: {color: OB.accentSoft, fontFamily: BravoFont.bold, fontSize: 13},
  evt: {gap: 6, paddingVertical: 12},
  evtTop: {flexDirection: 'row', alignItems: 'center', gap: 8},
  evtTitle: {flex: 1, color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 12.5},
  intBadge: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: 'rgba(226,200,147,0.14)', borderWidth: 1, borderColor: 'rgba(226,200,147,0.4)'},
  intText: {color: OB.amber, fontFamily: BravoFont.mono, fontSize: 7.5, fontWeight: '700', letterSpacing: 0.6},
  evtTime: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 10},
  evtNote: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, lineHeight: 18, marginLeft: 23},
  assignCard: {flexDirection: 'row', alignItems: 'center', gap: 11},
  assignName: {flex: 1, color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 13.5},
  assignAction: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 12},
  modalBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end'},
  modalCard: {backgroundColor: '#10141C', padding: 18, paddingBottom: 30, gap: 6, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderTopColor: OB.hair2},
  modalTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 16, marginBottom: 6, paddingHorizontal: 2},
  pickRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: OB.hair},
  pickName: {flex: 1, color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 14},
  noteWrap: {flexDirection: 'row', alignItems: 'flex-end', gap: 10},
  noteInput: {flex: 1, minHeight: 56, maxHeight: 120, color: OB.text, fontFamily: BravoFont.regular, fontSize: 13.5, borderRadius: 14, backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair2, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12},
  send: {width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: OB.accent},
}));
