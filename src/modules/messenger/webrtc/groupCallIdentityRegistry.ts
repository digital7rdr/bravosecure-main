/**
 * Per-room map of `participantTag → displayName`.
 *
 * Populated by the runtime when a `groupCallPresence` sealed envelope
 * arrives from a peer (advertised at SFU `sfu.join` time). Consumed by
 * the active `useGroupCall` hook so tile labels show real names instead
 * of opaque tag fragments.
 *
 * The SFU never sees this mapping — it's end-to-end encrypted in transit
 * via the existing pairwise Signal sessions, and lives only in client
 * memory.
 *
 * Subscribers receive the full per-room map snapshot on every update
 * (Map identity changes), so React-side `useEffect` deps stay simple.
 */

type Identity = {displayName: string; userId?: string};

/** roomId → (participantTag → identity). */
const byRoom = new Map<string, Map<string, Identity>>();
/** roomId → listeners. Cleared on `clearRoomIdentities`. */
const listenersByRoom = new Map<string, Array<(map: Record<string, Identity>) => void>>();

/**
 * Audit P0-C3 — per-room set of participantTags the SFU has broadcast
 * via `sfu.participant.joined`. `recordGroupCallIdentity` rejects any
 * presence envelope whose tag isn't in this set (strict mode active
 * when the set is non-empty). Without this, a removed-member or non-
 * member peer who still holds a pairwise Signal session can ship a
 * sealed groupCallPresence envelope claiming any tag they like — and
 * the receiver's tile registry would happily overwrite a legitimate
 * member's name with the attacker's "EVE" label.
 *
 * Race grace: when the set is empty (room just opened, no broadcasts
 * yet), we admit. The first joiner's own presence envelope can land
 * before the SFU's `sfu.participant.joined` broadcast for that same
 * tag arrives — without the grace, the first joiner's tile would
 * never get labeled until someone else joined.
 */
const observedTagsByRoom = new Map<string, Set<string>>();

function snapshot(roomId: string): Record<string, Identity> {
  const m = byRoom.get(roomId);
  if (!m) {return {};}
  const out: Record<string, Identity> = {};
  for (const [tag, ident] of m) {out[tag] = ident;}
  return out;
}

function notify(roomId: string): void {
  const ls = listenersByRoom.get(roomId);
  if (!ls) {return;}
  const snap = snapshot(roomId);
  for (const cb of ls) {
    try { cb(snap); } catch { /* one bad listener mustn't block */ }
  }
}

export function recordGroupCallIdentity(
  roomId: string, participantTag: string, displayName: string, userId?: string,
): void {
  // Audit P0-C3 — strict tag binding. If we've seen ANY SFU broadcast
  // for this room, the tag must be in the observed set. If the set is
  // empty (race grace, room just opened), admit. Once it's non-empty,
  // it's the authority on which tags are legit for THIS room.
  const observed = observedTagsByRoom.get(roomId);
  if (observed && observed.size > 0 && !observed.has(participantTag)) {
    // Drop silently — the attacker learned nothing and the legit
    // identity (if one ever arrives via a real broadcast) lands when
    // its tag does enter the observed set.
    return;
  }
  let m = byRoom.get(roomId);
  if (!m) { m = new Map(); byRoom.set(roomId, m); }
  // Skip silently if nothing changed — avoids storms of identical
  // re-renders if a peer keeps re-sending the same envelope.
  const prev = m.get(participantTag);
  if (prev && prev.displayName === displayName && prev.userId === userId) {return;}
  m.set(participantTag, {displayName, userId});
  notify(roomId);
}

/**
 * Audit P0-C3 — runtime calls this when the gateway emits
 * `sfu.participant.joined` for this room. Adds the tag to the
 * per-room observed set so a subsequent `recordGroupCallIdentity`
 * for the same tag passes the strict check.
 */
export function recordObservedTag(roomId: string, participantTag: string): void {
  let s = observedTagsByRoom.get(roomId);
  if (!s) { s = new Set(); observedTagsByRoom.set(roomId, s); }
  s.add(participantTag);
}

/**
 * Audit P0-C3 — runtime calls this when a participant leaves (via
 * `sfu.participant.left` or kick / room teardown). Drops the tag so
 * any subsequent presence envelope claiming it is rejected. Keeping
 * the set non-empty (other tags still observed) is what KEEPS strict
 * mode active for the kicked tag.
 */
export function forgetObservedTag(roomId: string, participantTag: string): void {
  const s = observedTagsByRoom.get(roomId);
  if (!s) {return;}
  s.delete(participantTag);
  // B-345 — un-learn the leaver from the presence sent-set BEFORE dropping
  // their identity (the tag→userId mapping lives in that entry). Their own
  // device wiped its map on leave; without this, every veteran's "already
  // told them" guard silenced the reply on their REJOIN and the re-added
  // member saw hex tags forever. This runs for both the full and the
  // reduced restore-path frame handlers — sfuDispatcher feeds every
  // participant.left through here.
  const m = byRoom.get(roomId);
  const leftUid = m?.get(participantTag)?.userId;
  if (leftUid) {presenceSentByRoom.get(roomId)?.delete(leftUid);}
  // Also drop any cached identity for this tag — the kicked user's
  // tile should disappear immediately, not on next render.
  if (m?.delete(participantTag)) {
    notify(roomId);
  }
}

/**
 * B-344/B-345 — per-room set of userIds this device has already sent its own
 * identity to. Lives HERE (not in a boot closure) because leaves are
 * processed in this registry (`forgetObservedTag`, fed by sfuDispatcher for
 * BOTH the full and the reduced restore-path frame handlers), and a rejoining
 * participant must be UN-learned so they get a fresh reply — their own map
 * was wiped by `clearRoomIdentities` when they left, while every veteran
 * still remembered "already told them" (the founder's rejoin-sees-hex repro).
 */
const presenceSentByRoom = new Map<string, Set<string>>();

/** B-344 — record that our identity went (or is going) to these userIds. */
export function markPresenceSent(roomId: string, userIds: Iterable<string>): void {
  let s = presenceSentByRoom.get(roomId);
  if (!s) { s = new Set(); presenceSentByRoom.set(roomId, s); }
  for (const uid of userIds) { if (uid) {s.add(uid);} }
}

/**
 * B-344 — which userIds an IN-CALL participant should send its own identity
 * to, given a fresh identity snapshot. Presence used to be one-shot at boot,
 * so a member ADDED mid-call (in nobody's boot-time recipient list) never
 * received anyone's identity and saw hex tags forever. When the newcomer's
 * own announcement lands (their roster-derived list DOES include us), we
 * reply once. Dedupes multiple tags per user, skips self, skips userIds
 * already in the room's sent-set. Callers must `markPresenceSent` the
 * returned ids when they actually send.
 */
export function selectPresenceReplyTargets(
  roomId: string,
  snap: Record<string, Identity>,
  ownUserId: string | undefined,
): string[] {
  const sent = presenceSentByRoom.get(roomId);
  const out: string[] = [];
  for (const ident of Object.values(snap)) {
    const uid = ident.userId;
    if (!uid || uid === ownUserId) {continue;}
    if (sent?.has(uid) || out.includes(uid)) {continue;}
    out.push(uid);
  }
  return out;
}

export function getGroupCallIdentities(roomId: string): Record<string, Identity> {
  return snapshot(roomId);
}

export function onGroupCallIdentities(
  roomId: string,
  cb: (map: Record<string, Identity>) => void,
): () => void {
  let ls = listenersByRoom.get(roomId);
  if (!ls) { ls = []; listenersByRoom.set(roomId, ls); }
  ls.push(cb);
  // Fire once with the current snapshot so the consumer can paint
  // immediately if envelopes arrived before they subscribed. Defer
  // through queueMicrotask so a synchronous setState INSIDE cb (the
  // common case in React hooks) can't fire mid-render of the
  // subscriber's component — that's the "Cannot update during an
  // existing state transition" warning we used to see during fast
  // group-call mount sequences.
  queueMicrotask(() => {
    try { cb(snapshot(roomId)); } catch { /* ignore */ }
  });
  return () => {
    const arr = listenersByRoom.get(roomId);
    if (!arr) {return;}
    const next = arr.filter(x => x !== cb);
    if (next.length === 0) {listenersByRoom.delete(roomId);}
    else {listenersByRoom.set(roomId, next);}
  };
}

/** Drop everything for a room when the call ends. */
export function clearRoomIdentities(roomId: string): void {
  byRoom.delete(roomId);
  listenersByRoom.delete(roomId);
  observedTagsByRoom.delete(roomId);
  presenceSentByRoom.delete(roomId);
}

/**
 * Round 2 fix: drop ALL room state. Wired into authStore.signOut so a
 * logout doesn't leak the prior user's identity envelopes or pin
 * subscriber closures (each entry in listenersByRoom holds a setState
 * pointing at a now-unmounted GroupCallScreen).
 */
export function clearAllRoomIdentities(): void {
  byRoom.clear();
  listenersByRoom.clear();
  observedTagsByRoom.clear();
  presenceSentByRoom.clear();
}

/**
 * B-365b — roster-driven variant of selectPresenceReplyTargets: which of
 * these MEMBER uids still owe our identity (unsent, dedup, not self). The
 * escalated-call joiner's boot one-shot fires BEFORE its healed roster
 * arrives, reaching nobody — and B-344's reciprocal reply only triggers off
 * the joiner's OWN announcement, so both directions stayed hex forever.
 * Callers must `markPresenceSent` the returned ids when they actually send.
 */
export function selectUnsentMembers(
  roomId: string,
  memberUserIds: Iterable<string>,
  ownUserId: string | undefined,
): string[] {
  const sent = presenceSentByRoom.get(roomId);
  const out: string[] = [];
  for (const uid of memberUserIds) {
    if (!uid || uid === ownUserId) {continue;}
    if (sent?.has(uid) || out.includes(uid)) {continue;}
    out.push(uid);
  }
  return out;
}
