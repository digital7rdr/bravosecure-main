# Call-state scaling constraint (WI-6.8 — documented, deliberately NOT built)

**Status: single-replica REQUIRED for `messenger-service`. This is enforced at
boot, not merely documented. Do not scale the service horizontally without
doing the promotion work below.**

## The constraint

Five pieces of live call state are **per-process** in `messenger-service`:

| State                                                               | Where                                    | What breaks across pods                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `callSessions` (1:1 sessions, `answeredBy` arbitration, tombstones) | `gateway/messenger.gateway.ts`           | A `call.answer` landing on a pod without the session is silently dropped by `authorizeCallFrame` → every cross-pod call strands at "Answering…". The WI-6.1 first-answer arbitration and `call.sync` (WI-6.6) answer from the wrong pod's empty map. |
| Disconnect-bye grace timers (`callDisconnectGrace`)                 | same                                     | A reconnect on another pod can't cancel the timer → spurious `call.hangup{failed}` mid-call.                                                                                                                                                         |
| In-process pending answers (`pendingAnswers`)                       | same                                     | Held answers never flush for a caller reconnecting to another pod (the Redis-durable half covers restarts, not affinity).                                                                                                                            |
| SFU rooms / participants / leave grace / join reservations (WI-6.4) | `sfu/sfu.service.ts`                     | mediasoup routers are process-bound by nature; `hostOf`, the join cap and ring authority answer wrong on any other pod.                                                                                                                              |
| Session-aware adapter bookkeeping                                   | `gateway/session-aware-redis-adapter.ts` | Presence/lease accounting splits.                                                                                                                                                                                                                    |

The WS **fan-out** already rides the cluster-ready Redis adapter, which is what
makes an accidental scale-out _silent_: frames still route, but every guard
above them evaporates.

## What enforces it today

`redis/replica-guard.service.ts` (AUDIT-2026-08-13 #3/#10): each instance
claims `messenger:single-replica:claim` (`SET NX`, 15 s TTL + heartbeat) at
bootstrap. A second live replica **refuses to boot** after a 45 s window
(absorbs rolling restarts) with a loud error naming this constraint — a
startup warning in the strongest possible form. `REPLICA_GUARD=off` is the
logged ops escape hatch; a Redis error fails OPEN so the only replica always
boots.

## Options when scale-out is actually needed

1. **Sticky sessions (cheapest).** Pin caller+callee (and every SFU room
   member) to one pod — e.g. LB affinity by userId-hash won't do (two users
   hash differently); it must be per-_call_ routing, which in practice means a
   room→pod / call→pod lookup layer in front of the adapter. Viable for the
   SFU (rooms are already single-router); awkward for 1:1, where either
   participant may connect anywhere.
2. **Redis promotion (the field comment's own plan).** Promote `callSessions`
   to Redis with a ~5-min expiry (sessions are short-lived; a relay restart
   legitimately ends calls). The arbitration write (WI-6.1 first-answer) must
   become atomic (`SET NX` / `HSETNX` on `answeredBy`), the tombstone check a
   Redis read, and the grace timers either Redis-scheduled or accepted as
   per-pod best-effort. SFU rooms stay pod-bound regardless — they need
   room→pod affinity from option 1 anyway.
3. **Hybrid (likely end state).** Redis-backed `callSessions` for 1:1
   correctness on any pod + room→pod affinity for the SFU.

Until one of these is built and verified, the replica guard stays. Tracked in
`docs/planning/REMAINING_TODO.md`.
