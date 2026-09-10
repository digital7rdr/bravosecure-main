/**
 * One-call helper for every call-launch site in the app.
 *
 * Centralises peer-resolution + callId-generation so a screen doesn't
 * need to know about CallController, signalling, or dispatcher
 * internals — it just calls `launchCall(navigation, {conversationId,
 * callType})`.
 *
 * Routing rules:
 *   - 1:1 conversation              → CallScreen (existing WebRTC P2P)
 *   - 3+ member group / ops_channel → GroupCallScreen (mediasoup SFU)
 *
 * For groups we ALSO probe `/sfu/rooms/by-conversation/:cid` first so
 * the 2nd member tapping "call" joins the existing room instead of
 * creating a parallel ghost room. The server's createRoom is idempotent
 * by conversationId — this client probe is just a UX optimisation that
 * lets us pass `direction:'incoming'` (skip the ring) when there's
 * already a live call.
 */
import {useMessengerStore} from '../store/messengerStore';
import {isDirectPrefixed, peerFromDirectSlot} from '../conversationIds';
import {useAuthStore} from '@store/authStore';
// SFU room registry is served by messenger-service (NOT auth-service).
// MSG_BASE_URL points at relay.94-136-184-52.sslip.io in staging.
import {MSG_BASE_URL} from '@utils/constants';
import {getActiveGroupCall, setActiveGroupCall} from '../runtime/groupCallRegistry';
import {logCallSm, shortCallId, logCallLat} from '../runtime/callDiag';
import {getActiveCall, onActiveCallChange} from '../runtime/callRegistry';
import {clearRoomIdentities} from './groupCallIdentityRegistry';
import {computeRingSet} from './ringSet';

interface LaunchOpts {
  conversationId: string;
  callType:       'voice' | 'video';
  remoteDeviceId?: number;
  // LIVE-MONITOR-CHAT (area 8 #4) — explicit group hint + participants for
  // callers that launch BEFORE the conversation is hydrated in messengerStore
  // (e.g. the mission Ops Room from AgentLiveTracker right after assignCrew).
  // Without these, shouldRouteCallViaSfu() returns false for an unhydrated room
  // → the call wrongly routes to the 1:1 path with remoteUserId undefined and
  // "call failed". Prefer these over the store lookup when provided.
  isGroup?:       boolean;
  participants?:  string[];   // member userIds (self is filtered out)
}

interface NavLike {
  navigate: (screen: string, params?: Record<string, unknown>) => void;
}

// Re-export for callers that want to evaluate the gate up front
// (e.g. to hide the dial button instead of just blocking the action).
export {blockReasonForOutgoingCall} from './callRoleGate';
import {blockReasonForOutgoingCall} from './callRoleGate';

function genCallId(): string {
  // Round 2 / Security audit fix: never fall back to Math.random().
  // The original code used Math.random() if crypto.randomUUID was
  // missing — but the RN polyfill chain doesn't always populate that
  // helper, so the weak fallback fired in production. Predictable
  // callIds let an attacker who can guess them issue spurious
  // call.hangup / call.ice frames against an active call.
  // Use crypto.randomUUID when available; otherwise fall back to
  // crypto.getRandomValues — both libsignal and groupClient already
  // depend on getRandomValues, so it's guaranteed to exist on every
  // boot path that reaches this function.
  const c = (globalThis as {crypto?: {randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array}}).crypto;
  if (c?.randomUUID) {return c.randomUUID();}
  if (!c?.getRandomValues) {
    // Should be unreachable — polyfills.ts boots before any caller —
    // but throwing is safer than silently emitting a guessable id.
    throw new Error('genCallId: no CSPRNG available (crypto.getRandomValues missing)');
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Resolve the peer userId for a 1:1 or first-other-member for a group. */
export function resolvePeerForCall(conversationId: string): string | null {
  const s = useMessengerStore.getState();
  const ownId = useAuthStore.getState().user?.id;
  const convo = s.conversations[conversationId];
  if (!convo) {
    if (isDirectPrefixed(conversationId)) {return peerFromDirectSlot(conversationId);}
    return null;
  }
  if (convo.peer?.userId) {return convo.peer.userId;}
  const others = (convo.participants ?? []).filter(p => p && p !== 'self' && p !== ownId);
  return others[0] ?? null;
}

/** Other (non-self) members of the conversation, per LOCAL state. */
function otherMembers(conversationId: string): string[] {
  const s = useMessengerStore.getState();
  const ownId = useAuthStore.getState().user?.id;
  const convo = s.conversations[conversationId];
  return (convo?.participants ?? []).filter(p => p && p !== 'self' && p !== ownId);
}

/**
 * Everyone who should be RUNG for a group call.
 *
 * Why this is not just `otherMembers`: local `participants` resolves to the
 * device's CRYPTO membership — resolveRosterOverwrite prefers
 * `groups[id].members` whenever it holds any — i.e. "peers I already hold a
 * group key for". Ringing is plain SFU signalling and needs no key, so keying
 * the ring off crypto state silently skipped anyone whose key had not reached
 * this device yet.
 *
 * That produced the reported asymmetry in a mission Ops Room: the agency rang
 * the client (early re-share) but not the CPOs, and a CPO rang the client but
 * not the agency/managers — each device rang only its own key-holders.
 *
 * So: UNION the local set with the server's authoritative roster. Falls back to
 * local-only if the roster fetch fails, because a degraded ring beats no call.
 */
async function ringRecipients(
  conversationId: string,
  localMembers: string[],
  hint: string[] | undefined,
): Promise<string[]> {
  const ownId = useAuthStore.getState().user?.id;
  /**
   * B-433 — repair a roster that went stale before the removal fix shipped.
   *
   * `rosterUserIds` is persisted and never self-repairs, so an install that
   * removed someone last week would keep ringing them even with the fix in.
   * Replays this group's own `member_removed` / `member_added` history (last
   * event per user wins) and narrows the row. Idempotent and one pass over one
   * conversation, run here because this is the exact moment it matters.
   */
  try {
    const {repairRosterFromRemovalHistory} =
      require('../runtime/applyMemberRemoval') as typeof import('../runtime/applyMemberRemoval');
    repairRosterFromRemovalHistory(conversationId);
  } catch { /* repair is best-effort; a stale roster over-rings, never under-rings */ }
  const store = useMessengerStore.getState();
  // B-247 — the preserved, never-narrowed roster (the create/receive snapshot)
  // and the group's OWN member map.
  //
  // ⚠️ B-640 CORRECTION. This comment used to claim a mission Ops Room "is not a
  // server conversation row at all (missions has no conversation_id, only
  // comms_room_failed_at)". That is FALSE and was worth correcting because it
  // would mislead the next person reasoning about an empty ring set: the Ops
  // Room IS a real `public.conversations` row, and
  // `system-messenger.service.ts:270` (`ensureRoomMembers`) inserts real
  // `public.conversation_members` rows for it — which is exactly why
  // `listMine` can see it. So the server arm below IS populated for a mission
  // room, even for a member who holds no key. The snapshot still earns its
  // place as a belt-and-braces source; it is not the only one.
  //
  // The member map is the only LIVE source —
  // applyAdminAction maintains it through every add and remove — and is what
  // fixes the CPO-initiated direction, since a CPO never runs
  // ensureAssignedGroup and therefore has no snapshot at all.
  const roster = store.conversations[conversationId]?.rosterUserIds;
  const groupMembers = Object.keys(store.groups[conversationId]?.members ?? {});
  let server: string[] = [];
  try {
    const {conversationApi} = require('@services/api') as typeof import('@services/api');
    const {data} = await conversationApi.listMine();
    server = (data.conversations.find(c => c.id === conversationId)?.members ?? [])
      .map(m => m.userId)
      .filter(Boolean);
  } catch (e) {
    console.warn('[bravo.launchcall] roster fetch failed, ringing local set only:', (e as Error).message);
  }
  // The union rule itself lives in ringSet.ts so it can be unit-tested per
  // device shape — this module can't be imported by the node Jest project.
  return computeRingSet({localMembers, hint, roster, groupMembers, server, ownId});
}

/**
 * True when the conversation has 2+ other members (3+ total) — mesh
 * WebRTC degrades fast and we route through the SFU instead.
 *
 * NOT a message-topology test, and deliberately NOT the same rule as
 * `messagingLogic.isGroupConversation`: a 2-person group routes as a 1:1 CALL
 * (mesh is cheaper than the SFU) while still being a GROUP for message fan-out.
 * This was named `isGroupConversation` too, so the two rules read as
 * interchangeable at an import site and were one careless consolidation away
 * from silently rerouting every call. Renamed for that reason — see
 * docs/runbooks/MESSAGE_LOOP.md M2 / W4. Do not merge the two.
 */
export function shouldRouteCallViaSfu(conversationId: string): boolean {
  const s = useMessengerStore.getState();
  const convo = s.conversations[conversationId];
  if (!convo) {return false;}
  if (convo.type === 'group' || convo.type === 'ops_channel') {return true;}
  return otherMembers(conversationId).length >= 2;
}

/**
 * Best-effort probe for an in-progress room for this conversation.
 * Returns null on any error — the caller will create a fresh room
 * (the server's createRoom is itself idempotent by conversationId,
 * so worst case is a tiny extra round-trip).
 *
 * Audit P0-C2 / row #5 (C1) — also reads `roomToken` (server mints a
 * per-caller HMAC alongside the discovered roomId). Without this the
 * 2nd-member-joins-existing-call path would have a roomId but no
 * token, and `sfu.join` would reject with `room_token_required` the
 * moment ops sets `SFU_ROOM_TOKEN_SECRET`.
 */
async function findLiveRoom(
  conversationId: string,
): Promise<{roomId: string; roomToken?: string; live: boolean} | null> {
  try {
    // fetchWithRefresh handles auth attach + 401 auto-refresh. Without
    // it, a stale token here would silently return null (probe error
    // swallowed below), which then sends launchCall down the "create
    // new room" path — which 401s for the same reason. Observed as
    // "call failed" on every re-entry until the next /auth/refresh on
    // an unrelated screen.
    const {fetchWithRefresh} = require('@/services/api') as typeof import('@/services/api');
    const res = await fetchWithRefresh(
      `${MSG_BASE_URL}/sfu/rooms/by-conversation/${encodeURIComponent(conversationId)}`,
      {headers: {'X-Signal-Device-Id': '1'}},
    );
    if (!res.ok) {return null;}
    const body = await res.json() as {roomId: string | null; roomToken?: string; live?: boolean};
    if (!body.roomId) {return null;}
    /**
     * `live === false` means the room RECORD exists but nobody is in it —
     * the server hands a freshly-created room out for a 30s grace, and a
     * boot that dies before `sfu.join` (media failure) leaves exactly that
     * corpse behind. Default to FALSE on an older relay that omits the
     * field: "ring anyway" is the safe direction to be wrong in (a
     * redundant ring is stripped of self+duplicates server-side), whereas
     * defaulting true reinstates the silent-join bug.
     */
    return {roomId: body.roomId, roomToken: body.roomToken, live: body.live === true};
  } catch {
    return null;
  }
}

// ── CALL-17 — 1:1 double-tap / concurrent-dial guard ─────────────────
// launchCall mints a fresh callId per invocation, so a fast double-tap
// on the dial button rang the peer TWICE (two CallScreens, two offers).
// The callRegistry is the source of truth for a live call, but it only
// populates once useCall's boot registers the controller — this latch
// covers the tap→registration window. Released when the registry takes
// over (active call appears), and by a watchdog for aborted boots
// (permission denied / instant back) so a failed launch can't wedge
// future calls.
let oneToOneLaunchInFlight = false;
let oneToOneLaunchWatchdog: ReturnType<typeof setTimeout> | null = null;
import {ONE_TO_ONE_LAUNCH_WATCHDOG_MS} from './callDeadlines';
import {displayRoomName} from '@utils/missionRoomName';

export function isOneToOneLaunchBlocked(): boolean {
  return oneToOneLaunchInFlight || getActiveCall() !== null;
}

export function releaseOneToOneLaunchLatch(): void {
  oneToOneLaunchInFlight = false;
  if (oneToOneLaunchWatchdog) {
    clearTimeout(oneToOneLaunchWatchdog);
    oneToOneLaunchWatchdog = null;
  }
}

function latchOneToOneLaunch(): void {
  oneToOneLaunchInFlight = true;
  const unsub = onActiveCallChange(s => {
    // Fires synchronously with the CURRENT (null — we just checked)
    // state on register; release only once the call actually lands.
    if (s) { unsub(); releaseOneToOneLaunchLatch(); }
  });
  if (oneToOneLaunchWatchdog) {clearTimeout(oneToOneLaunchWatchdog);}
  oneToOneLaunchWatchdog = setTimeout(() => {
    unsub();
    releaseOneToOneLaunchLatch();
  }, ONE_TO_ONE_LAUNCH_WATCHDOG_MS);
}

export function launchCall(nav: NavLike, opts: LaunchOpts): void {
  // Role gate — CP Agents must not start outgoing 1:1 calls to
  // individual users. Evaluated before any nav so the agent gets a
  // visible reason rather than an apparent silent failure.
  const role = useAuthStore.getState().user?.role;
  const convo = useMessengerStore.getState().conversations[opts.conversationId];
  // Area 8 #4 — prefer the explicit hint (set by callers that launch before the
  // room is hydrated) over the store-derived classification.
  const groupCall = opts.isGroup ?? shouldRouteCallViaSfu(opts.conversationId);
  const reason = blockReasonForOutgoingCall(role, convo?.type ?? (opts.isGroup ? 'group' : undefined), groupCall);
  if (reason) {
    try {
      const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
      Alert.alert('Call not allowed', reason);
    } catch {
      console.warn('[bravo.launchcall] blocked:', reason);
    }
    return;
  }

  // Why: B-320 — the group branch used to return ABOVE the 1:1 busy guard,
  // and neither guard consulted the OTHER registry: launching a group call
  // over a live 1:1 (or any call over a live group call) ran two calls at
  // once — double audio sessions, and the floating overlay's group-first
  // precedence hid the 1:1's End control. One combined check, both branches.
  // Re-launching into the SAME conversation's live group call stays allowed:
  // that is the legitimate "return to call" adopt path.
  {
    const busyOneToOne = getActiveCall();
    const busyGroup = getActiveGroupCall();
    // WI-1.6 — a group entry marked `ending` is still BUSY (that is the whole
    // point: the transports are still closing), but it is NOT a call you can
    // return to. Excluding it from the rejoin escape hatch is what stops a
    // "return to call" tap racing `sfu.join` against the leave in flight.
    const rejoiningOwnGroup =
      groupCall && busyGroup !== null && !busyGroup.ending &&
      busyGroup.conversationId === opts.conversationId;
    if ((busyOneToOne !== null || busyGroup !== null) && !rejoiningOwnGroup) {
      // WI-1.6 — being busy behind a call the user JUST ENDED is real, but it
      // lasts at most the 3 s leave bound, and "Finish the current call before
      // starting a new one" is a lie about a call they already finished. Say
      // what is actually happening and let them tap again.
      //
      // Deliberately NOT an auto-retry: deferring the launch means navigating
      // seconds later with no way to cancel (the user may well have walked away
      // from the screen), and neither the CALL-17 latch nor the group branch
      // guards a queue of deferred launches — N taps inside the window would
      // each fire `ringRecipients` + a navigate. A 3 s "try again" beats being
      // yanked into a call you abandoned.
      const endingGroupIsTheOnlyBlocker =
        busyOneToOne === null && busyGroup !== null && busyGroup.ending === true;
      if (endingGroupIsTheOnlyBlocker) {
        logCallSm('launch.blocked-behind-leave', {
          room: shortCallId(busyGroup!.roomId), gen: busyGroup!.gen,
        });
      }
      try {
        const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
        if (endingGroupIsTheOnlyBlocker) {
          Alert.alert('Ending the previous call', 'That call is still hanging up. Try again in a moment.');
        } else {
          Alert.alert('Call in progress', 'Finish the current call before starting a new one.');
        }
      } catch {
        console.warn('[bravo.launchcall] blocked — another call is live (B-320)');
      }
      return;
    }
  }

  // Group calls (3+) bypass the 1:1 path entirely — mesh WebRTC dies
  // around 5 participants, so we route everything that isn't a 1:1
  // through mediasoup.
  if (groupCall) {
    // B-111-A — this build cannot run E2EE group calls (no FrameCryptor —
    // iOS until B-111-B lands). Say so honestly BEFORE any room/ring work
    // instead of the old join→S6-refuse ghost that peers read as a
    // network glitch. 1:1 calls are unaffected.
    const {frameCryptorOrchestratorAvailable} = require('./frameCryptorOrchestrator') as typeof import('./frameCryptorOrchestrator');
    if (!frameCryptorOrchestratorAvailable()) {
      const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
      Alert.alert(
        'Group calls not available yet',
        'Group calls are not supported on this device yet — one-to-one calls work normally.',
      );
      return;
    }
    // Area 8 #4 — recipients from the store if hydrated, else from the explicit
    // participants hint (mission Ops Room launched before materialization).
    const fromStore = otherMembers(opts.conversationId);
    const groupConvo = useMessengerStore.getState().conversations[opts.conversationId];
    // Deck page 19 - the local store caches whatever name it first synced, so
    // this display transform is what reaches missions already running.
    const callerName = displayRoomName(groupConvo?.name) || 'Group';

    // Fire the room probe in the background. If it returns a live room
    // before the screen mounts, we navigate as `incoming` to skip the
    // ring; otherwise navigate fresh as `outgoing` to ring everyone.
    void Promise.all([
      findLiveRoom(opts.conversationId),
      ringRecipients(opts.conversationId, fromStore, opts.participants),
    ]).then(([live, recipientUserIds]) => {
      // Defensive cleanup of stale registry state from a PREVIOUS
      // call. After a 6-person call fully ends, leaveInternal in the
      // last hook instance might race the navigation pop and leave
      // the registry holding the old room's refs. The next call's
      // useGroupCall boot would then see `existing` and try to adopt
      // refs that point at closed mediasoup transports — symptom is
      // a black tile grid that never shows anyone. Clear here so the
      // boot path falls through to a fresh build cleanly.
      const liveRoomId = live?.roomId ?? null;
      const stale = getActiveGroupCall();
      if (stale && (!liveRoomId || stale.roomId !== liveRoomId)) {
        // Why: B-320 — nulling the slot alone orphaned a still-live call:
        // no sfu.leave, mediasoup transports left open, peers kept a frozen
        // tile. Capture leave() BEFORE nulling (same pattern as the
        // useGroupCall boot's stale-adopt path) and fire it best-effort.
        const staleLeave = stale.leave;
        console.log(`[bravo.launchcall] clearing stale registry roomId=${stale.roomId}`);
        clearRoomIdentities(stale.roomId);
        setActiveGroupCall(null);
        if (staleLeave) {
          try { void staleLeave().catch(() => { /* already-dead room */ }); } catch { /* best-effort */ }
        }
      }
      nav.navigate('GroupCallScreen', {
        conversationId:   opts.conversationId,
        callType:         opts.callType,
        /**
         * Ring-vs-join keys on whether anyone is ACTUALLY in the room, not
         * on whether a room record exists.
         *
         * This used to be `liveRoomId ? 'incoming' : 'outgoing'`, and that
         * is the whole of "only the admin's calls ring". `direction` gates
         * the boot ring in useGroupCall, so anyone handed an existing room
         * id entered SILENTLY and rang nobody — including when the room was
         * a corpse left by a first tapper whose boot died before joining
         * (the server advertises such a room for a 30s grace). The user
         * tapped Call, saw a call screen, and no one was ever summoned.
         *
         * Tapping Call is an intent to SUMMON. We still join the discovered
         * room when one exists (so a second caller lands in the same room
         * rather than forking the call) — we just also ring when nobody is
         * in it yet. Ringing as a non-host is allowed: the server's gate is
         * host-OR-participant (B-334), and it strips self + duplicates.
         */
        direction:        live?.live ? 'incoming' : 'outgoing',
        roomId:           liveRoomId ?? undefined,
        recipientUserIds,
        callerName,
        // Audit row #5 (C1) — token from GET /sfu/rooms/by-conversation.
        // Without it the joiner would hit room_token_required at
        // sfu.join once SFU_ROOM_TOKEN_SECRET is set.
        roomToken:        live?.roomToken,
      });
    });
    return;
  }

  // 1:1 path.
  // CALL-17 — reject when a 1:1 call is already live/pending (registry)
  // or another launch is mid-boot (latch). Without this, a double-tap
  // minted two callIds and rang the peer twice.
  if (isOneToOneLaunchBlocked()) {
    try {
      const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
      Alert.alert('Call in progress', 'Finish the current call before starting a new one.');
    } catch {
      console.warn('[bravo.launchcall] blocked — a call is already in progress or launching');
    }
    return;
  }
  const peer = resolvePeerForCall(opts.conversationId);
  // Only latch when we actually dial — an unresolvable peer never boots
  // a controller, so a latch would just block the retry for nothing.
  if (peer) {
    latchOneToOneLaunch();
    // WI-4.9 — calling the peer back retires their "Missed call" banner; the
    // reminder's job is done the moment the user dials. The conversationId
    // rides along so a group banner merely NAMING this peer is not retired
    // by a 1:1 dial (conversation identity wins when both sides carry one).
    try {
      const {dismissMissedCallNotifs} = require('../push/callNotification') as typeof import('../push/callNotification');
      void dismissMissedCallNotifs({fromUserId: peer, conversationId: opts.conversationId});
    } catch { /* notifee unavailable — the banner just stays */ }
  }
  const oneToOneCallId = peer ? genCallId() : undefined;
  // [CALLLAT] (audit Step 0) — the caller lane's clock starts at the tap.
  if (oneToOneCallId) {logCallLat('1to1-out', oneToOneCallId, 'launch', {kind: opts.callType}, {reset: true});}
  nav.navigate('CallScreen', {
    conversationId: opts.conversationId,
    callType:       opts.callType,
    isIncoming:     false,
    remoteUserId:   peer ?? undefined,
    remoteDeviceId: opts.remoteDeviceId ?? 1,
    callId:         oneToOneCallId,
  });
}
