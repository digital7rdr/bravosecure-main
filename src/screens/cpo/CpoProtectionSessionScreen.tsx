/**
 * CPO active protection-session screen (spec §6). Live map (marker + recent
 * trail) with a TRUTHFUL staleness ladder computed from server timestamps only
 * (received_at vs server now — never the device clock; clock drift is what
 * burned the group-call "stale" investigation). >3m renders "Location
 * unavailable" with a greyed marker — never a live-looking stale marker (rule 9).
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, ActivityIndicator, TextInput, Platform} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {WebView} from 'react-native-webview';
import Geolocation from 'react-native-geolocation-service';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {Alert} from '@utils/alert';
import {MAPBOX_TOKEN, MAPBOX_TOKEN_MISSING} from '@/modules/maps/mapToken';
import {mapHtmlSource} from '@/modules/maps/mapWebViewSource';
import {cpoProtectionApi, type CpoProtectionSessionDetail, type StalenessState, type ProtectionTrailFix, type ProtectionNote} from '@services/api';
import {useProtectionSessionRealtime} from '@screens/pro/useProtectionSessionRealtime';
import {useProtectionReadiness} from '@hooks/useProtectionReadiness';
import ReadinessGate from '@components/protection/ReadinessGate';

const CPO_OPTIONS = [
  'On the way', 'Arrived at location', 'With member',
  'Situation normal', 'Need assistance', 'Mission completed',
] as const;

const D = {
  bg: '#07090D', card: 'rgba(22,27,37,0.72)', text: '#F2F4F8',
  textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.06)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80', amber: '#F5C76B', danger: '#F87171', grey: '#8A93A6',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold', fMono: 'monospace',
};

const STALE: Record<StalenessState, {color: string; label: (age: number | null) => string}> = {
  live:        {color: D.signal, label: a => `Live · updated ${fmtAge(a)}`},
  delayed:     {color: D.amber,  label: a => `Delayed · last update ${fmtAge(a)}`},
  unavailable: {color: D.danger, label: a => `Location unavailable — last update ${fmtAge(a)}`},
  idle:        {color: D.grey,   label: () => 'Waiting for first location…'},
};

function fmtAge(sec: number | null): string {
  if (sec === null) {return '—';}
  if (sec < 60) {return `${sec}s ago`;}
  return `${Math.floor(sec / 60)}m ago`;
}

const CPO_COLOR = '#5B8DEF';

// Combined SATELLITE map: customer marker (staleness colour) + officer marker
// (cobalt) + a dashed link between them, fit to show both.
function combinedMapHtml(custFixes: ProtectionTrailFix[], cpoFixes: ProtectionTrailFix[], custColor: string): string {
  const cust = custFixes.map(f => [f.lng, f.lat]);
  const cpo = cpoFixes.map(f => [f.lng, f.lat]);
  const custNew = cust[0] ?? [55.2708, 25.2048];
  const cpoNew = cpo[0] ?? null;
  const custLine = [...cust].reverse();
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<link href="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.css" rel="stylesheet"/>
<script src="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.js"></script>
<style>body,html,#m{margin:0;height:100%;background:#07090D}</style></head>
<body><div id="m"></div><script>
mapboxgl.accessToken=${JSON.stringify(MAPBOX_TOKEN)};
var map=new mapboxgl.Map({container:'m',style:'mapbox://styles/mapbox/satellite-streets-v12',center:[${custNew[0]},${custNew[1]}],zoom:14,attributionControl:false});
function mk(col){var e=document.createElement('div');e.style.cssText='width:18px;height:18px;border-radius:50%;background:'+col+';border:3px solid #fff;box-shadow:0 0 0 6px '+col+'44';return e;}
var custEl=mk('${custColor}');var custM=new mapboxgl.Marker(custEl).setLngLat([${custNew[0]},${custNew[1]}]).addTo(map);
var cpoM=${cpoNew ? `new mapboxgl.Marker(mk('${CPO_COLOR}')).setLngLat([${cpoNew[0]},${cpoNew[1]}]).addTo(map)` : 'null'};
map.on('load',function(){
  var line=${JSON.stringify(custLine)};
  if(line.length>1){map.addSource('t',{type:'geojson',data:{type:'Feature',geometry:{type:'LineString',coordinates:line}}});
  map.addLayer({id:'t',type:'line',source:'t',paint:{'line-color':'${custColor}','line-width':3,'line-opacity':0.75}});}
  fit();
});
function fit(){try{var b=new mapboxgl.LngLatBounds();b.extend(custM.getLngLat());if(cpoM)b.extend(cpoM.getLngLat());
  if(cpoM){map.fitBounds(b,{padding:70,maxZoom:15,duration:400});}else{map.setCenter(custM.getLngLat());}}catch(e){}}
window.update=function(la,ln,col,cla,cln){custM.setLngLat([ln,la]);custEl.style.background=col;custEl.style.boxShadow='0 0 0 6px '+col+'44';
  if(cla!=null&&cln!=null){if(!cpoM){cpoM=new mapboxgl.Marker(mk('${CPO_COLOR}')).setLngLat([cln,cla]).addTo(map);}else{cpoM.setLngLat([cln,cla]);}}fit();};
</script></body></html>`;
}

type SessionRoute = RouteProp<{CpoProtectionSession: {sessionId: string}}, 'CpoProtectionSession'>;

export default function CpoProtectionSessionScreen() {
  const navigation = useNavigation();
  const route = useRoute<SessionRoute>();
  const sessionId = route.params?.sessionId;
  const insets = useSafeAreaInsets();
  const {bottomPad} = useKeyboardLayout();

  const [detail, setDetail] = useState<CpoProtectionSessionDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [comment, setComment] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [protecting, setProtecting] = useState(false);
  const [protectFailed, setProtectFailed] = useState(false);
  const mounted = useRef(false);
  const webRef = useRef<WebView>(null);
  const idemKey = useRef<string | null>(null);
  // Bumped only to force a remount after iOS reclaims the WebView's content
  // process — otherwise the map comes back from the background as a blank box.
  const [mapEpoch, setMapEpoch] = useState(0);

  const load = useCallback(async () => {
    if (!sessionId) {return;}
    try {
      const {data} = await cpoProtectionApi.session(sessionId);
      setDetail(data);
      setFailed(false);
      const newest = data.trail[0];
      const cpoNewest = data.cpo_trail[0];
      if (newest && mounted.current) {
        const cpoArg = cpoNewest ? `${cpoNewest.lat},${cpoNewest.lng}` : 'null,null';
        webRef.current?.injectJavaScript(
          `window.update&&window.update(${newest.lat},${newest.lng},${JSON.stringify(STALE[data.staleness.state].color)},${cpoArg});true;`,
        );
      }
    } catch {
      setFailed(f => (detail ? f : true));
    }
  }, [sessionId, detail]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(t);
  }, [load]);
  useProtectionSessionRealtime(sessionId, () => { void load(); });

  // The page is built ONCE per epoch, from the first trail we receive — every
  // later fix moves the markers through window.update via injectJavaScript.
  // Rebuilding it on each 5s poll would reload the whole map mid-mission.
  // baseUrl is what keeps GL's blob workers legal on iOS (mapWebViewSource).
  const hasTrail = (detail?.trail.length ?? 0) > 0;
  const mapSource = useMemo(
    () => mapHtmlSource(combinedMapHtml(
      detail?.trail ?? [], detail?.cpo_trail ?? [],
      STALE[detail?.staleness.state ?? 'idle'].color,
    )),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasTrail, mapEpoch],
  );

  // Mission-start gate for the officer's own device. Reported to the server,
  // which alone decides whether the mission may go live (both sides required).
  const readiness = useProtectionReadiness(sessionId, 'cpo');
  const gateBlocking = !readiness.checking
    && (readiness.missing.length > 0 || readiness.blockedBy.length > 0);

  // Stream the OFFICER's own location while viewing a live session, so ops gets
  // the CPO / combined maps. Coordinates are never logged (§9).
  useEffect(() => {
    if (!sessionId || detail?.session?.status !== 'ACTIVE') {return;}
    const grab = () => Geolocation.getCurrentPosition(
      pos => { void cpoProtectionApi.cpoPing(sessionId, [{
        lat: pos.coords.latitude, lng: pos.coords.longitude,
        accuracy_m: typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : undefined,
        recorded_at: new Date(pos.timestamp || Date.now()).toISOString(),
      }]).catch(() => undefined); },
      () => { /* no fix — nothing sent; never logged */ },
      {enableHighAccuracy: true, timeout: 10_000, maximumAge: 8_000},
    );
    grab();
    const t = setInterval(grab, 10_000);
    return () => clearInterval(t);
  }, [sessionId, detail?.session?.status]);

  const stale = detail ? STALE[detail.staleness.state] : STALE.idle;
  const notLive = !detail || detail.session.status !== 'ACTIVE';
  const protectActive = !!detail?.session.protect_activated_at;
  const notes: ProtectionNote[] = detail?.notes ?? [];

  const submitUpdate = useCallback(async () => {
    if (!sessionId || submitting) {return;}
    const body = [selected, comment.trim()].filter(Boolean).join(' — ');
    if (!body) {return;} // empty comment + no option → prevent submission
    // §6 — one idempotency key per attempt; a retry (or a success-but-disconnect)
    // reuses it so the server dedupes instead of creating a duplicate update.
    if (!idemKey.current) {idemKey.current = `psn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;}
    setSubmitting(true); setSendFailed(false);
    try {
      await cpoProtectionApi.postNote(sessionId, body, idemKey.current);
      idemKey.current = null; // consumed — the next update mints a fresh key
      setComment(''); setSelected(null);
      await load();
    } catch {
      // Persistent failed state — input + key retained; the inline "Not sent —
      // tap to retry" row stays until it succeeds (retry reuses the key).
      setSendFailed(true);
    } finally {
      setSubmitting(false);
    }
  }, [sessionId, submitting, selected, comment, load]);

  const doProtect = useCallback(async () => {
    if (!sessionId || protecting) {return;}
    setProtecting(true); setProtectFailed(false);
    try {
      await cpoProtectionApi.activateProtect(sessionId);
      await load();
    } catch {
      setProtectFailed(true);
    } finally {
      setProtecting(false);
    }
  }, [sessionId, protecting, load]);

  const confirmProtect = useCallback(() => {
    if (protecting || protectActive || notLive) {return;}
    Alert.alert('Activate CPO Protect?', 'Confirm you are engaging protection for this member now.', [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Activate', onPress: () => { void doProtect(); }},
    ]);
  }, [protecting, protectActive, notLive, doProtect]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}
          accessibilityRole="button" accessibilityLabel="Go back" hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>LIVE SESSION</Text>
        <View style={{width: 40}} />
      </View>

      {!detail && !failed && <View style={s.loadingWrap}><ActivityIndicator color={D.accent} /></View>}
      {failed && !detail && (
        <View style={s.loadingWrap}><Text style={s.errText}>Couldn't load this session.</Text></View>
      )}

      {detail && (
        <ScrollView style={{flex: 1}} contentContainerStyle={{paddingHorizontal: 20, paddingBottom: bottomPad(24)}}
          keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

          {detail.session.sos_active ? (
            <View style={s.sosBanner}>
              <Icon name="alert-octagon" size={18} color={D.danger} />
              <Text style={s.sosBannerText}>SOS ACTIVE — customer raised an alert. Coordinate a response now.</Text>
            </View>
          ) : null}

          <View style={s.custCard}>
            <View style={s.custAvatar}>
              <Text style={s.custAvatarText}>
                {((detail.session.customer_name as string | undefined) ?? 'C').slice(0, 1).toUpperCase()}
              </Text>
            </View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.custCap}>PROTECTING</Text>
              <Text style={s.custName} numberOfLines={1}>{detail.session.customer_name ?? 'Customer'}</Text>
            </View>
          </View>

          {/* The mission cannot start until BOTH sides are device-ready, and a
              revocation mid-mission reappears here (edge cases 2, 4, 6). */}
          {gateBlocking && (
            <View style={s.gateCard}>
              <ReadinessGate
                role="cpo"
                missing={readiness.missing}
                checking={readiness.checking}
                blockedBy={readiness.blockedBy}
                onOpenSettings={readiness.openSettings}
                onRecheck={readiness.recheck}
              />
            </View>
          )}

          {/* Staleness banner (server-clock truth) */}
          <View style={[s.staleBanner, {borderColor: stale.color + '55', backgroundColor: stale.color + '14'}]}>
            <View style={[s.staleDot, {backgroundColor: stale.color}]} />
            <Text style={[s.staleText, {color: stale.color}]}>{stale.label(detail.staleness.age_seconds)}</Text>
          </View>

          {/* Live map */}
          <View style={s.mapCard}>
            {MAPBOX_TOKEN_MISSING || detail.trail.length === 0 ? (
              <View style={s.mapFallback}>
                <Icon name="map-marker-off-outline" size={26} color={D.textMute} />
                <Text style={s.mapFallbackText}>
                  {MAPBOX_TOKEN_MISSING ? 'Map unavailable' : 'No location received yet'}
                </Text>
              </View>
            ) : (
              <WebView ref={webRef} originWhitelist={['*']} javaScriptEnabled domStorageEnabled
                mixedContentMode="compatibility"
                androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
                onLoadEnd={() => { mounted.current = true; }}
                // iOS reclaims the content process while backgrounded; remount
                // on the way back or the map returns as a blank rectangle.
                onRenderProcessGone={() => setMapEpoch(e => e + 1)}
                onContentProcessDidTerminate={() => setMapEpoch(e => e + 1)}
                key={`psession-map-${mapEpoch}`}
                source={mapSource}
                style={{flex: 1, backgroundColor: D.bg}} />
            )}
          </View>

          <View style={s.metaGrid}>
            <View style={s.metaCell}>
              <Text style={s.metaCap}>STATUS</Text>
              <Text style={s.metaVal}>{String(detail.session.status)}</Text>
            </View>
            <View style={s.metaCell}>
              <Text style={s.metaCap}>ACCURACY</Text>
              <Text style={s.metaVal}>
                {typeof detail.trail[0]?.accuracy_m === 'number' ? `${Math.round(Number(detail.trail[0]?.accuracy_m))}m` : '—'}
              </Text>
            </View>
          </View>

          {/* CPO Protect */}
          <TouchableOpacity
            style={[s.protectBtn, (protectActive || notLive) && s.protectBtnOn]}
            activeOpacity={protectActive || notLive ? 1 : 0.85}
            disabled={protectActive || notLive || protecting}
            onPress={confirmProtect}
            accessibilityRole="button" accessibilityLabel="CPO Protect">
            <Icon name={protectActive ? 'shield-check' : 'shield-plus'} size={20} color={protectActive ? D.signal : '#0A0E16'} />
            <Text style={[s.protectBtnText, protectActive && {color: D.signal}]}>
              {protectActive ? 'Protection Active' : protecting ? 'Activating…' : 'CPO Protect'}
            </Text>
          </TouchableOpacity>
          {protectFailed && !protectActive && !protecting && (
            <TouchableOpacity style={s.retryRow} onPress={() => { void doProtect(); }} activeOpacity={0.8}
              accessibilityRole="button" accessibilityLabel="Retry activating protection">
              <Icon name="alert-circle-outline" size={15} color={D.amber} />
              <Text style={s.retryText}>Activation failed — tap to retry</Text>
            </TouchableOpacity>
          )}

          {/* Mission updates (CPO → Ops, one-way) */}
          <Text style={s.sectionLabel}>SEND UPDATE</Text>
          <View style={s.chips}>
            {CPO_OPTIONS.map(opt => (
              <TouchableOpacity key={opt} activeOpacity={0.8}
                style={[s.chip, selected === opt && s.chipOn]}
                onPress={() => setSelected(selected === opt ? null : opt)}
                accessibilityRole="button" accessibilityLabel={opt}>
                <Text style={[s.chipText, selected === opt && s.chipTextOn]}>{opt}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            style={s.comment}
            value={comment}
            onChangeText={setComment}
            placeholder="Add a comment (optional)…"
            placeholderTextColor={D.textMute}
            multiline
            maxLength={500}
            editable={!notLive} />
          <TouchableOpacity
            style={[s.submitBtn, (submitting || (!selected && !comment.trim()) || notLive) && s.submitBtnOff]}
            activeOpacity={0.85}
            disabled={submitting || (!selected && !comment.trim()) || notLive}
            onPress={() => { void submitUpdate(); }}
            accessibilityRole="button" accessibilityLabel="Submit update">
            <Text style={s.submitBtnText}>{submitting ? 'Sending…' : 'Submit update'}</Text>
          </TouchableOpacity>
          {sendFailed && !submitting && (
            <TouchableOpacity style={s.retryRow} onPress={() => { void submitUpdate(); }} activeOpacity={0.8}
              accessibilityRole="button" accessibilityLabel="Retry sending update">
              <Icon name="alert-circle-outline" size={15} color={D.amber} />
              <Text style={s.retryText}>Not sent — tap to retry</Text>
            </TouchableOpacity>
          )}

          {/* Activity / history */}
          {notes.length > 0 && (
            <>
              <Text style={s.sectionLabel}>ACTIVITY</Text>
              {[...notes].reverse().map(n => (
                <View key={n.id} style={s.noteRow}>
                  <View style={[s.noteDot, {backgroundColor: n.sender === 'cpo' ? D.accent : D.signal}]} />
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.noteBody}>{n.body}</Text>
                    <Text style={s.noteMeta}>{n.sender === 'cpo' ? 'You' : 'Member'} · {fmtTime(n.created_at)}</Text>
                  </View>
                </View>
              ))}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '';}
  return d.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14},
  back: {width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontFamily: D.fMono, fontSize: 11, fontWeight: '700', letterSpacing: 2, color: D.accentSoft},
  loadingWrap: {paddingTop: 80, alignItems: 'center'},
  errText: {fontFamily: D.fSans, fontSize: 13, color: D.textDim},

  sosBanner: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 14, marginBottom: 12, backgroundColor: 'rgba(248,113,113,0.12)', borderWidth: 1, borderColor: 'rgba(248,113,113,0.45)'},
  sosBannerText: {flex: 1, minWidth: 0, fontFamily: D.fBold, fontSize: 12.5, color: D.danger},

  custCard: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, backgroundColor: D.card, borderWidth: 1, borderColor: D.hair},
  custAvatar: {width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)', alignItems: 'center', justifyContent: 'center'},
  custAvatarText: {fontFamily: D.fBold, fontSize: 18, color: D.accentSoft},
  custCap: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1.2, color: D.textMute},
  custName: {fontFamily: D.fBold, fontSize: 15, color: D.text, marginTop: 3},

  staleBanner: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13, borderRadius: 12, marginTop: 12, borderWidth: 1},
  staleDot: {width: 9, height: 9, borderRadius: 5},
  staleText: {flex: 1, minWidth: 0, fontFamily: D.fSemi, fontSize: 12.5},

  gateCard: {borderRadius: 16, borderWidth: 1, borderColor: 'rgba(245,165,36,0.22)', backgroundColor: 'rgba(245,165,36,0.05)', marginTop: 12},
  mapCard: {height: 240, borderRadius: 16, overflow: 'hidden', backgroundColor: '#06101E', borderWidth: 1, borderColor: D.hair2, marginTop: 12},
  mapFallback: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8},
  mapFallbackText: {fontFamily: D.fSans, fontSize: 12, color: D.textDim},

  metaGrid: {flexDirection: 'row', gap: 10, marginTop: 12},
  metaCell: {flex: 1, padding: 13, borderRadius: 12, backgroundColor: D.card, borderWidth: 1, borderColor: D.hair, alignItems: 'center', gap: 5},
  metaCap: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1.2, color: D.textMute},
  metaVal: {fontFamily: D.fBold, fontSize: 14, color: D.text},

  protectBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 14, paddingVertical: 15, borderRadius: 14, backgroundColor: D.accentSoft},
  protectBtnOn: {backgroundColor: 'rgba(74,222,128,0.1)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.4)'},
  protectBtnText: {fontFamily: D.fBold, fontSize: 15, color: '#0A0E16'},

  sectionLabel: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 2, color: D.textDim, marginTop: 18, marginBottom: 10},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {paddingVertical: 8, paddingHorizontal: 12, borderRadius: 99, backgroundColor: D.card, borderWidth: 1, borderColor: D.hair2},
  chipOn: {backgroundColor: 'rgba(91,141,239,0.16)', borderColor: 'rgba(91,141,239,0.45)'},
  chipText: {fontFamily: D.fSemi, fontSize: 12, color: D.textDim},
  chipTextOn: {color: D.accentSoft},
  comment: {marginTop: 12, minHeight: 48, maxHeight: 120, borderRadius: 12, backgroundColor: D.card, borderWidth: 1, borderColor: D.hair2, paddingHorizontal: 14, paddingVertical: 10, color: D.text, fontFamily: D.fSans, fontSize: 13.5, textAlignVertical: 'top'},
  submitBtn: {alignItems: 'center', justifyContent: 'center', marginTop: 10, paddingVertical: 13, borderRadius: 12, backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)'},
  submitBtnOff: {opacity: 0.4},
  submitBtnText: {fontFamily: D.fBold, fontSize: 13.5, color: D.accentSoft},
  retryRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 8, paddingVertical: 9, borderRadius: 10, backgroundColor: 'rgba(245,199,107,0.08)', borderWidth: 1, borderColor: 'rgba(245,199,107,0.35)'},
  retryText: {fontFamily: D.fSemi, fontSize: 12, color: D.amber},

  noteRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 9, borderTopWidth: 1, borderTopColor: D.hair},
  noteDot: {width: 7, height: 7, borderRadius: 4, marginTop: 5},
  noteBody: {fontFamily: D.fSans, fontSize: 13, color: D.text, lineHeight: 18},
  noteMeta: {fontFamily: D.fMono, fontSize: 10, color: D.textMute, marginTop: 2},
}));
