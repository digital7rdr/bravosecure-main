# UI Spec v2 — M0 · PLATFORM SHELL (module handoff)

> **IMPLEMENTED 2026-07-16 (B-91 M0 commit).** Built as a product-aware single shell
> rather than three separate navigator mounts: the client Tab.Navigator keeps all its
> routes (so every existing `navigate('SecureTab'/'MessengerTab'…)` caller, push handler
> and deep link keeps working), but is `key`ed by `activeProduct` — a product switch
> remounts the tree (= the spec's back-stack reset), `initialRouteName`/`initialParams`
> land each product on its own dashboard, `CustomTabBar` renders the per-product tab set,
> and the Dashboard (combined home) tab is no longer registered. Shipped: `productStore`
> (persisted active/pending product + `switchProduct`), `ProductGateScreen` (post-auth
> selector for accounts with no product), selector cards now carry the choice, splash 2 s,
> `SwitchDashboardSection` (in ProfileScreen above Sign Out), sign-out resets the product,
> "Secure Services" selector labels. DashboardScreen stays in-tree UNROUTED pending INDEX
> Q8 (SOS pipeline decision); the activity/notification drawer is offline with it (flagged
> in sqa). Remaining M0 items ride later modules: messenger/VBG drawer mounts (M1/M2),
> unsaved-booking guard (M3).

> Part A + final page of `Bravo_Platform_UI_Corrections_Implementation_Specification.pdf`
> (PDF pages 1–2, 28). **This module goes FIRST** — M1/M2/M3 all build on its decisions.
> Run THE MODULE LOOP from `UI_SPEC_V2_INDEX.md` for every row.

**Target in one sentence:** splash (2 s) → global product selector (Messenger · Secure
Services · Virtual Bodyguard) → the chosen product's own onboarding → that product's own
dashboard; the app remembers the active product across launches; switching products is
deliberate (Profile → Switch Dashboard), resets the old product's back-stack, and no
combined "command home" exists anywhere.

---

## 1. Current architecture (verified 2026-07-16)

- **One `NavigationContainer`, one root stack** — `src/navigation/index.tsx:61-78`. Root
  screens are chosen by CONDITIONAL RENDERING (not navigation): exactly one of
  `AccessEnded` / `Auth` (AuthNavigator) / `PermGate` / `Main` (MainNavigator) mounts.
- **Splash is two-stage:** native expo-splash (`App.tsx:26,54-57`, holds until fonts) +
  a JS animated splash `src/screens/auth/SplashScreen.tsx` (`BAR_DURATION = 2500`, line 30)
  that `replace('Onboarding')`s at the end (lines 104-108). The JS splash exists ONLY in
  the pre-auth stack (`AuthNavigator.tsx:22,33`); authenticated relaunches skip it
  (`index.tsx:73-74` renders Main directly, with a "Verifying session…" overlay 81-85).
- **The product selector already exists but is cosmetic** —
  `src/screens/auth/OnboardingScreen.tsx:134-138` shows the three cards (Messenger /
  "Bravo Secure Services" / Virtual Bodyguard "AI"), but ALL three share one handler:
  `handlePath = () => navigation.navigate('RoleSelection')` (line 201). The choice is
  thrown away.
- **`HomeSelectionScreen.tsx` is a DEAD screen** — a "Choose your default" (Bravo Secure
  Lite / Pro / VBG) chooser (`PATHS` lines 34-74) whose CTA ignores the selection and just
  `navigate('Main')` (98-100). Nothing navigates to it (registered `AuthNavigator.tsx:41`
  but orphaned). It is raw material for the returning-user product gate, or deletion.
- **The combined command home is `src/screens/dashboard/DashboardScreen.tsx`**, mounted as
  the FIRST tab (`MainNavigator.tsx:652`, default landing — no `initialRouteName` set).
  Spec says delete it. It is load-bearing (see §4).
- **No product persistence exists.** No `activeProduct`/`lastDashboard` anywhere. The
  post-auth shell is derived EVERY render from server user fields:
  `resolveAuthedRoute(...)` (`MainNavigator.tsx:231-238` →
  `src/navigation/resolveRoute.ts:32-62`) returning
  `access-ended | cpo-activation | cpo-onboarding | cpo | agency | client`, branched at
  `MainNavigator.tsx:621-676`. The only persisted nav-adjacent flags: `pendingProvider`
  (AsyncStorage, `src/store/pendingProvider.ts:14-17`) and `bravo_perms_shown`
  (`index.tsx:17,46-53`). `authStore` itself is NOT zustand-persisted (only
  `activityStore` is — key `'bravo:activity'`, `activityStore.ts:50` — a good pattern to copy).
- **The client tab shell is static** — `MainNavigator.tsx:637-675`: tabs Dashboard /
  MessengerTab / SecureTab / ProfileTab (a `NewsTab` type exists in `types.ts:46` but is
  never rendered — dead). `CustomTabBar` (80-182) supports HIDING per route
  (`tabBarStyle display:'none'`, forced for MessengerTab at :101, VBG fullscreen routes
  :66-68,661-663) but has NO mechanism for per-product tab sets.
- **The existing isolation precedent is separate navigators per audience** — agency →
  `AgentNavigator`, cpo → `CpoNavigator`, mounted exclusively by the `authedRoute` branch.
  This conditional-mount pattern is exactly what per-product shells need.
- **Back-stack reset infrastructure is minimal:** one production `navigation.reset`
  (`VaultLockScreen.tsx:66`); the SecureTab tab-press re-navigate pattern
  (`MainNavigator.tsx:665-672`). Conditional REMOUNT (the authedRoute pattern) gives
  stack-reset for free — when the subtree unmounts, its navigation state dies with it.
- **Messenger runtime warm-up is safe** — it lives in MainNavigator effects keyed on
  `user?.id` (`MainNavigator.tsx:275-380`), NOT in DashboardScreen. Call handling /
  verification / group-ring handlers: `MainNavigator.tsx:387-613`. Deleting the Dashboard
  does not touch these — but the per-product refactor of MainNavigator MUST carry these
  effects unchanged (they are the messenger's life-support).

## 2. R1 — Splash + global selector journey (PDF p.2)

**Spec.** Splash 2 s → product selector (Messenger, Secure Services, Virtual Bodyguard) →
selected product's own onboarding → its dashboard. No mixed home after selection.

**Gap.** Selector exists pre-auth only and ignores the choice; authed users never see any
selector; splash is 2.5 s (pre-auth only).

**Plan.**

1. `SplashScreen.tsx:30` `BAR_DURATION` 2500 → 2000 (and label copy). (INDEX open Q6:
   confirm fixed-hold vs cap; recommend cap-at-2s.)
2. `OnboardingScreen` card presses carry the product: `handlePath(product)` stores a
   `pendingProduct` (same AsyncStorage pattern as `pendingProvider`) and continues to
   RoleSelection/Register. On first successful auth, `pendingProduct` seeds the persisted
   `activeProduct` and is cleared.
3. Returning AUTHED user with NO `activeProduct` (all existing installs): show the product
   selector ONCE post-auth — rebuild the orphaned `HomeSelectionScreen` as this gate
   (3 product cards, sets `activeProduct`, no skip). Label per naming rules (§7).
4. Card labels: "Bravo Secure Services" → "Secure Services" (`OnboardingScreen.tsx:136`).

## 3. R2 — Active-product persistence + per-product shells (PDF p.2)

**Spec.** Store the active product; reopen it on next launch; each product feels
standalone.

**Plan (the architectural core).**

1. New `src/store/productStore.ts` — zustand + persist (copy `activityStore.ts:50`
   pattern): `{activeProduct: 'messenger' | 'vbg' | 'secure' | null, setActiveProduct,
clearOnSignOut}`. Wire clear into `authStore.signOut` alongside the existing store
   resets (`authStore.ts:593-597`).
2. `MainNavigator` client branch (`:637-676`) stops rendering ONE static Tab.Navigator and
   instead mounts per product (same conditional-mount idiom as agency/cpo at :621-635):
   - `messenger` → `MessengerNavigator` as product root (its internal 5-tab bar already
     matches spec — `MessengerHomeScreen.tsx:1031-1037`).
   - `secure` → `BookingNavigator` root + a 2-tab product bar (M3).
   - `vbg` → new `VbgNavigator` + 3-tab product bar (M2).
   - `null` → the §2.3 product gate.
     The MainNavigator user-keyed effects (runtime warm-up :275-380, call handlers
     :387-613, AppState refresh :208-218) stay in the wrapper that hosts ALL products —
     they must run regardless of active product.
3. `switchProduct(next)` helper (drawer uses it): confirm-if-unsaved (M3 booking guard) →
   `setActiveProduct(next)` → subtree remount = automatic back-stack reset (spec's reset
   rule satisfied structurally; no reset() calls to maintain). If the destination
   product's onboarding is incomplete → its onboarding first (per-product completion flag
   in productStore).
4. Agent/CPO/agency shells: UNTOUCHED. `resolveAuthedRoute` still wins first — only the
   `client` branch gains the product dimension.

**Blast radius.** Everything client-side. The `client` Tab.Navigator param list
(`MainTabParamList`) is typed into MANY screens (`navigate('SecureTab', …)` callers) —
every cross-tab call must be re-pointed to its product's internal routes or the
switchProduct path. Grep list to sweep: `navigate('SecureTab'`, `navigate('MessengerTab'`,
`navigate('Dashboard'`, `navigate('ProfileTab'`.

## 4. R3 — Delete the combined command home (PDF p.2, p.6)

**Spec.** The combined screen (Emergency/SOS + Protect Me Now + product cards) must be
deleted and unreachable.

**Current duties that MUST be re-homed first** (all verified in `DashboardScreen.tsx`):
| Duty | Today | Re-home to |
| --- | --- | --- |
| SOS / panic (`sosApi.raise/status/cancel`, hold-to-activate modal) | :285-409, 451-468, 702-808 — the ONLY client panic entry | VBG Quick Actions "Hold to Alert Control Room" (M2 R3) — same `sosApi` plumbing; decide with boss whether Secure Services also needs a panic entry (spec doesn't give it one) |
| Protect Me Now (auto-dispatch hero, `user?.auto_dispatch_enabled`) | :479-497 | Secure Services dashboard (it's a booking entry) — M3; or drop if the boss confirms Book-Now covers it |
| Product cards (Messenger/Secure/VBG) | :513-540 | Replaced by the product model itself |
| Activity/notification drawer (`useActivityStore`) | :554-603 | Shared header bell available in each product shell (component extraction), or profile drawer — boss taste call, default: keep as a shared header control |
| Profile drawer (Edit Profile, My Bookings, Bravo Pro, Log Out + B-90 fixes) | :605-699 | Extract to a shared `ProfileDrawer` component used by all three products; gains the Switch Dashboard section (§6) |
| Operator status strip / UTC clock | :884-908 | Dies with the screen unless boss wants it in VBG |
| Unread badge aggregation | :208-210 | Messenger product owns its own badges |

**Plan.** Extract drawer + activity drawer into shared components first; move SOS to M2;
move Protect-Me-Now to M3; only THEN remove the `Dashboard` tab + screen + the single
external caller (`ProActivityHistoryScreen.tsx:188` `navigate('Dashboard')` → its product
root). Until then it stays mounted behind the legacy shell (P1–P4 of the INDEX build order).

## 5. R4 — Switch-Dashboard matrix + module-vs-product distinction (PDF p.2, 21, 26)

**Spec.** Drawer switch shows only the OTHER two products (never the current one).
Messenger appearing as a bottom TAB inside VBG/Secure opens the communication MODULE in
that product's context; the drawer switch opens the full Messenger PRODUCT.

**Plan.** `SwitchDashboardSection` (shared, in the extracted ProfileDrawer): reads
`activeProduct`, lists the other two with exact labels ("Messenger", "Secure Services",
"Virtual Bodyguard" — never "Open X"), calls `switchProduct()`. Module-vs-product: the
messenger MODULE mount = `MessengerNavigator` nested inside the VBG/Secure product shells
(their Messenger tab), sharing the one runtime/stores; the PRODUCT mount = activeProduct
switch. One codebase, two mount points — the runtime singletons
(`getMessengerRuntime`) are process-wide already, so both mounts share state safely.
**Decision to encode:** an incoming CALL while in another product must still present
(CallKeep/full-screen intent is app-level) — call UI keeps living at the MainNavigator
wrapper level (:387-613), NOT inside the messenger product, so it overlays any product.

## 6. R5 — Deep links, notifications, entitlements (PDF p.2)

**Spec.** Entitlements follow the subscription (M1 owns the tier model). Deep-link rule:
destination product's onboarding incomplete → open its onboarding; else its dashboard.

**Plan.** Inventory every imperative navigation into the client shell and map each to a
product (these bypass tab UX and will break silently when routes move):

- Call handlers + group ring: `MainNavigator.tsx:387-613` (stay at wrapper level, §5).
- Paywall deep link: `MainNavigator.tsx:247-250` (`ProPaywall` — Secure product).
- Push-notification taps (booking status, messenger, mission): grep
  `navigationRef`/`CommonActions.navigate` in `src/modules/**` + notification handlers —
  every target route gets a product prefix rule: `openInProduct(product, route, params)`
  = `setActiveProduct(product)` then navigate once mounted.
- B-82 regression watch: killed-app notification taps were fixed recently — re-run that
  matrix after the shell change.

## 7. R6 — Naming rules (PDF p.2, 24)

**Spec.** "Secure Services" in all user-facing labels; remove "Bravo Secure Services" from
onboarding/product headers; "Enterprise" replaces "Service Provider" (M1); no "Open X" in
switch labels.

**Verified label sites (product labels only — brand/app-name "Bravo Secure" chrome is NOT
in scope, e.g. login copy, CallKit display name, `app.json` name):**

- `OnboardingScreen.tsx:136` — card title 'Bravo Secure Services'.
- `RoleSelectionScreen.tsx:177` — desc "…Bravo Secure services and VBG".
- `RoleSelectionScreen.tsx:343` — desc "Messenger, Bravo Secure, VBG basics".
- `DashboardScreen.tsx:527` — module card "Bravo Secure" (dies with the screen).
- `HomeSelectionScreen.tsx:37,44,50` — 'Bravo Secure Lite/Pro' (screen gets rebuilt §2.3).
- `NewsHubScreen.tsx:165` — "Bravo Secure products · Partner offers" (removed by M1 R8).
- 'Service Provider': `roleLabel.ts:12`, `RoleSelectionScreen.tsx:183,371`,
  `AgentTypeSelectScreen.tsx:47,54` — **M1 R1 decides**; the AGENCY-side occurrences
  (AgentTypeSelect) serve the agency product and may keep the term — ⛔ INDEX Q2.
- M3 owns the booking-side "BRAVO SECURE" header sweep.

## 8. Module acceptance (PDF p.2 + p.28 distilled)

- Fresh install: splash ~2 s → selector shows the three products with correct labels →
  chosen product onboarding → that product's dashboard. No combined home anywhere.
- Relaunch: opens the LAST active product directly (per product, all three).
- Switch Dashboard: lists only the other two, exact labels, switch resets the old stack
  (hardware back after a switch NEVER re-enters the previous product).
- Agent/CPO/agency logins unaffected end-to-end.
- Push/deep-link taps land in the right product with onboarding fallback.
- Test matrix (p.28): new + returning user × each tier × onboarding complete/incomplete ×
  location allowed/denied × online/offline × switching with/without unsaved work.

## Module loop additions

- After EVERY shell change: boot all three products + one agency + one CPO account.
- Messenger life-support check: runtime warm-up, incoming 1:1 call, group ring, and FCM
  wake must work from EVERY active product (the wrapper-level effects must never become
  product-conditional).
- `npm test` full + messenger crypto suite; on-device back-button walk per product.
- Screenshot the selector, each product landing, and the drawer per product for the boss.
