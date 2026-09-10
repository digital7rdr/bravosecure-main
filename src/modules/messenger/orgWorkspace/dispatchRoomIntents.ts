/**
 * Auto-dispatch Ops Room — membership-intent drain (agency device).
 *
 * SECURITY (E2EE stop-condition): the server holds NO group key, so it cannot
 * rekey on its own. When an agency assigns/removes a CPO to a booking's Ops Room,
 * the server records a metadata change + a pending intent. THIS function — run on
 * the agency's device (the room creator/admin that holds the group key) — drains
 * those intents and performs the sanctioned, rekeying runtime actions:
 *   - add    → runtime.addGroupMember     (wraps planAddAndRekey)
 *   - remove → runtime.removeGroupMember  (wraps planRemoveAndRekey)
 * then acks the intent so it isn't replayed. Until this runs, a removed CPO still
 * holds the old master key — so drain it promptly (on agency dashboard focus).
 *
 * The runtime methods already enforce admin authorisation, the per-group lock, and
 * the remove-then-rekey ordering; this layer only sequences intents and maps
 * add/remove → the right call. It never touches key material. Mirrors
 * orgWorkspace/membershipIntents.ts (department channels) scoped to booking rooms.
 */
import {dispatchApi} from '@services/api';
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {useAuthStore} from '@store/authStore';

export interface DrainResult {
  processed: number;
  skipped: number;   // intents for not-yet-provisioned rooms
  failed: number;
}

// M1 (B-207) — coalesce concurrent drains. The drain now fires from more than one
// trigger (AgentDashboard mount, MessengerHome focus, AND the M2 key-request bridge),
// and without this two overlapping passes would list the same intents and race their
// acks (the second ack 404s and counts a spurious failure). A second caller awaits the
// in-flight pass instead — same shape as membershipIntents.ts's dept-channel drain.
let inFlight: Promise<DrainResult> | null = null;

/**
 * B-416/B-417 — the ONE identity formula for "may this device hold Ops Room
 * key authority": the agency OWNER OR a delegated MANAGER (managed_org
 * non-null — the clean manager discriminator, structurally null for owners;
 * resolveManagerContext).
 *
 * The owner is TWO arms on purpose:
 *  - `owns_agency` (B-417) — the server-computed direct fact (ACTIVE company
 *    account, mirrors OrgManagerGuard Path 1). The legacy inference below
 *    rotted the moment Phase B let an owner JOIN another org's workspace:
 *    their `org` goes non-null (four-arm fallback) and the owner silently
 *    lost key authority over their own agency.
 *  - `account_kind === 'agency' && !org` — the legacy inference, KEPT for
 *    mixed versions: against an old server owns_agency is undefined and the
 *    un-joined owner must keep working.
 *
 * NOT account_kind for the manager arm — a promoted-CPO manager reads
 * account_kind 'cpo' (cpo precedence in deriveAccountKind). NOT
 * is_org_manager — TRUE for the owner too (the B-210 trap that no-op'd the
 * drain for every real owner). NOT org — a plain managed CPO also carries a
 * non-null org.
 *
 * Authority to ACT on a given room is still arbitrated per-room by the
 * server-side atomic claim (see drainOnce); this predicate only decides who
 * may TRY — widening it is fork-safe by construction post-B-416. Exported so
 * every trigger call site uses the same rule (duplicate-copy class).
 */
export function isOpsRoomKeyAuthority(u: {
  account_kind?: string;
  org?: {id: string; name: string} | null;
  managed_org?: {id: string; name: string} | null;
  owns_agency?: boolean;
} | null | undefined): boolean {
  if (!u) {return false;}
  return (u.account_kind === 'agency' && !u.org) || !!u.owns_agency || !!u.managed_org;
}

export function drainDispatchRoomIntents(): Promise<DrainResult> {
  // SECURITY (B-207 → B-416) — the mission Ops Room drain BOOTSTRAPS + MINTS
  // the group key via runtime.ensureAssignedGroup, which is safe on exactly
  // ONE device per room. That used to be enforced by an owner-only identity
  // gate here; since B-416 (founder-approved) delegated managers are
  // admitted too, and the single-authority invariant moved to the SERVER'S
  // ATOMIC CLAIM: drainOnce claims each room before touching it and stands
  // down wherever another account already won (first admin wins, PK-
  // arbitrated). Two admin devices therefore cannot mint diverging keys for
  // one room (the B-35 fork class) no matter how they race.
  //
  // B-210 history (why the formula in isOpsRoomKeyAuthority is shaped the
  // way it is): `is_org_manager` is TRUE for the owner too, so the original
  // `!is_org_manager` gate silently no-op'd the drain for every real owner
  // — confirmed live on staging via an instrumented build.
  const u = useAuthStore.getState().user;
  if (!isOpsRoomKeyAuthority(u)) {
    return Promise.resolve({processed: 0, skipped: 0, failed: 0});
  }
  if (inFlight) {return inFlight;}
  inFlight = drainOnce().finally(() => { inFlight = null; });
  return inFlight;
}

async function drainOnce(): Promise<DrainResult> {
  const result: DrainResult = {processed: 0, skipped: 0, failed: 0};

  const {data} = await dispatchApi.listRoomIntents();
  if (!data.intents.length) {return result;}

  // B-416 CLAIM PASS — before touching ANY room, atomically claim its single
  // key authority on the server (PK-arbitrated first-writer-wins; legacy
  // rooms are pre-seeded by the migration with the pre-B-416 de-facto
  // authority — the agency org account, via intents/booking linkage).
  // Only rooms THIS account claimed are bootstrapped/drained here; rooms
  // claimed by another admin are that account's job — their intents are
  // skipped WITHOUT ack so the claimant retries them (at-least-once).
  // FAIL CLOSED: any claim error (network, 404) keeps the room out of
  // `mine` — never bootstrap a room whose authority is unproven.
  const myUserId = useAuthStore.getState().user?.id;
  const mine = new Set<string>();
  {
    const roomIds = Array.from(new Set(
      data.intents.map(i => i.conversation_id).filter((id): id is string => !!id)));
    for (const roomId of roomIds) {
      try {
        const {data: claim} = await dispatchApi.claimRoomCrypto(roomId);
        if (myUserId && claim.claimed_by === myUserId) {mine.add(roomId);}
      } catch { /* fail closed — not mine this pass */ }
    }
  }

  const runtime = await getMessengerRuntime('production');

  // BOOTSTRAP PASS (MISSION-GROUP area 5) — the Ops Room conversation id is
  // minted server-side, so the group master key is NEVER created by the normal
  // createGroupChat path. Until the CLAIMANT device holds local GroupState,
  // addGroupMember throws "unknown group" and every CPO add-intent loops
  // `pending` forever. Bootstrap each distinct CLAIMED room ONCE here (with
  // the client as the initial non-agency member) before applying the adds.
  // ensureAssignedGroup is idempotent — a no-op if the group already exists
  // locally, so re-running every drain is safe and never re-keys.
  if (runtime.ensureAssignedGroup) {
    for (const roomId of mine) {
      const intent = data.intents.find(i => i.conversation_id === roomId);
      if (!intent) {continue;}
      try {
        await runtime.ensureAssignedGroup({
          groupId: roomId,
          // Client-facing group NAME — it becomes the title on the chat and
          // on an incoming mission call, so it carries the locked term.
          name:    intent.conversation_title ?? 'Mission · Bravo Control System',
          members: intent.client_id ? [intent.client_id] : [],
        });
      } catch {
        // Transient bootstrap failure — leave the intents pending; the next
        // drain retries. Not counted as a per-intent failure here.
      }
    }
  }

  for (const intent of data.intents) {
    // A room whose Signal group hasn't been bootstrapped on this device yet has no
    // epoch to rekey — leave the intent pending; it'll apply once the group exists.
    if (!intent.conversation_id) {
      result.skipped++;
      continue;
    }
    // B-416 — not this account's room: the claimant drains it. Skip, never
    // ack (the intent must stay pending for the claimant's next pass).
    if (!mine.has(intent.conversation_id)) {
      result.skipped++;
      continue;
    }
    try {
      if (intent.action === 'remove') {
        if (!runtime.removeGroupMember) {result.skipped++; continue;}
        await runtime.removeGroupMember({
          groupId: intent.conversation_id,
          removedUserId: intent.member_user_id,
        });
      } else {
        if (!runtime.addGroupMember) {result.skipped++; continue;}
        // Phase-1 peers live on signal deviceId=1 (multi-device lands later).
        await runtime.addGroupMember({
          groupId: intent.conversation_id,
          newMember: {userId: intent.member_user_id, deviceId: 1},
        });
      }
      /**
       * Only ack AFTER the rekey broadcast succeeded — a failed rekey leaves the
       * intent pending so the next drain retries it (at-least-once).
       *
       * ⚠️ B-640 — "succeeded" here means "did not THROW", which is weaker than
       * it reads. `addGroupMember` resolves even when the new member's inline
       * key delivery reached ZERO recipients (see the
       * `[group-add-rekey:runtime] inline key delivery reached 0 recipients`
       * warn in productionRuntime). So this ack can mark an intent `done` for a
       * member who is seated but holds no key — the state that makes an Ops
       * Room group call fail at the 25 s key gate while every server probe
       * looks clean.
       *
       * This warn is OBSERVABILITY ONLY and deliberately changes nothing: the
       * ack still fires, semantics are untouched. Not-acking here was proposed
       * and REJECTED — the client's own add-intent throws ALREADY_MEMBER by
       * construction (it is the bootstrap's initial member), so "never ack"
       * would leave every client intent permanently pending and re-fire a
       * sealed reshare on every drain, which is the churn the benign arm below
       * exists to stop. The real fix needs an architecture pass on key
       * distribution plus a device run.
       *
       * ids ONLY — correlate on memberUserId with the runtime warn above.
       */
      console.warn(
        '[dispatch-intents] ack',
        'intentId=', intent.id,
        'action=', intent.action,
        'memberUserId=', intent.member_user_id,
      );
      await dispatchApi.ackRoomIntent(intent.id);
      result.processed++;
    } catch (e) {
      // NOTE: this only decides whether an intent is acked / skipped / retried — the
      // rekey ops (addGroupMember/removeGroupMember) are untouched. No key material,
      // epoch, or recipient set changes here.
      const msg = (e as Error)?.message ?? '';
      // B-207 / D2-g — idempotent no-op: the member is already in/out of the group.
      // This is the common case for the CLIENT's add-intent (S2) — the client is the
      // bootstrap's initial member, so addGroupMember throws ALREADY_MEMBER. It is
      // also hit by a duplicate/resumed crew intent. The intent is already satisfied,
      // so ACK it instead of leaving it pending to churn on every future drain.
      //
      // B-416 — `cannot add self` joins the benign set: the owner is now
      // seated + intented too (decline reason (a)), so the CLAIMANT always
      // meets its OWN add-intent, and addGroupMember refuses self-adds
      // before the already-member check. The claimant holds the key by
      // construction — the intent is satisfied; without this arm it would
      // churn `failed` on every drain forever (gatekeeper Part-1 item 1).
      if (/already a member of|is not a member of|cannot add self/.test(msg)) {
        await dispatchApi.ackRoomIntent(intent.id).catch(() => {});
        result.processed++;
        continue;
      }
      // D2-e — this device has no local state for the group ("unknown group"): it is
      // not the owner/provisioning device, so it cannot rekey. Defer cleanly (skip, do
      // NOT ack) so the device that holds the group state drains it.
      if (/unknown group/.test(msg)) {
        result.skipped++;
        continue;
      }
      // B-416 defense-in-depth — a non-admin device somehow processing an
      // intent (a race that slipped the claim) must DEFER, not churn: skip
      // without ack so the real claimant retries it. Never acked — acking
      // would drop the member's key delivery on the floor.
      if (/only admins can/.test(msg)) {
        result.skipped++;
        continue;
      }
      // A genuine, retryable failure — leave the intent pending for the next drain.
      result.failed++;
    }
  }
  return result;
}
