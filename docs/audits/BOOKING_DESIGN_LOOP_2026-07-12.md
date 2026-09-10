# Booking / Lite — Design Review Loop sweep (2026-07-12)

> Run against [`DESIGN_REVIEW_LOOP.md`](../../DESIGN_REVIEW_LOOP.md). Scope: the whole
> **Lite / Booking** screen family under `src/screens/booking/`. Two workstreams:
> **(A)** finish the navy→obsidian palette sync (5 lagging screens), and **(B)** a full
> design-loop audit of the already-obsidian booking screens with the confirmed fixes applied.
>
> Orchestrated under ultracode via `Workflow` (fan-out audit → fan-out fix), per §5 of the loop.

---

## A. Navy → obsidian palette migration (5 screens)

These five booking screens were still on the legacy **Command Navy** palette
(`@theme/colors` → `Colors`, `#0A1F3F` bg / `#1E88FF` primary). They are now on the
canonical **obsidian** tokens (`@components/ui/tokens` → `UI`, `#07090D` bg / `#5B8DEF`
cobalt), matching every sibling booking screen.

| Screen                          | Colour refs migrated | Navy remaining | Design-loop fixes folded in                                                                |
| ------------------------------- | :------------------: | :------------: | ------------------------------------------------------------------------------------------ |
| `AddOnsScreen.tsx`              |          40          |       0        | back-button hitSlop+a11y; add-on title overflow guard                                      |
| `CreditPaywallScreen.tsx`       |          92          |       0        | back-button hitSlop+a11y; header overflow guards                                           |
| `BookingConfirmationScreen.tsx` |          44          |       0        | crew/paid overflow guards; a11y on 4 CTAs incl. disabled state; success-halo → `UI.signal` |
| `TripSummaryScreen.tsx`         |          26          |       0        | back-button hitSlop+a11y; **added a Retry path to the error state**; crew overflow         |
| `LocationPickerScreen.tsx`      |          52          |       0        | hitSlop+a11y on top-bar + search-modal + FAB icon buttons                                  |

**Verification:** `rg` for the banned navy hex set (`#0A1F3F/#06142B/#1B3A66/#162F54/
#122747/#1C3B66/#244C82/#1E88FF`) and `Colors.` across `src/screens/booking/` → **0 matches**.
`npm run typecheck` → **exit 0 (at/under baseline 47)**. Palette-only + additive props; no
layout or business-logic restructure.

**Deliberate non-navy colours kept exact** (per the "keep status colours as-is" rule):
semantic green/amber/red status tints, agent-purple, JetBrains-Mono ref codes, and
dark-on-amber button text. One residual off-token shadow hex (`#14285A` in
`CustomizeAddOnsScreen`) is handled in Part B.

---

## B. Design-loop audit — already-obsidian booking screens

13 screens audited against the full §3 category set (UX / responsive / safe-area / a11y /
states / perf / interaction). **68 findings, 30 major.** The dominant classes:

1. **Icon-only controls with no screen-reader identity** — back buttons, FABs, steppers,
   toggles, and safety-critical **SOS** buttons missing `accessibilityRole`/`accessibilityLabel`.
   The single most common defect across the family.
2. **Undersized touch targets** — 34–40dp back/SOS/stepper/chip targets below the 44/48
   minimum with no `hitSlop`.
3. **Overflow at 320dp / fontScale 1.3** — status chips, date labels, hero titles, and the
   "trust" pill missing `numberOfLines`/`ellipsizeMode`/`flexShrink`.
4. **State dead-ends** — `BookingHistoryScreen` shows "No bookings yet" during load AND on a
   failed fetch (false-empty + no retry, a **G5** navigation-dead-end); `RateAgencyScreen` and
   `NoDetailScreen` can clip their content past the viewport with no scroll at fontScale 1.3.

### Findings by screen

| Screen                      | Major | Minor | Headline issue                                                    |
| --------------------------- | :---: | :---: | ----------------------------------------------------------------- |
| `BookingHomeScreen.tsx`     |   4   |   3   | FAB + region chip + quick-actions unlabeled / sub-44dp            |
| `ServiceTypeScreen.tsx`     |   3   |   2   | back + selectable ServiceCard have no a11y role/state             |
| `BookingDateTimeScreen.tsx` |   4   |   2   | passenger steppers unlabeled + sub-44dp; date-label overflow      |
| `CustomizeAddOnsScreen.tsx` |   3   |   4   | steppers + toggle no switch semantics; `#14285A` shadow off-token |
| `BaselinePackageScreen.tsx` |   2   |   3   | back button no a11y; decorative icons announced                   |
| `ZoneMapScreen.tsx`         |   1   |   5   | back a11y; "0 CPOs" shown during load (not distinct from empty)   |
| `BookingHistoryScreen.tsx`  |   4   |   1   | **false-empty + no retry dead-end**; status-chip overflow         |
| `AgencyAcceptedScreen.tsx`  |   1   |   4   | SOS sub-44dp; async note not announced                            |
| `MissionCompleteScreen.tsx` |   0   |   3   | decorative icons announced; fare overflow                         |
| `RateAgencyScreen.tsx`      |   2   |   1   | **body clips with no scroll**; back a11y                          |
| `InvoiceScreen.tsx`         |   1   |   3   | back a11y; invoice-number overflow                                |
| `FindingDetailScreen.tsx`   |   2   |   4   | trust-pill clips at 320dp; SOS sub-44dp                           |
| `NoDetailScreen.tsx`        |   3   |   3   | **body clips with no scroll**; SOS + escalate a11y                |

### Deliberately NOT applied (recorded, not fixed)

- `ServiceTypeScreen` L161 — "CTA always enabled even with no service selected." Touches flow
  logic; low-confidence (may be an intentional implicit default). Left for product decision.
- `ZoneMapScreen` L39 — private inline `D` colour map. Flagged by G8, but every value is
  obsidian/cobalt-correct with a documented mockup-parity comment; no navy. Cosmetic only.
- `MissionCompleteScreen` L47 / `FindingDetailScreen` L116 — ScrollView-wrap of the centred
  terminal layout. Structural; auditors flagged "awareness only" to keep the terminal screens
  consistent. Only `RateAgencyScreen` and `NoDetailScreen` (more content, real clip risk) get
  the scroll wrap.
- `NoDetailScreen` L33 — graceful `.catch` fallback fetch; a spinner/error surface would be
  wrong on a calm terminal fallback. Kept.

---

## C. Fixes applied

Fix phase orchestrated as 13 parallel agents (one per screen). **68 findings → applied**, only
the 4 explicitly-deferred items skipped (§B "Deliberately NOT applied"). All edits are additive
props / minimal style changes except three that touch layout or state, called out below.

**By class:**

- **a11y labels/roles** — `accessibilityRole="button"` + `accessibilityLabel` on every icon-only
  back / FAB / SOS / stepper / chip / CTA; `accessibilityState` on selectable cards, toggles,
  disabled buttons; `accessibilityRole="switch"`/`"checkbox"` on the CustomizeAddOns toggle +
  consent row; `importantForAccessibility="no"` on decorative icons; `accessibilityLiveRegion`
  on the AgencyAccepted async note.
- **touch targets** — `hitSlop` on every sub-44/48dp control (back buttons, steppers, SOS, chips,
  View-All, region chip). Visuals unchanged.
- **overflow** — `numberOfLines`/`ellipsizeMode`/`flexShrink`/`maxWidth` on status chips, date
  labels, hero/header titles, invoice number, fare, crew names, the FindingDetail trust pill.
- **states** — `BookingHistoryScreen` now renders a 3-way `ListEmptyComponent` (loading spinner →
  error + **Retry** → true empty), closing the false-empty **G5** dead-end; `ZoneMapScreen` shows
  "Checking…" until availability loads instead of a misleading "0 CPOs online".
- **design-system** — the lone stray `#14285A` shadow hex inside `CustomizeAddOnsScreen` folded
  into that screen's own `D.accentDeep` token (the rest of its shadows already used `D.*`).

**Three structural changes (reviewed in depth):**

1. `BookingHistoryScreen` — added `isLoading`/`error`/`clearError` store selectors + retry wiring.
   Typecheck confirms all three resolve on `useBookingStore`.
2. `RateAgencyScreen` — body `View`→`ScrollView` so the rating (stars + 6 wrapping tag chips)
   scrolls at fontScale 1.3 instead of clipping behind the pinned footer.
3. `NoDetailScreen` — centred body wrapped in a `ScrollView` for the same reason.

**Regressions caught during adversarial review of the fixes (and fixed):**

- `RateAgencyScreen` — the new `ScrollView` was missing `style={{flex:1}}`, so in the flex column
  it would collapse to content height and **unpin the footer/CTA from the bottom**. Added `flex:1`.
- `NoDetailScreen` — the wrapped `s.center` still had `flex:1`, which clamps the child to the
  viewport and **defeats scrolling** (the exact clip the wrap was meant to fix). Dropped `flex:1`
  so the content container's `justifyContent:'center'` centres short content and lets tall content
  scroll.

### Adversarial regression-verify of the 5 migrations

A second, skeptical pass (one refuter per migrated screen, tasked to find contrast/visibility
regressions the palette swap introduced) ran over the 5 migrated screens. **CreditPaywall,
TripSummary, LocationPicker → clean.** Three confirmed regressions found and **fixed**:

- **`AddOnsScreen` (major)** — the unchecked add-on checkbox border was mapped to `UI.hair`
  (9% white ≈ 1.25:1 on the near-black card), so the _only_ selection affordance nearly vanished.
  `UI.hair` is a divider token, not a control outline. → `borderColor: 'rgba(255,255,255,0.22)'`.
- **`AddOnsScreen` (minor)** — the add-on description body copy was mapped to `UI.textMute`
  (45% ≈ 2.9:1, below AA) while every sibling string uses `UI.textDim`. → `color: UI.textDim`.
- **`BookingConfirmationScreen` (minor)** — the CPO avatar fill `avGradient` was mapped to
  `UI.surface` (2.5% white, near-invisible) and inverted the person-vs-vehicle hierarchy (the
  vehicle tile read stronger than the crew). → `backgroundColor: 'rgba(91,141,239,0.14)'`
  (cobalt tint, marks a person, more prominent than the vehicle tile's 6%).

**Lesson (recorded):** a mechanical `Colors.*`→`UI.*` map is safe for backgrounds/text tiers but
_not_ for control outlines and depth-hierarchy fills — `UI.hair`/`UI.surface` are the faintest
tokens and silently erase affordances that a solid navy previously carried. Contrast must be
re-checked per element, not just per token.

**Verification:** grep → 0 navy in `src/screens/booking`; `tsc --noEmit` → **46 errors (≤ baseline
47**, no increase); `eslint src/screens/booking` → **0 errors** (1 pre-existing `||`→`??` warning,
untouched).
On-device screenshots are **pending** — the Pixel's wireless-ADB endpoint dropped during the
session and could not be re-paired; per `DESIGN_REVIEW_LOOP` §"UI verification", this is recorded
rather than claimed as done.

---

## Scores

```
UX 96/100 · A11y 97/100 · Responsive 96/100 · Perf 95/100 · Foldable 92/100 · Prod-Ready 95/100
```

- **A11y 97** — the screen-reader gap (unlabeled icon-only + SOS controls) was the biggest defect
  class and is now closed family-wide; remaining deductions are for items not runtime-tested with
  TalkBack/VoiceOver.
- **Foldable 92** — no hinge/split-screen testing was possible without devices; portrait +
  320dp/fontScale-1.3 overflow is now guarded, but foldable continuity is unverified (see G4).
- **Prod-Ready 95** — meets the gate on static evidence; the remaining 5 is the un-run on-device /
  screen-reader / foldable pass, to be closed on the next build cycle.

---

## Deferred follow-up (device-found, out of scope for this UI sweep)

- **16 KB page-size incompatibility (Android 15 / foldable) → `sqa.md` B-83.** Surfaced during a
  foldable device pass of v1.0.111/vc138: the OS shows an "Android App Compatibility" dialog
  ("RELRO alignment check failed… page size compatible mode") because bundled prebuilt native
  `.so` libs aren't 16 KB-aligned — primarily **`react-native-agora` 4.3.4** (Agora SDK aligned
  only in ≥ 4.5.0), plus `libconceal`/`libbarhopper_v3`/`libargon2native`/`libcrypto`
  (SQLCipher — security-sensitive). **Warning, not a crash; app runs; not caused by this design
  work** (native libs are identical on every build). It is a native-build task (dependency +
  NDK/AGP bump), not a screen fix — deferred by owner request 2026-07-12 to its own build. See
  `DESIGN_REVIEW_LOOP.md` §3.3 (native ABI / 16 KB) and `sqa.md` B-83 for the full fix path.
