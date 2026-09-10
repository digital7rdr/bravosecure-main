import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Item H — incident report drafts (M10: "draft saving").
 *
 * WHY THIS IS SAFE, stated up front because this repo bans message drafts:
 * the messenger drafts ban (draftsPersistence.test.ts / the messengerStore
 * partialize whitelist) exists because MESSAGE plaintext must never leave
 * SQLCipher. An incident report is a different confidentiality class — its
 * description is sent to the server AS PLAINTEXT on submit (incidentApi.submit
 * body), so a local draft adds no new exposure. Media is stored as URIs ONLY —
 * never bytes, never base64 (the host-activity-reclaim lesson on the details
 * screen) — pointing at the user's own camera roll / cache files.
 *
 * Keyed per user (the backupFlags pattern): a shared device must not leak one
 * account's half-written report into another's compose screen. Drafts are
 * ALSO swept on logout (authStore) — the text can name people and events, and
 * must not outlive the account.
 *
 * ONE slot per user, last-writer-wins BY DESIGN: starting a fresh report
 * overwrites any older draft on the first edit. Saves are whole-object
 * (category+severity+content together), so a hybrid of two reports can never
 * exist — the trade-off is silent replacement, accepted for v1.
 */

export interface IncidentDraftMedia {
  uri: string;
  mime: string;
  kind: 'image' | 'video';
}

export interface IncidentDraft {
  category: string;
  severity: string;
  description: string;
  media: IncidentDraftMedia[];
  manualLabel?: string;
  savedAt: number;
}

const KEY_PREFIX = 'bravo.incident.draft.v1.';
/**
 * vs2 item 4 — keyed by USER **and ORG**.
 *
 * User alone was right while a person had exactly one organisation. Multi-org
 * broke it: Dana half-writes an Acme incident naming a site and an officer,
 * abandons it, switches to Borealis, opens Incident — and the Resume-draft card
 * offers Acme's narrative and media, with Submit filing it at Borealis. It
 * survives an app restart even though the workspace context deliberately does
 * not, so the leak outlives the session that caused it.
 *
 * Same argument this file already makes one level up for users: a draft must
 * never surface in a context it was not written in.
 */
const keyFor = (userId: string, orgId: string | null | undefined) =>
  `${KEY_PREFIX}${userId}${orgId ? `.${orgId}` : ''}`;

/** Best-effort: a corrupt/missing draft reads as "no draft" (newsPrefs rule). */
export async function loadIncidentDraft(
  userId: string | undefined,
  orgId: string | null | undefined): Promise<IncidentDraft | null> {
  if (!userId) {return null;}
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId, orgId));
    if (!raw) {return null;}
    const d = JSON.parse(raw) as IncidentDraft;
    if (typeof d?.category !== 'string' || typeof d?.severity !== 'string') {return null;}
    return {
      category: d.category,
      severity: d.severity,
      description: typeof d.description === 'string' ? d.description : '',
      media: Array.isArray(d.media)
        ? d.media.filter(m => typeof m?.uri === 'string' && typeof m?.mime === 'string')
          .map(m => ({uri: m.uri, mime: m.mime, kind: m.kind === 'video' ? 'video' as const : 'image' as const}))
        : [],
      manualLabel: typeof d.manualLabel === 'string' ? d.manualLabel : undefined,
      savedAt: typeof d.savedAt === 'number' ? d.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export async function saveIncidentDraft(
  userId: string | undefined,
  orgId: string | null | undefined, draft: Omit<IncidentDraft, 'savedAt'>): Promise<void> {
  if (!userId) {return;}
  try {
    await AsyncStorage.setItem(keyFor(userId, orgId), JSON.stringify({...draft, savedAt: Date.now()}));
  } catch { /* best-effort — a failed save costs a draft, never the report */ }
}

export async function clearIncidentDraft(
  userId: string | undefined,
  orgId: string | null | undefined): Promise<void> {
  if (!userId) {return;}
  try {
    await AsyncStorage.removeItem(keyFor(userId, orgId));
  } catch { /* best-effort */ }
}

/** Logout hygiene (edge review, 2026-08-08): incident text can name people,
 *  places and security events — it must not outlive the account on a shared
 *  device. Sweeps EVERY user's draft key (logout means the device is changing
 *  hands as far as this data is concerned). Best-effort like its siblings. */
export async function clearAllIncidentDrafts(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter(k => k.startsWith(KEY_PREFIX));
    if (mine.length > 0) {await AsyncStorage.multiRemove(mine);}
  } catch { /* best-effort */ }
}

/**
 * Did the user just COMPLETE a report?
 *
 * Client review vs2 item 15 made the category grid the member's Incident root,
 * so it is no longer unmounted between reports and its picked category/severity
 * would carry over — silently pre-categorising the next report. Clearing on
 * every focus would over-correct: backing out of STEP 2 to change the category
 * is a normal move and should not wipe the selection too.
 *
 * One flag, set by the submit path and consumed by the grid's focus effect,
 * distinguishes the two. Module state rather than a route param because
 * `popToTop()` carries none.
 */
let justSubmitted = false;

export function markIncidentSubmitted(): void {
  justSubmitted = true;
}

/** Reads AND clears — a submit resets the grid exactly once. */
export function consumeIncidentSubmitted(): boolean {
  const v = justSubmitted;
  justSubmitted = false;
  return v;
}
