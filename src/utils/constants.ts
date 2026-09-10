// Expo 54 inlines `EXPO_PUBLIC_*` vars from .env at bundle time (client-safe only).
// Anything without the prefix is server-side and should never reach the RN bundle.
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? 'https://api.bravosecure.com';
// Finding 19 — keep the hardcoded fallback (a deliberate release-build
// safety net; removing it has previously caused "network error" release
// regressions when the env var didn't reach `expo export:embed`), but warn
// loudly when the fallback is used so a misconfigured build is visible in
// logs instead of silently pointing at prod.
const _envMsgBaseUrl = process.env.EXPO_PUBLIC_MSG_BASE_URL;
if (!_envMsgBaseUrl) {
  console.warn('[config] EXPO_PUBLIC_MSG_BASE_URL not set — using fallback https://msg.bravosecure.com. Verify the build baked the env var.');
}
export const MSG_BASE_URL = _envMsgBaseUrl ?? 'https://msg.bravosecure.com';

export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const AGORA_APP_ID = process.env.EXPO_PUBLIC_AGORA_APP_ID ?? '';
export const GOOGLE_MAPS_API_KEY =
  process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

// Real app version — sourced from app.json (bundled), so UI never shows a
// stale hardcoded string. resolveJsonModule is on (tsconfig).
export const APP_VERSION: string = (require('../../app.json') as {expo?: {version?: string}}).expo?.version ?? '0.0.0';

// ─── Feature flags ───────────────────────────────────────────────────────────
// Auto-dispatch (Uber-style nearest-agency matching). Build-time gate only for
// now; default OFF keeps the legacy admin-mediated booking flow unchanged.
// Why: a later step swaps this for a server-driven bootstrap field so the flag
// can flip without an app rebuild.
export const AUTO_DISPATCH = process.env.EXPO_PUBLIC_AUTO_DISPATCH === 'true';

// Department Chat v2 (provider↔CPO attendance verification + structured incident
// reporting). Build-time gate; default OFF keeps the legacy attendance/chat
// surfaces unchanged. Why: a later step swaps this for a server-driven bootstrap
// field (`deptChatV2`) so the flag can flip per-org without an app rebuild.
export const DEPT_CHAT_V2 = process.env.EXPO_PUBLIC_DEPT_CHAT_V2 === 'true';

// ─── Booking ─────────────────────────────────────────────────────────────────
export const BOOKING_MIN_LEAD_HOURS = 3;
export const BOOKING_MIN_DURATION_HOURS = 4;
export const BOOKING_MAX_DURATION_HOURS = 24;

// ─── Regions ─────────────────────────────────────────────────────────────────
// LM-V7 — mirrors the auth-service canonical list (common/regions.ts). This copy
// previously carried US (never dispatchable) and missed SA/BD — the classic
// three-way region drift that produced silent NO_PROVIDERs. Change regions THERE
// first, then mirror here.
export const SUPPORTED_REGIONS = [
  {code: 'AE', label: 'UAE', currency: 'AED'},
  {code: 'SA', label: 'Saudi Arabia', currency: 'SAR'},
  {code: 'BD', label: 'Bangladesh', currency: 'BDT'},
  {code: 'GB', label: 'United Kingdom', currency: 'GBP'},
  {code: 'ZA', label: 'South Africa', currency: 'ZAR'},
] as const;

// ─── Phone dial codes (login / registration country picker) ──────────────────
// `digits` = national-significant-number length (excluding leading zero and dial code).
export const DIAL_CODES = [
  {code: 'AE', flag: '🇦🇪', label: 'UAE',            dial: '+971', digits: 9},
  {code: 'IN', flag: '🇮🇳', label: 'India',          dial: '+91',  digits: 10},
  {code: 'GB', flag: '🇬🇧', label: 'United Kingdom', dial: '+44',  digits: 10},
  {code: 'US', flag: '🇺🇸', label: 'United States',  dial: '+1',   digits: 10},
  {code: 'ZA', flag: '🇿🇦', label: 'South Africa',   dial: '+27',  digits: 9},
  {code: 'SA', flag: '🇸🇦', label: 'Saudi Arabia',   dial: '+966', digits: 9},
  {code: 'PK', flag: '🇵🇰', label: 'Pakistan',       dial: '+92',  digits: 10},
  {code: 'BD', flag: '🇧🇩', label: 'Bangladesh',     dial: '+880', digits: 10},
  {code: 'AU', flag: '🇦🇺', label: 'Australia',      dial: '+61',  digits: 9},
  {code: 'SG', flag: '🇸🇬', label: 'Singapore',      dial: '+65',  digits: 8},
] as const;
export type DialCode = (typeof DIAL_CODES)[number];

// ─── User Roles ──────────────────────────────────────────────────────────────
export const USER_ROLE_LABELS = {
  individual: 'Individual Client',
  corporate: 'Corporate Client',
  agent: 'Security Agent / CPO',
  ops: 'Operations Room',
} as const;

// ─── Message Self-Destruct Intervals ─────────────────────────────────────────
export const SELF_DESTRUCT_OPTIONS = [
  {label: 'Off', value: null},
  {label: '1 minute', value: 60},
  {label: '5 minutes', value: 300},
  {label: '1 hour', value: 3600},
  {label: '24 hours', value: 86400},
  {label: '7 days', value: 604800},
] as const;

// ─── Storage Buckets ─────────────────────────────────────────────────────────
export const STORAGE_BUCKETS = {
  avatars: 'avatars',
  vault: 'secure-vault',
  kyc: 'kyc-documents',
  itineraries: 'itineraries',
} as const;

// ─── Realtime Channels ───────────────────────────────────────────────────────
export const REALTIME_CHANNELS = {
  liveTracking: (bookingId: string) => `live:${bookingId}`,
  sos: (bookingId: string) => `sos:${bookingId}`,
  jobRequests: (agentId: string) => `jobs:${agentId}`,
  bookingStatus: (bookingId: string) => `booking:${bookingId}`,
} as const;
