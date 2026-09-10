 

# B-331 — Can't accept a call from the notification (regression, 2026-07-29)

**Status:** **FIXED IN CODE 2026-07-29** (uncommitted working tree) — §6 Step 1 + Step 2
applied exactly as specified; gates green (see §9). Device verify owed (two-device
matrix, §7 — no second signed-in device this session).

**Symptom (founder):** yesterday's build answered calls from the notification fine; after
today's messenger/notification commits, tapping **Accept** on the incoming-call
notification has "trouble" — the call screen opens to "Answering…" and never connects.
The phone still RINGS normally; only the accept dies. Intermittent (see §4 why).

**The one-line cause:** the new killed-app message drain (B-324/B-325, commit `aa68da9`)
connects the messenger WebSocket from a **UI-less headless VM**. A `call.offer` arriving on
that socket reaches `callDispatcher` while **no incoming-call handler is registered**
(MainNavigator never mounted there) and is **silently dropped** — and because the socket
is already connected, the server's parked-offer replay (which only fires on a NEW socket
connect) never gets a chance to redeliver it. Accept then starves forever waiting for an
offer SDP that no longer exists anywhere reachable.

---

## 1. Which builds

| Build                                                                   | State                | Call accept from notification                      |
| ----------------------------------------------------------------------- | -------------------- | -------------------------------------------------- |
| v1.0.184/vc215 · v1.0.185/vc216 (2026-07-28, "yesterday")               | last commit`1a2bafd` | **WORKS** — B-319 flow                             |
| v1.0.186/vc217 (`aa68da9`+) · v1.0.187/vc218 · v1.0.188/vc219 ("today") | HEAD`864517d`        | **BROKEN** in the killed-app + recent-message case |

The founder's "3 commits regarding messenger and notification" = `aa68da9` (B-323..B-325),
`06ed20c` (B-326/B-327), `a218f69` (B-328). The regression is in **`aa68da9`** — specifically
the new `headlessDrain.ts` + the `fcmHeadless.ts` msg-wake branch that calls it.

## 2. How it worked yesterday (vc216) — the B-319 choreography

1. App killed. A message wake drew a **generic banner only** — `fcmHeadless.ts` explicitly
   did NOT boot the runtime: _"We deliberately do NOT boot the messenger runtime /
   libsignal / SQLCipher / WS here — that 2nd-VM contention is why the headless task was
   removed."_ (that comment was deleted today). `index.js:42` still says the handler is
   "SLIM BY DESIGN".
2. A call arrives → callee has **no socket** → gateway **parks the offer in Redis (45s
   TTL)** and **always fires the VoIP wake** (N-01, `messenger.gateway.ts:1382-1432`).
3. Phone rings (FCM full-screen ring). User taps Accept → app boots → runtime boots →
   **fresh WS connect → gateway replays the parked offer on connect**
   (`messenger.gateway.ts:~590-730`, "replay pending offer").
4. CallScreen is already mounted with `autoAccept` (cold-launch stack seeds it); useCall
   registered its signalling, so the replayed offer is ingested → `incomingSdpKey` flips →
   the B-319 auto-accept effect fires `accept()` → connected.

## 3. How it breaks today (vc217+) — verified chain, file:line

1. App killed. Any **message** arrives → msg-wake FCM → `handleHeadlessFcm`
   (`index.js:47`) → **NEW:** `headlessDrainAndNotify()` (`fcmHeadless.ts:163`) →
   `configureRuntimeFromPersisted()` → `getMessengerRuntime('production')` →
   **`transport.connect()` (`productionRuntime.ts:1548`)**. The drain never disconnects —
   the killed phone now holds a **live WS socket owned by a VM with no UI**, for as long
   as Android keeps the process.
2. The caller calls. Gateway forwards `call.offer` **live** into that socket
   (`messenger.gateway.ts:1374`). It also parks the offer + fires the wake (N-01 does both
   unconditionally — this is why ringing still works).
3. In the headless VM, `callDispatcher.ts` case `'call.offer'` (`:240`) reaches a
   dead end **whichever branch runs**: `setIncomingCallHandler` AND `setCallOfferVerifier`
   are both registered only by `MainNavigator.tsx:534/:727` — never in this VM. With no
   verifier installed, the legacy fallback `if (onIncoming) {onIncoming(f.data);}`
   (`:267`) drops the offer; if a verifier were present, the verified branch
   `if (handler) {handler(f.data);}` (`:260`) drops it the same way. **The offer is
   dropped on the floor.** Nothing caches it (`incomingCallCache` is written by the
   handler path), nothing rings from this lane, nothing persists.
4. The FCM wake posts the ring → user taps **Accept** → the activity launches **into the
   same process** → runtime already configured (B-326 relies on exactly this) → **the WS
   is already connected, so there is no new connect → the Redis parked-offer replay never
   fires**. `resolveIncomingCallRoute` finds no cached SDP (the cache is in-memory,
   `incomingCallCache.ts:1-29`, and was never written). CallScreen mounts with
   `incomingSdp: undefined`.
5. The auto-accept effect blocks at `if (!incomingSdpKey) {return;}`
   (`CallScreen.tsx:982`) — by design it waits for the offer. The offer never comes.
   **"Answering…" forever.** The 45 s NA-02/B-110 dead-offer machinery eventually shows
   the failure — but the call was already lost.

## 4. Why it's intermittent

- If **no message preceded the call** (no headless drain ran, process cold): the yesterday
  flow runs unchanged — accept works. The bug needs a msg-wake within the
  process-survival window before the call — for an actively-chatting tester, most of the
  time.
- If Android froze/reaped the headless process before the call: cold boot on Accept →
  fresh WS → replay works.
- If the zombie socket died and the transport watchdog `forceReconnect()`s
  (`productionRuntime.ts:1738-1758`) within the offer's 45 s Redis TTL: replay fires late
  → call recovers. Race-dependent — hence "sometimes okay, sometimes stuck".
- App merely **backgrounded** (not killed): the same handler runs in the main VM where
  MainNavigator IS mounted → handler registered → no bug.

## 5. Differential — everything else in `1a2bafd..864517d`, examined and cleared

| Change                                                                             | Verdict                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-329** `useCall.ts` state seed from registry (`864517d`)                        | Cleared. Cold accept: registry empty → seeds`'ringing'` exactly as before. Warm accept: CallScreen already mounted, no remount, seed never consulted. Pre-accept registry state is always `'ringing'` (`useCall.ts:883`), so the seed cannot produce a non-ringing value before accept. |
| **B-330** `CallScreen.tsx` diff (+58)                                              | Cleared. Entirely PiP margin/PanResponder +`useWindowDimensions`; the auto-accept effect is byte-identical to yesterday.                                                                                                                                                                |
| **B-326** `ensureRuntimeForNotifAction` / **B-325** `startTapTimePull` (`06ed20c`) | Same hazard**class** (early WS connect before UI) but bounded — these run on a tap that is about to boot the UI, so the no-handler window is seconds. Secondary exposure, not the primary cause. Fixing §6 closes this window too.                                                      |
| **B-323/B-327/B-328** `callNotification.ts`, `backgroundMessageNotifier`           | Cleared — display-only fields (send time, avatar icon, sender name) on MESSAGE banners.                                                                                                                                                                                                 |
| `MainNavigator.tsx` +8 (`persistHeadlessRuntimeConfig`)                            | Cleared — write-only persistence of ids + public key.                                                                                                                                                                                                                                   |
| Maps/news/VBG commits (`c1619b0`, `6178895`, `5a91705`)                            | Not on the call path.                                                                                                                                                                                                                                                                   |

## 6. The fix — step by step, smallest safe diff first

### Step 1 — `callDispatcher.ts`: never drop a verified offer; cache it (THE fix)

In the `'call.offer'` case, in the no-handler path, write the offer into the existing
`incomingCallCache` instead of discarding it. The cache is exactly the machinery built for
"the payload arrived before the UI could consume it" (`incomingCallCache.ts:6-17`), and
`resolveIncomingCallRoute` already hydrates the Accept navigation from it
(`fcmBootstrap.ts:1444`).

```ts
// inside verifier.then(result => { ... }) — AFTER result.ok, replacing the bare
// `if (handler) {handler(f.data);}`:
if (handler) {
  handler(f.data);
} else {
  // B-331 — a verified offer with no UI handler (headless VM, or the
  // pre-MainNavigator boot window) must not be dropped: the gateway has
  // already delivered it, so no replay will ever resend it. Cache it so
  // the Accept navigation's resolveIncomingCallRoute finds the SDP.
  try {
    const cache =
      require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
    cache.setIncomingCallPayload({
      callId: f.data.callId,
      callerName: '', // wake/notification lane owns the display name
      kind: f.data.kind === 'video' ? 'video' : 'voice',
      fromUserId: f.data.from.userId,
      remoteDeviceId: f.data.from.deviceId,
      incomingSdp: f.data.sdp,
    });
  } catch {
    /* cache unavailable (tests) — behavior degrades to the old drop */
  }
}
```

Apply the same `else` to the legacy no-verifier fallback branch (`callDispatcher.ts:266-268`).

Why this shape:

- **Security unchanged:** the cache write sits INSIDE the S7-verified branch — a forged
  offer still never surfaces. No envelope/AAD/verifier change → no CLAUDE.md stop
  condition. `setIncomingCallPayload` is tombstone-aware (returns false for a
  consumed/declined callId — stale SDP cannot repopulate, same guarantee as today).
- **No new ring lane:** the ring keeps coming from the always-fired VoIP wake (N-01);
  the notifee id `bravo-call-<callId>` dedupe is untouched (`ringDedupPresented` stays
  meaningful).
- **Both death modes covered:** process survives to the Accept tap → cache hit → SDP at
  mount → accept proceeds. Process reaped → genuine cold boot → fresh WS connect → Redis
  replay (45 s TTL covers the ring window) → B-319 path, unchanged.
- **Bonus:** also closes the pre-existing (rare) cold-boot race where the WS replay lands
  a beat before MainNavigator registers the handler.

### Step 2 — the RED-first regression test (bug-regression contract, CLAUDE.md)

New `src/modules/messenger/__tests__/callOfferNoHandlerCache.test.ts`:

1. `setIncomingCallHandler(null)`; dispatch a **verified** `call.offer` frame →
   `getIncomingCallPayload(callId)` returns the payload **with the SDP**.
   **Must be RED at HEAD** (today it's dropped) — that proves it pins B-331.
2. Tombstoned callId (declined earlier) → still NOT cached (tombstone wins).
3. Handler registered → handler receives the offer and the cache is NOT written by this
   branch (no behavior change on the normal path).
4. Verifier-rejects → nothing cached (forged offers stay dead).

### Step 3 — OPTIONAL hardening (separate commit, needs discussion — do NOT fold into Step 1)

Disconnect the transport at the end of `headlessDrainAndNotify()` when running in a
truly-headless VM, restoring the "killed device is offline" contract (park + wake +
replay-on-connect). **Deliberately not required once Step 1 lands**, and it interacts
with B-326 (notification Reply reuses the connected runtime) and the foreground reconnect
paths — it needs a MESSAGE_LOOP §5 caller-completeness pass over every
`getMessengerRuntime` caller first. Don't improvise it into the hotfix.

### What NOT to do

- Do **not** register a full incoming-call handler (navigation!) in the headless VM —
  navigating without UI is the B-272 class of crash, and it would add a second ring lane.
- Do **not** revert the headless drain wholesale — B-324/B-325 are founder-approved
  behavior (real group names/previews on killed banners). Step 1 keeps them.
- Do **not** weaken the S7 offer verifier or cache before verification.
- Do **not** touch `verifyMerkleCommit`/backup paths — unrelated, listed here because the
  drain lives next to backup code.

## 7. Verification protocol — prove the fix, prove nothing else broke

Run in this order:

1. **New test RED first** at HEAD (Step 2, case 1) — commit only after seeing it fail for
   the right reason (payload undefined), then apply Step 1, see it turn GREEN.
2. **The full messenger gate** (CLAUDE.md — both projects, crypto twice):

   ```
   npx jest --selectProjects messenger-crypto        # run TWICE — B-126 flake rule
   npx jest --selectProjects app --testPathPattern "screens/messenger"
   ```

   Suites that specifically guard this seam (all green at HEAD, 2026-07-29 baseline —
   run before writing this doc): `callFrameRouter`, `callAcceptLatch`, `callAnswerStuck`,
   `callAnswerLifecycle`, `callNotifActionContract`, `ringDedupPresented`,
   `invitePhantomRing`, `headlessDrainNotify`, `notifTapNavContract`,
   `fcmHeadlessRouting`, `callMinimizeRestorePins`. None of them models a null
   `onIncoming` with a live headless socket — that is WHY CI stayed green while the
   device broke.

3. **Typecheck:** `npm run typecheck` — ≤ baseline 47 (46 at last ship).
4. | **Device matrix (two devices, A caller / B callee)** — the part no unit test can vouch for: | #                                                                                                               | Scenario                                          | Expected |
   | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------- |
   | a                                                                                           | **Founder repro:** kill app on B → A sends a TEXT → within ~1 min A CALLS B → B taps Accept on the notification | connects (this is the broken one today)           |
   | b                                                                                           | Control: kill app on B → A calls directly (no prior text) → Accept                                              | connects (B-319 path must stay intact)            |
   | c                                                                                           | Warm: app foreground/background, Accept from shade                                                              | connects                                          |
   | d                                                                                           | B-326 stays fixed: kill app on B → notification Reply                                                           | reply sends                                       |
   | e                                                                                           | Group ring during/after a headless drain                                                                        | rings + joins (different lane, confirm untouched) |
   | Logcat markers:`[CALLDIAG]`, `[bravo.callDispatcher] call.offer`,                           |                                                                                                                 |                                                   |
   | `[fcm-headless] msg-wake drained`, `[notifee] navigated → CallScreen`.                      |                                                                                                                 |                                                   |
5. **Server side needs NO deploy** for this fix — the gateway already parks + wakes
   unconditionally (N-01). Do not touch it.

## 8. Fix applied — 2026-07-29 (same session as the diagnosis)

**Code:** `src/modules/messenger/webrtc/callDispatcher.ts` — new `cacheUnhandledOffer()`
helper + `else` branches on BOTH offer paths (verified `:260`-class and legacy
`:267`-class). The handler path is verbatim-unchanged (`git diff 1a2bafd --
src/modules/messenger/webrtc/callDispatcher.ts` shows only the two `else` additions +
the helper — the file was untouched by today's upstream commits, so that diff IS the
whole change vs yesterday). `callerName` is passed `''` deliberately: the cache's NA-01
`mergeIncoming` keeps the voip-wake lane's resolved name (`next.callerName ||
prev.callerName`) — confirmed by the merge test below.

**Test:** `src/modules/messenger/__tests__/callOfferNoHandlerCache.test.ts` (6 tests) —
**proven RED first** at HEAD `864517d` (the 3 cache-requiring cases failed with
null/undefined; the 3 guard cases passed), then GREEN after the fix. That is the
mutation-proof: the test demonstrably measures this exact bug.

**Gates (all on the fixed working tree):**

| Gate                                                                  | Result                                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| New suite `callOfferNoHandlerCache`                                   | RED pre-fix → **6/6 GREEN** post-fix                                                           |
| `messenger-crypto` full, run 1                                        | 388/389 suites; `groupCallVideoEncodings` red (16)                                             |
| `messenger-crypto` full, run 2                                        | 388/389 suites; red **MOVED** to `callAudioSessionArbitration` (3)                             |
| Both movers in isolation                                              | `groupCallVideoEncodings` 18/18 · `callAudioSessionArbitration` 14/14                          |
| Flake-rule verdict (B-126: "a failure that moves is the known flake") | moving + isolation-green + both green twice pre-fix same morning → **known flake, gate GREEN** |
| App project `screens/messenger`                                       | 18 suites / 163 tests green (identical to pre-fix baseline)                                    |
| `npm run typecheck`                                                   | exit 0, within the 47-error baseline; zero new errors                                          |

## 9. Sign-off criteria

- New regression test proven RED→GREEN by the fix (mutation-prove: revert Step 1, test
  goes red again).
- Crypto project green twice + app messenger screens green + tsc ≤ baseline.
- Device rows (a)–(d) pass on a physical device pair; (a) additionally re-run once with
  the app killed >2 min after the text (process-reaped variant → Redis replay path).
- `sqa.md` B-331 entry updated from DIAGNOSED → FIXED with the commit hash.
