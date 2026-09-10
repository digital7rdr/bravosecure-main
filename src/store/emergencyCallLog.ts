import {create} from 'zustand';
import {persist, createJSONStorage} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * PDF item 08 — "Emergency Calls have not been added to Calls Log."
 *
 * ── WHY THIS STORE HAS TO EXIST AT ALL ───────────────────────────────────
 *
 * Every other row in the Calls Log is a projection of the encrypted message
 * store: a WebRTC call produces a call bubble, and `selectCallMessages` reads
 * those back. An emergency call produces NOTHING of the kind — it is a
 * `Linking.openURL('tel:…')` hand-off to the OS dialler. Android and iOS both
 * refuse to tell an app what happened after that: no duration, no answered/
 * missed, no callee identity beyond the number we passed in.
 *
 * So the only moment at which the app can honestly record anything is the
 * instant it hands off. That is what this store keeps, and it is deliberately
 * the ONLY claim it makes: "this device placed an emergency call to this number
 * at this time".
 *
 * ── WHAT IT MUST NEVER RECORD ────────────────────────────────────────────
 *
 * ⚠️ SOS IS NOT A CALL. `SOSScreen` / the panic lane raise an alert to Ops and
 * place no call whatsoever. Logging one here would put "Emergency call placed"
 * in the call history of a security app when no call happened — a false record
 * in the one log a user would reach for after an incident. SOS history already
 * exists server-side and is surfaced by `ProtectionHistoryScreen`; that is
 * where it belongs. Do not "unify" the two.
 *
 * ⚠️ AND NO OUTCOME IS INVENTED. There is no `duration`, no `answered`, no
 * `missed` field, because the OS never tells us and a guessed value would be
 * indistinguishable from a measured one. The row says what we know and stops.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────
 *
 * Local to the device, never synced. It holds a dialled number and a label,
 * which is ordinary call-history data, but it is emergency-shaped — so it is
 * capped, it is wiped on sign-out with the rest of the local state, and it is
 * never attached to an envelope. Do NOT add a server mirror without an
 * architecture decision: "who did this person call in a crisis" is a different
 * disclosure from anything the relay carries today.
 */
export interface EmergencyCallRecord {
  /** Local id. Time-based + the number, so a double-tap dedupes naturally. */
  id: string;
  /** The number as dialled, already sanitised by the caller. */
  number: string;
  /**
   * What the user tapped, e.g. "Police", "Ambulance", "Next of kin — Dad".
   * Display only; never parsed. Absent when the caller genuinely has no label
   * (a typed number), and the row then shows the number alone.
   */
  label?: string;
  /** Where it was placed from, so the row can say "Emergency directory" vs
   *  "Next of kin". Display only. */
  source: 'directory' | 'next-of-kin' | 'quick-dial';
  /** Country ISO for a directory call, when the screen knew one. */
  countryIso?: string;
  /** Epoch ms at hand-off. NOT a call start — the OS may never connect. */
  at: number;
}

/** Keep the list bounded. A crisis can mean several taps in a minute, and this
 *  is a log, not an archive — the Calls Log itself shows a rolling window. */
const MAX_RECORDS = 100;

/** Two taps on the same number inside this window are one call, not two.
 *  Real: the dialler takes a moment to foreground, and users tap again. */
const DEDUPE_MS = 15_000;

interface EmergencyCallLogState {
  records: EmergencyCallRecord[];
  /** Record a hand-off. Safe to call on every dial; it dedupes. */
  record: (r: Omit<EmergencyCallRecord, 'id' | 'at'> & {at?: number}) => void;
  clear: () => void;
}

export const useEmergencyCallLog = create<EmergencyCallLogState>()(
  persist(
    (set, get) => ({
      records: [],
      record: input => {
        const at = input.at ?? Date.now();
        const {records} = get();
        // Dedupe against the most recent entry only: the list is newest-first,
        // and a repeat tap is always adjacent. Scanning the whole list would
        // also collapse a legitimate call-back minutes later.
        const head = records[0];
        if (head && head.number === input.number && at - head.at < DEDUPE_MS) {return;}
        const rec: EmergencyCallRecord = {
          id: `em-${at}-${input.number}`,
          number: input.number,
          label: input.label,
          source: input.source,
          countryIso: input.countryIso,
          at,
        };
        set({records: [rec, ...records].slice(0, MAX_RECORDS)});
      },
      clear: () => set({records: []}),
    }),
    {
      name: 'bravo-emergency-call-log',
      storage: createJSONStorage(() => AsyncStorage),
      // Only the data. The actions are re-created by the factory on every boot,
      // and persisting them would serialise functions to null.
      partialize: s => ({records: s.records}),
      version: 1,
    },
  ),
);

/** Read the log without subscribing — for a one-shot merge in a selector. */
export const getEmergencyCallRecords = (): EmergencyCallRecord[] =>
  useEmergencyCallLog.getState().records;

/**
 * ONE place that turns a raw number + context into a record.
 *
 * Exported as a plain function rather than left to each caller so the three
 * `tel:` sites cannot drift in what they store — the shape of a row is a
 * property of the log, not of the screen that happened to place the call.
 * `sanitised` is what was actually handed to the dialler, so the log and the
 * dialler can never disagree about which number was called.
 */
export function recordEmergencyCall(args: {
  sanitised: string;
  label?: string;
  source: EmergencyCallRecord['source'];
  countryIso?: string;
}): void {
  if (!args.sanitised) {return;}
  useEmergencyCallLog.getState().record({
    number: args.sanitised,
    label: args.label,
    source: args.source,
    countryIso: args.countryIso,
  });
}
