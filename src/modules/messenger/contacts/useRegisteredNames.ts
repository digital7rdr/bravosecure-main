import {useCallback, useEffect, useRef} from 'react';
import type {UsersHttpClient} from '@bravo/messenger-core';
import {useMessengerStore} from '../store';

/**
 * B-79 — resolve the peer's REGISTERED Bravo name for direct conversations that
 * are still sitting on the auto-generated `Bravo · <8hex>` placeholder (created
 * by the store's shadow-create when a stranger messages you before contact
 * sync). The address-book sweep (`useDiscoveredContacts`) only renames peers
 * whose phone is in your address book — everyone else stayed a cryptic hex label
 * forever. This sweep fills that gap using the public `/users/profiles` lookup.
 *
 * Name precedence (highest wins): user-set custom name (`is_custom_name`) >
 * saved address-book name (`localName`, from useDiscoveredContacts) > registered
 * Bravo display name (this hook) > `Bravo · <hex>` placeholder. This hook only
 * ever replaces a still-placeholder name, so it never clobbers a saved/custom
 * one — and the address-book sweep, which runs the same way, overwrites this
 * hook's registered name with the user's own label when the peer is a contact.
 */
// B-411 — moved to notifTitle.ts (import-free, so the killed-app push lanes
// can share it); re-exported here so existing importers keep working.
export {isPlaceholderName} from './notifTitle';
import {isPlaceholderName} from './notifTitle';

export function useRegisteredNames(opts: {users: UsersHttpClient | null; enabled?: boolean}): void {
  const {users, enabled = true} = opts;
  /**
   * PERF (2026-08-22) — subscribe to the ANSWER, not to the whole map.
   *
   * This hook is mounted in `MainNavigator`, i.e. always, in every shell. It
   * used to select `s.conversations`, and `appendMessage` / `syncLastMessageStatus`
   * mint a NEW conversations map on every message and every tick transition — so
   * the selector returned a fresh identity each time and re-rendered the ROOT
   * NAVIGATOR several times per received message, app-wide.
   *
   * ⚠️ THE BROAD SUBSCRIPTION IS KEPT WHILE ANYTHING IS PENDING, and that is
   * not an oversight. A failed fetch marks nothing attempted and is documented
   * to retry "on the next conversations change" — narrowing to the pending ids
   * alone killed that retry, because muting a chat (the test's trigger, and any
   * ordinary edit) does not change WHICH peers are unresolved.
   *
   * So the two states are separated. With nothing pending — the steady state,
   * and overwhelmingly the common one — the selector returns a constant and the
   * root navigator stops re-rendering on every message. With something pending
   * it subscribes exactly as before, so every change is still a retry chance.
   */
  const pendingKey = useMessengerStore(s => {
    let key = '';
    for (const c of Object.values(s.conversations)) {
      if (c.type === 'direct' && !c.is_custom_name && c.peer?.userId
          && isPlaceholderName(c.name, c.peer.userId)) {
        key += `${c.peer.userId},`;
      }
    }
    return key;
  });
  const retryTick = useMessengerStore(s => (pendingKey ? s.conversations : null));
  // userIds already queried this session (resolved OR unknown) so a stranger who
  // isn't on the directory doesn't get re-fetched on every conversations change.
  const attemptedRef = useRef<Set<string>>(new Set());

  const run = useCallback(async () => {
    if (!enabled || !users) {return;}
    const store = useMessengerStore.getState();
    const pending = Object.values(store.conversations).filter(
      c => c.type === 'direct' &&
        !c.is_custom_name &&
        !!c.peer?.userId &&
        isPlaceholderName(c.name, c.peer.userId) &&
        !attemptedRef.current.has(c.peer.userId),
    );
    if (pending.length === 0) {return;}
    const ids = pending.map(c => c.peer.userId);
    let profiles;
    try {
      profiles = await users.getProfilesByIds(ids);
    } catch {
      return; // best-effort — retried on the next conversations change
    }
    // Mark every queried id attempted (success): ids the server omitted (unknown/
    // blocked) simply keep the placeholder without re-hammering the endpoint.
    for (const id of ids) {attemptedRef.current.add(id);}
    const nameById = new Map(profiles.map(p => [p.userId, p.displayName]));
    for (const c of pending) {
      const reg = nameById.get(c.peer.userId);
      if (!reg) {continue;}
      // Re-read: the address-book sweep may have set a saved name (which wins)
      // between our fetch and now — only replace a STILL-placeholder name.
      const fresh = store.conversations[c.id];
      if (fresh && !fresh.is_custom_name && isPlaceholderName(fresh.name, fresh.peer?.userId)) {
        // B-411 — 'profile': this name came from the registered directory,
        // not the address book, so notification titles tag it "· Unsaved".
        store.upsertConversation({...fresh, name: reg, name_source: 'profile'});
      }
    }
  }, [enabled, users]);

  useEffect(() => { void run(); }, [run, pendingKey, retryTick]);
}
