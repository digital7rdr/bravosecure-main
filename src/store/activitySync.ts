/**
 * N-20 — hydrate the in-app notification centre (activityStore) from the durable
 * server inbox (GET /me/notifications). This is what makes the bell "sync":
 * a wake missed while the device was killed/Dozed/token-less is backfilled here
 * on next foreground + WS reconnect, and a since-watermark keeps it incremental.
 *
 * The server stores metadata only (class/kind/booking/mission ids); the display
 * title/subtitle is mapped here, mirroring the FCM path's AGENT_WAKE_META so a
 * backfilled row reads identically to a live wake.
 */
import {AppState, type AppStateStatus} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {API_BASE_URL} from '@utils/constants';
import {useActivityStore, type ActivityClass, type ActivityRowInput} from './activityStore';
import {tokenVault} from '@services/tokenVault';
import {decodeAccessTokenClaims} from '@services/jwtClaims';

// MOB-6 — the watermark is keyed PER USER. It used to be a single global key, so
// after user A synced (watermark = A's newest ts) and signed out WITHOUT the reset
// ever being wired, user B on the same device fetched `?since=<A's ts>` and MISSED
// every notification older than that. A per-user key means B never inherits A's
// cursor even if the sign-out cleanup is skipped (app killed, token swap).
const WATERMARK_PREFIX = 'bravo:activity-sync-watermark';
const watermarkKey = (userId: string) => `${WATERMARK_PREFIX}:${userId}`;

const KIND_META: Record<string, {title: string; subtitle: string}> = {
  'agent-approved':    {title: 'Application approved', subtitle: 'You can now apply for jobs.'},
  'agent-rejected':    {title: 'Application not approved', subtitle: 'Tap for details.'},
  'mission-dispatched':{title: 'Mission dispatched', subtitle: 'Ops has assigned you. Tap to open.'},
  'mission-aborted':   {title: 'Mission aborted', subtitle: 'Ops cancelled the mission. Stand down.'},
  'mission-complete-requested': {title: 'Completion requested', subtitle: 'A crew member asked to close a mission.'},
  // Executive Protection — hourly "all smooth" confirmations.
  'detail-hour-checkin':  {title: 'Hourly check-in — all smooth', subtitle: 'Your team confirmed the last protected hour.'},
  'mission-hour-checkin': {title: 'Hourly check-in logged', subtitle: 'The lead confirmed an elapsed hour.'},
  'payout-settled':    {title: 'Payout settled', subtitle: 'Your earnings have been credited.'},
  'sos-cpo-alert':     {title: 'SOS · crew alert', subtitle: 'A team member raised SOS. Tap to respond.'},
  'dispatch-offer':    {title: 'Incoming job offer', subtitle: 'A mission offer is waiting — respond quickly.'},
  'provider-accepted': {title: 'Agency accepted', subtitle: 'An agency accepted your request.'},
  'no-provider':       {title: 'No agency available', subtitle: 'We could not find an available agency.'},
  'agency-no-show':    {title: 'Agency did not crew', subtitle: 'Your booking was cancelled and fully refunded.'},
  'booking-redispatching': {title: 'Reassigning your detail', subtitle: 'Finding a replacement now.'},
  'payment-failed':    {title: 'Payment failed', subtitle: 'Your booking could not be charged.'},
  'booking-rejected':  {title: 'Booking not approved', subtitle: 'Tap for details.'},
  'booking-completed': {title: 'Mission complete', subtitle: 'Tap to rate and view your receipt.'},
  'booking-approved':  {title: 'Booking approved', subtitle: 'Ops approved your booking. Tap to continue.'},
  'refund-issued':     {title: 'Refund issued', subtitle: 'Credits were returned to your wallet.'},
  'crew-assigned':     {title: 'Crew assigned', subtitle: 'Your protection team is being prepared.'},
  // B-405 — T-60 start reminder for a scheduled ('later') booking.
  'booking-reminder':  {title: 'Upcoming protection detail', subtitle: 'Your booking starts within the hour.'},
  'dispute-opened':    {title: 'Dispute opened', subtitle: 'Ops will review it.'},
  'dispute-resolved':  {title: 'Dispute resolved', subtitle: 'Tap for the outcome.'},
  // vs2 item 16 — never "CPO": not every organisation has them.
  'incident-submitted':{title: 'Incident reported', subtitle: 'An incident was reported. Tap to review.'},
  'incident-status':   {title: 'Incident update', subtitle: 'An incident status changed.'},
  // A11 / M11A. Without these the row title was the RAW KIND STRING
  // ('enterprise.join.approved') with no subtitle — page 10 rule 4 asks for
  // readable labels and status text.
  'enterprise.join.requested': {title: 'New join request', subtitle: 'Someone asked to join your workspace.'},
  'enterprise.join.approved':  {title: 'Access approved',  subtitle: 'You can now open Department Channels.'},
  'enterprise.join.declined':  {title: 'Request declined', subtitle: 'Your request to join was not approved.'},
  // A7.3 — a manager set/changed the member's duty status. Metadata-only by
  // contract (P0-N8): the VALUE is read in My Attendance, not carried here.
  'enterprise.day_status':     {title: 'Day status updated', subtitle: 'A manager set your duty status. Tap to view.'},
  // Item E — member invites. The org is NOT named here (P0-N8 metadata-only);
  // ApprovalStatus names it after its own authorised fetch.
  'enterprise.invite.received': {title: "You're invited", subtitle: 'A workspace invited you to join. Tap to view.'},
  'enterprise.invite.accepted': {title: 'Invite accepted', subtitle: 'Someone you invited just joined your workspace.'},
  // R-4 — kinds the server records that previously backfilled as RAW STRINGS
  // ("pro-plan-activated" verbatim as a bell-row title). Copy mirrors the live
  // FCM meta so a backfilled row reads identically to a live wake.
  'detail-enroute':    {title: 'Your detail is en route', subtitle: 'Your protection officer is on the way.'},
  'detail-live':       {title: 'Protection active', subtitle: 'Your protection detail is now live.'},
  'pro-application-received': {title: 'Pro application received', subtitle: 'The Bravo Control System is preparing your proposal.'},
  'pro-proposal-ready':       {title: 'Your Pro proposal is ready', subtitle: 'Review your custom plan and Bravo Credits.'},
  'pro-application-rejected': {title: 'Pro application update', subtitle: 'Your application was not approved. Tap for details.'},
  'pro-application-cancelled': {title: 'Pro application cancelled', subtitle: 'Your application was cancelled as requested.'},
  'pro-plan-activated':       {title: 'Bravo Secure Pro active', subtitle: 'Your plan is live.'},
  'pro-ops-message':          {title: 'Bravo Control System replied', subtitle: 'New message on your Pro application.'},
  'pro-mission-update':       {title: 'Protection request update', subtitle: 'The Bravo Control System answered your request.'},
  // Protection sessions (on-demand live tracking).
  'psession-started':         {title: 'Protection active', subtitle: 'Your live protection session is active.'},
  'psession-ended':           {title: 'Protection ended', subtitle: 'Your protection session has ended.'},
  'pro-cpo-changed':          {title: 'Protection officer changed', subtitle: 'Your assigned officer was updated.'},
  'psession-new':             {title: 'New protection session', subtitle: 'A customer started a protection session.'},
  'psession-sos':             {title: 'SOS — protection session', subtitle: 'Your customer raised an SOS.'},
  'psession-conn-lost':       {title: 'Location lost', subtitle: 'A customer you protect went silent.'},
  // B-377/B-378 — agency-board events.
  'mission-accepted':  {title: 'Officer accepted', subtitle: 'An assigned officer confirmed the mission.'},
  'mission-declined':  {title: 'Officer declined — action needed', subtitle: 'Re-assign crew on the missions board.'},
  'mission-cancelled': {title: 'Booking cancelled by client', subtitle: 'The mission is stood down.'},
  // R-3 — family invite lifecycle.
  'family-invite':          {title: 'Family invitation', subtitle: 'You were invited to join a Bravo Secure family.'},
  'family-invite-accepted': {title: 'Family invite accepted', subtitle: 'Your family member is now active.'},
  'family-charge-blocked':  {title: 'Booking blocked by your plan holder', subtitle: 'Your family spend limit or access changed.'},
  // Family spending-quota lifecycle. Amounts are deliberately absent — they are
  // not on the wire, and a bell row that quoted a stale figure would contradict
  // the screen it opens.
  'family-credit-requested': {title: 'Credit request',         subtitle: 'A family member asked for more spending credit.'},
  'family-credit-decided':   {title: 'Credit request update',  subtitle: 'Your plan holder responded to your request.'},
  'family-quota-changed':    {title: 'Spending limit updated', subtitle: 'Your plan holder changed your spending limit.'},
  'family-quota-threshold':  {title: 'Family spending alert',  subtitle: 'A family member is approaching their spending limit.'},
};

function activityClassOf(kind: string, eventClass: string): ActivityClass | null {
  if (eventClass === 'dispatch') {return 'dispatch';}
  if (eventClass === 'payout') {return 'payout';}
  if (eventClass === 'mission') {return 'mission';}
  if (eventClass === 'agent') {return 'agent';}
  if (eventClass === 'sos') {return 'sos';}
  if (eventClass === 'incident') {return 'incident';}
  if (eventClass === 'booking') {return 'booking';}
  // Scope v2 Phase 3 — without this branch these fell through to the final
  // `return 'booking'` and rendered with a calendar badge.
  if (eventClass === 'enterprise') {return 'enterprise';}
  // Fall back to kind prefix for any older row.
  if (kind.startsWith('mission-')) {return 'mission';}
  if (kind.startsWith('agent-')) {return 'agent';}
  if (kind.startsWith('incident')) {return 'incident';}
  if (kind.startsWith('enterprise.')) {return 'enterprise';}
  return 'booking';
}

interface ServerNotification {
  id: string; eventClass: string; kind: string;
  bookingId?: string; missionId?: string; incidentId?: string; orgId?: string;
  createdAt: string; read: boolean;
}

/**
 * B-706 A-8 — one authorised fetch with the SAME refresh ladder every sibling in this
 * family already has (`serverWakeNotifications`, `headlessDrain`, `pendingActions`,
 * `backupClient`). `tokenVault.getAccess()` does no expiry check and returns an expired
 * token happily, and this module uses raw `fetch`, so it bypasses the axios 401-refresh
 * interceptor too. With `if (!res.ok) return;` as the only handling, the first 401 after
 * the 15-minute access TTL lapsed froze the feed silently until some unrelated request
 * happened to refresh the token — a large part of "it is not real time".
 */
async function authedFetch(url: string, init?: RequestInit): Promise<Response | null> {
  // Lazy, like every sibling: a top-level import would pull axios + supabase into
  // this module's graph, and it loads early on the wake path.
  const {refreshAccessTokenShared} = require('@services/api') as typeof import('@services/api');
  const attempt = async (retried: boolean): Promise<Response | null> => {
    let access = await tokenVault.getAccess();
    if (!access) {
      if (retried) {return null;}
      try { await refreshAccessTokenShared(); } catch { return null; }
      access = await tokenVault.getAccess();
      if (!access) {return null;}
    }
    const res = await fetch(url, {
      ...init,
      headers: {...(init?.headers ?? {}), Authorization: `Bearer ${access}`, 'X-Signal-Device-Id': '1'},
    });
    if (res.status === 401 && !retried) {
      try { await refreshAccessTokenShared(); } catch { return null; }
      return attempt(true);
    }
    return res;
  };
  return attempt(false);
}

/** Fetch new server notifications and merge them into the local activity feed. */
export async function syncActivityFromServer(): Promise<void> {
  try {
    const access = await tokenVault.getAccess();
    if (!access) {return;}
    // Scope the cursor to THIS user (JWT sub). Without a usable sub we cannot
    // isolate the watermark, so skip rather than risk crossing accounts.
    const userId = decodeAccessTokenClaims(access)?.sub;
    if (!userId) {return;}
    const key = watermarkKey(userId);
    const since = await AsyncStorage.getItem(key);
    const url = `${API_BASE_URL}/me/notifications?limit=100`
      + (since ? `&since=${encodeURIComponent(since)}` : '');
    const res = await authedFetch(url);
    if (!res?.ok) {return;}
    const body = await res.json() as {notifications?: ServerNotification[]};
    const rows = body?.notifications ?? [];
    if (rows.length === 0) {return;}
    // B-706 A-1 — build the whole page, then commit it in ONE set(). Appending row by
    // row fired a store commit per row (100 re-renders of every subscriber and 100
    // re-arms of the debounced persist for a single sync); worse, each append PREPENDED,
    // so this loop reversed the server's `ORDER BY created_at DESC` page and the feed
    // rendered oldest-first. Ordering is now an invariant of `mergeRows`.
    const batch: ActivityRowInput[] = [];
    let newest = since ?? '';
    for (const n of rows) {
      const eventClass = activityClassOf(n.kind, n.eventClass);
      if (!eventClass) {continue;}
      const meta = KIND_META[n.kind] ?? {title: n.kind, subtitle: ''};
      batch.push({
        id: n.id,
        eventClass,
        kind: n.kind,
        title: meta.title,
        subtitle: meta.subtitle || undefined,
        bookingId: n.bookingId,
        missionId: n.missionId,
        incidentId: n.incidentId,
        orgId: n.orgId,
        ts: n.createdAt,
        read: n.read,
      });
      if (n.createdAt > newest) {newest = n.createdAt;}
    }
    useActivityStore.getState().appendMany(batch);
    if (newest && newest !== since) {
      await AsyncStorage.setItem(key, newest);
    }
  } catch { /* best-effort — the local store still shows what it has */ }
}

/** Local mark-all-read + best-effort server persist so other devices converge. */
export async function markAllActivityReadSynced(): Promise<void> {
  useActivityStore.getState().markAllRead();
  try {
    // No `getAccess()` pre-check: authedFetch refreshes a lapsed token itself, and
    // bailing on a momentarily-absent one is how the read never reached the server.
    await authedFetch(`${API_BASE_URL}/me/notifications/read`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({all: true}),
    });
  } catch { /* local read already applied */ }
}

/**
 * B-706 A-3 — Clear the feed, durably.
 *
 * `clear()` alone was a local `set({rows: []})`. The server had no delete surface at all,
 * so it never learned, and the next `AppState: 'active'` sync handed the rows straight
 * back — unread, because the synced mark-read lived in an unmounted screen. That is the
 * founder's "I delete the notification, again it came back."
 *
 * Order matters: the LOCAL clear runs first and unconditionally, so the UI empties even
 * offline, and it records tombstones on the way out. The POST is best-effort — the
 * tombstones are what keep an offline/failed clear from being undone before it lands.
 *
 * `{all: true}` rather than `{ids}` on purpose: local ids are a MIX of FCM eventIds and
 * server row uuids (A-4), and the server's uuid filter would silently drop every eventId,
 * so an id list would dismiss only half the feed.
 */
export async function clearActivitySynced(): Promise<void> {
  useActivityStore.getState().clear();
  try {
    await authedFetch(`${API_BASE_URL}/me/notifications/dismiss`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({all: true}),
    });
  } catch { /* local clear + tombstones already applied */ }
}

/**
 * B-706 A-4 — the server inbox is the SINGLE minter of bell rows; a wake only nudges it.
 *
 * A warm wake used to `recordActivity()` a local row keyed on the FCM `eventId`, while the
 * backfill keyed the same event on the `notifications` row uuid. Two keyspaces that can
 * never collide, so the id dedupe never fired and EVERY booking/mission/payout event sat
 * in the feed twice, with the badge reading 2N — a defect the code already documented as
 * repo-wide and had only patched for `enterprise.*` (by suppressing the local row, exactly
 * as we now do for every class).
 *
 * The delay is load-bearing: `BookingPushBridge.publish()` sends the FCM wake BEFORE it
 * inserts the durable row (deliberately — an SOS fan-out must not queue behind Postgres),
 * so a sync fired the instant the wake lands can outrun the row it came for. A missed race
 * is self-healing rather than lossy: the watermark cannot have advanced past a row that did
 * not exist yet, so the next sync still picks it up.
 */
let syncKickTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleActivitySync(delayMs = 1500): void {
  if (syncKickTimer) {return;} // coalesce a burst of wakes into one round trip
  syncKickTimer = setTimeout(() => {
    syncKickTimer = null;
    syncActivityFromServer().catch(() => { /* best-effort */ });
  }, delayMs);
}

let appStateSub: {remove: () => void} | null = null;
let started = false;

/** Start syncing: an initial fetch + a re-fetch whenever the app foregrounds. */
export function startActivitySync(): void {
  if (started) {return;}
  started = true;
  syncActivityFromServer().catch(() => { /* best-effort */ });
  appStateSub = AppState.addEventListener('change', (s: AppStateStatus) => {
    if (s === 'active') {syncActivityFromServer().catch(() => { /* best-effort */ });}
  });
}

export function stopActivitySync(): void {
  started = false;
  appStateSub?.remove();
  appStateSub = null;
  // A wake kick armed moments before sign-out would otherwise fire afterwards. It is
  // harmless (it re-reads the token and bails without one), but this function exists to
  // leave nothing running, so leave nothing running.
  if (syncKickTimer) {clearTimeout(syncKickTimer); syncKickTimer = null;}
}

/**
 * Reset the sync watermark on sign-out so a new identity re-syncs from scratch.
 * Clears EVERY per-user watermark (and the legacy global key) by prefix — it runs
 * after tokens are already cleared, so it can't derive the current user id, and
 * clearing all of them is both correct and a cheap AsyncStorage housekeeping.
 */
export async function resetActivitySyncWatermark(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter(k => k.startsWith(WATERMARK_PREFIX));
    if (ours.length > 0) {await AsyncStorage.multiRemove(ours);}
  } catch { /* best-effort */ }
}
