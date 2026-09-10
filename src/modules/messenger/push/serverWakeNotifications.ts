/**
 * Shared server-driven wake → notification dispatch.
 *
 * CRIT-5 — the killed-app headless handler (fcmHeadless) previously handled
 * ONLY voip-wake / msg-wake and dropped every other server wake with
 * "unknown kind, no action" — so SOS / mission-dispatched / booking-approved /
 * agent-* / payout-settled and opaque {eventId} wakes surfaced NOTHING when the
 * app was fully killed. The warm handler (fcmBootstrap.setBackgroundMessageHandler)
 * DID handle them, so the two paths had drifted. This module is the single
 * source of truth both handlers call, so they can never drift again.
 *
 * SAFE FOR HEADLESS JS: draws via notifee and hydrates via fetch only. It never
 * boots the messenger runtime / libsignal / SQLCipher / WS (the 2nd-VM
 * contention the headless task avoids). All native deps are lazy-`require()`d
 * (Hermes headless can't reliably dynamic-`import()`), which also keeps this
 * module importable in the node test env.
 *
 * PRIVACY: opaque server wakes carry ONLY {eventId, eventClass} on the FCM
 * channel (P0-N8). The real detail (bookingId/missionId/kind) is fetched from
 * the JWT-gated, recipient-bound `GET /events/by-id/:eventId` — never put on the
 * cleartext push payload.
 */

type WakeData = Record<string, unknown>;

// P3 (background-reliability audit 2026-07-10): the v1 'sos-alerts' channel
// claimed DND-bypass but was created without `bypassDnd` (or any distinct
// sound), so a panic alert was DND-suppressed like a routine booking notif.
// Android channel config is immutable after creation, so the fix ships as a
// NEW channel id + a delete of the stale v1 — the same migration pattern as
// bravo-incoming-call-v2 (callNotification.ts). No dedicated SOS sound asset
// exists in res/raw (only call ring/ringback), so v2 keeps the default sound;
// bypassDnd is the safety-relevant part. Note: Android honors a channel's
// bypassDnd only once the user grants the app DND access (or toggles
// "Override Do Not Disturb" on the channel) — verify on-device.
const SOS_CHANNEL_ID = 'sos-alerts-v2';
const LEGACY_SOS_CHANNEL_ID = 'sos-alerts';
let legacySosChannelRetired = false;

// B-66 — small-icon tint (obsidian cobalt). Local constant, NOT imported from
// callNotification: this module runs in the headless-wake path and must keep
// its module graph minimal.
const NOTIF_ACCENT = '#5B8DEF';

/**
 * Hydrate an opaque server push wake. Returns the parsed detail
 * (e.g. {kind:'sos-cpo-alert', missionId, bookingId}) or null on any miss —
 * a null just means the wake stays generic, never an error.
 */
export async function hydratePushEvent(eventId: string): Promise<Record<string, unknown> | null> {
  const {refreshAccessTokenShared} = require('@services/api') as typeof import('@services/api');
  const {API_BASE_URL} = require('@utils/constants') as typeof import('@utils/constants');
  // Lazy-required like everything else here: this module must stay importable
  // in the node test env and in a headless JS VM (FIX-01 moved the tokens into
  // the keychain, so this pulls a native module).
  const {tokenVault} = require('@services/tokenVault') as typeof import('@services/tokenVault');
  async function attempt(retried: boolean): Promise<Record<string, unknown> | null> {
    let access = await tokenVault.getAccess();
    if (!access) {
      if (retried) {return null;}
      try { await refreshAccessTokenShared(); } catch { return null; }
      access = await tokenVault.getAccess();
      if (!access) {return null;}
    }
    const res = await fetch(`${API_BASE_URL}/events/by-id/${encodeURIComponent(eventId)}`, {
      method:  'GET',
      headers: {Authorization: `Bearer ${access}`, 'X-Signal-Device-Id': '1'},
    });
    if (res.status === 401 && !retried) {
      try { await refreshAccessTokenShared(); } catch { return null; }
      return attempt(true);
    }
    if (!res.ok) {return null;}
    try { return (await res.json()) as Record<string, unknown>; } catch { return null; }
  }
  return attempt(false);
}

const AGENT_WAKE_META: Record<string, {title: string; body: string; sos: boolean; channel?: string}> = {
  'agent-approved':    {title: 'Application approved', body: 'You can now apply for jobs.', sos: false},
  'agent-rejected':    {title: 'Application not approved', body: 'Tap for details.', sos: false},
  'mission-dispatched':{title: 'Mission dispatched', body: 'Ops has assigned you. Tap to open.', sos: false},
  'mission-aborted':   {title: 'Mission aborted', body: 'Ops cancelled the mission. Stand down.', sos: false},
  'payout-settled':    {title: 'Payout settled', body: 'Your earnings have been credited.', sos: false},
  'sos-cpo-alert':     {title: 'SOS · crew alert', body: 'A team member raised SOS. Tap to respond.', sos: true},
  // LM-N1 — the incoming job offer wake (30s TTL): its own channel so an agency
  // manager can max its priority independently of routine agent updates.
  'dispatch-offer':    {title: 'Incoming job offer', body: 'A mission offer is waiting — 30 seconds to respond.', sos: false, channel: 'dispatch-offers'},
  // LM-C7 — a crew member asked the agency to close a mission (lead unreachable).
  'mission-complete-requested': {title: 'Completion requested', body: 'A crew member asked to close a mission. Confirm on the missions board.', sos: false},
  // B-377 (Issue 41) — the officer answered; the AGENCY must hear a decline to re-crew.
  'mission-accepted':  {title: 'Officer accepted', body: 'An assigned officer confirmed the mission. View the board.', sos: false},
  'mission-declined':  {title: 'Officer declined — action needed', body: 'An assigned officer declined. Re-assign crew on the missions board.', sos: false},
  // B-378 — the client cancelled a crewed booking; the accepted agency's slot freed.
  'mission-cancelled': {title: 'Booking cancelled by client', body: 'A crewed booking was cancelled. The mission is stood down.', sos: false},
  // LM-N4 — client lifecycle wakes that were previously silent (or card-only).
  'provider-accepted':    {title: 'Agency accepted', body: 'An agency accepted your request. Tap to view your detail.', sos: false, channel: 'booking-updates'},
  'no-provider':          {title: 'No agency available', body: 'We could not find an available agency. Tap for options.', sos: false, channel: 'booking-updates'},
  'agency-no-show':       {title: 'Agency did not crew', body: 'Your booking was cancelled and fully refunded.', sos: false, channel: 'booking-updates'},
  'booking-redispatching':{title: 'Reassigning your detail', body: 'Your crew was reassigned — finding a replacement now.', sos: false, channel: 'booking-updates'},
  'payment-failed':       {title: 'Payment failed', body: 'Your booking could not be charged. Top up and try again.', sos: false, channel: 'booking-updates'},
  'booking-rejected':     {title: 'Booking not approved', body: 'Ops could not approve your booking. Tap for details.', sos: false, channel: 'booking-updates'},
  'booking-completed':    {title: 'Mission complete', body: 'Your detail has completed. Tap to rate and view your receipt.', sos: false, channel: 'booking-updates'},
  'refund-issued':        {title: 'Refund issued', body: 'Credits were returned to your wallet.', sos: false, channel: 'booking-updates'},
  'crew-assigned':        {title: 'Crew assigned', body: 'Your protection team is being prepared. Tap to track.', sos: false, channel: 'booking-updates'},
  // B-405 — T-60 start reminder for a scheduled ('later') booking.
  'booking-reminder':     {title: 'Upcoming protection detail', body: 'Your booking starts within the hour. Tap to review.', sos: false, channel: 'booking-updates'},
  // LM-N4 — mission-progress steps (previously silent to the client).
  'detail-enroute':       {title: 'Your detail is en route', body: 'Your protection officer is on the way. Tap to track.', sos: false, channel: 'booking-updates'},
  'detail-live':          {title: 'Protection active', body: 'Your protection detail is now live. Tap to track.', sos: false, channel: 'booking-updates'},
  // Executive Protection — the lead confirmed an elapsed protected hour.
  'detail-hour-checkin':  {title: 'Hourly check-in — all smooth', body: 'Your team confirmed the last protected hour. Tap to view.', sos: false, channel: 'booking-updates'},
  'mission-hour-checkin': {title: 'Hourly check-in logged', body: 'The lead confirmed an elapsed hour on a live mission.', sos: false},
  'dispute-opened':       {title: 'Dispute opened', body: 'A dispute was opened on your booking. Ops will review it.', sos: false, channel: 'booking-updates'},
  'dispute-resolved':     {title: 'Dispute resolved', body: 'Ops resolved the dispute on your booking. Tap for the outcome.', sos: false, channel: 'booking-updates'},
  // N-21 — the 'incident' push class (Dept Chat v2) was published by the server
  // but had NO client meta entry, so incident wakes fell through to
  // "unknown kind, no action" and surfaced nothing. Own channel so managers can
  // prioritise incident alerts independently of routine booking updates.
  // vs2 item 16 — "do not state CPO as not all organizations have CPOs". These
  // are the OLD-SERVER fallbacks; when the payload carries orgName/reporterName
  // the banner is composed from them (see incidentCopy below).
  'incident-submitted':   {title: 'Incident reported', body: 'An incident was reported. Tap to review.', sos: false, channel: 'incident-updates'},
  'incident-status':      {title: 'Incident update', body: 'An incident status changed. Tap for details.', sos: false, channel: 'incident-updates'},
  // Bravo Secure Pro application lifecycle (request-and-approval custom plans).
  'pro-application-received': {title: 'Pro application received', body: 'The Bravo Control System is preparing your proposal.', sos: false, channel: 'booking-updates'},
  'pro-proposal-ready':       {title: 'Your Pro proposal is ready', body: 'Review your custom plan and monthly Bravo Credits.', sos: false, channel: 'booking-updates'},
  'pro-application-rejected': {title: 'Pro application update', body: 'Your application was not approved. Tap for details.', sos: false, channel: 'booking-updates'},
  'pro-application-cancelled': {title: 'Pro application cancelled', body: 'Your application was cancelled as requested. You can apply again any time.', sos: false, channel: 'booking-updates'},
  'pro-plan-activated':       {title: 'Bravo Secure Pro active', body: 'Your plan is live. Tap to open your Pro dashboard.', sos: false, channel: 'booking-updates'},
  'pro-ops-message':          {title: 'Bravo Control System replied', body: 'New message on your Pro application.', sos: false, channel: 'booking-updates'},
  'pro-mission-update':       {title: 'Protection request update', body: 'The Bravo Control System answered your request. Tap to view.', sos: false, channel: 'booking-updates'},
  // Protection sessions (on-demand live tracking). Customer-facing wakes are
  // 'booking' class; the CPO-facing ones (psession-new / -sos / -conn-lost) are
  // urgent officer alerts. psession-sos rides the SOS channel + sos:true.
  'psession-started':         {title: 'Protection active', body: 'Your live protection session is active. Tap to open it.', sos: false, channel: 'booking-updates'},
  'psession-ended':           {title: 'Protection ended', body: 'Your protection session has ended.', sos: false, channel: 'booking-updates'},
  'pro-cpo-changed':          {title: 'Your protection officer changed', body: 'The Bravo Control System updated your assigned officer. Tap to view.', sos: false, channel: 'booking-updates'},
  'psession-new':             {title: 'New protection session', body: 'A customer started a protection session. Tap to monitor.', sos: false, channel: 'booking-updates'},
  'psession-sos':             {title: 'SOS — protection session', body: 'Your customer raised an SOS. Open the session now.', sos: true, channel: 'sos-alerts'},
  'psession-conn-lost':       {title: 'Location lost', body: 'A customer you protect went silent. Tap to check the session.', sos: false, channel: 'booking-updates'},
  // R-3 — family invite lifecycle (was pull-only: discovery relied on opening Profile).
  'family-invite':          {title: 'Family invitation', body: 'You were invited to join a Bravo Secure family. Tap to respond.', sos: false, channel: 'booking-updates'},
  'family-invite-accepted': {title: 'Family invite accepted', body: 'Your family member is now active. Tap to manage.', sos: false, channel: 'booking-updates'},
  // B-384 — a permission block, NOT an empty wallet: "top up" copy would send the
  // member round a loop only their plan holder can end.
  'family-charge-blocked':  {title: 'Booking blocked by your plan holder', body: 'Your family spend limit or access changed, so this booking was not charged. Tap for details.', sos: false, channel: 'booking-updates'},
  // Family spending-quota lifecycle. Metadata-only like every other kind: the
  // amounts never cross the wire, so the copy is deliberately unquantified and
  // the client reads the figures from the authenticated /family endpoints.
  'family-credit-requested': {title: 'Credit request',        body: 'A family member asked for more spending credit. Tap to review.',      sos: false, channel: 'booking-updates'},
  'family-credit-decided':   {title: 'Credit request update', body: 'Your plan holder responded to your credit request. Tap for details.', sos: false, channel: 'booking-updates'},
  'family-quota-changed':    {title: 'Spending limit updated', body: 'Your plan holder changed your spending limit. Tap to view.',         sos: false, channel: 'booking-updates'},
  // The 80/90/100% warning. Fires on a band CROSSING only (server-side), so
  // this is not a per-transaction ding.
  'family-quota-threshold':  {title: 'Family spending alert', body: 'A family member is approaching their spending limit. Tap to review.', sos: false, channel: 'booking-updates'},
  // R13-2 — enterprise workspace join loop (A11 / M11A). Copy mirrors
  // activitySync's KIND_META (the banner adds a tap CTA where the bell
  // subtitle has none). Own channel: a workspace admin can prioritise these
  // independently of booking noise.
  'enterprise.join.requested': {title: 'New join request', body: 'Someone asked to join your workspace. Tap to review.', sos: false, channel: 'enterprise-updates'},
  'enterprise.join.approved':  {title: 'Access approved', body: 'You can now open Department Channels.', sos: false, channel: 'enterprise-updates'},
  'enterprise.join.declined':  {title: 'Request declined', body: 'Your request to join was not approved.', sos: false, channel: 'enterprise-updates'},
  // Item E — member invites. `invite.received` fires only when the minted
  // contact matched an existing account (the silent-match rule); the org is
  // deliberately NOT named in the banner — the payload carries only the kind
  // (P0-N8) and the ApprovalStatus screen names it after a server round-trip.
  'enterprise.invite.received': {title: "You're invited", body: 'A workspace invited you to join. Tap to view.', sos: false, channel: 'enterprise-updates'},
  'enterprise.invite.accepted': {title: 'Invite accepted', body: 'Someone you invited just joined your workspace.', sos: false, channel: 'enterprise-updates'},
};

/**
 * N-18 — map a server-wake kind to the in-app activity feed's coarse class so a
 * wake also lands a durable row in the notification centre (bell), not just an
 * OS banner that vanishes when swiped.
 */
type ActivityClassLike = 'booking' | 'dispatch' | 'mission' | 'payout' | 'sos' | 'agent' | 'incident' | 'enterprise';
function kindToActivityClass(kind: string): ActivityClassLike | null {
  if (kind === 'dispatch-offer') {return 'dispatch';}
  if (kind === 'payout-settled') {return 'payout';}
  // Protection-session CPO alerts: SOS is its own class; new/conn-lost are mission-like.
  if (kind === 'psession-sos') {return 'sos';}
  if (kind === 'psession-new' || kind === 'psession-conn-lost') {return 'mission';}
  if (kind.startsWith('mission-')) {return 'mission';}
  if (kind.startsWith('agent-')) {return 'agent';}
  if (kind.startsWith('sos')) {return 'sos';}
  if (kind.startsWith('incident')) {return 'incident';}
  if (kind.startsWith('enterprise.')) {return 'enterprise';}
  if (kind === 'booking-approved') {return 'booking';}
  const BOOKING = new Set([
    'provider-accepted', 'no-provider', 'agency-no-show', 'booking-redispatching',
    'payment-failed', 'booking-rejected', 'booking-completed', 'refund-issued',
    'crew-assigned', 'booking-reminder', 'detail-enroute', 'detail-live', 'detail-hour-checkin',
    'dispute-opened', 'dispute-resolved', 'mission-complete-requested',
    // Bravo Secure Pro application lifecycle.
    'pro-application-received', 'pro-proposal-ready', 'pro-application-rejected',
    'pro-application-cancelled', 'pro-plan-activated', 'pro-ops-message', 'pro-mission-update',
    // R-3 — family invite lifecycle.
    'family-invite', 'family-invite-accepted', 'family-charge-blocked',
    // Family spending-quota lifecycle.
    'family-credit-requested', 'family-credit-decided', 'family-quota-changed', 'family-quota-threshold',
    // Protection sessions — customer-facing wakes.
    'psession-started', 'psession-ended', 'pro-cpo-changed',
  ]);
  if (BOOKING.has(kind)) {return 'booking';}
  return null;
}

/**
 * B-706 A-4 — a warm wake NUDGES the server inbox; it no longer mints a row itself.
 *
 * This used to `recordActivity()` a local row keyed on the FCM `eventId`, while the
 * backfill keys the same event on the `notifications` row uuid. Two keyspaces that never
 * collide, so `activityStore`'s id dedupe could never fire and every non-enterprise event
 * ended up in the feed TWICE, with the badge reading 2N for N events. The comment that
 * used to live here said so, called the mechanism repo-wide, and patched only
 * `enterprise.*` — by suppressing the local row. That suppression is now the rule for
 * every class, which makes the durable inbox the single minter and the two lanes
 * impossible to drift again.
 *
 * The banner is unaffected — it is drawn by the caller, immediately. Only the in-app bell
 * row now waits for the (short, debounced) sync, and it arrives with the routing fields
 * the server row carries: `orgId`, `incidentId`, `bookingId`, `missionId`.
 */
function recordActivityForWake(kind: string, _title: string, _body: string, data: Record<string, unknown>): void {
  const eventClass = kindToActivityClass(kind);
  if (!eventClass) {return;}
  void data;
  try {
    const {scheduleActivitySync} = require('@store/activitySync') as typeof import('@store/activitySync');
    scheduleActivitySync();
  } catch (e) {
    console.warn('[fcm] activity sync kick failed:', (e as Error).message);
  }
}

/**
 * Draw the local notification for a server-driven wake. Hydrates an opaque
 * {eventId} wake first. Returns true if a notification was drawn (kind handled),
 * false if the kind is not a server-event kind (caller logs "no action").
 *
 * Does NOT handle voip-wake / msg-wake — those have app-state-specific ringing
 * / envelope-pull behavior and stay in the per-handler code.
 */
export async function showServerWakeNotification(
  dataIn: WakeData,
  opts?: {recordActivity?: boolean},
): Promise<boolean> {
  const data: Record<string, unknown> = {...dataIn};

  // Opaque server wake ({eventId, eventClass}, no inline kind) → hydrate the
  // real kind/detail so the routing below can surface the right notification.
  if (typeof data.eventId === 'string' && !data.kind) {
    try {
      const detail = await hydratePushEvent(data.eventId);
      if (detail) {
        for (const [k, v] of Object.entries(detail)) {
          if (typeof v === 'string') {data[k] = v;}
        }
      }
    } catch (e) {
      console.warn('[fcm] event hydrate failed:', (e as Error).message);
    }
  }

  const kind = typeof data.kind === 'string' ? data.kind : '';

  if (kind === 'booking-approved' && typeof data.bookingId === 'string') {
    const bookingId = data.bookingId as string;
    // Validate UUID-ish shape before threading through notifee / tap-route.
    if (!/^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(bookingId)) {
      console.warn('[fcm] booking-approved bookingId rejected (bad shape):', bookingId.slice(0, 16));
      return true; // kind recognised, just not actioned
    }
    try {
      const {default: notifee, AndroidImportance} = require('@notifee/react-native') as typeof import('@notifee/react-native');
      const channelId = await notifee.createChannel({
        id: 'booking-updates',
        name: 'Booking updates',
        importance: AndroidImportance.HIGH,
      });
      await notifee.displayNotification({
        id: `booking-approved-${bookingId}`,
        title: 'Booking approved',
        body: 'Ops approved your booking. Tap to continue.',
        data: {kind: 'booking-approved', bookingId},
        android: {
          channelId,
          smallIcon: 'ic_stat_bravo',
          color: NOTIF_ACCENT, // B-66
          importance: AndroidImportance.HIGH,
          onlyAlertOnce: true,
          pressAction: {id: 'default', launchActivity: 'default'},
        },
      });
      console.log('[fcm] booking-approved notif shown for', bookingId);
    } catch (e) {
      console.warn('[fcm] booking-approved notif failed:', (e as Error).message);
    }
    if (opts?.recordActivity) {recordActivityForWake('booking-approved', 'Booking approved', 'Ops approved your booking. Tap to continue.', data);}
    return true;
  }

  const metaBase = AGENT_WAKE_META[kind];
  // vs2 item 16 — "identify the organisation, state that an incident was
  // reported, identify the reporter". Composed HERE and not in the static map
  // because those two names are per-event. Every field is optional: an old
  // server sends none, and a blob-fetch miss delivers none either — both land
  // on the map's generic copy above rather than on "Reported by ." Names are
  // display names the recipient can already see on the roster; no incident
  // detail is added to the banner.
  const meta = metaBase && kind === 'incident-submitted'
    ? {
      ...metaBase,
      title: typeof data.orgName === 'string' && data.orgName.trim()
        ? `${data.orgName.trim()}: incident reported`
        : metaBase.title,
      body: typeof data.reporterName === 'string' && data.reporterName.trim()
        ? `Reported by ${data.reporterName.trim()}. Tap to review.`
        : metaBase.body,
    }
    : metaBase;
  if (meta) {
    // DELIBERATELY NO "already on the screen" suppression for enterprise
    // wakes (removed after adversarial review, 2026-08-07): Approvals and
    // ApprovalStatus refetch on FOCUS only — no interval, no push listener —
    // so a suppressed banner removed the only signal. Worse, nav state
    // survives backgrounding: with the app in the pocket on Approvals,
    // getCurrentRoute() still said 'Approvals' and the wake was silently
    // dropped. Re-add suppression only alongside a refresh signal those
    // screens actually subscribe to.
    try {
      const {default: notifee, AndroidImportance} = require('@notifee/react-native') as typeof import('@notifee/react-native');
      // SOS gets a separate higher-priority channel so a DND-suppressed
      // booking notif can't mask a panic alert; offers + client booking updates
      // get their own channels (LM-N1/LM-N4).
      const channelKey = meta.sos ? SOS_CHANNEL_ID : (meta.channel ?? 'agent-updates');
      const CHANNEL_NAMES: Record<string, string> = {
        [SOS_CHANNEL_ID]: 'SOS alerts', 'agent-updates': 'Agent updates',
        'dispatch-offers': 'Job offers', 'booking-updates': 'Booking updates',
        'incident-updates': 'Incident updates',
        'enterprise-updates': 'Workspace updates',
      };
      const channelId = await notifee.createChannel({
        id: channelKey,
        name: CHANNEL_NAMES[channelKey] ?? 'Updates',
        importance: AndroidImportance.HIGH,
        // See the SOS_CHANNEL_ID migration note at the top of this file.
        ...(meta.sos ? {bypassDnd: true, sound: 'default', vibration: true} : {}),
      });
      if (meta.sos && !legacySosChannelRetired) {
        legacySosChannelRetired = true;
        // Retire the v1 channel so stale installs don't keep a dead
        // "SOS alerts" entry in system settings alongside the v2 one.
        try { await notifee.deleteChannel(LEGACY_SOS_CHANNEL_ID); } catch { /* never created on fresh installs */ }
      }
      // Executive Protection hourly wakes: every hour is a DISTINCT event — without the
      // hour in the id, hour N+1 silently REPLACES hour N's banner
      // (onlyAlertOnce) and a 24 h block alerts audibly once.
      const hourSuffix = (kind === 'detail-hour-checkin' || kind === 'mission-hour-checkin')
        && (typeof data.hourIndex === 'string' || typeof data.hourIndex === 'number')
        ? `-h${data.hourIndex}` : '';
      // Enterprise join wakes carry no per-record id by design (P0-N8), so
      // key on the KIND alone: N pending requests collapse into one banner
      // that replaces in place (onlyAlertOnce keeps repeats quiet) instead of
      // stacking N identical "New join request" cards nobody can tell apart.
      // vs2 edge A2 — PER ORG. The collapse itself is deliberate (N pending
      // requests become one banner instead of N cards nobody can tell apart),
      // but the id was org-agnostic, and now that the payload decides which
      // organisation the tap opens, org B's wake replaced org A's banner AND
      // its data: a two-org admin got one banner and could only ever reach the
      // org that fired last. Collapse within an org, never across them. An
      // org-less wake keeps the bare kind, exactly as before.
      const stableId = kind.startsWith('enterprise.')
        ? (typeof data.orgId === 'string' && data.orgId ? `${kind}:${data.orgId}` : kind)
        : (typeof data.missionId === 'string'
          ? `${kind}-${data.missionId}`
          : typeof data.bookingId === 'string'
          ? `${kind}-${data.bookingId}`
          : `${kind}-${typeof data.eventId === 'string' ? data.eventId : 'evt'}`) + hourSuffix;
      // B-234 — notifee validates data values and rejects the WHOLE
      // displayNotification if any is non-string. RNFirebase types a push's
      // data as string | object, and nested objects are real on the iOS lane,
      // so a bare `as Record<string, string>` cast would silently blank the
      // banner (only a console.warn in the catch). Filter to string values —
      // only string fields were ever read downstream anyway.
      const stringData: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') {stringData[k] = v;}
      }
      await notifee.displayNotification({
        id: stableId,
        title: meta.title,
        body: meta.body,
        data: stringData,
        android: {
          channelId,
          smallIcon: 'ic_stat_bravo',
          color: NOTIF_ACCENT, // B-66
          importance: AndroidImportance.HIGH,
          onlyAlertOnce: true,
          pressAction: {id: 'default', launchActivity: 'default'},
        },
      });
      console.log(`[fcm] ${kind} notif shown`);
    } catch (e) {
      console.warn(`[fcm] ${kind} notif failed:`, (e as Error).message);
    }
    if (opts?.recordActivity) {recordActivityForWake(kind, meta.title, meta.body, data);}
    return true;
  }

  return false;
}
