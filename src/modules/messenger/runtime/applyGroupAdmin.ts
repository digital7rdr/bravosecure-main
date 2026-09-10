import {
  applyAdminAction,
  disposeGroupKey,
  isGroupMember,
  verifyGroupCreateSignature,
} from '@bravo/messenger-core';
import type {CryptoStore, GroupAdminAction, GroupState, SessionAddress} from '@bravo/messenger-core';
import {decideGroupCreate} from './inboundGroupCreateGate';
import {isCallGroupState} from './messagingLogic';
import {upsertGroupConversationFromState} from './groupConversationUpsert';
import {noteDestroyedEnvelope} from './decryptFailureSignal';
import {LeaveOnRelayError} from './firstMessageRetryBudget';
import {
  appendGroupPhotoChangedEvent,
  appendMemberAddedEvent,
  appendMemberRemovedEvent,
} from './groupEventMessage';
import {applyGroupRenameToUi} from './applyGroupRename';
import {applyMemberRemovalToUi} from './applyMemberRemoval';
import {resolveCallKeyGroupId} from './callKeyRegistry';
import {resolveExpectedSenderIdentity} from '../crypto/expectedSenderIdentity';

/**
 * Seam S5 — the group ADMIN lane of `doHandleIncoming`.
 *
 * The largest single lane (350 lines) and the one that stayed inline longest,
 * because it is the security core of group messaging: create-signature
 * verification (G-05 relayed creates included), epoch monotonicity (G1), the
 * B-127 wire-id/signed-id split, master-key install and supersession (MEDIUM-2),
 * and `applyAdminAction` for roster + rekey. Three CLAUDE.md stop-conditions
 * meet in here, so it was extracted only with owner sign-off.
 *
 * MOVED VERBATIM. The body was lifted by a script rather than retyped —
 * transcription risk in this particular code is not worth taking — and only free
 * variables were rewritten into explicit `args`/`deps`. Behaviour is unchanged;
 * the diff is a relocation, not a rewrite. Verify that claim the same way I did:
 * `git show <prev>:productionRuntime.ts`, slice the lane, and compare.
 *
 * The superseded-key registry moved WITH it (below). It is used only by the
 * create path, and leaving it behind would have split one security control
 * across two files.
 *
 * NOT changed while moving, deliberately: the wire-id vs signed-id double lookup
 * (`args.existing` is bound from the WIRE id; `createExisting` from the SIGNED
 * id). That asymmetry looks like a redundancy and is the B-127 P0 fix — an
 * attacker set the wire id to an unused value so `existing` came back undefined
 * and every guard was skipped. Do not "simplify" them into one lookup.
 *
 * See docs/runbooks/MESSAGE_LOOP.md W24/S5 and sqa.md B-127.
 */

/**
 * Audit MEDIUM-2 (2026-07-02): per-group set of master keys that a same-epoch
 * owner-signed HEAL (G-04) has already SUPERSEDED. Enables a rollback guard:
 * because the G-04 heal accepts any owner-signed same-epoch create with a
 * different key, a malicious member could relay (via G-05) an OLDER captured
 * owner-create to roll a peer back to a key that was already replaced — there
 * is no ordering tiebreaker in the signed create bytes. A key here has been
 * provably retired at its epoch; re-installing it is always a downgrade, so we
 * refuse. Memory-only (per session): the precondition is a same-identity
 * same-epoch fork, and after a restart the group re-converges via self-heal,
 * so a persistent store is not warranted. Bounded per group.
 */
const supersededGroupKeys = new Map<string, Set<string>>();
const SUPERSEDED_KEYS_CAP = 32;

export function markGroupKeySuperseded(groupId: string, keyB64: string): void {
  let s = supersededGroupKeys.get(groupId);
  if (!s) { s = new Set(); supersededGroupKeys.set(groupId, s); }
  s.add(keyB64);
  // Bound: drop the oldest insertion if we exceed the cap.
  if (s.size > SUPERSEDED_KEYS_CAP) {
    const first = s.values().next().value;
    if (first !== undefined) { s.delete(first); }
  }
}

export function isGroupKeySuperseded(groupId: string, keyB64: string): boolean {
  return supersededGroupKeys.get(groupId)?.has(keyB64) === true;
}

/** Test-only: the registry is module state, so a suite must be able to clear it. */
export function __resetSupersededKeys(): void {
  supersededGroupKeys.clear();
}

/** Post-transaction work the admin lane can ask its caller to run after COMMIT. */
export type GroupAdminOutcome =
  | {kind: 'reshare-group-key'; groupId: string; toUserId: string}
  | {kind: 'drain-group'; groupId: string}
  // B-365 — a roster-gated decline now also asks the owner for the CURRENT
  // signed state (cooldown-guarded downstream), so a device holding a stale
  // roster copy stops declining the same member forever. Same shape the
  // post-txn handler already consumes for decrypt-failure resyncs.
  | {kind: 'request-group-key'; groupId: string; fromPeer?: SessionAddress; divergence?: boolean}
  | void;

export interface GroupAdminArgs {
  /** The decrypted admin action. */
  action:      GroupAdminAction;
  peer:        SessionAddress;
  /** Local group state resolved by the WIRE id — NOT the signed id. See B-127. */
  existing:    GroupState | undefined;
  envelopeId:  string | undefined;
  /** Sender-stamped routing id, used only for the wire/payload mismatch check. */
  wireGroupId: string | undefined;
  /** Authenticated sender identity key from the verified cert claims. */
  senderIdentityKey: string;
}

export interface GroupAdminDeps {
  store:      {groups: Record<string, GroupState>; setGroupState: (s: GroupState) => void};
  getState:   () => {
    groups: Record<string, GroupState>;
    conversations: Record<string, {type?: string} | undefined>;
    setGroupState: (s: GroupState) => void;
    setError: (m: string) => void;
  };
  ownStore:           CryptoStore;
  keys:               Parameters<typeof resolveExpectedSenderIdentity>[2] | null;
  peerIdentityCache:  Parameters<typeof resolveExpectedSenderIdentity>[3];
  ownUserId:          string;
  pendingAdminActions: {stash: (row: {
    groupId: string; actionEpoch: number; senderUserId: string;
    action: unknown; receivedAtMs: number;
  }) => Promise<void>} | null;
  /**
   * Narrowed to the ONE signal this lane emits (a voluntary `leave` bumps the
   * epoch without rotating the key, so a remaining admin must rekey — G-03).
   * Typing it `unknown` would not accept the runtime's real
   * `(s: GroupKeySignal) => void` under parameter contravariance, and widening
   * it would let this lane emit signals it has no business emitting.
   */
  emitGroupKeySignal: (s:
    | {kind: 'leave-rekey'; groupId: string; leaverId: string}
    /** B-337 — WE were removed: the factory purges this group's row, transcript,
     *  outbox and crypto state (stores only it holds). See the remove branch. */
    | {kind: 'purge-self-removed'; groupId: string}
  ) => void;
  crashLog:           (m: string) => void;
}

export async function applyGroupAdmin(
  args: GroupAdminArgs,
  deps: GroupAdminDeps,
): Promise<GroupAdminOutcome> {
  const action = args.action;
  console.log('[group-create:recv] admin action type=', action.type, 'from peer=', args.peer.userId);
  // Self-heal — a member that lost the group key asks us to re-share it.
  // We can only help if we hold this group's state; the factory handler
  // then enforces owner-gating (only the owner can mint a verifying
  // create signature), roster-gating (never re-share to a non-member),
  // and per-(group,requester) rate-limiting. Never mutates state.
  if (action.type === 'key-request') {
    // Fail-closed: only react if WE hold this group's state AND the
    // requester is a CURRENT member. The roster-gate in
    // reshareGroupKeyState is the authoritative anti-leak control, but
    // gating here too means a non-member's (or removed member's)
    // request does NOT make us fetch a cert, sign a create, or spin up
    // a session — shrinking the amplification surface to real members.
    // [KEYDIAG] — both declines below were SILENT (warn survives release
    // stripping; ids sliced, no key material). A keyless caller whose
    // request every member declines here dies 25 s later with "no group
    // master key — refusing to start" and zero serve-side evidence.
    //
    // B-358 — the B-124 root fix moved 'Call' states under their MINTED ids
    // with resolveCallKeyGroupId as the handle translation, and this serve
    // path kept the raw wire-id lookup: an escalated-call joiner's request
    // (named by a `direct:` handle) was declined "no state" by the very host
    // that minted the key, so the added third member always died at step 3b.
    // Translate exactly like requestGroupKeyResyncImpl's epoch lookup does.
    // No gate is weakened: the roster check below and the owner/sig/roster
    // gates inside reshareGroupKeyState all run against the RESOLVED state —
    // the one that actually holds the key.
    let serveState = args.existing;
    const requestedId = (action as {groupId?: string}).groupId;
    if (!serveState) {
      const mappedId = requestedId ? resolveCallKeyGroupId(requestedId) : undefined;
      if (mappedId) {serveState = deps.getState().groups[mappedId];}
    }
    // B-362r2 — last-resort HOST resolution. A request naming
    // `direct:<MY OWN uid>` means "you, as the call host": every recipient
    // of an ad-hoc 'Call' create files/addresses the key by the HOST's
    // handle, but the host's own registry mapping proved fragile (the
    // mint-time write sat on the fresh-mint path only, and the reuse lane
    // returned early — 2026-08-01 13:59 repro declined AGAIN). Resolve it
    // structurally instead: the ad-hoc state this device OWNS whose roster
    // contains the requester (newest first — a host runs one live escalated
    // call at a time). Locally-held state only; the roster gate below and
    // every owner/sig gate inside reshareGroupKeyState still run unchanged.
    if (!serveState && requestedId === `direct:${deps.ownUserId}`) {
      const groups = deps.getState().groups;
      let best: GroupState | undefined;
      for (const g of Object.values(groups)) {
        if (!isCallGroupState(g)) {continue;}
        if (g.owner !== deps.ownUserId) {continue;}
        if (!g.masterKeyB64) {continue;}
        if (!isGroupMember(g, args.peer.userId)) {continue;}
        if (!best || (g.updatedAt ?? 0) > (best.updatedAt ?? 0)) {best = g;}
      }
      if (best) {
        console.warn('[group-key-request:recv] host-handle resolved structurally to', best.groupId.slice(0, 12));
        serveState = best;
      }
    }
    if (serveState && isGroupMember(serveState, args.peer.userId)) {
      console.warn('[group-key-request:recv] serving reshare for', serveState.groupId.slice(0, 12), 'to', args.peer.userId.slice(0, 8));
      return {kind: 'reshare-group-key', groupId: serveState.groupId, toUserId: args.peer.userId};
    }
    console.warn('[group-key-request:recv] decline from', args.peer.userId.slice(0, 8), serveState ? '— requester not on our roster copy' : '— we hold no state for this group');
    // B-365 — a roster-gated decline is the drift signature (Ariful↔Ae2,
    // 2026-08-01 14:15): OUR copy may simply be missing a member the owner
    // has since added. Ask the owner for the current signed state; the
    // superset roster heal in the create gate adopts it. Cooldown-guarded
    // downstream; never fires for "no state at all" (nothing to reconcile).
    if (serveState) {
      return {kind: 'request-group-key', groupId: serveState.groupId, divergence: false};
    }
    return;
  }
  if (action.type === 'create') {
    // First time seeing this group; the sender shipped the full
    // initial state including the master key. The cert chain is
    // already verified above (verifySenderCert). Round 5 / Security
    // S4 — additionally verify the creatorSignature so a stolen
    // cert can't be paired with a substituted member list / master
    // key. We require the sender to be the owner of the group
    // they're creating (anyone can encrypt and ship a "create" via
    // someone else's session, but only the owner's identity priv
    // key produces a verifying signature).
    let sigCheck: {ok: true} | {ok: false; reason: string};
    if (action.state.owner === args.peer.userId) {
      // Owner is the sender — verify the create signature against the
      // sender's (= owner's) authenticated cert identity.
      sigCheck = await verifyGroupCreateSignature({
        state:                action.state,
        senderIdentityKeyB64: args.senderIdentityKey,
        creatorSignature:     action.creatorSignature,
      });
      if (!sigCheck.ok) {
        if (sigCheck.reason === 'missing') {
          // Legacy v1 sender — accept under the rollout-window policy.
          console.warn(`[group-create:recv] WARNING legacy unsigned create from peer=${args.peer.userId}`);
        } else {
          console.warn(`[group-create:recv] DROP create — sig-check ${sigCheck.reason} from peer=${args.peer.userId}`);
          deps.getState().setError('Group create sig invalid — dropped');
          return;
        }
      }
    } else {
      // Audit G-05 (2026-07-02): a MEMBER relayed the OWNER's signed create
      // (owner offline → they can't self-heal a keyless member). This is
      // NOT a forgery vector: verify the creatorSignature against the
      // OWNER's identity key — only a genuine owner signature verifies, and
      // it covers (groupId, members, masterKeyB64, epoch), so a stale sig
      // from before a rekey fails to verify and the relay harmlessly drops.
      // A missing signature is NOT accepted for a relay (unlike the legacy
      // owner path) — a relayed create MUST carry a real owner signature.
      let ownerIdKeyB64: string | undefined;
      // M10 — distinguish PERMANENT from TRANSIENT. This catch used to
      // swallow a keys-service/offline failure and fall into the bare
      // `return` below, which COMMITS and acks the envelope off the relay —
      // permanently destroying an OWNER-SIGNED group-key create, i.e. the
      // exact envelope a keyless member is waiting for. The WS path already
      // treats the same condition as recoverable (`outcome.result ===
      // 'unavailable'` → leaveOnRelay). Track why the resolve failed.
      let ownerIdentityLookupFailed = false;
      try {
        // Resolve the OWNER's identity key (local trust row first, then the
        // authority-signed bundle on cold contact) — the same resolver the
        // rest of doHandleIncoming uses for cert continuity.
        ownerIdKeyB64 = deps.keys
          ? await resolveExpectedSenderIdentity({userId: action.state.owner, deviceId: 1}, deps.ownStore, deps.keys, deps.peerIdentityCache)
          : undefined;
      } catch {
        // A THROW here is a keys-service blip, not a verdict about the create.
        ownerIdentityLookupFailed = true;
      }
      if (!ownerIdKeyB64) {
        // Transient (we have a keys client and it failed) ⇒ leave on relay
        // for a later drain. Permanent (no keys client at all — loopback /
        // fully offline build) ⇒ drop as before, since no retry can help.
        if (deps.keys && ownerIdentityLookupFailed && args.envelopeId) {
          console.warn(`[group-create:recv] LEAVE-ON-RELAY relayed create — owner identity lookup failed groupId=${action.state.groupId.slice(0, 8)}`);
          throw new LeaveOnRelayError(args.envelopeId);
        }
        console.warn(`[group-create:recv] DROP relayed create — owner identity unavailable groupId=${action.state.groupId.slice(0, 8)}`);
        return;
      }
      sigCheck = await verifyGroupCreateSignature({
        state:                action.state,
        senderIdentityKeyB64: ownerIdKeyB64,
        creatorSignature:     action.creatorSignature,
      });
      if (!sigCheck.ok) {
        console.warn(`[group-create:recv] DROP relayed create — owner-sig ${sigCheck.reason} groupId=${action.state.groupId.slice(0, 8)} relayer=${args.peer.userId.slice(0, 8)}`);
        return;
      }
      console.log(`[group-create:recv] G-05 accepted relayed owner-signed create for ${action.state.groupId.slice(0, 8)} via member ${args.peer.userId.slice(0, 8)}`);
    }
    // MISSION-GROUP G1 (epoch-monotonicity) — `create` bootstraps a group,
    // but for an externally-assigned id (the mission Ops Room) the id is
    // fixed and well-known, so a stale/duplicate signed `create` could be
    // replayed to OVERWRITE an advanced group: rolling the epoch back,
    // re-admitting removed members, and resetting the master key. Never
    // install a create that isn't strictly newer than what we already hold —
    // accept only when we have no local state for this group, or the incoming
    // epoch is higher. Also converges duplicate same-epoch creates on the
    // first writer (not the last), closing the B-35-class divergence window.
    // B-41 — keyless-placeholder bootstrap exception. The epoch guard must
    // NOT reject a create when we hold NO master key for this group yet.
    // A member can end up with a keyless state at an equal/higher epoch:
    // e.g. it received an `add` admin action that advanced its epoch, or a
    // synthetic key-request stub, but never the key itself. The owner then
    // re-broadcasts the keyed state as a `create` at its CURRENT epoch
    // (ensureCallGroupKey resync — no epoch bump), which `epoch <= existing`
    // would drop as "stale" — leaving the member permanently keyless: group
    // messages never decrypt and group calls die at the key-wait ("Call
    // failed", joiner joins the room but never produces). Accepting it is
    // NOT a downgrade: the create is owner-signature-verified above, and
    // there is no established keyed state to roll back. Only enforce
    // epoch-monotonicity (the replay / re-admit-removed-member / key-reset
    // defence) once we actually hold a key worth protecting.
    //
    // B-127 — the decision now lives in runtime/inboundGroupCreateGate.ts so
    // it is unit-testable (this file cannot be imported in jest, and B-129
    // showed what hand-mirrored copies of these rules cost).
    //
    // CRITICAL: resolve local state by the SIGNED id. `existing` above is
    // bound from `store.groups[unwrapped.group.groupId]` — the WIRE id —
    // while the install below writes `groups[action.state.groupId]`. An
    // attacker set the wire id to an unused value, so `existing` came back
    // undefined and EVERY guard was skipped: a self-signed create then
    // overwrote a victim group's owner, roster and master key at epoch 0.
    // Do not "simplify" these back into one lookup.
    const createExisting = deps.store.groups[action.state.groupId];
    const createDecision = decideGroupCreate({
      wireGroupId:           args.wireGroupId ?? action.state.groupId,
      state:                 action.state,
      existing:              createExisting,
      signatureOk:           sigCheck.ok,
      signatureMissing:      !sigCheck.ok && sigCheck.reason === 'missing',
      keySuperseded:         isGroupKeySuperseded(action.state.groupId, action.state.masterKeyB64),
      localConversationType: deps.getState().conversations[action.state.groupId]?.type,
      // B-365 — member lists for the same-epoch owner-signed roster heal.
      stateMembers:          Object.keys(action.state.members ?? {}),
      existingMembers:       createExisting ? Object.keys(createExisting.members ?? {}) : undefined,
    });
    if (createDecision.rosterHeal) {
      console.warn('[group-create:recv] B-365 roster heal — adopting owner-signed superset for', action.state.groupId.slice(0, 12), 'members', Object.keys(action.state.members ?? {}).length);
    }
    if (createDecision.warn === 'wire-id-mismatch') {
      // Telemetry only, never a drop — a planned change to the call-key
      // resync deliberately splits these two fields, and a hard drop there
      // would kill every re-escalated call at the joiner's key gate.
      console.warn(`[group-create:recv] wire/payload group id mismatch — routing ${String(args.wireGroupId).slice(0, 12)} vs signed ${action.state.groupId.slice(0, 12)}`);
    }
    if (createDecision.action === 'drop') {
      // Every drop here MUST be traceable. A dropped create is
      // unrecoverable — creates are never stashed, and the owner's reshare
      // self-heal re-sends the identical state, so a false positive is
      // permanent silent key loss. A bare `return` would also ack
      // 'delivered' and show the owner a false double-tick.
      const why = createDecision.reason ?? 'unknown';
      console.warn(`[group-create:recv] DROP create for ${action.state.groupId.slice(0, 12)} — ${why}`);
      noteDestroyedEnvelope({
        envelopeId: args.envelopeId ?? '',
        conversationId: action.state.groupId,
        peer: args.peer,
        reason: `group-create-${why}`,
      });
      return;
    }
    if (createDecision.action === 'repair-row') {
      // Idempotent duplicate. Repair a lost inbox row from LOCALLY-trusted
      // state, never the wire copy, then stop.
      if (createExisting && !isCallGroupState(createExisting) &&
          !deps.getState().conversations[action.state.groupId]) {
        upsertGroupConversationFromState(createExisting, args.peer.userId);
      }
      // B-362r2 — repair the CALL alias too. The escalated-call joiner keys
      // its FrameCryptor off `direct:<owner>`; the alias write below the
      // accept path is what creates that slot, and a duplicate create
      // (host reuse-lane re-broadcast of a state we already hold) landed
      // HERE and silently skipped it — the joiner then held the key under
      // the minted id but waited 25 s probing an empty handle (13:59 repro).
      // LOCALLY-trusted state only, same rule as the row repair above.
      if (isCallGroupState(createExisting) && createExisting.masterKeyB64) {
        try {
          deps.getState().setGroupState({
            ...createExisting,
            groupId: `direct:${createExisting.owner}`,
          });
          console.warn('[group-create:recv] repaired call alias for', `direct:${createExisting.owner.slice(0, 8)}`);
        } catch { /* alias best-effort — the key-request heal still covers it */ }
      }
      return;
    }
    // Audit G-04 — SAME-epoch owner-signed fork heal. The gate decides;
    // this performs the one side effect it cannot: record the key we are
    // leaving as superseded so a later replay can never roll us back onto
    // it. Losing this write silently disarms the MEDIUM-2 rollback defence.
    // The condition is NOT re-derived here on purpose — re-deriving is how
    // the epoch rule drifted out of sync before (B-129).
    if (createDecision.supersedeKeyB64) {
      markGroupKeySuperseded(action.state.groupId, createDecision.supersedeKeyB64);
      console.log(`[group-create:recv] G-04 same-epoch owner-signed HEAL — converging forked key for ${action.state.groupId}`);
    }
    if (createDecision.bootstrap) {
      console.log(`[group-create:recv] keyless-placeholder bootstrap — accepting older create for ${action.state.groupId} (no local key to protect)`);
    }
    console.log('[group-create:recv] CREATE for groupId=', action.state.groupId, 'name=', JSON.stringify(action.state.name), 'members=', Object.keys(action.state.members));
    // Audit G-05 — persist the owner's create signature so THIS member can
    // later relay it to a keyless peer if the owner is offline.
    deps.store.setGroupState(action.creatorSignature
      ? {...action.state, creatorSigB64: action.creatorSignature}
      : action.state);
    // BS-CALL-ADHOC — an ad-hoc call key arrives as a `'Call'`-named
    // group create. The recipient's useGroupCall for an escalated 1:1
    // keys the FrameCryptor off `direct:<host>`, so alias the master
    // key under that id too. Harmless for real groups (different name).
    if (isCallGroupState(action.state)) {
      try {
        deps.getState().setGroupState({
          ...action.state,
          groupId: `direct:${action.state.owner}`,
        });
      } catch { /* alias best-effort — host path still works */ }
    }
    // ALSO upsert the conversation row so the chat appears in
    // this user's inbox. Without this the receiver's groupState
    // is populated but no `conversations[groupId]` entry exists,
    // so MessengerHomeScreen renders nothing — exactly the bug
    // where "Sirajul created a group but I don't see it on my
    // side". Mirrors the sender's createGroupChat upsert shape.
    //
    // BS-CALL-GHOST — but NOT for an ad-hoc `'Call'` group. Those are
    // transient call-key carriers (ensureCallGroupKey mints a fresh
    // 'Call' group per escalated 1:1 call); the key + its direct:<owner>
    // alias are already filed above. Upserting them too dropped a
    // permanent "Call" entry into the recipient's chat list — and since
    // every call/retry mints a NEW groupId, they ACCUMULATED (2 retries
    // = 2 ghost "Call" chats). The host never upserts these (setGroupState
    // only), so it was recipient-only. Skip the inbox row; the call still
    // works (it reads the key, not the conversation).
    if (!isCallGroupState(action.state)) {
      // Handoff §2.7-3/-5 — shared single writer; preserves local-only
      // fields (unread/mute/pin/custom name/last_message) when the row
      // already exists, so a re-shared create doesn't reset them.
      upsertGroupConversationFromState(action.state, args.peer.userId);
    }
    // Bug-hunt #3.B — `create` is the first time we hold the master
    // key for this group. Any text envelope that arrived before this
    // moment was stashed via the no_key branch above; signal the
    // outer wrapper to drain it AFTER the txn commits. Per-row
    // replay runs in its own fresh txn (no SQLite write lock held
    // when this returns).
    return {kind: 'drain-group', groupId: action.state.groupId};
  } else if (args.existing) {
    // Audit fix #26 — pass the verified sender userId so admin
    // gating works. Non-admin actions are silently no-op'd by
    // applyAdminAction.
    const next = applyAdminAction(args.existing, action, args.peer.userId);
    // Bug-hunt #5 — telemetry on stale-epoch admin no-ops. The
    // reducer drops actions where `atEpoch !== state.epoch` (out-
    // of-order delivery, or non-admin sender) by returning the
    // SAME state reference. Without this breadcrumb, a recipient
    // who processed step 2 (rekey @ E+1) before step 1 (add @ E)
    // would silently desync — `next === existing` here means the
    // local state stayed at E while the rest of the group moved
    // to E+2. Surface so operators can correlate "group X stopped
    // decrypting" reports with the underlying ordering bug.
    if (next === args.existing) {
      // Audit P1-G6 — disambiguate the no-op reason so operators
      // don't have to guess between "stale epoch" and "non-admin
      // sender." `leave` is the only action that doesn't need admin
      // rights; for everything else, compute the gate decision here
      // so the breadcrumb names the actual cause.
      const stateEpoch = args.existing.epoch;
      const actionWithEpoch = action as {type: string; atEpoch?: number};
      const senderIsAdmin = args.existing.members[args.peer.userId]?.admin === true;
      const senderIsMember = args.existing.members[args.peer.userId] !== undefined;
      let reason: string;
      if (action.type === 'leave' && !senderIsMember) {
        reason = 'leaver-not-member';
      } else if (action.type !== 'leave' && !senderIsAdmin) {
        reason = 'non-admin-sender';
      } else if (typeof actionWithEpoch.atEpoch === 'number' && actionWithEpoch.atEpoch !== stateEpoch) {
        reason = `stale-epoch action=${actionWithEpoch.atEpoch} state=${stateEpoch}`;
      } else {
        reason = 'unknown';
      }
      deps.crashLog(
        `[group-admin] dropped ${actionWithEpoch.type} action: ` +
        `sender=${args.peer.userId.slice(0, 8)} ` +
        `reason=${reason}`,
      );
      // Bug-hunt #3.D — stash stale-epoch actions so the NEXT admin
      // commit that advances local state can replay them. Only stash
      // the stale-epoch family (the others are genuine policy drops
      // — non-admin sender or non-member leaver — replay won't help
      // and the receiver would just keep dropping the same row).
      if (
        deps.pendingAdminActions &&
        reason.startsWith('stale-epoch') &&
        typeof actionWithEpoch.atEpoch === 'number'
      ) {
        await deps.pendingAdminActions.stash({
          groupId:      args.existing.groupId,
          actionEpoch:  actionWithEpoch.atEpoch,
          senderUserId: args.peer.userId,
          action,
          receivedAtMs: Date.now(),
        });
      }
    }
    deps.store.setGroupState(next);
    // SN-11 — receive-side membership history. The adding device appends
    // the same row locally; the id is derived from (group, member, epoch)
    // so both sides converge on ONE entry and a re-delivered or drained
    // admin envelope can't stack duplicates. Gated on `next !== existing`
    // so a stale-epoch or non-admin no-op writes nothing.
    if (action.type === 'add' && next !== args.existing) {
      appendMemberAddedEvent({
        groupId:     next.groupId,
        actorUserId: args.peer.userId,
        addedUserId: action.member.userId,
        epoch:       next.epoch,
        selfUserId:  deps.ownUserId,
      });
    }
    // B-255 — the mirror of the add row above. Removals used to apply in
    // silence: the roster shrank with no trace, so a member could not tell
    // whether someone left, was removed, or the group had broken. Same
    // `next !== existing` gate, so a stale-epoch or non-admin no-op writes
    // nothing. This also fires on the REMOVED member's own device, which is
    // the only notice they get that they are out.
    if (action.type === 'remove' && next !== args.existing) {
      appendMemberRemovedEvent({
        groupId:       next.groupId,
        actorUserId:   args.peer.userId,
        removedUserId: action.userId,
        epoch:         next.epoch,
        selfUserId:    deps.ownUserId,
      });
      /**
       * B-433 — narrow the CONVERSATION row too, not just crypto state.
       *
       * `computeRingSet` unions the row's `participants` and `rosterUserIds`
       * with live group membership, and `rosterUserIds` is deliberately sticky
       * across upserts — so without this the removed user stays in the row and
       * gets RUNG on the next group call. Same helper the remover's own device
       * calls, so the two sides cannot drift.
       */
      applyMemberRemovalToUi({groupId: next.groupId, removedUserId: action.userId});
      // B-337 — WE are the one removed. Two founder-reported symptoms are the
      // same defect: the group lingered in our chat list, and a later re-add
      // replayed the ENTIRE pre-removal transcript (the relay never backfills
      // — that history was purely our surviving local copy, which is exactly
      // what remove+rekey is supposed to put out of reach).
      //
      // Routed through the EXISTING group-key signal seam (same one leave-rekey
      // uses) rather than a new post-txn outcome: the purge spans the message
      // + outbox SQLCipher stores, which only the factory closure holds. That
      // also avoids widening handleIncoming's parameter list, i.e. avoids the
      // MESSAGE_LOOP §5 caller-completeness trap.
      if (action.userId === deps.ownUserId) {
        deps.crashLog(`[group-admin] self removed from groupId=${next.groupId.slice(0, 8)} — purging locally (B-337)`);
        deps.emitGroupKeySignal({kind: 'purge-self-removed', groupId: next.groupId});
      }
    }
    // B-290 — the branch that did not exist. `add` and `remove` above both
    // reconcile what the user SEES; `rename` applied only to crypto state, and
    // nothing reads `groups[id].name` for display — the list, the header and
    // the info sheet all read `conversations[id].name`. So an admin's rename
    // was invisible on every member's device, permanently. Same
    // `next !== args.existing` gate as its siblings, so a stale-epoch or
    // non-admin no-op writes nothing, and the same helper the sender runs.
    if (action.type === 'rename' && next !== args.existing) {
      applyGroupRenameToUi({
        groupId:      next.groupId,
        newName:      next.name,
        actorUserId:  args.peer.userId,
        selfUserId:   deps.ownUserId,
        changedAtIso: new Date(next.updatedAt).toISOString(),
      });
    }
    // B-291 — the group picture changed. `setGroupState(next)` above already
    // carried it (it lives on the group state), so unlike `rename` there is no
    // separate row to patch: `GroupAvatar` reads `groups[id].photo` directly and
    // re-resolves when the objectKey changes. The system line is the whole
    // remaining job — without it a picture silently changing under a member is
    // indistinguishable from a glitch.
    if (action.type === 'photo' && next !== args.existing) {
      appendGroupPhotoChangedEvent({
        groupId:      next.groupId,
        actorUserId:  args.peer.userId,
        cleared:      action.photo === null,
        changedAtIso: new Date(next.updatedAt).toISOString(),
        selfUserId:   deps.ownUserId,
      });
    }
    // Audit G-03 (2026-07-02): a voluntary `leave` bumps the epoch but does
    // NOT rotate the master key (the leaver can't authorize the rekey), so
    // the departed member keeps a valid key and could read post-leave
    // messages. Have a DESIGNATED remaining admin rekey the group so the
    // key rotates. Designation is deterministic: owner-if-still-a-member,
    // else the lowest-userId remaining admin. AUDIT #1 — the KEY is now
    // fresh-random (the deterministic derivation was computable by the
    // leaver, who holds the previous key), so designation is the anti-fork
    // belt: exactly one admin fires this branch; a residual designation
    // race self-heals via the key-request/reshare + no_key-stash lanes.
    // Fires only when the leave actually changed state.
    if (action.type === 'leave' && next !== args.existing) {
      const leaverId = (action as {type: 'leave'; userId?: string}).userId ?? args.peer.userId;
      /**
       * B-433 — a LEAVER must stop being rung too.
       *
       * Identical hole to `remove`, found in review: `setGroupState` narrows
       * `participants` from crypto state, but `rosterUserIds` is sticky across
       * upserts and nothing else narrows it — so `computeRingSet` kept ringing
       * someone who had walked out. Hoisted above the rekey-designation branch
       * on purpose: EVERY remaining member must narrow their own row, whereas
       * only the designated admin rekeys.
       */
      applyMemberRemovalToUi({groupId: next.groupId, removedUserId: leaverId});
      const admins = Object.entries(next.members)
        .filter(([, m]) => (m as {admin?: boolean}).admin)
        .map(([uid]) => uid)
        .sort();
      const designated = (next.members[next.owner] && (next.members[next.owner] as {admin?: boolean}).admin)
        ? next.owner
        : admins[0];
      if (designated && designated === deps.ownUserId && next.masterKeyB64) {
        deps.emitGroupKeySignal({kind: 'leave-rekey', groupId: next.groupId, leaverId});
      }
    }
    // Audit P0-G2 — when an admin action rotates the master key
    // (rekey, or a future addAndRekey planner), evict the old
    // CryptoKey from the in-process cache. Reasoning identical to
    // the send-side dispose above — we MUST NOT let the previous
    // key linger in cache, because a replay of pre-rekey ciphertext
    // would otherwise decrypt cleanly. Compare masterKeyB64 so we
    // only dispose when it actually changed (non-rekey actions —
    // add/remove/rename — leave the key intact).
    if (args.existing.masterKeyB64 !== next.masterKeyB64) {
      disposeGroupKey(args.existing.masterKeyB64);
      // Bug-hunt #3.B — master key rotated; drain any pending
      // group envelopes that were waiting for this rekey to land.
      // Signal the outer wrapper to run the drain after the txn
      // commits.
      return {kind: 'drain-group', groupId: args.existing.groupId};
    }
  }
  // Admin messages don't render in the chat list.
  return;
}
