import React, {useState, useRef, useEffect} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Vibration,
  TouchableOpacity,
  Animated,
  Easing,
  Pressable,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Halo} from '@components/Halo';
import {Colors} from '@theme/index';
import {supabase} from '@services/supabase';
import {REALTIME_CHANNELS} from '@utils/constants';
import {sosApi} from '@services/api';
import Geolocation from 'react-native-geolocation-service';
import type {BookingScreenProps} from '@navigation/types';
import {goBackOnce} from '@navigation/tapGuard';

type Props = BookingScreenProps<'SOSScreen'>;

const HOLD_DURATION = 3000;

/**
 * SOS Screen — emergency distress signal
 * Broadcasts location + alert to Ops Room via Supabase Realtime
 * Requires 3-second hold to confirm (prevent accidental triggers)
 */
export default function SOSScreen({route, navigation}: Props) {
  const {bookingId} = route.params;
  const insets = useSafeAreaInsets();
  const [isActivated, setIsActivated] = useState(false);
  const [activatedTime, setActivatedTime] = useState('');
  // Audit C3 — distinguish "sending" from "confirmed" so the UI never
  // claims the SOS reached Ops until the authenticated backend accepted it.
  const [sending, setSending] = useState(false);
  const [sosError, setSosError] = useState<string | null>(null);
  // MOB-3 — whether we actually attached a GPS fix to the raise, so the UI can
  // tell the truth instead of always claiming "coordinates sent".
  const [locationSent, setLocationSent] = useState(false);
  // MOB-4 — the server SOS id, so Cancel can stand the alert down server-side.
  const sosIdRef = useRef<string | null>(null);
  const sosInFlight = useRef(false);
  // Issue 44 — "the app must not claim notification until server
  // acknowledgement is received". Recording the panic server-side is not the
  // same as ops having SEEN it, so poll /sos/:id/status for `acknowledged_at`
  // and say which of the two is true. Mirrors DashboardScreen's panic UI.
  const [sosAcked, setSosAcked] = useState(false);
  const sosPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sosPollCancelled = useRef(false);
  useEffect(() => () => {
    sosPollCancelled.current = true;
    if (sosPollTimer.current) {clearTimeout(sosPollTimer.current);}
  }, []);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const holdAnimation = useRef<Animated.CompositeAnimation | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulse2Anim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // `resetBeforeIteration: true` snaps the value back to its starting point
    // without animating the snap — no visible "rectangle fill" flash.
    const loop = Animated.loop(
      Animated.timing(pulseAnim, {
        toValue: 1.5,
        duration: 1800,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      {resetBeforeIteration: true},
    );
    const loop2 = Animated.loop(
      Animated.timing(pulse2Anim, {
        toValue: 1.5,
        duration: 1800,
        delay: 900,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      {resetBeforeIteration: true},
    );
    loop.start();
    loop2.start();
    return () => { loop.stop(); loop2.stop(); };
  }, [pulseAnim, pulse2Anim]);

  // Issue 44 — poll until ops acknowledge, with backoff and a hard stop so a
  // backgrounded panic screen can't poll forever.
  const startAckPoll = (sosId: string) => {
    const MAX_POLL_MS = 10 * 60 * 1000;
    const startedAt = Date.now();
    let delayMs = 3_000;
    sosPollCancelled.current = false;
    const tick = () => {
      if (sosPollCancelled.current || Date.now() - startedAt >= MAX_POLL_MS) {return;}
      sosApi.status(sosId)
        .then(({data}) => {
          if (sosPollCancelled.current) {return;}
          if (data?.acknowledged_at) {setSosAcked(true); return;}
          delayMs = Math.min(delayMs + 2_000, 15_000);
          sosPollTimer.current = setTimeout(tick, delayMs);
        })
        .catch(() => {
          if (sosPollCancelled.current) {return;}
          delayMs = Math.min(delayMs + 2_000, 15_000);
          sosPollTimer.current = setTimeout(tick, delayMs);
        });
    };
    sosPollTimer.current = setTimeout(tick, delayMs);
  };

  const activateSOS = async () => {
    // Audit C3 — the SOS screen previously flipped to "SOS ACTIVE / Ops
    // Room Notified" BEFORE (and regardless of) the network send, using a
    // fire-and-forget Supabase broadcast with no auth and no error path. A
    // failed/offline send showed a confirmed panic alert that reached no
    // one. Fix: drive the AUTHENTICATED `/sos/raise` endpoint (the same
    // server SOS record the dashboard panic button + ops console use),
    // AWAIT its success before showing ACTIVE, and surface failures so the
    // user can retry. The Supabase broadcast is kept only as a best-effort
    // supplementary real-time nudge — never the source of truth.
    if (sosInFlight.current) {return;}
    sosInFlight.current = true;
    setSosError(null);
    setSending(true);
    Vibration.vibrate([0, 500, 200, 500]);
    const now = new Date();
    try {
      // MOB-3 — actually attach the principal's location to the panic (the screen
      // used to send NONE while telling the user "GPS coordinates sent"). Best-effort
      // one-shot fix with a short timeout so a slow GPS never blocks the alert; the
      // raise still goes through without coords if the fix fails, and the UI then
      // says so honestly rather than claiming a location was shared.
      const fix = await new Promise<{lat: number; lng: number} | null>(resolve => {
        Geolocation.getCurrentPosition(
          p => resolve({lat: p.coords.latitude, lng: p.coords.longitude}),
          () => resolve(null),
          {enableHighAccuracy: true, timeout: 5000, maximumAge: 10_000},
        );
      });
      const {data: raised} = await sosApi.raise({
        bookingId,
        reason: 'client_panic',
        ...(fix ? {lat: fix.lat, lng: fix.lng} : {}),
        payload: {source: 'sos_screen', timestamp: now.toISOString()},
      });
      setLocationSent(fix !== null);
      // MOB-4 — remember the SOS id so Cancel can stand it down server-side.
      sosIdRef.current = raised?.id ?? null;
      // Issue 44 — the record exists; ops have not necessarily seen it yet.
      // Back off from 3s to 15s over 10 minutes, then stop.
      if (raised?.id) {startAckPoll(raised.id);}
      // Confirmed by the backend — NOW it's safe to show ACTIVE.
      setActivatedTime(`${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`);
      setIsActivated(true);
      // Best-effort realtime nudge so an ops console already subscribed to
      // the booking channel lights up without waiting for its next poll.
      // Failure here is irrelevant — the authenticated record above is what
      // ops acts on.
      void supabase.channel(REALTIME_CHANNELS.sos(bookingId)).send({
        type: 'broadcast',
        event: 'sos',
        payload: {booking_id: bookingId, timestamp: now.toISOString()},
      }).catch(() => { /* supplementary only */ });
    } catch (e) {
      const msg = (e as {response?: {data?: {message?: string}}}).response?.data?.message
        ?? (e as {message?: string}).message ?? 'Could not reach Ops. Check signal and try again.';
      setSosError(String(msg));
    } finally {
      setSending(false);
      sosInFlight.current = false;
    }
  };

  const cancelSos = () => {
    // MOB-4 — actually stand the alert down server-side (POST /sos/:id/cancel); the
    // button used to be goBack-only, so the user believed they'd cancelled while ops
    // still held an active SOS. Best-effort: leaving is safe even if the cancel fails
    // (a lingering alert is fail-ACTIVE), but it must at least try.
    const id = sosIdRef.current;
    if (id) { void sosApi.cancel(id).catch(() => { /* fail-active is safe */ }); }
    goBackOnce(navigation);
  };

  const handlePressIn = () => {
    holdAnimation.current = Animated.timing(progressAnim, {
      toValue: 1,
      duration: HOLD_DURATION,
      useNativeDriver: false,
    });
    holdAnimation.current.start(({finished}) => {
      if (finished) { void activateSOS(); }
    });
  };

  const handlePressOut = () => {
    holdAnimation.current?.stop();
    Animated.timing(progressAnim, {
      toValue: 0, duration: 200, useNativeDriver: false,
    }).start();
  };

  const ringScale = progressAnim.interpolate({
    inputRange: [0, 1], outputRange: [1, 1.35],
  });
  const ringOpacity = progressAnim.interpolate({
    inputRange: [0, 0.05, 1], outputRange: [0, 0.7, 1],
  });

  // ACTIVATED state
  if (isActivated) {
    return (
      <View style={[styles.activatedRoot, {paddingTop: insets.top, paddingBottom: insets.bottom}]}>
        <View style={styles.activatedBg} />
        <View style={styles.activatedHeader}>
          <Text style={styles.activatedHeaderTitle}>SOS ACTIVE</Text>
          <Text style={styles.activatedHeaderTime}>Activated at {activatedTime}</Text>
        </View>
        <View style={styles.activatedCenter}>
          {/* Ping halos (soft radial flash, no visible edges) */}
          <Halo size={260} color="#DC2626" style={{
            opacity: pulseAnim.interpolate({inputRange:[1,1.5], outputRange:[0.9, 0]}),
            transform:[{scale: pulseAnim.interpolate({inputRange:[1,1.5], outputRange:[0.6, 1.4]})}],
          }} />
          <Halo size={260} color="#EF4444" style={{
            opacity: pulse2Anim.interpolate({inputRange:[1,1.5], outputRange:[0.7, 0]}),
            transform:[{scale: pulse2Anim.interpolate({inputRange:[1,1.5], outputRange:[0.6, 1.7]})}],
          }} />
          <View style={styles.activatedCircle}>
            <Icon name="alert-circle" size={72} color="#FFF" />
          </View>
        </View>
        <View style={styles.activatedTextWrap}>
          <Text style={styles.activatedTitle}>SOS Active</Text>
          {/* Issue 44 — until `acknowledged_at` lands this says "Waiting",
              never "Notified". The app must not assert ops have the alert. */}
          <Text style={styles.activatedSubtitle}>
            {sosAcked ? 'Bravo Control System Acknowledged' : 'Waiting for Bravo Control System…'}
          </Text>
        </View>
        {/* MOB-3 — the fake "LIVE RESPONSE TRACKING" grid + static dot implied live GPS
            tracking that isn't happening on this screen; removed rather than mislead. */}
        {/* Info cards */}
        <View style={styles.infoCards}>
          <View style={styles.infoCard}>
            <Icon name="map-marker" size={20} color={Colors.primary} />
            <View>
              {/* MOB-3 — tell the truth about whether a fix was actually sent. */}
              <Text style={styles.infoCardTitle}>{locationSent ? 'Location Shared' : 'Location Unavailable'}</Text>
              <Text style={styles.infoCardSub}>
                {locationSent
                  ? 'GPS coordinates sent to Bravo Control System'
                  : 'No GPS fix yet — keep this screen open; it will retry'}
              </Text>
            </View>
          </View>
          <View style={styles.infoCard}>
            <Icon name="headset" size={20} color={Colors.primary} />
            <View>
              <Text style={styles.infoCardTitle}>Bravo Control System On Standby</Text>
              <Text style={styles.infoCardSub}>Response team ready to deploy</Text>
            </View>
          </View>
        </View>
        <TouchableOpacity style={styles.cancelActivated} onPress={cancelSos} activeOpacity={0.8}>
          <Text style={styles.cancelActivatedText}>Cancel SOS</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // IDLE state
  return (
    <View style={[styles.root, {paddingTop: insets.top, paddingBottom: insets.bottom}]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#CBD5E1" />
        </TouchableOpacity>
        <Text style={styles.headerBrand}>BRAVO</Text>
      </View>

      {/* Center content */}
      <View style={styles.center}>
        <View style={styles.titleWrap}>
          <Text style={styles.title}>Emergency SOS</Text>
          <Text style={styles.subtitle}>
            {sending ? 'Contacting Bravo Control System…' : 'Hold the button for 3 seconds to activate'}
          </Text>
          {/* Audit C3 — failure is loud: the user must know the alert did
              NOT reach Ops, with an explicit retry affordance, instead of a
              false "SOS ACTIVE" confirmation. */}
          {sosError !== null && (
            <Text style={styles.sosErrorText}>{sosError} · hold to retry</Text>
          )}
        </View>

        {/* SOS button */}
        <View style={styles.sosWrap}>
          {/* Radial halos — soft flash, zero visible rectangle */}
          <Halo size={220} color="#DC2626" style={{
            opacity: pulseAnim.interpolate({inputRange:[1,1.5], outputRange:[0.85, 0]}),
            transform:[{scale: pulseAnim.interpolate({inputRange:[1,1.5], outputRange:[0.55, 1.2]})}],
          }} />
          <Halo size={220} color="#EF4444" style={{
            opacity: pulse2Anim.interpolate({inputRange:[1,1.5], outputRange:[0.6, 0]}),
            transform:[{scale: pulse2Anim.interpolate({inputRange:[1,1.5], outputRange:[0.55, 1.5]})}],
          }} />
          {/* Progress ring */}
          <Animated.View style={[
            styles.progressRing,
            {transform:[{scale: ringScale}], opacity: ringOpacity},
          ]} />
          <Pressable
            onPressIn={sending ? undefined : handlePressIn}
            onPressOut={sending ? undefined : handlePressOut}
            disabled={sending}
            style={[styles.sosBtn, sending && styles.sosBtnSending]}>
            <Text style={styles.sosBtnText}>{sending ? '…' : 'SOS'}</Text>
          </Pressable>
        </View>

        {/* Info cards */}
        <View style={styles.infoCards}>
          <View style={styles.infoCard}>
            <Icon name="map-marker" size={20} color={Colors.primary} />
            <View>
              {/* MOB-3 — future tense: nothing is sent until the user activates. */}
              <Text style={styles.infoCardTitle}>Location Sharing</Text>
              <Text style={styles.infoCardSub}>Your GPS location is sent to Bravo Control System when you activate</Text>
            </View>
          </View>
          <View style={styles.infoCard}>
            <Icon name="headset" size={20} color={Colors.primary} />
            <View>
              <Text style={styles.infoCardTitle}>Bravo Control System On Standby</Text>
              <Text style={styles.infoCardSub}>Response team ready to deploy</Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex:1, backgroundColor:Colors.background},
  header: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingVertical:12, borderBottomWidth:1, borderBottomColor:'rgba(37,99,235,0.1)'},
  backBtn: {width:36, height:36, borderRadius:18, alignItems:'center', justifyContent:'center'},
  headerBrand: {color:'#F1F5F9', fontSize:14, fontWeight:'800', letterSpacing:4},

  center: {flex:1, alignItems:'center', justifyContent:'center', paddingHorizontal:24, gap:40},
  titleWrap: {alignItems:'center', gap:6},
  title: {color:'#F1F5F9', fontSize:22, fontWeight:'800', letterSpacing:0.5},
  subtitle: {color:'#94A3B8', fontSize:14, textAlign:'center'},
  sosErrorText: {color:'#F87171', fontSize:13, textAlign:'center', marginTop:8, fontWeight:'600'},

  sosWrap: {width:220, height:220, alignItems:'center', justifyContent:'center', overflow:'visible'},
  // Soft filled halo, no border. Scaling + opacity fade gives an abstract flash,
  // not a "rectangle drawn on screen" look.
  pulseRing: {
    position:'absolute', width:120, height:120, borderRadius:60,
    backgroundColor:'rgba(220,38,38,0.18)',
  },
  progressRing: {
    position:'absolute', width:140, height:140, borderRadius:70,
    backgroundColor:'rgba(239,68,68,0.25)',
  },
  sosBtn: {width:80, height:80, borderRadius:40, backgroundColor:'#DC2626', alignItems:'center', justifyContent:'center', shadowColor:'#DC2626', shadowOffset:{width:0,height:0}, shadowOpacity:0.7, shadowRadius:20, elevation:12},
  sosBtnSending: {opacity:0.6},
  sosBtnText: {color:'#FFF', fontSize:20, fontWeight:'900', letterSpacing:2},

  infoCards: {width:'100%', gap:8},
  infoCard: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:14, paddingVertical:12, borderRadius:10, backgroundColor:'rgba(37,99,235,0.05)', borderWidth:1, borderColor:'rgba(37,99,235,0.1)'},
  infoCardTitle: {color:'#F1F5F9', fontSize:12, fontWeight:'700'},
  infoCardSub: {color:'#64748B', fontSize:10, marginTop:1},

  // Activated styles
  activatedRoot: {flex:1, backgroundColor:Colors.background, paddingHorizontal:20},
  activatedBg: {position:'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(127,29,29,0.95)'},
  activatedHeader: {flexDirection:'row', justifyContent:'space-between', alignItems:'center', paddingTop:8, paddingBottom:12},
  activatedHeaderTitle: {color:'#FCA5A5', fontSize:14, fontWeight:'800', letterSpacing:3},
  activatedHeaderTime: {color:'rgba(252,165,165,0.6)', fontSize:12},
  activatedCenter: {alignItems:'center', justifyContent:'center', marginVertical:24, height:200},
  pingRing: {
    position:'absolute', width:208, height:208, borderRadius:104,
    backgroundColor:'rgba(239,68,68,0.18)',
  },
  activatedCircle: {width:160, height:160, borderRadius:80, backgroundColor:'#B91C1C', alignItems:'center', justifyContent:'center', shadowColor:'#DC2626', shadowOffset:{width:0,height:0}, shadowOpacity:0.7, shadowRadius:30, elevation:16},
  activatedTextWrap: {alignItems:'center', gap:6, marginBottom:20},
  activatedTitle: {color:'#FFF', fontSize:28, fontWeight:'800', textTransform:'uppercase', letterSpacing:1},
  activatedSubtitle: {color:Colors.primary, fontSize:15, fontWeight:'700'},
  mapMockCard: {borderRadius:12, overflow:'hidden', borderWidth:1, borderColor:'rgba(153,27,27,0.4)', marginBottom:12},
  mapMockHeader: {paddingHorizontal:12, paddingVertical:8, backgroundColor:'rgba(127,29,29,0.8)'},
  mapMockTitle: {color:Colors.primary, fontSize:10, fontWeight:'800', letterSpacing:2, textTransform:'uppercase'},
  mapMockBody: {height:120, backgroundColor:'#050D1A', position:'relative', alignItems:'center', justifyContent:'center'},
  mapGridH: {position:'absolute', left:0, right:0, height:0.5, backgroundColor:'rgba(37,99,235,0.2)'},
  mapGridV: {position:'absolute', top:0, bottom:0, width:0.5, backgroundColor:'rgba(37,99,235,0.2)'},
  mapPingDot: {width:20, height:20, borderRadius:10, borderWidth:2, borderColor:'rgba(239,68,68,0.6)', alignItems:'center', justifyContent:'center'},
  mapPingDotInner: {width:8, height:8, borderRadius:4, backgroundColor:'#EF4444'},
  cancelActivated: {paddingVertical:14, borderRadius:12, borderWidth:1, borderColor:'rgba(220,38,38,0.4)', alignItems:'center', marginTop:8},
  cancelActivatedText: {color:'rgba(252,165,165,0.8)', fontSize:14, fontWeight:'700'},
});
