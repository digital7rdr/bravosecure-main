# Secure Services — Client Change Request + Streamline + Nav Audit (Aug 2026)

**Source:** two client PDFs (`Bravo_Secure_Services_Developer_Changes_Aug_2026-1.pdf` = 8-item
acceptance checklist; `Secure Services Streamlined.pdf` = booking-flow consolidation) + the founder's
message on app-wide navigation ("I click Messenger, it takes me to a second screen and then to
something else… back buttons, errors, basic functionality must work").

**How this runs (founder rule):** each item is built by an **Opus 5 builder** agent with an **Opus 5
edge-case** agent, reviewed by me as **critic**, looping until we agree; RED-first pin per fix,
commit + push to main after each (or a coherent wave). Two items below are blocked on a **product
decision** (marked ⛔DECISION).

**Status legend:** ✅ done · 🟡 partial · ❌ not done · ⛔ needs decision. File:line from the 2026-08-21
read-only audits (re-grep before editing — lines drift).

---

## 0. Decisions needed from the founder (block their items)

> **ANSWERED 2026-08-21:** **D1 = keep live-session** (Pro Request Protection unchanged — confirm not a
> dead link, no rebuild). **D2 = "Request additional seats"** → files an Ops request. **D3 = remove the
> Lite plan card** (chooser = Pro + Lux). **D4 = quick-wins + nav first**, then the PDF-2 consolidation as
> its own project.

| #                     | Question                                                                                                                                                                                                                                                                                              | Options                                                                                           | Default if no answer                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| D1 (PDF-1 #2)         | Should the Pro dashboard's **"Request Protection"** do the _same_ thing as Lite's **"Book Now"** (the booking wizard), or is the current **live-session** flow (`ProLiveMission`) the intended Pro action?                                                                                            | (a) keep live-session (it's wired + working), (b) point it at the booking wizard, (c) offer both  | (a) keep — it's the correct retainer analogue; just confirm           |
| D2 (PDF-1 #7)         | **Linked member seats** at 4/4 — what next action?                                                                                                                                                                                                                                                    | (a) "Request more seats" → files an Ops request, (b) "Upgrade plan", (c) hard cap + contact route | (a) Request more seats (Ops request) — least infra, no dead-end       |
| D3 (PDF-2 A4)         | Remove the **"Lite" plan card** from the chooser (plans = Pro + Lux)? Lite becomes the home's Book-Now, not a plan card.                                                                                                                                                                              | yes / no                                                                                          | yes (matches PDF-2)                                                   |
| D4 (PDF-2 A7 / scope) | The full PDF-2 consolidation (6-step wizards → **one Booking dashboard per service** + a new **Home/Service/Booking/Summary/Messenger bottom-tab navigator**) is a large structural rewrite. Do it now as one project, or ship the PDF-1 quick wins + nav fixes first and schedule the consolidation? | now / after quick-wins                                                                            | after quick-wins (de-risk; PDF-1 + nav are higher-signal, lower-risk) |

---

## 1. PDF-1 — Developer Change Request (8 acceptance items)

| #   | Item                                                                                                                 | Status | Where (re-grep)                                                                                                                                                                                                                                                                    | Fix                                                                                                                                                                                                                                                                                                                                                             | Effort                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Plan routing** — Pro→Pro dashboard, Lite→Book-Now home (not the plans chooser)                                     | ❌     | `MainNavigator.tsx:1422-1426,1439-1446` (lands on `SecureServices` chooser); `SwitchDashboardSection.tsx`. Tier source EXISTS: `useSecureProStore(st=>st.application)` `status==='ACTIVE'`⇒Pro (used already at `BookingHomeScreen.tsx:290`, `SecureServicesScreen.openPlan:189`). | Branch the `SecureTab` landing (+ SwitchDashboard) on the store: ACTIVE→`ProDashboard`, else→`BookingHome`. `application` loads async → default `BookingHome`, focus-effect `replace` to `ProDashboard` once ACTIVE resolves (or a tiny resolver landing). **Do NOT use messenger `isProActive`/`subscription_tier` (SP-01: different product, shared vocab).** | M (routing spine) — must update `secureProductLanding.test.ts`, `switchDashboardProductRoot.test.tsx`, `nestedNavigationInitialFlag.test.ts` (they pin the chooser landing today) |
| 2   | **Pro "Request Protection" == Lite "Book Now"**                                                                      | 🟡⛔D1 | Pro tile `ProDashboardScreen.tsx:184-203`→`ProLiveMission` (real, working); Lite `BookingHomeScreen.tsx:360`→`ZoneMap`. Different flows by design.                                                                                                                                 | Per D1. If parity wanted: point the tile at the booking wizard or add a second tile. Otherwise NO CHANGE (don't redo).                                                                                                                                                                                                                                          | S (one navigate) if changed                                                                                                                                                       |
| 3   | **Country labels** — "Active Countries"→"Countries on Demand"; "Countries Coming Soon"→"Countries on Request"        | ❌     | `ZoneMapScreen.tsx:346, 370` (+ neighbours: `AVAILABLE ZONES` :322, row `COMING SOON` :133/201, a11y :98/196)                                                                                                                                                                      | Two string edits (+ consistency pass on neighbours). No test pins them.                                                                                                                                                                                                                                                                                         | XS (trivial)                                                                                                                                                                      |
| 4   | **Request-status wording** — no-CPO must read "Protection Requested" (Ops notified), not "Couldn't start protection" | ❌     | `ProLiveMissionScreen.tsx:200-205` (error alert + `setPhase('idle')`). Server: `protection.service.ts:89-96` emits the ops alert THEN throws `no_cpo_assigned` (Ops IS notified; no session row).                                                                                  | Client: the `no_cpo_assigned` branch → positive "Protection Requested" copy + neutral state (keep the generic `else` a real error). Optional server: persist a `REQUESTED`/pending session for a real "awaiting assignment" state (larger, touches the protection FSM).                                                                                         | S (copy) / M (server option)                                                                                                                                                      |
| 5   | **Assigned Team real data** — CPOs/vehicles/resources                                                                | 🟡     | `ProAssignedTeamScreen.tsx`: CPOs tab ✅ REAL (`secureProApi.team`, :55-70,121-156); **Vehicles** ❌ `const VEHICLES=[]` :36; **Resources** ❌ static :187-191. (= PDF Issue 30 HIGH.)                                                                                             | Backend: add vehicle (make/model/colour/plate/call-sign) + resource assignment to the Pro team/mission endpoint. Client: render in the Vehicles/Resources tabs. CPOs tab needs NO work.                                                                                                                                                                         | M (server field + client)                                                                                                                                                         |
| 6   | **Calendar date-range copy** — clean range not raw ISO                                                               | ❌     | `SecureProCalendarScreen.tsx:331-334` (`5 dates · 2026-09-01 → 2026-09-05`) + `:410-412` (`.join(' · ')`). `@utils/datetime` has `fmtDateUtc`/`fmtDayMonthUtc` but NO range/grouping helper.                                                                                       | Add pure `formatDateRanges(iso[]):string` (sort, group consecutive runs, `DD Mon YYYY` endpoints, "Booked from X to Y", else grouped ranges). Use at both sites. Unit-test it.                                                                                                                                                                                  | S (pure + testable)                                                                                                                                                               |
| 7   | **Member seats "Family Full" dead-end**                                                                              | ⛔D2   | `SecureProMembersScreen.tsx:38` `MAX_SEATS=4`, :390 dimmed "Family Full"; server `INVITE_ERRORS.family_full:64`. Hard cap, no upgrade/request path.                                                                                                                                | Per D2. If "Request more seats": actionable CTA at cap → files an Ops request (reuse the ops-audit request pattern) + a small endpoint.                                                                                                                                                                                                                         | S–M depending on D2                                                                                                                                                               |
| 8   | **Credit refund notice**                                                                                             | ❌     | `CreditsScreen.tsx` (Top Up 254-303 / History 307-348) — no disclaimer anywhere.                                                                                                                                                                                                   | Add a `noteCard`-style disclaimer under the payment-method card (Top Up) and/or bottom of History. Additive text; wording per `docs/audits/CREDITS_BC_AUDIT.md`/legal.                                                                                                                                                                                          | XS (additive)                                                                                                                                                                     |

**Quick wins (no decision, low risk):** #3, #4 (copy), #6, #8. **Then:** #1 (routing), #5 (backend add). **Blocked:** #2 (D1), #7 (D2).

---

## 2. PDF-2 — Streamlined booking flow (structural, "nothing new added")

**Headline: essentially NOT started structurally** — the current flow is a multi-step wizard behind a
plans-chooser landing. Only two PDF-2 sub-pieces already exist (A6a duration increments, A6b transport
progressive disclosure). This is a large rewrite; gate on **D4**.

| #   | Item                                                      | Status            | Where                                                                                                                                                                                                                                           | Fix                                                                                                                                              |
| --- | --------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | Two entries → one Secure Home w/ primary Book-Now         | 🟡                | entries `ProductGateScreen.tsx:34/64`, `SwitchDashboardSection.tsx:135`; both land on `SecureServices` chooser (`MainNavigator.tsx:1422`), Book-Now home is a _separate_ screen `BookingHomeScreen` beneath it                                  | Root `SecureTab` at `BookingHome`, demote the plans chooser to a card. (Overlaps PDF-1 #1.)                                                      |
| A2  | Book Now → immediately Secure Transfer vs Exec Protection | ❌                | Book Now→`ZoneMap` (a Zone step first); service choice is `ServiceTypeScreen` with **4** cards                                                                                                                                                  | Route Book Now straight to `ServiceType`; fold Zone into the consolidated booking screen                                                         |
| A3  | Remove **Recon Team** from service selection              | ❌                | `ServiceTypeScreen.tsx:86-92` (`recon_team`); add-on `CustomizeAddOnsScreen.tsx:75`, `AddOnsScreen`                                                                                                                                             | Delete `recon_team` from `SERVICES` (+ the `recon` add-on if intended). Also remove `Emergency Extraction` locked card? (confirm)                |
| A4  | Plans = Pro + Lux (drop Lite card)                        | ❌⛔D3            | `SecureServicesScreen.tsx:59-86` = Lite/Pro/Lux                                                                                                                                                                                                 | Per D3: remove Lite card                                                                                                                         |
| A5  | **Secure Transfer** = ONE Booking dashboard               | ❌                | 6 screens: `ZoneMap`→`ServiceType`→`BookingDateTime`(+`LocationPicker` modal)→`BaselinePackage`→`CustomizeAddOns`→`CreditPaywall`                                                                                                               | Collapse steps into one scrollable dashboard writing the same `bookingStore` draft; keep pricing/approval unchanged                              |
| A6  | **Executive Protection** = ONE Booking dashboard          | ❌ (sub-parts ✅) | 6 screens `ExecDuration→ExecSchedule→ExecTask→ExecTransport→ExecTeam→ExecReview`. Duration 3-24/3h ✅ (`executiveProduct.ts:10`); transport progressive disclosure ✅ (`ExecTransportScreen.tsx:96,138-152,185-189`); Female CPO only as add-on | Consolidate into one dashboard; keep transport toggle inline; surface `female_cpo` as a first-class toggle if wanted                             |
| A7  | Bottom nav Home/Service/Booking/Summary/Messenger         | ❌                | No Secure bottom-tab nav; `BookingNavigator` is a plain stack; footer = root `CustomTabBar` filtered to `PRODUCT_TABS.secure=['MessengerTab','ProfileTab']` (`MainNavigator.tsx:97`)                                                            | Add a `createBottomTabNavigator` for Secure (Home/Service/Booking/Summary/Messenger) or extend `PRODUCT_TABS.secure`. Largest structural change. |

---

## 3. Whole-app Navigation Audit (founder's "wrong screen / back / errors")

**No consumer double-hop _loader_ exists** (`MessengerNavigator.tsx:61 initialRouteName="MessengerHome"`
is pinned, B-85). The "second screen" feeling has real causes:

| #   | Finding                                                                                                                                                          | Status   | Where                                                                                                                                                                                                                                                          | Fix / note                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | **Messenger bottom bar is PUSH nav, not a persistent tab bar** — each "tab" pushes a full sibling screen and the bar disappears ("takes you to a second screen") | design   | `MessengerHomeScreen.tsx:1567-1610` `navigate('Groups'                                                                                                                                                                                                         | 'CallsLog'                                                                                       | 'Files' | 'NewsHub')` | Consider a real bottom-tab navigator for Messenger (Chats/Calls/Files/News/Channels) so the bar persists — also satisfies PDF-2 B2. Larger; scope with D4. |
| N2  | **Agency-shell dead taps — LIVE BUG**                                                                                                                            | ❌       | `MessengerHomeScreen.tsx:1584/1586`→`CallsLog`/`NewsHub`; `AgentNavigator.tsx:288` mounts the screen but registers NEITHER route → silent no-op                                                                                                                | Register `CallsLog`+`NewsHub` in `AgentNavigator` (or gate the footer per shell). **Fix first.** |
| N3  | **ProfileDrawerModal cold-stack-seed** — back no-op                                                                                                              | ❌       | `ProfileDrawerModal.tsx:201` `go('SecureTab',{screen:'BookingHistory'})` with NO `initial:false` → seeds the lazy stack at `BookingHistory` with no `BookingHome` beneath → back falls out. Invisible to `nestedNavigationInitialFlag.test.ts` (aliased `go`). | Add `initial:false`. **Fix first.**                                                              |
| N4  | Conditional **"← Secure Services"** back in Messenger                                                                                                            | ❌       | none exists (`src/screens/messenger/**` grep empty); header `MessengerHomeScreen.tsx:760-808` has no back chevron                                                                                                                                              | Thread a "cameFromSecure" param; render a top-left back that pops the product. (PDF-2 04.)       |
| N5  | Messenger tabs should be **Chats/Calls/Files/News/Channels**                                                                                                     | ❌       | `MSG_TABS` = Chat/Groups/Call/Files/News (`:1567-1573`) — "Groups" where "Channels" should be; no Channels tab                                                                                                                                                 | Rename/replace per PDF-2; verify a Channels destination exists                                   |
| N6  | `MessengerHome` name bound to **different components** (chat home vs `FilesScreen` on the Dept Vault tab `DepartmentalNavigator.tsx:247`)                        | latent   | —                                                                                                                                                                                                                                                              | a `replace('MessengerHome')` inside Vault shows Files — audit callers                            |
| N7  | Orphaned legacy `AddOns`/`AddOnsScreen` (`BookingNavigator.tsx:166`) parallel to live `CustomizeAddOns`; dead `Dashboard`/`NewsTab`/`AgentStack` ParamList decls | cleanup  | —                                                                                                                                                                                                                                                              | remove dead routes to prevent silent no-op navigates                                             |
| N8  | Large **intentional** duplicate-route web (deep-link degrade, resolved by `messengerDeepLink.ts`/`departmentalEntry.ts`)                                         | standing | —                                                                                                                                                                                                                                                              | any NEW cross-shell route MUST be added to the resolver table or it drops                        |

**Nav fix-first:** N2 (live agency dead taps), N3 (back no-op). Then N4/N5 (PDF-2 Messenger context), N1 (bar) with D4.

---

## 4. Proposed execution sequence (waves)

> **PROGRESS:**
>
> - **Wave 1 ✅ DONE** (commit `a76ad2ea`, pushed) — PDF-1 #3/#4/#6/#8 + Nav N2/N3.
> - **Wave 2 ✅ DONE** (commit `9f7c9699`, merged `b369233a`, pushed) — PDF-1 #1 tier-based landing
>   (`SecureLandingScreen` resolver + shared `secureRootRoute`); edge review caught + fixed a cross-user
>   PII leak (secureProStore now reset in signOut). #2 confirmed (Pro tile → registered ProLiveMission,
>   no change per D1).
> - **Wave 3 ✅ DONE** (commit `c431ca8a`, pushed) — #7 request-seats CTA (new `POST /family/request-seats`
>   in auth-service; self-serve cap of 4 preserved), A4 removed the Lite card (Pro + Lux), #2 confirmed.
>   **Deploy-owed (auth-service):** batched with Wave 4's auth-service backend — deploy once after Wave 4.
> - **Wave 4 ✅ DONE (Path B — honest empty state) + DECISION OWED.** #5 assigned-team vehicles/resources:
>   investigation found NO Pro-side assignment model exists — `pro_cpo_assignments` / `protection_sessions`
>   carry no vehicle/plate/resource link, and `vehicle_pool` (which HAS the right fields: call_sign,
>   make_model, plate, colour, armor_grade) is bound exclusively to the Lite booking product
>   (`lite_bookings.vehicle_id`). No path from a Pro mission to a vehicle today. So the fix removed the
>   always-empty `VEHICLES` stub + dead render/styles and shipped an honest, false-trigger-free empty
>   state ("...will appear here once it's allocated to your protection detail") — NEVER a fabricated
>   vehicle. Dual-AGREE (edge caught a false "once Ops confirms" trigger; copy decoupled from
>   mission-confirm). **Issue 30 is NOT fully resolved by this** — the real feature (a Pro vehicle-
>   assignment model: schema link + ops-console picker + endpoint join + client render) is bigger than a
>   wave and needs a founder product call (reuse Lite `vehicle_pool` vs a Pro fleet? do Pro assignments
>   lock a vehicle? is "Resources" real inventory or informational?). Surfaced to founder.
> - **Issue 30 full build ✅ SHIPPED + DEPLOYED** (the founder chose to build the real feature after Wave 4's
>   honest empty state). Separate Pro fleet + real resource inventory across DB/auth-service/ops-console/mobile —
>   see `PRO_FLEET_RESOURCES_ISSUE30.md`. Migration applied to Supabase; auth-service + ops-console deployed to
>   staging & verified. Wave-3 `/family/request-seats` deploy cleared (batched). Mobile APK deferred (founder).
> - **Wave 5 ✅ COMPLETE** (all 6 sub-waves on main, each dual-AGREE): 5a `67fb0374` (remove Recon +
>   Book-Now→service choice), 5b `9ad5681c` (Secure Transfer → one dashboard), 5c `a76da05f` (Exec →
>   one dashboard), 5d `4d30c6ba` (Secure 4-tab nav via leaf-in-BookingNavigator), 5e `c8c30696`
>   (Messenger tabs Chats/Calls/Files/News/Channels + "← Secure Services" back), 5f `afc7e77f`
>   (persistent Messenger bar via state-based tabs; Files stays a push — vault-PIN gate can't embed).
>   **DEVICE-VERIFICATION OWED** (all deferred per the session pattern): the consolidated dashboards'
>   full book→pay flow on device (both services); the Secure 4-tab bar; the Messenger persistent bar
>   (client bar-persistence across tabs, CPO double-bar, agency shell, News no-lag, hardware-back→Chats).
>   Mobile APK owed to reach devices. **NEXT: FB-1 + FB-2** (`POST_WAVE5_FOUNDER_BUGS.md`).
> - **Wave 5 (superseded detail)** — PDF-2 consolidation. Design mapped (see the session transcript / the
>   sub-wave table below). Founder decisions 2026-08-21: remove ONLY Recon (keep Emergency teaser);
>   **4 tabs** Home/Book/Summary/Messenger (Service+Booking merged); Messenger "Channels" tab → the
>   **Departmental channel tree**; **N1 persistent Messenger bar IS in scope**. Defaults: leave the
>   `recon` add-on; Summary = active-booking status; `female_cpo` stays an add-on; the Secure bar
>   replaces the root footer while in SecureTab. Key fact: wizards submit on step 5/step 7
>   (`CustomizeAddOns`/`ExecReview`) — dashboards reuse the SAME `confirmBooking` + shared pricing
>   modules unchanged; `CreditPaywall` stays a pushed detour.
>   - **5a** (low): A3 remove Recon card + A2 point Book-Now/FAB/region-chip at `ServiceType`.
>   - **5b** (high, money): A5 grow `CustomizeAddOnsScreen` into the Secure Transfer dashboard.
>   - **5c** (high): A6 grow `ExecReviewScreen` into the Exec dashboard.
>   - **5d** (high, nav): A7 4-tab Secure bottom-nav + N4 back + N5 Channels rename + N1 persistent bar.
>     Each: builder→edge→critic, RED-first, commit+push, FULL messenger + booking gates. Do NOT delete a
>     source-scanned screen file without updating its scan list in the same commit.
>   - **After Wave 5:** FB-1 (channel-tree tap targets) + FB-2 (incident-report org leak) —
>     `POST_WAVE5_FOUNDER_BUGS.md`.
> - Device-owed carried forward: agency Call/News taps, My-Bookings back button, Pro/Lite no-flash landing,
>   the 4/4 request-seats CTA (needs the auth-service deploy).
> - **Client feedback 2026-08-22 ("some are not implemented") — GAP CLOSURE ✅ (B-612..B-622, sqa.md).**
>   Three read-only auditors re-verified every item of BOTH PDFs against current source; the waves were
>   real but ELEVEN client-visible gaps remained, all fixed + RED-first pinned, critic + nav edge reviewer
>   dual AGREE after one fix round:
>   - PDF-2 A7 / screenshot "Wrong Nav Bar": the Secure bar existed on `SecureShell` only — every pushed
>     booking route showed the root MESSENGER · PROFILE footer. Now the root `CustomTabBar` renders AS the
>     Secure 4-tab bar via the pure `secureFlowTab.ts` (Book on the dashboards/picker, Summary on every
>     post-confirm surface, Home on the plan chooser/tiers/activity), gated on the shell being mounted
>     beneath (a PRO stack keeps the root footer — a press must be a POP, never a push of the Lite shell),
>     with the B-393-class "Leave this screen?" prompt off a dashboard.
>   - Screenshot "No Emergency Calls": B-587 was log-only → a pinned EMERGENCY CALLS quick-dial card on the
>     Calls list (device-country chips + universal 112, recorded hand-off).
>   - Screenshot "No Nav bar?": Files now hosts the shared `MessengerTabBar` (Files lit; Chats/Calls/News
>     pop to MessengerHome via a consume-once `{tab}` param; not in the Departmental Vault tab).
>   - PDF-2 A5/A6: 12-hour / 5-minute `TimeDropdownField` on both dashboards (Book Later snaps + 3-h clamp),
>     Exec Pro nudge restored + Base/Transfer subtotals (shown only while consistent with the total).
>   - PDF-2 Summary: `buildBookingSummaryRows` — every server-echoed field for both services, never the
>     cleared draft; BookingConfirmation got the same box; local 12-h clock.
>   - PDF-1 #4/#6/#8: on-screen "Protection Requested" card; Pro sheets above the nav bar
>     (`bottomPad(24)`); "Requested/Scheduled from … to …" + SecureProStatus dates; refund notice on all
>     three Credits tabs + the promo modal; BookingHome "Lite, Pro & Lux" copy.
>   - Verified-done/no change: #1 routing, #2 (D1), #3 labels, #5 team (Issue 30), #7 seats, A2/A3/A4, N4/N5.
>     Founder-intentional: the drawer's VBG + Workspaces rows (PDF-2 lists five). **DEVICE-OWED (no ADB
>     device in this lane): the whole set.** Mobile APK owed.

1. **Wave 1 — quick wins + live nav bugs (low risk, no decision):** PDF-1 #3, #4, #6, #8; Nav N2, N3. Each: builder+edge+critic, RED-first pin, commit+push. ✅ DONE (`a76ad2ea`).
2. **Wave 2 — routing (needs care):** PDF-1 #1 (+ overlaps PDF-2 A1). Updates the routing-spine tests.
3. **Wave 3 — decisions:** PDF-1 #2 (D1), #7 (D2); PDF-2 A4 (D3).
4. **Wave 4 — backend add:** PDF-1 #5 (vehicles/resources).
5. **Wave 5 — PDF-2 consolidation (large, D4):** A2/A3 (service choice + Recon), A5/A6 (one Booking dashboard per service), A7 + N1/N4/N5 (bottom navs + Messenger context). Sequenced as its own project.

Device verification (Firebase) after each wave that changes UI/flow.
