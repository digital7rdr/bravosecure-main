/**
 * Secure LITE flow footer (PDF-2 "Secure Services Streamlined", client feedback
 * 2026-08-22 "Wrong Nav Bar").
 *
 * Wave 5d put the 4-tab Secure bar (Home · Book · Summary · Messenger) on the
 * `SecureShell` route only. Every DEEPER booking route — the consolidated Secure
 * Transfer / Executive Protection dashboards, the location picker, the credit
 * paywall, the post-confirm Summary surfaces — is a pushed screen in
 * `BookingNavigator`, where the ROOT footer (MESSENGER · PROFILE) came back. The
 * client photographed exactly that under "Confirm Booking". The spec is explicit:
 * "the bottom navigation highlights Booking throughout data entry" and "Summary"
 * on the summary screen.
 *
 * This module is the DECISION, kept pure so it is unit-testable: given the
 * product, the focused root tab, the focused nested booking route (+ its params)
 * and whether the LITE shell is actually mounted beneath, which Secure tab (if
 * any) the root footer should render as the Secure flow bar. The root
 * `CustomTabBar` in MainNavigator consumes it — the bar itself stays a single
 * renderer (no fourth tab-bar component, the B-245 inset contract holds).
 *
 * WHY "SHELL MOUNTED" IS AN INPUT (review round 1, both reviewers): a flow-bar
 * press navigates INTO `SecureShell`. React Navigation's NAVIGATE pops back to a
 * route that already exists in the stack — but PUSHES it when it does not. A PRO
 * retainer client's stack is `[BookingHome, ProDashboard, …]` (no shell), and a
 * LITE deep-link seed can be `[BookingHome, X]`; on those stacks the same press
 * would push the LITE shell ON TOP of a Pro stack. So the bar renders only when
 * a press would be a POP: the shell is beneath the focused route.
 */
import type {SecureShellTabParamList} from './types';

export type SecureFlowTab = keyof SecureShellTabParamList;

/** Founder order, same as the SecureTabNavigator declaration. */
export const SECURE_FLOW_ORDER: readonly SecureFlowTab[] = ['Home', 'Book', 'Summary', 'Messenger'];

/**
 * BookingNavigator route → the Secure tab that must be lit while it is focused.
 *
 * Only LITE booking-flow routes and the "existing areas" the Lite Home opens
 * belong here. Pro / VBG / Profile-hosted routes are deliberately absent: they
 * keep the root MESSENGER · PROFILE footer (the client's own Pro dashboard mock
 * shows that footer, and Profile-hosted screens highlight PROFILE via
 * PROFILE_HOSTED_ROUTES, which takes precedence). The Pro APPLICATION flow
 * (SecurePro*) stays off this map on purpose: SecureProApply keeps its fields in
 * local state, and a footer that pops it would be the B-393 class.
 */
export const SECURE_FLOW_TAB: Readonly<Record<string, SecureFlowTab>> = {
  // The Book-Now home as a focused STACK route (it is normally the shell's Home
  // tab). Reached this way only beneath a deep link, or as the PRO back target —
  // and for PRO the shell is not mounted, so the guard below yields null there.
  BookingHome: 'Home',
  // "Open existing areas" from Home (PDF-2 Home stage): the plans chooser and
  // its tier surfaces, the activity bell.
  SecureServices: 'Home',
  SecureLux: 'Home',
  Pricing: 'Home',
  TierPaywall: 'Home',
  ActivityCenter: 'Home',

  // ── Book: service choice + the one-dashboard-per-service flow ─────────────
  ServiceType: 'Book',
  CustomizeAddOns: 'Book',   // the Secure Transfer dashboard
  ExecReview: 'Book',        // the Executive Protection dashboard
  LocationPicker: 'Book',
  ZoneMap: 'Book',
  // Legacy wizard steps — still registered (deep links / stale stacks), so
  // they light Book rather than falling back to the root footer.
  BookingDateTime: 'Book',
  BaselinePackage: 'Book',
  AddOns: 'Book',
  ExecDuration: 'Book',
  ExecSchedule: 'Book',
  ExecTask: 'Book',
  ExecTransport: 'Book',
  ExecTeam: 'Book',

  // ── Summary: everything the booking becomes after Confirm ─────────────────
  OpsRoomReview: 'Summary',
  BookingConfirmation: 'Summary',
  FindingDetail: 'Summary',
  NoDetail: 'Summary',
  AgencyAccepted: 'Summary',
  LiveTracking: 'Summary',
  SOSScreen: 'Summary',
  TripSummary: 'Summary',
  MissionComplete: 'Summary',
  Invoice: 'Summary',
  RateAgency: 'Summary',
  BookingHistory: 'Summary',  // "My Bookings" — the list of summaries
};

/**
 * `CreditPaywall` is ONE route with three doors, and only one of them is the
 * booking flow: the insufficient-credits detour off Confirm (`source:
 * 'booking-flow'`) lights Book; the retry-charge door off the Ops Room
 * (`'opsroom'`) stays in the Summary context; a wallet top-up from Profile
 * (`'wallet'`, or no source) is not the booking flow at all — root footer.
 */
function creditPaywallTab(params: Record<string, unknown> | null | undefined): SecureFlowTab | null {
  const source = params?.source;
  if (source === 'booking-flow') {return 'Book';}
  if (source === 'opsroom') {return 'Summary';}
  return null;
}

export interface SecureFlowInput {
  /** `useProductStore().activeProduct` — only the Secure product has this bar. */
  activeProduct: string | null | undefined;
  /** The focused ROOT tab route name. */
  focusedRouteName: string;
  /** The focused route INSIDE SecureTab (getFocusedRouteNameFromRoute), if any. */
  nestedRouteName: string | null | undefined;
  /** That focused route's params (for the routes whose door decides the tab). */
  nestedRouteParams?: Record<string, unknown> | null;
  /** True when the nested route is Profile-hosted — PROFILE wins, never this bar. */
  profileHosted: boolean;
  /**
   * True when `SecureShell` is in the SecureTab stack BENEATH the focused route,
   * so a press pops back to it. False (the PRO stack, a cold deep-link seed)
   * means the ordinary root footer — never a bar whose press would push a
   * second shell.
   */
  shellMounted: boolean;
}

/**
 * Which Secure tab to light — or null, meaning "render the ordinary root
 * footer". Null is the safe default for every route not in the map, so a new
 * booking route falls back to the pre-existing behaviour, never to a blank bar.
 */
export function secureFlowTabFor(input: SecureFlowInput): SecureFlowTab | null {
  if (input.activeProduct !== 'secure') {return null;}
  if (input.focusedRouteName !== 'SecureTab') {return null;}
  if (input.profileHosted) {return null;}
  if (!input.shellMounted) {return null;}
  if (!input.nestedRouteName) {return null;}
  if (input.nestedRouteName === 'CreditPaywall') {return creditPaywallTab(input.nestedRouteParams);}
  return SECURE_FLOW_TAB[input.nestedRouteName] ?? null;
}

/**
 * Routes where a flow-bar Home/Summary press pops a surface holding state the
 * store does NOT carry (local picker time, a half-placed pin, a search in
 * flight) — the same "Leave this screen?" confirmation the drawer's Switch
 * Dashboard uses before it truncates a stack (B-393 class). Summary surfaces
 * and the plain chooser hold nothing unsaved, so they pop silently, like the
 * root SECURE tab always has.
 */
export const SECURE_FLOW_CONFIRM_LEAVE: ReadonlySet<string> = new Set([
  'CustomizeAddOns', 'ExecReview', 'LocationPicker', 'ServiceType', 'ZoneMap',
  'BookingDateTime', 'BaselinePackage', 'AddOns',
  'ExecDuration', 'ExecSchedule', 'ExecTask', 'ExecTransport', 'ExecTeam',
]);
