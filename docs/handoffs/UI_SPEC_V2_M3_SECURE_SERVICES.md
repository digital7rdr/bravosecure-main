# UI Spec v2 — M3 · SECURE SERVICES (module handoff)

> **IMPLEMENTED 2026-07-16 (B-91 M3 commit).** Shipped: R1 header renamed "SECURE
> SERVICES" (selector card + RoleSelection descs were done in M0; LITE badge + region chip
> kept); R2 direct routing via the M0 shell (secure product lands on BookingHome, resume
> logic untouched); R3 top-left avatar on the booking header opens the shared
> ProfileDrawerModal (replaces the decorative shield badge); R4 two-item taskbar
> (Messenger · Profile) via M0's per-product tab sets — note the Profile TAB opens the
> full ProfileScreen (which carries Switch Dashboard) while the header avatar opens the
> drawer, a deliberate hybrid of the spec's "Profile opens the drawer"; R5 unsaved-booking
> guard: new `isBookingDraftDirty()` + a Stay/Leave confirm inside SwitchDashboardSection
> when leaving Secure with a dirty wizard, and `confirmBooking` now clears the draft on
> success (zone preserved for the region chip) so drafts stop lingering forever.

> Part III of `Bravo_Platform_UI_Corrections_Implementation_Specification.pdf` (PDF pages
> 23–27). **Prerequisite: M0 shell.** Run THE MODULE LOOP from `UI_SPEC_V2_INDEX.md` per
> row. This is the SMALLEST module — the spec explicitly keeps the booking dashboard and
> workflow as-is ("All existing booking functions remain available; only header wording
> and navigation are changed") — which is why the INDEX build order does it right after M0.

**Target in one sentence:** the booking product is renamed "Secure Services", is reached
directly from the selector via its own onboarding, keeps its current dashboard content
plus a top-left profile control, and runs on a two-item bottom taskbar (Messenger ·
Profile) with product switching (→ Messenger / Virtual Bodyguard) only in the profile
drawer, guarded when a booking draft would be lost.

---

## Requirements → current state → plan

### R1 — Product label: "Secure Services" (PDF p.24)

**Spec.** "Bravo Secure Services" → "Secure Services" on the global selector and in all
user-facing product headers. (Brand/app-name usage of "Bravo Secure" — login copy,
CallKit name, permission dialogs, Stripe merchant name, `app.json` — is NOT the product
label and stays.)

**Current state (verified).** The exact string "Bravo Secure Services" occurs ONCE:
`OnboardingScreen.tsx:136` (selector card). Product-label uses of "Bravo Secure":
booking header `BookingHomeScreen.tsx:230` (`BRAVO SECURE` + LITE badge :231), combined-
home module card `DashboardScreen.tsx:527` (dies with M0 §4), selector-adjacent copy
`RoleSelectionScreen.tsx:177,343`, dead-screen labels `HomeSelectionScreen.tsx:37,44,50`
(rebuilt by M0 §2.3), invoice brand header `InvoiceScreen.tsx:85` (brand chrome — keep),
news-hub sub-label `NewsHubScreen.tsx:165` (removed by M1 R8). The target string "Secure
Services" appears nowhere yet — no collision.

**Plan.** Rename the FOUR product-label sites (OnboardingScreen card, BookingHome header
→ "SECURE SERVICES", RoleSelection descs); everything else is handled by its owning
module. Keep the LITE plan badge and region chip (spec allows "active plan and
country/region selector may remain").

**Blast radius.** String-only; check header layout at 320dp with the longer title
("SECURE SERVICES" + LITE badge + region chip on one row — may need `flexShrink`).

---

### R2 — Onboarding & direct routing (PDF p.24)

**Spec.** Selecting Secure Services runs ONLY its onboarding (current account/region/
permissions/service setup retained), then lands on the booking dashboard. Returning users
reopen the last valid dashboard state. No combined screen in between; no VBG intel cards
or Messenger plan selection inside this onboarding.

**Current state (verified).** No Secure-specific onboarding exists. The selector card
routes to the generic signup (`OnboardingScreen.tsx:201` — all three cards share
`handlePath` → RoleSelection), and post-auth everyone lands on the combined Dashboard.
Region is NOT an onboarding step today — it's chosen inside the booking wizard
(`ZoneMapScreen` → `draft.zone_code` → ServiceType → …). The permissions gate is global
(`index.tsx:57,69-72`, `bravo_perms_shown`).

**Plan.** Under M0: `pendingProduct='secure'` carries through the existing generic signup
(account + OTP + permissions — those ARE the "current onboarding steps" the spec
retains); on completion, `activeProduct='secure'` → BookingHome. No new onboarding
screens needed v1 — the spec says RETAIN current steps. Returning users: M0 persistence
reopens the product at `BookingHome` (the booking-resume logic `booking:resume-seen` +
`activeBooking` detection at `BookingHomeScreen.tsx:138-188` already restores mission
context).

**Blast radius.** The `pendingProvider` (agency) branch must keep working — a "Service
Provider/Enterprise" signup is NOT a Secure-Services onboarding (⛔ INDEX Q2).

---

### R3 — Dashboard: keep content, add top-left profile control (PDF p.25)

**Spec.** Keep Book Close Protection / Book Now, Zone Map, My Credits, security-value
cards, Recent Bookings exactly as designed. Product title "Secure Services". Add the same
top-left profile/avatar control the other products use. The dashboard is the product
ROOT (no separate Home tab/button). Loading / no-bookings / service-unavailable states
must not hide core navigation. Book Now continues into the existing flow; returning from
Messenger/Profile actions must not lose an in-progress booking without confirmation.

**Current state (verified).** `BookingHomeScreen.tsx` already has ALL the content:
mission hero "Book Close Protection"/"Mission in Progress" + Book Now CTA (:252-329),
Zone Map + My Credits quick actions (:310-327), trust strip (AES-256/Vetted CPOs/Live
Tracking/Secure Comms :331-342), Recent Bookings + View All (:344-410), How-it-works
(:412-426), FAB (:429-447). `BookingHome` is already the initial route of
`BookingNavigator` (:68-72). **There is NO profile control on it** — header is shield
badge + title + LITE badge + region chip only (:220-247); profile today lives on the
separate ProfileTab (`ProfileScreen.tsx`) and the combined-home drawer.

**Plan.** Header-left becomes the avatar control (reuse the avatar/initials treatment
from `CustomTabBar`'s profile tab, `MainNavigator.tsx:154-164`) opening the shared
ProfileDrawer (M0 §4 extraction); the shield badge moves next to the title or drops.
Everything else untouched — this row is deliberately tiny.

**Blast radius.** None beyond the header; do NOT restyle the approved dashboard.

---

### R4 — Bottom taskbar: Messenger + Profile only (PDF p.25)

**Spec.** Remove Home and Secure from the bottom taskbar; show Messenger and Profile
only. Messenger opens the communication module (not the messenger PRODUCT); Profile opens
the drawer.

**Current state (verified).** One shared 4-tab bar serves the whole client shell —
`CustomTabBar` (`MainNavigator.tsx:80-182`) over static tabs Dashboard('Home') /
MessengerTab / SecureTab('Secure') / ProfileTab (:652-674). There is no per-product tab
mechanism; the bar can only hide per-route.

**Plan.** Under M0's per-product mounts, the Secure product shell renders its OWN 2-item
bar (Messenger · Profile) around `BookingNavigator`. "Messenger" mounts the messenger
MODULE in-context (M0 §5 module-vs-product); "Profile" opens the shared drawer (NOT a
navigation to ProfileTab — the spec says drawer). The `PROFILE_HOSTED_ROUTES` highlight
logic (:73-78) and the SecureTab tab-press reset (:665-672) die with the old shell —
verify their behaviors are either obsolete or re-homed (reset-to-BookingHome-on-tab-tap
becomes reset-on-product-reentry).

**Blast radius.** Every `navigate('SecureTab', {screen:…})` caller (booking wizard,
profile screen rows `ProfileScreen.tsx:216-232`, paywall deep link
`MainNavigator.tsx:247-250`) — all become in-product navigations; sweep list in M0 §3.

---

### R5 — Profile drawer + switching + unsaved-booking guard (PDF p.26)

**Spec.** Top-left avatar opens the standard account drawer (My Profile, My Bookings,
plan/account details etc. retained). Switch Dashboard shows Messenger and Virtual
Bodyguard ONLY (never Secure Services itself). Switching resets the Secure stack and
opens the destination's onboarding-or-dashboard. If a booking form has unsaved data, WARN
before switching. Labels exactly "Messenger" / "Virtual Bodyguard" (no "Open" prefix).

**Current state (verified).** No Switch Dashboard concept exists (grep-confirmed). The
booking draft (`bookingStore.ts:16-41`, `defaultDraft` :70-91) is IN-MEMORY only (no
persist), mutated via `updateDraft` (:139-151); **`resetDraft` is never called from any
screen** (drafts linger until sign-out `reset()` :304-312); there is NO dirty flag and NO
`beforeRemove`/discard pattern anywhere in booking screens.

**Plan.**

1. Drawer: shared ProfileDrawer (M0 §4) with `SwitchDashboardSection` (M0 §5) — matrix
   for `activeProduct==='secure'` = [Messenger, Virtual Bodyguard].
2. Unsaved guard: add `isDraftDirty()` to bookingStore (shallow-diff `draft` vs
   `defaultDraft`, ignoring the region/zone defaults that BookingHome itself sets) —
   `switchProduct()` consults it and shows a branded confirm ("You have a booking in
   progress — leave Secure Services?") before switching. While a booking is IN-FLIGHT
   (`activeBooking` truthy — `BookingHomeScreen.tsx:183-188`), switching is allowed
   without warning (server owns the mission; the dashboard restores it on return).
3. Hygiene fix rolled in: call `resetDraft()` on booking completion/cancel so stale
   drafts stop lingering (root cause of the dirty-flag ambiguity; tiny, test-covered —
   `bookingStore.zoneChange.test.ts` shows the pattern).

**Blast radius.** Booking wizard state machine — the dirty check must NOT fire after a
COMPLETED booking (draft reset ordering); LITE_BOOKING_LOOP applies (this touches the
Lite booking module — run its client lane as regression).

---

## Module acceptance checklist (PDF p.27 — verbatim release gate)

Selector says "Secure Services" · onboarding leads directly to the booking dashboard ·
existing booking content unchanged · top-left profile control + Secure Services title ·
bottom nav = Messenger and Profile only · profile switch lists Messenger + Virtual
Bodyguard only · warn before abandoning an in-progress booking · product switch clears
the old stack · plan/country indicators still control available services · no-bookings /
offline / service-unavailable / failed-booking states handled.

## Module loop additions (on top of INDEX loop)

- **Run `docs/runbooks/LITE_BOOKING_LOOP.md`** baseline + regression — this module wraps
  the Lite booking product; its §7 sign-off (client/agency/CPO lanes) is the exit gate
  for R2/R4/R5.
- Booking end-to-end on device after the tab-bar swap: book → dispatch → live tracking →
  complete; notification deep links into booking screens still land (B-82 watchlist).
- Draft-guard matrix: fresh draft (no warn) · mid-wizard draft (warn) · completed booking
  (no warn) · in-flight mission (no warn, restores on return).
- Agent/agency/CPO shells untouched — they use the same booking backend; smoke one
  agency assignment.
