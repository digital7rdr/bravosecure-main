# Bravo Platform UI Corrections v2.0 — Implementation Handoff (INDEX)

> **Source:** `Bravo_Platform_UI_Corrections_Implementation_Specification.pdf` (28 pages,
> Version 2.0, July 2026) — QA/product target-state spec. **Core intent: ONE app shell,
> THREE clearly separated products** — Messenger, Virtual Bodyguard (VBG), Secure Services —
> each with its own onboarding, dashboard, bottom navigation and entitlements, joined only
> by the shared account and a deliberate "Switch Dashboard" control in the profile drawer.
>
> **This is an architectural program, not a bug batch.** Unlike the B-90 PDF (isolated
> fixes), this spec deletes the app's current hub (the combined command DashboardScreen),
> re-shapes the root navigation into per-product shells, and adds an entitlement tier
> system. Treat it as a phased epic. NO code was changed while writing these docs —
> investigation and planning only.

## Module documents (one per module — work them as units)

| Doc                                                                        | Module                         | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`UI_SPEC_V2_M0_PLATFORM_SHELL.md`](UI_SPEC_V2_M0_PLATFORM_SHELL.md)       | **M0 Platform shell**          | Splash→selector journey, per-product routing, active-product persistence, back-stack reset, deletion of the combined command home, Switch-Dashboard matrix, global naming rules                                                                                                                                                                                                                                                                                                                                    |
| [`UI_SPEC_V2_M1_MESSENGER.md`](UI_SPEC_V2_M1_MESSENGER.md)                 | **M1 Messenger**               | Lite/Pro/Enterprise tiers, direct Chat landing, 5-tab nav, pinned sponsored slot, Departmental-Chat Enterprise gate, Files + 100MB cloud vault, News-feed content boundary, profile-drawer switching                                                                                                                                                                                                                                                                                                               |
| [`UI_SPEC_V2_M1A_TIER_MATRIX.md`](UI_SPEC_V2_M1A_TIER_MATRIX.md)           | **M1A Tier matrix (ADDENDUM)** | Founder-approved 2026-07-17 tier screenshot + verbal rules (incl. round-2 answers): 3 Messenger tier cards (Lite/Pro/Enterprise, full feature lists) + Service Provider card kept as-is; identical signup for all tiers + declinable post-auth paywall ("Start as Lite today"); Settings → Pricing page for easy up/downgrade; EVERY matrix row hard-gated w/ upgrade ask (Lite cloud-vault locked); provider tenant untouched. **Settles Q1** (billing = existing BC/Stripe flow) and supersedes M1 R1/R2 details |
| [`UI_SPEC_V2_M2_VIRTUAL_BODYGUARD.md`](UI_SPEC_V2_M2_VIRTUAL_BODYGUARD.md) | **M2 Virtual Bodyguard**       | Single-scroll Home (Principal→map→SRA/Nearby→Quick Actions→GeoRisk), real key-points map + expanded view + navigation handoff, Nearby list, 72-hour news filter, 3-tab nav                                                                                                                                                                                                                                                                                                                                         |
| [`UI_SPEC_V2_M3_SECURE_SERVICES.md`](UI_SPEC_V2_M3_SECURE_SERVICES.md)     | **M3 Secure Services**         | "Secure Services" rename, direct onboarding→booking dashboard, top-left profile control, Messenger+Profile-only taskbar, drawer switching, unsaved-booking guard                                                                                                                                                                                                                                                                                                                                                   |

**Read order for the implementing session: M0 FIRST.** M1–M3 all sit on the shell decisions
made in M0 (product persistence, back-stack reset, per-product tab bars). Implementing a
product module before the shell exists means rework.

## Suggested build order (phases, not files)

1. **P1 — Shell skeleton (M0):** product selector post-auth, active-product persistence,
   per-product navigator containers, back-stack reset on switch. The combined DashboardScreen
   stays temporarily reachable behind a flag until P2–P4 land (its SOS/warm-up duties must be
   re-homed first — see M0 §4).
2. **P2 — Secure Services (M3):** smallest delta (rename + tab bar + drawer) — proves the
   per-product shell on the least-changed product.
3. **P3 — Messenger (M1):** tiers/entitlements groundwork + nav + content boundaries.
4. **P4 — VBG (M2):** biggest UI build (single-scroll Home + map work).
5. **P5 — Kill switch:** delete the combined command home + legacy routes; run the full
   cross-product acceptance pass (all three PDF checklists + the final test matrix).

## THE MODULE LOOP (run per module; adapted for a target-state spec)

The B-90 loop was "reproduce the bug"; here there is no bug — there is a **target state**
and a **current state**. The loop per module:

```
┌─▶ 1. BASELINE   — screenshot/screen-record the module's current flows (the doc's
│        "Current state" section lists them). These are your regression reference.
│   2. GAP CHECK  — re-verify the doc's Current-state file:line claims still hold
│        (parallel sessions ship daily). If drifted, update the doc BEFORE coding.
│   3. SLICE      — implement ONE requirement row (each doc's table is ordered);
│        smallest diff that satisfies the row's Target.
│   4. SPEC CHECK — verify the row against the PDF's own acceptance wording
│        (each doc embeds its module's acceptance checklist verbatim).
│   5. ISOLATION PASS (the second perspective — MANDATORY, this spec's #1 risk):
│        a. The OTHER two products still work: boot each, walk its golden path.
│        b. The AGENT/CPO/agency shells (AgentNavigator, CpoNavigator) are NOT part
│           of this spec — confirm they are untouched and still mount for those roles.
│        c. Deep links + push-notification routes still resolve (notifications
│           navigate into specific screens — grep the handlers listed in M0 §6).
│        d. Back button from every new landing screen: must NOT escape into another
│           product or a deleted screen.
│   6. GATES      — npm run typecheck (≤ baseline 47) · lint · targeted jest project ·
│        full npm test before module sign-off. Navigation changes: also boot on device
│        (emulator ok) — navigator wiring errors are runtime, not compile-time.
│   7. ROW DONE?  — no → back to 3 (or 2 if reality drifted). yes → next row.
│   8. MODULE DONE when: every requirement row ticked + the module's PDF acceptance
│        checklist passes on device + isolation pass clean + gates green.
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Standing rules for every module**

- The spec's "keep current design" items are as binding as its changes — do not restyle
  approved screens (Calls, booking dashboard, chat list) while in there.
- Security constraints from CLAUDE.md still gate everything: entitlement checks are
  auth/permission surfaces (server-verified, never client-only); SOS/emergency-call/
  location flows need explicit confirmation patterns; never log location or message content.
- The obsidian design system (B-90 T-13 tokens) is the visual base — the spec's "keep the
  current dark theme" maps to it.
- Log progress per module in `sqa.md` under a new `B-91` cluster (B-90 was the last used as
  of 2026-07-16 — re-check before claiming).

## Cross-cutting risks (why M0 must land first)

1. **The combined DashboardScreen is load-bearing** — it is the client shell's default
   first tab and the ONLY host of the client SOS/panic system, the activity/notification
   drawer and the profile drawer. (The messenger runtime warm-up is safe — it lives in
   MainNavigator effects, not the Dashboard.) M0 §4 lists every duty that must be re-homed
   before deletion.
2. **Entitlements don't exist yet as a tier system** — "Lite/Pro/Enterprise" is today a mix
   of role flags (`service_provider`), build flags (`EXPO_PUBLIC_DEPT_CHAT_V2`) and one-off
   purchase screens. M1 §2 defines the minimal tier model; server-side enforcement is
   REQUIRED by the spec ("no entitlement can be bypassed through a deep link").
3. **Push notifications and deep links route into today's tree** — every route rename/removal
   must update the notification handlers or killed-app taps will dead-end (B-82 class).
4. **Agent/CPO/agency surfaces share screens with the client products** (booking, messenger,
   VBG is client-only) — the spec covers the CLIENT experience; agent flows must keep
   working unchanged.
5. **Conflict with B-90:** the spec (Messenger p.12) says drawer items "My Profile, My
   Bookings, Bravo Pro, Agent Portal … may remain" — but B-90 T-05 (boss's own later
   instruction) REMOVED Agent Portal as dead. Keep it removed; flag to the boss. Similarly
   the B-90 links/news changes are newer than the spec's mockups — reconcile per module doc.

## Open questions for the boss (blocking items marked ⛔)

1. ⛔ **Tier system source of truth (M1):** where do Lite/Pro/Enterprise subscriptions come
   from — in-app purchase, ops-console assignment, or existing `bravo_pro` flags? The spec
   defines the UX, not the billing. Server work is implied.
2. ⛔ **"Enterprise" vs today's service-provider/agency onboarding (M1/M0):** today
   "Service Provider" routes into agency onboarding (org creation). The spec renames the
   TIER to Enterprise and keeps the user "inside the Messenger product". Confirm: does
   Enterprise replace the agency signup entirely, or is agency onboarding reached elsewhere?
3. **Sponsored-slot campaign source (M1):** "remotely updated by an administrator" — needs a
   tiny campaign API/collection + ops-console editor, or a hardcoded first campaign?
4. ~~**SM-512 (M1):** the label must read "SM-512" — confirm which existing feature this maps
   to (there is no SM-512 crypto in the app; it can only be a marketing label — MUST NOT
   drive any actual crypto change; see M1 §8 security note).~~ **RESOLVED 2026-07-17:
   founder — the SM-512 wording was a spec mistake; the row is removed from the tier
   matrix entirely (all tiers). Do not (re)introduce the label anywhere. In the same
   correction, "Cloud Backup" moved out of Lite (now Pro/Enterprise only).**
5. **News source for 72h filter (M2):** the filter must be applied "in the query or API
   layer" — confirm which backend owns the news feed (see M2 §6 findings).
6. **Splash "2 seconds" (M0):** current JS splash runs 2.5 s and ONLY pre-auth (returning
   users skip it); confirm fixed 2 s hold vs "up to 2 s while booting", and whether
   returning users should see it at all.
7. ⛔ **Vault free tier (M1 R7):** spec says 100 MB free; the SHIPPED purchase screen
   promises "Base vault is 500 MB free for all users" and the client defaults to 500 MB.
   Which number wins (and what happens to users who saw 500)? Server quota enforcement is
   net-new either way.
8. **SOS pipelines (M0 §4 / M2 R3):** the combined home's `sosApi` panic and VBG's
   `vbgApi.panic` hold-to-alert are two different systems. Deleting the combined home
   removes the only `sosApi` entry — merge them or retire `sosApi`? (Ops-console
   implications.)
9. **"Request Support" quick action (M2 R3):** today it's a placeholder navigate to the
   OSINT feed. What should it actually do — open a support chat in the messenger module, or
   a new support-request endpoint?

---

_Written 2026-07-16. Companion register: `sqa.md` B-90 (previous batch). Each module doc
carries its own Current state → Target → Plan → Blast radius → Loop additions → Acceptance._
