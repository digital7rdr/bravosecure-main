# Scaling & Multi-Replica Runbook — messenger-service

**Owner:** platform · **Last updated:** 2026-07-02 · **Status:** code is multi-replica-_ready_; SFU horizontal sharding is the one remaining infra epic.

This is the contract between the messenger-service **code** and the **infrastructure** it runs on. It exists because the service holds per-process state; the load balancer and orchestrator MUST be configured as described below or calls and rate limits break at >1 replica.

Derived from the 2026-07-02 production-readiness audit (findings HIGH-1/2/3, MEDIUM-3). Each code-side fix below is already merged.

---

## 1. What the code now guarantees at N replicas (fixed 2026-07-02)

| Concern                                                                                              | Before                                                              | Now                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cron jobs** (envelope-sweep, relay orphan-sweep, archive-sweep, archive-retry, media orphan-sweep) | ran on **every** replica → N× Redis SCANs, N× R2 delete storms      | each wrapped in a Redis advisory lock (`runWithReplicaLock`, `apps/messenger-service/src/redis/replica-lock.ts`) → exactly one replica per tick |
| **Per-user abuse limit** (`envelope.send`, `sfu.join`)                                               | per-socket in-memory only → bypassed by opening sockets across pods | cluster-global Redis fixed-window counter (`userRateExceeded`) on top of the per-socket limiter                                                 |
| **Redis client**                                                                                     | stopped reconnecting on some failover paths; no readiness signal    | infinite capped-backoff `retryStrategy`, `reconnectOnError` on READONLY/reset, `/ready` probe returns 503 when Redis is down                    |
| **Delivered-receipt queue**                                                                          | non-atomic SADD/EXPIRE (TTL leak) + SMEMBERS/DEL race               | atomic `MULTI`, capped set size                                                                                                                 |

---

## 2. Infra requirements — MUST configure before scaling past 1 replica

### 2.1 Redis (HIGH-3)

- Use **managed Redis with automatic failover** (Sentinel or Cluster). The client follows a `redis+sentinel://` / cluster endpoint via `REDIS_URL` with **no code change**.
- Redis is the shared plane for: envelope store, presence, JTI allowlist, ack tokens, media grants, per-user rate counters, cron locks, delivered-receipt queue, **and the socket.io cross-pod adapter**. Its availability = the messenger's availability. Size for the connection count (100k WS ⇒ ~2–3 Redis connections/pod × N pods + pub/sub).

### 2.2 Load balancer / readiness

- Point the readiness check at **`GET /ready`** (503 = drain this pod; it has lost Redis). Keep liveness on **`GET /healthz`** (process up) so the orchestrator restarts a dead process but merely stops routing to a Redis-partitioned one.
- WebSocket upgrade must be allowed; long-lived connections; idle timeout ≥ the WS ping cadence.

### 2.3 SFU sticky routing (HIGH-1 — the blocker)

The SFU **control plane is per-process**: a room's mediasoup Router, its transports, and the participant set live on **one pod**. The socket.io Redis adapter fans out _broadcasts_ cross-pod, but `sfu.join / produce / consume / restartIce` MUST reach the pod that owns the Router.

Until the SFU is sharded (§3), you MUST **either**:

- **(a) run the SFU as a single replica** (current posture — safe, but caps concurrent group-call participants to one node's capacity, ~a few hundred, _not_ 2k rooms), **or**
- **(b) split the SFU into its own tier with roomId-sticky routing**: the LB routes a group-call socket to the pod that owns its `roomId` (consistent-hash on roomId, or a room→pod directory in Redis that the gateway consults on join). The 1:1 chat/relay tier can scale freely (stateless w.r.t. Redis); only the SFU tier needs stickiness.

> ⚠️ Do **not** put >1 replica behind a round-robin LB with the SFU enabled and no sticky routing: a mid-call reconnect landing on a different pod isolates the user on an empty room (the leave-grace timer on the original pod, `messenger.gateway.ts:227`, is per-process and cannot be cancelled cross-pod).

---

## 3. Remaining infra epic — shard the SFU (to hit 2k concurrent group calls)

One mediasoup node cannot serve 2k concurrent group calls. Target architecture:

1. **Dedicated SFU tier**, horizontally scaled, addressed by `roomId`.
2. **Room→pod directory in Redis** (`sfuroom:{roomId} → podId`) written at room create, read by the gateway to proxy/redirect control frames — or LB-level consistent-hash on roomId.
3. **Sticky group-call sockets** so all of a participant's SFU frames hit the owning pod.
4. Optionally **cascade/relay** between SFU nodes for very large rooms.

This is the only item preventing the stated 2k-group-call / 10k-call target. Everything else in §1–§2 is done or a config task.

---

## 4. Pre-scale checklist

- [ ] Redis is managed + failover-tested (kill primary, confirm reconnect + `/ready` recovers).
- [ ] LB readiness → `/ready`, liveness → `/healthz`.
- [ ] SFU is single-replica **or** sharded with roomId-sticky routing (§2.3).
- [ ] Confirm exactly one replica wins each cron (grep logs for `presence-reaper skip` / lock contention).
- [ ] Load-test per-user rate limits across 2 pods (one user, two sockets, two pods → still capped).
