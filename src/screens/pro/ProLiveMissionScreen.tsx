/**
 * Protection session — the customer's live screen (spec §5). Rebuilt from the
 * old wireframe. Handles the whole on-demand flow:
 *
 *   no live session → "Request Protection" (consent every session, rule 13) →
 *   permission gate (never bypass, edge G) → POST create → "Starting protection…"
 *   until the BACKEND confirms ACTIVE (edge N, no optimistic active state) →
 *   Protection Active (server duration) + CPO card + own-position map + truthful
 *   "last sent Xs ago" / "Connection lost — retrying" (edge E) + SOS + End.
 *
 * Streaming is owned by protectionLocationService (a singleton, survives
 * re-renders, stops only on end). The backend is the single source of truth for
 * session state; this screen never manufactures it.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, ActivityIndicator, TextInput, Platform,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {WebView} from 'react-native-webview';
import Geolocation from 'react-native-geolocation-service';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation} from '@react-navigation/native';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {useProPlanGate} from '@hooks/useProPlanGate';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {Alert} from '@utils/alert';
import {formatTime12h} from '@components/booking/time12h';
import {ensureLiveLocationAccess} from '@utils/locationPermission';
import {MAPBOX_TOKEN, MAPBOX_TOKEN_MISSING} from '@/modules/maps/mapToken';
import {mapHtmlSource} from '@/modules/maps/mapWebViewSource';
import {useSecureProStore} from '@store/secureProStore';
import {
  protectionApi, sosApi, type ProtectionSession, type ProtectionNote,
} from '@services/api';

const CUSTOMER_OPTIONS = ['All good', 'Please stay close', 'I feel unsafe', 'Call me', 'Change of plan'] as const;
import {protectionLocationService, type StreamStatus} from '@services/protectionLocationService';
import {useProtectionSessionRealtime} from './useProtectionSessionRealtime';
import {useProtectionReadiness} from '@hooks/useProtectionReadiness';
import ReadinessGate from '@components/protection/ReadinessGate';

const D = {
  bg: '#07090D', card: 'rgba(22,27,37,0.72)', text: '#F2F4F8',
  textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.06)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80', amber: '#F5C76B', danger: '#F87171',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold', fMono: 'monospace',
};

function selfMarkerHtml(lat: number, lng: number): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<link href="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.css" rel="stylesheet"/>
<script src="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.js"></script>
<style>body,html,#m{margin:0;height:100%;background:#07090D}</style></head>
<body><div id="m"></div><script>
mapboxgl.accessToken=${JSON.stringify(MAPBOX_TOKEN)};
var map=new mapboxgl.Map({container:'m',style:'mapbox://styles/mapbox/satellite-streets-v12',center:[${lng},${lat}],zoom:14,attributionControl:false});
var el=document.createElement('div');el.style.cssText='width:18px;height:18px;border-radius:50%;background:#5B8DEF;border:3px solid #fff;box-shadow:0 0 0 6px rgba(91,141,239,0.28)';
var m=new mapboxgl.Marker(el).setLngLat([${lng},${lat}]).addTo(map);
window.setCenter=function(la,ln){map.setCenter([ln,la]);m.setLngLat([ln,la]);};
</script></body></html>`;
}

type Phase = 'loading' | 'idle' | 'starting' | 'active' | 'error';

function agoLabel(ms: number | null): string {
  if (ms === null) {return 'never';}
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) {return `${s}s ago`;}
  return `${Math.floor(s / 60)}m ago`;
}

/** "09:41" — local wall clock of the user's own tap (not a server instant). */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  // 12-hour, like every other client-facing clock in the booking flow.
  return formatTime12h(d.getHours(), d.getMinutes());
}

export default function ProLiveMissionScreen() {
  useProPlanGate();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const {bottomPad} = useKeyboardLayout();
  const application = useSecureProStore(st => st.application);
  const applicationId = application?.id;

  const [phase, setPhase] = useState<Phase>('loading');
  const [session, setSession] = useState<ProtectionSession | null>(null);
  const [stream, setStream] = useState<StreamStatus>(protectionLocationService.getStatus());
  const [notes, setNotes] = useState<ProtectionNote[]>([]);
  const [comment, setComment] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [sendingNote, setSendingNote] = useState(false);
  const [noteFailed, setNoteFailed] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  // PDF-1 #4 — a request that landed at Ops but found no free officer
  // (no_cpo_assigned) has NO server session to render, so the proof it exists
  // lives here: local, per app session, cleared once a real session is adopted.
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  // Mission-start gate: this device's real capability, reported to the server,
  // re-checked automatically whenever we come back from Settings.
  const readiness = useProtectionReadiness(session?.id ?? null, 'customer');
  // Shown before the session goes live AND during it: a permission revoked
  // mid-mission must be surfaced immediately rather than silently degrading
  // into a stale trail (edge case 6).
  const gateBlocking = !readiness.checking
    && (readiness.missing.length > 0 || readiness.blockedBy.length > 0);
  const serverOffset = useRef(0);           // server_now − local at fetch
  // The screen's OWN position for the map (own coords — fine in component
  // state; never logged, never sent from here — the streamer owns the upload).
  const [mapFix, setMapFix] = useState<{lat: number; lng: number} | null>(null);
  const mapFixRef = useRef<{lat: number; lng: number} | null>(null);
  const mapReady = useRef(false);
  const webRef = useRef<WebView>(null);
  const busy = useRef(false);
  const noteKey = useRef<string | null>(null);
  // Stable identity — a fresh source object every render remounts the map.
  // `mapFix` is only re-set for the FIRST fix (later moves recenter via
  // injectJavaScript) and by the process-gone handlers, which deliberately hand
  // back a NEW object to force the remount that recovers a killed WebView.
  // baseUrl is what keeps GL's blob workers legal on iOS (see mapWebViewSource).
  const mapSource = useMemo(
    () => mapHtmlSource(selfMarkerHtml(mapFix?.lat ?? 0, mapFix?.lng ?? 0)),
    [mapFix],
  );
  // Bumped only to force a remount after iOS reclaims the content process.
  const [mapEpoch, setMapEpoch] = useState(0);

  // Server-truthful session status → drives phase + streaming start/stop.
  const applySession = useCallback((s: ProtectionSession | null, serverNow?: string) => {
    setSession(s);
    if (serverNow) {serverOffset.current = Date.parse(serverNow) - Date.now();}
    if (!s || s.status === 'COMPLETED' || s.status === 'ABORTED') {
      protectionLocationService.stop();
      setPhase('idle');
      return;
    }
    if (s.status === 'ACTIVE') {setPhase('active');}
    else {setPhase('starting');} // REQUESTED / ENDING
  }, []);

  const refresh = useCallback(async () => {
    try {
      const {data} = await protectionApi.current();
      applySession(data.session, data.server_now);
      // A live session on the server → make sure we are streaming to it + sync notes.
      if (data.session) {
        void protectionApi.notes(data.session.id).then(r => setNotes(r.data.notes)).catch(() => undefined);
        if (data.session.status === 'REQUESTED' || data.session.status === 'ACTIVE') {
          protectionLocationService.start(data.session.id);
        }
      }
    } catch (e) {
      const status = (e as {response?: {status?: number}}).response?.status;
      if (status === 404) {applySession(null);}
      else {setPhase(p => (p === 'loading' ? 'idle' : p));}
    }
  }, [applySession]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => protectionLocationService.subscribe(setStream), []);
  useProtectionSessionRealtime(session?.id, () => { void refresh(); });

  // A real session (created here or found on refresh) supersedes the local card.
  useEffect(() => {
    if (session && phase !== 'idle') {setRequestedAt(null);}
  }, [session, phase]);

  // The streamer surfaces the backend-confirmed status on each flush — flip to
  // Active the moment the server says so (edge N), and detect server-side end.
  useEffect(() => {
    if (!stream.serverStatus || !session) {return;}
    if (stream.serverStatus === 'ACTIVE' && phase === 'starting') {void refresh();}
    if (stream.serverStatus === 'COMPLETED' || stream.serverStatus === 'ABORTED') {void refresh();}
  }, [stream.serverStatus, session, phase, refresh]);

  // 1s ticker for the duration + "last sent" labels while live.
  useEffect(() => {
    if (phase !== 'active' && phase !== 'starting') {return;}
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const request = useCallback(() => {
    if (!applicationId) {return;}
    const cpo = session?.cpo_name;
    Alert.alert(
      'Share your live location?',
      `Your live location will be shared with your protection officer${cpo ? ` ${cpo}` : ''} for the duration of this session only. It stops the moment you end protection.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Start Protection', onPress: () => { void doStart(); }},
      ],
    );
  }, [applicationId, session?.cpo_name]);

  const doStart = useCallback(async () => {
    if (!applicationId || busy.current) {return;}
    busy.current = true;
    try {
      const grant = await ensureLiveLocationAccess({
        title: 'Location needed for protection',
        message: 'Your protection officer tracks you live during a protection session.',
      });
      if (grant === 'denied' || grant === 'blocked') {busy.current = false; return;}
      setPhase('starting');
      const {data} = await protectionApi.create(applicationId);
      applySession(data.session);
      protectionLocationService.start(data.session.id);
    } catch (e) {
      setPhase('idle');
      const code = (e as {response?: {status?: number; data?: {message?: string}}}).response;
      const msg = code?.data?.message;
      if (msg === 'no_cpo_assigned') {
        // Why: the server DOES notify the Bravo Control System (protection.service
        // emits the ops alert) then throws no_cpo_assigned — no officer is free
        // right now, but the request landed. Confirm it positively; only the
        // generic branch below is a real failure the user should retry.
        setRequestedAt(Date.now());
        Alert.alert(
          'Protection Requested',
          'Your protection request has been sent to the Bravo Control System. Our Ops team will assign a protection officer and confirm shortly.',
        );
      } else {
        Alert.alert(
          'Couldn\'t start protection',
          'We couldn\'t start protection. Please try again.',
        );
      }
    } finally {
      busy.current = false;
    }
  }, [applicationId, applySession]);

  const doEnd = useCallback(async () => {
    if (!session || busy.current) {return;}
    busy.current = true;
    try {
      const {data} = await protectionApi.end(session.id);
      applySession(data.session);
    } catch {
      Alert.alert('Couldn\'t end protection', 'Please try again.');
    } finally {
      busy.current = false;
    }
  }, [session, applySession]);

  const confirmEnd = useCallback(() => {
    if (!session) {return;}
    if (session.sos_active) {
      // §3 — an SOS stays live and is NOT resolved by ending the session.
      Alert.alert(
        'End protection while SOS is active?',
        'Your SOS alert will STAY ACTIVE and your officer + the Bravo Control System keep responding. Ending only stops location sharing. Type is not required here, but confirm you understand.',
        [
          {text: 'Keep protection on', style: 'cancel'},
          {text: 'End anyway', style: 'destructive', onPress: () => { void doEnd(); }},
        ],
      );
      return;
    }
    Alert.alert('End protection?', 'This stops sharing your live location with your officer.', [
      {text: 'Cancel', style: 'cancel'},
      {text: 'End Protection', style: 'destructive', onPress: () => { void doEnd(); }},
    ]);
  }, [session, doEnd]);

  const raiseSos = useCallback(() => {
    Alert.alert('Send SOS?', 'This alerts your protection officer and the Bravo Control System immediately.', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Send SOS', style: 'destructive',
        onPress: () => {
          const fix = mapFixRef.current;
          void sosApi.raise({
            reason: 'protection_session',
            ...(fix ? {lat: fix.lat, lng: fix.lng} : {}),
            payload: session ? {protection_session_id: session.id} : {},
          }).then(() => { void refresh(); }).catch(() => {
            Alert.alert('SOS failed to send', 'Check your connection and try again.');
          });
        },
      },
    ]);
  }, [session, refresh]);

  // Own position for the map — one shot on entering live, then a light refresh.
  // Recenters the existing WebView rather than remounting (cheaper, no flicker).
  useEffect(() => {
    if (phase !== 'active' && phase !== 'starting') {return;}
    const grab = () => Geolocation.getCurrentPosition(
      pos => {
        const f = {lat: pos.coords.latitude, lng: pos.coords.longitude};
        mapFixRef.current = f;
        if (!mapReady.current) {setMapFix(f); mapReady.current = true;}
        else {webRef.current?.injectJavaScript(`window.setCenter&&window.setCenter(${f.lat},${f.lng});true;`);}
      },
      () => { /* no fix — the map keeps its last center; never logged */ },
      {enableHighAccuracy: true, timeout: 10_000, maximumAge: 15_000},
    );
    grab();
    const t = setInterval(grab, 15_000);
    return () => clearInterval(t);
  }, [phase]);

  const submitNote = useCallback(async () => {
    if (!session || sendingNote) {return;}
    const body = [selected, comment.trim()].filter(Boolean).join(' — ');
    if (!body) {return;}
    // §6 — one idempotency key per attempt; retry / success-but-disconnect
    // reuses it so the server dedupes rather than duplicating the note.
    if (!noteKey.current) {noteKey.current = `pcn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;}
    setSendingNote(true); setNoteFailed(false);
    try {
      await protectionApi.postNote(session.id, body, noteKey.current);
      noteKey.current = null; // consumed — next note mints a fresh key
      setComment(''); setSelected(null);
      const r = await protectionApi.notes(session.id);
      setNotes(r.data.notes);
    } catch {
      // Persistent failed state — text + key retained; inline "Not sent — retry".
      setNoteFailed(true);
    } finally {
      setSendingNote(false);
    }
  }, [session, sendingNote, selected, comment]);

  const activatedAt = session?.activated_at ? Date.parse(session.activated_at) : null;
  const durationMs = activatedAt ? Math.max(0, (nowTick + serverOffset.current) - activatedAt) : 0;
  const durationLabel = fmtDuration(durationMs);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />

      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}
          accessibilityRole="button" accessibilityLabel="Go back" hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>PROTECTION</Text>
        <TouchableOpacity style={s.back}
          onPress={() => (navigation as unknown as {navigate: (n: string) => void}).navigate('ProtectionHistory')}
          activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Protection history">
          <Icon name="history" size={19} color={D.accentSoft} />
        </TouchableOpacity>
      </View>

      <ScrollView style={{flex: 1}} contentContainerStyle={{paddingHorizontal: 20, paddingBottom: bottomPad(24)}}
        keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

        {phase === 'loading' && (
          <View style={s.loadingWrap}><ActivityIndicator color={D.accent} /></View>
        )}

        {phase === 'idle' && (
          <View style={s.startWrap}>
            <ImageryBackdrop source={Imagery.requestProtection} variant="hero" />
            <View style={s.startIcon}><Icon name="shield-plus-outline" size={40} color={D.accentSoft} /></View>
            <Text style={s.startTitle}>Request Protection</Text>
            <Text style={s.startSub}>
              Start a live protection session. Your assigned officer will monitor your location in real time
              until you end it. Available whenever your plan is active.
            </Text>
            {requestedAt !== null && (
              <View style={s.requestedCard}>
                <View style={[s.bannerDot, {backgroundColor: D.amber}]} />
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.requestedTitle}>Protection Requested</Text>
                  <Text style={s.requestedBody}>
                    {`Sent to the Bravo Control System at ${fmtClock(requestedAt)}. Ops will assign a protection officer and confirm shortly.`}
                  </Text>
                </View>
              </View>
            )}
            <TouchableOpacity style={s.primaryBtn} onPress={request} activeOpacity={0.85}
              accessibilityRole="button" accessibilityLabel={requestedAt !== null ? 'Request again' : 'Request protection'}>
              <Icon name="shield-check" size={18} color="#0A0E16" />
              <Text style={s.primaryBtnText}>{requestedAt !== null ? 'Request again' : 'Request Protection'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {(phase === 'starting' || phase === 'active') && session && (
          <>
            {/* Status banner */}
            <View style={[s.banner, phase === 'active' ? s.bannerLive : s.bannerStarting]}>
              <View style={[s.bannerDot, {backgroundColor: phase === 'active' ? D.signal : D.amber}]} />
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={[s.bannerTitle, {color: phase === 'active' ? D.signal : D.amber}]}>
                  {phase === 'active' ? 'Protection Active' : 'Starting protection…'}
                </Text>
                <Text style={s.bannerSub}>
                  {phase === 'active'
                    ? durationLabel
                    : gateBlocking
                      ? 'Waiting for setup to be completed…'
                      : 'Waiting for your first location…'}
                </Text>
              </View>
              {session.sos_active && (
                <View style={s.sosPill}><Text style={s.sosPillText}>SOS LIVE</Text></View>
              )}
            </View>

            {/* The mission cannot start until BOTH sides are device-ready. */}
            {gateBlocking && (
              <View style={s.gateCard}>
                <ReadinessGate
                  role="customer"
                  missing={readiness.missing}
                  checking={readiness.checking}
                  blockedBy={readiness.blockedBy}
                  onOpenSettings={readiness.openSettings}
                  onRecheck={readiness.recheck}
                />
              </View>
            )}

            {/* CPO card */}
            <View style={s.cpoCard}>
              <View style={s.cpoAvatar}>
                <Text style={s.cpoAvatarText}>{(session.cpo_name ?? 'O').slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.cpoCap}>YOUR PROTECTION OFFICER</Text>
                <Text style={s.cpoName} numberOfLines={1}>{session.cpo_name ?? 'Assigned officer'}</Text>
              </View>
              {session.call_sign ? (
                <View style={s.callSign}><Text style={s.callSignText}>{session.call_sign}</Text></View>
              ) : null}
            </View>

            {/* Own-position map */}
            <View style={s.mapCard}>
              {MAPBOX_TOKEN_MISSING || !mapFix ? (
                <View style={s.mapFallback}>
                  <Icon name="map-marker-radius" size={26} color={D.accentSoft} />
                  <Text style={s.mapFallbackText}>
                    {MAPBOX_TOKEN_MISSING ? 'Map unavailable' : 'Acquiring your location…'}
                  </Text>
                </View>
              ) : (
                <WebView ref={webRef} originWhitelist={['*']} javaScriptEnabled domStorageEnabled
                  mixedContentMode="compatibility"
                  androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
                  // iOS drops the WebView's content process while backgrounded.
                  // The rebuilt html is byte-identical, so the source diff alone
                  // would NOT reload it — the key is what forces the remount.
                  onRenderProcessGone={() => { mapReady.current = false; setMapEpoch(e => e + 1); }}
                  onContentProcessDidTerminate={() => { mapReady.current = false; setMapEpoch(e => e + 1); }}
                  key={`self-map-${mapEpoch}`}
                  source={mapSource}
                  style={{flex: 1, backgroundColor: D.bg}} />
              )}
            </View>

            {/* Streaming status */}
            <View style={[s.streamRow, stream.lastError && s.streamRowError]}>
              <Icon
                name={stream.lastError ? 'wifi-off' : 'access-point'}
                size={15}
                color={stream.lastError ? D.amber : D.signal} />
              <Text style={[s.streamText, {color: stream.lastError ? D.amber : D.textDim}]}>
                {stream.lastError
                  ? 'Connection lost — retrying…'
                  : `Sharing live · last sent ${agoLabel(stream.lastSentAt)}`}
              </Text>
            </View>

            {/* Message your officer — predefined + comment (one-way), officer replies shown */}
            <Text style={s.msgLabel}>MESSAGE YOUR OFFICER</Text>
            <View style={s.chips}>
              {CUSTOMER_OPTIONS.map(opt => (
                <TouchableOpacity key={opt} activeOpacity={0.8}
                  style={[s.chip, selected === opt && s.chipOn]}
                  onPress={() => setSelected(selected === opt ? null : opt)}
                  accessibilityRole="button" accessibilityLabel={opt}>
                  <Text style={[s.chipText, selected === opt && s.chipTextOn]}>{opt}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={s.msgRow}>
              <TextInput style={s.comment} value={comment} onChangeText={setComment}
                placeholder="Add a note…" placeholderTextColor={D.textMute} maxLength={500} />
              <TouchableOpacity
                style={[s.sendBtn, (sendingNote || (!selected && !comment.trim())) && {opacity: 0.4}]}
                disabled={sendingNote || (!selected && !comment.trim())}
                onPress={() => { void submitNote(); }} activeOpacity={0.85}
                accessibilityRole="button" accessibilityLabel="Send note">
                <Icon name="send" size={18} color="#0A0E16" />
              </TouchableOpacity>
            </View>
            {noteFailed && !sendingNote && (
              <TouchableOpacity style={s.retryRow} onPress={() => { void submitNote(); }} activeOpacity={0.8}
                accessibilityRole="button" accessibilityLabel="Retry sending note">
                <Icon name="alert-circle-outline" size={15} color={D.amber} />
                <Text style={s.retryText}>Not sent — tap to retry</Text>
              </TouchableOpacity>
            )}
            {notes.length > 0 && (
              <View style={{marginTop: 12, gap: 8}}>
                {[...notes].reverse().slice(0, 8).map(n => (
                  <View key={n.id} style={n.sender === 'customer' ? {alignItems: 'flex-end'} : {alignItems: 'flex-start'}}>
                    <View style={[s.noteBubble, n.sender === 'customer' ? s.noteMine : s.noteOfficer]}>
                      <Text style={s.noteText}>{n.body}</Text>
                    </View>
                    <Text style={s.noteWho}>{n.sender === 'customer' ? 'You' : 'Officer'}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* SOS */}
            <TouchableOpacity style={s.sosBtn} onPress={raiseSos} activeOpacity={0.85}
              accessibilityRole="button" accessibilityLabel="Send SOS">
              <Icon name="alert-octagon" size={20} color={D.danger} />
              <Text style={s.sosBtnText}>SOS — Alert my officer now</Text>
            </TouchableOpacity>

            {/* End */}
            <TouchableOpacity style={s.endBtn} onPress={confirmEnd} activeOpacity={0.85}
              accessibilityRole="button" accessibilityLabel="End protection">
              <Text style={s.endBtnText}>End Protection</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14},
  back: {width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontFamily: D.fMono, fontSize: 11, fontWeight: '700', letterSpacing: 2, color: D.accentSoft},

  loadingWrap: {paddingTop: 80, alignItems: 'center'},

  startWrap: {alignItems: 'center', paddingTop: 48, gap: 12, paddingHorizontal: 8},
  startIcon: {width: 88, height: 88, borderRadius: 28, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)', alignItems: 'center', justifyContent: 'center'},
  startTitle: {fontFamily: D.fBold, fontSize: 21, color: D.text, marginTop: 4},
  startSub: {fontFamily: D.fSans, fontSize: 13, color: D.textDim, textAlign: 'center', lineHeight: 20},
  primaryBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 18, alignSelf: 'stretch', paddingVertical: 16, borderRadius: 16, backgroundColor: D.accentSoft},
  primaryBtnText: {fontFamily: D.fBold, fontSize: 15, color: '#0A0E16'},
  requestedCard: {flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'stretch', marginTop: 6, padding: 14, borderRadius: 16, borderWidth: 1, backgroundColor: 'rgba(245,199,107,0.08)', borderColor: 'rgba(245,199,107,0.3)'},
  requestedTitle: {fontFamily: D.fBold, fontSize: 14.5, color: D.amber},
  requestedBody: {fontFamily: D.fSans, fontSize: 12.5, color: D.textDim, lineHeight: 18, marginTop: 3},

  banner: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: 16, borderWidth: 1, marginTop: 6},
  bannerStarting: {backgroundColor: 'rgba(245,199,107,0.08)', borderColor: 'rgba(245,199,107,0.3)'},
  bannerLive: {backgroundColor: 'rgba(74,222,128,0.08)', borderColor: 'rgba(74,222,128,0.3)'},
  bannerDot: {width: 10, height: 10, borderRadius: 5},
  bannerTitle: {fontFamily: D.fBold, fontSize: 16},
  bannerSub: {fontFamily: D.fMono, fontSize: 12, color: D.textDim, marginTop: 3},
  sosPill: {paddingVertical: 4, paddingHorizontal: 8, borderRadius: 7, backgroundColor: 'rgba(248,113,113,0.14)', borderWidth: 1, borderColor: 'rgba(248,113,113,0.4)'},
  sosPillText: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 1, color: D.danger},

  cpoCard: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, backgroundColor: D.card, borderWidth: 1, borderColor: D.hair, marginTop: 12},
  cpoAvatar: {width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)', alignItems: 'center', justifyContent: 'center'},
  cpoAvatarText: {fontFamily: D.fBold, fontSize: 18, color: D.accentSoft},
  cpoCap: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1.2, color: D.textMute},
  cpoName: {fontFamily: D.fBold, fontSize: 15, color: D.text, marginTop: 3},
  callSign: {paddingVertical: 4, paddingHorizontal: 9, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2},
  callSignText: {fontFamily: D.fMono, fontSize: 11, fontWeight: '700', color: D.accentSoft},

  gateCard: {borderRadius: 16, borderWidth: 1, borderColor: 'rgba(245,165,36,0.22)', backgroundColor: 'rgba(245,165,36,0.05)', marginTop: 12},
  mapCard: {height: 200, borderRadius: 16, overflow: 'hidden', backgroundColor: '#06101E', borderWidth: 1, borderColor: D.hair2, marginTop: 12},
  mapFallback: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8},
  mapFallbackText: {fontFamily: D.fSans, fontSize: 12, color: D.textDim},

  streamRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: 'rgba(74,222,128,0.06)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.18)'},
  streamRowError: {backgroundColor: 'rgba(245,199,107,0.07)', borderColor: 'rgba(245,199,107,0.28)'},
  streamText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 12},

  sosBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16, paddingVertical: 15, borderRadius: 14, backgroundColor: 'rgba(248,113,113,0.1)', borderWidth: 1, borderColor: 'rgba(248,113,113,0.4)'},
  sosBtnText: {fontFamily: D.fBold, fontSize: 14, color: D.danger},

  endBtn: {alignItems: 'center', justifyContent: 'center', marginTop: 10, paddingVertical: 15, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  endBtnText: {fontFamily: D.fSemi, fontSize: 14, color: D.textDim},

  msgLabel: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 2, color: D.textDim, marginTop: 18, marginBottom: 10},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {paddingVertical: 8, paddingHorizontal: 12, borderRadius: 99, backgroundColor: D.card, borderWidth: 1, borderColor: D.hair2},
  chipOn: {backgroundColor: 'rgba(91,141,239,0.16)', borderColor: 'rgba(91,141,239,0.45)'},
  chipText: {fontFamily: D.fSemi, fontSize: 12, color: D.textDim},
  chipTextOn: {color: D.accentSoft},
  msgRow: {flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 12},
  comment: {flex: 1, minHeight: 46, maxHeight: 110, borderRadius: 12, backgroundColor: D.card, borderWidth: 1, borderColor: D.hair2, paddingHorizontal: 14, paddingVertical: 10, color: D.text, fontFamily: D.fSans, fontSize: 13.5},
  sendBtn: {width: 46, height: 46, borderRadius: 12, backgroundColor: D.accentSoft, alignItems: 'center', justifyContent: 'center'},
  noteBubble: {maxWidth: '82%', borderRadius: 13, paddingHorizontal: 12, paddingVertical: 8},
  noteMine: {backgroundColor: 'rgba(91,141,239,0.18)', borderTopRightRadius: 4},
  noteOfficer: {backgroundColor: D.card, borderWidth: 1, borderColor: D.hair, borderTopLeftRadius: 4},
  noteText: {fontFamily: D.fSans, fontSize: 13, color: D.text, lineHeight: 18},
  noteWho: {fontFamily: D.fMono, fontSize: 9, color: D.textMute, marginTop: 3},
  retryRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 10, paddingVertical: 9, borderRadius: 10, backgroundColor: 'rgba(245,199,107,0.08)', borderWidth: 1, borderColor: 'rgba(245,199,107,0.35)'},
  retryText: {fontFamily: D.fSemi, fontSize: 12, color: D.amber},
}));
