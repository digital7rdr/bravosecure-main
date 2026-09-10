/**
 * B-411 — the ONE place a conversation's display label is composed for
 * notifications and last-resort in-app titles. Internal identifiers
 * (`Bravo · <8hex>` placeholders, bare userId prefixes) must never be
 * rendered; a registered-directory name is tagged `· Unsaved` so it is
 * distinguishable from an address-book name (sqa.md "one helper called from
 * all sites" prescription).
 *
 * DELIBERATELY import-free: it is require()d from the killed-app headless
 * lanes (fcmHeadless/mutedLookup) whose import graph must stay clear of the
 * store and `@utils/constants` (B-153/B-327 class).
 */

export const UNSAVED_TAG = ' · Unsaved';

/**
 * B-79 — placeholder detector, moved here from useRegisteredNames so the
 * push lanes can use it without pulling react/store into their graph
 * (useRegisteredNames re-exports it; existing importers are unaffected).
 */
export function isPlaceholderName(name: string | undefined, peerUserId?: string): boolean {
  if (typeof name !== 'string' || name.length === 0) {return false;}
  // messengerStore shadow-create placeholder ("Bravo · abcd1234").
  if (name.startsWith('Bravo · ')) {return true;}
  // Bare id-prefix placeholder — the call/sync path stamps `userId.slice(0,8)`
  // ("c700ccde") "until profile fetch fills it in" (MainNavigator), or the full
  // userId. Match against the peer so we never mistake a real name for one.
  if (peerUserId && (name === peerUserId || name === peerUserId.slice(0, 8))) {return true;}
  return false;
}

export type NameSource = 'custom' | 'contact' | 'profile' | 'placeholder';

export type NotifTitleInput = {
  name?: string;
  name_source?: NameSource;
  is_custom_name?: boolean;
  phoneE164?: string;
  peerUserId?: string;
  /** Live session directory name, when the caller has one (warm lanes only). */
  directoryName?: string;
};

export type ResolvedTitle = {
  /** Notification title — carries UNSAVED_TAG when the name is directory-sourced. */
  title?: string;
  /** The same resolution WITHOUT the tag, for in-app surfaces / person names. */
  displayName?: string;
  isUnsaved: boolean;
};

/**
 * Order is load-bearing (doc §1c.3): the placeholder PATTERN is checked before
 * the flag because pre-flag vault rows have no `name_source` — flag-first
 * would re-render the hex for every row written before the migration.
 * Missing-flag rows render plain (fail-safe: never mislabel a saved contact
 * as Unsaved; the sweeps stamp the flag within one Home mount).
 */
export function resolveNotifTitle(input: NotifTitleInput): ResolvedTitle {
  const {name, name_source, is_custom_name, phoneE164, peerUserId, directoryName} = input;
  if (!name || isPlaceholderName(name, peerUserId)) {
    if (directoryName && !isPlaceholderName(directoryName, peerUserId)) {
      return {title: directoryName + UNSAVED_TAG, displayName: directoryName, isUnsaved: true};
    }
    if (phoneE164) {return {title: phoneE164, displayName: phoneE164, isUnsaved: true};}
    // Nothing usable — undefined lets each lane fall to its own generic
    // ('New secure message' in showMessageNotif); the hex never escapes.
    return {title: undefined, displayName: undefined, isUnsaved: false};
  }
  if (is_custom_name || name_source === 'custom' || name_source === 'contact') {
    return {title: name, displayName: name, isUnsaved: false};
  }
  if (name_source === 'profile') {
    return {title: name + UNSAVED_TAG, displayName: name, isUnsaved: true};
  }
  return {title: name, displayName: name, isUnsaved: false};
}
