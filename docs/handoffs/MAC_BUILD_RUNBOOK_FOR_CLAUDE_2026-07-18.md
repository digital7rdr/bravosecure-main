# MAC BUILD RUNBOOK — written FOR Claude Code running on the Mac QA machine

**Human instructions (one paragraph, then hand off):** open Terminal on the Mac, `cd` into the Bravo*Secure repo (clone it first if needed), run `claude`, and tell it: *"Read docs/handoffs/MAC*BUILD_RUNBOOK_FOR_CLAUDE_2026-07-18.md and execute it."* Keep the iPhone plugged in and unlocked. That's all — Claude does the rest and will tell you when it needs the phone touched (accepting a trust prompt, answering a call).

---

## Claude: your mission and rules

You are executing the iOS build + verification for the B-111-B FrameCryptor work (iOS group calls) plus the accumulated iOS fixes (B-109/112/113/114, B-111-A). ALL code is already written and committed — **you must not author or redesign anything**; your job is: build → fix mechanical build breakages only → verify on the iPhone → record results. The operator is NOT a developer: never ask them technical questions; ask them only for physical actions (plug/unlock phone, tap a dialog, answer a call from the second device).

**Hard rules:**

1. NEVER weaken security code to make something pass. Specifically off-limits: the S6 refusal in `useGroupCall.ts`, `frameCryptorTransport.isAvailable()` semantics, anything in `verifySenderCert`/`verifySealedAad`, the salt/algorithm/knobs in the FrameCryptor modules (`bravo-sframe-v1`, AES-GCM, 32-byte keys). If a step seems to demand it — STOP and write the blocker into sqa.md instead.
2. Mechanical fixes are allowed and expected (header search paths, pod post_install tweaks, a renamed selector on an LKRTC/RTC class, patch fuzz). Every such fix: smallest possible diff, committed separately with a message starting `fix(ios-build):`, logged in the report.
3. Never mark a verification row PASS without direct observed evidence. SKIPPED/BLOCKED with a reason beats a guessed PASS.
4. Read these before starting (they are short and load-bearing): `docs/handoffs/IOS_FRAMECRYPTOR_B111B_IMPLEMENTATION_2026-07-18.md` (what was built and why), `docs/runbooks/IOS_BUILD.md` (known Mac build traps), `docs/runbooks/IOS_README.md` §5 (prebuild traps), `docs/handoffs/IOS_QA_HANDOFF_2026-07-18.md` (the wider device matrix).

## Phase 0 — machine + repo preflight

```
# All from the repo root.
git pull                       # need the B-111-B commits (Swift module native/ios/, plugins/withBravoFrameCryptor.js, patch react-native-webrtc+125.0.12.patch, package.json npm-alias)
git log --oneline -5           # sanity: you should see fix(calls)/feat(messenger) commits dated 2026-07-18
node -v                        # any ≥18; volta may manage it
npm install                    # applies patches/ via patch-package — READ its output: every patch must say "Applying" without errors. react-native-webrtc+125.0.12.patch failing = STOP, log, report.
xcodebuild -version            # Xcode 26.x expected (runbook was validated on 26.6)
```

Device: `xcrun devicectl list devices` (or Xcode → Window → Devices) must show the physical iPhone. If none: ask the operator (plain words) to plug the iPhone in, unlock it, and tap "Trust".

## Phase 1 — generate the iOS project

```
npx expo prebuild -p ios --clean
```

Expected: SUCCESS. The config plugins re-apply everything (Podfile USE_FRAMEWORKS export, xcode.sh quoting, sandboxing off, VoIP AppDelegate block, FrameCryptor sources). If prebuild fails, read the error: a plugin printed a loud `[withIosBuildFixes]`/`[withBravoFrameCryptor]` warning means template drift — fix the ANCHOR in the plugin (mechanical), never by hand-editing ios/ (it is regenerated).

**Post-prebuild probes (MANDATORY, non-negotiable):**

```
ls ios/BravoSecure/BravoFrameCryptor.swift ios/BravoSecure/BravoFrameCryptor.m   # plugin copied the module
grep -c "USE_FRAMEWORKS" ios/Podfile                                             # ≥1
grep -c "ENABLE_USER_SCRIPT_SANDBOXING = NO" ios/BravoSecure.xcodeproj/project.pbxproj  # ≥2
/usr/libexec/PlistBuddy -c "Print :UIBackgroundModes" ios/BravoSecure/Info.plist # voip, audio, remote-notification
```

Any probe failing = STOP, log which, report.

## Phase 2 — pods

```
cd ios && pod install && cd ..
```

This now pulls **WebRTC-SDK =125.6422.07** (LiveKit's build with FrameCryptor) instead of JitsiWebRTC — the single biggest change. Expected turbulence (budget up to a day; all fixes are mechanical):

- A pod needing a repo update: `pod install --repo-update`.
- Header/module collisions involving WebRTC: check whether an existing patch in `patches/` (op-sqlite, quick-crypto, react-native+0.81.5) needs its header-path hunk extended — mirror the existing hunk style, regenerate that one patch (`docs/runbooks/IOS_BUILD.md` has the patch-regen hygiene rules — NEVER regenerate after an Android build without deleting build junk; sizes must stay small).
- `use_frameworks` linkage complaints from WebRTC-SDK: it ships as a binary xcframework and normally coexists; if the build fails linking, try `pod 'WebRTC-SDK', :modular_headers => true` via the Podfile post-hook ONLY as a last resort and log it.

## Phase 3 — build to the iPhone

```
xcodebuild -workspace ios/BravoSecure.xcworkspace -scheme BravoSecure -configuration Debug \
  -destination 'generic/platform=iOS' \
  PRODUCT_BUNDLE_IDENTIFIER=com.bravosecure.app DEVELOPMENT_TEAM=622QE445GT \
  CODE_SIGN_STYLE=Automatic build
```

(These overrides match the last known-good signing — `IOS_BUILD.md`. If signing fails: the personal-team profile may have expired (7-day) — open Xcode once, let it re-provision, retry. If the operator must log into an Apple ID, ask them in plain words.)

**Compile-error playbook for the NEW code (all mechanical, likely selector drift on the WebRTC-SDK ObjC API — fix in `native/ios/BravoFrameCryptor.swift`, then re-run prebuild to re-copy, commit as `fix(ios-build):`):**

- `RTCFrameCryptorKeyProvider` init label mismatch → check the pod's headers: `grep -rn "initWithRatchetSalt" ios/Pods/WebRTC-SDK/WebRTC.xcframework/*/WebRTC.framework/Headers/ | head -3` and align the Swift call labels.
- `RTCFrameCryptor` init labels (`rtpSender:`/`rtpReceiver:`/`participantId:`/`algorithm:`/`keyProvider:`) → same header check (`RTCFrameCryptor.h`). The algorithm enum has a historical upstream typo — it may be `RTCCyrptorAlgorithm` (yes, "Cyrptor") with case `.aesGcm` or constant `RTCCyrptorAlgorithmAesGcm`; use whatever the header says.
- `setKey`/`ratchetKey` selector labels → header `RTCFrameCryptorKeyProvider.h`.
- `senderId`/`receiverId` property names on RTCRtpSender/Receiver → header check; upstream they are `senderId`/`receiverId`.
  Then install: `xcrun devicectl device install app --device <UDID> <path to .app>` or simply run via Xcode.

## Phase 4 — verification (evidence or it didn't happen)

4.1 **Module alive:** launch the app on the iPhone with the console attached (Xcode ▶ or `log stream --predicate 'processImagePath contains "BravoSecure"'`). Sign in (ask the operator for the QA account they use, or register a fresh one — staging accepts any OTP code). Open Messenger.
4.2 **Probe check:** start a GROUP call from a group thread (or have the second device ring this one). WATCH THE LOG: you must see the `[bravo.groupcall.boot]` lines proceed past `step=3` WITHOUT `FrameCryptor unavailable` — that line appearing means `isAvailable()` returned false: check that BravoFrameCryptor.swift/.m are in the Compile Sources phase and the WebRTC-SDK classes exist (`nm` the framework for RTCFrameCryptor). The B-111-A alert appearing on iOS = the probe failed; do NOT bypass it, debug why.
4.3 **The matrix** — run the F-rows from `IOS_FRAMECRYPTOR_B111B_IMPLEMENTATION_2026-07-18.md` §7 (F1-F9) plus the M/C/G rows from `IOS_QA_HANDOFF_2026-07-18.md` §3 that hardware allows. The second device is the Android QA phone or a BlueStacks instance on the Windows side — coordinate with the operator ("please answer the call on the other phone"). Prerequisite for ANY group row: the founder must have applied the staging `SFU_ROOM_TOKEN_SECRET` fix (P-0) — if group joins fail with `room_token_required`/`token_secret_unset_prod` in the server frames, P-0 is not applied: mark group rows BLOCKED(P-0) and continue with 1:1 rows.
4.4 **1:1 regression is mandatory** (the pod swap changed the media stack for 1:1 too): F7 — voice + video + camera-toggle + lock-screen survival (M1/M3 rows).

## Phase 5 — report

Append to `sqa.md` a section `### B-111-B — Mac build + iPhone verification <date>`: build outcome, every mechanical fix committed (hashes), each matrix row PASS/FAIL/SKIPPED(reason) with one-line evidence, iPhone model + iOS version. Then `git add -A && git commit` (message `docs(sqa): B-111-B Mac build + device results`) and `git push`. If anything is FAIL: do NOT attempt redesigns — record precisely and stop; the Windows session picks it up from sqa.md.

## Appendix — if the operator asks "what is this?"

One-sentence answer for them: "It rebuilds the iPhone app with the new encrypted-group-call engine and tests calls between this iPhone and the other test phone; you only need to keep the phone plugged in and tap things when I ask."
