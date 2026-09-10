# B-25 — Group-call resume loses roster + resets timer to 0:00 — FIX HANDOFF

> **Purpose of this file.** This is an implementation-ready brief for a _fresh_ Claude
> session. It contains the complete root-cause analysis so the implementing session does
> **not** need to re-investigate. Read this top-to-bottom, then read only the files named in
> §6 before touching code. Follow the scoping rules in §7 so the fix does not regress an
> adjacent call path.
>
> **No code was changed while producing this document.** It is investigation output only.

---

## 0. Numbering warning (read first)

There are **two** different "B-25" in this repo:

- `sqa.md` already has **B-25 = "Keyless group text renders raw inner-envelope JSON"**, status **FIXED** (vc75, 2026-06-11). **Do not edit or overwrite that entry.**
- _This_ B-25 is a **different, newer bug** from the QA call-resume session:
  **"Navigating call → Messenger → back loses the roster and resets the timer to 0:00."**

When you log this in `sqa.md`, give it the **next free number** and cross-reference B-05.
Note **B-30 is already taken** (a "first-msg-drop fix", commit 556768c) — so use **B-31** or
whatever is next-free at the time. Do not reuse the existing B-25 row. (The QA prompt called
it "B-25"; that is a local numbering collision, not the same defect.)

---

## 1. Symptom (as reported by QA)

> Returning to a call after navigating away **remounts the call fresh instead of resuming
> it** — the participant roster is lost and the timer resets to **0:00**. It then tries to
> re-consume and fails (worse when B-05 has already killed the WS).

- **Layer:** Frontend (roster loss compounded by B-05 WS-drop).
- **Severity:** High.
- **Repro:** Be in a live group call (`GroupCallScreen`, `state === 'joined'`) → press
  back / swipe back / tap the minimize chip to go to Messenger → tap the
  `FloatingCallOverlay` (or otherwise re-enter the call) to return.
- **Expected:** the call resumes — same roster, timer keeps counting from the original join.
- **Actual:** timer shows `0:00` and counts up from zero; the roster is empty/rebuilding;
  under a dropped WS the rebuild never completes ("Connecting…" / failed).

---

## 2. The two-source-of-truth design you must respect

A group call deliberately survives `GroupCallScreen` unmount. The lifecycle is split:

- **The hook** `useGroupCall.ts` owns the live mediasoup objects (Device, transports,
  producers, consumers, SFrame detachers) inside `useRef` closures.
- **The registry** `groupCallRegistry.ts` is a module-level singleton that holds the
  _surface_ call state (roster, tiles, tracks, `joinedAtMs`, `keepAlive`, bound
  `leave`/`toggleMute`/`toggleVideo`). It outlives the screen.
- **The overlay** `FloatingCallOverlay.tsx` renders from the registry while the screen is
  unmounted, and on tap navigates back to `GroupCallScreen`.

Minimize → restore is supposed to work like this:

1. **Minimize**: `setGroupCallMinimized(true)` sets `isMinimized:true, keepAlive:true`
   (`groupCallRegistry.ts:132-136`). The screen pops. The hook's boot-effect cleanup
   (`useGroupCall.ts:2267-2283`) sees `keepAlive===true` and **skips** `leaveInternal()`,
   so the SFU room + tracks stay alive.
2. **Restore**: `GroupOverlay.restore()` (`FloatingCallOverlay.tsx:260-280`) calls
   `setGroupCallMinimized(false)` then
   `navigationRef.navigate('GroupCallScreen', {roomId: state.roomId, direction:'incoming',
recipientUserIds:[], …})`. The screen remounts; the hook boots again.
3. **Adopt (resume) path** in the hook (`useGroupCall.ts:537-702`): when the registry holds
   a live call for the **same** `roomId` with live tracks, it _adopts_ the existing refs
   and registry state instead of starting fresh, then **returns early at line 701**.

There are **three independent defects** in this flow. Defect A is deterministic (always
happens). Defects B and C explain the roster loss and the B-05 compounding.

---

## 3. Defect A — Timer always resets to 0:00 (deterministic, highest-confidence)

### Root cause

`GroupCallScreen.tsx:804` declares the visible call-duration timer as **local component
state**, incremented by a local interval:

```ts
// GroupCallScreen.tsx:804-809  (inside GroupCallScreenInner)
const [elapsed, setElapsed] = useState(0);
useEffect(() => {
  if (call.state !== 'joined') {
    return;
  }
  const t = setInterval(() => setElapsed(prev => prev + 1), 1000);
  return () => clearInterval(t);
}, [call.state]);
```

It is rendered at `GroupCallScreen.tsx:1694`:
`<Text style={s.headerTimer}>{formatDuration(elapsed)}</Text>`.

Because `elapsed` is `useState(0)` _local to the screen component_, **every unmount/remount
resets it to 0** — even when the resume (adopt) path succeeds perfectly. The timer is not
anchored to any persistent wall-clock.

### The correct source of truth already exists

The registry stores the real join time: `groupCallRegistry.ts:62-63` `joinedAtMs`, written
at `useGroupCall.ts:2206-2257` (`callStartedAtRef.current = Date.now()` → `joinedAtMs`).
The **adopt path leaves the registry slot untouched**, so `joinedAtMs` survives the
minimize→restore. `FloatingCallOverlay.tsx:47-75` already derives its duration correctly
from `joinedAtMs` — copy that exact pattern.

### Fix (low risk, self-contained)

In `GroupCallScreenInner`, change the `elapsed` effect (lines 805-809) to derive from the
registry's `joinedAtMs` instead of a local counter:

```ts
useEffect(() => {
  if (call.state !== 'joined') {
    return;
  }
  const tick = (): void => {
    const startMs = getActiveGroupCall()?.joinedAtMs ?? null;
    setElapsed(startMs ? Math.max(0, Math.round((Date.now() - startMs) / 1000)) : 0);
  };
  tick(); // paint immediately, no 1s blank
  const t = setInterval(tick, 1000);
  return () => clearInterval(t);
}, [call.state]);
```

- `getActiveGroupCall` is **already imported** in this file
  (`GroupCallScreen.tsx:72-75`) — no new import.
- Keep `const [elapsed, setElapsed] = useState(0);` (only the effect body changes).
- Keep `formatDuration(elapsed)` at line 1694 unchanged.

### ⚠️ Do NOT touch the other `elapsed`

There is a **second, unrelated** `elapsed` at `GroupCallScreen.tsx:2185` inside
`GroupReconnectingOverlay` (the 30-second reconnect budget counter). It is already correctly
anchored to its own `t0Ref = Date.now()`. **Leave it alone.** Scope your edit to
`GroupCallScreenInner` (component starts at line 131).

### Why this can't regress

On a genuinely _fresh_ call (adopt skipped, real new join) `joinedAtMs` is re-stamped at the
new join, so the timer correctly restarts from 0 — which is the desired behaviour for a new
session. When adopt _succeeds_, `joinedAtMs` is the original, so the timer continues. There
is no path where this shows a _wrong_ value.

---

## 4. Defect B — Adopt path is skipped → fresh boot blanks the roster

### Root cause

The resume gate is `useGroupCall.ts:581`:

```ts
if (existing && opts.roomId && existing.roomId === opts.roomId && transportsAlive) { … return; }
```

`transportsAlive` (`useGroupCall.ts:569-580`) is a **proxy** check. The registry shape does
not carry `sendTransport`/`recvTransport` (the code comments admit this), so those clauses
evaluate to `true` unconditionally; the real test reduces to:

```ts
audioReady = audioTrack ? audioTrack.readyState !== 'ended' : true;
videoReady = videoTrack ? videoTrack.readyState !== 'ended' : true;
transportsAlive = audioReady && videoReady; // transports themselves are NOT checked
```

So if a prior network blip / B-05 WS drop / partial teardown left the **local mic/cam track
in `readyState === 'ended'`**, `transportsAlive` is `false`, the adopt gate fails, and the
hook **falls through to the fresh-boot path** (`useGroupCall.ts:704+`).

### What the fresh-boot path does to the roster

The fresh path re-publishes a brand-new registry snapshot at `useGroupCall.ts:2229-2258`
with **`remoteTiles: []`** (line 2238) and a single self-only `identityByTag`. It then issues
a fresh `sfu.join` and re-consumes `existingProducers`. Consequences:

- The roster is **blanked** and only repopulates if the fresh join + consume succeeds.
- A new `participantTag` is minted (server-side), discarding the adopted identity slot.
- **Under a dead WS (B-05)**: `getLiveTransport()` returns null → `setState('unavailable')`,
  or `sfu.join`/consume fail → roster never returns. This is the "tries to re-consume and
  fails" the QA report calls out.

### Recommended fix (scoped, additive, low risk)

Do **not** loosen the adopt gate to adopt genuinely-dead calls (that risks adopting a corpse
— see the Fix #8 corpse note at `useGroupCall.ts:563-580`). Instead, make the fresh-boot
re-join **non-destructive to the roster for the same room**:

When the fresh path publishes the registry snapshot (line 2229), **seed `remoteTiles` and
`identityByTag` from the still-present registry entry if it is the same room**, instead of
hard-clobbering to `[]`:

```ts
const prior = getActiveGroupCall();
const samRoom = prior?.roomId === rid;
setActiveGroupCall({
  …,
  remoteTiles:   samRoom ? prior!.remoteTiles : [],
  identityByTag: samRoom
    ? { ...prior!.identityByTag, [joined.participantTag]: {displayName: opts.ownDisplayName} }
    : { [joined.participantTag]: {displayName: opts.ownDisplayName} },
  …
});
```

This keeps the last-known roster on screen while the fresh consume re-attaches live tiles,
so the user never sees an empty grid during a same-room rejoin. It is purely additive to the
initial seed; the subsequent `consumeProducer` / identity-envelope flow overwrites with live
data as it lands.

> **Note on stale-clear interaction:** the stale-room branch at `useGroupCall.ts:553-562`
> only nulls the registry when `existing.roomId !== opts.roomId`. For a same-room rejoin it
> is _not_ triggered, so `getActiveGroupCall()` is still populated at line 2229. Verify this
> holds before relying on it (it does in the current code).

### Optional, higher-value but higher-risk

Replace the track-readyState proxy in `transportsAlive` with a check that actually reflects
whether the mediasoup pipeline is reusable (e.g. inspect the stashed handles in
`liveSfuHandlesByRoom.get(opts.roomId)` — `recvTx`/`sendTx` `.closed`, `device` present).
This would let more restores take the true adopt path. **Gate this behind device testing**:
the adopt path's resume handler is itself degraded (see Defect C), so adopting more often is
only safe once Defect C is addressed.

---

## 5. Defect C — Even when adopt succeeds, the resumed call is degraded (B-05 fragility)

The adopt path **returns early at `useGroupCall.ts:701`**, _before_ the fresh-boot path's:

1. **`ws.onReconnect(...)` registration** (`useGroupCall.ts:745-769`) — so a resumed call has
   **no B-05 WS-reconnect rejoin** wired. If the WS drops again after a restore, the call
   cannot self-heal. `rejoinRoomRef` is never repopulated on the adopt path either.
2. **`reconcileProducersRef` 4s reconcile loop** — the missed-tile backstop is not re-armed,
   so tiles missed during/after the restore are never recovered.
3. The re-registered resume SFU handler (`useGroupCall.ts:627-700`) is **explicitly limited**
   (see its own comment at lines 627-638): it handles `participant.left` / `muted` / `kicked`
   / `room.ended` but **does not consume NEW producers**. So after a restore, a peer turning
   their camera on, or a new participant joining, will **not** appear.

Net effect: a resumed call looks fine at the instant of adopt but cannot grow its roster and
cannot survive a subsequent WS drop — which is exactly why the report says it's "worse when
B-05 has already killed the WS."

### Fix direction (medium risk — needs the device smoke in §8)

Before the early `return` at line 701, the adopt path should re-establish the same resilience
the fresh path installs:

- Re-register `ws.onReconnect(...)` bound to _this_ hook instance (mirror lines 745-769),
  and ensure `offReconnect` is cleaned up in the effect teardown (the teardown at line 2272
  already calls `offReconnect?.()`; make sure the adopt path assigns it).
- Re-arm the reconcile tick so missed tiles recover (populate `reconcileProducersRef` or
  start the periodic reconcile that the fresh path starts).
- Either (a) widen the resume handler to consume new producers (route through the same
  `consumeProducer` the fresh path uses — but `consumeProducer` is defined in the fresh
  IIFE's scope, so this needs a small refactor to make it callable from both paths, as the
  Fix #7 note at lines 627-638 already anticipates), **or** (b) document that new tiles only
  appear after a true rejoin and accept that limitation for this fix.

> **Risk note:** this is the most delicate change. Every ref in this hook is load-bearing and
> heavily commented with prior audit fixes (BS-LEAK, Fix #7/#8/#12/#13, B-05, B-06, B-13). If
> you only have budget for a safe subset, ship **Defect A (timer)** and **Defect B (non-
> destructive roster seed)** — both are low-risk and resolve the headline symptoms — and file
> Defect C as a tracked follow-up rather than risk a regression in the live mediasoup path.

---

## 6. Files to read before editing (and nothing more)

| File                                                 | Why                                                               | Key lines                                                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/screens/messenger/GroupCallScreen.tsx`          | Timer (Defect A); minimize/back/beforeRemove                      | 131 (component start), 804-809, 1158-1161, 1246-1268, 1680-1701, **2185 (DO NOT TOUCH)**                                                               |
| `src/modules/messenger/webrtc/useGroupCall.ts`       | Adopt vs fresh boot; registry publish; reconnect                  | 537-702 (adopt), 569-580 (`transportsAlive`), 704+ (fresh boot), 745-769 (`onReconnect`), 2206-2258 (join + `setActiveGroupCall`), 2267-2283 (cleanup) |
| `src/modules/messenger/runtime/groupCallRegistry.ts` | `joinedAtMs`, `keepAlive`, minimize semantics                     | 62-72, 121-136, 162-181                                                                                                                                |
| `src/screens/messenger/FloatingCallOverlay.tsx`      | The **correct** `joinedAtMs` timer pattern to mirror; restore nav | 47-75, 260-280                                                                                                                                         |

Use the `code-review-graph` MCP (`get_impact_radius`, `query_graph callers_of`) to confirm
nothing else reads `elapsed` or the registry fields before you change them.

---

## 7. Scoping rules (couplings you must not break)

1. **Two `elapsed` symbols.** Edit only the one in `GroupCallScreenInner` (line 804). The
   `GroupReconnectingOverlay` `elapsed` (line 2185) is a separate 30s counter — untouched.
2. **`keepAlive` is the teardown gate.** The hook cleanup (line 2281) and the audio-session
   cleanup (`GroupCallScreen.tsx:256-263`) both early-return on `keepAlive`. Do not change
   when `keepAlive` is set/cleared — minimize relies on it to keep the SFU room alive.
3. **Registry is the cross-mount source of truth.** Read `joinedAtMs`/`remoteTiles`/
   `identityByTag` from `getActiveGroupCall()`, never reconstruct them locally.
4. **Do not loosen the adopt gate to adopt dead calls.** The corpse guard
   (`useGroupCall.ts:563-580`) exists for a reason — adopting closed transports throws on the
   first `produce()`.
5. **Single responsibility:** the timer fix (A) and the roster-seed fix (B) are independent —
   land them as separate, individually-testable commits. Do not fold them into the riskier
   Defect C change.
6. **Security:** none of these changes touch crypto, sealed-sender, SFrame key handling, or
   the file-vault MFA gate. If your edit drifts toward `frameCryptor*`, `groupCallKeyWait`,
   or `ensureCallGroupKey`, stop — that is out of scope for this bug.

---

## 8. Verification (per CLAUDE.md change-safety gates)

Run in this order — fail fast, then widen:

1. **Targeted unit:** there is an existing resume test
   `src/screens/messenger/__tests__/GroupCallScreen.autopop.test.tsx`. Add/extend a test that:
   - mounts the screen with a registry entry whose `joinedAtMs = Date.now() - 65_000`,
   - asserts the rendered header timer reads ~`1:05`, **not** `0:00` (Defect A);
   - for Defect B, asserts that a same-room re-publish does not blank `remoteTiles` when the
     registry already holds tiles for that room.
     Run it: `npm test -- src/screens/messenger/__tests__/GroupCallScreen.autopop.test.tsx`
2. **Regression — group-call suite:** `npm run test:crypto` plus the group-call tests listed
   in `sqa.md` §10 (`groupCallConsumeOrder`, `groupCallLayout`, `groupCallIdentityRegistry`).
3. **Typecheck:** `npm run typecheck` (mobile) — must **not** exceed the
   `.tsc-baseline.json` baseline (CLAUDE.md says 96; `sqa.md` says 84 — check the live file
   and do not increase it).
4. **Broad:** `npm test`.
5. **Manual device smoke (mandatory for Defect C; recommended for A/B — native modules can't
   be unit-tested):** boot a 2–3 device group call → minimize to Messenger → restore.
   Confirm: (a) timer continues from the real elapsed, not 0:00; (b) roster is present
   immediately on restore; (c) a peer toggling camera after restore still updates (Defect C);
   (d) toggle airplane mode briefly to simulate B-05 and confirm the resumed call rejoins.

**Do not commit on a red gate. Do not `--no-verify`.** (CLAUDE.md change-safety rule 7.)

---

## 9. Suggested commit sequence

1. `fix(group-call): anchor GroupCallScreen timer to registry joinedAtMs (resume timer)`
   — Defect A only.
2. `fix(group-call): preserve roster on same-room SFU rejoin (roster loss)`
   — Defect B only.
3. _(optional, after device testing)_ `fix(group-call): restore reconnect+reconcile on resume adopt path (B-05 hardening)`
   — Defect C.

After landing, append a new bug row to `sqa.md` (next-free number — **B-30 is taken**, use
**B-31**+ — cross-ref B-05), keeping the summary table and numbering consistent — per the
CLAUDE.md QA rule.
