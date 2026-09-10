# UI Spec v2 — M1 · MESSENGER (module handoff)

> **IMPLEMENTED 2026-07-16 (B-91 M1 commit).** Shipped: R3 direct-Chat landing (via M0
> shell); R4 pinned SponsoredSlot as the chat list's permanent header (remote campaign
> via new `adsApi.getPinnedCampaign` with bundled fallback — server endpoint pending Q3);
> R5 Departmental Chat card = ENTERPRISE badge + locked state + spec-copy upgrade prompt,
> backed by the new `useEntitlements()` (`src/store/entitlements.ts`, mirrors the org
> gate; server `DeptChatAccessGuard` remains authoritative); R7 first-time vault entry
> shows the spec's 3-button Cloud/Drive Vault prompt + free tier re-labelled 100 MB
> (⚠️ was 500 — Q7); R8 News hub stripped to Intel + My Feed (Advertisements card, Bravo
> Services card, VBG CTA removed; NewsAds deregistered); R9 profile drawer on
> MessengerHome (avatar → shared `ProfileDrawerModal` with Switch Dashboard); R1 label
> renames (Service Provider → Enterprise in roleLabel/RoleSelection/AgentTypeSelect).
> **Deferred:** full tier-matrix selection screen + `messenger_tier` server field (⛔ Q1/
> Q2 — no billing/provisioning decision), server ads endpoint (Q3), server vault quota
> (Q7), SM-512 label placement (Q4 — string exists nowhere; matrix-only when the tier
> screen ships).

> Part I of `Bravo_Platform_UI_Corrections_Implementation_Specification.pdf` (PDF pages
> 3–13, "Bravo Messenger UI Correction Specification v1.0, 14 July 2026").
> **Prerequisite: `UI_SPEC_V2_M0_PLATFORM_SHELL.md` must be implemented (or at least its
> decisions fixed) first** — Messenger's direct-landing and isolation rules depend on the
> shell's product routing. Run THE MODULE LOOP from `UI_SPEC_V2_INDEX.md` for every row.

**Target in one sentence:** after picking Messenger and a tier (Lite/Pro/Enterprise), the
user lands directly on the Chat list and lives inside a 5-tab standalone messenger
(Chat · Groups · Call · Files · News) that never shows another Bravo product except via
Profile → Switch Dashboard.

---

## Requirements → current state → plan

### R1 — Tier selection: Lite / Pro / Enterprise only (PDF p.5)

**Spec.** After Messenger is chosen on the product selector, show ONLY three tiers —
Messenger Lite, Messenger Pro, Messenger Enterprise. Rename "Service Provider" →
"Enterprise" everywhere user-facing. Each tier card lists its COMPLETE feature set (no
"all Lite features +" shorthand). Approved matrix (verbatim):

| Feature                                 | Lite | Pro | Enterprise |
| --------------------------------------- | :--: | :-: | :--------: |
| Messenger                               |  ✓   |  ✓  |     ✓      |
| Group Chats                             |  ✓   |  ✓  |     ✓      |
| Voice and Video Calls (up to 10 people) |  ✓   |  ✓  |     ✓      |
| Secure Phone Vault                      |  ✓   |  ✓  |     ✓      |
| News                                    |  ✓   |  ✓  |     ✓      |
| Encryption AES-256                      |  ✓   |  ✓  |     ✓      |
| Cloud Backup                            |  —   |  ✓  |     ✓      |
| Secure Cloud Vault (100MB free)         |  —   |  ✓  |     ✓      |
| Department Channels                     |  —   |  —  |     ✓      |
| Employee Attendance Tracking            |  —   |  —  |     ✓      |
| Incident Reporting                      |  —   |  —  |     ✓      |

> **Founder correction (2026-07-17):** "Cloud Backup" moved out of Lite (Pro/Enterprise
> only) and the "Encryption SM-512" row is deleted from every tier — the SM-512 wording
> was a spec mistake. SM-512 mentions elsewhere in this doc are superseded; do not
> (re)introduce that label (INDEX Q4 is resolved).

Routing after selection: Lite → Chat list. Pro → Chat list. Enterprise → stays inside the
Messenger product (organisation setup may follow) — never the combined home.

**Current state (verified).** There is no Lite/Pro/Enterprise picker. The closest screen is
`src/screens/auth/RoleSelectionScreen.tsx` — a two-ROLE picker: "Individual User" (which
reveals a Lite/Pro sub-tier picker, lines 341-358) vs "Service Provider" (corporate card,
title at :183, sub-card :370-375). `handleConfirm` (:195-209) routes individuals to
`Register {role:'individual', tier}` and Service Provider to the AGENT flow (+ sets the
persisted `pendingProvider` flag). Tier is stored server-side as
`users.subscription_tier` — STRICTLY `'lite' | 'pro'`
(`apps/auth-service/src/common/guards/tier.guard.ts:8`); registration hardcodes lite
server-side; upgrades via `POST /subscription/pro`
(`src/services/api.ts:1479-1487`, `authStore.ts:668-671`). **"Enterprise" exists nowhere,
client or server.** And after auth, the shell is chosen by `account_kind` — Lite/Pro
individuals land on the combined Dashboard, never on Chat.

**Plan.** Rebuild the tier screen against the matrix (three cards, full feature lists,
obsidian tokens); wire Lite/Pro straight to `MessengerHome` via the M0 product shell;
Enterprise routes into org setup WITHIN the messenger shell. The "Service Provider" label
disappears from every user-facing string (grep sweep), but the underlying
`service_provider` ROLE and agency onboarding keep existing for the agency product — see
⛔ INDEX open question 2 before touching that flow.

**Blast radius.** Registration/role-selection flow, pendingProvider deferred-commit logic
(memory: provider role granted only at SUBMIT), agency signups must still be possible.

---

### R2 — Entitlement model (PDF p.4, p.13 "no entitlement bypassed via deep link")

**Spec.** Feature access follows the active subscription; upgrade prompts only when a
locked feature is tapped; gates cannot be bypassed by links, notifications or deep links.

**Current state (verified).** `users.subscription_tier` (`'lite'|'pro'`) + a server
`TierGuard` reading it live (`tier.guard.ts:58-75`); `pro_active_until` + a lapse sweeper
(`subscription.service.ts:275`) exist. Client mirror: `authStore.ts:88-89`. SEPARATE
org/agency capability fields (`account_kind`, `is_org_manager`, `membership_status`,
`org` — `authStore.ts:90-93`) drive the org features the spec calls "Enterprise". There
is no unified entitlement selector — checks are scattered per feature.

**Plan (minimal viable tier model).**

1. Server: `users.messenger_tier` (`lite|pro|enterprise`, default `lite`) + expose in the
   auth `/me` payload; admin-settable from ops-console. (⛔ INDEX Q1: billing source TBD —
   build the field + gates now, attach purchase flow later.)
2. Client: `useEntitlements()` selector on authStore — `hasCloudVault`, `hasSM512Label`,
   `hasDeptChannels`, etc. ALL gate checks go through it (no scattered role checks).
3. Server-side enforcement for real capabilities: dept-channel create/join endpoints
   reject non-enterprise accounts (auth-service guard) — client gating alone violates the
   spec's deep-link rule and CLAUDE.md's security constraints.
4. Upgrade prompt = one shared `UpgradeGateModal` (branded, obsidian) with "View
   Enterprise" / "Not Now" (exact copy PDF p.8).

**Blast radius.** Every gated feature; dept-chat module (already role-gated — align, don't
double-gate); ops-console needs a tier column/editor.

---

### R3 — Direct Chat landing + DELETE combined home from messenger flow (PDF p.4, 6, 7)

**Spec.** Lite/Pro land on the Chat list immediately after tier selection. The combined
"Bravo Command" home (SOS + Protect Me Now + product cards) must be unreachable from the
Messenger flow. Bottom nav = Chat, Groups, Call, Files, News ONLY. Approved landing page =
current Messenger layout (search, recent chats, compose, bottom nav) — keep it.

**Current state (verified).** GOOD NEWS: the messenger bottom bar ALREADY matches the spec
exactly — `MSG_TABS` = Chat/Groups/Call/Files/News
(`src/screens/messenger/MessengerHomeScreen.tsx:1031-1037`, inline `MessengerTabBar`
component :1039-1074, rendered :537), with all five targets registered in
`MessengerNavigator` (Groups :145, CallsLog :135, Files :155, NewsHub :205). The GAP is
purely shell-level: Messenger is a nested tab (`MainNavigator.tsx:653`, root bar hidden
for it at :101) and the default landing is the combined Dashboard, not Chat.

**Plan.** Under the M0 shell, the Messenger product's root = `MessengerNavigator` with
`MessengerHome` as initial route; the messenger tab bar becomes the 5-tab set (today's
`MessengerTabBar` already lives on MessengerHome — extend to all five destinations and
render consistently across the product's top-level screens). Combined-home deletion is
M0 §4 (shared task) — Messenger's part is only: no route in the messenger shell points at
it.

**Blast radius.** MessengerHome back-behavior (B-85 fixed `initialRouteName` — don't
regress); push-notification taps that currently open chat via the old tree (M0 §6 list).

---

### R4 — Pinned sponsored slot at top of chat list (PDF p.7)

**Spec.** First position above all chats: ONE permanently pinned advertising card —
labelled Sponsored/Promoted/Advertisement, distinct card treatment, image/logo + headline +
short description + CTA, remotely updatable campaign content, NOT dismissible by the user.
Mockup shows: "SPONSORED" eyebrow + pin glyph, icon, title, one-line sub, "Learn More →".
Placeholder content only — production campaign is client-promoted (e.g. Apex Executive
Travel example).

**Current state (verified).** Entirely net-new. The chat list is one FlatList over
conversations only (`MessengerHomeScreen.tsx:502-517`; pipeline :260-316) — no injected
rows. "Pinned" today means USER-pinned chats (`is_pinned`, sorted first by
`conversationListOrder.ts`) — a different concept; the sponsored slot must sit ABOVE even
those. `PremiumBanner` (`src/modules/messenger/ui/PremiumBanner.tsx`) is just the
AES-256 status strip (used at :460), not an ad slot. No remote-config / campaign
mechanism exists anywhere (grep-confirmed zero).

**Plan.**

1. Client: `SponsoredSlot` component rendered as `ListHeaderComponent` of the chat list
   (above all rows, scrolls naturally, cannot be swiped away). Distinct card: hairline
   border + "SPONSORED" mono eyebrow — must NOT look like a chat row (spec: never mistaken
   for a personal message).
2. Campaign source: `GET /ads/campaign?slot=messenger_pinned` on auth-service (tiny table:
   id, image_url, headline, body, cta_label, cta_url, active) + ops-console editor page.
   Client caches last campaign for offline; hides the slot ONLY when no campaign was ever
   fetched (spec says permanently pinned — with an active campaign it always shows).
3. CTA opens in-app browser/`Linking`; NO cross-product deep links as ad content on this
   surface (prohibited-content rule still applies to what campaigns may promote — Bravo
   Secure/VBG cards are banned here).

**Blast radius.** Chat-list perf (MessengerHome list is perf-sensitive — header component
must not re-render per message); log-audit (never log campaign URLs with user context).

---

### R5 — Groups: Departmental Chat gated ENTERPRISE (PDF p.8)

**Spec.** Groups screen layout stays. Departmental Chat card badge changes PRO →
ENTERPRISE; Lite/Pro see the card LOCKED; tapping it opens the upgrade prompt (copy:
"Department Channels are available on Messenger Enterprise. Upgrade to organise teams into
controlled departmental channels." — buttons "View Enterprise" / "Not Now"); no dept-
channel access without an active Enterprise entitlement, not even via deep links.

**Current state (verified).** The card (`GroupsScreen.tsx:191-208`) is UNGATED — always
tappable, navigates straight to `DepartmentChannels`; the "PRO" badge (:204-206, sub-copy
"Team broadcast channels · Bravo Pro" :202) is cosmetic. The REAL gate sits inside
`DepartmentChannelsScreen.tsx:47-50` and is ORG-MEMBERSHIP based (`service_provider` role
/ `agency` kind / active org member), NOT tier-based. Server mirror:
`apps/auth-service/src/department/dept-chat-access.guard.ts` (:39-51) — which explicitly
REPLACED an old `@RequireTier('pro')` gate because dept chat is an org feature. The
`EXPO_PUBLIC_DEPT_CHAT_V2` flag only hides dept groups from chat lists
(`constants.ts:38`; `MessengerHomeScreen.tsx:247`, `GroupsScreen.tsx:125`) — it never
gated the card.

**Plan.** Badge string + lock state driven by `useEntitlements().hasDeptChannels`; locked
tap → `UpgradeGateModal` (R2); the `EXPO_PUBLIC_DEPT_CHAT_V2` build flag stays as the
feature killswitch but stops being the ACCESS gate; server guard per R2.3. Deep-link/
notification entry into dept screens checks the entitlement at screen mount (fail →
modal + back).

**Blast radius.** Dept-chat module (large, E2EE-adjacent — gate at the navigation/screen
boundary, do NOT touch its crypto/provisioning internals); agency/org accounts must map to
Enterprise entitlement or they lose their existing channels (migration decision — flag).

---

### R6 — Calls: approved as-is (PDF p.9)

**Spec.** No redesign. Keep tabs All/Missed/Voice/Video, entries, styling, call-back icons,
and the Links control. Group calls up to 10 people on every tier. Only functional fixes.

**Current state.** Approved screen = `src/screens/messenger/CallsLogScreen.tsx` as shipped
in B-90 (LINKS button now functional → `LinksScreen`). Obsidian bg landed via T-13 token
retarget. **No work in this module beyond verifying the acceptance rows.**

**Plan.** Verify-only: no Bravo Secure/VBG controls appear (none do), filters return
correct records, phone icon launches call-back (B-59 fix). Confirm the configured
group-call participant cap matches "up to 10 people" (grep `maxParticipants` /
participant-limit constants in `src/modules/messenger/webrtc/` — not verified during
mapping; align or log the deviation for the boss).

---

### R7 — Files & Secure Vault: 100MB free cloud tier (PDF p.10)

**Spec.** Keep Files/Phone-Vault layout (All/Docs/Images/Video/Voice groups; local
attachments E2EE). Tapping "Open Vault" shows a Cloud/Drive Vault prompt: first 100MB
free; paid expansion at configurable prices ("final packages determined separately");
buttons "Continue with 100MB Free" / "View Storage Plans" / "Cancel". Cloud Vault is a
Pro+Enterprise feature; 100MB is the included allocation; paid expansion applies account-
wide across devices.

**Current state (verified).** ⚠️ **CONFLICT WITH SPEC:** the current purchase screen
(`FileVaultPurchaseScreen.tsx`) advertises **"Base vault is 500 MB free for all users"**
(:168-170) with paid plans 500MB/1GB/2.5GB/5GB priced in Bravo Credits (`STORAGE_PLANS`
:26-31); the walletStore defaults `vaultTotalMb: 500` (`walletStore.ts:33`). The spec
says the free tier is **100 MB** — boss must confirm which number wins (existing users
may have been promised 500). Deeper problem: the storage endpoints are Phase-1
placeholders that 404 (`api.ts:1462-1466` — `/vault/storage`, `/vault/storage/purchase`
have NO backend), and the messenger-service vault has NO aggregate quota concept at all
(only a per-file 50MB cap, `vault.service.ts:64`). So quota enforcement is net-new server
work regardless of the number chosen.

**Plan.** Rework `FileVaultPurchaseScreen` into the 3-button prompt; "Continue with 100MB
Free" activates the vault with a 100MB quota (server: quota field on the vault account +
enforcement on upload — reject over-quota with a clear error); "View Storage Plans" shows
placeholder plans (prices configurable server-side, not hardcoded). Tier gate: Lite users
tapping Open Vault get the R2 upgrade modal instead (Cloud Vault is Pro+). **Vault MFA
gate untouched** (CLAUDE.md hard constraint — the biometric/TOTP challenge before download
URLs stays exactly as is).

**Blast radius.** files-service quota enforcement (messenger-service), vault purchase flow
(B-86 Move-to-Vault fail-closed path must keep working), backup/restore of vault state.

---

### R8 — News Feed: news & intelligence only (PDF p.11) + copy rules (p.4)

**Spec.** Keep Bravo Intel + My Feed + category filters + editorial stories. REMOVE: the
Advertisements section, Bravo Services card/member prompt, the Virtual Bodyguard
button/banner, and every cross-product upsell. Advertising lives ONLY in the R4 pinned
slot. Copy rules: "AES-256" exact, "SM-512" exact, "Enterprise" not "Service Provider".

**Current state (verified).** `src/screens/news/NewsHubScreen.tsx`: the three blocks to
remove are exactly — Advertisements SectionCard (:159-170, badge PARTNER, sub "Bravo
Secure products · Partner offers", → `NewsAds`), Bravo Services SectionCard (:173-184,
badge MEMBER, → `NewsAds`), and the VBG footer CTA (:188-199 → `SecureTab/VBGHome`, the
button B-90 T-03 wired days ago — superseded). Removing both cards ORPHANS
`NewsAdsScreen` (only those two entry points; registered `MessengerNavigator.tsx:214`,
`NewsNavigator.tsx:30`) — delete it and its routes, or park it unrouted. Copy: "AES-256"
already renders at every crypto-label site (list in the mapping report — most prominent:
`MessengerHomeScreen.tsx:460`, `VaultScreen.tsx:271,409`, `ChatInfoScreen.tsx:524`);
**"SM-512" exists NOWHERE today** — it is a brand-new marketing label with no code
behind it.

**Plan.** Remove the two SectionCards + VBG footer from `NewsHubScreen` (note: B-90 T-03
just WIRED that VBG banner — superseded by this spec; the VBG product is reached via the
shell/product switch instead); delete or repurpose `NewsAdsScreen` routes; grep the copy
sweep. ⚠️ "SM-512" is a marketing label — it maps to NO real cryptosystem in this app
(Signal protocol + AES-256 are the reality). Render it ONLY as a plan-matrix label; do NOT
invent an "SM-512 encryption" toggle/claim anywhere near the security settings, and do not
touch any crypto because of it (CLAUDE.md stop conditions).

**Blast radius.** NewsHub entry points (Messenger News tab + VBG news tab share screens —
coordinate with M2's 72h filter so the removal doesn't fork the screen twice).

---

### R9 — Profile drawer: Switch Dashboard section (PDF p.12)

**Spec.** In the left profile drawer: a "Switch Dashboard" section below the existing
profile/service items and above Log Out, with EXACT labels "Bravo Secure" and "Virtual
Bodyguard" (no "Open" prefix). Selecting one leaves Messenger entirely (closes it as the
active dashboard) and opens that product's onboarding/sign-in. Existing items (My Profile,
My Bookings, Bravo Pro, Log Out) may remain. Returning to Messenger restores a
Messenger-only interface.

⚠️ **Spec-vs-B-90 conflict:** the spec lists "Agent Portal" among items that may remain;
B-90 T-05 (the boss's LATER instruction) removed it as dead. Keep it removed.
⚠️ **Naming tension:** this page says the switch label is "Bravo Secure" while Part III
renames the product "Secure Services" — M0 fixes ONE canonical label set (see M0 §7);
default: "Secure Services" everywhere per the newer Part III rule, flag to boss.

**Current state (verified).** No "Switch Dashboard" concept exists anywhere
(grep-confirmed). The only client drawer lives on the combined DashboardScreen
(:606-699; menu = My Profile / My Bookings / Bravo Pro after B-90 T-05) — and that whole
screen is deleted by this spec. Messenger screens have NO profile drawer today; the
drawer must be extracted into a shared component (M0 §4) and mounted in the messenger
product shell (spec p.12 mockup shows it opening from Messenger).

**Plan.** This drawer belongs to the M0 shell (same drawer serves all products with a
per-product switch matrix). Messenger's requirement: matrix shows the OTHER two products
only; switching calls the M0 `switchProduct()` (persist + reset stack + open product
onboarding-or-dashboard).

---

## Module acceptance checklist (PDF p.13 — verbatim release gate)

Onboarding & routing: chooser shows 3 products · tier screen shows Lite/Pro/Enterprise
only · Service Provider replaced by Enterprise · Lite+Pro route directly to Chat ·
combined home deleted/unreachable · bottom nav = Chat/Groups/Call/Files/News only.
Features & entitlements: AES-256 correct · SM-512 as specified · tier lists match matrix ·
Departmental Chat labelled Enterprise + locked for Lite/Pro · Calls approved UI, 10-person
calls · Cloud Vault 100MB free + paid expansion · no entitlement bypass via deep link.
Content: pinned sponsored slot above chats, labelled, not removable · News has no
Advertisements/Bravo-Services/VBG sections · Bravo Secure & VBG appear only under Switch
Dashboard · no clipped text/broken icons on common Android sizes · every upgrade prompt
has a cancel path.

## Module loop additions (on top of INDEX loop)

- Regression suites: `npm run test:crypto` after ANY messenger-shell change; messenger
  device smoke (1:1 + group send/receive, call, vault open w/ MFA) after nav changes.
- Entitlement adversarial pass: attempt dept-channel entry via stale notification deep
  link, direct route navigate, and killed-app push tap as a Lite user — all three must hit
  the gate.
- The pinned slot must survive: empty chat list, 1k-chat list scroll perf, offline boot.
- Verify Enterprise (org/agency) accounts still reach their dept channels after the gate
  swap (entitlement mapping — R5 blast radius).
