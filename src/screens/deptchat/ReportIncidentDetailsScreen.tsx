import React, {useEffect, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, StatusBar, TextInput,
  TouchableOpacity } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {launchCamera, launchImageLibrary, type Asset} from 'react-native-image-picker';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {AgentStackParamList} from '@navigation/types';
import {incidentApi} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {activeWorkspaceOrgParam} from '@store/activeWorkspace';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, useInDepartmentalShell} from './_obsidian';
import {INCIDENT_CATEGORY_META, severityColor, INCIDENT_SEVERITIES} from './incidentMeta';
import {getGeo, reverseGeocode} from './geo';
import {uploadAndSealEvidence, type EvidenceResult} from './incidentEvidence';
import {saveIncidentDraft, clearIncidentDraft, markIncidentSubmitted, type IncidentDraftMedia} from './incidentDraft';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
type Rt = RouteProp<AgentStackParamList, 'ReportIncidentDetails'>;

const MAX = 5000;
/** Item H — evidence caps. 5 attachments (each read whole into RAM at upload
 *  time — readUriBytes holds ~2.3x the file, so the cap IS the memory
 *  budget); 50 MB matches the server's ciphertext limit minus the v2
 *  overhead; 60 s for videos (durationLimit caps the camera; library picks
 *  are gated on asset.duration, which RNIP reports in SECONDS). */
const MAX_MEDIA = 5;
const MAX_BYTES = 50 * 1024 * 1024 - 49;
const MAX_VIDEO_SECONDS = 60;

// fromDraft marks rows restored from a saved draft: their cache URIs may have
// been purged by the OS since, so the row must not promise what the file may
// no longer deliver (edge review F4) — the copy hedges and the user can
// remove/re-pick before submitting.
type Media = IncidentDraftMedia & {fromDraft?: boolean};

export default function ReportIncidentDetailsScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad, overlap} = useKeyboardLayout();
  const navigation = useNavigation<Nav>();
  const inDepartmentalShell = useInDepartmentalShell();
  const {params} = useRoute<Rt>();
  const cat = INCIDENT_CATEGORY_META[params.category];
  const sevColor = severityColor(params.severity);
  const sevLabel = INCIDENT_SEVERITIES.find(s => s.key === params.severity)?.label ?? params.severity;

  const userId = useAuthStore(st => st.user?.id);
  // vs2 item 4 — drafts are per (user, ORG). Read at use time, not at
  // mount: the user can switch workspaces without this screen unmounting.
  const activeOrgId = activeWorkspaceOrgParam()?.orgId ?? null;
  const [description, setDescription] = useState(params.draft?.description ?? '');
  const [coords, setCoords] = useState<{lat: number; lng: number; label: string} | null>(null);
  // PDF p.12 — manual site entry when location permission is denied/unavailable.
  const [manualLabel, setManualLabel] = useState(params.draft?.manualLabel ?? '');
  const [manualOpen, setManualOpen] = useState(!!params.draft?.manualLabel);
  const [media, setMedia] = useState<Media[]>(
    (params.draft?.media ?? []).map(m => ({...m, fromDraft: true})));
  const [locBusy, setLocBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  // Item H — draft autosave (URIs only, never bytes; see incidentDraft.ts for
  // why this is a different confidentiality class from message drafts).
  // Debounced so typing doesn't hammer AsyncStorage; cleared ONLY after the
  // report is durable server-side.
  //
  // submittedRef: once the report POST succeeds, the draft is DEAD — a timer
  // armed by the last keystroke would otherwise fire during the (multi-second)
  // evidence loop and resurrect the cleared draft, whose "Resume draft?" card
  // then re-files an already-submitted report as a duplicate (critic,
  // 2026-08-08). The latch is checked inside the callback because clearing
  // the timer alone cannot stop edits made DURING the upload loop re-arming it.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submittedRef = useRef(false);
  useEffect(() => {
    if (draftTimer.current) {clearTimeout(draftTimer.current);}
    if (submittedRef.current) {return;}
    if (!description.trim() && media.length === 0 && !manualLabel.trim()) {return;}
    draftTimer.current = setTimeout(() => {
      if (submittedRef.current) {return;}
      void saveIncidentDraft(userId, activeOrgId, {
        category: params.category, severity: params.severity,
        description, media, manualLabel: manualLabel.trim() || undefined,
      });
    }, 800);
    return () => { if (draftTimer.current) {clearTimeout(draftTimer.current);} };
  }, [description, media, manualLabel, userId, params.category, params.severity]);

  /** Gate one picked asset; returns the reason it was dropped, or null. */
  const gateAsset = (a: Asset): 'no-uri' | 'too-big' | 'too-long' | null => {
    if (!a.uri) {return 'no-uri';}
    // fileSize (and duration — some pickers omit both, some OEMs ignore
    // durationLimit) is ADVISORY: a nullish value passes here and is caught by
    // uploadAndSealEvidence's post-read byteLength backstop ('too-big'), which
    // kills the wasted upload but not the read's RAM spike — stated trade-off.
    if (typeof a.fileSize === 'number' && a.fileSize > MAX_BYTES) {return 'too-big';}
    const isVideo = (a.type ?? '').startsWith('video/');
    if (isVideo && typeof a.duration === 'number' && a.duration > MAX_VIDEO_SECONDS) {return 'too-long';}
    return null;
  };

  const runPicker = async (src: 'camera-photo' | 'camera-video' | 'library') => {
    try {
      // Read by uri (NOT includeBase64): a multi-MB base64 string held in screen
      // state was enough to get the host activity reclaimed under memory pressure
      // on low-RAM devices, "refreshing" the in-progress report. We read the
      // file's bytes only at upload time (incidentEvidence → readUriBytes).
      const remaining = MAX_MEDIA - media.length;
      const res = src === 'camera-photo'
        ? await launchCamera({mediaType: 'photo', quality: 0.7, maxWidth: 1600, maxHeight: 1600, saveToPhotos: false})
        : src === 'camera-video'
          ? await launchCamera({mediaType: 'video', durationLimit: MAX_VIDEO_SECONDS, saveToPhotos: false})
          : await launchImageLibrary({mediaType: 'mixed', quality: 0.7, maxWidth: 1600, maxHeight: 1600, selectionLimit: remaining});
      if (res.didCancel) {return;}
      const assets = res.assets ?? [];
      let dropped = 0;
      const accepted: Media[] = [];
      for (const a of assets) {
        if (accepted.length >= remaining) {dropped += 1; continue;}
        if (gateAsset(a)) {dropped += 1; continue;}
        const mime = a.type ?? 'image/jpeg';
        accepted.push({uri: a.uri as string, mime, kind: mime.startsWith('video/') ? 'video' : 'image'});
      }
      if (accepted.length > 0) {setMedia(prev => [...prev, ...accepted].slice(0, MAX_MEDIA));}
      if (dropped > 0) {
        Alert.alert('Evidence',
          `${dropped} item(s) were not added — over the ${MAX_MEDIA}-attachment limit, larger than 50 MB, or longer than ${MAX_VIDEO_SECONDS} seconds.`);
      }
    } catch {
      Alert.alert('Evidence', 'Could not open the camera or library on this device.');
    }
  };

  const pickMedia = () => {
    // PDF p.12 — optional, and only where safe & lawful.
    Alert.alert('Evidence', 'Attach photos or video only where it is safe and lawful to do so.', [
      {text: 'Take photo', onPress: () => { void runPicker('camera-photo'); }},
      {text: 'Record video', onPress: () => { void runPicker('camera-video'); }},
      {text: 'Choose from library', onPress: () => { void runPicker('library'); }},
      {text: 'Cancel', style: 'cancel'},
    ]);
  };

  const captureLocation = async () => {
    if (locBusy) {return;}
    setLocBusy(true);
    try {
      const geo = await getGeo();
      if (geo) {
        // Reverse-geocode to a readable address so the manager sees a place,
        // not raw coordinates. Falls back to a generic label on a geocode miss.
        const label = await reverseGeocode(geo.lat, geo.lng);
        setCoords({lat: geo.lat, lng: geo.lng, label: label ?? 'Current location'});
        setManualOpen(false);
      } else {
        // PDF p.12 — offer the manual site fallback instead of a dead end.
        setManualOpen(true);
        Alert.alert('Location', 'Location was not shared. You can type the site manually, or submit without it.');
      }
    } finally {
      setLocBusy(false);
    }
  };

  const submit = async () => {
    // submittedRef also guards RE-entry: after a successful POST the screen
    // stays mounted through the seal loop / retry alert, and a second Submit
    // tap would file a duplicate report.
    if (busy || submittedRef.current) {return;}
    const text = description.trim();
    if (!text) {
      Alert.alert('Report Incident', 'Please add a short description of what happened.');
      return;
    }
    setBusy(true);
    try {
      const {data} = await incidentApi.submit({
        category: params.category,
        severity: params.severity,
        description: text,
        ...(coords
          ? {location_label: coords.label, location_lat: coords.lat, location_lng: coords.lng}
          : manualLabel.trim()
            ? {location_label: manualLabel.trim().slice(0, 120)}
            : {}),
      });
      // The report is DURABLE from here — the draft's job is done. The LATCH
      // and the pending timer die FIRST (a timer armed by the last keystroke
      // would otherwise fire mid-upload and resurrect the cleared draft, whose
      // resume card then re-files a duplicate — both reviewers, round 1), then
      // the draft is cleared, strictly AFTER the submit resolved (clearing
      // before it would eat the draft on a failed POST — the pinned RED
      // mutation).
      submittedRef.current = true;
      if (draftTimer.current) {clearTimeout(draftTimer.current); draftTimer.current = null;}
      await clearIncidentDraft(userId, activeOrgId);
      // Tell the (never-unmounted) category root to reset its picker — item 15.
      markIncidentSubmitted();
      const go = () => navigation.replace('IncidentSubmitted', {ref: data.ref, status: data.status, severity: data.severity});
      // Optional E2EE evidence (Step 10 + Item H). The report itself already
      // succeeded, so a failed/partial attach never blocks it. SEQUENTIAL on
      // purpose: each upload holds the whole file (~2.3x) in RAM
      // (readUriBytes), so parallel uploads would stack five of those. A
      // per-item catch means one bad file never aborts the rest. On partial
      // failure the recovery is IN PLACE — a Retry button over the same
      // incident id (the old copy promised "re-open the report and add them
      // again", an affordance no screen offers — critic, round 1).
      if (media.length > 0) {
        let pending = media;
        const sealBatch = async (): Promise<void> => {
          const failed: Media[] = [];
          for (const m of pending) {
            const ev: EvidenceResult = await uploadAndSealEvidence(data.id, m.uri, m.mime)
              .catch(() => ({attached: false, sealedFor: 0, reason: 'upload-failed' as const}));
            if (!(ev.attached && ev.sealedFor > 0)) {failed.push(m);}
          }
          if (failed.length > 0) {
            pending = failed;
            const secured = media.length - failed.length;
            Alert.alert(
              'Report submitted',
              `${secured} of ${media.length} attachment${media.length === 1 ? '' : 's'} were secured. The report itself is already filed — retry the rest now, or continue without them.`,
              [
                {text: 'Retry', onPress: () => { void sealBatch(); }},
                {text: 'Continue', style: 'cancel', onPress: go},
              ],
            );
            return;
          }
          go();
        };
        await sealBatch();
        return;
      }
      go();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Report Incident', msg ?? (e as Error).message ?? 'Could not submit. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Report Incident" onBack={() => navigation.goBack()} pill="STEP 2" />

      <View style={{flex: 1}}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}>

          {/* Selection summary */}
          <Card style={s.summary}>
            <View style={s.sumLeft}>
              <Icon name={cat.icon} size={20} color={OB.glow} />
              <Text style={s.sumText} numberOfLines={1}>{cat.label}</Text>
            </View>
            <View style={[s.sevChip, {backgroundColor: sevColor + '1A', borderColor: sevColor + '4D'}]}>
              <View style={[s.sevDot, {backgroundColor: sevColor}]} />
              <Text style={[s.sevChipText, {color: sevColor}]}>{sevLabel}</Text>
            </View>
          </Card>

          <View style={{marginTop: 20}}>
            <SectionLabel>WHAT HAPPENED</SectionLabel>
            <View style={s.inputWrap}>
              <TextInput
                style={s.input}
                value={description}
                onChangeText={t => setDescription(t.slice(0, MAX))}
                placeholder="Describe the incident — what, where, who was involved, and any action taken."
                placeholderTextColor={OB.textMute}
                multiline
                textAlignVertical="top"
              />
              <Text style={s.counter}>{description.length}/{MAX}</Text>
            </View>
          </View>

          <View style={{marginTop: 18}}>
            <SectionLabel>ATTACHMENTS · OPTIONAL</SectionLabel>
            <TouchableOpacity style={s.attach} activeOpacity={0.8} onPress={() => { void captureLocation(); }}>
              <Icon name={coords ? 'map-marker-check' : 'map-marker-plus-outline'} size={20} color={coords ? OB.signal : OB.accentSoft} />
              <View style={{flex: 1}}>
                <Text style={s.attachTitle}>{coords ? 'Location attached' : locBusy ? 'Getting location…' : 'Attach my location'}</Text>
                <Text style={s.attachSub} numberOfLines={1}>
                  {coords ? coords.label : 'Captured once, only when you tap'}
                </Text>
              </View>
              {coords ? <Icon name="check-circle" size={18} color={OB.signal} /> : null}
            </TouchableOpacity>

            {/* Manual site fallback (PDF p.12 "use current location / select site"). */}
            {!coords && !manualOpen ? (
              <Text style={s.manualLink} onPress={() => setManualOpen(true)}>
                Or enter the site manually
              </Text>
            ) : null}
            {!coords && manualOpen ? (
              <View style={s.manualWrap}>
                <Icon name="map-marker-outline" size={18} color={OB.accentSoft} />
                <TextInput
                  style={s.manualInput}
                  value={manualLabel}
                  onChangeText={t => setManualLabel(t.slice(0, 120))}
                  placeholder="Site / area (e.g. Main Gate, Warehouse B)"
                  placeholderTextColor={OB.textMute}
                />
              </View>
            ) : null}

            {/* Evidence (Step 10 + Item H) — up to 5 photos/videos, encrypted
                on submit + sealed so only the org's managers (and you) can
                open them; never posted to any channel. */}
            {media.map((m, i) => (
              <View key={`${m.uri}-${i}`}
                style={[s.attach, {borderColor: 'rgba(74,222,128,0.34)', backgroundColor: 'rgba(74,222,128,0.05)'}]}>
                <Icon name={m.kind === 'video' ? 'video-check-outline' : 'image-check-outline'} size={20} color={OB.signal} />
                <View style={{flex: 1}}>
                  <Text style={s.attachTitle}>{m.kind === 'video' ? 'Video attached' : 'Photo attached'}</Text>
                  <Text style={s.attachSub} numberOfLines={1}>
                    {m.fromDraft
                      ? 'From your saved draft — remove & re-pick if it fails to send'
                      : 'Encrypted on submit · managers can open it'}
                  </Text>
                </View>
                <TouchableOpacity
                  accessibilityRole="button" accessibilityLabel={`Remove ${m.kind}`}
                  onPress={() => setMedia(prev => prev.filter((_, j) => j !== i))}
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                  <Icon name="close-circle" size={18} color={OB.textMute} />
                </TouchableOpacity>
              </View>
            ))}
            {media.length < MAX_MEDIA && (
              <TouchableOpacity style={s.attach} activeOpacity={0.8} onPress={pickMedia}>
                <Icon name="camera-plus-outline" size={20} color={OB.accentSoft} />
                <View style={{flex: 1}}>
                  <Text style={s.attachTitle}>
                    {media.length === 0 ? 'Add photo or video evidence' : `Add more (${media.length} of ${MAX_MEDIA})`}
                  </Text>
                  <Text style={s.attachSub} numberOfLines={1}>Optional · encrypted, manager-only (only where safe & lawful)</Text>
                </View>
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      </View>

      {/* B-184 — the sticky footer is the bottom-most node, so it owns the
          keyboard inset. In the departmental shell (which pads the safe area
          itself) a closed keyboard pads a flat 12; open, bottomPad wins. */}
      <View style={[s.footer, {paddingBottom: inDepartmentalShell && overlap === 0 ? 12 : bottomPad(12)}]}>
        <PrimaryButton label="Submit Report" icon="send-check" busy={busy} onPress={() => { void submit(); }} />
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  summary: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 6},
  sumLeft: {flexDirection: 'row', alignItems: 'center', gap: 11, flex: 1, minWidth: 0},
  sumText: {flex: 1, color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  sevChip: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1},
  sevDot: {width: 8, height: 8, borderRadius: 4},
  sevChipText: {fontFamily: BravoFont.mono, fontSize: 9, fontWeight: '700', letterSpacing: 0.8},
  inputWrap: {
    borderRadius: 16, backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair2,
    padding: 14, minHeight: 150,
  },
  input: {flex: 1, color: OB.text, fontFamily: BravoFont.regular, fontSize: 14, lineHeight: 20, minHeight: 110},
  counter: {alignSelf: 'flex-end', color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9.5, marginTop: 6},
  attach: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, marginBottom: 10,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: OB.hair,
  },
  attachTitle: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 13.5},
  attachSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
  manualLink: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 11.5, paddingVertical: 8, paddingHorizontal: 4},
  manualWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10,
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
    backgroundColor: 'rgba(255,255,255,0.03)', paddingHorizontal: 14,
  },
  manualInput: {flex: 1, color: OB.text, fontFamily: BravoFont.regular, fontSize: 13, paddingVertical: 12},
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
}));
