# Bravo Secure — Bug Analysis (Resolution + Root Causes)

**Date:** 2026-06-08 | **Build analysed:** 1.0.48 (versionCode 71)
**Companion docs:** full bug report `~/Desktop/Bravo_Secure_Bug_Report_2026-06-08_v1.0.48.md`, running reference `sqa.md`

---

## 1. Per-bug status (as of build 1.0.48)

| Bug            | Title                                             | Side               | Status                        |
| -------------- | ------------------------------------------------- | ------------------ | ----------------------------- |
| B-01           | Host sees black video tiles                       | App                | ✅ Resolved                   |
| B-02           | Ad-hoc call "no group master key"                 | App                | ✅ Resolved                   |
| B-03           | `frameCryptorOrchestrator.ts` repo/APK divergence | App                | ✅ Resolved (ships)           |
| B-04           | Ghost "Call" groups in list                       | App                | ✅ Resolved                   |
| B-11           | 2nd device offline (`signalDeviceId=1`)           | App                | ✅ Resolved                   |
| B-12           | Group-call joiner never gets key (← B-11)         | App                | ✅ Resolved                   |
| B-15           | Group text not rendering                          | App                | ✅ Resolved                   |
| B-18 (group)   | Group text decrypts but not rendered              | App                | ✅ Resolved                   |
| **B-18 (1:1)** | **1:1 text decrypts but never renders**           | App                | ❌ Open                       |
| **B-13**       | Non-owner host skips key broadcast                | App                | ❌ Open                       |
| **B-17**       | Voice/group joiner blank tile                     | App                | ❌ Open                       |
| **B-05**       | **Server WS drop kills every call**               | **Backend**        | ❌ Open                       |
| B-19           | Video stream → wrong/duplicate tile               | App                | ⚠️ Inconclusive (emulator)    |
| B-16           | 1:1 audio→video first-enable sees self            | App                | ⚠️ Not retested               |
| B-07           | `toggleVideo` silent refusal                      | App                | ⚠️ Not retested               |
| B-08           | Boot race on `GROUP_CALL_PRESENCE`                | App                | ⚠️ Not retested               |
| B-09           | Calls boot voice (no camera)                      | App                | ⚠️ Not retested               |
| B-10           | Group key epoch mismatch                          | App                | ⚠️ Not retested               |
| B-14           | Post-call transport dead                          | Mixed (BE trigger) | ⚠️ Tied to B-05               |
| B-15b          | shirajul sealed-sender desync                     | App                | ⚠️ Transient (restart clears) |

---

## 2. Summary — count by side & status

| Side               | Resolved | Open (confirmed)         | Inconclusive / not-retested | Total  |
| ------------------ | -------- | ------------------------ | --------------------------- | ------ |
| **App (frontend)** | 8        | 3 (B-13, B-17, B-18·1:1) | 7                           | **18** |
| **Backend**        | 0        | 1 (B-05)                 | 1 (B-14 mixed)              | **~2** |
| **Total**          | **8**    | **4**                    | **8**                       | **20** |

**Bottom line:** bugs are overwhelmingly on the **App / frontend side (~18 of 20)**; only **B-05 is purely backend** (with B-14 a mixed knock-on). But B-05 is the single most damaging — it terminates 100% of calls regardless of the client (15/15 calls this session).

---

## 3. Most probable root causes

| #   | Root cause                                                                                                                                                                                                                                                                                         | Bugs it explains                   | Side    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------- |
| 1   | **`messenger-service` WebSocket instability** on `94.136.184.52` — process crash/restart or `WS_HEARTBEAT_GRACE` (10s) too tight under variable Contabo latency → all clients kicked simultaneously                                                                                                | **B-05**, B-14                     | Backend |
| 2   | **`signalDeviceId = 1` hardcoded** (now fixed) — all devices shared one `(userId:deviceId)` key → supersession churn → cascaded into key-delivery + sealed-sender desync                                                                                                                           | B-11, B-12, B-15b (now resolved)   | App     |
| 3   | **Render decoupled from the data layer** — tiles/messages keyed on index / `participant.joined` / remote-initiated events instead of binding directly off the consume / `ontrack` / append path. Media arrives + decrypts (`consumer attached`, `handled=true`) but never reaches a render surface | B-01, B-06, B-16, B-17, B-19, B-18 | App     |
| 4   | **1:1 inbound append path not unified with group** — group append fixed but `direct:` conversations don't append to the visible thread                                                                                                                                                             | B-18 (1:1)                         | App     |
| 5   | **Non-owner-host key shortcut** — `reusing real-group key (non-owner host)` skips broadcast assuming everyone holds the key; `resolveKeyId` looks under the wrong id for non-owner hosts                                                                                                           | B-13, B-02 (recurred)              | App     |
| 6   | **APK ahead of repo** — shipped builds contain code not committed (B-03 file, non-owner-host path); QA tests code the team can't see in source                                                                                                                                                     | B-03, B-13                         | Process |

---

## 4. Two highest-leverage fixes

1. **Server WS hardening** (root #1) — crash investigation + `WS_HEARTBEAT_GRACE` 10s→25s + watchdog on `94.136.184.52`. **Unblocks all calls; no client build resolves B-05.**
2. **Drive render off the consume/append path, keyed on the stable participant tag / conversation id** (root #3) — closes the whole tile + message render cluster (B-17, B-19, B-18·1:1, and guards B-01/B-16).

_Evidence basis: live ADB logcat (15 calls, multi-device messaging), screenshots, uiautomator dumps, 2026-06-08. Detail per bug in `sqa.md`._
