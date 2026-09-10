# SRV-03 - Connect-time drain of pending call offers / group rings / delivered receipts is destructive: convert to peek → emit → remove under a short-TTL claim

## Verdict

**CONFIRMED** (line numbers drifted slightly from the audit; mechanism is exactly as described).

Evidence from the current tree:

1. `apps/messenger-service/src/gateway/messenger.gateway.ts:569-571` — the index is destroyed before anything is emitted:
   ```ts
   // SREM the entire index up-front so a parallel reconnect on
   // another socket doesn't double-deliver.
   await this.redis.client.del(idxKey);
   ```
2. `messenger.gateway.ts:578-579` — payload GET+DEL, still before any emit: `const raw = await this.redis.client.get(key); await this.redis.client.del(key);`
3. `messenger.gateway.ts:597-598` — the 6h missed-call marker is DEL'd before the `call.missed` emit at `:601`: `const markerRaw = await this.redis.client.get(markerKey); await this.redis.client.del(markerKey);`
4. The live-offer emit happens even later, in a _second_ loop after the whole read/delete pass: `messenger.gateway.ts:605-617` (`records.sort(...)` then `client.emit('call.offer', …)`).
5. Group analogue is byte-for-byte the same shape: `messenger.gateway.ts:640` (`await this.redis.client.del(idxKey);`), `:646-647`, `:658-659`, emits at `:662` and `:671`.
6. `apps/messenger-service/src/relay/envelope.service.ts:407` and `:417` — `takePendingDelivered` / `takePendingUndeliverable` pop-then-emit, backed by an atomic `SMEMBERS+DEL` MULTI at `envelope.store.ts:392` and `:413`.
7. The fix pattern already exists **in the same function**, for read receipts only — `envelope.service.ts:428-457` ("Folded P2 … NON-DESTRUCTIVE drain … peek, emit, and delete only the entries that emitted without throwing"), backed by `peekPendingReadReceipts` / `removePendingReadReceipts` at `envelope.store.ts:447-455`.

So three of the four queues drained on connect are still take-then-emit; only the read-receipt queue was converted.

## Mechanism

`handleConnection` fires four fire-and-forget drains right after the socket joins its rooms (`messenger.gateway.ts:539-546`).

1:1 call offers (`deliverPendingCallOffer`):

1. `SMEMBERS pending-call-offer-idx:{u}:{d}` → list of queued callIds.
2. `DEL` that index. **The queue no longer exists anywhere.**
3. Per callId: `GET` the 45s offer payload, `DEL` it; if fresh, `DEL` the 6h missed-marker and stash the record in memory; if not fresh, `GET`+`DEL` the marker and `client.emit('call.missed', …)`.
4. After the loop, sort the in-memory records and `client.emit('call.offer', …)`.

Between step 2 and step 4 there are 2·N+ Redis round-trips plus JSON parsing. Any of these kills the queued ring **and** the missed-call record permanently:

- the socket dies mid-drain (mobile reconnect flap, radio hand-off, app killed a beat after the WS opens — the common case on the exact devices this feature exists for);
- the pod is rolled / crashes / OOMs mid-drain (staging deploys do exactly this);
- `client.emit` writes into a socket that is already half-open — socket.io drops it silently, and the server has nothing left to retry with.

Result: the callee never rings _and_ never learns anyone called (no `call.missed` bubble, no missed-call notification). Because the marker was the last durable trace, there is no recovery path — this is the "someone called me and I have no record of it" complaint class.

The group path (`deliverPendingGroupRing`) is identical with `pending-group-ring-idx:{u}` / `missed-group-call-marker:{u}:{room}` and `sfu.ring.incoming` / `sfu.ring.missed`.

The relay path (`flushPendingDelivered`) has the same shape for the sender-facing `envelope.delivered` / `envelope.undeliverable` receipts: `SMEMBERS+DEL` in one MULTI, then emit. A crash between the MULTI and the emit loop permanently loses the double-tick / "destroyed" receipt for the sender, whose only other reconciliation is a full manual pull.

Duplicate delivery — the reason the original author deleted up-front — is already handled on every client path, which is what makes peek/emit/remove safe here:

- `src/modules/messenger/webrtc/callDispatcher.ts:138` — missed bubble id is `missed-${d.callId}` ("Stable id makes appendMessage's dedup idempotent across a reconnect replay").
- `src/modules/messenger/webrtc/groupCallRingDispatcher.ts:82-95` — `seenIncomingRoomIds` + `RING_DEDUP_TTL_MS = 60_000` explicitly because "`sfu.ring.incoming` can now REPLAY on reconnect".
- `src/modules/messenger/runtime/productionRuntime.ts:5106` — `stableId: \`missed-group-${d.roomId}\``.
- `envelope.service.ts:403` — "Idempotent on the client, so re-emitting one it already saw is harmless."

## Fix

Three files. No wire-format change, no schema/migration, no new client build required.

### A. `apps/messenger-service/src/gateway/messenger.gateway.ts`

**A1 — import the existing advisory-lock helper** (reuse; do not write a new claim primitive — `runWithReplicaLock` at `apps/messenger-service/src/redis/replica-lock.ts:17` is exactly a `SET key id NX EX ttl` claim with compare-and-delete release).

Anchor (verbatim, current):

```ts
import {RedisService} from '../redis/redis.service';
```

Replace with:

```ts
import {RedisService} from '../redis/redis.service';
import {runWithReplicaLock} from '../redis/replica-lock';
```

**A2 — new constants + key helpers.** Insert immediately after the existing `pendingOfferIndexKey` helper.

Anchor (verbatim, current, `messenger.gateway.ts:2634-2637`):

```ts
/** SET of callIds with queued offers for a (user,device) pair. */
function pendingOfferIndexKey(userId: string, deviceId: number): string {
  return `pending-call-offer-idx:${userId}:${deviceId}`;
}
```

Insert after it:

```ts
// Why: SRV-03 — the drain no longer DELs the index up-front, so this advisory
// claim is what stops two sockets for the same target draining concurrently.
// Short TTL so a holder that crashes mid-drain can't wedge the next ring.
const PENDING_DRAIN_LOCK_TTL_SEC = 10;
function pendingOfferDrainLockKey(userId: string, deviceId: number): string {
  return `pending-call-offer-drain:${userId}:${deviceId}`;
}
function pendingGroupRingDrainLockKey(userId: string): string {
  return `pending-group-ring-drain:${userId}`;
}
```

**A3 — rewrite `deliverPendingCallOffer`.**

Anchor (verbatim, current, whole body `messenger.gateway.ts:556-622`):

```ts
  private async deliverPendingCallOffer(
    client: Socket,
    address: {userId: string; deviceId: number},
  ): Promise<void> {
    try {
      // Drain the SET of queued callIds for this device. The earlier
      // single-slot key silently overwrote the first caller when a
      // second caller dialed within 45s — they saw nothing while their
      // target rang for the second caller. Now we replay every queued
      // offer in arrival order.
      const idxKey = pendingOfferIndexKey(address.userId, address.deviceId);
      const callIds = await this.redis.client.smembers(idxKey);
      if (!callIds || callIds.length === 0) return;
      // SREM the entire index up-front so a parallel reconnect on
      // another socket doesn't double-deliver.
      await this.redis.client.del(idxKey);
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
        } catch { /* skip malformed entry */ }
      }
      records.sort((a, b) => a.at - b.at);
      for (const parsed of records) {
        const ageSec = (Date.now() - parsed.at) / 1000;
        this.logger.log(`replay pending offer cid=${parsed.callId.slice(0, 8)} → ${address.userId.slice(0, 8)}/${address.deviceId} age=${ageSec.toFixed(1)}s`);
        client.emit('call.offer', {
          callId: parsed.callId,
          from:   parsed.from,
          sdp:    parsed.sdp,
          kind:   parsed.kind,
          // Audit S7 — replay the same signed AAD the caller minted; the
          // receiver verifies via verifyCallOfferAuth.
          auth:   parsed.auth,
        });
      }
    } catch (e) {
      this.logger.warn(`pending-offer replay failed: ${(e as Error).message}`);
    }
  }
```

Replacement:

```ts
  private async deliverPendingCallOffer(
    client: Socket,
    address: {userId: string; deviceId: number},
  ): Promise<void> {
    try {
      // Drain the SET of queued callIds for this device. The earlier
      // single-slot key silently overwrote the first caller when a
      // second caller dialed within 45s — they saw nothing while their
      // target rang for the second caller. Now we replay every queued
      // offer in arrival order.
      const idxKey = pendingOfferIndexKey(address.userId, address.deviceId);
      const callIds = await this.redis.client.smembers(idxKey);
      if (!callIds || callIds.length === 0) return;
      // Why: SRV-03 — the drain used to DEL the index, payload and missed-marker
      // BEFORE emitting, so a socket dying mid-drain permanently ate both the
      // ring and the missed-call record. Peek → emit → remove-what-emitted (the
      // pattern the read-receipt queue already uses); an advisory claim replaces
      // the up-front DEL as the concurrent-drain guard.
      await runWithReplicaLock(
        this.redis,
        pendingOfferDrainLockKey(address.userId, address.deviceId),
        PENDING_DRAIN_LOCK_TTL_SEC,
        () => this.drainPendingCallOffers(client, address, callIds),
      );
    } catch (e) {
      this.logger.warn(`pending-offer replay failed: ${(e as Error).message}`);
    }
  }

  /**
   * SRV-03 — read-only pass over the queued offers, then emit, then remove
   * only what actually emitted on a live socket. Anything left behind (dead
   * socket, emit throw, crash) survives in Redis under its original TTL and
   * replays on the next connect; every client path dedups the replay
   * (`missed-<callId>` bubble id, live-session routing by callId).
   */
  private async drainPendingCallOffers(
    client: Socket,
    address: {userId: string; deviceId: number},
    callIds: string[],
  ): Promise<void> {
    const live:    Array<{callId: string; offer: PendingCallOffer}> = [];
    const missed:  Array<{callId: string; marker: MissedCallMarker}> = [];
    const settled: string[] = [];
    for (const cid of callIds) {
      try {
        const [raw, markerRaw] = await this.redis.client.mget(
          pendingOfferKey(address.userId, address.deviceId, cid),
          missedCallMarkerKey(address.userId, address.deviceId, cid),
        );
        const parsed = raw ? JSON.parse(raw) as PendingCallOffer : null;
        if (parsed && (Date.now() - parsed.at) / 1000 <= 45) {
          live.push({callId: cid, offer: parsed});
          continue;
        }
        // N-02 — no live offer (expired, or the caller hung up and we purged
        // the payload but kept the marker). A surviving marker means the callee
        // genuinely missed the call.
        if (markerRaw) {
          missed.push({callId: cid, marker: JSON.parse(markerRaw) as MissedCallMarker});
          continue;
        }
        settled.push(cid);
      } catch {
        // Malformed entry is never deliverable — settle it so it can't wedge
        // the index for the full marker TTL.
        settled.push(cid);
      }
    }
    missed.sort((a, b) => a.marker.at - b.marker.at);
    live.sort((a, b) => a.offer.at - b.offer.at);
    for (const {callId, marker} of missed) {
      if (!client.connected) break;
      try {
        client.emit('call.missed', {callId: marker.callId, from: marker.from, kind: marker.kind, at: marker.at});
        settled.push(callId);
      } catch { /* emit threw — leave it queued for the next connect */ }
    }
    for (const {callId, offer} of live) {
      if (!client.connected) break;
      const ageSec = (Date.now() - offer.at) / 1000;
      this.logger.log(`replay pending offer cid=${offer.callId.slice(0, 8)} → ${address.userId.slice(0, 8)}/${address.deviceId} age=${ageSec.toFixed(1)}s`);
      try {
        client.emit('call.offer', {
          callId: offer.callId,
          from:   offer.from,
          sdp:    offer.sdp,
          kind:   offer.kind,
          // Audit S7 — replay the same signed AAD the caller minted; the
          // receiver verifies via verifyCallOfferAuth.
          auth:   offer.auth,
        });
        settled.push(callId);
      } catch { /* emit threw — leave it queued for the next connect */ }
    }
    for (const cid of settled) {
      await this.clearPendingCallArtifacts(address.userId, address.deviceId, cid);
    }
  }
```

Note the reuse: removal goes through the existing `clearPendingCallArtifacts(userId, deviceId, callId)` (`messenger.gateway.ts:1337`), whose default (`keepMarker` unset) deletes payload + marker + index membership — exactly the three keys the old inline code deleted, and it keeps the P1-15/P2-13 invariant in one place.

**A4 — rewrite `deliverPendingGroupRing` the same way.**

Anchor (verbatim, current, `messenger.gateway.ts:631-684`) — the body from `private async deliverPendingGroupRing(` through its closing `}`; replacement:

```ts
  private async deliverPendingGroupRing(
    client: Socket,
    address: {userId: string},
  ): Promise<void> {
    try {
      const idxKey = pendingGroupRingIndexKey(address.userId);
      const roomIds = await this.redis.client.smembers(idxKey);
      if (!roomIds || roomIds.length === 0) return;
      // Why: SRV-03 — see drainPendingCallOffers; same destructive-drain fix.
      await runWithReplicaLock(
        this.redis,
        pendingGroupRingDrainLockKey(address.userId),
        PENDING_DRAIN_LOCK_TTL_SEC,
        () => this.drainPendingGroupRings(client, address.userId, roomIds),
      );
    } catch (e) {
      this.logger.warn(`pending group-ring replay failed: ${(e as Error).message}`);
    }
  }

  /** SRV-03 — peek → emit → remove-what-emitted for queued group rings. */
  private async drainPendingGroupRings(
    client: Socket,
    userId: string,
    roomIds: string[],
  ): Promise<void> {
    const live:    Array<{roomId: string; ring: PendingGroupRing}> = [];
    const missed:  Array<{roomId: string; marker: MissedGroupCallMarker}> = [];
    const settled: string[] = [];
    for (const rid of roomIds) {
      try {
        const [raw, markerRaw] = await this.redis.client.mget(
          pendingGroupRingKey(userId, rid),
          missedGroupCallMarkerKey(userId, rid),
        );
        const parsed = raw ? JSON.parse(raw) as PendingGroupRing : null;
        if (parsed && (Date.now() - parsed.at) / 1000 <= 45) {
          live.push({roomId: rid, ring: parsed});
          continue;
        }
        if (markerRaw) {
          missed.push({roomId: rid, marker: JSON.parse(markerRaw) as MissedGroupCallMarker});
          continue;
        }
        settled.push(rid);
      } catch {
        settled.push(rid);
      }
    }
    missed.sort((a, b) => a.marker.at - b.marker.at);
    live.sort((a, b) => a.ring.at - b.ring.at);
    for (const {roomId, marker} of missed) {
      if (!client.connected) break;
      try {
        client.emit('sfu.ring.missed', {
          roomId: marker.roomId, conversationId: marker.conversationId,
          from: marker.from, callType: marker.callType, at: marker.at,
        });
        settled.push(roomId);
      } catch { /* leave queued for the next connect */ }
    }
    for (const {roomId, ring} of live) {
      if (!client.connected) break;
      this.logger.log(`replay pending group-ring rid=${ring.roomId.slice(0, 8)} → ${userId.slice(0, 8)}`);
      try {
        client.emit('sfu.ring.incoming', {
          roomId:         ring.roomId,
          conversationId: ring.conversationId,
          callType:       ring.callType,
          from:           ring.from,
          callerName:     ring.callerName,
          roomToken:      ring.roomToken,
          roomTokenExp:   ring.roomTokenExp,
        });
        settled.push(roomId);
      } catch { /* leave queued for the next connect */ }
    }
    for (const rid of settled) {
      await this.clearPendingGroupRingArtifacts(userId, rid);
    }
  }
```

Again reusing the existing `clearPendingGroupRingArtifacts(userId, roomId)` (`messenger.gateway.ts:687`), which already DELs payload + marker and SREMs the index.

### B. `apps/messenger-service/src/relay/envelope.store.ts`

Add non-destructive primitives beside the existing read-receipt ones and delete the two destructive drains they replace.

Anchor (verbatim, current, `envelope.store.ts:387-396` and `:411-416`):

```ts
  async takePendingDelivered(userId: string): Promise<string[]> {
    const key = `delivered-pending:${userId}`;
    // Audit MEDIUM-4 — atomic drain. SMEMBERS-then-DEL as separate round-trips
    // lost any envelopeId added between the two calls. In a MULTI they execute
    // with nothing interleaved, so the DEL removes exactly what SMEMBERS read.
    const res = await this.redis.client.multi().smembers(key).del(key).exec();
    // res = [[err, string[]], [err, number]]; guard the shape defensively.
    const smembersReply = res?.[0]?.[1];
    return Array.isArray(smembersReply) ? (smembersReply as string[]) : [];
  }
```

Replace with:

```ts
  // Audit SRV-03 — non-destructive drain, same contract as the read-receipt
  // peek/remove pair below: the caller emits each id and removes only what
  // emitted, so a crash between the read and the emit can no longer destroy a
  // sender's double-tick. The key keeps its 7-day EXPIRE, so an entry that
  // never delivers still ages out.
  async peekPendingDelivered(userId: string): Promise<string[]> {
    return this.redis.client.smembers(`delivered-pending:${userId}`);
  }
  async removePendingDelivered(userId: string, envelopeIds: string[]): Promise<void> {
    if (envelopeIds.length === 0) return;
    await this.redis.client.srem(`delivered-pending:${userId}`, ...envelopeIds);
  }
```

And anchor (verbatim, current):

```ts
  async takePendingUndeliverable(userId: string): Promise<string[]> {
    const key = `undeliverable-pending:${userId}`;
    const res = await this.redis.client.multi().smembers(key).del(key).exec();
    const smembersReply = res?.[0]?.[1];
    return Array.isArray(smembersReply) ? (smembersReply as string[]) : [];
  }
```

Replace with:

```ts
  async peekPendingUndeliverable(userId: string): Promise<string[]> {
    return this.redis.client.smembers(`undeliverable-pending:${userId}`);
  }
  async removePendingUndeliverable(userId: string, envelopeIds: string[]): Promise<void> {
    if (envelopeIds.length === 0) return;
    await this.redis.client.srem(`undeliverable-pending:${userId}`, ...envelopeIds);
  }
```

(`takePendingReadReceipts` at `:433` is pre-existing dead code — out of scope, leave it.)

### C. `apps/messenger-service/src/relay/envelope.service.ts`

Anchor (verbatim, current, `envelope.service.ts:406-423`):

```ts
try {
  const ids = await this.store.takePendingDelivered(addr.userId);
  for (const envelopeId of ids) {
    this.hub.emitToDevice(addr, 'envelope.delivered', {envelopeId});
  }
} catch (e) {
  this.logger.warn(
    `[RELAY-C3] flushPendingDelivered failed for ${addr.userId}: ${(e as Error).message}`,
  );
}
// Handoff §3.6(c) — replay queued `envelope.undeliverable` receipts
// the same way. Client's applyEnvelopeUndeliverable is idempotent.
try {
  const ids = await this.store.takePendingUndeliverable(addr.userId);
  for (const envelopeId of ids) {
    this.hub.emitToDevice(addr, 'envelope.undeliverable', {envelopeId});
  }
} catch (e) {
  this.logger.warn(
    `[3.6c] flushPendingUndeliverable failed for ${addr.userId}: ${(e as Error).message}`,
  );
}
```

Replacement:

```ts
// Audit SRV-03 — non-destructive drain (same shape as the F7 read-receipt
// block below): emit first, remove only what emitted. A crash or an emit
// throw used to destroy the receipt permanently.
try {
  const settled: string[] = [];
  for (const envelopeId of await this.store.peekPendingDelivered(addr.userId)) {
    try {
      this.hub.emitToDevice(addr, 'envelope.delivered', {envelopeId});
      settled.push(envelopeId);
    } catch {
      /* emit threw — leave this entry queued for the next drain */
    }
  }
  await this.store.removePendingDelivered(addr.userId, settled);
} catch (e) {
  this.logger.warn(
    `[RELAY-C3] flushPendingDelivered failed for ${addr.userId}: ${(e as Error).message}`,
  );
}
// Handoff §3.6(c) — replay queued `envelope.undeliverable` receipts
// the same way. Client's applyEnvelopeUndeliverable is idempotent.
try {
  const settled: string[] = [];
  for (const envelopeId of await this.store.peekPendingUndeliverable(addr.userId)) {
    try {
      this.hub.emitToDevice(addr, 'envelope.undeliverable', {envelopeId});
      settled.push(envelopeId);
    } catch {
      /* emit threw — leave this entry queued for the next drain */
    }
  }
  await this.store.removePendingUndeliverable(addr.userId, settled);
} catch (e) {
  this.logger.warn(
    `[3.6c] flushPendingUndeliverable failed for ${addr.userId}: ${(e as Error).message}`,
  );
}
```

### Wire format / back-compat / schema

- **No wire change.** `call.offer`, `call.missed`, `sfu.ring.incoming`, `sfu.ring.missed`, `envelope.delivered`, `envelope.undeliverable` keep identical shapes and identical fields. Server-only change; deploys ahead of clients with zero client work.
- **The only observable difference for an old client is a possible duplicate replay** in the narrow "emitted but removal failed" window. Every path already dedups: `missed-${callId}` (`callDispatcher.ts:138`), `missed-group-${roomId}` (`productionRuntime.ts:5106`), `seenIncomingRoomIds` 60s guard (`groupCallRingDispatcher.ts:82`), `applyEnvelopeDelivered` documented idempotent (`envelope.service.ts:403`).
- **No schema, no migration, no SQLCipher version bump.** All state is Redis keys that already exist; no key names change, no TTLs change (45s payloads, 6h markers, 7-day receipt sets all untouched — so the 30-day dwell contract is untouched too).
- **No security check touched.** The `auth` block is still replayed verbatim (Audit S7) and the client still runs `verifyCallOfferAuth` unchanged; nothing widens a freshness window. Nothing new is logged beyond the existing truncated callId/roomId/userId prefixes.

## Blast radius

Files/functions:

- `apps/messenger-service/src/gateway/messenger.gateway.ts` — `deliverPendingCallOffer`, `deliverPendingGroupRing` (rewritten), new private `drainPendingCallOffers` / `drainPendingGroupRings`, new module-level `PENDING_DRAIN_LOCK_TTL_SEC` + two key helpers, one new import. Both entry points are still `void`-called from `handleConnection:540,543` — signatures unchanged.
- `clearPendingCallArtifacts` / `clearPendingGroupRingArtifacts` gain a new caller (the drain). No signature change; their other callers (answer at `:1325`, hangup/decline at `:1990`, `:2538`) are untouched. Their P1-15/P2-13 `keepMarker` behaviour is unchanged and is now the single place index/marker removal happens.
- `apps/messenger-service/src/relay/envelope.store.ts` — two destructive methods removed, four peek/remove methods added. `takePendingDelivered`/`takePendingUndeliverable` have exactly one caller each (`envelope.service.ts:407,417`); grep confirms no spec calls them directly.
- `apps/messenger-service/src/relay/envelope.service.ts` — `flushPendingDelivered` only. Its sole production caller is `messenger.gateway.ts:546`.
- Client: **no changes.**

Overlapping findings (coordinate edits):

- **SRV-02** (persist ringing call-session state in Redis) touches the same `pending-call-offer:*` / `missed-call-marker:*` key family and the same connect-time path — merge conflicts likely in `deliverPendingCallOffer`.
- **SYNC-5** (raise `MISSED_CALL_MARKER_TTL_SEC` above 6h, or mint the missed call as a real E2EE envelope) edits the marker TTL and, in the envelope variant, may delete this whole `call.missed` drain lane. Land SRV-03 first — it is the smaller, contract-neutral change — then let SYNC-5 rebase onto it.
- Any finding editing `handleConnection` (auth-refresh / presence work) sits 40 lines above.
- **SRV-04** and other gateway P2s in the same 2784-line file: textual conflicts only.

What could regress:

- **Double ring.** Two sockets for the same target draining concurrently. Mitigated by the `NX EX 10` claim (which replaces the old up-front DEL) plus the client dedups above.
- **Index leak.** If entries with neither payload nor marker were not settled, the 6h index would be rescanned on every connect. `settled.push(cid)` in both the "nothing to deliver" and the malformed-JSON branches covers this; the index itself still carries its 6h EXPIRE.
- **Delayed ring for a second device.** With the group-ring lock held by device A (per-user key), device B connecting inside the 10s window gets nothing this connect. Previously B also got nothing (A had already DEL'd the index), so this is not a new hole, but it is now a _deferral_ rather than a loss.
- **`client.connected` in tests.** `fakeClient()` in `messenger.gateway.calls.spec.ts:33` has no `connected` field; any test that reaches the drain must set `connected: true` or the drain correctly no-ops.

## Tests

Follow the existing layout: `apps/messenger-service` has its own Jest project (`cd apps/messenger-service && npm test`); gateway specs invoke handlers off the prototype with a hand-built `this` and a fake ioredis client, relay specs use `ioredis-mock` through Nest DI.

### 1. `apps/messenger-service/src/gateway/messenger.gateway.calls.spec.ts` (existing file, new describe)

Add `connected: true` to the shared `fakeClient()` helper, then:

```ts
describe('SRV-03 — connect-time ring drain is non-destructive', () => { … });
```

Harness: a fake redis client backed by a `Map` supporting `smembers`, `mget`, `del`, `srem`, `get`, and `set(key, val, 'EX', n, 'NX')` (returns `'OK'` only when absent — mirror `vault/mfa.guard.spec.ts:51`), a `self` with `{redis, logger: {log(){}, warn(){}}, clearPendingCallArtifacts, clearPendingGroupRingArtifacts, drainPendingCallOffers: proto.drainPendingCallOffers, drainPendingGroupRings: proto.drainPendingGroupRings}`.

Assertions:

1. **dead socket keeps the ring** — one fresh queued offer, `fakeClient()` with `connected: false`; after `deliverPendingCallOffer`, `emit` was never called AND `pending-call-offer-idx:*` still contains the callId AND the `missed-call-marker:*` key still exists.
2. **emit throw keeps the ring** — `emit` throws once; index + marker survive; a second `deliverPendingCallOffer` on a healthy socket emits `call.offer` exactly once and _then_ the index/payload/marker are gone.
3. **happy path** — fresh offer (`at: Date.now()`) → emits `call.offer` with `auth` preserved verbatim, then `clearPendingCallArtifacts` called with `(user, device, callId)`.
4. **expired payload, surviving marker** — no payload key, marker present → emits `call.missed` with `{callId, from, kind, at}`, then settles.
5. **empty entry settles** — index entry with neither payload nor marker → no emit, but `clearPendingCallArtifacts` still called (no index leak).
6. **concurrent drain is claimed once** — with the lock key pre-set, `deliverPendingCallOffer` emits nothing and removes nothing.
7. **group analogue** — `sfu.ring.missed` survives a `connected: false` socket; and on a live socket it emits then calls `clearPendingGroupRingArtifacts(userId, roomId)`.

### 2. `apps/messenger-service/src/relay/envelope.service.spec.ts` (existing file)

Mirror the existing "folded-P2" pair at `:953-990`:

```ts
  it('SRV-03 — a queued envelope.delivered survives an emit failure and replays on the next flush', async () => { … });
  it('SRV-03 — a queued envelope.undeliverable survives an emit failure and replays', async () => { … });
```

Assertions: after `service.ack(...)` and clearing `hub.emits`, spy `emitToDevice` to throw once → `await redis.scard('delivered-pending:alice')` is `1` and no `envelope.delivered` frame; second `flushPendingDelivered` → exactly one frame and `scard` is `0`. Same for `undeliverable-pending:alice` (ack with `'discarded'`).

Existing tests that must still pass unchanged: `envelope.service.spec.ts:582` ("offline sender gets the queued undeliverable"), `:603` / `:620` (F7 read receipts), `messenger.gateway.calls.spec.ts:112` (P1-15/P2-13 `keepMarker`).

### 3. Gates

- `cd apps/messenger-service && npm test` (direct + regression).
- `npm run test:crypto` from the repo root — unaffected but it is the standing regression suite for anything on the messenger path.
- `npm run typecheck` (mobile baseline 47) — untouched by a server-only change, run it anyway per the change-safety gates.
- Device probe: two BlueStacks accounts — call an offline device, kill the app mid-connect (adb force-stop right as the WS opens), relaunch, confirm the missed-call bubble + notification still arrive. That is the exact scenario the old code lost.

## Risk

Things a reviewer should be suspicious of:

1. **This narrows the loss window; it does not eliminate it.** `client.emit` returning without throwing is _not_ proof the client received the frame. If the socket dies immediately after the emit, we still remove and still lose the record. The honest complete fix is a client ack (`client.timeout(ms).emit(ev, data, cb)`), which cannot ship unconditionally: an old client never invokes the ack, so the entry would replay on every reconnect for the marker's full 6h and re-fire `showMissedCallNotif` each time. **Follow-up:** gate an acked drain on a client-capability flag in the handshake `auth` payload, then flip the default once the fleet has moved. Land the peek/emit/remove increment now.
2. **The advisory claim is a behaviour swap, not a strict improvement.** It is not held across the whole reconnect, only the drain. Verify `runWithReplicaLock`'s `finally` really releases on the early-`break` path (it does — the release is in `finally`, not after `fn()`), or a crashed pod parks the ring for 10s.
3. **Duplicate `call.offer` into a live signalling session.** In the "emit ok, removal failed" window the offer can be re-emitted within its 45s TTL, and `callDispatcher.ts:216` routes it into an existing `sig.ingest`, i.e. a second `setRemoteDescription` on a session that may no longer be in `have-remote-offer`. Currently harmless (the handler loop swallows throws at `signallingClient.ts:84`) but not _designed_ to be idempotent. If a reviewer wants belt-and-braces, add a 60s `seenOfferIds` guard in `callDispatcher` mirroring `seenIncomingRoomIds` — separate, client-side, and not required for this fix.
4. **`mget` replaces two `get`s.** Confirm the fake redis in the gateway spec implements `mget` (it is not in the current `calls.spec` fakes) and that ioredis's `mget` returns `(string | null)[]` positionally — the destructure assumes it.
5. **Ordering change.** Missed records now emit before live offers, both chronologically sorted, whereas the old code emitted missed records in arbitrary SET order interleaved with the read pass. This is a deliberate improvement (the ring surface lands last) but it is a visible behaviour change in the Calls log ordering.
6. **Architecture:** constraint #10 for this batch explicitly permits this ("removal must still happen on ack, no unbounded re-ring; bounded redelivery"). Removal still happens; redelivery is bounded by the unchanged 45s / 6h / 7-day TTLs; no freshness or cert check is widened. Nothing here needs an architecture amendment.
