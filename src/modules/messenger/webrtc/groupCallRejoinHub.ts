/**
 * B-101 LC-4 — group-call rejoin ownership that survives MINIMIZE.
 *
 * The SFU rejoin-on-WS-reopen listener used to be owned by the
 * `useGroupCall` boot effect, so minimizing the call (which unmounts the
 * screen but deliberately keeps the call running behind the floating
 * bubble) dropped it: `FloatingCallOverlay` is a pure registry consumer
 * and mounts no hook. A socket bounce during that window — a network
 * blip, a messenger-service redeploy, or the P0-6 revoked-token sweep —
 * therefore reopened the transport but never re-ran `sfu.join`, while
 * the server had already closed the participant's transports after its
 * 10s leave grace. Result: the bubble kept advertising a live call while
 * the user was silent and frozen for every other participant, and
 * restoring the screen adopted transports that were dead server-side.
 *
 * This hub keeps exactly ONE reconnect subscription on the transport for
 * the lifetime of a group call, independent of screen mounts:
 *   • the mounted hook installs its handler here instead of subscribing
 *     directly, and REPLACES (never stacks) any previous handler — so a
 *     restore can't produce two hook instances both issuing `sfu.join`;
 *   • minimize leaves the handler in place, which is the whole point;
 *   • a real teardown clears it.
 *
 * The subscription is bound to the TransportClient instance (whose
 * `onReconnect` listener set outlives individual socket rebuilds), and
 * re-bound only if the runtime hands us a different transport object.
 */

import {GROUP_REJOIN_CEILING_MS} from './callDeadlines';
import {logCallSm, logCallSmQuiet, shortCallId} from '../runtime/callDiag';

/** Minimal transport surface — avoids importing the RN transport graph. */
interface ReconnectSource {
  onReconnect(fn: () => void): () => void;
}

let handler:        (() => void) | null = null;
let unsubscribe:    (() => void) | null = null;
let boundTransport: ReconnectSource | null = null;
/**
 * WI-3.3 — who installed the current handler.
 *
 * The clear used to be unconditional, and the hub deliberately outlives the
 * screen, so an OLD hook instance's teardown could retire the handler a NEW
 * call had just installed. That is a live path, not a theoretical one: a stale
 * `leaveInternal` is fired un-awaited by `launchCall`'s `void staleLeave()`
 * and by `endActiveGroupCall`, both of which run while the next call is
 * already booting. The new call then spends its whole lifetime with no
 * WS-reopen recovery — silently, because nothing about it looks wrong until a
 * socket bounces and the call zombies.
 *
 * `releaseGroupCallRejoinHandler(token)` therefore clears only for the owner.
 * A refused release is safe rather than a leak: the reconnect subscription
 * re-checks `groupCallIsLive()` on every fire, so a handler whose call has
 * ended is inert, and the next `setGroupCallRejoinHandler` replaces it.
 */
let handlerToken:   string | null = null;
let installSeq = 0;
/**
 * Rejoin in-flight guard, owned HERE rather than by a per-hook ref, for
 * two reasons found in review:
 *
 *  • A boolean latch cleared only when the rejoin promise settles is
 *    unsafe: `sfu.join` rides an ack whose reject timer is a setTimeout,
 *    frozen while the screen is locked. If the socket dies between emit
 *    and ack the promise NEVER settles, and a per-instance latch would
 *    silently block every future rejoin for the rest of the call —
 *    defeating exactly the minimize-window recovery this hub exists for.
 *    A wall-clock expiry cannot latch.
 *  • Restoring a minimized call installs a handler from a NEW hook
 *    instance while the previous instance's rejoin may still be in
 *    flight. Per-instance refs cannot see each other, so both could
 *    issue `sfu.join` concurrently; one shared guard makes that
 *    impossible.
 */
let rejoinInFlight   = false;
let rejoinStartedAt  = 0;
/** Identifies ONE claim of the slot, so a loser's finally cannot free it. */
let rejoinClaim      = 0;
/** Round 2 R-1 — an up-edge fire refused by a held claim retries on release. */
let retryOnClaimRelease = false;
/**
 * True when a group call is still non-terminal. Lazy-required so this
 * module stays importable from the node-only Jest projects (the registry
 * pulls in the RN graph transitively).
 */
function groupCallIsLive(): boolean {
  try {
    const {getActiveGroupCall} = require('../runtime/groupCallRegistry') as
      typeof import('../runtime/groupCallRegistry');
    const g = getActiveGroupCall();
    // WI-1.6 — never rejoin a call we are in the middle of LEAVING. The slot
    // used to be nulled before the await, so this returned false for free.
    return !!g && !g.ending && (
      g.state === 'creating' || g.state === 'joining' ||
      g.state === 'joined'   || g.state === 'reconnecting'
    );
  } catch {
    // Registry unavailable (tests / early boot) — don't block the rejoin;
    // the handler itself re-checks roomId / isLeaving before joining.
    return true;
  }
}

/**
 * Install (or replace) the rejoin handler and ensure exactly one
 * reconnect subscription exists on `ws`.
 */
/**
 * WI-5.3 (transport G5) — the reconnect subscription must FOLLOW the live
 * transport. After `disposeLiveRuntime()` → rebuild, the hub used to stay
 * bound to the DEAD client until the next `setGroupCallRejoinHandler` (a
 * fresh mount) — so the new transport's reconnects never fired the rejoin
 * and a minimized group call silently died across a runtime rebuild. The
 * hub now watches the registry and re-binds itself; ownership (the token)
 * is untouched by a re-bind — the same handler simply follows the socket.
 */
let registryWatchInstalled = false;
function ensureRegistryWatch(): void {
  if (registryWatchInstalled) {return;}
  registryWatchInstalled = true;
  try {
    const {onTransport} = require('../runtime/transportRegistry') as
      typeof import('../runtime/transportRegistry');
    onTransport(t => {
      // Only re-bind when a handler exists and the transport genuinely
      // changed. A null broadcast (dispose) leaves the old subscription in
      // place — it is inert on a closed client, and the next non-null
      // transport replaces it.
      if (!t || !handler || boundTransport === (t as unknown as ReconnectSource)) {return;}
      bindTo(t as unknown as ReconnectSource);
      logCallSmQuiet('groupcall.rejoin.rebind', {owner: handlerToken ?? '-'});
      // Round 1 P1 — a rebuild constructs a NEW client, and onReconnect
      // deliberately skips a client's FIRST connect (B-05) — so the rebind
      // alone never fired the rejoin at the exact moment the swap happened,
      // which is when the SFU has already torn this participant down. Arm a
      // one-shot on the new client's first up-edge (fires immediately when
      // it is already up). Structurally guarded: test fakes without
      // onceConnected simply skip, and the reconnect path still covers them.
      const once = (t as unknown as {onceConnected?: (fn: () => void) => () => void}).onceConnected;
      if (typeof once === 'function') {
        try {
          once.call(t, () => {
            if (!handler || !groupCallIsLive()) {return;}
            // Round 2 R-1 — the handler's own beginGroupCallRejoin may
            // REFUSE (a pre-dispose rejoin's claim survives ≤15 s on the
            // dead socket's ack). The one-shot is spent either way, so
            // detect the refusal by the claim not moving and flag a retry
            // for the moment the stale claim releases.
            const claimBefore = currentGroupCallRejoinClaim();
            try { handler(); } catch { /* handler fault must not break dispatch */ }
            if (currentGroupCallRejoinClaim() === claimBefore && rejoinInFlight) {
              retryOnClaimRelease = true;
            }
          });
        } catch { /* transport shape without the hook — reconnects still cover */ }
      }
    });
  } catch { /* registry unavailable (tests) — explicit set calls still bind */ }
}

function bindTo(ws: ReconnectSource): void {
  try { unsubscribe?.(); } catch { /* already gone */ }
  boundTransport = ws;
  unsubscribe = ws.onReconnect(() => {
    // The call may have ended while minimized (peer hung up, host ended
    // the room). Never issue a rejoin for a call that is over.
    if (!handler || !groupCallIsLive()) {return;}
    try { handler(); } catch { /* handler fault must not break the transport dispatch */ }
  });
}

export function setGroupCallRejoinHandler(token: string, ws: ReconnectSource, fn: () => void): void {
  handler = fn;
  handlerToken = token;
  ensureRegistryWatch();
  if (boundTransport === ws && unsubscribe) {return;}
  bindTo(ws);
}

/**
 * UNCONDITIONAL reset — logout, hard teardown, test isolation.
 *
 * Prefer `releaseGroupCallRejoinHandler` from anything owned by a hook
 * instance; this one cannot tell whose handler it is dropping.
 */
export function clearGroupCallRejoinHandler(): void {
  handler = null;
  handlerToken = null;
  try { unsubscribe?.(); } catch { /* already gone */ }
  unsubscribe = null;
  boundTransport = null;
  rejoinInFlight = false;
  rejoinStartedAt = 0;
  retryOnClaimRelease = false;
  // No claim bump here: `beginGroupCallRejoin` already mints a fresh one, so a
  // claim taken before this clear can never match the next holder. Mutation
  // testing showed an extra bump here changes nothing observable.
}

/**
 * WI-3.3 — ownership-checked teardown. Clears ONLY when `token` still owns the
 * installed handler; a stale instance's release is refused and logged.
 *
 * `null` means "this instance never installed anything", which is refused for
 * the same reason a mismatched token is: whatever is installed belongs to
 * someone else.
 */
export function releaseGroupCallRejoinHandler(token: string | null): void {
  if (handlerToken === null && handler === null) {return;}   // nothing to do
  if (token === null || handlerToken !== token) {
    // Release-visible: this is the silent-recovery-loss path, and "an old
    // instance tried to retire the live call's handler" is the line worth
    // finding in a logcat when a call zombies after a socket bounce.
    logCallSm('groupcall.rejoin.release.refused', {
      by: token ?? '-', owner: handlerToken ?? '-',
    });
    return;
  }
  logCallSmQuiet('groupcall.rejoin.release', {owner: handlerToken});
  clearGroupCallRejoinHandler();
}

/** A fresh, unique installation token for one hook instance + room. */
export function nextGroupCallRejoinToken(roomId: string): string {
  installSeq += 1;
  // Truncated: this token is printed by the refused-release warn, which rides
  // console.warn and survives the release console-strip. Every other id in the
  // [CALLSM] lane goes through shortCallId, and `installSeq` alone already
  // guarantees uniqueness within the process.
  return `${shortCallId(roomId)}#${installSeq}`;
}

/**
 * The claim currently holding the rejoin slot, or 0.
 *
 * Review round 2 — the rejoin attempt's GENERATION is minted when its
 * `sfu.join` acks, not when it starts, so that an attempt which never joins
 * cannot supersede anything. That is safe only while attempts are serialised,
 * and the stuck-claim takeover exists precisely to break that: it lets a
 * second attempt start while the first is still outstanding, on the explicit
 * premise that the first one's ack can arrive LATE (its reject timer is a
 * setTimeout, frozen while the screen is locked).
 *
 * Without this, an abandoned attempt whose ack lands after the takeover would
 * mint a HIGHER generation than the fresh attempt that replaced it, and then
 * tear down the transports that attempt had just built — the exact
 * interleaving the generation exists to prevent, on the one path where two
 * attempts are guaranteed to overlap. Callers compare their own claim against
 * this before minting.
 */
export function currentGroupCallRejoinClaim(): number {
  return rejoinClaim;
}

/** Test-only introspection: who owns the installed handler. */
export function currentGroupCallRejoinToken(): string | null {
  return handlerToken;
}

/**
 * Claim the rejoin slot. Returns false when a rejoin is genuinely still
 * running; a claim older than `REJOIN_STUCK_MS` is treated as lost (its
 * ack can never arrive — see the guard's rationale above) and is taken
 * over rather than blocking recovery forever.
 */
export function beginGroupCallRejoin(): number {
  const now = Date.now();
  if (rejoinInFlight && now - rejoinStartedAt < GROUP_REJOIN_CEILING_MS) {return 0;}
  if (rejoinInFlight) {
    // WI-3.3 — we are TAKING OVER a claim whose ack can never arrive. Under
    // the old 30 s ceiling this fired against rejoins that were merely slow,
    // and left no trace at all. Release-visible so a "the call recovered
    // twice" report can be told apart from a genuinely stuck one.
    logCallSm('groupcall.rejoin.takeover', {heldMs: now - rejoinStartedAt});
  }
  rejoinInFlight = true;
  rejoinStartedAt = now;
  rejoinClaim += 1;
  return rejoinClaim;
}

/**
 * Release the rejoin slot — ONLY if this claim still owns it.
 *
 * Review round 1: this was unconditional while its sibling
 * `endAttemptRunning` had been hardened for the identical reason. After a
 * stuck-claim takeover the ABANDONED rejoin still settles and still runs its
 * `.finally`, and an unconditional release handed the slot away while the
 * winner was mid-rebuild — re-opening exactly the concurrency the 90 s ceiling
 * was widened to prevent.
 */
export function endGroupCallRejoin(claim: number): void {
  // 0 is both the "refused" return and the counter's initial value. No
  // separate `claim === 0` clause is needed: once any claim has been minted
  // `rejoinClaim` is positive so 0 can never match, and before the first claim
  // `rejoinInFlight` is already false so releasing is a no-op either way.
  // (Mutation testing showed the extra clause changes nothing observable —
  // same finding as the claim bump deliberately absent from the clear above.)
  if (claim !== rejoinClaim) {return;}
  rejoinInFlight = false;
  rejoinStartedAt = 0;
  // Round 2 R-1 — an up-edge fire that was REFUSED because this claim was
  // still held (the ≤15 s dead-socket ack window) spent its one-shot; retry
  // now that the claim is free. Event-driven on purpose: no timer (banned
  // for backgrounded recovery) and no second up-edge required.
  if (retryOnClaimRelease) {
    retryOnClaimRelease = false;
    if (handler && groupCallIsLive()) {
      try { handler(); } catch { /* handler fault must not break the release */ }
    }
  }
}

/** Test-only introspection. */
export function hasGroupCallRejoinHandler(): boolean {
  return handler !== null;
}
