# Keyboard / Focused-Input UI Test Plan — B-184

> **Run this whenever you touch a screen that has a `TextInput`.** It is the
> device-side half of the keyboard-inset rule; the code-side half is
> `src/hooks/useKeyboardLayout.ts` + the two Jest suites in §6.
>
> Companion docs: `DESIGN_REVIEW_LOOP.md` (device matrix, audit categories),
> `docs/audits/KEYBOARD_INSET_AUDIT_2026-07-24.md` (the register),
> `docs/audits/KEYBOARD_FOCUS_AUDIT_2026-07-16.md` (the earlier B-84 sweep).

---

## 1. The rule under test

**The bottom-most element of a surface owns the keyboard inset. Nothing else in
the tree reacts to the IME.**

```ts
const {overlap, safeBottom, bottomPad} = useKeyboardLayout();
```

| Situation                                            | Value to use       |
| ---------------------------------------------------- | ------------------ |
| Bottom-anchored composer / sticky footer / sheet     | `bottomPad(gap)`   |
| Container that lifts a whole column (form, backdrop) | `overlap`          |
| A child inside an already-lifted container           | `safeBottom + gap` |

`bottomPad` **replaces** the safe-area inset while the keyboard is up — it never
stacks on it, because the IME is already covering the nav bar / home indicator.

Two platform facts the rule normalizes (both read out of the RN sources, do not
re-derive them by eye on a device):

| Platform            | What RN reports in `endCoordinates.height`                 | Rule applies      |
| ------------------- | ---------------------------------------------------------- | ----------------- |
| Android API **≥30** | `imeInsets.bottom − systemBars().bottom` (nav bar removed) | `+ insets.bottom` |
| Android API **<30** | display-metrics delta (nav bar already included)           | as-is             |
| iOS                 | keyboard frame in **window** coords (home indicator incl.) | as-is, clamped    |

---

## 2. The two failure signatures

Learn these by sight — every finding in this plan is one of them.

| Signature                   | Looks like                                                                            | Cause class                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **BLIND SPACE** (over-lift) | A visible band of screen background between the input row and the top of the keyboard | Two paddings stacked (inset + overlap), or a stray `keyboardVerticalOffset` |
| **CUT DOWN** (under-lift)   | The input row is sliced by the keyboard; part of it is behind the IME                 | Padding short by the nav-bar band, or nothing reacted at all                |

A third, checked on every case: **GHOST SPACE** — dismiss the keyboard and the
layout does **not** return to rest (a dead strip above the nav bar). That was
the `behavior="height"` failure and it must never come back.

---

## 3. Device matrix

Run the **Tier-1** column on every keyboard-touching change. Run the full matrix
before a release build.

| Tier | Device                               | Why it is in the matrix                                         |
| ---- | ------------------------------------ | --------------------------------------------------------------- |
| 1    | **Pixel 7a, gesture nav** (24 dp)    | The primary target; the `+insets.bottom` compensation path      |
| 1    | **Pixel 7a, 3-button nav** (48 dp)   | Doubles the band — an uncompensated build is obvious here       |
| 1    | **Any iPhone with a home indicator** | The blind-space path (34 pt already inside the reported height) |
| 2    | BlueStacks 5555/5565/5575            | No nav bar at all (`insets.bottom === 0`) — the null case       |
| 2    | TECNO KM5 / Redmi 2409BRN2CY         | OEM IMEs that re-fire show with sub-pixel height bumps          |
| 2    | An API 28/29 device or emulator      | RN's **legacy** keyboard path — must NOT be compensated         |
| 3    | Foldable, unfolded + folded          | Inset changes across the fold while the IME is up               |
| 3    | Tablet / landscape                   | Short viewport; the composer must not eat the whole screen      |

**Keyboard configurations to vary** (they change the IME height, which is the
whole point):

- Gboard **with** the suggestion strip, and **without**.
- Gboard **one-handed** mode and **floating** mode.
- The emoji panel (taller than the letter keyboard on most IMEs).
- A third-party IME (SwiftKey / OEM default).
- `fontScale` **1.0** and **1.3+** (Settings → Display → Font size, largest).

---

## 4. Per-surface cases

Every case uses the same three checks:

- **(a) VISIBLE** — the focused field is fully visible while typing.
- **(b) REACHABLE** — the submit/send control is tappable without dismissing the keyboard.
- **(c) RESTORES** — dismissing the keyboard returns the layout to rest with no ghost strip.

Plus, on every case, look for **blind space** and **cut down** per §2.

### 4.1 Chat composer — the founder repro (P0)

`src/screens/messenger/ChatScreen.tsx` → `ChatComposer`

| #   | Steps                                                               | Expected                                                                                     |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| K1  | Open a 1:1 chat → tap the message field                             | Composer sits **flush** on the keyboard: no gap, nothing sliced. Last message stays visible. |
| K2  | Type a multi-line message until the field grows                     | Composer grows upward; list shrinks; composer stays flush.                                   |
| K3  | Send, then dismiss the keyboard                                     | Composer drops back to rest above the nav bar; no ghost strip.                               |
| K4  | Switch to the emoji panel from the keyboard                         | Composer tracks the new height (**iOS**). On **Android** see the known gap in §7.            |
| K5  | Reply-swipe a message, then focus                                   | Reply bar + composer both above the keyboard.                                                |
| K6  | Rotate / unfold while focused                                       | No overlap, no double gap after the re-layout.                                               |
| K7  | Repeat K1 with a **group** chat and with the **Dept chat** composer | Identical behaviour (`DepartmentChatScreen`).                                                |

### 4.2 Backup password — the B-84 critical path

`BackupRestoreScreen`, `BackupSetupScreen` (setup + unlock)

| #   | Steps                                                                                           | Expected                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| K8  | Fresh install → login with a backed-up account → RESTORE BACKUP screen → tap the password field | Field **and** the RESTORE button both visible; the reveal scroll happens after the IME settles, not before. |
| K9  | Settings → Chat Backup → set a password, focus each field in turn                               | Each field scrolls clear; no jump-then-settle flicker.                                                      |

### 4.3 Modal / bottom-sheet inputs

`ProfileScreen`, `IndividualProfileScreen`, `CreditsScreen` (promo), `NewChatScreen` (×2),
`ChatInfoScreen` (rename), `AdminAttendanceScreen`, `MyAttendanceScreen`,
`JobDetailScreen` (pledge sheet), `GroupCallScreen` (in-call chat), `NextOfKinModal`

| #   | Steps                                             | Expected                                                                                              |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| K10 | Open the modal → focus the input                  | The card re-centres **above** the keyboard (centred modals) or the sheet lifts flush (bottom sheets). |
| K11 | Tap the primary button while the keyboard is open | It fires on the **first** tap (`keyboardShouldPersistTaps`), not after a dismiss tap.                 |
| K12 | Dismiss the keyboard with the modal still open    | The card returns to centre; no ghost padding.                                                         |
| K13 | Tap the backdrop while typing                     | The modal closes (or is blocked deliberately) — it must not swallow the tap silently.                 |

### 4.4 Forms with a sticky footer

`CpoActivationScreen`, `DayStatusScreen`, `ReportIncidentDetailsScreen`,
`OrgCreateCpoScreen`, `OrgComplianceScreen`, `LoginScreen`, `IncidentDetailScreen`

| #   | Steps                                              | Expected                                                                      |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| K14 | Focus the **last** field on the form               | The field scrolls above the keyboard; the sticky CTA rides on top of the IME. |
| K15 | Focus a **middle** field, then tab/tap to the next | No re-scroll jitter; both fields reachable.                                   |
| K16 | Set fontScale to 1.3 and repeat K14                | Still reachable — the form scrolls, nothing clips.                            |

### 4.5 Surfaces that must **not** move

| #   | Surface                                                                         | Expected                                                                    |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| K17 | The app tab bar (`MainNavigator` `CustomTabBar`)                                | Stays parked at the screen bottom, covered by the IME. It must not ride up. |
| K18 | The VBG 5-tab footer (`VbgFooter`)                                              | Same — the body shrinks, the tab bar does not lift.                         |
| K19 | `LocationPickerScreen` search modal                                             | Field is at the TOP; results list shrinks. Field never moves.               |
| K20 | The keypad screens (`OTPVerification`, `OtpVerify`, `VaultNewPin`, `VaultLock`) | Custom keypad, no IME. Nothing changes when tapping.                        |

---

## 5. Screenshot evidence

For a Tier-1 pass, capture at minimum: chat composer focused (K1), backup password
focused (K8), one centred modal focused (K10), one sticky-footer form focused (K14) —
on **both** an Android gesture-nav device and an iPhone.

```bash
adb -s <serial> exec-out screencap -p > kb_K1_pixel7a.png
# fontScale sweep
adb -s <serial> shell settings put system font_scale 1.3   # revert to 1.0 after
# nav-mode sweep
adb -s <serial> shell cmd overlay enable com.android.internal.systemui.navbar.threebutton
adb -s <serial> shell cmd overlay enable com.android.internal.systemui.navbar.gestural
```

Device serials ↔ accounts: `sqa.md` §4.

---

## 6. Automated gates (run before the device pass)

```bash
# The rule's arithmetic + the reveal hook (23 tests)
npx jest --selectProjects app --testPathPattern useKeyboardLayout

# The contract: no hand-rolled copies, every inheritor still inherits (36 tests)
npx jest --selectProjects app --testPathPattern keyboardContract

# Whole app project + the messenger gate (the latter twice — B-126 flake rule)
npx jest --selectProjects app
npx jest --selectProjects messenger-crypto
```

Plus `npm run typecheck` (≤ the `.tsc-baseline.json` count) and `npm run lint`.

---

## 7. Known limitations (state them, don't re-file them)

1. **Android does not report IME height CHANGES.** `ReactRootView` only emits
   `keyboardDidShow` on a visibility **transition** (API ≥30 path). Swapping the
   letter keyboard for a taller emoji panel while it is already open fires no
   event, so the padding holds the old height until the IME closes. iOS fires
   `keyboardWillShow` on every frame change and does track it. Fixing this needs
   `react-native-keyboard-controller` (WindowInsetsAnimation) — a dependency
   decision, not a UI diff. This is case **K4** above; log the gap, do not treat
   it as a new bug.
2. **Split-screen / freeform** on Android reports insets for the whole display,
   not the app window. Portrait-locked full-screen use is the supported mode.
3. **iPad floating/split keyboard** resolves to overlap 0 by design (nothing is
   covered). iPad is not a shipping target.
4. Emulator/BlueStacks keyboards are **shorter** than real IMEs. A pass there is
   not a pass — Tier 1 requires physical hardware.
