/**
 * 12-hour wall-clock helpers for the booking dashboards (Secure Services
 * Streamlined, GAP 1). Pure — no RN imports — so the node `booking` Jest
 * project pins the arithmetic. Hours in/out of the app stay 24-hour (the draft
 * shape is untouched); these only convert at the picker / label boundary.
 */

const pad = (n: number): string => n.toString().padStart(2, '0');

/** 0-23 → {hour12: 1-12, pm}. Midnight is 12 AM, noon is 12 PM. */
export function to12h(hour24: number): {hour12: number; pm: boolean} {
  const h = ((hour24 % 24) + 24) % 24;
  return {hour12: ((h + 11) % 12) + 1, pm: h >= 12};
}

/** {1-12, pm} → 0-23. */
export function to24h(hour12: number, pm: boolean): number {
  return (hour12 % 12) + (pm ? 12 : 0);
}

/** "6:25 PM" — hour unpadded, minute padded. */
export function formatTime12h(hour24: number, minute: number): string {
  const {hour12, pm} = to12h(hour24);
  return `${hour12}:${pad(minute)} ${pm ? 'PM' : 'AM'}`;
}

/**
 * Round UP to the next `step`-minute boundary on the local clock (seconds and
 * milliseconds cleared; a time already on the boundary is unchanged). Returns a
 * new Date — the same formula the dashboards use for "earliest start".
 */
export function roundUpToMinuteStep(d: Date, step = 5): Date {
  const out = new Date(d.getTime());
  out.setMinutes(Math.ceil(out.getMinutes() / step) * step, 0, 0);
  return out;
}
