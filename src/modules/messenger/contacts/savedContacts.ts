import * as Contacts from 'expo-contacts';
import {normalizeToE164} from './phoneNormalize';

/**
 * "Is this peer's number actually in my phone's address book?" — and, if not,
 * a way to save it under their Bravo name.
 *
 * Why this exists: when a number is NOT saved, the app falls back to the
 * peer's REGISTERED Bravo display name (`useRegisteredNames`, B-79). That is a
 * good fallback, but it is indistinguishable on screen from a name that came
 * out of your own address book — so you cannot tell whether you actually have
 * the person saved. This module supplies the missing signal, plus the action
 * that closes the gap.
 *
 * Two deliberate design choices:
 *
 * 1. **Saving goes through the SYSTEM contact form** (`presentFormAsync`), not
 *    `addContactAsync`. Writing to someone's address book is an outward-facing,
 *    not-easily-undone side effect, and doing it silently on a tap is the wrong
 *    default — the system sheet lets the user see exactly what will be written,
 *    edit it, and cancel. It also means saving needs no WRITE permission of our
 *    own on Android.
 *
 * 2. **Unknown is NOT "unsaved".** Reading the address book needs permission.
 *    If it is denied or unavailable we return `'unknown'`, and the UI shows
 *    nothing rather than claiming the contact is unsaved — a wrong "not saved"
 *    badge would push people to create duplicate contacts they already have.
 *
 * The lookup index is built once per session and refreshed after a successful
 * save, so the badge flips without an app restart.
 */

export type SavedState = 'saved' | 'not-saved' | 'unknown';

/** E.164 numbers present in the device address book. Null until first load. */
let index: Set<string> | null = null;
let loading: Promise<Set<string> | null> | null = null;

function contactsAvailable(): boolean {
  // Mirrors useDiscoveredContacts' guard — the module is absent on web/jest.
  return typeof Contacts.getPermissionsAsync === 'function';
}

/**
 * Build (or reuse) the address-book index.
 *
 * `requestPermission: false` by default: the badge must never trigger a
 * permission prompt just because a chat screen rendered. The prompt belongs to
 * an explicit user action — see `refreshSavedContacts`.
 */
async function loadIndex(requestPermission: boolean): Promise<Set<string> | null> {
  if (index) {return index;}
  if (loading) {return loading;}
  loading = (async () => {
    try {
      if (!contactsAvailable()) {return null;}
      const perm = requestPermission
        ? await Contacts.requestPermissionsAsync()
        : await Contacts.getPermissionsAsync();
      if (perm.status !== Contacts.PermissionStatus.GRANTED) {return null;}
      const {data} = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers],
      });
      const set = new Set<string>();
      for (const c of data ?? []) {
        for (const p of c.phoneNumbers ?? []) {
          // Store BOTH the normalized form and a digits-only tail. Address
          // books hold numbers in wildly inconsistent shapes ("0171…",
          // "+880171…", "01 71 …"), and normalizeToE164 can only resolve a
          // local-format number when it can infer the calling code — which it
          // often cannot for an arbitrary address-book row.
          const raw = p.number ?? '';
          const e164 = normalizeToE164(raw);
          if (e164) {set.add(e164);}
          const digits = raw.replace(/\D/g, '');
          if (digits.length >= 7) {set.add(TAIL_PREFIX + digits.slice(-9));}
        }
      }
      index = set;
      return set;
    } catch {
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * Sentinel prefix for the digits-tail entries, so a 9-digit tail can never be
 * confused with a real E.164 value in the same Set.
 */
const TAIL_PREFIX = 'tail:';

/**
 * Last-9-digits comparison. Two numbers that agree on their last 9 digits are
 * the same subscriber in every numbering plan we support; comparing full
 * strings would miss "+8801711…" vs "01711…", which is the single most common
 * way a saved contact fails to match.
 */
function tailOf(e164: string): string | null {
  const digits = e164.replace(/\D/g, '');
  return digits.length >= 7 ? TAIL_PREFIX + digits.slice(-9) : null;
}

/**
 * Is this number in the address book? Never prompts for permission — a screen
 * rendering a badge must not raise a system dialog.
 */
export async function getSavedState(phoneE164: string | null | undefined): Promise<SavedState> {
  if (!phoneE164) {return 'unknown';}
  const set = await loadIndex(false);
  if (!set) {return 'unknown';}
  if (set.has(phoneE164)) {return 'saved';}
  const tail = tailOf(phoneE164);
  return tail && set.has(tail) ? 'saved' : 'not-saved';
}

/**
 * Drop the cached index so the next `getSavedState` re-reads the address book.
 * Called after a save, and safe to call when the user grants permission later.
 */
export function invalidateSavedContacts(): void {
  index = null;
}

/**
 * Open the system "new contact" form pre-filled with the peer's Bravo display
 * name and number. Resolves once the sheet closes; the caller re-checks the
 * saved state rather than trusting a return value, because the user may have
 * edited or cancelled and the platforms disagree on what they report.
 */
export async function presentSaveContact(args: {
  displayName: string;
  phoneE164:   string;
}): Promise<void> {
  if (!contactsAvailable() || typeof Contacts.presentFormAsync !== 'function') {return;}
  await Contacts.presentFormAsync(
    null,
    {
      // `Contacts.Fields.Name` is literally the string 'name', so spelling it
      // both ways is a duplicate key, not belt-and-braces.
      name:        args.displayName,
      contactType: Contacts.ContactTypes.Person,
      phoneNumbers: [{label: 'mobile', number: args.phoneE164, isPrimary: true}],
    } as unknown as Contacts.Contact,
    {allowsEditing: true, allowsActions: true},
  );
  invalidateSavedContacts();
}

/** Test hook — clears the module-level cache. */
export function _resetSavedContactsForTests(): void {
  index = null;
  loading = null;
}
