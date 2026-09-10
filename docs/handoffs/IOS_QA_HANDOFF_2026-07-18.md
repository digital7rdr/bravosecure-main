# iOS QA HANDOFF — for the Mac QA member · 2026-07-18

**To:** the Mac-based QA engineer (sqa.md header: "QA: Mac-based tester") · **From:** the 2026-07-18 call-fix session
**Why you:** this Windows environment has NO iPhone and cannot run `expo prebuild -p ios` (macOS-only). Everything below is Mac/iPhone-gated and is **assigned to you**; nothing else blocks it. Reply-confirm to the founder when you pick this up, and log every row's outcome in `sqa.md` (PASS / FAIL / SKIPPED — never mark a skipped row passed).

## 0. What changed (context in 30 seconds)

Today's session fixed B-102…B-117 (see `sqa.md` 2026-07-18 entries). The iOS-relevant code that **rides your next build**:

- `plugins/withIosBuildFixes.js` (NEW) — `expo prebuild` no longer destroys the Podfile `USE_FRAMEWORKS` export, the `react-native-xcode.sh` quoting fix, or `ENABLE_USER_SCRIPT_SANDBOXING=NO`. Prebuild is now SAFE to run (previously it bricked the build — `docs/runbooks/IOS_README.md` §5).
- B-109 (`8de5d17`) — in-app accept now answers the CallKit CXCall; a stale ring dismissal can no longer hang up a live call; InCallManager waits for `didActivateAudioSession`.
- B-112/B-113 (`6bfef34`) — iOS VoIP wake now carries callKind/roomToken/conversationId/fromUserId; call-cancel now reaches iOS (AppDelegate ends the ringing uuid).
- B-114 (`3900327`) — iOS group audio → speaker for video calls.
- B-111-A (`289f0b3`) — group calls show an honest "not available on this device yet" alert on iOS (E2EE FrameCryptor gate; do NOT expect group calls to work — that's the B-111-B project).

## 1. Build (Mac)

1. `git pull` (confirm you have commits `8de5d17`…`2134a5f`), `npm install`.
2. `npx expo prebuild -p ios --clean` — now expected to SUCCEED (the plugin re-applies the hand fixes).
3. **Mandatory probes on the BUILT app** (`docs/runbooks/IOS_README.md` §5):
   - `codesign -d --entitlements :- BravoSecure.app` → must show `aps-environment`.
   - `PlistBuddy -c "Print :UIBackgroundModes" BravoSecure.app/Info.plist` → must list `voip`, `audio`, `remote-notification`.
     If either probe fails, STOP and report — the B-109 matrix is meaningless without them.
4. `cd ios && pod install`, build to a physical iPhone (simulator cannot run the app — `IOS_BUILD.md`).

## 2. Prerequisites that are NOT yours but gate some rows

- **P-0** (`SFU_ROOM_TOKEN_SECRET` on staging msgr) — founder/dev applies; until then ALL group-call joins fail on every platform.
- **P-1** (`APNS_VOIP_*` env + org-team explicit App ID) — until applied, locked/killed iPhone NEVER rings (rows marked [P-1] below). Steps: `docs/runbooks/IOS_CALLKIT_VOIP.md` — its §5 five-second-contract device test is MANDATORY before pointing prod at real devices (entitlement revocation is permanent).

## 3. The matrix (log each row in sqa.md under B-109/B-112/B-113/B-114)

| Row      | Steps                                                                                                         | Pass criterion                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| M1       | iPhone→Android voice call, lock iPhone at min 2, stay locked 5+ min                                           | Audio continues both ways; CallKit lock UI shows                                                                                              |
| M2       | Same, video                                                                                                   | Audio continues; camera pause acceptable, resumes on unlock                                                                                   |
| M3       | Android→iPhone, answer IN-APP, then lock                                                                      | Survives; NO stale ringing CXCall left; no self-decline (B-109 RC-3)                                                                          |
| M4 [P-1] | Android→iPhone, iPhone LOCKED, answer from CallKit UI                                                         | Rings while locked; answer connects; audio routes (didActivateAudioSession)                                                                   |
| M5       | Android locks mid-call instead                                                                                | Survives (Android side regression row)                                                                                                        |
| M6       | iPhone→iPhone (if 2nd iPhone available), either locks                                                         | Survives; else SKIPPED                                                                                                                        |
| M7       | iPhone app-switch (not lock) mid-call                                                                         | Survives                                                                                                                                      |
| M8       | iPhone locked >15 min on a live call                                                                          | Call alive (Manager-ping re-auth works on iOS)                                                                                                |
| C1 [P-1] | A rings locked iPhone, A cancels within 5 s                                                                   | CallKit ring stops ≤2 s (B-113); missed-call marker lands                                                                                     |
| C2 [P-1] | Group VIDEO ring to killed iPhone                                                                             | Rings as VIDEO with sensible label (B-112); answer routes to the group screen, which then shows the B-111-A "not available" alert (expected!) |
| G1       | Start a group call from iOS / accept a group ring in-app                                                      | Honest alert, NO join/leave roster flash on Android peers (watch their tiles)                                                                 |
| G2       | 1:1 VIDEO call on iPhone                                                                                      | Audio on speaker (B-114); after hangup, ringtones/media play normally (route released)                                                        |
| R1       | Full Android regression: notification Answer/Decline warm+killed, ring screen first-frame, camera-off avatars | Unchanged from the 2026-07-18 Android matrix results in sqa.md                                                                                |

## 4. Report format

Append to `sqa.md`: one line per row (`M1 PASS — <one-line evidence>`), plus device model + iOS version + build number. FAIL rows: attach Console.app excerpts filtered on `bravo.` and `callkit`.

## 5. Out of scope for you (tracked separately)

B-111-B (FrameCryptor iOS — a project, arch-review-gated), B-116 phase 2 sheet, B-108 part-2 kicker. Register: `docs/handoffs/IOS_GROUPCALL_AND_MESSENGER_PARITY_B111_B117_2026-07-18.md`.
