/**
 * IncomingOfferWatcher (BUILD_RUNBOOK Step 20) — the agency-wide "interrupt from any screen"
 * driver. The FCM dispatch wake is intentionally opaque (and not yet routed client-side), so
 * the robust path is to POLL `GET /dispatch/offers/current` while the agency app is
 * foregrounded; when a fresh offer surfaces, deep-link into the full-screen IncomingOffer
 * interrupt via navigationRef (AgentNavigator is the active navigator, so the route resolves).
 *
 * Renders nothing. Self-disables for non-agency callers: GET /dispatch/offers/current is
 * OrgManagerGuard-gated, so a 401/403 means "not a company agency" → stop polling (no noise).
 * Mounted once in AgentNavigator so it covers every agency screen.
 */
import {useEffect, useRef} from 'react';
import {AppState} from 'react-native';
import {navigationRef} from '@navigation/navigationRef';
import {dispatchApi} from '@services/api';

const POLL_MS = 5000;
// LM-N1 — was 2500ms: with a 30s offer TTL every startup ms counts; the dashboard
// mount survives one light GET just fine.
const FIRST_DELAY_MS = 500;
// LM-A2 — how long a surfaced offer stays muted after the user leaves the screen
// without resolving it (backed out / decline failed). The offer is still LIVE and
// assigned to this org until its TTL, so re-interrupting after the snooze is
// correct — the old permanent `handled` set buried it for the whole session.
const RESURFACE_SNOOZE_MS = 12_000;

export default function IncomingOfferWatcher(): null {
  // offer_id → last time we surfaced it. Prevents an immediate re-interrupt loop
  // while still allowing a live, unresolved offer to come back after the snooze.
  const surfacedAt = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (!alive) {return;}
      // Skip entirely unless foregrounded AND not already on the offer screen. When an
      // IncomingOffer screen is mounted it owns the polling (and handles the offer + any
      // cascade via its own poll + auto-dismiss), so polling here too is redundant churn
      // against the server throttle — and skipping it makes the de-dup structural (we never
      // fire a second navigate while the first screen is up) rather than timing-dependent.
      const onOfferScreen = navigationRef.isReady() && navigationRef.getCurrentRoute()?.name === 'IncomingOffer';
      if (AppState.currentState === 'active' && !onOfferScreen) {
        try {
          const {data} = await dispatchApi.getCurrentOffer();
          if (!alive) {return;}
          const last = data ? surfacedAt.current.get(data.offer_id) : undefined;
          const snoozed = last !== undefined && Date.now() - last < RESURFACE_SNOOZE_MS;
          if (data && !snoozed && navigationRef.isReady()) {
            surfacedAt.current.set(data.offer_id, Date.now());
            // Two-step cast: navigationRef.navigate's deeply-nested param union can't be
            // satisfied by a single cast (matches the MainNavigator incoming-call pattern).
            (navigationRef.navigate as unknown as (name: string, params?: unknown) => void)(
              'IncomingOffer', {offerId: data.offer_id},
            );
          }
        } catch (e: unknown) {
          const status = (e as {response?: {status?: number}})?.response?.status;
          if (status === 401 || status === 403) {alive = false; return;} // not an agency — stop.
        }
      }
      if (alive) {timer = setTimeout(() => { void tick(); }, POLL_MS);}
    };

    timer = setTimeout(() => { void tick(); }, FIRST_DELAY_MS);
    return () => { alive = false; if (timer) {clearTimeout(timer);} };
  }, []);

  return null;
}
