/**
 * Post-confirm BOOKING SUMMARY rows — one pure builder shared by
 * OpsRoomReviewScreen (pending / approved / rejected) and
 * BookingConfirmationScreen (paid), so both reproduce every selected value the
 * server actually echoes (ClientBooking → src/types Booking).
 *
 * Honesty rules (pinned by bookingSummaryRows.test.ts):
 *   - a row is rendered ONLY from a field the booking carries; nothing is
 *     defaulted (the draft is cleared at submit, so it is never a source);
 *   - the referral code and the itemised price split are persisted server-side
 *     but NOT returned, so they are omitted rather than shown as "—";
 *   - consent is rendered from a server INVARIANT: the auto-dispatch path
 *     refuses a booking without location + terms consent, so
 *     `dispatch_mode === 'auto'` ⇒ accepted. Legacy bookings omit the row.
 *
 * Kept free of RN/Expo imports so the node `booking` Jest project can run it.
 */
import type {Booking} from '../../types';
import {formatTime12h} from '../../components/booking/time12h';
import {EXEC_ADDONS} from '../executive/executivePricing';
import {execTaskLabel, isExecTaskType} from '../executive/executiveProduct';

export interface SummaryRow {
  label: string;
  value: string;
  highlight?: boolean;
}

/** Structural subset of the wire Booking — every field optional so a list row
 *  or a half-loaded booking fits. `notes` is nullable on the wire
 *  (ClientBooking.notes: string | null) even though the mobile type says string. */
export type SummaryBooking = Partial<Pick<Booking,
  | 'service' | 'booking_mode' | 'start_time' | 'pickup' | 'dropoff'
  | 'duration_hours' | 'passengers' | 'cpo_count' | 'vehicle_count' | 'driver_only'
  | 'add_ons' | 'total_eur' | 'dispatch_mode' | 'task_type' | 'exec_transport'
>> & {notes?: string | null};

export interface SummaryOptions {
  /** Live catalogue labels (GET /bookings/add-ons) keyed by add-on id. */
  addOnLabels?: Record<string, string>;
}

const SERVICE_LABELS: Record<string, string> = {
  secure_transfer: 'Secure Transfer',
  executive_protection: 'Executive Protection',
  recon_team: 'Recon Team',
  emergency_extraction: 'Emergency Extraction',
};

// Offline fallback for the Lite catalogue (lite_booking_add_ons seed). The live
// catalogue is ops-editable and authoritative — pass it via `addOnLabels`.
const LITE_ADDON_LABELS: Record<string, string> = {
  female_cpo: 'Female CPO Team',
  recon: 'Recon Team',
  medical: 'Medical Support',
  comms: 'Comms / SIGINT',
};

const TRANSFER_MODE_LABELS: Record<string, string> = {
  one_way: 'One Way',
  return: 'Return',
  both_ways: 'Both Ways',
};

const DASH = '—';

const humanise = (key: string): string => {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
};

/**
 * The client's LOCAL time, 12-hour — the same clock the booking dashboards use
 * to pick it (review round 1: the summary rendered "14:30Z" for a time the user
 * had just chosen as "2:30 PM"; a summary that "reproduces every selected
 * value" must show the value as selected, not the wire's UTC form).
 */
export function formatBookingTime(iso: string | null | undefined): string | null {
  if (!iso) {return null;}
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return null;}
  const day = d.toLocaleDateString('en-GB', {weekday: 'short', day: '2-digit', month: 'short'});
  return `${day} · ${formatTime12h(d.getHours(), d.getMinutes())}`;
}

const addressOf = (loc: {address?: string; label?: string} | null | undefined): string | null => {
  const a = loc?.address?.trim();
  if (a) {return a;}
  const l = loc?.label?.trim();
  return l || null;
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function addOnLabel(id: string, isExec: boolean, live?: Record<string, string>): string {
  const fromLive = live?.[id];
  if (fromLive) {return fromLive;}
  if (isExec) {
    const def = EXEC_ADDONS.find(a => a.id === id);
    if (def) {return def.label;}
  }
  return LITE_ADDON_LABELS[id] ?? humanise(id);
}

function scheduleRow(b: SummaryBooking): SummaryRow | null {
  const when = formatBookingTime(b.start_time);
  const mode = b.booking_mode === 'now' ? 'Book Now' : b.booking_mode === 'later' ? 'Book Later' : null;
  if (!when && !mode) {return null;}
  return {label: 'Schedule', value: [mode, when].filter(Boolean).join(' · ')};
}

function totalRow(b: SummaryBooking): SummaryRow | null {
  if (typeof b.total_eur !== 'number' || !Number.isFinite(b.total_eur)) {return null;}
  return {label: 'Estimated Total', value: `${Math.round(b.total_eur).toLocaleString()} BC`, highlight: true};
}

function consentRow(b: SummaryBooking, label: string): SummaryRow | null {
  // Why: the server gates the auto path on location + terms consent
  // (booking.service create), so 'auto' is proof it was accepted; the legacy
  // path never asks, and the flag itself is not echoed — omit there.
  return b.dispatch_mode === 'auto' ? {label, value: 'Accepted'} : null;
}

function secureTransferRows(b: SummaryBooking, opts?: SummaryOptions): Array<SummaryRow | null> {
  const addOns = Array.isArray(b.add_ons) ? b.add_ons : null;
  const hasTeam = typeof b.cpo_count === 'number';
  let team: string | null = null;
  if (hasTeam) {
    const cpos = plural(b.cpo_count as number, 'CPO', 'CPOs');
    const vehicles = b.driver_only === true
      ? 'Client vehicle + Bravo driver'
      : typeof b.vehicle_count === 'number' && b.vehicle_count > 0
        ? `${plural(b.vehicle_count, 'Vehicle', 'Vehicles')} + Driver`
        : null;
    team = vehicles ? `${cpos} · ${vehicles}` : cpos;
  }
  return [
    b.service ? {label: 'Service', value: SERVICE_LABELS[b.service] ?? humanise(b.service)} : null,
    scheduleRow(b),
    addressOf(b.pickup) ? {label: 'Pick-up', value: addressOf(b.pickup) as string} : null,
    addressOf(b.dropoff) ? {label: 'Drop-off', value: addressOf(b.dropoff) as string} : null,
    typeof b.duration_hours === 'number' ? {label: 'Duration', value: `${b.duration_hours} hrs est.`} : null,
    typeof b.passengers === 'number' ? {label: 'Passengers', value: String(b.passengers)} : null,
    team ? {label: 'Team', value: team} : null,
    typeof b.driver_only === 'boolean' ? {label: 'Driver Only', value: b.driver_only ? 'Yes' : 'No'} : null,
    addOns
      ? {label: 'Add-ons', value: addOns.length ? addOns.map(id => addOnLabel(id, false, opts?.addOnLabels)).join(' · ') : 'None'}
      : null,
    b.notes !== undefined ? {label: 'Notes', value: b.notes?.trim() || DASH} : null,
    consentRow(b, 'Consent'),
    totalRow(b),
  ];
}

function executiveRows(b: SummaryBooking, opts?: SummaryOptions): Array<SummaryRow | null> {
  const addOns = Array.isArray(b.add_ons) ? b.add_ons : null;
  const t = b.exec_transport ?? null;
  const otherAddOns = addOns ? addOns.filter(id => id !== 'female_cpo') : [];
  const transferRows: Array<SummaryRow | null> = t
    ? [
        {label: 'Transfer type', value: TRANSFER_MODE_LABELS[t.mode] ?? humanise(t.mode)},
        addressOf(t.pickup) ? {label: 'Pick-up', value: addressOf(t.pickup) as string} : null,
        addressOf(t.dropoff) ? {label: 'Drop-off', value: addressOf(t.dropoff) as string} : null,
        // Why: the wire documents a null pickup_time as "same as the booking start".
        {label: 'Pick-up time', value: formatBookingTime(t.pickup_time) ?? 'Same as start time'},
        typeof t.passengers === 'number' ? {label: 'Passengers', value: String(t.passengers)} : null,
        typeof b.vehicle_count === 'number' ? {label: 'Vehicles', value: String(b.vehicle_count)} : null,
        typeof b.driver_only === 'boolean' ? {label: 'Driver Only', value: b.driver_only ? 'Yes' : 'No'} : null,
      ]
    : [];
  return [
    b.service ? {label: 'Service', value: SERVICE_LABELS[b.service] ?? humanise(b.service)} : null,
    scheduleRow(b),
    typeof b.duration_hours === 'number' ? {label: 'Duration', value: `${b.duration_hours} hrs`} : null,
    addressOf(b.pickup) ? {label: 'Service location', value: addressOf(b.pickup) as string} : null,
    b.task_type
      ? {label: 'Event / Task type', value: isExecTaskType(b.task_type) ? execTaskLabel(b.task_type) : humanise(b.task_type)}
      : null,
    b.notes !== undefined ? {label: 'Description', value: b.notes?.trim() || DASH} : null,
    typeof b.cpo_count === 'number' ? {label: 'CPOs required', value: String(b.cpo_count)} : null,
    addOns ? {label: 'Female CPO', value: addOns.includes('female_cpo') ? 'Selected' : 'Not selected'} : null,
    b.exec_transport !== undefined ? {label: 'Secure Transfer', value: t ? 'Added' : 'Not added'} : null,
    ...transferRows,
    otherAddOns.length
      ? {label: 'Add-ons', value: otherAddOns.map(id => addOnLabel(id, true, opts?.addOnLabels)).join(' · ')}
      : null,
    consentRow(b, 'Location consent'),
    totalRow(b),
  ];
}

export function buildBookingSummaryRows(
  booking: SummaryBooking | null | undefined,
  opts?: SummaryOptions,
): SummaryRow[] {
  if (!booking) {return [];}
  const rows = booking.service === 'executive_protection'
    ? executiveRows(booking, opts)
    : secureTransferRows(booking, opts);
  return rows.filter((r): r is SummaryRow => r !== null);
}
