/**
 * Mission Lead Console
 *
 * Shown to the CPO designated as `is_lead` for an active mission. Renders
 * the route summary, the 7-step waypoint timeline, and big tap-to-mark
 * buttons for the 4 manual waypoints (DISPATCH / RECON / PICKUP / DROPOFF).
 *
 * GPS push: a `Geolocation.watchPosition` watcher pushes a real fix to
 * the backend every ~10s while the screen is mounted and the mission is
 * not yet COMPLETED. Backend auto-fires CHKPT 01 / CHKPT 02 when the
 * lead's distance to dropoff drops below 50% / 20% of the precomputed
 * route distance. Permission is handled inline (Android prompt, iOS
 * `whenInUse`).
 */
import React, {useEffect, useState, useCallback, useRef} from 'react';
import {
  View, Text, ScrollView, StatusBar, StyleSheet, TouchableOpacity, Platform, AppState,
} from 'react-native';
import {Alert} from '@utils/alert';
import Geolocation from 'react-native-geolocation-service';
import {ensureLiveLocationAccess, isServicesOffError, promptEnableLocationServices} from '@utils/locationPermission';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useRoute} from '@react-navigation/native';
import type {NativeStackNavigationProp, NativeStackScreenProps} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {NavHeader, BRAND} from './_shared';
import {agentApi} from '@services/api';
import {extractMsg} from './agentFlowHelpers';
import {scaleTextStyles} from '@utils/scaling';

type Nav   = NativeStackNavigationProp<AgentStackParamList>;
type Props = NativeStackScreenProps<AgentStackParamList, 'MissionLeadConsole'>;

type WaypointTag = 'DISPATCH' | 'RECON' | 'PICKUP' | 'CHKPT 01' | 'EN ROUTE' | 'CHKPT 02' | 'DROPOFF';
type ManualTag   = 'DISPATCH' | 'RECON' | 'PICKUP' | 'DROPOFF';

interface Waypoint {
  seq: number; tag: WaypointTag; event: string; state: string;
  settled_at: string | null; marked_via: string | null;
}

const MANUAL_ORDER: ManualTag[] = ['DISPATCH', 'RECON', 'PICKUP', 'DROPOFF'];
const MANUAL_LABEL: Record<ManualTag, {title: string; sub: string; icon: string}> = {
  DISPATCH: {title: 'Crew Dispatched',  sub: 'Tap when team is in the vehicle and rolling out of HQ.',          icon: 'car-arrow-right'},
  RECON:    {title: 'Recon Cleared',    sub: 'Tap once your recon team has swept the pickup point.',           icon: 'binoculars'},
  PICKUP:   {title: 'Principal Onboard', sub: 'Tap when the principal is in the vehicle. EN ROUTE auto-fires.', icon: 'account-check-outline'},
  DROPOFF:  {title: 'Dropoff Complete', sub: 'Tap once the principal has been handed off at destination.',     icon: 'flag-checkered'},
};

/**
 * Issue 43 — this screen is BOTH a route and the body of AgentLiveTracker's
 * slide-in overlay. In the overlay the panel already owns a close control, so
 * rendering our own back chevron produced the two stacked top-left controls in
 * the report — and ours was DEAD there, because navigation.goBack() does not
 * dismiss a Modal. `embedded` suppresses it and leaves dismissal to the owner.
 */
export default function MissionLeadConsoleScreen({embedded = false}: {embedded?: boolean} = {}) {
  const insets     = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const route      = useRoute<Props['route']>();
  const {missionId} = route.params;

  const [waypoints, setWaypoints]     = useState<Waypoint[]>([]);
  const [shortCode, setShortCode]     = useState<string>('');
  const [status, setStatus]           = useState<string>('LIVE');
  const [routeDistanceM, setRouteDistanceM] = useState<number | null>(null);
  const [routeDurationS, setRouteDurationS] = useState<number | null>(null);
  const [progressPct, setProgressPct] = useState<number>(0);
  const [distToDropoff, setDistToDropoff] = useState<number | null>(null);
  const [isLead, setIsLead] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [lastAuto, setLastAuto] = useState<string[]>([]);
  // Audit H2 — telemetry health. The GPS push previously swallowed every
  // error silently, so a sustained failure (e.g. refresh-token expired so
  // the 401 auto-retry can't recover, or a dead uplink) dropped the CPO's
  // live marker on the ops map with zero indication to either side. We
  // count consecutive push failures and surface a visible "GPS not reaching
  // Ops" banner once they cross a threshold, so the CPO knows to re-auth /
  // move to signal instead of believing they're tracked.
  const telemetryFailures = useRef(0);
  const [telemetryDegraded, setTelemetryDegraded] = useState(false);
  const TELEMETRY_FAIL_THRESHOLD = 3; // ~30s of failed pushes at the 10s cadence

  const refresh = useCallback(async () => {
    try {
      const {data} = await agentApi.getMissionDeployment(missionId);
      setWaypoints(data.waypoints as Waypoint[]);
      setShortCode(data.mission?.short_code ?? '');
      setStatus(data.mission?.status ?? 'LIVE');
      setRouteDistanceM(data.mission?.route_distance_m ?? null);
      setRouteDurationS(data.mission?.route_duration_s ?? null);
      setIsLead(data.crew_role?.is_lead ?? false);
      setLastSync(new Date());
    } catch { /* transient */ }
  }, [missionId]);

  useEffect(() => {
    void refresh();
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id) {return;}
      id = setInterval(() => { void refresh(); }, 4000);
    };
    const stop = () => { if (id) { clearInterval(id); id = null; } };
    if (AppState.currentState === 'active') {start();}
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') { void refresh(); start(); }
      else {stop();}
    });
    return () => { stop(); sub.remove(); };
  }, [refresh]);

  // ── Real GPS watcher (P1-19) ────────────────────────────────────
  // Replaces the 12% advance simulator. Watches the device's position
  // and pushes a fix to the backend every ~10s. Gated on:
  //   - The user being the lead (server enforces it too)
  //   - The mission not being COMPLETED/CANCELLED/ABORTED
  //   - AppState === 'active' (paused on background to save battery)
  // Backend `pushTelemetry` returns `progress_pct` + `auto_marks`, the
  // same response the dev simulator was reading.
  const liveForGps = isLead === true
    && status !== 'COMPLETED' && status !== 'CANCELLED' && status !== 'ABORTED';
  useEffect(() => {
    if (!liveForGps) {return;}
    let cancelled = false;
    let watchId: number | null = null;
    let lastPush = 0;

    const start = async () => {
      // Permission first. Same runtime gates as AgentDashboardScreen +
      // LiveTrackingScreen so behaviour is consistent across CPO surfaces.
      // B-89 + founder requirement — on a LIVE mission ASK AGAIN when
      // access is missing (branded rationale → re-request → Settings when
      // blocked) instead of the old silent return; also detects the
      // Android 12+ approximate-only grant (MG-06).
      try {
        if (Platform.OS === 'android') {
          const grant = await ensureLiveLocationAccess({
            title: 'Share live position with ops',
            message: 'Bravo Secure needs your location while you lead this mission so ops can render your position on the live map.',
          });
          if (grant === 'denied' || grant === 'blocked') {return;}
        } else if (Platform.OS === 'ios') {
          const auth = await Geolocation.requestAuthorization('whenInUse');
          if (auth !== 'granted') {return;}
        }
      } catch { return; }
      if (cancelled) {return;}

      const onPos = async (pos: Parameters<Parameters<typeof Geolocation.watchPosition>[0]>[0]) => {
        const now = Date.now();
        if (now - lastPush < 9000) {return;} // throttle to ~10s
        lastPush = now;
        try {
          const {data} = await agentApi.pushTelemetry(missionId, {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            // Review m-7 — iOS reports course -1 when unavailable; the DTO's
            // @Min(0) then 400'd the WHOLE push. Omit invalid courses (the
            // server derives bearing from movement instead — MG-02).
            heading_deg: Number.isFinite(pos.coords.heading) && (pos.coords.heading ?? -1) >= 0
              ? pos.coords.heading as number : undefined,
            speed_kph: pos.coords.speed !== null && pos.coords.speed !== undefined ? Math.max(0, pos.coords.speed * 3.6) : undefined,
            accuracy_m: pos.coords.accuracy ?? undefined,
          });
          if (cancelled) {return;}
          // Audit H2 — a successful push clears the degraded indicator.
          // setState is called unconditionally; React no-ops when the value
          // is unchanged, so we avoid reading (and going stale on) the
          // current `telemetryDegraded` inside this long-lived closure.
          telemetryFailures.current = 0;
          setTelemetryDegraded(false);
          setLastSync(new Date());
          if (data.progress_pct !== null && data.progress_pct !== undefined) {setProgressPct(data.progress_pct);}
          if (data.distance_to_dropoff_m !== null && data.distance_to_dropoff_m !== undefined) {setDistToDropoff(data.distance_to_dropoff_m);}
          if (data.auto_marks.length > 0) {setLastAuto(data.auto_marks);}
        } catch {
          // Audit H2 — don't silently drop. A single blip is fine (keep
          // watching), but sustained failure means ops has lost our marker;
          // surface it so the CPO can act (re-auth / find signal).
          if (cancelled) {return;}
          telemetryFailures.current += 1;
          if (telemetryFailures.current >= TELEMETRY_FAIL_THRESHOLD) {
            setTelemetryDegraded(true);
          }
        }
      };
      watchId = Geolocation.watchPosition(
        pos => { void onPos(pos); },
        err => {
          // B-89 MG-05 — GPS off used to fail silently while ops lost the
          // dot. Nudge once per session with a jump to location settings.
          if (isServicesOffError(err)) {
            promptEnableLocationServices('Ops can’t see your position while you lead this mission.');
          }
        },
        {
          enableHighAccuracy: true,
          distanceFilter: 10,
          interval: 10_000,
          fastestInterval: 5_000,
          // MG-05 — let the OS offer its own "turn on location" resolution.
          showLocationDialog: true,
        },
      );
    };
    void start();
    return () => {
      cancelled = true;
      if (watchId !== null) {
        Geolocation.clearWatch(watchId);
        watchId = null;
      }
    };
  }, [missionId, liveForGps]);

  const stateOf = (tag: WaypointTag) => waypoints.find(w => w.tag === tag)?.state ?? 'pending';

  async function mark(tag: ManualTag) {
    if (busy) {return;}
    if (isLead === false) {
      Alert.alert('Only the team lead can mark waypoints.');
      return;
    }
    setBusy(tag);
    try {
      const {data} = await agentApi.markWaypoint(missionId, tag);
      if (data.auto_marks.length > 0) {setLastAuto(data.auto_marks);}
      await refresh();
    } catch (e) {
      Alert.alert('Mark failed', extractMsg(e));
    } finally { setBusy(null); }
  }

  // pushSim removed — replaced by the real GPS watcher above. The mock
  // existed because there was no native rebuild path in dev; with
  // `react-native-geolocation-service` already linked (used by
  // AgentDashboardScreen + LiveTrackingScreen) the simulator was dead
  // weight that masked the real production wiring.

  const totalKm = routeDistanceM !== null ? (routeDistanceM / 1000).toFixed(1) : '—';
  const etaMin  = routeDurationS !== null ? Math.round(routeDurationS / 60).toString() : '—';
  const remainingM = distToDropoff;
  const remainingKm = remainingM !== null ? (remainingM / 1000).toFixed(1) : null;

  return (
    <View style={[s.root, {paddingTop: embedded ? 0 : insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      <NavHeader
        title={`Mission ${shortCode || '—'}`}
        onBack={embedded ? undefined : () => navigation.goBack()}
      />

      <ScrollView style={{flex: 1}} contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {isLead === false && (
          <View style={s.notLeadBanner}>
            <Icon name="information-outline" size={14} color={BRAND.warn} />
            <Text style={s.notLeadText}>
              You&apos;re assigned to this mission but not the lead. Only the lead can mark waypoints.
            </Text>
          </View>
        )}

        {/* Hero — route summary */}
        <View style={s.hero}>
      <ImageryBackdrop source={Imagery.opsCenter} variant="hero" radius={12} />
          <View style={{flexDirection:'row', alignItems:'center', gap:8, marginBottom:8}}>
            <View style={[s.dot, {backgroundColor: status === 'LIVE' ? BRAND.ok : BRAND.warn}]} />
            <Text style={s.heroStatus}>{status}{isLead ? '  ·  TEAM LEAD' : ''}</Text>
            {lastSync && !telemetryDegraded && (
              <Text style={s.heroSync}>
                · sync {lastSync.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'})}
              </Text>
            )}
          </View>
          {/* Audit H2 — telemetry-degraded banner. Ops has lost the live
              marker; tell the CPO explicitly instead of letting the stale
              "sync" timestamp imply they're still tracked. */}
          {telemetryDegraded && (
            <View style={s.telemetryWarn}>
              <Text style={s.telemetryWarnText}>
                ⚠ GPS not reaching Ops — check signal. If this persists, sign out and back in.
              </Text>
            </View>
          )}
          <View style={s.heroRow}>
            <View style={s.heroCell}>
              <Text style={s.heroK}>ROUTE</Text>
              <Text style={s.heroV}>{totalKm} km</Text>
            </View>
            <View style={s.heroCell}>
              <Text style={s.heroK}>ETA</Text>
              <Text style={s.heroV}>{etaMin} min</Text>
            </View>
            <View style={s.heroCell}>
              <Text style={s.heroK}>PROGRESS</Text>
              <Text style={[s.heroV, {color: progressPct >= 80 ? BRAND.ok : Colors.textPrimary}]}>
                {progressPct}%
              </Text>
            </View>
            <View style={s.heroCell}>
              <Text style={s.heroK}>REMAINING</Text>
              <Text style={s.heroV}>{remainingKm !== null ? `${remainingKm} km` : '—'}</Text>
            </View>
          </View>

          {/* Progress bar with checkpoint tick marks */}
          <View style={s.bar}>
            <View style={[s.barFill, {width: `${progressPct}%`}]} />
            <View style={[s.barTick, {left: '50%'}]} />
            <View style={[s.barTick, {left: '80%'}]} />
          </View>
          <View style={s.barRow}>
            <Text style={s.barLbl}>0%</Text>
            <Text style={s.barLbl}>CHKPT 01</Text>
            <Text style={s.barLbl}>CHKPT 02</Text>
            <Text style={s.barLbl}>DROP</Text>
          </View>
        </View>

        {/* Manual mark buttons */}
        {isLead !== false && (
          <View style={{marginTop: 14, gap: 8}}>
            <Text style={s.sectionLabel}>MANUAL MARKS · LEAD ONLY</Text>
            {MANUAL_ORDER.map(tag => {
              const st = stateOf(tag);
              const wp = waypoints.find(w => w.tag === tag);
              const meta = MANUAL_LABEL[tag];
              const done = st === 'done';
              const isBusy = busy === tag;
              return (
                <TouchableOpacity
                  key={tag}
                  disabled={done || isBusy}
                  onPress={() => { void mark(tag); }}
                  style={[
                    s.markBtn,
                    done && {borderColor: BRAND.ok, backgroundColor: 'rgba(0,200,83,0.08)'},
                  ]}>
                  <View style={[s.markIcon, done && {borderColor: BRAND.ok, backgroundColor: 'rgba(0,200,83,0.18)'}]}>
                    <Icon
                      name={(done ? 'check-bold' : meta.icon) as React.ComponentProps<typeof Icon>['name']}
                      size={18}
                      color={done ? BRAND.ok : Colors.primary}
                    />
                  </View>
                  <View style={{flex:1, minWidth:0}}>
                    <Text style={s.markTitle}>{meta.title}</Text>
                    <Text style={s.markSub}>
                      {done && wp?.settled_at
                        ? `MARKED ${new Date(wp.settled_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`
                        : meta.sub}
                    </Text>
                  </View>
                  <Text style={[
                    s.markBadge,
                    done && {color: BRAND.ok},
                    isBusy && {color: BRAND.warn},
                  ]}>
                    {isBusy ? '…' : done ? 'DONE' : 'TAP'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Waypoint timeline (read-only mirror of all 7) */}
        <Text style={[s.sectionLabel, {marginTop: 16}]}>WAYPOINT TIMELINE</Text>
        {waypoints.map(w => {
          const done = w.state === 'done';
          const auto = w.marked_via?.startsWith('auto');
          return (
            <View key={w.seq} style={s.wpRow}>
              <View style={[s.wpDot, done && {backgroundColor: BRAND.ok}]}>
                <Text style={[s.wpDotText, done && {color: '#04101F'}]}>{done ? '✓' : w.seq}</Text>
              </View>
              <View style={{flex:1, minWidth:0}}>
                <Text style={s.wpTag}>
                  {w.tag}
                  {auto && <Text style={s.wpAuto}>  · AUTO</Text>}
                </Text>
                <Text style={s.wpEvent}>{w.event}</Text>
              </View>
              <Text style={s.wpTs}>
                {w.settled_at
                  ? new Date(w.settled_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
                  : '—:—'}
              </Text>
            </View>
          );
        })}

        {lastAuto.length > 0 && (
          <View style={s.autoBanner}>
            <Icon name="map-marker-check" size={14} color={BRAND.ok} />
            <Text style={s.autoBannerText}>
              Auto-marked: {lastAuto.join(' · ')}
            </Text>
          </View>
        )}

        {/* GPS telemetry status — auto-pushed every ~10s by the watcher
            above. The ops live map renders the lead's position from these
            samples; no manual action needed. */}
        {isLead !== false && (
          <View style={{marginTop: 16, gap: 8}}>
            <Text style={s.sectionLabel}>GPS TELEMETRY</Text>
            <View style={[s.gpsBtn, {opacity: 0.85}]}>
              <Icon
                name={liveForGps ? 'crosshairs-gps' : 'crosshairs-off'}
                size={18}
                color="#04101F"
              />
              <Text style={s.gpsBtnText}>
                {liveForGps ? 'AUTO-PUSHING POSITION ~10s' : 'GPS PAUSED'}
              </Text>
            </View>
            <Text style={s.gpsHelp}>
              Your device automatically posts a GPS sample to ops every ~10 seconds while this screen is open. Backend auto-fires CHKPT 01 / CHKPT 02 once distance to dropoff crosses the 50% / 20% thresholds.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  scroll: {padding: 14, paddingBottom: 32},

  notLeadBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 10, borderRadius: 8,
    backgroundColor: 'rgba(255,193,7,0.08)',
    borderWidth: 1, borderColor: 'rgba(255,193,7,0.4)',
    marginBottom: 12,
  },
  notLeadText: {
    flex: 1, fontFamily: BravoFont.regular, fontSize: 11,
    color: Colors.textSecondary, lineHeight: 15,
  },

  hero: {
    padding: 14, borderRadius: 12,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.primary,
  },
  dot: {width: 8, height: 8, borderRadius: 4},
  heroStatus: {
    fontFamily: BravoFont.extraBold, fontSize: 10, letterSpacing: 1.5,
    color: Colors.textPrimary,
  },
  heroSync: {fontFamily: BravoFont.mono, fontSize: 9, color: Colors.textMuted},
  telemetryWarn: {marginTop: 8, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.5)'},
  telemetryWarnText: {fontFamily: BravoFont.mono, fontSize: 10, color: '#FCA5A5', lineHeight: 14},
  heroRow: {flexDirection: 'row', gap: 10, marginTop: 4},
  heroCell: {flex: 1},
  heroK: {fontFamily: BravoFont.mono, fontSize: 8.5, color: Colors.textMuted, letterSpacing: 1.2, fontWeight: '700'},
  heroV: {fontFamily: BravoFont.extraBold, fontSize: 16, color: Colors.textPrimary, marginTop: 4},

  bar: {
    height: 8, borderRadius: 4, marginTop: 14,
    backgroundColor: Colors.surfaceOverlay, position: 'relative', overflow: 'hidden',
  },
  barFill: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    backgroundColor: Colors.primary,
  },
  barTick: {
    position: 'absolute', top: -2, bottom: -2, width: 1,
    backgroundColor: Colors.borderDefault,
  },
  barRow: {flexDirection: 'row', justifyContent: 'space-between', marginTop: 4},
  barLbl: {fontFamily: BravoFont.mono, fontSize: 8.5, color: Colors.textMuted, letterSpacing: 0.4},

  sectionLabel: {
    fontFamily: BravoFont.extraBold, fontSize: 9.5, letterSpacing: 1.5,
    color: Colors.textMuted, textTransform: 'uppercase',
  },

  markBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  markIcon: {
    width: 38, height: 38, borderRadius: 9,
    backgroundColor: Colors.backgroundDepth,
    borderWidth: 1, borderColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  markTitle: {
    fontFamily: BravoFont.extraBold, fontSize: 12.5, color: Colors.textPrimary,
    letterSpacing: 0.4, textTransform: 'uppercase',
  },
  markSub: {fontSize: 10, color: Colors.textSecondary, marginTop: 2, lineHeight: 14},
  markBadge: {
    fontFamily: BravoFont.extraBold, fontSize: 10, letterSpacing: 1.2,
    color: Colors.primary,
  },

  wpRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
  },
  wpDot: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: Colors.surfaceOverlay,
    alignItems: 'center', justifyContent: 'center',
  },
  wpDotText: {fontFamily: BravoFont.extraBold, fontSize: 10, color: Colors.textSecondary},
  wpTag: {fontFamily: BravoFont.extraBold, fontSize: 10, color: Colors.primary, letterSpacing: 1},
  wpAuto: {fontSize: 8, color: Colors.textMuted, fontFamily: BravoFont.mono},
  wpEvent: {fontSize: 11, color: Colors.textPrimary, marginTop: 1},
  wpTs: {fontFamily: BravoFont.mono, fontSize: 10, color: Colors.textSecondary},

  autoBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 10, borderRadius: 8, marginTop: 12,
    backgroundColor: 'rgba(0,200,83,0.08)',
    borderWidth: 1, borderColor: 'rgba(0,200,83,0.4)',
  },
  autoBannerText: {
    flex: 1, fontFamily: BravoFont.mono, fontSize: 10.5, color: BRAND.ok,
    fontWeight: '700', letterSpacing: 0.5,
  },

  gpsBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: 10, backgroundColor: BRAND.ok,
  },
  gpsBtnText: {
    fontFamily: BravoFont.extraBold, fontSize: 12, letterSpacing: 1.2, color: '#04101F',
  },
  gpsHelp: {
    fontSize: 10, color: Colors.textSecondary, lineHeight: 14, fontFamily: BravoFont.regular,
  },
}));
