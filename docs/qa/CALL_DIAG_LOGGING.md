# Call diagnostics logging (WI-7.1 / WI-7.2 — 2026-08-18)

The whole call lifecycle — client and server — reconstructs from logs alone.
IDs and enums only, everywhere: no names, no SDP, no candidate bodies, no
tokens, no key material (`logAudit.test.ts` scans the client directories).

## Client — `[CALLSM]` (survives RELEASE builds)

`console.warn` is deliberate: the release babel transform strips `log` and
keeps `warn`, and release is the only build worth measuring.

```bash
adb logcat -s ReactNativeJS | grep CALLSM
```

| Line                                                                      | Emitted by                                                           | Meaning                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `[CALLSM] transition cid=… gen=… prev=… next=… event=… source=controller` | `callController.setState` (via `runtime/callDiag.logCallTransition`) | every ACCEPTED state transition                                     |
| `[CALLSM] illegal prev→next src=…`                                        | `callController.setState`                                            | REJECTED transition (state table); long-standing pinned form        |
| `[bravo.callController] setState(...) ignored — already terminal`         | `callController.setState`                                            | terminal absorption (legacy pinned form, same lane)                 |
| `[CALLSM] registry.end / registry.end.reentered / registry.end.dropped …` | `runtime/callRegistry`                                               | keyed teardown accepted / re-entered / stale-key-dropped            |
| `[CALLSM] <group registry events>`                                        | `runtime/groupCallRegistry`                                          | group keyed writes + teardown                                       |
| `[CALLSM] latch.accept cid=…`                                             | `push/fcmBootstrap.markAccepted`                                     | this device claimed the Answer                                      |
| `[CALLSM] notif.cancel.apply cid=… missed=…`                              | `push/fcmBootstrap.handleCallCancel`                                 | the cancel funnel APPLIED (each ignore branch warns its own reason) |

Companion lanes: `[CALLDIAG]` (ring dispatch/routing), `[KEYDIAG]`,
`[LAGDIAG]` — all warn-channel, all release-surviving.

## Server — `[CALL]` / `[SFU]` (messenger-service stdout / `docker logs`)

| Line                                                    | Site                   | Meaning                                   |
| ------------------------------------------------------- | ---------------------- | ----------------------------------------- | ---------------- |
| `[CALL] session cid=… -→ringing src=offer               | rehydrate`             | `trackCallStart` / `rehydrateCallSession` | 1:1 session born |
| `[CALL] session cid=… ringing→active src=answer by=…`   | `trackCallAnswer`      | arbitration winner recorded               |
| `[CALL] session cid=… …→ended src=hangup`               | `trackCallEnd`         | tombstoned                                |
| `[CALL] OFFER / ANSWER / ICE / HANGUP …`                | frame handlers         | per-frame relay records (pre-existing)    |
| `[SFU] room.create rid=… cid=… host=…`                  | `createRoom`           | room born                                 |
| `[SFU] join rid=… uid=… tag=… n=… host=…`               | `joinRoom`             | successful join (the B-346 gap)           |
| `[SFU] leave rid=… tag=… n=…`                           | `leaveRoom`            | leave, room survives                      |
| `[SFU] room.close rid=… reason=host-left\|last-leave …` | `leaveRoom`            | room torn down                            |
| `[SFU] room.reap n=…`                                   | zombie sweep           | idle rooms reaped                         |
| `[SFU] ring wake summary … pushed=… throttled=… dark=…` | ring fan-out           | per-fan-out delivery summary (B-239)      |
| `[SFU] ring-decline rid=… by=…`                         | `handleSfuRingDecline` | authorized decline applied                |
| `[SFU] host-handoff rid=… → … (claiming join failed)`   | join rollback          | host authority moved (KO-6)               |
| `router-close reconcile: purged room=… participants=…`  | `onRouterClosed`       | worker death reconcile                    |

Volume is O(lifecycle events) — nothing logs per-frame in a media or ICE hot
loop beyond the pre-existing `[CALL] ICE` relay line.

## Pinned by

`callDiagTransition.test.ts` (format + wiring scans), `callStateMachine.test.ts`
(rejected forms), `logAudit.test.ts` (hygiene). Server lines are asserted
incidentally by the gateway/SFU specs; keep new lines ids-and-enums-only.
