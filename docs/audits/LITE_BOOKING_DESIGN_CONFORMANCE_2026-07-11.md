# Lite CPO Booking — Bravo Design-Conformance Review

**Date:** 2026-07-11 · **Branch:** `main` @ `387beab` · **Type:** design/style audit (read-only findings + partial fixes)

Reviewed the Lite booking client screens against the app's design tokens (`@theme/colors`
`Colors`, `@theme/bravo` `BravoFont`/`BravoMetrics`, `@components/ui/tokens` `UI`) and the
on-style exemplars (`FindingDetailScreen`, `AgencyAcceptedScreen`, `MissionStepper`,
`TripSummaryScreen`).

## Headline: three palettes coexist (the dominant drift)

The flow is mid-migration between **Command Navy** (`Colors`, used by
`BookingConfirmation`/`LiveTracking`), **Obsidian/cobalt** (`UI`, the _intended_ shared
source, used by `FindingDetail`/`AgencyAccepted`/`MissionStepper`), and **per-screen local
clones** (`const B`/`const T` re-declaring `UI` with raw hex, in `BookingHome`/`OTP`/`Login`).
Semantic colors are re-invented per file (4 ambers, 4 blues, 7 reds across 8 files). This is
the root of most nits below.

## Fixed now (touch-local, low-risk — shipped with the B-82 bug fixes)

| Item                                                       | Where                                  | Fix applied                                                                                                                  |
| ---------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `VerifyGuardCard` text was system-default (no `BravoFont`) | `LiveTrackingScreen.tsx` verify styles | Added `BravoFont.bold/regular/mono` to `verifyTitle/verifySub/verifyCode/verifyPanicText`; new `verifyRetry` styled to match |
| Verify card had no error/retry a11y                        | `LiveTrackingScreen.tsx`               | New Retry control with `accessibilityRole="button"` + label; reconnecting/refresh banners labelled                           |
| 30-min "Refresh now" banner had no a11y                    | `LiveTrackingScreen.tsx`               | Added `accessibilityRole`/`accessibilityLabel`                                                                               |

(These rode along because the same screens were being edited for LB-OTP1/2, LB-ST3, LB-API2.)

## Deferred (documented follow-up — needs a design-direction decision, NOT bug fixes)

These are **structural/visual refactors**; applying them blind (no on-device visual check) is
riskier than the value, so they are logged rather than force-applied:

1. **Palette consolidation (should-fix, structural).** Delete the local `const B`/`const T`
   clones in `BookingHomeScreen.tsx:13-25`, `OTPVerificationScreen.tsx:30-42`,
   `LoginScreen.tsx:28-41`; `import {UI}` instead. `BookingHome`'s `B.amber '#E2C893'`
   diverges from `UI.amber '#F5C76B'` (the "My Credits" star is a different gold). Reconcile
   the two auth-screen error reds (`#F58B97` vs `#FF8B8B`).
2. **Navy↔Obsidian seam (needs direction).** `BookingConfirmation` + `LiveTracking` are built
   on `Colors` (navy) but embed `MissionStepper` (Obsidian cobalt) → two blues on one screen.
   Decision: move those two screens onto `UI` (like Finding/AgencyAccepted already are), since
   the shared `MissionStepper` can't change. Also `VerifyGuardCard`'s cobalt tints sit on a
   navy screen.
3. **`bookingStatus.ts` status palette (should-fix).** `:18-36` hardcodes slate/Tailwind hex
   with no token ref (`DRAFT/COMPLETED '#475569'` is borderline-WCAG grey on `#07090D`).
   Map each status to `UI`/`Palette` tokens. **Constraint:** consumers concatenate alpha
   (`display.color + '14'` etc.), so the map must stay **6-digit hex** — don't migrate to
   `rgba()` without refactoring the call sites.
4. **Auth screens off-brand typeface (blocker for brand, but large).** `OTPVerificationScreen`
   - `LoginScreen` use bare `fontWeight` (system sans) + literal `'monospace'`, no Manrope.
     Swap to `BravoFont.*`. (Client-side OTP autofill for LB-OTP3 was fixed server-side, so I
     did not re-open these screens for the font pass.)
5. **SOS/CTA a11y gaps (should-fix).** `FindingDetailScreen.tsx:110-114` and
   `AgencyAcceptedScreen.tsx:104-108` SOS buttons lack `accessibilityRole`/`accessibilityLabel`
   (LiveTracking's EMERGENCY has both — copy that). Primary CTAs on OTP/Login/BookingConfirmation
   also lack labels.
6. **Radius/size drift (nits).** chip radius `7` (BookingHome) vs `999` (TripSummary/pills);
   card radii 8/10/12 (navy) vs 14-16 (obsidian) vs `BravoMetrics.cardRadius 18`. Twin screens
   (`AgencyAccepted` vs `FindingDetail`) use 3 button heights for the same role. Pick one scale.

## Already on-style — preserve

`FindingDetailScreen` + `AgencyAcceptedScreen` are the model (import `UI`, `UI.f*` fonts,
`scaleTextStyles`, `MissionStepper`, pill radius 999). `MissionStepper` is a clean single-source
Obsidian component. **Status is always a text-labelled chip, never colour-only** — good, keep it.
`scaleTextStyles(...)` wraps every StyleSheet (the responsive-typography contract).

## Recommended next step

One consolidation pass — delete `B`/`T` clones → `UI`, point `bookingStatus.ts` at tokens, add
`BravoFont` to auth + navy-screen text — removes items 1-4 and 6 at once. Do it behind a
2-device visual check (light/dark), since there's no automated visual regression. Touch files:
`src/theme/colors.ts` (add the one missing semantic red), `src/components/ui/tokens.ts`, and the
eight screen files.
