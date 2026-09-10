# Keyboard-Inset Audit — "blind space on iOS, cut down on Android" · 2026-07-24

**Bug:** `sqa.md` **B-184**
**Scope:** every focused-input surface in `src/` (RN 0.81 / Expo SDK 54, minSdk 24, target 36, edge-to-edge ON).
**Trigger:** founder screenshots of the same chat composer on two devices — iOS showed a
band of empty screen between the composer and the keyboard; Android showed the composer
sliced in half by the IME.
**Status:** **FIXED same session.** One rule (`src/hooks/useKeyboardLayout.ts`), 30 surfaces
migrated, `KeyboardAvoidingView` deleted from the codebase, 63 regression tests
(23 arithmetic + 40 contract-scan), both mutation-proved RED before the fix.
**Device verify:** PENDING — `docs/qa/KEYBOARD_UI_TEST_PLAN.md`.

---

## 1. Root cause — `endCoordinates.height` is not the same quantity on the two platforms

Both defects are the same arithmetic error with opposite signs. Neither was guessable
from the JS side; both are read directly out of the React Native sources in
`node_modules`.

### R-1 · Android (API ≥ 30) — RN subtracts the nav bar, we never added it back

`node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactRootView.java`,
`CustomGlobalLayoutListener.checkForKeyboardEvents()`:

```java
Insets imeInsets = rootInsets.getInsets(WindowInsets.Type.ime());
Insets barInsets = rootInsets.getInsets(WindowInsets.Type.systemBars());
int height = imeInsets.bottom - barInsets.bottom;      // <-- the nav bar is REMOVED
```

Meanwhile `react-native-safe-area-context` (`SafeAreaUtils.kt`, API ≥ 30 path) computes
`insets.bottom` from `statusBars | displayCutout | navigationBars | captionBar` — it is
IME-independent and equals that same `barInsets.bottom`.

Under `edgeToEdgeEnabled=true` (mandatory on RN 0.81 / target SDK 36) our views run to
the physical screen bottom. So a surface padded by the reported height is short by
**exactly `insets.bottom`** — 24 dp on gesture nav, 48 dp on 3-button. That is the
"composer cut in half" screenshot.

`checkForKeyboardEventsLegacy()` (API < 30, still in range at minSdk 24) measures
`displayMetrics.heightPixels - visibleRect.bottom`, which **already includes** the bar.
The compensation therefore has to be API-gated, not unconditional.

### R-2 · iOS — the height already spans the home indicator, and we stacked on it

`node_modules/react-native/React/CoreModules/RCTKeyboardObserver.mm` converts
`UIKeyboardFrameEndUserInfoKey` into **window** coordinates. A docked keyboard is flush
to the window bottom, so `height` already covers the 34 pt home-indicator band. Every
surface that also padded `insets.bottom` bought 34 pt of dead space under a keyboard
that was already covering it.

### R-3 · `KeyboardAvoidingView` made it worse, three ways

`node_modules/react-native/Libraries/Components/Keyboard/KeyboardAvoidingView.js`:

```js
const keyboardY = keyboardFrame.screenY - (this.props.keyboardVerticalOffset ?? 0);
return Math.max(frame.y + frame.height - keyboardY, 0);
```

1. `keyboardVerticalOffset` is added to the computed padding **one-for-one**. `ChatScreen`
   passed `insets.top + 10`, so a notched iPhone got ~69 pt of blind space on top of R-2's
   34 pt — ≈ 100 pt, which matches the founder screenshot.
2. `frame.y` comes from `onLayout`, i.e. it is **parent-relative**. The math is only
   correct when the KAV is a direct child of a full-screen view; nested, it is silently wrong.
3. On Android the app-wide idiom `behavior={Platform.OS === 'ios' ? 'padding' : undefined}`
   is a **no-op** (12+ screens had zero keyboard handling on the primary platform), and the
   alternative `behavior="height"` leaves ghost padding after dismissal.

### R-4 · No single owner — five idioms, all disagreeing

Before this change the repo held, simultaneously: KAV with `padding`/`undefined`; KAV with
`height`; KAV **plus** a manual Android-only `paddingBottom: kbHeight`; a bare manual
`kbHeight` on the screen root; and one hand-rolled `Keyboard.addListener` pair in
`NextOfKinModal`. Nine surfaces gated the manual pad on `Platform.OS === 'android'`, four
did not — so the same helper produced different geometry depending on which screen you
opened. B-84 fixed the _symptom_ on 17 screens without unifying the _arithmetic_, which is
why the class came back.

---

## 2. The rule

`src/hooks/useKeyboardLayout.ts`

```ts
computeKeyboardOverlap(evt, env); // pure; dp of the SCREEN BOTTOM the IME covers
useKeyboardOverlap(); // that number, live
useKeyboardLayout(); // { overlap, visible, safeBottom, bottomPad(gap) }
useKeyboardBottomPad(gap); // one-liner for the common case
useRevealOnKeyboard(scrollRef); // unchanged: event-driven reveal for bottom fields
```

> **THE BOTTOM-MOST ELEMENT OF A SURFACE OWNS THE KEYBOARD INSET.**
> It pads by `bottomPad(gap)`; nothing else in the tree reacts to the IME.

| Situation                                            | Use                |
| ---------------------------------------------------- | ------------------ |
| Bottom-anchored composer / sticky footer / sheet     | `bottomPad(gap)`   |
| Container that lifts a whole column (form, backdrop) | `overlap`          |
| A child inside an already-lifted container           | `safeBottom + gap` |

`bottomPad` **replaces** the safe-area inset while the keyboard is up; it never stacks.
`safeBottom` collapses to 0 for the same reason.

Normalization, per platform:

| Platform         | Reported `height`                    | Applied                                                                                                                          |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Android API ≥ 30 | `ime − systemBars`                   | `+ insets.bottom`                                                                                                                |
| Android API < 30 | display-metrics delta (bar included) | as-is                                                                                                                            |
| iOS              | window-coord keyboard frame          | `min(height, windowHeight − screenY)` — clamps undocked iPad keyboards to 0 and survives the Reduce-Motion `screenY === 0` quirk |

---

## 3. Surfaces migrated (30)

| Surface                                                                                                                             | Was                                                                                             | Now                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatScreen` composer **(the repro)**                                                                                               | KAV + `keyboardVerticalOffset: insets.top+10` + Android `kbHeight` + composer `insets.bottom+8` | `bottomPad(8)` on the composer only                                                                                                                                           |
| `DepartmentChatScreen`                                                                                                              | KAV + Android `kbHeight` on the root                                                            | `bottomPad(12)` on composer / viewer bar                                                                                                                                      |
| `GroupCallScreen` in-call chat sheet                                                                                                | KAV + Android `kbHeight`                                                                        | `overlap` on the sheet frame                                                                                                                                                  |
| `BackupSetupScreen`, `BackupRestoreScreen`                                                                                          | KAV + Android `kbHeight`                                                                        | `overlap` on the body frame                                                                                                                                                   |
| `NewChatScreen` (×2), `ChatInfoScreen`, `AdminAttendanceScreen`, `MyAttendanceScreen`, `IndividualProfileScreen`, `JobDetailScreen` | KAV + Android-gated `kbHeight` backdrop                                                         | `overlap` on the backdrop (`safeBottom` on JobDetail's sheet)                                                                                                                 |
| `ProfileScreen`, `CreditsScreen`                                                                                                    | ungated `kbHeight` (iOS double-lift)                                                            | `overlap` on the backdrop                                                                                                                                                     |
| `CpoActivationScreen`, `DayStatusScreen`                                                                                            | `kbHeight` on the root + footer `insets.bottom`                                                 | `bottomPad(n)` on the sticky footer                                                                                                                                           |
| `OrgComplianceScreen`                                                                                                               | `kbHeight` on the root                                                                          | `overlap` on the root                                                                                                                                                         |
| `OrgCreateCpoScreen`, `ReportIncidentDetailsScreen`                                                                                 | KAV, footer outside it (never lifted)                                                           | `bottomPad(n)` on the footer                                                                                                                                                  |
| `IncidentDetailScreen`, `LoginScreen`, `LocationPickerScreen`                                                                       | KAV (`undefined` on Android = inert)                                                            | `overlap` on the body frame                                                                                                                                                   |
| `AgentLiveTrackerScreen`                                                                                                            | KAV + Android-only replace-pattern                                                              | `bottomPad()` on the dock                                                                                                                                                     |
| `NextOfKinModal`                                                                                                                    | own `Keyboard.addListener` pair                                                                 | `bottomPad(18)`                                                                                                                                                               |
| `vbgUi` `VbgScreen`                                                                                                                 | KAV (inert on Android)                                                                          | `overlap` on the body, footer parked                                                                                                                                          |
| `KeyboardAvoidingScreen` (+ `ScreenContainer`)                                                                                      | KAV `padding`/`height`                                                                          | `overlap`; gained a `footer` slot so a pinned CTA is actually inside the shrinking box (its docstring had claimed this for months while the code rendered the footer outside) |
| `AgentRegistrationScreen`, `ProfileCompletionScreen`, `CreditPaywallScreen`, `ProClientProfileScreen`                               | sticky CTA rendered OUTSIDE the wrapper — covered by the IME on every platform, since B-84      | CTA moved into the new `footer` slot with `safeBottom + n`                                                                                                                    |

`src/hooks/useKeyboardHeight.ts` deleted. `KeyboardAvoidingView` no longer appears in `src/`.

---

## 4. Regression coverage

| Suite                                            | Tests | Pins                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/hooks/__tests__/useKeyboardLayout.test.tsx` | 23    | the arithmetic on iOS / Android ≥30 / Android <30, the API-30 boundary, floating-keyboard and cross-fade quirks, the noise floor, listener cleanup, replace-not-stack                                                                                                                      |
| `src/hooks/__tests__/keyboardContract.test.ts`   | 40    | no `KeyboardAvoidingView`, no `keyboardVerticalOffset`, no second `Keyboard.addListener`, no `kbHeight`, no revived `Platform.OS === 'ios' ? 'padding' : undefined`, all 30 inheritors still import the rule, no inset stacked on a keyboard pad, and the ChatScreen composer specifically |

Both mutation-proved: reverting the composer to `insets.bottom + 8` and neutralising the
Android compensation turned 6 tests RED (5 arithmetic + the composer pin), then green again
on restore.

The contract scan strips comments before every absence assertion and splits on `\r?\n`
(these sources are CRLF) — the two ways a source scan in this repo passes vacuously.

---

## 5. Residual risk

1. **Android emits no event when the IME RESIZES while open** (API ≥ 30 fires only on a
   visibility transition). Letter keyboard → emoji panel holds the old height until dismiss.
   iOS tracks it. Closing this needs `react-native-keyboard-controller`
   (`WindowInsetsAnimation`) — a dependency decision, deliberately not taken in a UI fix.
   Tracked as test-plan case **K4**.
2. **Device verification pending** — no attached device this session. The whole matrix is
   `docs/qa/KEYBOARD_UI_TEST_PLAN.md`; Tier 1 is Pixel 7a (gesture **and** 3-button nav)
   plus one home-indicator iPhone.
3. `ScreenContainer` currently has **no consumers**; its footer fix is untested in the field.
4. The rule assumes a full-screen, portrait-locked window. Split-screen / freeform on
   Android reports display-level insets — out of the supported mode.
