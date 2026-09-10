# End-to-end message delivery latency — send → server → other device's screen (2026-08-29)

**Status:** investigation only — no code changed. Logged as **B-693** in `sqa.md`.
**Complaint (founder):** "on WhatsApp when we send a message the other device gets it
immediately; in our app it takes a little time to show on the other device — 1:1,
groups, AND departmental/workspace channels. It should work smoothly even on a dead
phone."

**Scope split:** the sibling doc
`docs/qa/NOTIFICATION_LATENCY_SMOOTHNESS_2026-08-29.md` (**B-692**) owns the
_notification_ half (killed-app banner lane, alert throttle, FCM debounce, in-app
banner gap). This doc owns the _delivery_ half: sender's tap → encrypt → transport →
server fan-out → recipient decrypt → bubble rendered, for all three conversation
kinds. The dead-phone lane is B-692's RC-1; this doc adds only what B-692 did not
cover.

Built from a two-agent trace (full sender/server/recipient code walk with file:line,
then an adversarial verification round), a critic pass on the finished doc, plus the
measured QA record (B-279/B-285, B-632..634, B-687/B-690, B-691, sqa.md 2026-08-28/29
device sessions). Line numbers rot fast in this repo — **re-grep the symbol before
trusting any stamped line.**

---

## 0. Plain-English summary

Think of sending a message as mailing a letter through a courier. WhatsApp's courier
takes your letter the instant you hand it over, and the recipient's doorman hands it
straight in. In Bravo the courier is honest but has habits that add seconds:

1. **In a group or department channel, the sender's phone writes a separate,
   individually-encrypted copy of the letter for EVERY member** — 30 members means
   30 encryption jobs and 30 courier calls from your phone, all on the same single
   JS thread that is also drawing your screen. 1:1 doesn't have this.
2. **The recipient's phone opens letters strictly one at a time** through a single
   security checkpoint (decrypt + database write). A burst of arrivals queues; the
   checkpoint is shared with other work, so one slow item delays every render
   behind it.
3. **If anything goes slightly wrong on send** (a stale connection, a cold
   certificate, a server 429), the letter silently parks in a retry queue. Any
   reconnect, network change, or app-foreground retries it immediately — but on a
   quietly-broken connection with no such event, the next attempt can be up to a
   minute away, and the bubble just says "sending" so the sender can't tell slow
   from broken.
4. **A phone with the screen off but app alive** may hold a half-dead connection
   for up to ~40 seconds before anyone notices; until then the server's delivery
   lands on a dead pipe and the message waits for the push-notification wake lane
   (B-692's territory).

The good news, verified in the trace: the architecture is right where it matters —
the sender's bubble renders **before** any crypto or network; the server's hot path
is Redis-only and **pushes the full envelope over the live socket immediately** (no
"wake then pull" round-trip); dept/workspace channels are exactly groups on the wire
(one path to fix, not two). What's missing is measurement on half the pipeline and a
handful of structural costs listed below.

---

## 1. The pipeline, leg by leg (verified topology)

| Leg                        | 1:1                                                                                                                                                                                                                                                                                                                      | Group / dept channel                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sender UI                  | optimistic bubble BEFORE any await (`productionRuntime.ts:4214`, M-15/B-125 rule)                                                                                                                                                                                                                                        | same (`:3624`)                                                                                                                                                                                                    |
| Sender crypto              | 1 ratchet encrypt + ECIES wrap, serial awaits, caches warm ⇒ all local (`:4296-4353`)                                                                                                                                                                                                                                    | 1 group AES encrypt (`:3715-3738`), then **N pairwise ratchet encrypts + N ECIES wraps + 2N SQLCipher outbox writes** (`sendOne` `:3827-4067`), `Promise.allSettled` (`:4088`) — parallel network, **serial CPU** |
| Transport                  | **WS frame** `envelope.send`, fire-and-forget; HTTP fallback after ack watchdog max(5s, 4×RTT) cap 20s (`:4546`, `:4567-4599`)                                                                                                                                                                                           | **N × HTTP POST `/envelopes`** — no WS lane by design (`:4016-4021`); 20s fetch deadline                                                                                                                          |
| Server hot path            | Redis-only: dedup claim → pending put → 3 concurrent aux writes → archive fire-and-forget → immediate emit (`envelope.service.ts` submit → `tryFanOut :725-752`)                                                                                                                                                         | same, ×N independent posts — the relay is deliberately group-blind (`envelope.controller.ts:46-59`)                                                                                                               |
| Delivery to live recipient | **direct WS emit carrying the full sealed envelope** to room `u:{userId}:{deviceId}` (`envelope.service.ts:731-750`) — zero extra round-trips                                                                                                                                                                            | same, per leg                                                                                                                                                                                                     |
| Recipient                  | unwrap ECIES + cert verify outside the txn (`handleDeliverInner :7524-7681`), then **one global `txnChain`** serializes ratchet decrypt + SQLCipher BEGIN IMMEDIATE…COMMIT per envelope (`receiveTransaction.ts:50,111-164,327-404`); zustand append renders without waiting for COMMIT; notifications post-COMMIT (M16) | same + one AES-GCM `parseGroupMessage` (`:9191`) — recipient cost ≈ 1:1                                                                                                                                           |
| Sender's ✓✓                | `envelope.accepted` WS event flips 'sent' (`handleAccepted :7475`); recipient acks batch 200ms/100 (`ackQueue.ts:28-30`)                                                                                                                                                                                                 | HTTP 200 flips 'sent'; **delivery receipts arrive only via the 60s outbox poll** (`:2351-2362`, OM-03 `:4028-4032`)                                                                                               |

**Dept/workspace channels are groups, full stop:** `DepartmentChatScreen.tsx:1002-1004`
calls `rt.sendText(groupConversationId, …, {isGroup:true})` — same branch, same
fan-out, same receive path. No separate wire path, no server-side channel concept.

**Boot-only buffer:** message frames arriving between `transport.connect()` and
SQLCipher-deps construction (~1-2s cold boot) buffer FIFO and drain after hydrate
(`productionRuntime.ts:1370-1381,1496-1503`). Call/ring frames are exempt; message
frames are not. Irrelevant after boot.

---

## 2. Root causes, ranked (DL-1..DL-9)

> Two scopes, deliberately separated. **Both-devices-foreground** is the best case
> (~1 RTT + tens of ms; the architecture is right there). **Idle-but-alive
> recipient** (screen off, app backgrounded, not killed) is the case the founder
> most often actually experiences — and there the dominant term is not crypto or
> fan-out at all. The killed-phone case is B-692 RC-1 and is not re-ranked here.
> Items marked ⚠ UNMEASURED are structural hypotheses with a proposed instrument,
> not findings — the fix plan gates on F-0.

### DL-1 (P0, ⚠ UNMEASURED) — recipient-side serialized decrypt+commit chain

Every inbound envelope pays: in-flight guard → `wasSeen` SQLCipher read → ECIES
unwrap → Ed25519 cert verify (both outside the chain) → **a slot on the single
global `txnChain`** → JS libsignal ratchet decrypt → SQLCipher BEGIN IMMEDIATE →
upsert + markSeen → COMMIT — strictly one envelope at a time
(`receiveTransaction.ts:50`). The lock topology around it (critic-verified —
an earlier draft of this doc got it wrong):

- **First-contact X3DH session installs ride the global chain**; a warm-session
  send takes NO chain slot (`hasSession` short-circuit at `:6925` sits BEFORE the
  `runOnTxnChain` wrapper at `:6939-6942`); the per-send ratchet `storeSession`
  is one raw autocommit statement (`sqlCipherStore.ts:468-473`).
- The 50ms-coalesced status/persist flush (`upsertCoalesced`,
  `sqlMessageStore.ts:155-183`) deliberately does **NOT** take the global chain —
  it writes raw autocommit rows on a **per-conversation** chain (chain B), the
  B-130 fix shape (in-code comment: the flush "must NOT call upsertBatch, which
  awaits the global txn chain"). The `statusFlush`-labelled `upsertBatch` (`:685`)
  has zero live-path callers (restore importer only).
- **The coupling that remains:** the receive txn holds the global chain (A) and
  then **awaits chain B** for its own row write (`applyDirectText.ts:93` /
  `applyGroupText.ts:140` → `chainOp`). So a fast-send burst's coalesced flush
  holding chain B for a conversation **extends the receive frame** for an inbound
  message in that conversation — plus every raw statement interleaves on the one
  SQLCipher connection.

Backup does **NOT** share this chain (verified: `merkleCommit.ts:138` has its own
`commitChain`; the mirror ledger writes autocommit-no-chain on purpose,
`mirrorLedger.ts:93-100`) — but backup mirror encrypts and the ~0.8s Merkle root
computation still burn the same **JS thread** on backup-enabled accounts, and
interleave statements on the one SQLCipher connection.

On low-end Hermes the per-envelope chain cost is plausibly 100-300ms and compounds
linearly in bursts. **No probe measures any of it** — this is the unlit half of the
pipeline (§3c). W5 moved the digest floor native (sha256 6.9×), never measured on
this path specifically. The A-holds-then-awaits-B coupling under a fast-send burst,
together with the measured B-632..634 per-send residue, is the best current
explanation of the founder's "send fast then everything is stuck" repro.

### DL-2 (P0) — idle-but-alive recipient: socket half-death detection IS the latency

The case the founder's phrasing most often describes. Screen-off/Doze freezes the
app-level 4s ping (a frozen timer, `productionRuntime.ts:2140-2158`); a dead route
is noticed only by the server's 30s ping cadence
(`configuration.ts:16`, pong grace 25s), the client's 40s silence rule
(`client.ts:100`), or a NetInfo edge (~1s on a real handover, `:1810-1863`). Until
detection, the server's immediate `envelope.deliver` emit lands on a buffered dead
fd — the message is "delivered" to a pipe nobody is reading — and reaches the user
only via the B-692 FCM wake lane (2s server debounce + drain budget). Reconnect
rides socket.io's 0.5→30s jittered ladder + the B-14 manual ladder
(`client.ts:1020-1027,1352-1356`); a timer-free immediate reopen exists when a call
is live or an outbound message is unacked (`hasLiveCall`/`hasPendingOutbound`,
`client.ts:190-200`) — i.e. the _sender_ gets an urgency fast-path, the idle
_recipient_ does not.

### DL-3 (P1) — group/dept sender fan-out: CPU × N on the JS thread

The body is group-encrypted once (`:3715-3738`), but each member costs a full
pairwise ratchet encrypt + per-recipient seal + ECIES wrap + 2 SQLCipher outbox
writes on the sender's one JS thread (`sendOne :3827-4067`). A 30-member dept
channel ≈ 30× the 1:1 crypto cost per post, paid while the sender's phone is also
animating. The old serial-network loop cost ~8s for 20 members, fixed to
`Promise.allSettled` (`:4088`, Fix #10 note `:3814-3819`); the CPU serialization
remains by the nature of JS. Cap `MAX_GROUP_FANOUT = 250` (`:3654`).
Late-in-the-wave members structurally receive later under contention, and each leg
also fans out its own server-side FCM wake decision.

### DL-4 (P1) — the silent outbox detour after any transient failure

Any send-leg failure (cold cert fetch, network blip, relay 429, socket fallback)
parks the envelope in the durable outbox with backoff **eligibility** rungs
`[1s, 4s, 15s, 60s, 5min]`, MAX_ATTEMPTS 10 (`sqlOutboxStore.ts:60-66,306-407`).
The rescue machinery is better than an earlier draft claimed (critic-verified):
the drain fires **unthrottled** on every WS 'connected' (`:1567`, with
`unpark:true`), NetInfo edge (`:1862`), and AppState-active (`:2012`) — the
15s/20s budgets only suppress _repeat_ kicks inside a flap storm (OM-07 design
decision), and even a denied kick still runs `drain()` (`:9774-9777`);
`scheduleTransientRedrain` (`:9794-9818`) books a 2-60s retry honouring
Retry-After after a 429/5xx. **The true residue:** a due row on a stable socket
with NO connectivity/foreground event waits for the 60s timer (`:2351-2362`); a
parked unreachable-class row waits for the next up-edge. Either way the bubble
shows 'sending' with no reason — "sometimes it takes a while" is this class's
signature, and the user cannot tell slow from broken.

### DL-5 (P1) — the half-dead-fd SENDER blind window: 5-20s, narrowly scoped

Precisely scoped (verified): a sender who KNOWS it is disconnected pays ~0 —
`transport.send` throws synchronously when `!socket.connected`
(`client.ts:397-400`) and `sendText`'s catch goes straight to `await httpFallback()`
(`:4601-4607`). The blind window exists only when the fd is half-dead
(`connected === true`, writes buffered — Doze-thaw, NAT rebind): the WS emit is
fire-and-forget with no per-write error callback, so the ack watchdog
`max(5s, 4×RTT) cap 20s` (`:370-372,392-399,4567-4599`) is the only detection, and
`forceReconnect` inside it is additionally gated on 40s of server silence. NetInfo
(~1s, real handovers only) and backgrounding (drains the already-enqueued outbox
row over HTTP, `:2112-2116`) can beat the watchdog; a pure fd death on a stable
network cannot. This matches "backgrounded sender resumes and the message crawls",
not two foreground phones.

### DL-6 (P2) — group sender's ✓✓ honesty gap: the 60s receipt poll

HTTP-submitted envelopes get no `envelope.delivered` push — the submitter map is
populated only by the WS handler (`messenger.gateway.ts:1386-1392`; the HTTP
controller passes none by design, `envelope.controller.ts:97-110`; ack-side emit
only fires when `takeSubmitter` finds one, `envelope.service.ts:461-483`). All
group legs are HTTP → receipt slot only. The poll runs at exactly two sites — WS
`'connected'` (`:1586`) and the 60s outbox timer (`:2357`) — **not** chat-open,
**not** app-resume. So on a stable socket a group ✓✓ genuinely waits up to ~60s
after every member already has the message. ('sending'→'sent' is never the poll's
job: group flips on the HTTP 200 tally `:4152`, 1:1 on `envelope.accepted`
`:7475`; the poll only advances sent→delivered, `httpReceiptReconcile.ts:112-113`,
capped at 100 probes per tick `:2355-2357` — a large fan-out's ✓✓ trickles across
successive polls.) The founder judges speed by what the ticks say — this is a pure
perceived-latency amplifier on every group/channel send.

### DL-7 (P2) — fixed costs on the 1:1 critical path + cold-boot buffer

A durable SQLCipher outbox enqueue is awaited **before** the network write
(`:4424-4449`) — correct for reliability, unmeasured on device (dead-phone plan F8
names the per-send disk write as the likely residual cost). The recipient's ack
batches 200ms/100 items (`ackQueue.ts:28-30`) — delays the sender's ✓✓ only, never
the render. Cold boot only: message frames arriving before SQLCipher deps exist
buffer FIFO ~1-2s (`:1370-1381,1496-1503`); call/ring frames are exempt, message
frames are not.

### DL-8 (P2) — missing-group-key stash: minutes, not seconds

A member without the group master key (new member, lazily-provisioned dept channel,
rekey in flight) has inbound envelopes durably stashed and rendered only after the
key arrives via owner reshare; resync is reconnect-triggered and rate-limited
(`:8017-8018,8082-8100,1597-1599`). The one group-specific path where "a little
time" becomes minutes-to-next-reconnect. (Gate parity M15 already enforced —
`stashDrainGateParity`.)

### DL-9 (P3) — perception: delayed messages pop instead of animating

B-692 RC-7: a bubble older than 2s skips the entrance animation
(`ChatScreen.tsx:3117-3119`) — every pipeline-delayed message _also looks_ broken.
Fix rides with B-692 S-6; listed here because delivery delays trigger it.

**One verified non-problem worth stating:** the bubble renders as soon as decrypt
finishes — the zustand append runs INSIDE the txn, before the awaited SQL upsert
and before COMMIT, in both lanes (`applyGroupText.ts:138` before `:140`;
`applyDirectText.ts:92-94`); only notifications defer to post-COMMIT (M16). Render
is not gated on the commit.

---

## 3. The before/after ledger — "previous vs now", and what is still owed

**Founder rule (device-verify-before-handover): nothing below moves from "target"
to "now" without a post-install device log.** All measured numbers are from the
founder's Redmi Note 11 unless noted.

### 3a. Already fixed — previous → now (measured pairs)

| Metric                               | Previous (measured)                                                                            | Now (measured)                               | Fix                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------ |
| Merkle commit after a chat burst     | 8.8–33.8s each, ×14 back-to-back (~4.5 min walking); 58% of ALL stall time co-timed with walks | **0.82–0.91s** cache-signed, zero walk bytes | B-687 flip, device-proven 2026-08-29 |
| Crypto digest floor (sha256×200×1KB) | 290ms                                                                                          | **42ms** (6.9×)                              | W5 native, device-proven             |
| Wire codec (100KB)                   | 280ms                                                                                          | **117ms** (2.4×)                             | W5                                   |
| Fast-send burst JS stalls            | 350–500ms/send compounding to 3.4s (July)                                                      | 155–776ms, **no compounding**                | B-632..634                           |
| Group fan-out network wave           | ~8s serial for 20 members (pre-Fix#10)                                                         | parallel `allSettled`                        | historical                           |
| Cold start → first frame             | 3.7s (post-install) / 1544ms steady                                                            | **1479ms**                                   | W4 boot diet                         |
| Release APK                          | 604MB                                                                                          | **110MB** arm64                              | B-685/686                            |

### 3b. Baselines that exist but are UNREAD or partial

| Probe                                                                                       | What it would tell us                                                                  | Status                                                             |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `[LAGDIAG] [send.total]` (`:6792-6823`, warn ≥80ms)                                         | total sender wall per send — **982–1962ms measured 2026-08-28**, sub-stages unmeasured | sub-stage probes explicitly OWED (sqa.md W5 entry)                 |
| `[LAGDIAG] send1v1 session=…ratchet=…idkey=…sealedsender=` (`:3841-3928`, fires >120ms/leg) | 1:1 stage split                                                                        | never fired on device (B-285) — threshold may sit above real costs |
| `[NOTIFLAT]` (5 bail sites)                                                                 | killed-lane stage timings                                                              | shipped 2026-08-01, **never read off a phone** (B-692 S-0)         |
| `[chat.open]` bracket (B-691)                                                               | tap → transitionEnd                                                                    | shipped, device A/B owed                                           |
| Server pair `[envelope.send] accepted` ↔ `[envelope.deliver] emit`                          | server dwell per envelope                                                              | in tree, never correlated                                          |

### 3c. Missing entirely — must be built before any fix is believed

| Gap                                          | Proposed probe                                                                                                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Receive side has NO latency probe at all** | `[RECVLAT]` warn in `handleDeliverInner`: frame-arrival → post-COMMIT ms + chain-queue depth + stage split (unwrap / cert / chain-wait / decrypt / persist). Mirror of `[send.total]`; `console.warn` so it survives release; ids and numbers only (logAudit). |
| Group fan-out cost curve                     | `[send.total]` gains member-count + per-stage aggregate for the group branch                                                                                                                                                                                   |
| E2E device-to-device number                  | two-device protocol: sender tap timestamp ↔ recipient `[RECVLAT]` commit timestamp, NTP-corrected; 20 sends interleaved A/B per the measurement rule                                                                                                           |

### 3d. Targets after fixes (the "now" column the next session must fill)

| Path                                                     | Target                                              |
| -------------------------------------------------------- | --------------------------------------------------- |
| 1:1, both alive, foreground → bubble on recipient screen | **< 500ms** p50, < 1s p95                           |
| Group ≤30 members, both alive                            | **< 800ms** p50 to first member, < 2s to all        |
| Sender tap → own bubble                                  | < 100ms (dead-phone plan §3, stands)                |
| 10-fast-sends burst                                      | no JS stall > 250ms either device (plan §3, stands) |
| Killed phone: push → something visible                   | < 1.5s (B-692 S-0 target, stands)                   |
| Group sender's ✓✓ after all members have it              | < 5s (vs today's ≤60s poll)                         |

**Measurement rule (repo standing rule, B-279):** interleave OLD/NEW builds
(A/B/A/B) with scripted input — thermal drift exceeds most effects being measured.
Release APK on a real phone; never BlueStacks for anything push-adjacent;
swipe-kill, never Force-stop.

---

## 4. How to solve — ranked fix plan

> Ordering rule this repo has paid for repeatedly: **measure before rebuilding.**
> F-0 is not garnish — DL-1 is unmeasured and the biggest-looking item; a fix
> shipped without its "previous" number can never prove itself.

### F-0 — light the dark half (half a day, zero risk)

**PROBES BUILT 2026-08-29 (this session) — the device capture is what remains.**
What shipped (all `console.warn`, release-visible; numbers/counts/truncated ids
only, logAudit-clean; gates: invariant batch 121, crypto 6846 green run 1 +
B-126-moving on re-runs, app messenger screens 736, tsc 47 = baseline, eslint
clean; two mutation proofs):

- **`[LAGDIAG] [recv.total]`** — one line per live WS envelope in
  `handleDeliverInner`: `ms` total, `unwrap` (wasSeen + ECIES), `cert`
  (authority verify), `chainWait` (queued behind the global txn chain), `txn`
  (decrypt + persist, commit excluded), `qdepth` (frames already on the chain
  at arrival — new `chainPendingCount()` gauge in `receiveTransaction.ts`),
  `ok`, `env`. Emitted before the ack so a wedged ack can't eat the reading.
- **`[LAGDIAG] [send.group]`** — one line per group/dept post: `members`,
  `delivered`, `failed`, `waveMs` (the `allSettled` fan-out wall time — the
  DL-3 scaling number), `convo`.
- **`[LAGDIAG] [send.1v1]`** — 1:1 stage split at ≥40ms: `cert`, `session`,
  `ratchet` (seal+encrypt), `idkey`, `wrap`, `outbox` (the awaited durable
  enqueue — dead-phone plan F8's number, incl. attachment grants), `total`.
- **`send1v1` per-member threshold 120→40ms** — at 120 it never fired on
  device (B-285): legs sat under it while their sum did not.
- Pins: `recvLatProbe.test.ts` (8 scans: probe presence, qdepth sampled at
  arrival, recvPerf into BOTH handleIncoming calls, stamp ordering inside the
  txn closure, the 40ms threshold ratchet) + 3 behavioural `chainPendingCount`
  cases in `receiveTransaction.test.ts`. The AUDIT #12 frame-threading pin was
  re-pointed (same contract, new block anchor), not deleted.

**The device capture (do next, on the founder's Redmi + one second real phone;
release APK; never BlueStacks for the wake lane; swipe-kill never Force-stop):**

```bash
adb logcat -s ReactNativeJS | grep -E "send\.total|send\.group|send\.1v1|recv\.total|send1v1|NOTIFLAT|NOTIFHEALTH|MSGSTAT|LAGDIAG"
```

Protocol, one session: (1) both phones foreground, 20 single 1:1 sends spaced
~3s — pairs `[send.total]`/`[send.1v1]` on A with `[recv.total]` on B; (2) a
10-fast-send burst A→B — watch B's `qdepth`/`chainWait` climb (DL-1's number);
(3) 5 posts into a real dept channel — `[send.group]` `waveMs` vs `members`;
(4) B screen-off 3 min, then A sends — the DL-2/B-692 wake lane, read
`[NOTIFLAT]`; (5) B swipe-killed, A sends — closes the owed B-352/B-692 S-0
pass. Output: the §3 ledger's "previous" column for DL-1/DL-3/DL-7 filled with
real numbers, and the fix order beneath F-0 becomes number-driven.

> **BUILD STATUS 2026-08-29 (founder override of the number-gate):** the founder
> directed "build the rest step by step with critic loop; we will test after all
> the fixes are done." F-2, F-3 (+ the retrying… affordance), F-4 and F-5's
> client half are BUILT (see each item); F-1 remains measurement-gated, F-6
> stays wontfix-unless-measured, F-7 landed via the parallel B-692 session, and
> the two ARCH-GATED items (F-5 server half, F-2 server fan-out) still await an
> explicit architecture decision — a blanket "build the rest" is not consent to
> touch the sealed-sender contract. Critic loop: round-1 REJECT (P0: the first
> F-2 cut gated waves on network settle — head-of-line blocking + a widened
> P0-N4 crash-loss window) → reshaped to staggered-launch → round-2 review.
> **Baseline caveat (critic P1-1):** probes and fixes ship in ONE build, so the
> pre-fix "previous" for the fixed paths is only recoverable as a v1.0.267 ↔
> new-build interleaved A/B (two-device wall-clock + server bracket on v267;
> full probe splits on the new build). The §3d targets are the judged numbers.

### F-1 (P0, gated on F-0 numbers) — make the receive chain cheap and fair

In leverage order, smallest first:

- Confirm nothing new crept onto the pre-chain path (unwrap + cert verify are
  outside the chain today — pin that with a scan if F-0 confirms the chain
  dominates).
- Profile the in-txn decrypt: W5 made digests native; if the ratchet's remaining JS
  cost dominates, that is the B-688 arch item (native libsignal) — escalate, do not
  hand-roll.
- Chain-B contention under send bursts: the receive frame holds the global chain
  and then awaits the per-conversation write chain (`applyDirectText.ts:93`,
  `applyGroupText.ts:140` → `chainOp`), which a fast-send burst's 50ms coalesced
  flush (`upsertCoalesced`, `sqlMessageStore.ts:155-183`) also occupies — measure
  the flush's hold time under a burst; if it crowds inbound decrypts, options are
  smaller flush batches or yielding between rows. **Never invert the lock order
  (M14: global chain first, finer second) and never put the coalesced flush back
  on the global chain — that undoes the B-130 fix.**
- Backup-enabled accounts: the mirror encrypt + ~0.8s Merkle root are JS-thread
  CPU, not chain frames — if F-0 shows them co-timed with receive stalls, the fix
  conversation is chunking/yielding inside backup, owned by BACKUP_LOOP.
- Do NOT parallelize the chain itself (M14/B-130 territory; serialization is the
  correctness spine — make each slot cheaper instead).

### F-2 (P1) — group fan-out: take the N× off the sender's hot path

- Yield between `sendOne` CPU sections (chunked `allSettled` waves with
  `await Promise.resolve()` / `setImmediate` between chunks) so a 30-member post
  stops starving the UI thread — cheap, no wire change.
- Batch the 2N outbox writes into one SQLCipher txn per fan-out (today:
  per-member). **Constraint (critic):** an explicit BEGIN on this connection must
  ride `runWithRatchetTxn` (the P0-1 doctrine, `sqlCipherStore.ts:180-186`) —
  i.e. the batched enqueue takes a global-chain slot on the send path, and must
  complete before the first `relay.send` to keep the crash-safety story; the
  crypto-failure deferred rows (`:3934-3955`) enqueue per-member and cannot join
  it, and the N `markDelivered`s are per-response and cannot batch at all. Weigh
  that slot against DL-1 before building.
- ARCH-GATED, do not do unilaterally: a true sender-key / server fan-out redesign
  (one POST, relay splits) changes the sealed-sender topology and the relay's
  blindness contract — CLAUDE.md stop-condition. Name it, cost it, escalate.

### F-3 (P1) — kill the silent outbox stall

Immediate-kick-on-up-edge is **already built** (WS connected / NetInfo / foreground
all drain unthrottled — DL-4). What is genuinely new:

- Surface it: a bubble in 'sending' > 5s gets a subtle "retrying…" affordance so
  slow ≠ broken (design-system rules apply; NAV loop if tappable).
- Consider halving the early backoff rungs (1s, 2s, 8s, 30s, 2min) and/or dropping
  the quiet-socket periodic timer 60s → 30s — number-gate on F-0 showing this
  class in real traces, and argue against OM-07's flap-storm rationale explicitly
  if touching the budgets.

### F-4 (P1) — shrink half-dead-socket blindness on BOTH ends

The known-disconnected fast-fail **already exists** (`client.ts:397-400` throws
sync → instant HTTP fallback `:4601-4607`) — do not re-build it. What's left:

- **Sender, half-dead fd:** race the WS send against a short HTTP fallback instead
  of waiting the full `max(5s, 4×RTT)` watchdog. The double-submit IS dedup-safe —
  `envelope.service.ts:157-162` names exactly this WS-timeout/HTTP-fallback pair,
  atomic SET NX on (recipient, clientMsgId) — **but** the dedup early-return
  (`:170-187`) precedes the submitter-map write (`:294`): if the raced HTTP submit
  wins, no submitter mapping is written, that 1:1 send gets no
  `envelope.delivered` push, and its ✓✓ falls to the 60s receipt poll —
  manufacturing more of DL-6. Ship only paired with F-5's client-side poll
  triggers (or an identity-free receipt event). Cheaper variant: drop the watchdog
  floor 5s → 2-3s; number-gate on F-0 RTT data.
- **Idle recipient (DL-2):** the levers are server-side ping cadence (30s → e.g.
  15s costs battery — needs a deliberate trade-off decision), the reconnect
  ladder's first rungs, and honesty about the fact that FCM (B-692 lane) is the
  real path for a Dozed phone — which is why B-692 S-1/S-4 matter to _delivery_,
  not just banners. No unilateral change here; bring numbers to the founder.

### F-5 (P2) — group ✓✓ honesty: faster poll now, receipt push ARCH-GATED

**The server half is ARCH-GATED — do not build it unilaterally.** Recording
`envelopeId → submitter` for HTTP submits violates the sealed-sender decision
documented twice in the relay (`envelope.controller.ts:100-103` "the server must
not link the stored envelope to the submitter"; `envelope.service.ts:279-283`
OM-03 "Sealed Sender forbids recording WHO submitted") — for a group post it
would hand the relay a queryable sender→all-N-recipients edge set per message.
Escalate with an identity-free alternative on the table (e.g. a receipt-slot
event keyed on the retract-token hash the sender already holds).

**The safe client half, do first:** add receipt-poll triggers on **chat-open
(visible conversation only) and app-resume** — verified today's only two sites
are WS-connected (`:1586`) and the 60s timer (`:2357`). Note the reconcile is
capped at 100 probes per tick (`:2355-2357`), so a large fan-out's ✓✓ trickles
across successive polls either way.

### F-6 (P2) — 1:1 outbox enqueue off the critical path

Today: durable enqueue awaited before the WS write. Options: (a) keep (reliability
first) and just measure it; (b) enqueue and network-write concurrently, reconcile
on ack. (b) must not weaken the crash-safety story — if F-0 shows the enqueue is
<20ms on device, close as wontfix.

### F-7 (P3) — perception fixes ride with B-692

In-app banner + receive sound (B-692 S-3), per-message alert dedupe (S-2),
entrance animation for delayed bubbles (S-6). Listed for completeness; owned there.

---

## 5. Dead ends — do not re-propose (with sources)

1. Parallelizing the receive txn chain — B-130/M14 family; serialization is the
   correctness spine. Make slots cheaper, never concurrent.
2. Deferring lists to `runAfterInteractions` — measured 2× worse (B-279).
3. GPU/shadow/gradient "optimizations" — GPU measured idle twice (B-279).
4. Putting `conversationId` on the push wire / client-side group resolution from
   sender id — arch-gated topology disclosure (B-324, B-692 dead-end #7).
5. Shipping `senderName`/plaintext in pushes — N-15.
6. Weakening `verifySenderCert`/`verifySealedAad`/membership gates to save time —
   CLAUDE.md stop-condition, non-negotiable.
7. Trusting relay `sent=1/1` as "recipient rendered" — B-336 lesson.
8. Diagnosing push on BlueStacks / after Force-stop — tokens reaped ~90s /
   FCM-blocked by Android design.
9. "The Merkle loop steals the thread" — the pre-flip walk is DEAD (B-687 flip,
   device-proven); do not re-blame it without new logs.
10. Un-gating notifications from COMMIT (M16) — banner-before-commit shipped a
    ghost-notification class; stays gated.

---

## 6. Invariants any fix on this surface must respect

- **M3**: `sendText` never exits above the optimistic append (mutation-proved pins).
- **M14**: lock order `txnChain` → finer, everywhere. B-130's family has shipped
  four times.
- **M16**: message-content notifications gate on COMMIT, both directions.
- **M8/M9**: N envelopes → N rows; append + upsert same-txn; ack after COMMIT.
- Sealed-sender shape, AAD binding, cert verify order, group master-key
  distribution: **stop-conditions** — architecture approval required.
- `productionRuntime.ts` has no importing test — every change there rides the
  MESSAGE_LOOP §5 caller sweep + §7 gates (crypto suite TWICE, B-126 flake rule)
  - §8 device smoke. Line numbers in this doc rot — re-grep.
- Backup coupling: every status flip calls `notifyBackupDirty` — a fix that flips
  ticks more often multiplies mirror traffic (BACKUP_LOOP applies).
- NAV loop for any new tappable surface (retry affordance in F-3).

## 7. Related open items this plan should ride with

- **B-692 S-0..S-7** — the notification half; F-0's device session should capture
  both docs' probes in one pass.
- **B-352 device pass** — owed since 2026-08-01; same session.
- **Dead-phone plan F8** — per-send SQLCipher write instrumentation = F-0/F-6.
- **B-688** (native crypto arch review) — the structural answer if F-0 shows the
  ratchet dominating DL-1.
- **Notifications inbox migration** (GAP-3) — written, never applied; the durable
  answer to lost wakes.
- Owed device checks from W1-W5: killed-app notification icon, agency-map open.
