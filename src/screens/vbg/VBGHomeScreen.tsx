import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  Animated,
  Linking,
  Image,
  type DimensionValue,
  type ImageSourcePropType,
} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useAuthStore} from '@store/authStore';
import {isProActive} from '@utils/tier';
import {vbgApi, type VbgKeyPoint, type VbgFavorite} from '@/services/api';
import {ensureVbgTelemetry} from '@/services/vbgTelemetry';
import {useVbgLocation} from './useVbgLocation';
import {VbgFooter} from './VbgFooter';
import {GeoRiskPanel} from './VBGGeoRiskScreen';
import {switchProduct} from '@store/productStore';
import {confirmProductSwitch} from '@navigation/productSwitch';
import {ProfileDrawerModal} from '@components/ProfileDrawerModal';
import {NextOfKinModal} from './NextOfKinModal';
import {LocationHistoryModal} from './LocationHistoryModal';
import {VbgKeyPointsMap} from './VbgKeyPointsMap';
import {VbgScanPrompt} from './VbgScanPrompt';
import {recordEmergencyCall} from '@store/emergencyCallLog';
import {setLastKnownCountry} from './lastKnownCountry';
import {countryNameFromContext} from './resolveEmergencyCountry';
import {
  VBG, VbgScreen, VbgCard, SectionLabel, RiskBadge, PillButton,
  TacticalMap, LocatorDot,
} from './vbgUi';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

const KIND_LABEL: Record<VbgKeyPoint['kind'], {label: string; color: string}> = {
  embassy:  {label: 'Embassy', color: VBG.amber},
  police:   {label: 'Police', color: VBG.accent},
  hospital: {label: 'Medical', color: VBG.signal},
  fire:     {label: 'Fire', color: '#FF7A5C'},
};

export default function VBGHomeScreen() {
  const navigation = useNavigation<Nav>();
  const {fix, ready} = useVbgLocation();
  const {user} = useAuthStore();

  // Principal = the signed-in user (no hardcoded name/role).
  const principalName = user?.full_name ?? user?.email ?? 'Principal';
  const principalInitials = principalName.split(/[\s@.]/).filter(Boolean).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || 'B';
  const tierLabel = isProActive(user) ? 'PRO' : 'VIP';

  // Region-based: live threat counts + nearest key points for this GPS fix.
  const [region, setRegion] = useState<string | null>(null);
  // Country name (last segment of the geocode context) — passed to the
  // emergency screen so it pins the principal's country at the top. The ISO
  // code from the reverse geocode is preferred (audit L-5 — name matching is
  // fragile for variant spellings).
  const [countryName, setCountryName] = useState<string | null>(null);
  const [countryIso, setCountryIso] = useState<string | null>(null);
  // Audit M-3 — the geofence badge reflects the user's REAL zones (null =
  // still loading), never a hardcoded "Active".
  const [geofenceCount, setGeofenceCount] = useState<number | null>(null);
  const [criticalCount, setCriticalCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [nearby, setNearby] = useState<VbgKeyPoint[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  // True once the first threats response settles (success OR failure), so the
  // dashboard can show placeholders instead of confirmed-looking '0'/Low while
  // the first fetch is still in flight. `threatsError` drives an inline retry.
  const [threatsReady, setThreatsReady] = useState(false);
  const [threatsError, setThreatsError] = useState(false);

  // Next-of-Kin favorites (server-backed). Loaded on mount; the action always
  // opens the unified sheet (list + call + edit + add).
  const [favorites, setFavorites] = useState<VbgFavorite[]>([]);
  const [kinModal, setKinModal] = useState(false);
  const [historyModal, setHistoryModal] = useState(false);

  useEffect(() => {
    let alive = true;
    void vbgApi.listFavorites()
      .then(r => { if (alive) {setFavorites(r.data.favorites);} })
      .catch(() => {});
    void vbgApi.listGeofences()
      .then(r => { if (alive) {setGeofenceCount(r.data.zones.length);} })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const dial = useCallback((phone: string, label?: string) => {
    const sanitised = phone.replace(/[^\d+]/g, '');
    // PDF item 08 — the next-of-kin lane. `NextOfKinModal` funnels every kin
    // call through here by design ("the tel: logic lives in one place"), so
    // recording here covers the sheet too without a second call site.
    recordEmergencyCall({sanitised, label, source: 'next-of-kin'});
    Linking.openURL(`tel:${sanitised}`).catch(() => {});
  }, []);

  // Phone Next of Kin: always open the sheet — it lists the saved contacts to
  // call, and lets you add/edit them inline. (No more direct-dial-on-one.)
  const handleNextOfKin = useCallback(() => { setKinModal(true); }, []);

  const onFavoritesSaved = useCallback((next: VbgFavorite[]) => {
    setFavorites(next);
  }, []);

  // Reusable so the inline "retry" affordance can re-pull on demand.
  const pullThreats = useCallback(() => {
    setThreatsError(false);
    void vbgApi.threats(fix ?? {}).then(r => {
      setRegion(r.data.region);
      if (r.data.country) {setCountryIso(r.data.country);}
      // Context is "Locality, District, City, Country" — the last segment is
      // the country, used to pin emergency numbers for the principal's place.
      const ctxCountry = countryNameFromContext(r.data.context);
      if (ctxCountry) {setCountryName(ctxCountry);}
      // 2026-08-24 — persist the geocoded country so the emergency directory's
      // "YOUR LOCATION" card is location-based from EVERY entry point (the
      // messenger Calls banner opens it with no params), not just this one.
      if (r.data.country || ctxCountry) {
        void setLastKnownCountry({iso: r.data.country ?? null, name: ctxCountry});
      }
      setCriticalCount(r.data.counts.critical);
      setAlertCount(r.data.counts.critical + r.data.counts.caution);
      setUpdatedAt(Date.now());
      setThreatsError(false);
    }).catch(() => { setThreatsError(true); })
      .finally(() => { setThreatsReady(true); });
  }, [fix]);

  useEffect(() => {
    if (!ready) {return;}
    let alive = true;
    pullThreats();
    void vbgApi.keypoints(fix ?? {}).then(r => { if (alive) {setNearby(r.data.keypoints);} }).catch(() => {});
    // Poll region threats every 45s so the dashboard stays current.
    const id = setInterval(() => { if (alive) {pullThreats();} }, 45_000);
    return () => { alive = false; clearInterval(id); };
  }, [ready, fix, pullThreats]);

  // BE-7.1 — encrypted telemetry lives in the app-wide service now (audit
  // H-3): it keeps running after the principal leaves this screen. The
  // ensure call is idempotent and a no-op until a key is enrolled.
  useEffect(() => { void ensureVbgTelemetry(); }, []);

  const updatedLabel = updatedAt ? `Updated ${agoLabel(updatedAt)}` : 'Syncing…';
  const alerting = criticalCount > 0;

  const [panicDone, setPanicDone] = useState(false);
  const VBG_PANIC_ENABLED = false; // founder 2026-08-01 — inactive on VBG for now
  const panicAnim = useRef(new Animated.Value(0)).current;
  const panicTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePanicIn = () => {
    Animated.timing(panicAnim, {toValue: 1, duration: 1600, useNativeDriver: false}).start();
    panicTimer.current = setTimeout(() => {
      setPanicDone(true);
      // BE-7.1 — panic fans out SOS + SMS + WS server-side, all in one call.
      void vbgApi.panic(fix ?? {}).catch(() => {});
    }, 1600);
  };
  const handlePanicOut = () => {
    if (panicTimer.current) {clearTimeout(panicTimer.current);}
    if (!panicDone) {Animated.timing(panicAnim, {toValue: 0, duration: 180, useNativeDriver: false}).start();}
  };
  // Cancel a held panic timer on unmount — otherwise holding then navigating
  // away within 1.6s fires setPanicDone + vbgApi.panic() after unmount (an
  // unintended SOS/SMS fan-out + a setState-on-unmounted warning).
  useEffect(() => () => { if (panicTimer.current) {clearTimeout(panicTimer.current);} }, []);
  const panicWidth = panicAnim.interpolate({inputRange: [0, 1], outputRange: ['0%', '100%']}) as unknown as DimensionValue;

  return (
    <VbgScreen footer={<VbgFooter />}>
      <NextOfKinModal
        visible={kinModal}
        initial={favorites}
        onClose={() => setKinModal(false)}
        onSaved={onFavoritesSaved}
        onDial={dial}
      />
      <LocationHistoryModal visible={historyModal} onClose={() => setHistoryModal(false)} />
      <ProfileDrawerModal visible={drawerOpen} onClose={() => setDrawerOpen(false)} />
      {/* Top bar — B-91 M2 R7: top-left profile control opens the shared
          account drawer (Switch Dashboard lives inside it). */}
      <View style={styles.topbar}>
        <TouchableOpacity
          style={styles.topbarAvatar}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Open profile drawer"
          onPress={() => setDrawerOpen(true)}>
          {user?.avatar_url ? (
            <Image source={{uri: user.avatar_url}} style={styles.topbarAvatarImg} />
          ) : (
            <Text style={styles.topbarAvatarText}>
              {(user?.full_name ?? user?.email ?? 'B').slice(0, 2).toUpperCase()}
            </Text>
          )}
        </TouchableOpacity>
        <SectionLabel style={{fontSize: 11, letterSpacing: 2.4, flexShrink: 1, minWidth: 0}} numberOfLines={1}>Virtual Dashboard</SectionLabel>
        {/* PROTECTED (green) / ALERT (red) — driven by live critical count */}
        <View style={[styles.statusBadge, alerting ? styles.statusAlert : styles.statusOk]}>
          <View style={[styles.statusDot, {backgroundColor: alerting ? VBG.alert : VBG.signal, shadowColor: alerting ? VBG.alert : VBG.signal}]} />
          <Text style={[styles.statusText, {color: alerting ? '#FF8B8B' : VBG.signal}]}>
            {alerting ? 'ALERT' : 'PROTECTED'}
          </Text>
        </View>
      </View>

      <View style={styles.body}>
        {/* Scheduled biometric check-in — renders only when a scan is due (H-2). */}
        <VbgScanPrompt fix={fix} />

        {/* Principal */}
        <VbgCard rail="#818CF8" pad={15}>
          <SectionLabel style={{marginBottom: 11}}>Principal</SectionLabel>
          <View style={styles.principalRow}>
            <View style={styles.portrait}><Text style={styles.portraitText}>{principalInitials}</Text></View>
            <View style={{flex: 1, minWidth: 0}}>
              <View style={styles.principalNameRow}>
                <Text style={styles.principalName} numberOfLines={1}>{principalName}</Text>
                <View style={styles.sosTag}><Text style={styles.sosTagText}>{tierLabel}</Text></View>
              </View>
              <Text style={styles.principalSub} numberOfLines={1}>
                <Text style={{color: alerting ? VBG.alert : VBG.signal, fontWeight: '600'}}>{alerting ? 'Alert' : 'Active'}</Text> · {updatedLabel}
              </Text>
            </View>
          </View>
        </VbgCard>

        {/* Live location */}
        <VbgCard pad={14} img={Imagery.vbgLiveLocation} imgVariant="card">
          <View style={styles.cardHead}>
            <SectionLabel dot={VBG.signal}>Live Location</SectionLabel>
            {/* Audit M-3 — honest badge: reflects the user's real zones. */}
            {geofenceCount === null ? null : geofenceCount > 0 ? (
              <RiskBadge level="low" small>Geofence Active</RiskBadge>
            ) : (
              <RiskBadge level="info" small>No Geofence</RiskBadge>
            )}
          </View>
          {/* Audit M-9 — a REAL map of the principal + nearby key points; the
              schematic TacticalMap remains only as the no-fix placeholder. */}
          {fix ? (
            <View>
              <VbgKeyPointsMap
                centre={fix}
                points={nearby}
                onExpand={() => navigation.navigate('VBGMap')}
                style={styles.miniMap}
              />
              <View style={styles.enRoute} pointerEvents="none">
                <Text style={styles.enRouteText}>{region ? `LOCATED · ${region.toUpperCase()}` : 'LOCATING…'}</Text>
              </View>
            </View>
          ) : (
            <TacticalMap height={132} route radius={13}>
              <LocatorDot x={46} y={56} />
              <View style={styles.enRoute}>
                <Text style={styles.enRouteText}>{region ? `LOCATED · ${region.toUpperCase()}` : 'LOCATING…'}</Text>
              </View>
            </TacticalMap>
          )}
          <View style={styles.statRow}>
            <Stat label="Alerts" value={threatsReady ? String(alertCount) : '—'} unit="live" />
            <Stat label="Critical" value={threatsReady ? String(criticalCount) : '—'} unit="now" />
          </View>
          {threatsError ? (
            <TouchableOpacity style={styles.retryStrip} activeOpacity={0.8} onPress={pullThreats}>
              <Text style={styles.retryStripText}>Threat feed unreachable · TAP TO RETRY</Text>
            </TouchableOpacity>
          ) : null}
          <View style={styles.btnRow}>
            <PillButton variant="primary" full style={{flex: 1}} onPress={() => navigation.navigate('VBGMap')}>
              <Text style={styles.pillPrimaryText}>VIEW ON MAP</Text>
            </PillButton>
            <PillButton full style={{flex: 1}} onPress={() => setHistoryModal(true)}>
              <Text style={styles.pillGhostText}>LOCATION HISTORY</Text>
            </PillButton>
          </View>
        </VbgCard>

        {/* Three intel cards — all region-driven */}
        <View style={styles.miniGrid}>
          <MiniCard label="Security Risk" img={Imagery.vbgSecurityRisk} onLink={() => navigation.navigate('VBGSRA')} linkText="View SRA">
            {threatsReady ? (
              <RiskBadge level={criticalCount >= 3 ? 'critical' : criticalCount >= 1 ? 'elevated' : 'low'} small>
                {criticalCount >= 3 ? 'High' : criticalCount >= 1 ? 'Elevated' : 'Low'}
              </RiskBadge>
            ) : (
              <Text style={styles.miniDesc}>Assessing…</Text>
            )}
          </MiniCard>
          {/* B-91 M2 R2 — OSINT tile removed from the Home sequence (spec
              p.16): intelligence lives in the News Feed tab. */}
          <MiniCard label="Nearby" img={Imagery.vbgNearby} onLink={() => navigation.navigate('VBGNearby')} linkText="View Map">
            {nearby.length === 0 ? (
              <Text style={styles.miniDesc}>Locating…</Text>
            ) : (
              dedupeNearby(nearby).slice(0, 3).map((kp, i) => (
                <NearRow key={i} c={KIND_LABEL[kp.kind].color} k={KIND_LABEL[kp.kind].label} v={kp.distanceKm.toFixed(1)} />
              ))
            )}
          </MiniCard>
        </View>

        {/* Quick actions */}
        <SectionLabel style={{marginLeft: 2, marginBottom: 9, marginTop: 4}}>Quick Actions</SectionLabel>
        {/* Founder 2026-08-01 — the VBG panic hold is INACTIVE for now (a
            mistaken hold had no undo). Secure Services keeps its live SOS,
            which already has the Cancel SOS stand-down path. Handlers stay
            wired above so re-enabling is flipping this flag. */}
        <Pressable
          onPressIn={VBG_PANIC_ENABLED ? handlePanicIn : undefined}
          onPressOut={VBG_PANIC_ENABLED ? handlePanicOut : undefined}
          accessibilityState={{disabled: !VBG_PANIC_ENABLED}}
          style={[styles.panic, !VBG_PANIC_ENABLED && styles.panicDisabled]}>
          <Animated.View style={[styles.panicFill, {width: panicWidth}]} />
          <Text style={styles.panicText}>{panicDone ? '✓ Bravo Control System Alerted' : 'Hold to Alert Bravo Control System'}</Text>
          {!VBG_PANIC_ENABLED ? <Text style={styles.panicSoon}>COMING SOON</Text> : null}
        </Pressable>
        <View style={styles.actionGrid}>
          <ActionTile
            title="Contact Emergency Services" tint="blue" img={Imagery.vbgEmergencyCall}
            icon={<Path d="M5 4h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5V18a2 2 0 0 1-2 2A14 14 0 0 1 5 6a2 2 0 0 1 0-2Z" stroke="#A9C5FF" strokeWidth={1.6} fill="none" strokeLinejoin="round" />}
            onPress={() => navigation.navigate('VBGEmergency', (countryName ?? countryIso)
              ? {countryName: countryName ?? undefined, countryIso: countryIso ?? undefined}
              : undefined)}
          />
          <ActionTile
            title="Phone Next of Kin" tint="blue" img={Imagery.vbgNextOfKin}
            icon={<><Path d="M16 11a4 4 0 1 0-4-4" stroke="#A9C5FF" strokeWidth={1.6} fill="none" strokeLinecap="round" /><Path d="M3 20a6 6 0 0 1 12 0" stroke="#A9C5FF" strokeWidth={1.6} fill="none" strokeLinecap="round" /><Path d="M18 9v6M15 12h6" stroke="#A9C5FF" strokeWidth={1.6} strokeLinecap="round" /></>}
            onPress={handleNextOfKin}
          />
          <ActionTile
            title="Request Support" tint="blue" img={Imagery.vbgRequestSupport}
            icon={<Path d="M12 3l8 3v6c0 4.5-3.2 8.3-8 9-4.8-.7-8-4.5-8-9V6l8-3Z" stroke="#A9C5FF" strokeWidth={1.6} fill="none" strokeLinejoin="round" />}
            // Founder 2026-08-01 — inactive until the dedicated
            // support-request flow ships (INDEX Q9); the old messenger hop
            // read as broken.
            disabled
          />
          <ActionTile
            title="Secure Services" tint="indigo" highlight
            icon={<Path d="M5 16l1.5-5h11L19 16M6 16h12v3H6zM8 19v1M16 19v1" stroke="#A9C5FF" strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
            // Spec p.17 — opens the Secure Services product/booking flow.
            // B-352 — record the origin so back at the Secure root returns to
            // this dashboard instead of ejecting to the product gate.
            //
            // vs2 edge A5 — this is a CROSS-PRODUCT switch and was the one door
            // doing it bare: no confirm, no ring warning, and no minimise. The
            // last is the damaging one — `switchProduct` is a plain store write
            // and the shell is keyed on it, so the remount is a raw unmount that
            // never dispatches `beforeRemove`, and a full-screen live call was
            // destroyed with no way back. All three now come from THE shared
            // pre-flight, so this door cannot drift from the others again.
            onPress={() => confirmProductSwitch(
              'Secure Services',
              () => switchProduct('secure', undefined, 'vbg'),
            )}
          />
        </View>

        {/* B-91 M2 R3 — the live-monitoring card is deleted (spec
            p.17) and GeoRisk continues INLINE on the same scroll, so the
            page runs Principal → map → SRA/Nearby → Quick Actions → Run
            Security Analysis without changing tabs. */}
        <SectionLabel style={{marginLeft: 2, marginBottom: 9, marginTop: 10}}>GeoRisk Analysis</SectionLabel>
        <GeoRiskPanel />
      </View>
    </VbgScreen>
  );
}

function agoLabel(at: number): string {
  const m = Math.floor((Date.now() - at) / 60000);
  if (m < 1) {return 'just now';}
  if (m < 60) {return `${m} min ago`;}
  return `${Math.floor(m / 60)}h ago`;
}

// One row per kind (nearest), so the 3-slot mini card shows variety.
function dedupeNearby(kps: VbgKeyPoint[]): VbgKeyPoint[] {
  const seen = new Set<string>();
  const out: VbgKeyPoint[] = [];
  for (const kp of kps) {
    if (seen.has(kp.kind)) {continue;}
    seen.add(kp.kind);
    out.push(kp);
  }
  return out;
}

function Stat({label, value, unit}: {label: string; value: string; unit: string}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text>
        <Text style={styles.statValue}>{value}</Text>
        <Text style={styles.statUnit}> {unit}</Text>
      </Text>
    </View>
  );
}

function MiniCard({label, children, linkText, onLink, img}: {
  label: string; children: React.ReactNode; linkText: string; onLink?: () => void;
  img?: ImageSourcePropType;
}) {
  return (
    <VbgCard pad={11} radius={14} style={styles.miniCard} img={img} imgVariant="card">
      <Text style={styles.miniLabel}>{label}</Text>
      <View style={styles.miniContent}>{children}</View>
      <TouchableOpacity activeOpacity={0.7} onPress={onLink} style={styles.miniLink}>
        <Text style={styles.miniLinkText}>{linkText}</Text>
        <Svg width={6} height={10} viewBox="0 0 8 14"><Path d="M1 1l6 6-6 6" stroke="#A9C5FF" strokeWidth={1.7} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
      </TouchableOpacity>
    </VbgCard>
  );
}

function NearRow({c, k, v}: {c: string; k: string; v: string}) {
  return (
    <View style={styles.nearRow}>
      <View style={[styles.nearDot, {backgroundColor: c, shadowColor: c}]} />
      <Text style={styles.nearKey}>{k}</Text>
      <Text style={styles.nearVal}>{v}<Text style={{color: VBG.textMute}}> km</Text></Text>
    </View>
  );
}

function ActionTile({tint, title, icon, highlight, onPress, disabled, img}: {
  tint: 'blue' | 'indigo'; title: string; icon: React.ReactNode; highlight?: boolean; onPress?: () => void;
  /** Inactive tile — dimmed, non-tappable, labelled "Coming Soon". */
  disabled?: boolean;
  /** Brand art behind the tile (founder drop 2026-08-31), `wide`-plated. */
  img?: ImageSourcePropType;
}) {
  const map = {
    blue:   {bg: 'rgba(255,255,255,0.03)', bd: VBG.hair2},
    indigo: {bg: 'rgba(91,141,239,0.12)', bd: 'rgba(91,141,239,0.42)'},
  }[tint];
  return (
    <TouchableOpacity activeOpacity={disabled ? 1 : 0.85} onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityState={{disabled: !!disabled}}
      style={[styles.actionTile, {backgroundColor: map.bg, borderColor: highlight ? 'rgba(91,141,239,0.55)' : map.bd}, disabled && styles.actionTileDisabled]}>
      {/* `card`, not `art` — see the DepartmentalHomeScreen note. A tile title
          like "Contact Emergency Services" wraps across ~90% of the tile, so a
          horizontal scrim leaves its tail on bare photo. */}
      {!!img && <ImageryBackdrop source={img} variant="card" radius={13} />}
      <Svg width={17} height={17} viewBox="0 0 24 24" fill="none">{icon}</Svg>
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={[styles.actionTitle, {flex: 0}]} numberOfLines={2}>{title}</Text>
        {disabled ? <Text style={styles.actionSoon}>COMING SOON</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  topbar: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 14},
  topbarSpacer: {width: 34, height: 34},
  topbarAvatar: {
    width: 34, height: 34, borderRadius: 17, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
  },
  topbarAvatarImg: {width: 34, height: 34, borderRadius: 17},
  topbarAvatarText: {color: '#A9C5FF', fontSize: 11, fontWeight: '800'},
  statusBadge: {flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999, borderWidth: 1},
  statusOk: {backgroundColor: VBG.signalDim, borderColor: 'rgba(74,222,128,0.34)'},
  statusAlert: {backgroundColor: VBG.alertDim, borderColor: 'rgba(255,93,93,0.34)'},
  statusDot: {width: 7, height: 7, borderRadius: 4, shadowOpacity: 0.9, shadowRadius: 5, shadowOffset: {width: 0, height: 0}},
  statusText: {fontSize: 9, fontWeight: '700', letterSpacing: 1.2},

  body: {paddingHorizontal: 18, gap: 11},

  principalRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  portrait: {width: 48, height: 48, borderRadius: 13, borderWidth: 1, borderColor: VBG.hair2, backgroundColor: 'rgba(91,141,239,0.08)', alignItems: 'center', justifyContent: 'center'},
  portraitText: {fontSize: 8, color: VBG.textMute, letterSpacing: 0.5, fontWeight: '700'},
  principalNameRow: {flexDirection: 'row', alignItems: 'center', gap: 7},
  principalName: {flexShrink: 1, minWidth: 0, fontSize: 16.5, fontWeight: '700', color: VBG.text, letterSpacing: -0.3},
  sosTag: {flexShrink: 0, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, backgroundColor: 'rgba(255,93,93,0.13)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.3)'},
  sosTagText: {fontSize: 7, fontWeight: '800', color: '#FF8B8B', letterSpacing: 0.6},
  principalSub: {fontSize: 11, color: VBG.textDim, marginTop: 4},
  miniBtnText: {fontSize: 8.5, fontWeight: '700', letterSpacing: 1.2, color: VBG.text},

  cardHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11},
  miniMap: {height: 132, borderRadius: 13},
  enRoute: {position: 'absolute', left: '50%', bottom: 10, transform: [{translateX: -64}], backgroundColor: 'rgba(7,12,22,0.8)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999},
  enRouteText: {fontSize: 9, letterSpacing: 1.4, color: '#A9C5FF', fontWeight: '600'},

  statRow: {flexDirection: 'row', gap: 10, marginVertical: 12},
  retryStrip: {marginBottom: 10, paddingVertical: 8, borderRadius: 9, alignItems: 'center', backgroundColor: 'rgba(255,93,93,0.08)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.28)'},
  retryStripText: {fontSize: 9.5, fontWeight: '700', color: '#FF8B8B', letterSpacing: 0.6},
  stat: {flex: 1, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: VBG.hair},
  statLabel: {fontSize: 8.5, color: VBG.textMute, letterSpacing: 1.4, textTransform: 'uppercase'},
  statValue: {fontSize: 21, fontWeight: '700', color: VBG.text, letterSpacing: -0.5},
  statUnit: {fontSize: 10, color: VBG.textMute},

  btnRow: {flexDirection: 'row', gap: 9},
  pillPrimaryText: {fontSize: 10.5, fontWeight: '700', letterSpacing: 1.2, color: '#fff'},
  pillGhostText: {fontSize: 10.5, fontWeight: '700', letterSpacing: 1.2, color: VBG.text},

  miniGrid: {flexDirection: 'row', gap: 9},
  miniCard: {flex: 1},
  miniLabel: {fontSize: 8, color: VBG.textMute, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8},
  miniContent: {flex: 1, alignItems: 'flex-start', gap: 3.5, minHeight: 56},
  miniLink: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8},
  miniLinkText: {fontSize: 8.5, fontWeight: '600', color: '#A9C5FF', letterSpacing: 0.6, textTransform: 'uppercase'},
  bigNum: {fontSize: 19, fontWeight: '700', color: VBG.text},
  bigNumUnit: {fontSize: 10, color: VBG.textMute, fontWeight: '600'},
  miniDesc: {fontSize: 9.5, color: VBG.textMute, marginTop: 3},
  nearRow: {flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'stretch'},
  nearDot: {width: 5, height: 5, borderRadius: 3, shadowOpacity: 0.8, shadowRadius: 4, shadowOffset: {width: 0, height: 0}},
  nearKey: {fontSize: 9.5, color: VBG.textDim, flex: 1},
  nearVal: {fontSize: 9, color: VBG.text, fontWeight: '600'},

  panic: {width: '100%', paddingVertical: 16, borderRadius: 12, borderWidth: 1.5, borderColor: 'rgba(255,93,93,0.5)', backgroundColor: 'rgba(255,93,93,0.06)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, overflow: 'hidden'},
  panicFill: {position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(255,93,93,0.2)'},
  panicText: {color: '#FF8B8B', fontSize: 13.5, fontWeight: '800', letterSpacing: 0.3},
  panicDisabled: {opacity: 0.55, flexDirection: 'column', gap: 3, paddingVertical: 12},
  panicSoon: {color: VBG.textMute, fontSize: 8.5, fontWeight: '800', letterSpacing: 1.6},
  actionTileDisabled: {opacity: 0.5},
  actionSoon: {color: VBG.textMute, fontSize: 8, fontWeight: '800', letterSpacing: 1.4, marginTop: 3},

  actionGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 9},
  // `overflow: hidden` clips the absoluteFill brand backdrop to the radius.
  actionTile: {width: '48%', flexGrow: 1, minHeight: 56, paddingVertical: 14, paddingHorizontal: 12, borderRadius: 13, borderWidth: 1, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', gap: 9},
  actionTitle: {fontSize: 11.5, fontWeight: '600', color: VBG.text, letterSpacing: -0.2, flex: 1},

  opsRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10},
  opsSub: {fontSize: 11.5, color: VBG.textDim},
}));
