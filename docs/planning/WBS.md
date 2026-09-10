# Bravo Secure — Phase 1 WBS (actual status)

> Generated 2026-04-19. Verified against the code in `apps/` + `src/modules/`.
> Use this to refresh the spreadsheet. Rows that differ from your sheet flagged **[SHEET STALE]**.

---

## BE-2 · Messenger Core — Signal Protocol `Sprint 3–4  ·  100%`

| WBS        | Task                                           | Status      | %    | File evidence                                                                                                                                                                           |
| ---------- | ---------------------------------------------- | ----------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BE-2.1** | libsignal server-side relay + key distribution | ✅ Complete | 100% | `apps/auth-service/src/keys/` (upload/bundle), `apps/messenger-service/src/relay/envelope.service.ts`                                                                                   |
| **BE-2.2** | Sealed sender + sender certificate signing     | ✅ Complete | 100% | `apps/auth-service/src/sender-cert/*`, `src/modules/messenger/crypto/sealedSender.ts`, `src/modules/messenger/runtime/certCache.ts`                                                     |
| **BE-2.3** | WebSocket gateway                              | ✅ Complete | 100% | `apps/messenger-service/src/gateway/messenger.gateway.ts` + `connection-registry.ts`. **Delta:** raw `ws` (not Socket.io), in-memory registry (no Redis adapter yet — single-node only) |
| **BE-2.4** | Presence, typing indicators, read receipts     | ✅ Complete | 100% | `messenger.gateway.ts` handles `typing.start/stop`, `presence.*`, `envelope.read`; fan-out via `ConnectionRegistry`                                                                     |

Phase-1 deltas documented:

- OPK pool auto-replenish fires client-side only (spec says server can warn when pool < 10 → `X-Pre-Key-Count` header already present; client-initiated re-upload deferred to M12).
- Sealed Sender cert TTL currently 1 h (env `SENDER_CERT_TTL_SECONDS`; 24 h per spec — one env flip).

---

## BE-3 · Group Chat, Files & File Vault `Sprint 5  ·  100%`

| WBS        | Task                                        | Status      | %    | File evidence                                                                                                                                                                 |
| ---------- | ------------------------------------------- | ----------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BE-3.1** | Group messaging (sealed-sender broadcast)   | ✅ Complete | 100% | `src/modules/messenger/groups/groupClient.ts` — pairwise fan-out, N-1 ciphertexts, master-key per GroupState, admin rekey. Zero server-side group state.                      |
| **BE-3.2** | files-service: S3 pre-signed URL generation | ✅ Complete | 100% | `apps/messenger-service/src/media/media.service.ts` — R2/S3-compatible, TTL 60 s, single-use, served behind `JwtHttpGuard`                                                    |
| **BE-3.3** | File Vault MFA gate                         | ✅ Complete | 100% | `apps/messenger-service/src/vault/mfa.guard.ts` — requires fresh action-token (`X-Action-Token` header, HS256, 5-min TTL, single-use from Redis). Audit log in `audit.log.ts` |

---

## BE-4 · WebRTC Voice & Video Calls `Sprint 6–7  ·  ~70%`

| WBS        | Task                                | Status (sheet) | Status (actual)                   | %    | Notes                                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------- | -------------- | --------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **BE-4.1** | signalling-service: SDP/ICE relay   | Complete       | ✅ Complete                       | 100% | Pure WS relay via `call.offer` / `call.answer` / `call.ice` frames in `messenger.gateway.ts`. Server never parses SDP.                                                                                                                                                                           |
| **BE-4.2** | TURN credential issuance API        | Not Started    | ✅ **Complete** **[SHEET STALE]** | 100% | `apps/messenger-service/src/turn/turn.controller.ts` — `GET /webrtc/turn-credentials`, HMAC-SHA1 24 h creds per coturn REST spec. `TURN_STATIC_AUTH_SECRET` + `TURN_URLS` in env. Spec `turn.service.spec.ts` passes.                                                                            |
| **BE-4.3** | VoIP push notifications (APNs/FCM)  | Not Started    | 🟡 **Scaffold** **[SHEET STALE]** | 40%  | `apps/messenger-service/src/push/push.service.ts` — **registration** endpoint + separate DATA / VOIP token channels are live. **Delivery** (real APNs p8 auth, FCM high-priority dispatch, bundle-id match, retries) deferred to Phase-2. Wake-only payload contract enforced by log-audit test. |
| **BE-4.4** | Group call SFU scaffold (mediasoup) | Not Started    | 🟡 **Scaffold**                   | 15%  | `apps/messenger-service/src/sfu/sfu.service.ts` — every method throws `NotImplementedException` with an in-file Phase-2 checklist. `sfu.types.ts` shapes are stable so the RN client can compile against them.                                                                                   |

---

## Additional work completed this sprint (not in original WBS)

These all shipped today against the spec's Definition-of-Done but didn't have dedicated WBS rows:

| Item                                                                  | Status | Evidence                                                                                                                          |
| --------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Disappearing messages — client-side burn animation + sweeper          | ✅     | `src/screens/messenger/ChatScreen.tsx` (burn anim), `src/modules/messenger/runtime/expirySweeper.ts` (1 s poll)                   |
| Disappearing messages — **server-side** Redis TTL + 5-min orphan cron | ✅     | `apps/messenger-service/src/relay/envelope.service.ts` `@Cron(EVERY_5_MINUTES)` + `expiresAtSec` accepted on DTO                  |
| Client message persistence (AsyncStorage, zustand/persist)            | ✅     | `src/modules/messenger/store/messengerStore.ts`                                                                                   |
| quick-crypto HMAC polyfill shim (fixes libsignal HKDF)                | ✅     | `src/modules/messenger/crypto/polyfills.ts`                                                                                       |
| Client tab-bar hide during chat + call (immersion)                    | ✅     | `MainNavigator.CustomTabBar` reads `tabBarStyle.display`                                                                          |
| Full emoji keyboard (`rn-emoji-keyboard`)                             | ✅     | integrated in `ChatScreen.tsx`                                                                                                    |
| Real camera preview in video call PiP (`expo-camera`)                 | ✅     | `CallScreen.tsx` `<CameraView facing={cameraFacing} />`                                                                           |
| Live mic-level waveform in voice call (`expo-av`)                     | ✅     | `CallScreen.tsx` `Audio.Recording` 100 ms metering poll                                                                           |
| Full security docs                                                    | ✅     | `docs/architecture/MESSENGER_BACKEND.md`, `README.md`, `docs/development/AUTH_TESTING.md`, `docs/architecture/AUTH_COMPLIANCE.md` |

---

## Summary for the sheet

- **BE-2 rollup:** 100% ✅ (unchanged)
- **BE-3 rollup:** 100% ✅ (unchanged)
- **BE-4 rollup:** bump from ~25% to **~70%** — BE-4.2 is done, BE-4.3 is scaffolded at 40%, BE-4.4 scaffolded at 15%.
- **Phase 1 overall:** tracking ahead of sprint plan; only dependency carries are Phase-2 infrastructure work (real APNs certs, mediasoup Workers, Kafka brokers).
