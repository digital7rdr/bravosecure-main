# Call baseline — known-good reference

> **Read this FIRST when calls break.** Founder-verified working build, plus the
> exact defects that had to be fixed to get here. Do not re-diagnose from
> scratch — diff against the baseline and check the four invariants below.

|                    |                                          |
| ------------------ | ---------------------------------------- |
| **Baseline build** | **v1.0.157 (vc188)**                     |
| **Commit**         | `7debd9c`                                |
| **Git tag**        | `known-good/calls-v1.0.157`              |
| **Verified**       | 2026-07-26, founder, real device pair    |
| **Scope verified** | 1:1 **and** group calls, both connecting |

Device evidence from the verified run:

```
[CALLDIAG] cid=a1cf9fa1 role=outgoing iceConnectionState=completed
```

```bash
# See exactly what changed since calls were last known good:
git diff known-good/calls-v1.0.157..HEAD -- \
  src/modules/messenger/webrtc src/screens/messenger/CallScreen.tsx \
  src/screens/messenger/GroupCallScreen.tsx \
  src/screens/messenger/IncomingGroupCallScreen.tsx \
  src/modules/messenger/runtime/transportRegistry.ts \
  src/modules/messenger/push apps/messenger-service/src/gateway
```

---

## 1. The four invariants that make calls work

Break any one of these and calls fail in the ways described. Each was a real,
shipped bug — check them in this order.

### C1 — Outbound ICE must never precede its own offer (B-273)

The relay drops `call.ice` for a `callId` it has no session for, and the session
is created by the **offer**. Candidates sent early are **silently discarded** —
`authorizeCallFrame` returns an `ignore`, not an error, so nothing anywhere
reports it.

Two mechanisms conspire, and fixing only one is not enough:

1. `createOffer()` also applies the local description, so gathering (and
   `onicecandidate`) starts the instant it returns — while the offer still waits
   behind `await buildOfferAuth(...)`.
2. `sendOffer` travels `enqueueForCall` → `waitOpenThenSend` (**async**), while
   `sendIce` takes `safeSend` (**synchronous**). ICE wins the race _even when
   issued second_.

**Therefore the outbound-ICE gate must flush on the `sendOffer` / `sendAnswer`
PROMISE — i.e. at `socket.emit` — not when `sendOffer()` returns.** Gating on
return looks correct and still loses the race. A test caught exactly that.

Symptom when broken: the first (host + srflx) candidates vanish. Calls still
connect on easy networks via relay candidates, so **it looks fine** — then fails
whenever the early candidates were the ones that mattered.

### C2 — `accept()` must answer, or fail loudly (B-274)

Two outcomes only: an answer went out, or the call is ended as failed and the
caller is told. Cancellation is the sole silent case.

Bare `if (cancelled || !pc || pc.isClosed()) return;` exits **resolve the
promise normally**. And throwing is not enough either — the manual in-app accept
path (`useCall.accept`) awaits with **no catch**, so a throw became an unhandled
rejection and the call just sat there. Only the autoAccept path handled failure.

Symptom when broken: callee stuck on "Answering…" while the caller rings out.
Server-side signature: **OFFER delivered OK, then from the callee no answer, no
ICE, and no hangup.** Silence is the tell.

### C3 — The answer-from-notification path runs during a COLD START (B-275)

Tapping a call notification can start the process from scratch:

```
Start proc 15286:com.bravosecure.app for broadcast
  {io.invertase.firebase.messaging.ReactNativeFirebaseMessagingReceiver}
```

**`setLiveTransport` is called from exactly ONE place — `buildProductionRuntime`.**
So on a push cold-start there may be nothing constructing the socket at all, and
merely _waiting_ for it just times out more slowly (a measured device sat **8.7
seconds** with no socket).

A consumer on this path must **boot the runtime, then wait** — bounded, so a
genuinely dead socket still fails rather than hanging behind a spinner. Never ask
`getLiveTransport()` once and treat `null` as terminal.

Symptom when broken: **"Group call unavailable"** immediately on answering from
the notification. The 1:1 path was immune only because `CallScreen` subscribes
via `onTransport` instead of asking once.

### C4 — `iceTransportPolicy` defaults to `'all'`, not `'relay'`

Relay-only makes coturn a **single point of failure**: a TURN outage bricks every
1:1 call with a permanent "Answering…" (that was B-41). `EXPO_PUBLIC_ICE_RELAY_ONLY=true`
restores the old behaviour if a cross-network cellular regression ever needs it.

---

## 2. Diagnose from the RELAY, not the client

The client's own account of a call is **deleted from release builds**:
`babel-plugin-transform-remove-console` strips `console.log` and keeps
`warn`/`error`. `[WEBRTC]` traces are `console.log`, so they do not exist on any
QA build. The relay is the only observer that sees **both** phones.

```bash
ssh -i ~/.ssh/bravo-staging.pem admin@94.136.184.52

# The call frames. NOTE the log tag is "[CALL] OFFER", NOT the wire name
# "call.offer" — grepping the wire names finds nothing and looks like
# "signalling never happened". This cost a session.
docker logs bravo-staging-msgr --since 60m 2>&1 | grep -E '\[CALL\]'

# Frame-count triage. Healthy: OFFER ≈ ANSWER. A big gap means callees are
# not answering at the protocol level (14 OFFER vs 3 ANSWER = broken).
docker logs bravo-staging-msgr --since 60m 2>&1 | grep -oE '\[CALL\] [A-Z]+' | sort | uniq -c

# Did media actually flow? `peer usage: rp=0, rb=0, sp=0, sb=0` means the
# allocation succeeded but NO CreatePermission was issued and not one packet
# was relayed. Filter to real usernames — see the scanner warning below.
docker logs bravo-staging-coturn --since 60m 2>&1 | grep -E 'username=<[0-9]'
```

### Traps that have each cost real time

- **Server log timestamps are UTC; `date` on the box reports IST** (+5:30).
  `11:15` in the log _is_ `16:45` IST — do not dismiss live logs as hours stale.
- **coturn 401/403s are mostly internet scanners**, not us: sessions with
  `username=<>` from `185.216.51.x`. Only `username=<epoch:hex>` lines are ours.
- **TURN secret drift is a real failure mode (B-41) but check it, don't assume
  it.** Compare `docker exec bravo-staging-msgr printenv TURN_STATIC_AUTH_SECRET`
  against coturn's `--static-auth-secret` (via `docker inspect … .Config.Cmd`).
  They matched during the 2026-07-26 incident and the lead was a dead end.
- **`[CALLDIAG]` lines are `warn` and DO survive release.** On the answer path
  they bracket every step, so the **last** one printed names the step that
  stopped: `accept:begin` → `remote-offer-applied` → `local-media-attached` →
  `answer-created` → `call.answer delivered=<bool>` → `iceConnectionState`.
- **The trace lives on the phone that ANSWERS.** To debug a failed answer you
  need logcat from the _callee_, so stage a round where a device you control
  answers.

---

## 3. Still unproven at this baseline

Calls work, but one thread was never closed: during the incident hour, the one
call that was answered was **audio-only** (`sdpLen=1223`, one m-line) and both
that failed were **`kind=video`**. `attachLocalMedia` (camera acquisition) runs
**before** `createAnswer` on the answerer, which makes it the prime suspect for a
video-specific answer failure.

If a video-only answer regression appears, start there — and get a `[CALLDIAG]`
trace from the answering device before changing code.

---

## 4. Do not re-litigate

Ruled out with evidence on 2026-07-26 — do not re-chase without new data:

| Suspect                        | Verdict                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- |
| TURN secret drift (B-41 class) | Secrets **identical** on both sides; creds issued to both parties at call time   |
| B-257/B-258 deep-link rewrite  | Params byte-identical; every call site still waits for `navigationRef.isReady()` |
| `callController.ts` regression | File unchanged since `b0087d7` (B-130)                                           |
| B-256 FGS arbitration          | Touches **stop** paths only; cannot block an answer                              |
