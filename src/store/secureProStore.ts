import {create} from 'zustand';
import {immer} from 'zustand/middleware/immer';
import {
  secureProApi,
  type ProApplication,
  type ProApplicationCreateBody,
  type ProApplicationHistoryEntry,
  type ProApplicationMessage,
} from '@services/api';

// Bravo Secure Pro application state — the request-and-approval custom plan.
// One open application per user; the store holds the latest one (any status)
// plus its Bravo Control System message thread.

interface SecureProState {
  application: ProApplication | null;
  history: ProApplicationHistoryEntry[];
  messages: ProApplicationMessage[];
  isLoading: boolean;
  isSubmitting: boolean;
  hasLoaded: boolean;
  error: string | null;
}

interface SecureProActions {
  loadApplication: () => Promise<void>;
  submitApplication: (body: ProApplicationCreateBody) => Promise<ProApplication>;
  renewPlan: () => Promise<ProApplication>;
  cancelApplication: () => Promise<void>;
  acceptProposal: () => Promise<void>;
  requestChanges: (message: string) => Promise<void>;
  activate: () => Promise<ProApplication>;
  loadMessages: () => Promise<void>;
  sendMessage: (body: string) => Promise<void>;
  clearError: () => void;
  reset: () => void;
}

function humanError(error: unknown, fallback: string): string {
  const e = error as {response?: {data?: {message?: string; code?: string}}; message?: string};
  const msg = e?.response?.data?.message ?? e?.response?.data?.code;
  if (typeof msg === 'string' && msg.length > 0) {
    if (msg === 'insufficient_credits') {
      return 'Not enough Bravo Credits — top up to activate your plan.';
    }
    if (msg === 'pro_application_exists') {
      return 'You already have an open Pro application.';
    }
    return msg.replace(/_/g, ' ');
  }
  return fallback;
}

// NAV-21 — the single live /pro-applications/me request; concurrent callers
// (the ~9 useProPlanGate screens re-firing on focus) await this one.
let loadApplicationInFlight: Promise<void> | null = null;

export const useSecureProStore = create<SecureProState & SecureProActions>()(
  immer((set, get) => ({
    application: null,
    history: [],
    messages: [],
    isLoading: false,
    isSubmitting: false,
    hasLoaded: false,
    error: null,

    loadApplication: async () => {
      // NAV-21 (2026-08-26 rapid-use audit) — in-flight dedupe. useProPlanGate
      // mounts this on ~9 screens and re-fires it on every focus, so a rapid
      // back/forward burst issued N concurrent /pro-applications/me fetches
      // whose N setState bursts all landed after the transition. Awaiting
      // callers share the one live request; the next focus after it settles
      // still refetches (stale-while-revalidate unchanged).
      if (loadApplicationInFlight) {return loadApplicationInFlight;}
      loadApplicationInFlight = (async () => {
      // B-648 — stale-while-revalidate. SecureServicesScreen (and the Pro screens)
      // call this on EVERY focus, so flipping isLoading unconditionally made a
      // spinner flash over content we already had every time the user came back —
      // the founder's "when back to secure services it loading". The refetch still
      // runs; it just no longer blanks a loaded screen. The FIRST load still shows
      // the loader, because hasLoaded is false then.
      //
      // hasLoaded is deliberately NOT touched here: it is the fail-CLOSED gate for
      // the Pro dashboard (see the catch below), and it must keep its meaning.
      if (!get().hasLoaded) {
        set(s => { s.isLoading = true; });
      }
      try {
        const {data} = await secureProApi.me();
        set(s => {
          s.application = data.application;
          s.history = data.history ?? [];
          s.hasLoaded = true;
          s.error = null;
        });
      } catch (error) {
        set(s => {
          s.error = humanError(error, 'Could not load your Pro application.');
          // Audit Rev2 SP-01 — hasLoaded MUST be set here too, or the Pro
          // dashboard's `if (hasLoaded && !planActive) redirect` gate never
          // runs and every module renders for anyone whose /pro-applications/me
          // call failed (offline, 500, axios timeout, 401 mid-refresh). The
          // gate has to fail closed; "we don't know yet" must not mean "let
          // them in".
          s.hasLoaded = true;
        });
      } finally {
        set(s => { s.isLoading = false; });
      }
      })().finally(() => { loadApplicationInFlight = null; });
      return loadApplicationInFlight;
    },

    renewPlan: async () => {
      const app = get().application;
      if (!app) {throw new Error('No previous plan to renew.');}
      // NAV-13 — synchronous in-flight bail-out. `disabled={isSubmitting}` on
      // the button needs a committed re-render, which is late exactly when the
      // JS thread is lagging; this store read is not (authStore.ts signOut
      // idiom). Silent: callers surface errors via storeError, and a dropped
      // repeat has none.
      if (get().isSubmitting) {throw new Error('Already processing.');}
      set(s => { s.isSubmitting = true; s.error = null; });
      try {
        const {data} = await secureProApi.renew(app.id);
        set(s => { s.application = data.application; });
        return data.application;
      } catch (error) {
        const msg = humanError(error, 'Could not renew your plan. Please try again.');
        set(s => { s.error = msg; });
        throw new Error(msg);
      } finally {
        set(s => { s.isSubmitting = false; });
      }
    },

    cancelApplication: async () => {
      const app = get().application;
      if (!app) {return;}
      if (get().isSubmitting) {throw new Error('Already processing.');}  // NAV-13 — see acceptProposal
      set(s => { s.isSubmitting = true; s.error = null; });
      try {
        const {data} = await secureProApi.cancel(app.id);
        set(s => { s.application = data.application; });
      } catch (error) {
        const msg = humanError(error, 'Could not cancel the application. Please try again.');
        set(s => { s.error = msg; });
        throw new Error(msg);
      } finally {
        set(s => { s.isSubmitting = false; });
      }
    },

    submitApplication: async body => {
      // NAV-13 — see renewPlan.
      if (get().isSubmitting) {throw new Error('Already processing.');}
      set(s => { s.isSubmitting = true; s.error = null; });
      try {
        const {data} = await secureProApi.create(body);
        set(s => {
          s.application = data.application;
          s.hasLoaded = true;
        });
        return data.application;
      } catch (error) {
        const msg = humanError(error, 'Could not submit your Pro request. Please try again.');
        set(s => { s.error = msg; });
        throw new Error(msg);
      } finally {
        set(s => { s.isSubmitting = false; });
      }
    },

    acceptProposal: async () => {
      const app = get().application;
      if (!app) {return;}
      // NAV-13 — THROW, never a silent return (critic): callers navigate on
      // resolve (`await acceptProposal(); replace('SecureProPayment')`), so a
      // silent no-op would take the SUCCESS path before the real accept
      // settled. All callers catch.
      if (get().isSubmitting) {throw new Error('Already processing.');}
      set(s => { s.isSubmitting = true; s.error = null; });
      try {
        const {data} = await secureProApi.accept(app.id);
        set(s => { s.application = data.application; });
      } catch (error) {
        const msg = humanError(error, 'Could not accept the proposal. Please try again.');
        set(s => { s.error = msg; });
        throw new Error(msg);
      } finally {
        set(s => { s.isSubmitting = false; });
      }
    },

    requestChanges: async message => {
      const app = get().application;
      if (!app) {return;}
      if (get().isSubmitting) {throw new Error('Already processing.');}  // NAV-13 — see acceptProposal
      set(s => { s.isSubmitting = true; s.error = null; });
      try {
        const {data} = await secureProApi.requestChanges(app.id, message);
        set(s => { s.application = data.application; });
      } catch (error) {
        const msg = humanError(error, 'Could not send your change request. Please try again.');
        set(s => { s.error = msg; });
        throw new Error(msg);
      } finally {
        set(s => { s.isSubmitting = false; });
      }
    },

    activate: async () => {
      const app = get().application;
      if (!app) {throw new Error('No application to activate.');}
      // NAV-13 — 20 queued taps on "Pay & activate" must not fire 20 activate
      // calls; see renewPlan for why the disabled prop alone cannot stop this.
      if (get().isSubmitting) {throw new Error('Already processing.');}
      set(s => { s.isSubmitting = true; s.error = null; });
      try {
        const {data} = await secureProApi.activate(app.id);
        set(s => { s.application = data.application; });
        return data.application;
      } catch (error) {
        const msg = humanError(error, 'Payment failed. Please try again.');
        set(s => { s.error = msg; });
        throw new Error(msg);
      } finally {
        set(s => { s.isSubmitting = false; });
      }
    },

    loadMessages: async () => {
      const app = get().application;
      if (!app) {return;}
      try {
        const {data} = await secureProApi.messages(app.id);
        set(s => { s.messages = data.messages; });
      } catch {
        // Thread is auxiliary — keep the last good list rather than surfacing
        // a blocking error on a background refresh.
      }
    },

    sendMessage: async body => {
      const app = get().application;
      if (!app) {return;}
      const {data} = await secureProApi.sendMessage(app.id, body);
      set(s => { s.messages.push(data.message); });
    },

    clearError: () => set(s => { s.error = null; }),

    reset: () => set(s => {
      s.application = null;
      s.history = [];
      s.messages = [];
      s.isLoading = false;
      s.isSubmitting = false;
      s.hasLoaded = false;
      s.error = null;
    }),
  })),
);
