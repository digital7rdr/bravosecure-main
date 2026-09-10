# SRV-02 - Replayed call offers are unanswerable: the Redis offer drain never re-registers the in-memory call session

## Verdict

**CONFIRMED** (mechanism exactly as described; one line-number drift, and the audit's proposed
fix is heavier than necessary — see §Fix).

Evidence from the current tree (`apps/messenger-service/src/gateway/messenger.gateway.ts`, 2784 lines):

1. `:252` — `private readonly callSessions = new Map<string, CallSession>();`, documented at `:242`
   as _"The map is in-memory only (1:1 sessions are short-lived and a gateway restart legitimately
   ends the call anyway)."_ That premise is now false: the offer itself survives the restart.
2. `:1210-1215` (offer path) — `const trackErr = this.trackCallStart(client, data.callId, …)` is the
   **only** writer of `callSessions`. It is never called from the replay path.
3. `:551-620` `deliverPendingCallOffer` — reads the Redis payload and at `:609-618` does
   `client.emit('call.offer', {callId: parsed.callId, from: parsed.from, sdp: parsed.sdp, kind: parsed.kind, auth: parsed.auth})`
   with **no** `trackCallStart` / `callSessions.set` anywhere in the function.
4. `:2414-2419` `authorizeCallFrame` — `const session = this.callSessions.get(callId); if (!session || session.state === 'ended') { … return {ok: false, ignore: true}; }`.
5. `:1314-1317` `handleCallAnswer` — `const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId); if (auth.ok === false) { if ('ignore' in auth) return undefined; … }` → the answer returns
   `undefined`, is never forwarded, and the caller is told nothing.
6. The offer _is_ durable across the restart: `:1263-1281` writes `pendingOfferKey` with `'EX', 45`
   plus the index and the 6h missed-marker, and `handleConnection` calls
   `void this.deliverPendingCallOffer(client, {userId: claims.sub, deviceId: signalDeviceId});` (`:540`).
7. Single container (`docker-compose.yml` `container_name: bravo-messenger-service`, no `replicas`)
   confirms the live trigger is **process restart**, not cross-pod split — and staging redeploys
   messenger-service on every push to `main`.

Client side confirms it fails silently: `src/modules/messenger/webrtc/signallingClient.ts:276-290`
`sendAnswer` is `void enqueueForCall(... waitOpenThenSend('call.answer', …))` — no ack, no retry
once the frame reaches the socket. The callee sits at "Answering…" until its 20s watchdog while the
caller keeps ringing to the 45s timeout.

## Mechanism

1. A rings B. `handleCallOffer` calls `trackCallStart` → `callSessions[callId] = {state:'ringing', caller:A, callee:B}`
   (in-memory), forwards the offer, and — per N-01, _unconditionally_ — persists
   `pending-call-offer:{B.user}:{B.dev}:{callId}` (45s), the missed-marker (6h), the index entry, and
   fires the VoIP wake.
2. The messenger-service process restarts (staging auto-deploy, crash, OOM, `docker compose up`).
   `callSessions` is gone. Redis is a separate container, so the pending offer survives.
3. Both sockets drop and reconnect. B's `handleConnection` → `deliverPendingCallOffer` finds the
   payload, sees `ageSec <= 45`, and re-emits `call.offer` verbatim (S7 auth block included).
   **No session is created.** B's UI rings (or keeps ringing).
4. B taps Answer → `call.answer` reaches the gateway → `authorizeCallFrame` finds no entry for
   `callId` → `{ok:false, ignore:true}` → `handleCallAnswer` returns `undefined`. The frame is
   dropped on the floor. Every subsequent `call.ice`, `call.hangup`, `call.mediaState`,
   `call.reoffer`, `call.reanswer` for that callId is dropped by the same gate.
5. Neither side is told. B watchdogs at 20s ("Could not connect"); A rings to the 45s ceiling. The
   offer was replayed, so it is a _ghost ring_: it looks answerable and never is.

Secondary (independent of restart): even with a live session, `handleCallAnswer` →
`forwardToDevice` → `hub.deviceIsOnline(A)` returns false during A's own reconnect blip → the answer
is returned as `peer_offline` and discarded. There is no answer queue symmetric to the offer queue.

## Fix

Three increments. **Increment 1 is the fix for the finding as written**; 2 closes the residual
caller-blip race; 3 is optional and flagged.

Deliberately **not** doing what the audit proposed (persisting ringing-session state in Redis): the
pending-offer record _already_ contains `callId`, `from` (= caller `{userId, deviceId}`), and the
drain already knows `address` (= callee `{userId, deviceId}`). Every field the session needs is
already persisted. Adding a parallel Redis session key would add new server-side call state — which
the batch architecture ruling flags as **NOT-COVERED / needs human approval**
(`SIGNAL_PROTOCOL_IMPLEMENTATION.md`: _"Calls (call_id/participants/state) — no dedicated table …
live state ephemeral"_). Deriving the in-memory session from state that is already persisted needs
no new key, no new TTL, no approval, and is a ~15-line diff. **`archGated: false`.**

---

### File 1 (only production file): `apps/messenger-service/src/gateway/messenger.gateway.ts`

#### 1a. New helper — insert directly after `trackCallStart` (before `authorizeCallFrame`)

Anchor (verbatim, end of `trackCallStart`):

```ts
    let owned = this.socketCalls.get(client);
    if (!owned) { owned = new Set(); this.socketCalls.set(client, owned); }
    owned.add(callId);
    return undefined;
  }

  /**
   * Verify the sender of a `call.*` frame is a participant in the
```

Insert between `return undefined;\n  }` and the `/** Verify the sender …` comment:

```ts
  /**
   * SRV-02 — re-create the in-memory session for an offer replayed out of
   * Redis on reconnect. `callSessions` dies with the process but the queued
   * offer does not, so without this a ring replayed after a gateway restart
   * (staging redeploys on every push) can never be answered:
   * `authorizeCallFrame` sees an unknown callId and silently drops the
   * `call.answer`. Every field comes from the persisted offer, so no new
   * server-side call state is introduced.
   *
   * Returns false when the callId is a live tombstone — the caller already
   * hung up, so the offer must NOT be replayed at all.
   *
   * Why: the session is intentionally NOT linked into `socketCalls`. Linking
   * it would make a post-replay socket flap fire an immediate `call.hangup`
   * at the caller (ringing sessions get the un-graced bye), killing a call
   * the callee is still ringing for. `trackCallAnswer` links the socket at
   * answer time, which is the normal flow.
   */
  private rehydrateCallSession(
    callId: string,
    caller: {userId: string; deviceId: number},
    callee: {userId: string; deviceId: number},
  ): boolean {
    this.gcCallTombstones();
    const existing = this.callSessions.get(callId);
    if (existing) return existing.state !== 'ended';
    this.callSessions.set(callId, {
      callId, caller, callee,
      state: 'ringing', createdAt: Date.now(),
    });
    return true;
  }
```

#### 1b. Call it from the replay loop

Anchor (verbatim, in `deliverPendingCallOffer`):

```ts
      records.sort((a, b) => a.at - b.at);
      for (const parsed of records) {
        const ageSec = (Date.now() - parsed.at) / 1000;
        this.logger.log(`replay pending offer cid=${parsed.callId.slice(0, 8)} → ${address.userId.slice(0, 8)}/${address.deviceId} age=${ageSec.toFixed(1)}s`);
```

Replacement:

```ts
      records.sort((a, b) => a.at - b.at);
      for (const parsed of records) {
        const ageSec = (Date.now() - parsed.at) / 1000;
        if (!this.rehydrateCallSession(parsed.callId, parsed.from, address)) {
          this.logger.log(`skip replay of ended cid=${parsed.callId.slice(0, 8)}`);
          continue;
        }
        this.logger.log(`replay pending offer cid=${parsed.callId.slice(0, 8)} → ${address.userId.slice(0, 8)}/${address.deviceId} age=${ageSec.toFixed(1)}s`);
```

Nothing else in the drain changes. No wire change, no Redis key change, no schema change.

---

#### 2a. Pending-answer map — declare next to `callDisconnectGrace`

Anchor (verbatim):

```ts
  private readonly callDisconnectGrace = new Map<string, {timer: ReturnType<typeof setTimeout>; userId: string; deviceId: number; peer: {userId: string; deviceId: number}; callId: string}>();
  private static readonly CALL_DISCONNECT_GRACE_MS = 12_000;
```

Append after it:

```ts
  /**
   * SRV-02 — `call.answer` frames whose target (the CALLER's device) was not
   * in its room at forward time, keyed by `callGraceKey(callId, caller)`.
   * A deploy drops both sockets; the callee can reconnect, drain the replayed
   * offer and accept before the caller's socket is back, and the answer is
   * then discarded as `peer_offline` with no retry on either side
   * (`signallingClient.sendAnswer` is fire-and-forget). Held briefly and
   * flushed by `handleConnection`. In-memory for the same reason as
   * `callSessions`: single-replica deploy, and a restart in this window
   * legitimately ends the call.
   */
  private readonly pendingAnswers = new Map<string, {frame: ServerCallAnswer['data']; timer: ReturnType<typeof setTimeout>}>();
  private static readonly PENDING_ANSWER_TTL_MS = 15_000;
```

(`ServerCallAnswer` is already imported — it is used as the return type of the `buildFrame` closure
in `handleCallAnswer`.)

#### 2b. Queue on `peer_offline` in `handleCallAnswer`

Anchor (verbatim, tail of `handleCallAnswer`):

```ts
    void this.clearPendingCallArtifacts(ctx.claims.sub, ctx.signalDeviceId, data.callId);
    return this.forwardToDevice(client, data.to, false, (from): ServerCallAnswer => ({
      event: 'call.answer',
      data:  {callId: data.callId, from, sdp: data.sdp},
    }));
  }
```

Replacement:

```ts
    void this.clearPendingCallArtifacts(ctx.claims.sub, ctx.signalDeviceId, data.callId);
    const forwarded = await this.forwardToDevice(client, data.to, false, (from): ServerCallAnswer => ({
      event: 'call.answer',
      data:  {callId: data.callId, from, sdp: data.sdp},
    }));
    if (forwarded && forwarded.data.code === 'peer_offline') {
      this.queuePendingAnswer(data.to, {
        callId: data.callId,
        from:   {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},
        sdp:    data.sdp,
      });
      return undefined;
    }
    return forwarded;
  }
```

Note the queued frame is byte-identical to the live one (`data.auth` is dropped by the existing
live path too — see §Risk; do **not** "fix" that here).

#### 2c. Queue/flush helpers — insert after `cancelCallDisconnectByes`

Anchor (verbatim):

```ts
  /** P1-BR-5 — cancel every deferred bye owned by this (user, device). */
  private cancelCallDisconnectByes(userId: string, deviceId: number): void {
    for (const [key, v] of this.callDisconnectGrace) {
      if (v.userId === userId && v.deviceId === deviceId) {
        clearTimeout(v.timer);
        this.callDisconnectGrace.delete(key);
      }
    }
  }
```

Insert after it:

```ts
  /**
   * SRV-02 — hold an answer for a caller device that was mid-reconnect. One
   * slot per (callId, caller device); a re-sent answer replaces the previous
   * one. The TTL timer bounds the map so it cannot grow on a caller that
   * never returns.
   */
  private queuePendingAnswer(
    to:    {userId: string; deviceId: number},
    frame: ServerCallAnswer['data'],
  ): void {
    const key = callGraceKey(frame.callId, to.userId, to.deviceId);
    const prev = this.pendingAnswers.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => this.pendingAnswers.delete(key), MessengerGateway.PENDING_ANSWER_TTL_MS);
    (timer as unknown as {unref?: () => void}).unref?.();
    this.pendingAnswers.set(key, {frame, timer});
    this.logger.log(`[CALL] answer queued for reconnecting caller cid=${frame.callId.slice(0, 8)} → ${to.userId.slice(0, 8)}/${to.deviceId}`);
  }

  /** SRV-02 — deliver answers queued while this device was reconnecting. */
  private flushPendingAnswers(client: Socket, address: {userId: string; deviceId: number}): void {
    const suffix = `::${address.userId}::${address.deviceId}`;
    for (const [key, entry] of this.pendingAnswers) {
      if (!key.endsWith(suffix)) continue;
      clearTimeout(entry.timer);
      this.pendingAnswers.delete(key);
      const session = this.callSessions.get(entry.frame.callId);
      if (!session || session.state === 'ended') continue;
      client.emit('call.answer', entry.frame);
      this.logger.log(`[CALL] answer flushed cid=${entry.frame.callId.slice(0, 8)} → ${address.userId.slice(0, 8)}/${address.deviceId}`);
    }
  }
```

#### 2d. Flush on connect

Anchor (verbatim, in `handleConnection`):

```ts
// P1-BR-5 — a reconnect within the disconnect-grace window cancels any
// deferred bye for this (user, device) so a live call survives a brief blip.
this.cancelCallDisconnectByes(claims.sub, signalDeviceId);
```

Replacement:

```ts
// P1-BR-5 — a reconnect within the disconnect-grace window cancels any
// deferred bye for this (user, device) so a live call survives a brief blip.
this.cancelCallDisconnectByes(claims.sub, signalDeviceId);
// SRV-02 — deliver any call.answer that arrived while this device was down.
this.flushPendingAnswers(client, {userId: claims.sub, deviceId: signalDeviceId});
```

#### 2e. Clear timers on teardown (Jest open-handle hygiene, mirrors the existing line)

Anchor (verbatim, in `onModuleDestroy`):

```ts
for (const {timer} of this.callDisconnectGrace.values()) clearTimeout(timer);
this.callDisconnectGrace.clear();
```

Replacement:

```ts
for (const {timer} of this.callDisconnectGrace.values()) clearTimeout(timer);
this.callDisconnectGrace.clear();
for (const {timer} of this.pendingAnswers.values()) clearTimeout(timer);
this.pendingAnswers.clear();
```

---

### 3. OPTIONAL — purge the callee's queued offer on an `ignore`d hangup

Residual after 1+2: if the **caller** gives up during the window where its own `call.hangup` is
dropped by `authorizeCallFrame` (restart, callee not yet reconnected), the Redis offer is never
purged and the callee still gets a live ghost ring up to the 45s TTL.

Anchor (verbatim, in `handleCallHangup`):

```ts
const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
if (auth.ok === false) {
  if ('ignore' in auth) return undefined; // duplicate / late hangup — ack silently
  console.warn(
    `[CALL] HANGUP rejected cid=${data.callId.slice(0, 8)} ${auth.err.data.code} (third-party hangup attempt blocked)`,
  );
  return auth.err;
}
```

Replacement:

```ts
const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
if (auth.ok === false) {
  if ('ignore' in auth) {
    // SRV-02 — the session may simply have been lost to a restart. Purge
    // the target's queued offer (keeping the missed-marker) so the ring
    // the caller just abandoned cannot still be replayed on reconnect.
    void this.clearPendingCallArtifacts(data.to.userId, data.to.deviceId, data.callId, {
      keepMarker: true,
    });
    return undefined;
  }
  console.warn(
    `[CALL] HANGUP rejected cid=${data.callId.slice(0, 8)} ${auth.err.data.code} (third-party hangup attempt blocked)`,
  );
  return auth.err;
}
```

Trade-off to weigh before shipping: this gives an authenticated client a side effect on an _unknown_
callId (it can delete `pending-call-offer:{to}:{callId}` for any callId it names). callIds are
client-minted UUIDs and unguessable, and the only effect is dropping a ring the attacker would have
to already know about, so the exposure is negligible — but it _is_ a new side-effect on a frame the
participant gate rejected. If a reviewer objects, drop increment 3; increments 1+2 stand alone.

### Back-compat / wire format

No wire change at all. No new frame, no new field, no field removed, no Redis key or TTL change, no
DB/SQLCipher schema, no client change. Old clients get the exact same `call.offer` bytes they get
today and their `call.answer` starts working. Server can ship ahead of clients (which is the
deployment order). Nothing is required of the mobile app.

## Blast radius

- **File touched:** `apps/messenger-service/src/gateway/messenger.gateway.ts` only.
- **Functions changed:** `deliverPendingCallOffer` (1 guard), `handleCallAnswer` (tail),
  `handleConnection` (1 call), `onModuleDestroy` (2 lines), `handleCallHangup` (increment 3 only).
  **New:** `rehydrateCallSession`, `queuePendingAnswer`, `flushPendingAnswers`.
- **Read-only dependents of `callSessions`** now see entries they did not before:
  `authorizeCallFrame` (intended), `trackCallAnswer`, `trackCallEnd`, `gcCallTombstones`,
  `scheduleCallDisconnectBye`, `handleDisconnect`'s `socketCalls` loop, and `handleCallHangup`'s
  `pre`/`wasRinging`/`isCaller` read. The `handleDisconnect` loop is the one to watch — it is driven
  by `socketCalls`, which `rehydrateCallSession` deliberately does **not** write, so the new sessions
  are invisible to it until a real `trackCallAnswer`. Verify that in review.
- **`handleCallHangup` after a replay** now takes the authorized branch: `wasRinging === true` and
  `isCaller` is computed against the rehydrated `caller`, so a caller giving up correctly keeps the
  missed-marker and a callee decline correctly drops it. This is a _behaviour restoration_, not a
  new path, but it means Redis writes now happen where previously nothing happened.
- **Memory:** `callSessions` grows by at most one entry per replayed offer, GC'd by the existing
  60s tombstone sweep once ended; `pendingAnswers` is bounded by its 15s TTL timer.
- **Overlapping findings:**
  - **SRV-03** edits the _same_ `deliverPendingCallOffer` function (destructive drain →
    peek/emit/remove). Land these two together or sequence SRV-02 first; SRV-03 must keep the
    `rehydrateCallSession` call _before_ the emit and must not remove the ended-tombstone `continue`.
  - **NA-05** (client-side answer re-send on reconnect) is the mobile mirror of increment 2. If both
    land, a duplicate `call.answer` can arrive; that is already tolerated (`trackCallAnswer` is
    idempotent, and `useCall`'s accept-dedupe drops the second at the caller). Worth a joint smoke.
  - **NA-01** (FCM bg-wake clobbering the SDP cache) is the _other_ cause of the same user symptom;
    fixing SRV-02 alone will not make "Answering…" disappear from device logs.
  - **SRV-06** (VoIP wake pair-budget) shares `handleCallOffer` but not these lines.
- **Regression candidates:** a replayed offer for a call that ended during the drain now emits
  nothing instead of a ghost ring — verify no client relies on the ghost `call.offer` to render a
  missed-call row (it does not: the `call.missed` marker path at `:596-601` is the missed-call
  source). Nothing in the `messenger-crypto` / `app` / `booking` Jest projects touches the gateway.

## Tests

Add to the existing call-lifecycle spec — same prototype-with-hand-built-`this` harness, same file
that already covers `clearPendingCallArtifacts` / `handleCallOffer`:

**`apps/messenger-service/src/gateway/messenger.gateway.calls.spec.ts`** — new
`describe('SRV-02 — replayed offers are answerable')`:

Harness: `self = {redis:{client:{smembers,get,del,srem}}, logger:{log:jest.fn(),warn:jest.fn()}, callSessions: new Map(), gcCallTombstones: proto.gcCallTombstones, rehydrateCallSession: proto.rehydrateCallSession}`
bound with `.call(self, …)` (bind the two helpers onto `self` so `this` resolves).

1. `deliverPendingCallOffer` with one fresh (`at: Date.now()`) payload and an EMPTY `callSessions`
   → asserts `self.callSessions.get('call-1')` equals
   `{callId:'call-1', caller:{userId:'A',deviceId:1}, callee:{userId:'B',deviceId:7}, state:'ringing', createdAt: expect.any(Number)}`
   and `client.emit` was called with `'call.offer'`.
2. **The regression the finding is about:** after (1), `proto.handleCallAnswer.call(answerSelf, {callId:'call-1', to:{userId:'A',deviceId:1}, sdp:'v=0'}, fakeClient('B',7))`
   using the SAME `callSessions` map → `forwardToDevice` **was** called with `{userId:'A',deviceId:1}`.
   Assert the pre-fix behaviour fails: with an empty map, `forwardToDevice` is NOT called and the
   return is `undefined`.
3. Existing live session is not clobbered: seed `callSessions` with `state:'active'`, run the drain
   → the entry still reads `state:'active'` and `createdAt` is unchanged.
4. Tombstone: seed `{state:'ended', endedAt: Date.now()}` → `client.emit` is NOT called with
   `'call.offer'` for that callId, and the map entry stays `'ended'`.
5. `socketCalls` untouched: after the drain, `self.socketCalls` (a real `WeakMap`) has no entry for
   the callee socket — pins the "no new disconnect-bye path" invariant from §Fix 1a.
6. Increment 2 — `handleCallAnswer` with `forwardToDevice: jest.fn(async () => ({event:'error', data:{code:'peer_offline', message:'x'}}))`
   → returns `undefined` (no error leaked to the callee) and `queuePendingAnswer` called with
   `({userId:'A',deviceId:1}, {callId:'call-1', from:{userId:'B',deviceId:7}, sdp:'v=0'})`.
   A non-`peer_offline` error is still returned verbatim.
7. Increment 2 — `flushPendingAnswers` with a live session emits `call.answer` once and deletes the
   map entry; with an `ended` session it emits nothing but still deletes; a key for a _different_
   device is left untouched.
8. Increment 3 (if kept) — `handleCallHangup` on an `ignore` verdict calls
   `clearPendingCallArtifacts(data.to.userId, data.to.deviceId, callId, {keepMarker:true})` and still
   returns `undefined`.

Commands:

- Targeted: `cd apps/messenger-service && npx jest src/gateway/messenger.gateway.calls.spec.ts`
- Regression: `cd apps/messenger-service && npm test` (whole service suite — `privacy`,
  `sfu-*`, `calls`, `envelope.*` all exercise the gateway prototype).
- `cd apps/messenger-service && npm run typecheck`.
- Mobile gates are untouched but run `npm run typecheck` at root to confirm the 47 baseline is
  unmoved (no mobile file changes, so it must be identical).

Device probe (cannot be automated here): A calls B (B backgrounded); while ringing,
`docker compose restart messenger-service` on staging; B answers → media must connect. Pre-fix this
hangs at "Answering…". Second probe: same, but delay B's answer until _after_ confirming A's socket
is down (`redis-cli` presence) to exercise increment 2.

## Risk

- **What a reviewer should be suspicious of #1:** the deliberate omission of `socketCalls` linkage in
  `rehydrateCallSession`. It is a real asymmetry with `trackCallStart` and looks like an oversight.
  It is not — linking would make a post-replay socket flap send an immediate
  `call.hangup{reason:'failed'}` to the caller (ringing sessions skip the 12s grace at
  `handleDisconnect`), killing calls that work today. Test 5 pins it.
- **#2: increment 3 gives an unauthorized frame a side effect.** See the trade-off note; it is the
  weakest part of this spec and is severable.
- **#3: `handleCallAnswer` drops `data.auth`.** The current live path builds
  `{callId, from, sdp}` and never forwards the P1-C3 `CallControlAuthBlock` the client sends
  (`protocol.ts:184-192` vs `:445-451`). That is a **separate defect** — probably worth its own
  finding — and this spec deliberately preserves the existing (broken) behaviour so the queued
  answer is byte-identical to the live one. Do not "fix" it inside SRV-02: starting to send `auth`
  could flip clients from legacy fallback into strict verification mid-rollout.
- **#4: scope honesty.** This fixes the _replayed-ring_ case, which is the finding as written. It
  does **not** restore sessions for calls that were already `active` at restart — those keep losing
  `call.ice`/`call.hangup`/`call.mediaState` to the same `ignore` gate and fall back to ICE
  timeouts. A general fix needs the audit's Redis-persisted session, which the batch architecture
  ruling marks NOT-COVERED / needs approval (`SIGNAL_PROTOCOL_IMPLEMENTATION.md` "live state
  ephemeral"). Recommended follow-up, not this change. The tempting cheap alternative — rehydrating
  from `(sender, data.to)` on any unknown-callId `call.*` frame — is **forbidden**: it destroys
  `authorizeCallFrame`'s participant pinning (CLAUDE.md "Never weaken transitions").
- **#5: 15s `PENDING_ANSWER_TTL_MS` is a guess** bounded by the client's 20s connecting watchdog
  (`signallingClient.ts` / `useCall`). If the client watchdog changes, this must follow.
- **Security posture unchanged:** no crypto, no AAD, no sender-cert, no sealed-sender, no vault MFA,
  no dwell semantics, no envelope IDs touched. The S7 offer-auth block is still forwarded verbatim
  and still verified end-to-end by the callee. No new logging of plaintext or key bytes (all new log
  lines use 8-char id prefixes, matching the existing PII rule).
