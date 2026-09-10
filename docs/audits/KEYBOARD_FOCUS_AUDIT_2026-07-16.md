# Keyboard-Focus Audit — "keyboard covers the text input" · 2026-07-16

**Scope:** entire mobile codebase (`src/`), Android-primary (RN 0.81 / Expo SDK 54, target SDK 36).
**Trigger:** founder repro — backup-password field hidden behind the keyboard.
**Status:** **FIXED 2026-07-16 (same day)** — all 17 findings remediated via shared
`src/hooks/useKeyboardHeight.ts` (`useKeyboardHeight` + `useRevealOnKeyboard`) applied per
pattern (see §3 + `sqa.md` B-84 UPDATE). Gates: tsc 46 ≤ 47, eslint clean, hook tests 6/6,
app+booking suites green (2 failing suites verified pre-existing on main via stash-test).
**On-device verify pending** (physical device + Gboard). Logged as **B-84** in `sqa.md`.

---

## 1. Root cause (systemic — three compounding facts)

### S-1 · Edge-to-edge killed `adjustResize`

`android/gradle.properties:52` → `edgeToEdgeEnabled=true` (mandatory under RN 0.81 / target SDK 36).
Under edge-to-edge the manifest's `windowSoftInputMode="adjustResize"`
(`AndroidManifest.xml:133`) **no longer resizes the app window** when the keyboard opens.
Every screen that implicitly relied on "Android resizes for us" silently broke.

**In-repo evidence (not theory):**

- `src/screens/messenger/ChatScreen.tsx:220-241` — the main chat composer works ONLY because it
  manually tracks keyboard height via `Keyboard.addListener('keyboardDidShow')` and pads by
  `kbHeight`. If the window also resized, this would double-lift — it doesn't → the window is
  provably not resizing.
- `src/screens/messenger/BackupSetupScreen.tsx:465-471` — QA comment: _"Without a behavior on
  Android the keyboard overlaps the field."_
- Founder device repro on the backup-password screens (B-84).

### S-2 · The app-wide KAV idiom is a no-op on Android

`behavior={Platform.OS === 'ios' ? 'padding' : undefined}` appears on **12+ screens**.
With `behavior=undefined`, `KeyboardAvoidingView` does **nothing** on Android. Combined with
S-1, those screens have **zero** keyboard handling on the primary platform.

### S-3 · RN `Modal` windows never resize for the keyboard

Independent of S-1, an Android `Modal` window does not reliably apply `adjustResize`. Every
`TextInput` inside a `Modal` needs explicit handling. Only ONE modal in the repo does it right:
`src/screens/vbg/NextOfKinModal.tsx:48-59` (manual `Keyboard` listener lifts the sheet by
`kbHeight`) — this is the proven in-repo reference pattern.

**Sweep coverage:** 37 screen files render `TextInput` (there are NO TextInputs in
`src/components/`, `src/modules/`, or `src/navigation/` — the entire risk surface is
`src/screens/`). No shared input wrapper exists; screens use raw `<TextInput>`.
`react-native-keyboard-controller` / `keyboard-aware-scroll-view` are NOT installed.

---

## 2. Findings register

Severity model (Android): **HIGH** = focused input unrecoverably covered (bottom-anchored or
bottom-of-scroll — scrolling cannot lift it above the IME because the viewport never shrinks) or
a critical-path flow; **MEDIUM** = covered on tall keyboards / small screens / fontScale ≥ 1.3,
or the Save/submit button under the input gets covered, or recoverable only by manual scroll.

### HIGH

| ID        | File / line                                                            | Input                                                                                | Why it's covered                                                                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KB-01** | `src/screens/messenger/BackupRestoreScreen.tsx:649` (input :726)       | **Backup password** — fresh-install restore gate                                     | KAV `behavior=undefined` on Android = inert; field sits bottom-half after hero + 3 bullets; the `flexGrow` scroll rationale (:795-798) assumes the window shrinks — it doesn't (S-1). **THE founder-reported repro.** Blocks the restore critical path.                                                                      |
| **KB-02** | `src/screens/messenger/BackupSetupScreen.tsx:471` (reveal hack :83-87) | Backup password (Settings → Chat Backup, setup + unlock modes)                       | Has Android `behavior="height"` + `scrollToEnd` onFocus — but the reveal fires on a fixed **120 ms** timer, before the keyboard settles (~250-300 ms) and before `height` re-layouts (Android waits for `keyboardDidShow`) → lands on the pre-keyboard layout; flaky coverage. Second entry point of the same critical flow. |
| **KB-03** | `src/screens/messenger/DepartmentChatScreen.tsx:336`                   | Dept-chat composer (bottom-pinned)                                                   | KAV `undefined` on Android, **no** manual kbHeight tracking (unlike ChatScreen) → composer covered while typing.                                                                                                                                                                                                             |
| **KB-04** | `src/screens/agent/AgentLiveTrackerScreen.tsx:790` (input :803)        | Message/note input pinned to bottom over full-screen map                             | KAV `undefined`, no ScrollView → nothing can lift it.                                                                                                                                                                                                                                                                        |
| **KB-05** | `src/screens/messenger/GroupCallScreen.tsx:2189-2242` (input :2226)    | In-call chat composer at bottom of a slide-up `Modal` sheet                          | Modal (S-3) + KAV `undefined` (S-2) — worst-case combination.                                                                                                                                                                                                                                                                |
| **KB-06** | `src/screens/agent/JobDetailScreen.tsx:531-638` (backdrop :798)        | Pledge/note input in a bottom-sheet `Modal`                                          | Bottom-edge input, Modal never resizes, KAV `undefined`.                                                                                                                                                                                                                                                                     |
| **KB-07** | `src/screens/settings/ProfileScreen.tsx:460-464`                       | Name-edit input in centered `Modal`                                                  | **No keyboard handling of any kind** (no KAV at all); non-scrollable card — input and Save/Cancel get covered.                                                                                                                                                                                                               |
| **KB-08** | `src/screens/wallet/CreditsScreen.tsx:359-365`                         | Promo-code input in centered `Modal`                                                 | Same as KB-07 — zero handling.                                                                                                                                                                                                                                                                                               |
| **KB-09** | `src/screens/cpo/CpoActivationScreen.tsx:111,159-165`                  | **3 password fields near the bottom of a ScrollView** (CPO activation critical path) | No KAV; bottom-of-scroll fields can't be scrolled above the IME when the viewport doesn't shrink.                                                                                                                                                                                                                            |

### MEDIUM

| ID        | File / line                                                     | Input                                               | Why                                                                                                                                   |
| --------- | --------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **KB-10** | `src/screens/messenger/ChatInfoScreen.tsx:805-856` (input :818) | Group-rename input, centered Modal                  | KAV `undefined` (S-2) + Modal (S-3); input + confirm button below center.                                                             |
| **KB-11** | `src/screens/messenger/NewChatScreen.tsx:420-452, 461-494`      | Inputs in two centered Modals                       | Same pattern.                                                                                                                         |
| **KB-12** | `src/screens/settings/IndividualProfileScreen.tsx:306-341`      | Edit input, centered Modal                          | Same pattern.                                                                                                                         |
| **KB-13** | `src/screens/deptchat/AdminAttendanceScreen.tsx:212-249`        | Edit input, centered Modal                          | Same pattern.                                                                                                                         |
| **KB-14** | `src/screens/deptchat/MyAttendanceScreen.tsx:158-184`           | Input, centered Modal                               | Same pattern.                                                                                                                         |
| **KB-15** | `src/screens/deptchat/DayStatusScreen.tsx:96,158-164`           | Multiline "Reason or context" near bottom of scroll | No KAV; low field ⇒ covered / manual-scroll-only.                                                                                     |
| **KB-16** | `src/screens/agent/OrgComplianceScreen.tsx:134,170`             | Reference input mid-lower scroll                    | No KAV.                                                                                                                               |
| **KB-17** | `src/screens/auth/LoginScreen.tsx:324-326`                      | Email/password (lower-mid), **no ScrollView**       | KAV `undefined`; on small devices / fontScale ≥ 1.3 / tall IMEs the password field crowds under the keyboard with no scroll fallback. |

### LOW / notes (verified, not bugs today)

- **`src/components/KeyboardAvoidingScreen.tsx:72`** (via `ScreenContainer`) — the blessed form
  wrapper; Android `behavior="height"` does shrink the view, **but nothing auto-scrolls the
  focused deep field into view** — users must scroll manually on tall forms (Register,
  ProfileCompletion, AgentRegistration ×2, MessengerSettings, CreditPaywall, VaultForgot,
  VaultOTPVerify, ProClientProfile, CreditPaywall). Also `height` has known
  restore-glitch quirks. Fine for now; would be subsumed by the systemic fix.
- `src/screens/booking/LocationPickerScreen.tsx:476,491` — search Modal, but input at TOP;
  keyboard covers the results list, not the input.
- `src/screens/vbg/vbgUi.tsx:91` (`VbgScreen`) — KAV with no Android behavior (inert), but the
  only input consumer (`VBGGeoRiskScreen.tsx:314`) has its field near the top. Latent footgun
  for future VBG forms.
- Keypad screens (`OTPVerificationScreen`, `OtpVerifyScreen`, `VaultNewPinScreen`,
  `VaultLockScreen`) render a custom on-screen keypad, no IME — unaffected.
- **Correct reference implementations:** `ChatScreen.tsx:220-241` (bottom-pinned composer,
  manual kbHeight) and `NextOfKinModal.tsx:48-59` (Modal bottom-sheet, manual kbHeight).
- Search-at-top screens (`MessengerHomeScreen:465`, `VBGEmergencyScreen:130`) — never covered.
- iOS: `behavior='padding'` is consistently set, so iOS is broadly OK (iOS not shipped anyway).

---

## 3. Recommended fix direction (for the implementing dev — NOT applied)

1. **Systemic:** adopt `react-native-keyboard-controller` (the standard edge-to-edge-correct
   replacement for KAV/adjustResize on RN 0.75+), OR standardize the two proven in-repo
   patterns: manual `kbHeight` listener (ChatScreen/NextOfKinModal pattern) for bottom-pinned
   composers and ALL Modal inputs; `KeyboardAvoidingScreen` + focus-driven
   `scrollResponderScrollNativeHandleToKeyboard`/`scrollTo` for forms.
2. **Priority order:** KB-01/KB-02 (backup password — restore critical path, founder-blocked),
   KB-09 (CPO activation), KB-03 (dept-chat composer), then the Modal cluster (KB-05..KB-08,
   KB-10..KB-14).
3. KB-02 specific: replace the 120 ms timer with a `keyboardDidShow` listener (or
   `InteractionManager` + `scrollResponderScrollNativeHandleToKeyboard`) so the reveal happens
   after the final layout.
4. Any fix must be device-verified (BlueStacks + Pixel 7a, fontScale 1.3, Gboard with
   suggestions bar ON) — emulator keyboards are shorter than real ones; per
   `DESIGN_REVIEW_LOOP.md` device matrix.

## 4. Verification matrix (repro steps)

For each finding: focus the input on a physical device (Pixel 7a, Gboard + suggestion strip,
portrait) and check (a) is the focused field visible while typing, (b) is the submit button
reachable without dismissing the keyboard, (c) after keyboard dismiss, is layout restored
(no ghost padding). KB-01 repro: fresh install → login (account with backup) → RESTORE BACKUP
screen → tap password field → field + RESTORE button covered by IME.
