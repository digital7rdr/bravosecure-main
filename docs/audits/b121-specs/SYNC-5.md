# SYNC-5 - Missed-call record is lost when the callee stays offline longer than the 6h Redis marker TTL

## Verdict

**CONFIRMED-WITH-DRIFT.**

1. The 6h ceiling is real and unchanged. `apps/messenger-service/src/gateway/messenger.gateway.ts:2648`:
   `const MISSED_CALL_MARKER_TTL_SEC = 6 * 60 * 60; // 6h`
2. It is the **only** durable carrier of the missed-call _log row_. Both the 1:1 marker
   (`messenger.gateway.ts:1268-1282`, `'EX', MISSED_CALL_MARKER_TTL_SEC` + `expire(pendingOfferIndexKey(...), MISSED_CALL_MARKER_TTL_SEC)`)
   and the group marker (`:1949-1955`) use it, so both lanes drop at 6h.
3. The record only materialises at WS connect-time drain — `deliverPendingCallOffer`
   (`messenger.gateway.ts:598-602`): `const markerRaw = await this.redis.client.get(markerKey); await this.redis.client.del(markerKey); if (markerRaw) { … client.emit('call.missed', …) }`.
   No marker → no emit → no `missed-<callId>` bubble is ever minted.
4. The FCM fallback does **not** compensate. `sendCallCancel(..., /*missed*/ true)` reaches
   `handleCallCancel` in `src/modules/messenger/push/fcmBootstrap.ts:797-812`, which only calls
   `cn.showMissedCallNotif({...})` — it posts a **notification** and never appends a `call_meta`
   row. The Calls log stays empty.
5. Client side is correct and idempotent already: `src/modules/messenger/webrtc/callDispatcher.ts:188-210`
   handles the dynamic `call.missed` frame and calls `appendMissedCallBubble` with the stable id
   `missed-${d.callId}`; `CallsLogScreen.tsx` reads purely from `selectCallMessages`
   (`src/modules/messenger/store/messengerStore.ts:1459-1473`: `if (m.type === 'call' && m.call_meta) {out.push(m);}`).
   So there is nothing to fix on the render path.

**Drift (the audit is partly wrong on clause 2).** "call history is per-device local with no
reconciliation" overstates it: call bubbles **do** ride the E2EE backup mirror —
`src/modules/messenger/backup/messageMirror.ts:783` and `backup/backupWireV3.ts:100` both carry
`call_meta: msg.call_meta`, and `backup/restoreMessages.ts:538` restores it. So a new device that
restores from backup _does_ get call history. What genuinely does not exist is **live multi-device
call-log sync**, which is a product feature, not a defect, and is explicitly out of scope here
(see Fix §0).

## Mechanism

1. Alice calls Bob. Bob's device is killed/Dozed, or on a dead radio.
2. `handleCallOffer` (`messenger.gateway.ts:1259-1282`) writes three Redis keys for Bob:
   `pending-call-offer:{bob}:{dev}:{callId}` (`EX 45`), `missed-call-marker:{bob}:{dev}:{callId}`
   (`EX MISSED_CALL_MARKER_TTL_SEC`), and adds `callId` to `pending-call-offer-idx:{bob}:{dev}`
   (also `EXPIRE MISSED_CALL_MARKER_TTL_SEC`). It fires `sendVoipWake`.
3. Alice gives up. `handleCallHangup` (`:1404-1431`) computes `callerGaveUp = wasRinging && isCaller`,
   calls `clearPendingCallArtifacts(..., {keepMarker: true})` — which deliberately keeps BOTH the
   marker and the index entry (`:1345-1353`) — and sends `sendCallCancel(..., missed=true)`.
4. Bob's device stays offline. At **T+6h** Redis expires the marker _and_ the index key.
5. Bob reconnects at T+8h. `deliverPendingCallOffer` runs `smembers(idxKey)` → empty → early
   `return` at `:567`. No `call.missed` is emitted. Nothing is ever written to
   `messages`/`call_meta`. Bob's Calls log shows nothing; he never learns Alice called.
6. If the FCM cancel push landed at some point, Bob saw a transient notification (which he may have
   swiped away or which is gone after reboot) — but that path (`fcmBootstrap.ts:797-812`) writes no
   row, so once the notification is dismissed the event is gone for good.

Real-world trigger (matches the founder complaint class): phone off overnight / on a plane / OEM
battery-killed over a weekend → all missed calls from that window vanish silently.

## Fix

### §0 — Scope decision (read first)

The audit offers two options. **Take (a) now, and explicitly defer (b)** — because (b) is _blocked_
by a wire-compat landmine that the audit did not account for:

`isSealedPayload` **rejects unknown top-level keys**. `packages/messenger-core/src/crypto/sealedSender.ts:596-606`:

```ts
const SEALED_PAYLOAD_KEYS = new Set([
  'v', 'cert', 'body', 'attachment', 'expiresAtSec', 'clientMsgId',
  'group', 'replyTo', 'reaction', 'control', 'groupCallPresence', 'aad',
]);
…
  for (const k of Object.keys(o)) {
    if (!SEALED_PAYLOAD_KEYS.has(k)) {return false;}
  }
```

(mirrored verbatim at `src/modules/messenger/crypto/sealedSender.ts:473-486`.)

Adding a `callEvent` field therefore makes an older receiver throw `CryptoError('sealed payload
shape invalid')` from `unsealPayload`. In `productionRuntime.ts:6386-6394` that throw is **rethrown**
inside the receive transaction, which rolls back `seenEnvelopes.markSeen` _and_ the ratchet advance —
so the envelope is never acked and the relay **redelivers it for up to 30 days**. A poison pill, per
missed call, for every not-yet-updated client. (The file header comment at `sealedSender.ts:52-56`
claiming the guard "allows extras" is stale relative to the code — do not trust it.)

Shipping (b) therefore needs a two-release train: release N makes the guard _strip_ unknown keys
instead of rejecting (itself a posture change that needs architecture sign-off under CLAUDE.md
"never weaken transitions"), release N+1 emits the field, with emission gated until fleet
saturation. That is a separate, approval-gated change — **out of scope for SYNC-5**. It is written up
in §4 as the follow-up.

**Approval gate on (a):** raising the TTL lengthens the window in which the relay holds a cleartext
`{callee → caller, kind, at}` tuple in Redis. Per the batch architecture ruling this is
ALLOWED-WITH-CONSTRAINT but "flag for approval if it goes to days". **Do not merge the default
value below without Ranak's sign-off.** The change is written so the default can be dialled by env
without a redeploy of code, and is hard-clamped to the relay dwell ceiling so it can never outlive
an envelope.

---

### 1. `apps/messenger-service/src/gateway/messenger.gateway.ts` — dwell-clamped, env-tunable TTL

**Anchor** (verbatim, currently at ~:2638-2648):

```ts
/**
 * N-02 — slim missed-call marker (no SDP). The pending offer payload lives only
 * 45s, so the old payload-based `call.missed` emit on reconnect was effectively
 * dead code (the payload had already expired by the time its age crossed the
 * >45s threshold that would have emitted it). This marker carries just enough
 * to render a "Missed call" on reconnect, and lives long enough that a
 * killed/Dozed device that reconnects minutes-to-hours later still learns it
 * missed a call — bounded so markers can't accumulate unboundedly.
 */
const MISSED_CALL_MARKER_TTL_SEC = 6 * 60 * 60; // 6h
```

**Replacement:**

```ts
/**
 * N-02 — slim missed-call marker (no SDP). The pending offer payload lives only
 * 45s, so the old payload-based `call.missed` emit on reconnect was effectively
 * dead code (the payload had already expired by the time its age crossed the
 * >45s threshold that would have emitted it). This marker carries just enough
 * to render a "Missed call" on reconnect, and lives long enough that a
 * killed/Dozed device that reconnects minutes-to-hours later still learns it
 * missed a call — bounded so markers can't accumulate unboundedly.
 *
 * SYNC-5 — the old flat 6h silently DROPPED the record for any device that
 * stayed offline longer (phone off overnight, plane, OEM battery-kill over a
 * weekend): the connect-time drain reads the marker index, finds nothing, and
 * the call never reaches the Calls log. The marker is slim JSON (~130 B), so
 * hold it for a fraction of the relay's own dwell budget instead.
 *
 * Why the clamp: this marker is the one place the relay holds a cleartext
 * callee→caller tuple, so it must never outlive an actual envelope. Hard-capped
 * at the configured RELAY_DWELL_SECONDS (30d Signal default) and floored at 60s
 * so a typo'd env can neither extend the metadata window past dwell nor
 * disable the feature outright.
 */
function resolveMissedCallMarkerTtlSec(): number {
  const parse = (raw: string | undefined, fallback: number): number => {
    const n = parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const dwell = parse(process.env['RELAY_DWELL_SECONDS'], 30 * 24 * 3600);
  const want = parse(process.env['MISSED_CALL_MARKER_TTL_SEC'], 7 * 24 * 3600);
  return Math.max(60, Math.min(want, dwell, 30 * 24 * 3600));
}
const MISSED_CALL_MARKER_TTL_SEC = resolveMissedCallMarkerTtlSec();

/**
 * SYNC-5 — with a multi-day marker TTL a device that was offline for a week can
 * come back holding a large backlog. Cap the connect-time `call.missed` /
 * `sfu.ring.missed` burst at the newest N (the rest are already deleted from
 * Redis by the drain) so one reconnect can't emit hundreds of frames into a
 * cold client.
 */
const MISSED_CALL_DRAIN_EMIT_CAP = 50;
```

Notes:

- `process.env` read at module scope matches the existing style in this file
  (`process.env.BRAVO_DUMP_SDP` at `:174`, `process.env.NODE_ENV` at `:1590`). The gateway does
  **not** inject `ConfigService`, so routing this through `config/configuration.ts` would mean
  adding an 11th constructor dep — rejected as scope creep. `RELAY_DWELL_SECONDS` is read from the
  same env var `configuration.ts:62` uses, so the two stay in lockstep.
- No wire change, no client change required, no schema change. Server-only, and it is
  **forward-and-backward compatible with every deployed client** — the `call.missed` /
  `sfu.ring.missed` frame shape is untouched.
- Deploy order is irrelevant (server-only).

### 2. `apps/messenger-service/src/gateway/messenger.gateway.ts` — bound the 1:1 drain burst

**Anchor** (verbatim, inside `deliverPendingCallOffer`, currently ~:571-604):

```ts
// Read each offer payload and replay in chronological order.
const records: PendingCallOffer[] = [];
for (const cid of callIds) {
  const key = pendingOfferKey(address.userId, address.deviceId, cid);
  const markerKey = missedCallMarkerKey(address.userId, address.deviceId, cid);
  try {
    const raw = await this.redis.client.get(key);
    await this.redis.client.del(key);
    if (raw) {
      const parsed = JSON.parse(raw) as PendingCallOffer;
      const ageSec = (Date.now() - parsed.at) / 1000;
      if (ageSec <= 45) {
        // Fresh, live offer — replay it and drop the missed-marker: the
        // callee is getting the call live now (an answer will follow).
        await this.redis.client.del(markerKey);
        records.push(parsed);
        continue;
      }
    }
    // N-02 — no live offer (expired, or the caller hung up and we purged
    // the payload but kept the marker). If a missed-marker survives, the
    // callee genuinely missed the call: emit `call.missed` so they get a
    // "Missed call" record. This replaces the old payload-based emit,
    // which was dead code (the 45s payload had always expired by the time
    // its age crossed the >45s threshold that would have emitted it).
    const markerRaw = await this.redis.client.get(markerKey);
    await this.redis.client.del(markerKey);
    if (markerRaw) {
      const m = JSON.parse(markerRaw) as MissedCallMarker;
      client.emit('call.missed', {callId: m.callId, from: m.from, kind: m.kind, at: m.at});
    }
  } catch {
    /* skip malformed entry */
  }
}
```

**Replacement:**

```ts
// Read each offer payload and replay in chronological order.
const records: PendingCallOffer[] = [];
const missed: MissedCallMarker[] = [];
for (const cid of callIds) {
  const key = pendingOfferKey(address.userId, address.deviceId, cid);
  const markerKey = missedCallMarkerKey(address.userId, address.deviceId, cid);
  try {
    const raw = await this.redis.client.get(key);
    await this.redis.client.del(key);
    if (raw) {
      const parsed = JSON.parse(raw) as PendingCallOffer;
      const ageSec = (Date.now() - parsed.at) / 1000;
      if (ageSec <= 45) {
        // Fresh, live offer — replay it and drop the missed-marker: the
        // callee is getting the call live now (an answer will follow).
        await this.redis.client.del(markerKey);
        records.push(parsed);
        continue;
      }
    }
    // N-02 — no live offer (expired, or the caller hung up and we purged
    // the payload but kept the marker). If a missed-marker survives, the
    // callee genuinely missed the call: emit `call.missed` so they get a
    // "Missed call" record. This replaces the old payload-based emit,
    // which was dead code (the 45s payload had always expired by the time
    // its age crossed the >45s threshold that would have emitted it).
    const markerRaw = await this.redis.client.get(markerKey);
    await this.redis.client.del(markerKey);
    if (markerRaw) {
      missed.push(JSON.parse(markerRaw) as MissedCallMarker);
    }
  } catch {
    /* skip malformed entry */
  }
}
// SYNC-5 — keep the NEWEST cap-worth, then emit oldest-first so the
// client's chronological splice in appendMessage does no extra work.
missed.sort((a, b) => b.at - a.at);
for (const m of missed.slice(0, MISSED_CALL_DRAIN_EMIT_CAP).reverse()) {
  client.emit('call.missed', {callId: m.callId, from: m.from, kind: m.kind, at: m.at});
}
```

### 3. `apps/messenger-service/src/gateway/messenger.gateway.ts` — same bound for the group drain

**Anchor** (verbatim, inside `deliverPendingGroupRing`, currently ~:655-666):

```ts
          // No live ring (expired or host-cancelled) — surface the missed record.
          const markerRaw = await this.redis.client.get(markerKey);
          await this.redis.client.del(markerKey);
          if (markerRaw) {
            const m = JSON.parse(markerRaw) as MissedGroupCallMarker;
            client.emit('sfu.ring.missed', {
              roomId: m.roomId, conversationId: m.conversationId, from: m.from, callType: m.callType, at: m.at,
            });
          }
        } catch { /* skip malformed entry */ }
      }
```

**Replacement:**

```ts
          // No live ring (expired or host-cancelled) — surface the missed record.
          const markerRaw = await this.redis.client.get(markerKey);
          await this.redis.client.del(markerKey);
          if (markerRaw) {
            missedGroup.push(JSON.parse(markerRaw) as MissedGroupCallMarker);
          }
        } catch { /* skip malformed entry */ }
      }
      // SYNC-5 — bound the reconnect burst (see MISSED_CALL_DRAIN_EMIT_CAP).
      missedGroup.sort((a, b) => b.at - a.at);
      for (const m of missedGroup.slice(0, MISSED_CALL_DRAIN_EMIT_CAP).reverse()) {
        client.emit('sfu.ring.missed', {
          roomId: m.roomId, conversationId: m.conversationId, from: m.from, callType: m.callType, at: m.at,
        });
      }
```

…plus the declaration, immediately after the existing `const fresh: PendingGroupRing[] = [];`
(currently ~:640):

```ts
const missedGroup: MissedGroupCallMarker[] = [];
```

### 4. `src/modules/messenger/webrtc/callDispatcher.ts` — don't ring-notify week-old missed calls

This is a regression _created by_ §1: with a 7-day TTL, a reconnect after a week fires
`showMissedCallNotif` once per stale marker. Append the log row always; only notify for recent ones.

**Anchor** (verbatim, currently ~:195-210):

```ts
    const convoId = appendMissedCallBubble(f.data);
    if (convoId) {
      // Post a persistent "Missed call" notification so a backgrounded user
      // sees it after the ring auto-dismisses (WhatsApp/Signal parity).
      try {
```

**Replacement:**

```ts
    const convoId = appendMissedCallBubble(f.data);
    // SYNC-5 — the server marker now survives days, so a reconnect after a long
    // offline stretch can replay stale markers. The Calls-log row is always
    // written; only recent misses get a notification, otherwise waking from a
    // weekend offline spams one banner per old call.
    const missedAgeMs = Date.now() - (f.data.at ?? 0);
    if (convoId && missedAgeMs < MISSED_CALL_NOTIF_MAX_AGE_MS) {
      // Post a persistent "Missed call" notification so a backgrounded user
      // sees it after the ring auto-dismisses (WhatsApp/Signal parity).
      try {
```

**Insertion**, immediately above the `appendMissedCallBubble` function definition (currently ~:118):

```ts
/** SYNC-5 — notify only for misses newer than this; older ones are log-only. */
const MISSED_CALL_NOTIF_MAX_AGE_MS = 6 * 60 * 60 * 1000;
```

No change is needed for the group lane: `productionRuntime.ts:5095-5111` (`sfu.ring.missed`) only
calls `appendMissedGroupCallBubble` — it posts no notification.

### 5. Schema / wire / migration

- **No SQLCipher schema change.** The missed bubble reuses the existing `messages.call_meta_json`
  column (`src/modules/messenger/crypto/db.ts:155`, schema v5), which already round-trips through
  `sqlMessageStore.doUpsert` (`:128`, `:136`) and the backup mirror (`messageMirror.ts:783`).
  No `db.ts` version bump.
- **No wire-format change.** `call.missed` / `sfu.ring.missed` frame shapes are byte-identical.
  Old clients that get a stale-but-valid `call.missed` behave exactly as today (row + notification).
- **Deploy order:** server-first is fine and required by nothing. §4 is a pure client-side
  politeness fix that can ship in any later APK; without it, a long-offline client on an old build
  simply shows more notifications than we would like — no data loss, no crash.

## Blast radius

**Server (`apps/messenger-service/src/gateway/messenger.gateway.ts`)**

- `MISSED_CALL_MARKER_TTL_SEC` has 4 read sites: `:1270`, `:1278` (1:1 offer queue),
  `:1952`, `:1955` (group ring queue). All four get the longer value — intended; the 1:1 and group
  lanes must stay symmetric.
- `:1278` / `:1955` are `EXPIRE` on the _index_ keys. Because these are refreshed on every new
  offer, a busy recipient's index key now lives up to 7 days past their last incoming call. Redis
  memory: index member 36 B + marker ~130 B per missed call — with the §2/§3 emit cap and the
  existing `rateGate(client, 'call.offer')` throttle, worst realistic case is single-digit KB per
  device. Not a new class of growth, just a longer window on an existing one.
- `deliverPendingCallOffer` / `deliverPendingGroupRing` are called only from the connect handler
  (`:540`, `:543`) — no other callers.
- `clearPendingCallArtifacts` (`:1337`) is untouched; the `{keepMarker}` semantics that P1-15/P2-13
  depend on remain exactly as-is. Answer (`:1325`), hangup (`:1428`) and HTTP decline (`:2550`)
  still purge, so a longer TTL cannot resurrect an answered/declined call.

**Client**

- `callDispatcher.dispatchCallFrame` — the `call.missed` branch. `endZombieSession(f.data.callId, …)`
  stays **before** the age gate (a stale marker for a callId that somehow matches a live session must
  still kill the zombie; B-64).
- `appendMissedCallBubble` unchanged; its `missed-${callId}` id keeps `appendMessage`'s dedup
  idempotent across repeat drains (`messengerStore.ts:539-547`).
- `appendMessage`'s out-of-order binary splice (`messengerStore.ts:552-566`) already places an
  old-`created_at` missed bubble in its chronological slot, so a week-old replayed miss lands in the
  right place in `ChatScreen` and sorts correctly in `selectCallMessages`.
- `CallsLogScreen.tsx` — no code change; `fmtRelative` already handles multi-day ages
  (`CallsLogScreen.tsx:55-61`).
- Backup mirror: more `type:'call'` rows now exist → they flow into the mirror as normal message
  rows. This touches `docs/runbooks/BACKUP_LOOP.md` territory only in the trivial sense that new
  rows appear; no ledger/commit semantics change, invariants I1–I9 unaffected.

**Overlapping findings**

- **SYNC-4** (delete-for-everyone) hits the _same_ `SEALED_PAYLOAD_KEYS` wall described in §0. If
  SYNC-4 is approved to relax the guard to strip-unknown-keys, SYNC-5's follow-up (b) rides that
  same release train — coordinate; do not do two independent guard edits.
- **SRV-03** (connect-time drain of pending call offers) edits `deliverPendingCallOffer`, the exact
  function §2 rewrites. **Merge conflict guaranteed — land SRV-03 and SYNC-5 §2 together or
  sequentially, not in parallel.**
- **SRV-02** (persist ringing call-session state in Redis) touches the same call-metadata-in-Redis
  privacy question; if SRV-02 is rejected on metadata grounds, §1's default should be reconsidered
  downward for the same reason.
- **B-53/B-62..B-70** call-notification work touches `fcmBootstrap.handleCallCancel` and
  `callNotification.showMissedCallNotif` — §4 sits next to it.

**What could regress**

- Duplicate "Missed call" rows: no — stable id + dedup, and the marker is `DEL`'d on drain.
- Phantom missed calls for answered/declined calls: no — the purge sites are unchanged and were
  already correct (P1-14, P1-15).
- A malformed `MISSED_CALL_MARKER_TTL_SEC` env value: guarded — non-numeric/≤0 falls back to the
  7-day default, and the result is clamped into `[60, min(dwell, 30d)]`.

## Tests

**New — `apps/messenger-service/src/gateway/messenger.gateway.missed-call-ttl.spec.ts`**
(follows the harness style of `messenger.gateway.calls.spec.ts`: handlers invoked off
`MessengerGateway.prototype` with a hand-built `this` and jest-mocked `redis.client`.)

- `resolveMissedCallMarkerTtlSec` behaviour — since it is module-private, assert it indirectly via
  `handleCallOffer`'s `redis.set` call, using `jest.resetModules()` + `process.env` mutation and a
  fresh `require('./messenger.gateway')` per case:
  - default (no env): the marker `set` is called with `'EX', 7 * 24 * 3600`.
  - `MISSED_CALL_MARKER_TTL_SEC=1209600` (14d): honoured → `'EX', 1209600`.
  - `MISSED_CALL_MARKER_TTL_SEC=99999999` (>30d): clamped to `30 * 24 * 3600`.
  - `RELAY_DWELL_SECONDS=86400` + `MISSED_CALL_MARKER_TTL_SEC=604800`: clamped to `86400`
    (**this is the key assertion — the marker can never outlive relay dwell**).
  - `MISSED_CALL_MARKER_TTL_SEC=abc` / `=0` / `=-5`: falls back to the 7-day default, never `<= 0`.
  - The 45s pending-offer payload TTL is **unchanged** (`'EX', 45`) — assert it explicitly so a
    future edit can't accidentally lengthen the SDP-bearing key.
- `deliverPendingCallOffer` emit cap:
  - seed 120 markers via a stubbed `redis.client` (`smembers` → 120 callIds, `get(markerKey)` →
    marker JSON with descending `at`), assert exactly `50` `call.missed` emits, that they are the
    **newest 50** by `at`, and that they arrive **ascending** by `at`.
  - assert every marker key was `del`'d even for the ones not emitted (no Redis leak).
  - single-marker case still emits exactly one frame with `{callId, from, kind, at}` unchanged
    (regression guard on the frame shape / old-client compat).
- `deliverPendingGroupRing`: same cap assertion for `sfu.ring.missed`, plus the existing
  fresh-ring-within-45s path still emits `sfu.ring.incoming` and deletes the marker.

**Existing — `apps/messenger-service/src/gateway/messenger.gateway.calls.spec.ts`**

- Must still pass unchanged (P1-14 / P1-15 / P2-13 purge semantics). If any assertion hard-codes
  `'EX', 21600`, update it to the new resolved constant rather than pinning a literal.

**New — `src/modules/messenger/__tests__/missedCallNotifAge.test.ts`** (jest project
`messenger-crypto`; that project's `testMatch` covers `src/modules/messenger/__tests__/**/*.test.ts`).
Model it on the existing `callHangupWhileRinging.test.ts`, which already mocks the store and
asserts the `missed-<callId>` bubble.

- `dispatchCallFrame({event: 'call.missed', data: {..., at: Date.now()}})` → bubble appended **and**
  `showMissedCallNotif` called.
- `dispatchCallFrame({event: 'call.missed', data: {..., at: Date.now() - 7 * 86_400_000}})` →
  bubble **still** appended (`call_meta` = `{kind, direction:'incoming', outcome:'missed', duration:0}`)
  but `showMissedCallNotif` **not** called.
- `at` absent → treated as stale (age = `Date.now()`), bubble appended, no notif. Assert this
  explicitly so the `?? 0` fallback is deliberate, not accidental.
- A stale `call.missed` whose `callId` matches a live registry session still calls
  `endActiveCall` (B-64 guard must not be gated by the age check).

**Existing regression suites to run**

- `cd apps/messenger-service && npm test` (whole service — §1-§3 are server-side).
- `npm run test:crypto` (project `messenger-crypto` — covers §4 and
  `callDispatcherZombieEnd.test.ts` / `callFrameRouter.test.ts` / `callHangupWhileRinging.test.ts`).
- `npm run typecheck` — must stay at or below the `.tsc-baseline.json` count (47).

## Risk

- **The metadata window is the real cost, and it needs a human decision.** This marker is the only
  place the relay holds a cleartext "user X was called by user Y at time T" record. Going 6h → 7d is
  a 28× longer window on a plaintext social-graph artefact, in a codebase whose own docs grade a
  cleartext `conversationId` in FCM as "below the project's own opacity bar"
  (`SIGNAL_PROTOCOL_IMPLEMENTATION.md:438`) and boast "no who-called-whom oracle" (`:329`).
  A reviewer should push back on the default and ask whether 24-48h buys most of the user-visible
  benefit at a quarter of the exposure. The clamp makes 30d _possible_; nobody should set it there.
- **Do not read §1 as "the fix".** It buys days, not permanence. A device offline for longer than
  the configured TTL still loses the record. Only the E2EE-envelope variant (§0, follow-up) makes
  the missed call a first-class message with dwell-length durability and zero relay metadata.
  Anyone claiming SYNC-5 is "fully fixed" after this change is wrong.
- **Verify the `SEALED_PAYLOAD_KEYS` claim yourself before anyone attempts option (b).** It is the
  single most load-bearing fact in this spec and the header comment in the same file contradicts it.
  Read `sealedSender.ts:602-606`, not the docblock at `:52-56`.
- **Merge order with SRV-03.** §2 rewrites the body of `deliverPendingCallOffer`. If SRV-03 lands
  first with its own restructure of that loop, re-derive §2's anchor rather than force-applying.
- **The emit cap silently drops markers beyond 50.** They are deleted from Redis in the same pass,
  so they are gone, not deferred. That is intentional (a 51st week-old missed call has no value) but
  it is data loss by design and a reviewer should confirm they are comfortable with the number.
- **Env-var lockstep (B-51 rule).** `MISSED_CALL_MARKER_TTL_SEC` must be added to the staging and
  prod compose/env files in the same change, or the deployed default silently becomes 7d without
  anyone having chosen it.
- **§4 changes user-visible notification behaviour.** If product wants every missed call to ring a
  banner regardless of age, drop §4 — but then ship §1 with a 24h default, not 7d.
