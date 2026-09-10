/**
 * Executive Protection — product constants and pure helpers.
 *
 * Kept free of React Native / Expo imports so node-side Jest suites (pricing,
 * validation) can import it without dragging in the native chain — same rule
 * as src/screens/booking/pricing.ts.
 */

/** Bookable blocks — fixed 3-hour steps, per the executive product definition. */
export const EXEC_DURATIONS = [3, 6, 9, 12, 15, 18, 21, 24] as const;

export type ExecDurationHours = (typeof EXEC_DURATIONS)[number];

export const isExecDuration = (h: number): h is ExecDurationHours =>
  (EXEC_DURATIONS as readonly number[]).includes(h);

/** Task types — what the protection detail is for (Step 4). */
export const EXEC_TASK_TYPES = [
  {key: 'site_protection',  label: 'Site Protection',            icon: 'office-building-outline'},
  {key: 'event_security',   label: 'Event Security',             icon: 'account-group-outline'},
  {key: 'close_protection', label: 'Close Protection (Escort)',  icon: 'shield-account'},
  {key: 'residential_watch',label: 'Residential Watch',          icon: 'home-outline'},
  {key: 'asset_protection', label: 'Asset Protection',           icon: 'diamond-stone'},
  {key: 'other',            label: 'Other',                      icon: 'dots-horizontal'},
] as const;

export type ExecTaskTypeKey = (typeof EXEC_TASK_TYPES)[number]['key'];

export const isExecTaskType = (k: string): k is ExecTaskTypeKey =>
  EXEC_TASK_TYPES.some(t => t.key === k);

export const execTaskLabel = (k: string): string =>
  EXEC_TASK_TYPES.find(t => t.key === k)?.label ?? 'Site Protection';

/** Secure-transfer leg options (Step 5). */
export const EXEC_TRANSPORT_MODES = ['one_way', 'return', 'both_ways'] as const;
export type ExecTransportMode = (typeof EXEC_TRANSPORT_MODES)[number];
