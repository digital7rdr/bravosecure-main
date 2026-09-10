/**
 * ActivityCenterScreen (Step 18 / B2) — the durable, locally-persisted notifications inbox.
 * Renders the activity store's rows (newest first), marks everything read on open, and
 * deep-links a tapped row to the right surface (offer → booking, mission → tracker, SOS →
 * SOS). Rows are pure metadata fetched on each opaque wake — no message body, no key.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, RefreshControl} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useActivityStore, type ActivityClass, type ActivityRowData} from '@store/activityStore';
import ActivityRow from '@components/ui/ActivityRow';
import EmptyState from '@components/ui/EmptyState';
import {UI} from '@components/ui/tokens';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {openAttendance, openJoinFlowScreen, findNavigatorWithRoute, type ResolvableNavigation} from '@navigation/departmentalEntry';
import {navigateToMessengerScreen} from '@navigation/messengerDeepLink';
import {adoptOrgContextFromWake} from '@store/adoptOrgContext';

const CLASS_META: Record<ActivityClass, {icon: string; tint: string}> = {
  booking:  {icon: 'calendar-check', tint: UI.accentSoft},
  dispatch: {icon: 'radar',          tint: UI.accent},
  mission:  {icon: 'shield-account', tint: UI.signal},
  payout:   {icon: 'wallet',         tint: UI.amber},
  sos:      {icon: 'alarm-light',    tint: UI.alert},
  agent:    {icon: 'account-badge',  tint: UI.accentSoft},
  incident: {icon: 'alert-octagon',  tint: UI.alert},
  // Scope v2 Phase 3 — without its own entry these fell back to `booking` and
  // rendered with a calendar badge.
  enterprise: {icon: 'account-clock-outline', tint: UI.accentSoft},
};

/**
 * B-706 A-10 — `now` is a PARAMETER, not `Date.now()` read inside. The label used to be
 * computed once at render with no clock behind it, so a row that said "5m" still said
 * "5m" an hour later. The screen now ticks a minute clock while focused and passes it in.
 * An unparseable ts renders '—' rather than the old "NaNd".
 */
function relTime(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) {return '—';}
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) {return 'now';}
  if (m < 60) {return `${m}m`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h`;}
  return `${Math.floor(h / 24)}d`;
}

export default function ActivityCenterScreen() {
  const insets = useSafeAreaInsets();
  // The nav type must include getParent/getState, not just navigate: this
  // screen hands it to `openJoinFlowScreen`, which RESOLVES against the mounted
  // tree. The previous hand-narrowed shape happened to be fine at runtime
  // (useNavigation returns the real object) but declared away the very
  // capability the resolver needs — the R10-2 hazard, in a second place.
  const navigation = useNavigation<{
    goBack: () => void;
    navigate: (n: string, p?: object) => void;
  } & ResolvableNavigation>();
  const rows = useActivityStore(st => st.rows);
  const markAllRead = useActivityStore(st => st.markAllRead);
  const markRead = useActivityStore(st => st.markRead);
  // B-706 A-3 — Clear now goes through the SYNCED path (local wipe + tombstones +
  // POST /me/notifications/dismiss). The bare store `clear` left the server believing
  // nothing had changed, so the rows came back on the next foreground sync.
  const clearInFlightRef = useRef(false);
  const clearAll = useCallback(() => {
    if (clearInFlightRef.current) {return;}
    clearInFlightRef.current = true;
    void (async () => {
      try {
        const {clearActivitySynced} = require('@store/activitySync') as typeof import('@store/activitySync');
        await clearActivitySynced();
      } catch { useActivityStore.getState().clear(); }
      finally { clearInFlightRef.current = false; }
    })();
  }, []);

  // B-706 A-10 — a minute clock so the relative labels actually move. Focus-scoped:
  // a blurred screen must not hold a timer alive (NAV_RAPID_USE_LOOP N-rules).
  const [now, setNow] = useState(() => Date.now());
  useFocusEffect(useCallback(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []));

  /**
   * B-706 A-3 — opening the inbox clears the unread badge ON THE SERVER TOO.
   * This called the store's LOCAL `markAllRead`, so `read_at` was never written:
   * 467 of 500 live rows were unread, and every resync re-lit the bell for
   * notifications the user had already read. The synced call applies the local
   * mark first and POSTs best-effort, so an offline open still clears the badge.
   *
   * Guarded by a ref, not a state flag: the effect must not re-POST on a re-render,
   * and the screen can be re-focused repeatedly.
   */
  const markAllSentRef = useRef(false);
  useEffect(() => {
    if (markAllSentRef.current) {return;}
    // The local markAllRead is idempotent; the POST is not. Nothing unread means
    // there is nothing for the server to learn, so do not spend a round trip.
    if (!useActivityStore.getState().rows.some(r => !r.read)) {return;}
    markAllSentRef.current = true;
    void (async () => {
      try {
        const {markAllActivityReadSynced} = require('@store/activitySync') as typeof import('@store/activitySync');
        await markAllActivityReadSynced();
      } catch { markAllRead(); }
    })();
  }, [markAllRead]);

  /**
   * B-706 A-11 — pull the server inbox when the screen OPENS. There was no focus
   * effect, no refresh control and no import of the sync at all: with the notification
   * drawer's `openNotif` living in an unmounted file, the only automatic refresh left in
   * the whole app was boot + AppState 'active'. Tapping the bell showed a cache.
   */
  const [refreshing, setRefreshing] = useState(false);
  const syncInFlightRef = useRef(false);
  const runSync = useCallback(async (viaPull: boolean) => {
    if (syncInFlightRef.current) {return;}
    syncInFlightRef.current = true;
    if (viaPull) {setRefreshing(true);}
    try {
      const {syncActivityFromServer} = require('@store/activitySync') as typeof import('@store/activitySync');
      await syncActivityFromServer();
    } catch { /* best-effort — the local store still renders what it has */ }
    finally {
      syncInFlightRef.current = false;
      if (viaPull) {setRefreshing(false);}
    }
  }, []);
  useFocusEffect(useCallback(() => { void runSync(false); }, [runSync]));

  /**
   * The two WORKSPACE classes. Split out because they must SCOPE before they
   * route (vs2 edge A1/A2) and so cannot run in the synchronous arm below.
   *
   * Page 10 rule 3 — "notifications deep-link to the exact authorised record".
   * These rows carry no bookingId/missionId, so before this existed they fell
   * through every case and TAPPING DID NOTHING.
   */
  const routeWorkspaceRow = useCallback((row: ActivityRowData) => {
    if (row.eventClass === 'enterprise') {
      // ActivityCenter IS registered in the Agent shell, which registers none
      // of these routes — so the previous `if (host)` with no else made the
      // admin's own "join requested" notification a silent dead tap, the very
      // failure this branch was added to fix. The resolver reports instead.
      // A7.3 — a day-status row is an ATTENDANCE fact: land the member on
      // the workspace Attend tab (their history shows the new status), not
      // on the join-flow screens.
      if (row.kind === 'enterprise.day_status') {openAttendance(navigation); return;}
      // Admin-side rows land on the Approvals inbox (a new request to review,
      // or an accepted invite to see on the roster/invite list); everything
      // else is the caller's own status/invite → ApprovalStatus.
      const toApprovals =
        row.kind === 'enterprise.join.requested' || row.kind === 'enterprise.invite.accepted';
      openJoinFlowScreen(navigation, toApprovals ? 'Approvals' : 'ApprovalStatus');
      return;
    }
    // vs2 item 16 — an incident row carries no booking/mission id either, so
    // it used to fall through every case below and just mark itself read.
    // This is the DURABLE lane: the only path left once the 5-minute detail
    // blob has expired (killed app, Doze, reinstall, dead token), i.e. the
    // deliveries the client is most likely to be looking at.
    //
    // Explicit rather than an `else`: this function's caller decides which
    // classes reach it, and a third class added there must not silently be
    // routed as an incident.
    if (row.eventClass !== 'incident') {return;}
    const target = row.kind === 'incident-submitted'
      ? (row.incidentId ? 'IncidentDetail' : 'IncidentQueue')
      : 'MyIncidents';
    navigateToMessengerScreen(
      navigation as never, target,
      target === 'IncidentDetail' ? {incidentId: row.incidentId as string} : {},
      {initial: false},
    );
  }, [navigation]);

  const onRow = useCallback((row: ActivityRowData) => {
    markRead(row.id);
    // Best-effort deep-link; unknown targets just mark the row read.
    //
    // vs2 edge A1/A2 — the workspace classes SCOPE first. This is the durable
    // lane: every delivery that missed the 5-minute detail blob arrives here,
    // and for a multi-org member that is precisely when the sticky context is
    // wrong (it is session-only, so null at boot). `adoptOrgContextFromWake`
    // waits out the org switch before we navigate; a row with no orgId (old
    // server, or a self-scoped kind) resolves immediately and behaves exactly
    // as it did before.
    if (row.eventClass === 'enterprise' || row.eventClass === 'incident') {
      void (async () => {
        try {
          // These rows have no tap guard, and the adopt awaits — so two taps
          // inside that window used to interleave and open the FIRST row's
          // record against the SECOND row's organisation. Newest tap wins.
          if (await adoptOrgContextFromWake(row.orgId) === 'superseded') {return;}
          routeWorkspaceRow(row);
        } catch { /* route not in this shell — leave it as a read row */ }
      })();
      return;
    }
    /**
     * B-706 A-9 — RESOLVE before navigating.
     *
     * These were four bare `navigation.navigate` calls in a try/catch. But React
     * Navigation's `defaultOnUnhandledAction` RETURNS EARLY when
     * `process.env.NODE_ENV === 'production'`, so an unregistered route is a silent
     * no-op with no throw and no log — the catch never fired, and the whole guard was
     * decorative. It only console.errors in dev, which is exactly why this passed
     * testing. No shell registers all four routes:
     *
     *   route             Agent   Booking   Cpo
     *   SOSScreen           ✗        ✓       ✗
     *   AgentLiveTracker    ✓        ✗       ✗
     *   OpsRoomReview       ✗        ✓       ✗
     *   LiveTracking        ✗        ✓       ✗
     *
     * The worst case was ordering: an `sos-cpo-alert` in the agent shell hit the
     * SOSScreen branch — unregistered there — and returned, one line BEFORE the
     * `missionId` branch that would have opened AgentLiveTracker. A crew SOS alert
     * did nothing. Candidates are now tried in priority order and the first one the
     * mounted tree actually registers wins.
     */
    const candidates: Array<{route: string; params: object}> = [];
    if (row.eventClass === 'sos' && row.bookingId) {candidates.push({route: 'SOSScreen', params: {bookingId: row.bookingId}});}
    if (row.missionId) {candidates.push({route: 'AgentLiveTracker', params: {missionId: row.missionId}});}
    // B-405 — a reservation reminder/approval concerns a booking that may be
    // days from having a mission: the review screen (which self-routes on
    // status) is the honest target, not a live map with an armed EMERGENCY.
    if ((row.kind === 'booking-reminder' || row.kind === 'booking-approved') && row.bookingId) {
      candidates.push({route: 'OpsRoomReview', params: {bookingId: row.bookingId}});
    }
    if (row.bookingId) {candidates.push({route: 'LiveTracking', params: {bookingId: row.bookingId}});}

    for (const c of candidates) {
      if (findNavigatorWithRoute(navigation, c.route) === null) {continue;}
      try {
        navigation.navigate(c.route, c.params);
        return;
      } catch { /* resolved but refused — fall through to the next candidate */ }
    }
    // Nothing this shell can open. Previously indistinguishable from a successful
    // tap; now at least it is visible in a release logcat.
    if (candidates.length > 0) {
      console.warn(`[activity] no route in this shell for kind=${row.kind} (tried ${candidates.map(c => c.route).join(', ')})`);
    }
  }, [navigation, markRead, routeWorkspaceRow]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={22} color={UI.text} />
        </TouchableOpacity>
        <View style={s.accentBar} />
        <Text style={s.headerTitle}>ACTIVITY</Text>
        {rows.length > 0 && (
          <TouchableOpacity onPress={clearAll} activeOpacity={0.7}><Text style={s.clear}>Clear</Text></TouchableOpacity>
        )}
      </View>

      <ScrollView contentContainerStyle={[s.body, {paddingBottom: insets.bottom + 24}]} showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { void runSync(true); }}
            tintColor={UI.accent} colors={[UI.accent]} progressBackgroundColor={UI.bg} />
        }>
        {rows.length === 0 ? (
          <View style={{marginTop: 60}}>
            <EmptyState icon="bell-sleep-outline" title="Nothing yet"
              body="Offers, status changes, payments, and alerts will show up here — even after a silent notification." />
          </View>
        ) : (
          rows.map(r => {
            const meta = CLASS_META[r.eventClass] ?? CLASS_META.booking;
            return (
              <ActivityRow key={r.id} icon={meta.icon} tint={meta.tint} title={r.title} subtitle={r.subtitle}
                timeLabel={relTime(r.ts, now)} unread={!r.read} expiresAt={r.expiresAt} onPress={() => onRow(r)} />
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 14},
  backBtn: {width: 42, height: 42, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: UI.hair, alignItems: 'center', justifyContent: 'center'},
  accentBar: {width: 3, height: 17, borderRadius: 2, backgroundColor: UI.accent},
  headerTitle: {flex: 1, fontFamily: UI.fBold, fontSize: 13, letterSpacing: 2.2, color: UI.text},
  clear: {fontFamily: UI.fSemi, fontSize: 12.5, color: UI.textDim},
  body: {paddingHorizontal: 20, paddingTop: 4, gap: 10},
}));
