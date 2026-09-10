# M1A — Messenger tiers: Lite / Pro / Enterprise (approved matrix + onboarding flow)

> **Addendum to [`UI_SPEC_V2_M1_MESSENGER.md`](UI_SPEC_V2_M1_MESSENGER.md) R1/R2.**
> Source: founder-approved tier screenshot (2026-07-17) + founder verbal instructions in
> the same session, **updated same day with founder round-2 answers** (§1 rules 9-12 —
> D-1 resolved, Pricing page, hard feature gating). This doc SUPERSEDES M1 R1's open
> questions Q1 (billing source: **the existing BC/Stripe subscription flow — "recent
> gateway is perfect"**) and narrows R2's plan. Investigation only — **NO code changed
> while writing this doc.**

---

## §1 Required changes (approved, verbatim from screenshot + founder additions)

From the screenshot:

1. **Replace "Service Provider" with "Enterprise"** in the user-facing tier/role picker.
2. **Remove** Bravo Secure Services, VBG, booking, executive cover, itinerary AI,
   priority operations and service-provider onboarding **references** from the tier
   screen.
3. **Display only** Messenger Lite, Messenger Pro, Messenger Enterprise.
4. **List the complete feature set under every tier** — never "all Lite features +" as
   the only description.

Founder additions (verbal, same session):

5. **All three tiers are individual accounts.** Pro and Enterprise sign up / log in
   **exactly like Lite** — same registration, same OTP, same session. The subscription
   ask comes **at the end** (after auth), never as a signup blocker.
6. **Upgrade must be easy from Lite; downgrade must be easy from any paid tier.**
7. **The service-provider tenant is UNTOUCHED** — org backend, managed-CPO roster,
   OrgManagerContext, provider payouts, dept-chat workspace internals all stay as-is.
   Only the _label and entry point_ on the picker change.
8. **The recent product gateway is perfect** — `ProductGateScreen` (post-auth
   Messenger / Secure Services / VBG chooser, B-91 M0 + B-95 nav fix) stays exactly
   as shipped in v1.0.115.

Founder round-2 answers (same day — these RESOLVE the §6 flags they touch):

9. **Service Provider keeps its own card** — the tier screen shows **four cards**: the
   three Messenger tier cards PLUS the Service Provider card **kept as it is present**
   (same funnel, same behaviour). This deliberately overrides the screenshot's
   "display only" wording for the provider entry — the _tier list_ is only
   Lite/Pro/Enterprise; the provider card is a separate account funnel, not a tier.
10. **Paywall decline = "Start as Lite today"** — when a Pro/Enterprise picker declines
    the subscription ask, an explicit option (copy ≈ _"Start as Lite today — explore
    the app"_) signs them in **as Lite**; they can switch tier later in-app at any
    time. Identical for Pro and Enterprise declines.
11. **Settings → "Pricing" page** — a dedicated page under Settings where the user can
    see the full tier matrix + their current plan and **change tier easily** (upgrade
    AND downgrade live here).
12. **Every matrix point is enforced against the account's tier/role** — features a
    tier lacks are not silently hidden NOR silently working: tapping one triggers the
    upgrade ask. Named example: the **cloud vault the app currently exposes to
    everyone stops working on Lite** — a Lite user entering it gets the upgrade
    prompt (matrix: Secure Cloud Vault is Pro+).

Founder round-3 answers (mid-implementation, same day):

13. **Naming: "Lite" / "Bravo Pro" / "Enterprise"** — NOT "Messenger Pro" etc.; the
    existing Bravo Pro brand carries over. Server keys stay `lite|pro|enterprise`.
14. **Prices are ops-console-editable** — a price increase applies **from the next
    renewal for everyone** ("from next month"); already-paid periods finish at what
    they paid. Implemented as charge-time reads of a `subscription_prices` table.
15. **Auto-renew is required** — including for BC-funded subscriptions (the renewal
    sweep debits Bravo Credits at the CURRENT price at period end; the Stripe card
    path already existed and stays).
16. **Enterprise inherits today's three department features** (Department Channels,
    Employee Attendance Tracking, Incident Reporting) for **managing employees** —
    and the word **"CPO" is removed for that audience** (enterprise individuals see
    "Employee"; provider-org screens keep "CPO" verbatim, rule 7).

## §2 Approved Messenger tier matrix (verbatim — render each column IN FULL)

| Feature                                 | LITE | PRO | ENTERPRISE |
| --------------------------------------- | :--: | :-: | :--------: |
| Messenger                               |  ✓   |  ✓  |     ✓      |
| Group Chats                             |  ✓   |  ✓  |     ✓      |
| Voice and Video Calls (up to 10 people) |  ✓   |  ✓  |     ✓      |
| Secure Phone Vault                      |  ✓   |  ✓  |     ✓      |
| News                                    |  ✓   |  ✓  |     ✓      |
| Encryption AES-256                      |  ✓   |  ✓  |     ✓      |
| Cloud Backup                            |      |  ✓  |     ✓      |
| Secure Cloud Vault (100MB free)         |      |  ✓  |     ✓      |
| Department Channels                     |      |     |     ✓      |
| Employee Attendance Tracking            |      |     |     ✓      |
| Incident Reporting                      |      |     |     ✓      |

> **Founder correction (2026-07-17):** the original spec wording was a mistake —
> "Cloud Backup" is Pro/Enterprise only (removed from Lite), and the
> "Encryption SM-512" row is removed entirely from every tier. The table above is
> corrected; any SM-512 mention elsewhere in these handoffs is superseded — do not
> (re)introduce that label.

**Routing after selection (verbatim):** Lite → Messenger Chat landing page. Pro →
Messenger Chat landing page. Enterprise → keep the user **inside the Messenger
product**; organisation setup may follow, but **no combined Bravo home screen may
appear** (it no longer exists — B-91 M0).

### Feature → existing module mapping (all already built)

| Matrix row                | What it is in this codebase                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| Messenger / Group Chats   | messenger module (libsignal 1:1 + sealed-sender group broadcast)                                   |
| Voice/Video up to 10      | WebRTC calls + SFrame group calls (cap is the existing group-call roster limit)                    |
| Secure Phone Vault        | File Vault w/ MFA gate (B-86 — biometric → `vault-access` action token; **gate must stay**)        |
| News                      | `src/screens/news/*` (VBG-sourced feed; M1 R6 content boundary applies)                            |
| Cloud Backup              | messenger backup/mirror/Merkle module (B-94 ledger; `BACKUP_LOOP.md` governs any change)           |
| Encryption AES-256        | marketing label for the shipped crypto (SQLCipher at rest, AES-256-CBC media, Signal DR) — no code |
| Secure Cloud Vault 100MB  | M1 R7 Files tab + 100MB free-tier label (vault storage quota)                                      |
| Department Channels       | dept-chat v2 workspace (`feat/dept-chat-v2` heritage, shipped org chat)                            |
| Employee Attendance Track | dept-chat v2 attendance verification (MLKit face capture + checkout verify)                        |
| Incident Reporting        | dept-chat v2 incident reporting + dispute route + PDF export                                       |

**⚠️ The three Enterprise rows are today keyed off ORG MEMBERSHIP** (`account_kind`,
`is_org_manager`, `membership_status`, `org` — `src/store/authStore.ts:90-93`), i.e. the
service-provider workspace. The Enterprise _tier_ must gate the **client-side visibility
and server-side access** of these features for individual Enterprise subscribers without
touching how provider orgs use them (§4.5).

## §3 Present setup (verified against HEAD `f512e54`, 2026-07-17)

### 3.1 The screen being replaced — `src/screens/auth/RoleSelectionScreen.tsx`

- Pre-auth screen. Two ROLE cards: **Individual User** vs **Enterprise** (eyebrow
  "Operator Partner" — this card is actually the **service-provider** funnel, lines
  180-186, 201-208: sets `pendingProvider`, registers as `agent`, role flips to
  `service_provider` at `POST /agents` submit).
- Individual card reveals a **Lite/Pro sub-picker** (lines 341-358) whose Pro desc is
  exactly the copy the screenshot bans: _"Executive cover, itinerary AI, priority ops"_.
  The FEATURES strip (line 188) also lists banned refs: _"Bravo Lite booking"_,
  _"Virtual Bodyguard"_.
- Confirm → `Register {role:'individual', tier}` — but **registration hardcodes `lite`
  server-side** (verified in M1 R1); the client-picked `pro` is currently cosmetic.

### 3.2 The gateway that stays — `src/screens/auth/ProductGateScreen.tsx`

Post-auth product chooser (Messenger / Secure Services / VBG), persists
`activeProduct` (`src/store/productStore.ts`), remount-on-switch, B-95 `gateVisible`
re-entry + booking-draft guard. **Founder: perfect — do not touch.** Tier selection is
a _different axis_ (which Messenger plan) from product selection (which dashboard).

### 3.3 Subscription infrastructure that already works (reuse, don't rebuild)

- `users.subscription_tier` — **strictly `'lite' | 'pro'`**
  (`apps/auth-service/src/common/guards/tier.guard.ts:8`), plus `pro_active_until`
  (NULL = permanent comp grant, RS-17).
- `POST /subscription/pro` — debits Pro price in **BC** + flips tier in one
  transaction; optional Stripe auto-renew; `POST /subscription/pro/cancel`;
  `/stripe-webhook` (invoice.paid extends, payment_failed marks past_due,
  subscription.deleted downgrades lapsed but never comp grants). Client:
  `src/services/api.ts:1479-1487`, `authStore.ts:668-671`.
- **Lapse cron** (`subscription/pro-lapse.cron.ts`) sweeps `pro_active_until` past-due
  → Lite. `TierGuard` reads the DB **live per request** (`tier.guard.ts:58-75`), treats
  a lapsed 'pro' row as Lite (RS-19) — downgrade takes effect on the next request.
  `@RequireTier` decorator exists; currently mounted on no handler.
- Client mirror: `subscription_tier` + `pro_active_until` on the auth user
  (`authStore.ts:88-89`).

### 3.4 Enterprise-feature infrastructure (service-provider workspace — UNTOUCHED)

Dept channels / attendance / incident reporting all exist behind org membership
(§2 table). Server dept endpoints authorize via org context (dept-scoped managers,
`OrgManagerContext.department` required). None of this moves.

## §4 Target flows

### 4.1 Tier selection screen (replaces RoleSelection's role+tier composite)

Pre-auth, after "Get started": **four cards** — **Messenger Lite / Messenger Pro /
Messenger Enterprise** (each listing its FULL column from §2, no shorthand) **plus the
Service Provider card kept as it is present** (rule 9). Obsidian tokens
(`#07090D`/`#5B8DEF`, G8). No Secure-Services/VBG/booking/executive-cover/itinerary-AI
copy anywhere on the _tier_ cards.

- Keep the existing `SubCard`/`Radio` design language (RoleSelectionScreen already has
  the right obsidian components — rework content, not the design system).
- **Provider card behaviour byte-identical to today:** `pendingProvider.set()` →
  `Register {role:'agent'}` → role flips to `service_provider` at `POST /agents`
  submit. Funnel untouched (rule 7).
- **D-5 (naming, needs sign-off):** today's provider card is _titled_ "Enterprise"
  (eyebrow "Operator Partner") — that title now collides with the Messenger
  Enterprise tier card. Default: provider card takes the title **"Operator
  Partner"** (or "Service Provider") with description unchanged; the word
  "Enterprise" belongs to the individual tier. Behaviour unchanged either way.

### 4.2 Signup = identical for all tiers (founder rule 5)

`Register {role:'individual'}` for every tier. The chosen tier persists client-side as
`pendingTier` (mirror of `pendingProduct` in `productStore` — same adopt-on-first-mount
pattern). Server keeps hardcoding `lite` at registration — **the tier is an
entitlement, not an account type.**

### 4.3 The end-of-flow subscription ask (founder rule 5)

After auth completes (and after the product gate if it shows):

- `pendingTier = lite` → straight to Chat landing. Done.
- `pendingTier = pro | enterprise` → **PaywallScreen** (new): shows that tier's full
  column + price in BC, CTA = subscribe now (reuses `POST /subscription/pro` /
  new `/subscription/enterprise`), secondary = **"Start as Lite today — explore the
  app"** (rule 10 copy) — decline NEVER blocks entry; the account signs in as Lite
  and the user can change tier any time from Settings → Pricing (§4.4).
- Routing after a successful subscribe (or decline): per §2 — Lite/Pro → Chat landing;
  Enterprise → stays inside Messenger (org setup may follow); combined home never.

### 4.4 Settings → "Pricing" page (founder rules 6 + 11 — the tier-management home)

One dedicated screen under Settings, named **Pricing**:

- Renders the **full §2 matrix** with the account's current plan highlighted, plus
  renewal state (`pro_active_until`, auto-renew on/off).
- **Upgrade:** tap a higher tier → same PaywallScreen/subscribe flow (BC debit +
  optional Stripe auto-renew — machinery exists, §3.3).
- **Downgrade:** tap a lower tier → confirm → `POST /subscription/pro/cancel`
  (+ enterprise equivalent); tier flips at period end via the lapse cron. **Default
  D-2: period end, not instant** — the user keeps what they paid for; TierGuard's
  live read makes the flip bite on the next request once lapsed. No refund flow.
- Secondary upgrade entry points stay: locked-feature taps (§4.5) deep-link here /
  to the paywall; M1 R5's dept-chat locked card ditto.
- Service-provider accounts do NOT see the Pricing page (rule 7: untouched — their
  billing is payouts, not subscriptions).

### 4.5 Entitlement gating (narrows M1 R2)

1. **Server:** extend `SubscriptionTier` → `'lite' | 'pro' | 'enterprise'`
   (`tier.guard.ts:8` + the users-table CHECK constraint migration) — **reusing
   `subscription_tier`/`pro_active_until`/lapse-cron**, NOT the separate
   `messenger_tier` column M1 R2 sketched (that was hedging on Q1; billing source is
   now settled = existing BC/Stripe flow). Add `POST /subscription/enterprise`
   (same shape as `/pro`, Enterprise price).
2. **Server enforcement:** dept-channel/attendance/incident endpoints accept
   **org-member OR enterprise-tier** (align with the existing org gate — do NOT
   double-gate provider orgs; CLAUDE.md: client-only gating violates the deep-link
   rule). Vault quota >100MB free tier ditto when quota lands.
3. **Client:** one `useEntitlements()` selector on authStore (`hasCloudVault`,
   `hasDeptChannels`, `hasSM512Label`, …) — every gate check goes through it; no
   scattered `subscription_tier === …` comparisons.
4. **Effective-tier rule:** lapsed paid window ⇒ Lite (RS-19 semantics extend to
   enterprise unchanged).
5. **Every §2 matrix row is CHECKED, visibly (rule 12).** A feature the tier lacks
   renders **locked, not hidden** — tapping it opens the upgrade ask (shared
   `UpgradeGateModal`, branded, → paywall/Pricing). Named regression from the
   founder: **Secure Cloud Vault on Lite** — today's move-to-vault/vault-open flows
   (B-86) are reachable by every account; under the matrix they are **Pro+**, so on
   Lite every vault entry point (chat long-press "Move to Vault", Files tab, vault
   screen) must show the upgrade ask instead of working. Server side: the vault
   download/upload endpoints add the tier check **on top of** the existing MFA gate —
   the biometric/TOTP `vault-access` action-token flow is a CLAUDE.md stop-condition
   and must NOT be weakened or reordered while adding it. Org/provider accounts keep
   their existing access paths for org features (org-OR-tier, never double-gate).

## §5 Implementation plan (ordered, smallest safe slices)

| #   | Slice                                                                               | Files (primary)                                            |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Server: tier enum + constraint migration + `/subscription/enterprise` + guard union | `tier.guard.ts`, `subscription/*`, new migration           |
| 2   | Client: `pendingTier` store + `useEntitlements()`                                   | `src/store/` (pattern: `productStore`), `authStore.ts`     |
| 3   | Tier screen rebuild (3 tier cards w/ full lists + provider card as-is, D-5 title)   | `RoleSelectionScreen.tsx` (rename → `TierSelectionScreen`) |
| 4   | PaywallScreen ("Start as Lite today" decline) + end-of-flow ask + routing           | new screen, `MainNavigator.tsx`, product-gate handoff      |
| 5   | Settings → Pricing page (matrix + current plan + up/downgrade)                      | new screen under Settings, subscription api                |
| 6   | Feature-gate sweep: `UpgradeGateModal` on every lacked matrix row (vault first)     | vault entry points, GroupsScreen dept card, Files tab      |
| 7   | Server enforcement: dept enterprise-OR-org gate + vault tier check (MFA untouched)  | auth-service dept controllers, files-service vault routes  |
| 8   | Ops-console tier column/editor (M1 R2 blast radius)                                 | ops-console users admin                                    |

Each slice runs the standard gates (direct test, `npm run typecheck` ≤ baseline, ops
typecheck, targeted suite then `npm test`) + M1's isolation pass (other products boot;
Agent/CPO shells untouched; deep links resolve).

## §6 Decisions taken as defaults (flag to founder) + open questions

- **D-1 ✅ RESOLVED (founder, round 2):** Service Provider keeps its own card on the
  tier screen, as it is present — four cards total (rule 9).
- **D-2** Downgrade = cancel + period-end lapse (existing machinery), not instant.
- **D-3** Enterprise tier reuses `subscription_tier` (+ `pro_active_until` as the
  generic paid-until), NOT a parallel `messenger_tier` column. Supersedes M1 R2.1.
- **D-4 ✅ CONFIRMED (rule 10):** paywall declinable → "Start as Lite today — explore
  the app"; account lands as Lite, switchable later from Settings → Pricing.
- **D-5** Provider card retitled "Operator Partner" (or "Service Provider") since
  "Enterprise" now names the individual tier — two cards can't share the title.
  Behaviour untouched. NEEDS SIGN-OFF (naming only).
- **Q-A** Enterprise price in BC? (Pro price exists in config; Enterprise TBD.)
- **Q-B** Enterprise "organisation setup may follow" — what exactly does an individual
  Enterprise subscriber set up (create an org? invite members?) vs. dept features
  scoped how? Blocked on product answer; slice 6 ships org-OR-tier read access first.
- **Q-C** "SM-512" copy stays marketing-only (no such primitive; CLAUDE.md forbids
  inventing crypto). Confirm the label text placement (matrix cells only).

## §7 Acceptance checklist

- [ ] Tier screen shows the three Messenger tier cards (each with its full §2 column) + the Service Provider card as present (D-5 title applied); zero banned references on the tier cards (Secure Services, VBG, booking, executive cover, itinerary AI, priority operations).
- [ ] Provider funnel functional end-to-end from its card (roster onboarding unchanged, `pendingProvider` → agent flow → `service_provider` at submit).
- [ ] Pro/Enterprise signup is byte-identical to Lite until the post-auth paywall; declining via "Start as Lite today" lands a working Lite account.
- [ ] Settings → Pricing exists: full matrix + current plan; tier change (up AND down) in ≤ 2 taps from Settings; period-end lapse verified (cron + TierGuard live read).
- [ ] Every §2 row a tier lacks is locked-with-upgrade-ask, not hidden and not working — verified per feature; **Lite vault probe:** all vault entry points show the upgrade ask AND the server rejects a direct vault call from a Lite token (deep-link rule), with the B-86 MFA gate still enforced for entitled tiers.
- [ ] Lite/Pro land on Chat; Enterprise never leaves Messenger; combined home unreachable (regression: B-95 gate/back behaviour intact).
- [ ] Dept channels/attendance/incident: server rejects Lite/Pro individuals (deep-link probe), accepts Enterprise tier AND provider-org members exactly as before.
- [ ] `ProductGateScreen` byte-identical (founder: "perfect").

---

## §8 IMPLEMENTATION STATUS — 2026-07-17, all slices SHIPPED IN CODE

Implemented same-day against §1 rules 1-16 (founder rounds 1-3). Summary of what
landed where; every slice verified by the gates at the bottom.

**Server (auth-service):**

- `SubscriptionTier = 'lite'|'pro'|'enterprise'` + `TIER_RANK` (enterprise satisfies
  pro-gated handlers) + lapse-aware `effectiveTierOf` (`tier.guard.ts`, spec'd).
- Migrations (applied to live Supabase): `20260717120000_enterprise_tier.sql` (CHECK
  constraint), `20260717123000_subscription_prices_autorenew.sql`
  (`subscription_prices` seeded pro=2000/enterprise=5000 + `users.bc_auto_renew`).
- `subscribeToTier` (POST `/subscription/pro` + NEW `/subscription/enterprise`):
  charge-time price read (`getPrices()`, table w/ compiled fallback), same-tier renewal
  extends / tier-switch = fresh 30-day window, **tier switch cancels the old Stripe sub**
  (no zombie renewals), auto_renew flag also sets `bc_auto_renew`.
- **BC auto-renew sweep** `renewFromCredits()` runs before the lapse sweep each cron
  tick: debits the CURRENT price for due opted-in accounts (never while a live Stripe
  sub exists — no double charge); failed debit → ordinary lapse. Lapse + webhook now
  cover both paid tiers; enterprise renewal never downgraded to 'pro'.
- **Vault tier gate at action-token issuance** (`biometric.service.ts`): the 3
  vault-accepted purposes require effective-paid-tier OR org affiliation; ON TOP of
  attestation, `recipient_purge` untouched, MfaGuard/messenger-service untouched.
- **Dept enterprise inherit**: `DeptChatAccessGuard` + `OrgManagerGuard` Path 3 —
  ACTIVE enterprise tier = manager of own single-tenant org (org_user_id = self, the
  shape department_channels.org_id was designed for). Provider paths untouched + spec'd.
- **Ops endpoints** (`OpsSubscriptionController`, SUPERVISOR/ADMIN): GET/PATCH
  `/ops/subscription/prices`, PATCH `/ops/subscription/users/:id/tier` (comp grants;
  days=null ⇒ permanent RS-17; tier=lite also cancels renewals so a live card sub
  can't re-upgrade).

**Client (mobile):**

- `PackageTier`+`effectiveTier`/`isProUser` widened (enterprise; superset rule);
  `deriveEntitlements` → `effective`, `isOrgAffiliated`, `hasCloudVault`,
  `hasDeptChannels` (org-OR-tier), `showTierUpgradePrompt`; `pendingTier` bridge.
- Tier screen (`RoleSelectionScreen`): 4 cards — Lite / **Bravo Pro** / Enterprise
  (FULL matrix columns) + **Operator Partner** card (funnel byte-identical, D-5
  retitle); banned copy gone; login clears stale pendingTier.
- Post-auth ask: MainNavigator renders standalone `TierPaywall` once for a pending
  paid tier on an effectively-Lite account — live price, BC debit + Stripe shortfall
  top-up, auto-renew toggle, decline = **"Start as Lite today — explore the app"**;
  resolution enters the Messenger product (spec §2 routing).
- **Settings → Pricing** (`PricingScreen`, BookingNavigator route + ProfileScreen
  "Pricing / PLANS" row, hidden for org accounts): full matrix + current plan +
  upgrade/switch via `TierPaywall` route + downgrade = cancel + period-end lapse (D-2).
- **Gate sweep**: `openVault` choke point + FilesScreen promo + FileViewer
  "Move to Vault" all gate on `hasCloudVault` → branded upgrade ask → Pricing
  (server backstop = 403 at token issuance). Dept card routes its Enterprise upsell
  to Pricing. ProPaywall's stale "Department Channels under Pro" promise fixed;
  live prices on both paywalls. Dept screens: audience-aware `deptMemberNoun()` —
  "Employee(s)" for enterprise individuals, "CPO(s)" for provider orgs (13 strings).

**Ops console:** users/[id] inline tier editor (select + days + APPLY, permanent
grants supported); Settings page "Subscription pricing" card (GET/PATCH, next-renewal
copy); `subscriptionPrices`/`setSubscriptionPrice`/`setUserTier` api fns.

**Gates:** auth-service tsc exit 0 · full auth suite 102/103 (sole fail = pre-existing
`vbg.service.spec.ts`, reproduced on clean tree) · new/updated specs: tier.guard 20,
subscription (incl. enterprise/renewFromCredits/getPrices), biometric vault-gate 9,
org-manager Path-3 4 · mobile tsc **46 ≤ 47** · app+booking 419 green (2 pre-existing
fails reproduced on clean tree) · messenger-crypto **186/186, 1646** (8 new vault-gate
tests; entitlement seam keeps the node suite parse-clean) · ops-console tsc exit 0 ·
eslint 0 NEW errors everywhere (3 flagged errors reproduced on clean tree).

**Residuals (documented, deliberate):**

- **Q-A price**: ENTERPRISE_MONTHLY_BC seeded at **5000 BC placeholder** — founder to
  set the real price in ops Settings (that's the point of the editor).
- Enterprise employee ROSTER onboarding (inviting employees into org_members) still
  uses the provider machinery; an enterprise individual can open dept surfaces and
  create channels, but a self-serve "invite employee" flow is the next build (Q-B v2).
- Stripe enterprise price id (`STRIPE_ENTERPRISE_PRICE_ID`) unset ⇒ enterprise card
  auto-renew gracefully degrades to BC-only auto-renew.
- Device verify (fresh signup → paywall → decline/subscribe → vault/dept probes)
  rides the next APK build.

### §8.1 Addendum (same day, device-test driven) — Enterprise employee workspace

Device testing found the Q-B gap live: an Enterprise individual reached Department
Channels but saw the org-member gate copy with no way to run the workspace.
Shipped same session:

- `org_members.member_role` += **'employee'** (migration applied live): workspace
  membership (channels/attendance/incidents) that is **invisible to the §35A
  account-kind discriminator** (never hijacks the member's own app shell) and
  excluded from every mission/crew query (never deployable). Provider CPO/manager
  machinery untouched by construction.
- `resolveIsOrgManager` admits an ACTIVE enterprise tier → `/auth/me
is_org_manager` lights the existing manager surfaces (create channels etc.).
- **POST /org/employees** — enroll an EXISTING user by email/phone as employee
  (re-enroll allowed only for employee rows; provider rows must use the roster
  status endpoint). Channel auto-seed labels employees "Employee"; provider CPOs
  keep "CPO" verbatim (rule 7).
- Client: `DepartmentChannelsScreen` entitlement now routes through
  `useEntitlements` (it held a scattered org-only copy of the rule — the exact
  drift M1 R2 warned about); owner empty state offers **Create channel** +
  **Employees**; new `EmployeesScreen` (add / suspend / reinstate / remove);
  `ManageChannels` gains an Employees button; prompt copy fixed to
  **Bravo Pro** naming (round-3).
- Employees' own accounts keep their own tier; enrolling grants workspace access
  only. Removal is reversible; the member's Bravo account is never touched.
