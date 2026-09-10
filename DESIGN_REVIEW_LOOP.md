# DESIGN_REVIEW_LOOP.md — Autonomous UI/UX Design Review Loop

> **When to read this:** ANY task that changes, adds, or reviews a **screen, component,
> layout, interaction, visual style, or user flow** in the mobile app or ops-console.
> This is the design counterpart to `LOOP.md` (engineering) and `sqa.md` (QA). Read it
> BEFORE touching UI. It is NOT auto-loaded.
>
> **Relationship to the other loops:**
>
> - `LOOP.md` — the maker → verifier → auditor → risk-review engineering loop. Still applies.
> - `sqa.md` — the bug register + device/ADB reference. Log UI defects there (as `B-##` /
>   `D-##`) when they are field-reported.
> - **This file** — the _design_ audit categories, gates, device matrix, and iteration format.

---

## 0. Prime directive

You are not a designer who ships one version. You are an **autonomous design-review system**:

```
ANALYZE → DESIGN → AUDIT → IDENTIFY WEAKNESSES → IMPROVE → RE-AUDIT → STRESS-TEST
   → issues found?  ── yes ──▶ loop again
                    ── no  ──▶ APPROVE
```

Never assume the first design is correct. Always challenge your own decisions. Continue
until **Critical = 0, Major = 0, Responsiveness ✗ = 0, Accessibility ✗ = 0, Foldable ✗ = 0**
and **Production Readiness ≥ 95/100**.

---

## 1. Project-grounded constraints (read before proposing anything)

- **Stack:** React Native 0.81 + Expo SDK 54, TypeScript 5.9, React 19. Ops-console: Next.js 15.
- **Design system is LOCKED.** Follow the tokens in the _Bravo Secure Design System Master_
  memory AND the **obsidian migration** (current app surface = obsidian `#07090D` bg /
  cobalt `#5B8DEF` accent; `MainNavigator` `CustomTabBar` is the universal footer; Secure/Lite
  home = `BookingHomeScreen`). **No new colours, no arbitrary spacing (8pt grid: 4/8/12/16/24/32/40),
  one primary action per screen.** A palette or spacing deviation is an automatic **Major**.
- **Reuse before inventing.** There is already a responsive helper (`@utils/scaling` —
  `scaleTextStyles` / scale fns), `react-native-safe-area-context` (`useSafeAreaInsets`),
  `@theme/*`, `BravoFont`, and the obsidian `OB`/`Bravo` palette objects. Use them — do NOT
  add a second scaling system, a raw `SafeAreaView`, or a private colour map.
- **Fonts:** Manrope (300/400/500/600/700). Type scale is defined in the design master.
- **Portrait-first, but must not BREAK in landscape / split / unfold.** If a screen is
  portrait-locked, that is a valid decision — but it must degrade gracefully, not clip.

---

## 2. Device / breakpoint matrix (every responsive pass tests ALL of these)

| Class             | Widths (dp) / devices                                                            | Source of truth                                           |
| ----------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Small phones      | **320, 360, 375**                                                                | narrowest supported                                       |
| Standard phones   | **390, 414, 430**                                                                | iPhone 14/15/Pro Max class                                |
| Real test devices | **Pixel 6a / 7a**, TECNO KM5, Xiaomi/Redmi 2409BRN2CY, BlueStacks 5555/5565/5575 | `sqa.md` §4                                               |
| Foldables         | Samsung Fold, Pixel Fold, Surface Duo (portrait + landscape, folded + unfolded)  | hinge overlap, continuity                                 |
| Tablets           | portrait + landscape                                                             | multi-column, reading comfort, no stretched single-column |
| Font scale        | `fontScale` 0.85 → **1.3+** (OS "largest")                                       | dynamic type                                              |
| Density           | ldpi→xxxhdpi via `PixelRatio`                                                    | crisp assets, hairlines                                   |

Prefer `useWindowDimensions()` (reactive) over one-shot `Dimensions.get`. Never hardcode a
width that can exceed 320dp minus horizontal padding.

---

## 3. Mandatory audit categories (every iteration audits ALL)

For each screen/component, produce findings under **every** heading. Each finding gets a
**severity** (Critical / Major / Minor), a **root cause**, and a **proposed fix**.

### 3.1 UX

Flow · friction · discoverability · navigation depth · cognitive load · **error prevention**
· **error recovery** (retry paths) · task-completion speed · back-button / hardware-back
behaviour · confirmation on destructive/irreversible actions.

### 3.2 Responsive (RN specifics)

Overflow / clipping / hidden content / misalignment at every width in §2. Check: `flexShrink`
on text rows, `numberOfLines` + `ellipsizeMode` on labels, `flexWrap` on chip/pill rows,
`ScrollView`/`FlatList` for content taller than the viewport, `minWidth:0` on flex children
that hold text, no fixed `width` where `maxWidth`/`flex` belongs, images `resizeMode` +
`maxWidth:'100%'`.

### 3.3 Safe area & platform chrome

- **Keyboard inset is a LOCKED rule** — `useKeyboardLayout()` (`@hooks/useKeyboardLayout`),
  see CLAUDE.md § "Keyboard / focused input". The bottom-most element owns it via
  `bottomPad(gap)`, which REPLACES the safe-area inset (never stacks — that is the iOS
  blind space) and compensates the nav bar RN strips on Android API ≥ 30 (that is the
  Android cut-off). `KeyboardAvoidingView` and `keyboardVerticalOffset` are banned and
  scanned for. Any new keyboard formula is an automatic **Major**. Device cases:
  `docs/qa/KEYBOARD_UI_TEST_PLAN.md`.
- iOS: notch, **Dynamic Island**, home-indicator gesture bar, `useSafeAreaInsets()` on top
  AND bottom (never a raw constant).
- Android: status bar, gesture-nav pill vs 3-button, cutouts, `StatusBar` style/colour.
- Foldable hinge: content not split under the fold; no interactive target under the hinge.
- **Native ABI / 16 KB page size** (Android 15+, newer Pixels + foldables): every bundled
  `.so` must be 16 KB-aligned or the OS shows an "App Compatibility" dialog and runs in
  page-size-compat mode. This is a **native-build** concern (dependency + NDK/AGP versions),
  not a screen fix, but it surfaces during on-device/foldable passes — flag it, don't try to
  fix it in a UI diff. **Known-open:** `sqa.md` **B-83** (Agora 4.3.4 + others unaligned as of
  2026-07-12; warning only, app still runs).

### 3.4 Accessibility (WCAG 2.1 AA target)

- **Contrast** ≥ 4.5:1 body / 3:1 large text & UI — verify against the token, not a guess.
- `accessibilityLabel` / `accessibilityRole` / `accessibilityState` on every touchable,
  icon-only button, and image conveying meaning. Decorative → `accessibilityElementsHidden`
  / `importantForAccessibility="no"`.
- **Dynamic font scaling**: text must reflow, not clip, up to fontScale ≥ 1.3. Use
  `allowFontScaling` deliberately; cap with `maxFontSizeMultiplier` only where truncation is
  worse than scaling (never on body copy).
- **Touch targets ≥ 44×44pt (iOS) / 48×48dp (Android)**; add `hitSlop` where the visual is
  smaller. Spacing between targets ≥ 8dp.
- Focus order + screen-reader traversal is logical; live regions announce async state.

### 3.5 States (every screen, every list, every async surface)

Loading (skeleton/spinner, not a dead screen) · empty (with a next action, not a blank) ·
error (message + **retry**) · offline · partial/slow-network · very-short content · very-long
content · missing fields (`—` fallback, never `undefined`/`NaN`).

### 3.6 Performance

List virtualization (`FlatList`/`FlashList`, stable `keyExtractor`, memoized rows) · avoid
re-render storms (memoize derived arrays passed to children) · animation on the native
driver / `react-native-reanimated` · no layout thrash from per-tick `setState` · image sizing.

### 3.7 Interaction & motion

Pressed/disabled/loading states on every button · no double-submit (disable while in-flight)
· gesture affordances · motion respects reduce-motion · nothing blocks input silently.

---

## 4. Quality gates (design cannot be APPROVED until all pass)

| Gate | Condition                                                                     |
| ---- | ----------------------------------------------------------------------------- |
| G1   | No Critical UX issues                                                         |
| G2   | No Major Accessibility issues (contrast, labels, dynamic type, targets)       |
| G3   | No Responsive failures across the §2 matrix                                   |
| G4   | No Foldable / split-screen breakage                                           |
| G5   | No navigation dead-ends or trap states                                        |
| G6   | No layout breakpoint fails (320dp ↔ tablet-landscape)                         |
| G7   | No Major performance concerns                                                 |
| G8   | **No design-system deviation** (colour / spacing / type / one-primary-action) |

---

## 5. How to run the loop (ultracode = orchestrate with the Workflow tool)

Design review is fan-out-shaped: many screens × many audit dimensions, then converge on
fixes. When **ultracode is on**, drive it with `Workflow`:

1. **Scout (inline):** list the target screens + shared components + the design tokens/utils.
2. **Audit phase (fan-out):** one auditor per (screen × dimension) or per screen with all
   dimensions — each returns a **structured findings list** (schema: file, line, category,
   severity, rootCause, proposedFix). Read code; where visual truth is needed, screenshot on
   a real device (`adb exec-out screencap`, per `sqa.md` §4) rather than guessing pixels.
3. **Verify phase (adversarial):** each Major/Critical finding is verified by a second agent
   that tries to REFUTE it (is it already handled? is the fix a regression?). Default to
   "not a finding" when uncertain.
4. **Fix phase:** apply the confirmed fixes (smallest diff that resolves the finding; reuse
   existing helpers). Objective fixes (safe-area, targets, font-scale, overflow, missing
   states, a11y labels) are applied directly; subjective visual redesign is proposed first.
5. **Re-audit:** re-run the affected auditors on the diff. Loop until the §4 gates pass.

Solo (no ultracode): do the same phases sequentially per `LOOP.md` (maker → verifier →
auditor → risk review). Never skip verification or audit.

**Verification is real, not asserted.** For each iteration: `npm run typecheck` (≤ baseline),
`npm run lint`, and — where a device is attached — build (`npm run apk:staging`), install,
and **screenshot the changed screens at multiple widths / fontScales** to confirm the fix.

---

## 6. Self-critique checklist (run after every iteration)

1. What would a senior product designer criticise here?
2. What will users actually complain about?
3. What breaks at 320dp? … in landscape? … on a foldable at the hinge?
4. What breaks at fontScale 1.3? … with a 40-char name? … with an empty list?
5. What breaks offline / mid-request / on a dropped socket?
6. Does anything violate the locked design system (colour/spacing/type)?
7. Is every touch target ≥ 44/48 and labelled for a screen reader?
8. Is there a dead-end (no back, no retry, no next action)?

Answer honestly → convert each answer into a finding → fix → repeat.

---

## 7. Per-iteration deliverable format

Output every iteration in this shape (append to a working doc under `docs/audits/` for a
large sweep; inline for a single screen):

```
### Iteration N — <scope>
Findings:        [<severity>] <screen> — <issue> (root cause) → <fix>
Fixes applied:   <what changed, file:line>
Remaining risks: <unresolved, with why>
Scores:  UX __/100 · A11y __/100 · Responsive __/100 · Perf __/100 · Foldable __/100 · Prod-Ready __/100
```

---

## 8. Stop condition

Do **NOT** stop after producing a design. Continue iterating until:

```
Critical = 0   Major = 0   Responsiveness ≥ 95   Accessibility ≥ 95
Foldable ≥ 95  Production Readiness ≥ 95
```

Only then:

> ✅ **APPROVED FOR PRODUCTION**

and record the final scores + residual risks in the iteration log (and `sqa.md` for any
field-reported UI bug).
