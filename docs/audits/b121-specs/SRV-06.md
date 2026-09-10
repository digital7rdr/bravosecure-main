# SRV-06 - VoIP wake pair-budget is charged for undeliverable and duplicate wakes, so legitimate redials go silently unwoken

## Verdict

**CONFIRMED-WITH-DRIFT** — the mechanism is exactly as described; the audit's _proposed fix_
("key the budget on (sender, recipient, callId)") is wrong as literally written and is corrected below.

Evidence from the current tree:

1. `apps/messenger-service/src/push/push.service.ts:980` — the charge is the **first** statement of
   `sendVoipWake`, before token lookup, before the FCM-readiness check:
   `const budget = await this.consumeVoipWakeBudget(senderUserId, userId);`
   followed by `push.service.ts:988` `const records = await this.loadUserTokenRecords(...)` and
   `push.service.ts:994` `if (!this.fcmReady) { ... return {sent: 0, stubbed: true}; }`.
   A recipient with **zero VoIP tokens**, or a box with FCM creds missing, burns a budget unit for a
   push that is never sent.
2. `push.service.ts:898` `const PAIR_CAP      = 6;` / `:899 const RECIPIENT_CAP = 30;` /
   `:900 const WINDOW_SEC    = 60;` — a fixed 60 s window, 6 per (sender → recipient).
3. `apps/messenger-service/src/gateway/messenger.gateway.ts:1232-1240` — N-01 comment:
   _"ALWAYS queue the offer + fire the VoIP wake, not only when the socket-room probe says
   peer_offline"_ — so **every** `call.offer` charges, including to a fully-online callee. Confirmed
   at `messenger.gateway.ts:1290` `void this.push.sendVoipWake(...)`.
4. The deny is discarded at both call sites: `messenger.gateway.ts:1293`
   `.catch(() => { /* swallow */ });` and `messenger.gateway.ts:1928` — the `{reason}` field
   `sendVoipWake` returns (`push.service.ts:973`) is never read. The only trace is
   `push.service.ts:982-985` `this.logger.warn('push.voip.budget-deny …')`.
5. `messenger.gateway.ts:1925-1928` — the **group** path calls
   `this.push.sendVoipWake(uid, data.roomId, callerId, roomToken || undefined, …)` inside the
   `for (const uid of targets)` loop, i.e. the callId **is the roomId**. A host re-ringing the same
   room spends a fresh unit per recipient per re-ring, even though FCM collapses them
   (`push.service.ts:1082` `collapseKey: \`voip-wake:${callId}\``) and the device dedupes by callId.

Drift vs. the audit text:

- **Redial does NOT reuse the callId.** `src/modules/messenger/webrtc/useCall.ts:874-875`:
  _"A genuine fresh dial mints a new callId"_, and `messenger.gateway.ts:2391` rejects a repeated
  callId outright (`duplicate_call_id`). So keying the budget on `callId` **cannot** help the
  "7th redial" case the audit names — 7 redials are 7 distinct callIds. Worse, giving each callId its
  own 6/min bucket (the literal reading of the audit's FIX) would delete the anti-spam perimeter,
  because an attacker mints a new callId per wake for free.
- The correct reading of the audit's intent is _charge once per distinct call_, which is what this
  spec implements, plus the two charges that are pure waste today (undeliverable wakes, duplicate
  same-call rings), plus a modest cap raise to actually cover the frantic-redialer case.

Mitigating context (state it in review, don't remove it): a throttled wake is **not** total loss —
`messenger.gateway.ts:1262-1279` still writes the 45 s `pendingOffer` and the 6 h
`missedCallMarker` before the wake fires, so a callee reconnecting inside 45 s still rings live and a
later reconnect still surfaces a missed call.

## Mechanism

1. Caller taps Call. `useCall` mints a **fresh** callId (`useCall.ts:874`) and
   `callController.startOutgoing` emits one `call.offer` (`callController.ts:472`).
2. `handleCallOffer` forwards, queues the pending offer + missed marker, then fires
   `sendVoipWake` fire-and-forget (`messenger.gateway.ts:1290`).
3. `sendVoipWake`'s **first** action is `consumeVoipWakeBudget(sender, recipient)`
   (`push.service.ts:980`). It reads `push-voip-budget:pair:<sender>:<recipient>`; if the count is
   already `>= 6` it returns `{ok:false, reason:'pair_budget_exhausted'}` and `sendVoipWake` returns
   `{sent:0, stubbed:false, reason}` — **no FCM/APNs push is dispatched**.
4. The unit is spent regardless of outcome:
   - callee fully online (WS live) → wake sent and charged, even though the WS frame already
     delivered the call;
   - callee has no VoIP token registered (fresh install, GC'd token) → charged, nothing sent;
   - `fcmReady === false` on the box → charged, nothing sent;
   - group re-ring of the same room (`callId === roomId`) → charged again per recipient, while FCM's
     `collapseKey` and the device's `bravo-call-<callId>` notifee id make it invisible.
5. So by the 7th genuine dial inside 60 s the pair bucket is exhausted. If the callee is now Dozed /
   killed, the wake is the **only** delivery path — and it is denied.
6. `messenger.gateway.ts:1293` swallows the result. The caller's UI stays in "calling…" until the
   45 s ring timeout (`callController.ts:476 this.ringState.armOutgoing`) and then records a
   missed-outgoing row. Neither party ever learns the wake was throttled; only
   `push.voip.budget-deny` in the container log shows it.

## Fix

Server-side only. **No wire-format change, no client change, no SQLCipher/Postgres schema change.**
Three orthogonal corrections + one log improvement:

- **F1** charge once per distinct call (bounded free retries) — kills the group re-ring waste;
- **F2** charge only when a wake is genuinely dispatchable — kills the no-token / FCM-down waste;
- **F3** raise the per-pair cap 6 → 10 (the recipient-wide 30/min ceiling is unchanged) — covers the
  frantic legitimate redialer;
- **F4** log the deny in the operator-facing `[CALL]` / `[SFU]` stream, not only in the push logger.

### File 1 — `apps/messenger-service/src/push/push.service.ts`

#### 1a. Constants (module scope)

Anchor (verbatim, current tree):

```ts
const VOIP_WAKE_TTL_SECONDS = 30;
const VOIP_WAKE_KEY_BYTES = 32;
```

Replace with:

```ts
const VOIP_WAKE_TTL_SECONDS = 30;
const VOIP_WAKE_KEY_BYTES = 32;
/**
 * Audit P0-C5 / SRV-06 — VoIP wake budget. Exported so the spec asserts the
 * boundary against the real constant instead of a copy.
 *
 * SRV-06 raised the pair cap 6 → 10: with the same-call dedupe and the
 * dispatchable-only charge below, every remaining unit is a DISTINCT,
 * genuinely deliverable call, and 6 was reachable by a caller redialing an
 * unresponsive peer — whose only delivery path, once Dozed, is this wake.
 * The recipient-wide cap is untouched and stays the hard ceiling.
 */
export const VOIP_WAKE_PAIR_CAP = 10;
export const VOIP_WAKE_RECIPIENT_CAP = 30;
const VOIP_BUDGET_WINDOW_SEC = 60;
/**
 * SRV-06 — extra wakes for a call this pair was ALREADY charged for, inside
 * the window. `sfu.ring` reuses the roomId as the callId, so a host re-ringing
 * a group used to spend one unit per recipient per re-ring; FCM collapses them
 * (`collapseKey: voip-wake:<callId>`) and the device dedupes on the notifee id
 * `bravo-call-<callId>`, so they were never separate rings. Bounded, not free:
 * past this count a same-callId loop charges again.
 */
const VOIP_WAKE_CALL_FREE_RETRIES = 3;

type VoipWakeDenyReason = 'pair_budget_exhausted' | 'recipient_budget_exhausted';
```

#### 1b. Split `consumeVoipWakeBudget` into peek + commit

Anchor (verbatim, current tree — the whole method body from the signature through its closing brace):

```ts
  async consumeVoipWakeBudget(
    senderUserId:    string,
    recipientUserId: string,
  ): Promise<{ok: true} | {ok: false; reason: 'pair_budget_exhausted' | 'recipient_budget_exhausted'}> {
    if (!senderUserId || !recipientUserId) {
      return {ok: false, reason: 'pair_budget_exhausted'};
    }
    const pairKey      = `push-voip-budget:pair:${senderUserId}:${recipientUserId}`;
    const recipientKey = `push-voip-budget:recipient:${recipientUserId}`;
    const PAIR_CAP      = 6;
    const RECIPIENT_CAP = 30;
    const WINDOW_SEC    = 60;

    const [pairCur, recipientCur] = await Promise.all([
      this.redis.client.get(pairKey),
      this.redis.client.get(recipientKey),
    ]);
    const pairCount      = pairCur      ? Number(pairCur)      : 0;
    const recipientCount = recipientCur ? Number(recipientCur) : 0;

    if (pairCount >= PAIR_CAP) {
      return {ok: false, reason: 'pair_budget_exhausted'};
    }
    if (recipientCount >= RECIPIENT_CAP) {
      return {ok: false, reason: 'recipient_budget_exhausted'};
    }

    // Admit and bump both counters. EXPIRE on first set so the bucket
    // rolls forward at most WINDOW_SEC after first use.
    const nextPair      = await this.redis.client.incr(pairKey);
    const nextRecipient = await this.redis.client.incr(recipientKey);
    if (nextPair      === 1) await this.redis.client.expire(pairKey,      WINDOW_SEC);
    if (nextRecipient === 1) await this.redis.client.expire(recipientKey, WINDOW_SEC);

    return {ok: true};
  }
```

Replacement (also update the two doc-comment lines above the method that say "6 wakes … per minute"
and "Consumed automatically inside `sendVoipWake`" — see note after the code):

```ts
  async consumeVoipWakeBudget(
    senderUserId:    string,
    recipientUserId: string,
    callId?:         string,
  ): Promise<{ok: true} | {ok: false; reason: VoipWakeDenyReason}> {
    const peek = await this.peekVoipWakeBudget(senderUserId, recipientUserId, callId);
    if (!peek.ok) return peek;
    if (peek.charge) await this.commitVoipWakeBudget(senderUserId, recipientUserId);
    return {ok: true};
  }

  /**
   * SRV-06 — the read half. Decides admit/deny AND whether this wake owes a
   * unit. Split from the write half so `sendVoipWake` can keep the cheap
   * perimeter deny first (before any token/FCM work) while charging only once
   * it knows a push is actually going out.
   */
  private async peekVoipWakeBudget(
    senderUserId:    string,
    recipientUserId: string,
    callId?:         string,
  ): Promise<{ok: true; charge: boolean} | {ok: false; reason: VoipWakeDenyReason}> {
    if (!senderUserId || !recipientUserId) {
      return {ok: false, reason: 'pair_budget_exhausted'};
    }
    if (callId) {
      const callKey = `push-voip-budget:call:${senderUserId}:${recipientUserId}:${callId}`;
      const seen = await this.redis.client.incr(callKey);
      if (seen === 1) {
        await this.redis.client.expire(callKey, VOIP_BUDGET_WINDOW_SEC);
      } else if (seen <= VOIP_WAKE_CALL_FREE_RETRIES + 1) {
        return {ok: true, charge: false};
      }
    }

    const pairKey      = `push-voip-budget:pair:${senderUserId}:${recipientUserId}`;
    const recipientKey = `push-voip-budget:recipient:${recipientUserId}`;
    const [pairCur, recipientCur] = await Promise.all([
      this.redis.client.get(pairKey),
      this.redis.client.get(recipientKey),
    ]);
    const pairCount      = pairCur      ? Number(pairCur)      : 0;
    const recipientCount = recipientCur ? Number(recipientCur) : 0;

    if (pairCount >= VOIP_WAKE_PAIR_CAP) {
      return {ok: false, reason: 'pair_budget_exhausted'};
    }
    if (recipientCount >= VOIP_WAKE_RECIPIENT_CAP) {
      return {ok: false, reason: 'recipient_budget_exhausted'};
    }
    return {ok: true, charge: true};
  }

  /**
   * SRV-06 — the write half. EXPIRE on first set so the bucket rolls forward
   * at most VOIP_BUDGET_WINDOW_SEC after first use.
   */
  private async commitVoipWakeBudget(senderUserId: string, recipientUserId: string): Promise<void> {
    const pairKey      = `push-voip-budget:pair:${senderUserId}:${recipientUserId}`;
    const recipientKey = `push-voip-budget:recipient:${recipientUserId}`;
    const nextPair      = await this.redis.client.incr(pairKey);
    const nextRecipient = await this.redis.client.incr(recipientKey);
    if (nextPair      === 1) await this.redis.client.expire(pairKey,      VOIP_BUDGET_WINDOW_SEC);
    if (nextRecipient === 1) await this.redis.client.expire(recipientKey, VOIP_BUDGET_WINDOW_SEC);
  }
```

Doc-comment edits in the block immediately above `consumeVoipWakeBudget` (`push.service.ts:865-888`),
so the prose does not contradict the code:

- `*   1. per-pair: 6 wakes from (sender → recipient) per minute`
  → `*   1. per-pair: VOIP_WAKE_PAIR_CAP wakes from (sender → recipient) per minute,`
  `*      charged ONCE per distinct callId (SRV-06)`
- append after the "Implementation note" paragraph:
  `* SRV-06: the charge is committed only once sendVoipWake knows a push is`
  `* actually dispatchable — an unreachable recipient no longer spends a unit.`

#### 1c. `sendVoipWake` — peek first, commit late

Anchor (verbatim, current tree):

```ts
const budget = await this.consumeVoipWakeBudget(senderUserId, userId);
if (!budget.ok) {
  this.logger.warn(
    `push.voip.budget-deny sub=${userId.slice(0, 8)} sender=${senderUserId.slice(0, 8)} call=${callId.slice(0, 8)} reason=${budget.reason}`,
  );
  return {sent: 0, stubbed: false, reason: budget.reason};
}
```

Replacement:

```ts
const budget = await this.peekVoipWakeBudget(senderUserId, userId, callId);
if (!budget.ok) {
  this.logger.warn(
    `push.voip.budget-deny sub=${userId.slice(0, 8)} sender=${senderUserId.slice(0, 8)} call=${callId.slice(0, 8)} reason=${budget.reason}`,
  );
  return {sent: 0, stubbed: false, reason: budget.reason};
}
```

Second anchor (verbatim, current tree — end of the per-device signing loop):

```ts
      if (r.platform === 'android') signedAndroid.push({record: r, wakeKey});
      else                          signedIos.push({record: r, wakeKey});
    }

    let sent = 0;
```

Replacement:

```ts
      if (r.platform === 'android') signedAndroid.push({record: r, wakeKey});
      else                          signedIos.push({record: r, wakeKey});
    }

    // SRV-06 — charge only now that a push is genuinely going out. The old
    // charge-first ordering spent a unit on recipients with no VoIP token, on
    // boxes with FCM creds missing, and on devices with no wake key, so the
    // perimeter fired against legitimate callers long before any spam.
    if (budget.charge && (signedAndroid.length > 0 || signedIos.length > 0)) {
      await this.commitVoipWakeBudget(senderUserId, userId);
    }

    let sent = 0;
```

Note the two early returns between the peek and the commit (`push.service.ts:989-992` no-tokens,
`:994-1004` fcm-not-ready) now exit **uncharged** — that is the point of F2.

### File 2 — `apps/messenger-service/src/gateway/messenger.gateway.ts` (F4, log only)

Anchor 1 (verbatim, current tree — 1:1 `call.offer`):

```ts
void this.push
  .sendVoipWake(
    data.to.userId,
    data.callId,
    ctx.claims.sub,
    undefined,
    ((data as {kind?: string}).kind ?? (data as {callType?: string}).callType) === 'video'
      ? 'video'
      : 'voice',
  )
  .catch(() => {
    /* swallow */
  });
```

Replacement:

```ts
void this.push
  .sendVoipWake(
    data.to.userId,
    data.callId,
    ctx.claims.sub,
    undefined,
    ((data as {kind?: string}).kind ?? (data as {callType?: string}).callType) === 'video'
      ? 'video'
      : 'voice',
  )
  .then(r => {
    // SRV-06 — a throttled wake means a Dozed/killed callee never rings; the
    // queued pendingOffer (45s) + missed marker are the only remaining paths.
    // Surface it in the operator-facing [CALL] stream, not just push logs.
    if (r?.reason) {
      console.warn(
        `[CALL] OFFER wake-throttled cid=${data.callId.slice(0, 8)} → ${data.to.userId.slice(0, 8)} reason=${r.reason}`,
      );
    }
  })
  .catch(() => {
    /* swallow */
  });
```

Anchor 2 (verbatim, current tree — group `sfu.ring`):

```ts
void this.push
  .sendVoipWake(
    uid,
    data.roomId,
    callerId,
    roomToken || undefined,
    (data as {callType?: string}).callType === 'video' ? 'group-video' : 'group-voice',
  )
  .catch(() => {
    /* swallow */
  });
```

Replacement:

```ts
void this.push
  .sendVoipWake(
    uid,
    data.roomId,
    callerId,
    roomToken || undefined,
    (data as {callType?: string}).callType === 'video' ? 'group-video' : 'group-voice',
  )
  .then(r => {
    if (r?.reason) {
      this.logger.warn(
        `[SFU] ring wake-throttled rid=${data.roomId.slice(0, 8)} → ${uid.slice(0, 8)} reason=${r.reason}`,
      );
    }
  })
  .catch(() => {
    /* swallow */
  });
```

(`console.warn` in the 1:1 handler matches the surrounding `[CALL]` lines at `:1192`/`:1221`/`:1231`;
`this.logger.warn` in the SFU handler matches `:1868`/`:1878`.)

### Redis keyspace

One new key family, TTL 60 s, no migration and no read of any pre-existing key:

```
push-voip-budget:call:<senderUserId>:<recipientUserId>:<callId>   EX 60   (INCR counter)
```

Existing `push-voip-budget:pair:*` / `push-voip-budget:recipient:*` keep their exact shape and TTL,
so a rolling deploy across nodes is safe — a node on the old build and a node on the new build share
the same pair/recipient counters and simply disagree about the cap and the dedupe. No key is deleted,
no value format changes.

### Wire / back-compat

Nothing on the wire changes. `sendVoipWake`'s FCM/APNs `data` block, the HMAC canonical form
(`kind|callId|nonce|exp`), the `collapseKey`, and the WS frames are all untouched, so old APKs are
unaffected and the server can ship ahead of clients.

### Explicitly NOT done (and why)

- **Not** skipping the wake for a "fully online" callee. `messenger.gateway.ts:1232-1240` (N-01)
  documents that a zombie socket lingers up to ~55 s and that the peer-offline probe lies; gating on
  it reopens the "call rang nowhere" class. Not charging for an online callee is worse — the wake
  still lights the lock screen, so an attacker whose target is online would get unmetered ring spam.
- **Not** telling the caller. Doing it on the `call.offer` ack means `await`-ing the FCM round-trip
  (~100-400 ms added to call setup); doing it as a push needs a new advisory frame plus UI. See
  follow-up below.

### Follow-up (separate change, needs a UI decision)

Add a server→client advisory `call.wake-throttled` `{callId, reason}` emitted to the caller's socket
from the `.then()` above, register it in `src/modules/messenger/runtime/callFrameRouter.ts`
`CALL_FRAME_EVENTS` + a `case` in `callDispatcher.ts`, and surface a branded toast. This is
additive and back-compat by the same route `call.missed` took (`callFrameRouter.ts:34-37`): old
clients receive the frame via `transport/client.ts:360 socket.onAny`, fail the `isCallFrame` gate,
and drop it silently. Deferred here because it adds UI and therefore pulls in `DESIGN_REVIEW_LOOP.md`.

## Blast radius

Files:

- `apps/messenger-service/src/push/push.service.ts` — `consumeVoipWakeBudget` (public; only callers
  are the specs and `sendVoipWake`), new private `peekVoipWakeBudget` / `commitVoipWakeBudget`,
  `sendVoipWake` (two edits), module consts. Two new exports.
- `apps/messenger-service/src/gateway/messenger.gateway.ts` — `handleCallOffer` (one statement),
  the `sfu.ring` handler (one statement).

Callers checked (full sweep, `sendVoipWake` + `consumeVoipWakeBudget` across `apps/`, `src/`,
`packages/`): exactly two production call sites — `messenger.gateway.ts:1290` and `:1925` — plus
`push.service.spec.ts`, `push-chat-wake.spec.ts`, `messenger.gateway.calls.spec.ts`,
`messenger.gateway.sfu-auth.spec.ts`. `consumeVoipWakeBudget` gains an **optional** third parameter,
so every existing call compiles unchanged.

No persisted schema touched: no SQLCipher migration (this is server-side Redis only), no Postgres,
no `apps/messenger-service` table. Nothing in `packages/messenger-core` or the mobile client changes.

Overlapping findings (same functions / adjacent lines — sequence or expect conflicts):

- **SRV-03** (connect-time drain of pending call offers) edits the same
  `handleCallOffer` tail block (`messenger.gateway.ts:1232-1300`) — direct textual conflict with the
  F4 anchor. Land one, rebase the other.
- **SRV-02** (persist ringing call-session state in Redis) introduces a callId-keyed Redis record;
  coordinate so it does not collide with `push-voip-budget:call:*` and so its TTL story stays
  separate from the 60 s budget window.
- **SYNC-5** (`MISSED_CALL_MARKER_TTL_SEC`) edits `messenger.gateway.ts:1256-1279`, immediately above
  the F4 anchor.
- Anything else touching `push.service.ts` VoIP wake payloads (B-112 / PUSH-B6 / P1-BR-1 lineage) —
  this spec does not touch the payload, only the ordering around it.

What could regress:

1. `push.service.spec.ts` hard-codes `6` and `30`; the cap raise fails three existing assertions
   unless they are migrated to the exported constants (below).
2. The gateway spec mocks (`messenger.gateway.calls.spec.ts:51`,
   `messenger.gateway.sfu-auth.spec.ts:52`) return a promise, so `.then()` is fine — but
   `messenger.gateway.calls.spec.ts:411`'s mock returns an object without `reason`, which the
   `r?.reason` guard handles.
3. Group ring: with F1 a re-ring inside 60 s no longer charges, so a host retrying a ring 4× now
   costs 1 unit per recipient instead of 4. That is intended, and is bounded by
   `VOIP_WAKE_CALL_FREE_RETRIES`, the per-socket `sfu.ring` limit
   (`ws-rate-limiter.ts:151` `{refillPerSec: 1, capacity: 5}`) and the cluster-wide
   `userRateExceeded(callerId, 'sfuring', 20)` at `messenger.gateway.ts:1857`.
4. A token-less recipient no longer charges, so an attacker aimed at such a victim gets unmetered
   `SMEMBERS` + `MGET` per offer. Bounded by `call.offer` `{refillPerSec: 1, capacity: 5}` per socket
   and by CRIT-1's migration marker (`push-index-mig:*`) which guarantees at most one SCAN ever per
   user. No push can reach that victim anyway, so there is no budget worth protecting.

## Tests

Layout followed: `apps/messenger-service` has its own Jest project (`rootDir: src`, run with
`cd apps/messenger-service && npx jest`), specs colocated next to the source
(`src/push/push.service.spec.ts`, `src/gateway/messenger.gateway.calls.spec.ts`), Redis faked with
`ioredis-mock` via the existing `setup()` helper at `push.service.spec.ts:24-40`. No new spec file is
needed — extend the existing P0-C5 describe.

### `apps/messenger-service/src/push/push.service.spec.ts` (modify)

Import the new constants:

```ts
import {PushService, VOIP_WAKE_PAIR_CAP, VOIP_WAKE_RECIPIENT_CAP} from './push.service';
```

Migrate the three existing cap-boundary assertions off the literals (`:60` `i < 6`, `:72` `i < 6`,
`:85` `i < 30`, `:111` `i < 6`) to `i < VOIP_WAKE_PAIR_CAP` / `i < VOIP_WAKE_RECIPIENT_CAP`. Behaviour
of those four tests is unchanged.

Add to the `PushService — audit P0-C5 VoIP wake budget` describe:

1. `SRV-06 — the same callId is charged once inside the window`
   - `for (let i = 0; i < VOIP_WAKE_PAIR_CAP + 2; i++)` call
     `consumeVoipWakeBudget('s', 'r', 'call-x')` → every result `{ok: true}`.
   - assert `Number(await mock.get('push-voip-budget:pair:s:r'))` is `1 + Math.max(0, (VOIP_WAKE_PAIR_CAP + 2) - 1 - 3)`
     (first charge + charges after the free-retry allowance) — i.e. the pair bucket is **not**
     exhausted by a same-call loop.

2. `SRV-06 — distinct callIds still each cost a unit (perimeter intact)`
   - `for (let i = 0; i < VOIP_WAKE_PAIR_CAP; i++)` call `consumeVoipWakeBudget('s', 'r', \`c-${i}\`)`→ all`{ok: true}`.
   - `expect(await push.consumeVoipWakeBudget('s', 'r', 'c-last')).toEqual({ok: false, reason: 'pair_budget_exhausted'})`.

3. `SRV-06 — free same-callId retries are bounded`
   - hammer `consumeVoipWakeBudget('s', 'r', 'c-loop')` 40 times; assert every call resolves
     `{ok: false, reason: 'pair_budget_exhausted'}` by the end, and
     `Number(await mock.get('push-voip-budget:pair:s:r'))` `>= VOIP_WAKE_PAIR_CAP`
     (a same-callId loop cannot buy unlimited wakes).

4. `SRV-06 — a wake with no dispatchable device does not charge`
   - `const r = await push.sendVoipWake('u-no-tokens', 'c1', 's1');`
   - `expect(r).toEqual({sent: 0, stubbed: false});`
   - `expect(await mock.exists('push-voip-budget:pair:s1:u-no-tokens')).toBe(0);`
   - `expect(await mock.exists('push-voip-budget:recipient:u-no-tokens')).toBe(0);`

5. `SRV-06 — an FCM-not-ready wake does not charge`
   - `await push.registerVoipToken({userId: 'u9', deviceId: 'd9', platform: 'android', token: 'tok', updatedAt: Date.now()});`
   - `const r = await push.sendVoipWake('u9', 'c2', 's2');`
   - `expect(r).toEqual({sent: 0, stubbed: true});` (records found, FCM creds absent in unit tests)
   - `expect(await mock.exists('push-voip-budget:pair:s2:u9')).toBe(0);`

6. `SRV-06 — the deny still short-circuits before any token work` (regression guard for the
   perimeter, replaces the intent of the existing `:107` test): exhaust the bucket with
   `VOIP_WAKE_PAIR_CAP` **distinct** callIds, then
   `expect(await push.sendVoipWake(recipient, 'call-id', sender)).toEqual({sent: 0, stubbed: false, reason: 'pair_budget_exhausted'})`.

### `apps/messenger-service/src/gateway/messenger.gateway.calls.spec.ts` (modify)

Add one test in the existing call.offer describe: make the `push.sendVoipWake` mock resolve
`{sent: 0, stubbed: false, reason: 'pair_budget_exhausted'}` and assert the handler's return value is
**unchanged** (still `undefined` when the offer was queued) — i.e. F4 is log-only and cannot alter
call setup, and no unhandled rejection escapes.

### Commands

```
cd apps/messenger-service && npx jest src/push src/gateway     # targeted
cd apps/messenger-service && npm test                          # full service suite
cd apps/messenger-service && npm run typecheck
```

No mobile suite is affected (nothing under `src/` or `packages/` changes), but per CLAUDE.md gate 2
run `npm run test:crypto` from the repo root once to confirm the messenger-crypto project is
untouched.

## Risk

What a reviewer should be suspicious of:

1. **F3 is a deliberate perimeter relaxation** (6 → 10 per pair per minute). It is permitted —
   `MESSENGER_BACKEND.md:210` pins rate limits only for `/auth/register` + `/auth/login`, and the
   batch architecture note explicitly allows a blind limit raise since no doc pins this value — but
   it is still a security-relevant number. Check that `VOIP_WAKE_RECIPIENT_CAP` stays at 30, because
   that is now the only hard ceiling on a distributed ring-spam attempt.
2. **F1's free-retry allowance is a wake amplifier if the bound is wrong.** With
   `VOIP_WAKE_CALL_FREE_RETRIES = 3`, one charged unit buys at most 4 wakes for the same callId.
   Confirm the three independent bounds still hold: FCM `collapseKey: voip-wake:<callId>`
   (`push.service.ts:1082`), the device's `bravo-call-<callId>` notifee dedupe, and
   `userRateExceeded(callerId, 'sfuring', 20)` (`messenger.gateway.ts:1857`). If any of those is
   removed later, this allowance must shrink to 0.
3. **Peek has a side effect.** `peekVoipWakeBudget` INCRs the per-call counter, so it is not a pure
   read — calling it twice for one wake would consume a free retry. There is exactly one call site
   (`sendVoipWake`) plus the `consumeVoipWakeBudget` wrapper; do not add a third.
4. **Charge/no-charge asymmetry on the early-return paths.** A wake that peeks (`charge: true`) and
   then bails at the no-tokens or fcm-not-ready return leaves the per-call counter bumped but nothing
   charged. Bounded (at most `FREE_RETRIES` under-charges per call), intentional, and strictly safer
   than today's over-charge — but confirm it is understood, not accidental.
5. **Race window is unchanged, not fixed.** The original method already read-then-incremented
   non-atomically (`push.service.ts:877-883` documents it); the split widens the gap between read and
   write by the token-lookup + signing work. Worst case is still bounded by
   `(cap + concurrent wakes to the same pair)`, which for a real pair is 1-2. If a reviewer wants
   this tight, the correct fix is a Lua script or `INCR`-then-compare-then-`DECR`, not a lock — but
   that is a different change and would alter the documented behaviour of the existing method.
6. **`.then()` before `.catch()`** — verify the handler body cannot throw synchronously in a way that
   escapes; `r?.reason` plus `slice()` on strings already validated upstream is safe, and the
   trailing `.catch` covers it regardless.
7. **The audit's own FIX text is wrong** and a reviewer reading only the audit will expect
   `(sender, recipient, callId)`-keyed buckets. That would make the perimeter trivially bypassable
   (fresh callId per wake). Confirm the implemented shape is _charge once per callId_, not
   _a bucket per callId_.
