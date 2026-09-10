# Back navigation & rapid-use — why swipe-back / back-button and button-mashing feel buggy

**Date:** 2026-08-26 · **Status:** REMEDIATED SAME DAY (founder: "fix all") — every finding except NAV-01/02 (arch-gated) and the deptchat focus-storm internals (B-593-pinned) is FIXED with a regression pin; see §7 for the per-item status and `sqa.md` for **B-664..B-679** · **Branch read:** `main` @ `2da40e0b` · **sqa.md:** session entries 2026-08-26 (audit ids NAV-01..NAV-23)
**Symptom (client, via founder):** _"app is sometimes buggy — not smooth swipe back (back button also) and rapid use"_ · Founder's matching repro (sqa.md L24654): _"click one button 20 times then rapid back, forward — sometimes it's lagged"_

> Line numbers were re-grepped today on `main`. They go stale fast in this repo — **re-grep the symbol before acting on any of them.** Every claim below is a `file:line` read today or a number already in `sqa.md`. Estimates are marked _(est.)_. **Nothing in this document was measured on a device today** (`adb devices` → empty) — the device capture in §8 is still the step that closes B-279/B-285 honestly. This audit does NOT re-open the eight measured dead ends in the CLAUDE.md lag dossier; every finding here is navigation-event-tied or tap-burst-tied work that was **not** in that measured set.

---

## 0. TL;DR — the one-paragraph diagnosis

The complaint decomposes into **four verified mechanisms**, not one. **(1)** On Android this app has **no gesture-driven back transition at all, by construction** — every `gestureEnabled`/`fullScreenGestureEnabled` line is an iOS-only prop (dead code on Android), predictive back is explicitly (and correctly) disabled, and 6 of 9 stacks don't even set an `animation` — so a swipe-back is just the system back event plus a post-hoc pop animation, which can never read as "smooth" (§1). **(2)** Several back presses are **genuinely swallowed or double-fired**: two non-focus-scoped `BackHandler`s in `MessengerHomeScreen` and one in `FilesScreen` eat the first back press on any screen pushed above them, and the agent-shell `NavHeader` never received the double-tap guard `ObHeader` got, so its back chevron still double-pops (§2). **(3)** Rapid use is unguarded almost everywhere: the only ref-guarded button in the app is the chat send; ~109 forward-navigation presses and a set of async-mutation buttons (including a **pay button that can fire N Stripe charges**) queue their full handler cost once per tap, and the back press then waits behind the queue — exactly the founder's repro (§3). **(4)** The screens you land on when backing are the most expensive re-entries in the app: focus effects re-fetch, re-sort and re-commit the chat list / booking home / workspace home on **every** return, with zero dedupe across 83 `useFocusEffect` sites, so rapid back/forward multiplies that cost (§4).

**Plain-English analogy:** the back button rings a bell at a busy kitchen — the bell always rings (native feedback), but the one cook (JS thread) is already juggling 20 queued orders from the button-mashing, two waiters occasionally pocket the bell note entirely (swallowed `BackHandler`s), and walking back into the dining room re-triggers a full table reset every time (focus refetch storm).

---

## 1. The architecture ceiling — swipe-back on Android cannot be smooth today

### NAV-01 — Android has no in-app swipe-back; every gesture option in the repo is iOS-only ⚠ P0 (by impact) · ARCH-GATED

- `@react-navigation/native-stack` types annotate both `gestureEnabled` and `fullScreenGestureEnabled` as `@platform ios` (`node_modules/@react-navigation/native-stack/src/types.tsx:420-441`).
- `react-native-screens` 4.16 Android stores `isGestureEnabled` (`Screen.kt:61`, set from `ScreenViewManager.kt:156-161`) and **reads it nowhere** in the Android source tree — a stored, unused property.
- RNS 4.x _does_ ship an Android swipe-back (`GestureDetectorProvider` + `goBackGesture`), but the app never mounts it: `App.tsx:71` wraps only `GestureHandlerRootView`; no `GestureDetectorProvider` exists in `src/`.
- Sites that believe otherwise (all no-ops on Android): `MessengerNavigator.tsx:80,84`, `AuthNavigator.tsx:31,34`, `BookingNavigator.tsx:81,84`, `AgentNavigator.tsx:100,103`, `NewsNavigator.tsx:22,25`, `CpoOnboardingNavigator.tsx:50`, plus ~12 per-screen `gestureEnabled: false` opt-outs (those screens are actually protected by their `BackHandler`/`beforeRemove`, not the option).
- The B-372 `Platform.OS === 'android'` ternary on `fullScreenGestureEnabled` is **inverted relative to reality**: it enables the prop only on the platform where it does nothing. (B-372's actual goal — stop iOS full-screen-pan hijack — is still achieved, because the prop is off on iOS; the ternary is just misleadingly named "Android swipe-back".)

**Consequence:** on Android, the user's edge swipe is the _system_ gesture-nav back → `OnBackPressedDispatcher` → `BackHandler` → instant `pop`. No finger-following transition, no peek of the previous screen. **Swipe and button are literally the same code path** — which is exactly why the client reports both together.

### NAV-02 — Predictive back is explicitly disabled (correctly — do NOT flip it) · WONTFIX-FOR-NOW

`android/app/src/main/AndroidManifest.xml:121` — `android:enableOnBackInvokedCallback="false"`, with the 40-line justification at `:86-119`. The reasoning is correct: RNS 4.x does not consume `OnBackInvokedDispatcher`, and flipping it true backgrounds the app on every back press. But it is the second half of NAV-01's user-visible symptom: on Android 13+/14+ there is no system back-preview animation either, so **the back gesture has zero progressive feedback of any kind**. This ceiling lifts only via RNS's `GestureDetectorProvider` path or RNS predictive-back support (RNS 4.x roadmap / v7 territory).

### NAV-03 — 6 of 9 stacks set no `animation`, so back speed differs per shell · P3

`animation` is specified only in `MessengerNavigator.tsx:72` (`slide_from_right`, 220 ms), `AuthNavigator.tsx:26`, and the root stack (`index.tsx:62`, `fade`). `BookingNavigator`, `AgentNavigator`, `NewsNavigator`, `CpoNavigator`, `CpoOnboardingNavigator`, and all four `DepartmentalNavigator` stacks (`stackOpts`, `DepartmentalNavigator.tsx:99`) fall through to the platform default fragment animation. The app therefore has **two visibly different back-animation speeds** depending on shell — a plausible contributor to "_sometimes_ not smooth" as a consistency complaint.

---

## 2. Back presses that are genuinely swallowed, double-fired, or racing

These are **bugs, not perception** — the cheapest high-impact fixes in this audit.

### NAV-04 — `MessengerHomeScreen` registers two non-focus-scoped `BackHandler`s that swallow the first back press on screens pushed above it 🔴 P0

`src/screens/messenger/MessengerHomeScreen.tsx:739-746` (tab-reset handler, `useEffect` keyed `[activeTab]`) and `:725-732` (`chatSelect` handler, `useEffect` keyed `[chatSelect]`). Both are plain `useEffect`, **not** `useFocusEffect`. MessengerHome is a native-stack route and **stays mounted** when `Chat` / `CallsLog` / `NewsArticle` / `Files` are pushed on top. RN dispatches `hardwareBackPress` handlers LIFO — last registered wins — and none of the pushed screens registers its own `BackHandler`.

**Repro:** switch MessengerHome to the Calls/Groups/Files/News tab → open a chat (or article) → press back → **nothing visibly happens** (the handler returns `true` and silently flips a tab on the hidden screen below) → second press pops. This is _verbatim_ the B-261 symptom ("first back appears dead, second pops") — but it is a **swallowed event**, not JS-thread lag, and `goBackOnce` cannot help. A real, reproducible cause of the client's "back button buggy".

### NAV-05 — `FilesScreen` has the identical non-focus-scoped swallow ⚠ P1

`src/screens/messenger/FilesScreen.tsx:476-483` — `useEffect` keyed `[selectionMode]` registering `hardwareBackPress` → `setSelected(null); return true;`. FilesScreen stays mounted under any pushed screen; while a selection is active, any back press above it is eaten. Its `beforeRemove` companion at `:493-501` is correctly route-scoped — the asymmetry proves the `BackHandler` should have been `useFocusEffect` too. (Combined with the `beforeRemove` intercept, FilesScreen has **two** independent first-press swallows in selection mode.)

### NAV-06 — `NavHeader` (agent shell) never received the BB-7 double-tap guard `ObHeader` got ⚠ P1

`src/screens/agent/_shared.tsx:28-56` — `NavHeader` renders `onPress={onBack}` **raw**. Its deptchat twin `ObHeader` (`src/screens/deptchat/_obsidian.tsx:116-127`) got a 600 ms ref guard from the 2026-08-15 BB-7 finding, deliberately placed "at the ONE component all of them share". The same fix **never landed on `NavHeader`**. 9 unguarded back sites: `AgentInviteCodeScreen.tsx:60`, `AgentTypeSelectScreen.tsx:141`, `MissionLeadConsoleScreen.tsx:257`, `AgentDeploymentRequirementsScreen.tsx:132`, `AttendanceScreen.tsx:130`, and the four wizard screens via `handleBack`. A double-tap here is the B-261 class: the second `GO_BACK` bubbles to the parent navigator and **pops a screen the user never asked to leave**. This is the founder's "rapid back/forward" surface.

### NAV-07 — Four agent screens' hardware-back handlers close over a stale `handleBack` · P2

`AgentAvailabilityScreen.tsx:97-104`, `AgentKYCScreen.tsx:149-156`, `AgentCoverageScreen.tsx:120-127`, `AgentDocsUploadScreen.tsx:163-170` — `useFocusEffect` with `[]` deps and a suppressed lint rule, capturing first-render `handleBack`. The sibling `AgentRegistrationWizardScreen.tsx:186-195` already fixed this with `handleBackRef`; these are the un-fixed copies. (`AgentDocsUploadScreen`'s `handleBack` can also pop an `Alert.alert` from a back press — a native-modal hop that reads as a stall.)

### NAV-08 — Timer-based navigation that can race a user's back press · P2

- `src/components/ProfileDrawerModal.tsx:82` — `setTimeout(() => navigation.navigate(...), 220)`; a back inside the window pops, then the timer navigates anyway.
- `src/screens/dashboard/DashboardScreen.tsx:635` — same shape, 240 ms.
- `src/screens/agent/IncomingOfferScreen.tsx:102` — `setTimeout(→ navigation.goBack(), 2800)`: an **unguarded programmatic goBack**; if the user already backed out, this fires a second `GO_BACK` that bubbles to the parent (the exact `tapGuard.ts:8-14` mechanism). `dismissed.current` is not set by an actual user back.
- Counter-examples done right: `FilesScreen.tsx:289`, `VaultScreen.tsx:157` (`navigation.isFocused()` check inside the timer).

### NAV-09 — Hard-swallowed back with zero user feedback · P2

`OpsRoomReviewScreen.tsx:310-320` (payment lock — also mutates `setOptions` per lock-state flip; the `gestureEnabled` half is a no-op on Android per NAV-01) and `AgentAdminApprovalScreen.tsx:113-116` (`() => true`). Intentional traps, but with no toast/hint the press reads as "app is stuck". The only handler in the app modelling fall-through correctly is `VBGGeoRiskScreen.tsx:96` (returns `false` when its dropdown is closed).

### Standing unfixed inventory: BB-1..BB-13 (2026-08-15) — still findings-only

The app-wide back-button audit at `sqa.md:17729-17848` shipped **no fixes**. Its P1s (BB-1 IncomingGroupCall decline strands on ring screen; BB-2 dead back on cold-answered calls; BB-3 notification-tap targets genuinely STUCK; BB-6 `goBackOnce` has no `canGoBack()` fallback) all still stand and all overlap this client complaint. This audit does not re-derive them — read that entry.

**Clean bill (back lane):** all 20 `BackHandler` sites remove their subscriptions correctly (no leak, no per-render stacking); no `blur` listeners exist; `goBackOnce` itself (`src/navigation/tapGuard.ts:68-87`) is sound and applied at ~226 call sites across ~106 files; there are **no JS-stack navigators** (everything is native-stack/bottom-tabs, so no custom interpolators to mistune).

---

## 3. Rapid use — what 20 taps on one button actually queues

### NAV-10 — The only guard that exists covers `goBack` only; ~109 forward-navigation presses are unguarded ⚠ P1 (systemic)

`tapGuard.ts:39-42` scopes itself to back-navigation by design. **No generic debounce/throttle/pressGuard/inFlight helper exists anywhere** (`src/utils`, `src/hooks`: zero matches). `navigate()` dedups the destination (no `push()` sites exist in `src/` — verified), so 20 taps ≈ 1 screen but **20 dispatches + 20 StackRouter reducer runs**, and the back press queues behind all of them. Top-traffic unguarded sites: Dashboard module cards (`DashboardScreen.tsx:515,525,535`), tab bars (`ObsidianTabBar.tsx:201` — the `if (!focused)` gate is a render-time capture, stale for the whole burst under lag; `MessengerTabBar.tsx:148` additionally walks `findNavigatorWithRoute` per press), chat rows (`MessengerHomeScreen.tsx:1298` → `openConversation.ts:109-131`, a full `getState()` + dept resolution per press), `ChatScreen.tsx:1973` header, plus the full top-15 table in the sqa entry.

### NAV-11 — There is no shared Button component: 2,337 raw `TouchableOpacity`, exactly ONE ref-guarded button in the app · P1 (systemic)

`src/components/ui/` contains no Button. Every guard is hand-rolled per site — which is why coverage is patchy and why the **chat send button is the only correctly ref-guarded press in the app** (`ChatScreen.tsx:4020-4045`: `textRef.current = ''` cleared before anything async; taps #2..#20 cost one ref read). Everything else relies on React-state `disabled`, which commits **late precisely when the JS thread is lagging** — the exact condition of the repro.

### NAV-12 — Pay button: no `disabled`, no in-flight guard, real money 🔴 P0

`src/screens/booking/CreditPaywallScreen.tsx:614-618` — `onPress={() => { void runPayment(); }}` with **no `disabled` prop**, and `runPayment` has **no early return** on `processing` (both gates are React state). 20 queued taps → up to 20 `topUpAndCharge()` → **20 Stripe PaymentIntents + 20 wallet credit additions**. The other top-up screen does it right (`CreditsScreen.tsx:133-135`: `if (!pkg || purchasing) return;`) — same operation, two implementations, one guarded. Under the founder's exact repro conditions this is a duplicate-charge factory.

### NAV-13 — SecurePro accept/activate: `isSubmitting` is written but never read as a bail-out ⚠ P1

`src/store/secureProStore.ts:152-167` (`acceptProposal`) and `:184-199` (`activate`) set `isSubmitting = true` but have **no `if (get().isSubmitting) return;`**. The only protection is `disabled={isSubmitting}` at the screens (`SecureProProposalScreen.tsx:239`, `SecureProPaymentScreen.tsx:244` — the latter's handler `:83-90` has no guard at all), i.e. a committed re-render — late under lag. The correct in-repo pattern is `authStore.ts:641` (synchronous store read). 20 taps = 20 accept/activate API calls + up to 20 `navigation.replace`.

### NAV-14 — `activityStore` still has the B-633 defect, reachable from an unguarded dashboard tap ⚠ P1

`src/store/activityStore.ts:90` — bare `createJSONStorage(() => AsyncStorage)`: every `set()` pays a **synchronous `JSON.stringify` of the whole ≤200-row feed** plus an AsyncStorage bridge call, with no debounce. Hot unguarded paths: `DashboardScreen.tsx:588` (`markActivityRead(row.id)` per drawer row — the **single most amplifying unguarded tap found**: 20 taps = 20 × (200-row map + 200-row stringify + bridge write)); `:567` `markAllActivityRead` (also fires unguarded network sync); `ActivityCenterScreen.tsx:111,173`. `productStore.ts:78` and `emergencyCallLog.ts:105` share the pattern with trivial payloads (low risk). The fix (`messengerStore`'s debounced `PersistStorage`, `messengerStore.ts:63-145`) already exists in-repo.

### NAV-15 — Reaction emoji: 20 taps = 20 sealed envelopes, nondeterministic final state · P2

`ChatScreen.tsx:2363` / `DepartmentChatScreen.tsx:1543` → `reactToMessage` (no in-flight ref; `setActionMsg(null)` is React state). Each press = one crypto seal + network fan-out, and `remove` is recomputed from `msg.reactions?.self`, so a burst toggles on/off nondeterministically.

### NAV-16 — The alert queue has no dedupe: 20 taps = 20 stacked dialogs · P2

`src/utils/alert.ts:63-76` — FIFO queue, no identity check or coalescing (doc comment `:22` confirms). Worst instance: **`confirmProductSwitch`** (`productSwitch.ts:94-111`; pressed from `VBGHomeScreen.tsx:367-369` and `SwitchDashboardSection.tsx:327`) fires one Alert **plus a lazy `require()` of the group-ring module** per press, zero latch. The user must dismiss all 20 one at a time — reads as "app went insane".

### NAV-17 — Other unguarded async-mutation buttons (inventory) · P2

20 taps = 20 mutations at: `IncidentDetailScreen.tsx:274,280` (assign), `MessengerSettingsScreen.tsx:623` (unblock), `ChatInfoScreen.tsx:658/862` (save contact), `ProfileScreen.tsx:437` (**biometric toggle** — 20 keystore ops, nondeterministic final state), plus `void load()` refresh buttons with no `disabled` at ~10 sites (full list in the agent sweep; counter-example done right: `LocationHistoryModal.tsx:94`). Call buttons: `launchCall.ts` guards are synchronous registry reads (good) but the registry is written after the callee mounts — the module's own comment (`:323-326`) acknowledges the N-tap window (`ChatScreen.tsx:1906,2041,2044` press sites unguarded).

---

## 4. Why back feels laggy _after_ rapid use — JS work tied to the navigation path itself

Zero of the 83 `useFocusEffect` sites has an in-flight dedupe or min-interval guard — a `cancelled` flag only suppresses the `setState`, never the request. Rapid back/forward therefore issues N concurrent requests whose N setState bursts all land after the transition. These costs were **not** in the eight measured dead ends (those were render-tree candidates; these are navigation-event candidates).

### NAV-18 — Returning to the chat list fires 2 HTTP round-trips + ~N store commits + a full list re-sort, every time 🔴 P1 (top lag suspect)

`src/screens/messenger/MessengerHomeScreen.tsx`:

- `:269` focus → `flushRosterIntents()` → `conversationApi.listMine()` → per-conversation loop `:293-379` (4 `getState()` reads + one `upsert` store `set()` per row) → second prune loop `:390-404`. ~100 threads ≈ ~100 store commits per focus _(est.)_.
- `:465` focus → `departmentApi.listChannels()` → `:473-474` **`setDeptGroupIds(new Set(...))` unconditionally — fresh identity even when byte-identical** → invalidates the `ordered` memo `:505-513` → full `.map().filter().sort(compareConversationsForList)` chat-list rebuild + FlatList re-render on **every** back into Home. The in-code justification at `:485-489` covers only the store write, not the React state write two lines above it. Then `:491` N more `rememberDeptConversation` calls.
- `:435` third focus effect (`drainDispatchRoomIntents`) for authority accounts.

Chat list ↔ chat screen is the app's highest-frequency back/forward pair. **Each back = both round-trips + the rebuild landing on the JS thread while the pop animation runs.** Under the founder's repro (rapid back/forward), these stack N-deep.

### NAV-19 — `GroupsScreen` repeats the same new-`Set`-per-focus invalidation ⚠ P1

`GroupsScreen.tsx:132-152` — `:141` `setDeptGroupIds(new Set(next))` unconditional → invalidates the `groups` memo `:164-179` (full conversation-map filter/map/sort) per focus.

### NAV-20 — `BookingHomeScreen` focus = AsyncStorage read + 2 network loads + interval restart + a possible `navigate()` mid-transition ⚠ P1

`BookingHomeScreen.tsx:183-231` — per focus: `AsyncStorage.getItem` + `JSON.parse` (`:195-196`), `loadProApplication()` (`:202`), `await loadBookings()` (`:203`), a **fresh `setInterval(loadBookings, 8000)`** rebuilt every focus (`:207`), then `findResumableBooking` which can itself **`navigate()` during the focus commit** (`:218-228`). Rapid back/forward stacks concurrent `loadBookings` and can re-trigger the resume navigation mid-transition.

### NAV-21 — `DepartmentalHomeScreen`: 6 sequential awaited fetches, 6 render passes, per focus ⚠ P1

`DepartmentalHomeScreen.tsx:71-101` — workspaceSettings, myShifts, myTodayShift, orgSummary, incident queue + filter, join requests — strung over ~1.8 s _(est.)_ after every focus; and it is the `backBehavior="firstRoute"` target of `DepartmentalNavigator` (`:506`), so every module back lands here. Same class: `DepartmentChatScreen.tsx:804/:880` (two focus effects, ~N+7 setStates + 2 round trips per entry, incl. a sync store `set()` inside the focus handler), `DepartmentChannelsScreen.tsx:731` (5 API calls + admin sweep), `useProPlanGate.ts:40-52` (network per focus **×9 mounted screens**, plus a `StackActions.replace` dispatched from inside a focus effect), `ProfileScreen.tsx:215,226`, `IncidentQueueScreen.tsx:85-93`, plus ~45 single-`load()`-on-focus screens (uniform 1 request + 1-2 setStates; they compound only because none is deduped).

### NAV-22 — Leaving a chat you typed in runs an O(conversations + groups) partialize inside the back pop ⚠ P1

`ChatScreen.tsx:3928` — unmount cleanup flushes the draft → `setDraft` (`:249` → `messengerStore.ts:1363`) → a zustand `set()` whose `partialize` (`:2051-2100`) **synchronously spread-copies every group (`stripGroups`) and every conversation (`stripLastMessage`)**. Only the stringify+write is debounced (B-633); the partialize allocation is per-`set()`. A heavy account pays this on the JS thread at the exact moment the pop animation starts. Only bites when the user actually typed (`setDraft` early-returns on unchanged value, `:1366-1372`) — but "type, then back out" is the most-travelled back path in the app.

### NAV-23 — Navigation-root subscriptions and freeze posture · P2

- **Bare `useAuthStore()` (no selector)** at `navigation/index.tsx:37` (re-renders the whole `NavigationContainer` subtree on any auth write), `MainNavigator.tsx:369` (owner of the tab navigator), and `MainNavigator.tsx:144` (**inside `CustomTabBar`**, which React Navigation already re-renders on every nav state change; `:146-152` recomputes `userInitials` and `:196-210` walks routes per nav event).
- **`freezeOnBlur` coverage:** set stack-wide only on `MessengerNavigator.tsx:70` (+ `AgentNavigator.tsx:309` Chat). Absent on Booking/Agent-global/News/Auth/CpoOnboarding/Cpo/all four Departmental stacks/the root tabs — blurred screens there keep rendering through every pop; every store commit reaches all three root tabs. **Correction to `MESSENGER_LAG_AUDIT_2026-08-24.md` N2:** an explicit `freezeOnBlur: true` **does** work without `enableFreeze()` (`react-native-screens/src/components/Screen.tsx:77` uses `freezeEnabled()` only as the destructuring _default_; native-stack forwards explicit values). The real problem is coverage, not a no-op.
- O(N)-per-commit selectors that land during transitions: `DashboardScreen.tsx:209-211` (`Object.values(conversations).reduce` on every messengerStore commit, Dashboard always mounted), `useDeptConversationFilter.ts:50-58` (identity flips on the very `rememberDeptConversation` loops NAV-18 runs). All 45 messenger screens are eagerly imported (`MessengerNavigator.tsx:7-48`).
- JS-driven animations near transitions (P3): `LoadingView.tsx:195` (`useNativeDriver:false`, full-screen during auth transitions), `DashboardScreen.tsx:299` (SOS progress), `VBGHomeScreen.tsx:165,174`.

---

## 5. What this audit does NOT re-open (verified standing)

- The **eight measured dead ends** (CLAUDE.md lag dossier) stand. Nothing above proposes deleting shadows/gradients, gating modals, list-window tuning, or `runAfterInteractions` deferral.
- **B-632/B-633/B-634 are fixed in source** (re-verified today: `messageMirror` Map dedup; `makeDebouncedJsonStorage` is a `PersistStorage` stringifying inside the 500 ms flush, `messengerStore.ts:63-145`; `flushBackupDirty` runs post-commit). Still not device-confirmed. Note: the doc block in `src/modules/messenger/__tests__/storePerSetCost.test.ts:1-40` still says "REAL and UNFIXED" — **stale prose**, code is fixed.
- The **chat send button is correctly guarded** (`ChatScreen.tsx:4028-4031`) — 20 taps on send cost ~one ref read each after the first. The founder's "one button ×20" is therefore most likely NOT the send button; the unguarded candidates are §3's list (dashboard cards, tab bar, activity rows, reactions, pay/accept buttons).
- All 20 `BackHandler` subscriptions clean up correctly; `goBackOnce` is sound; no `navigation.push()` exists (the worst rapid-nav failure mode is absent).

---

## 6. Ranked mapping to the client's complaint

| Rank | Symptom phrase                  | Mechanism                                                                                                                                               | Findings            |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1    | "not smooth swipe back"         | No gesture-driven back transition exists on Android at all; animation inconsistency between shells                                                      | NAV-01/02/03        |
| 2    | "back button also" (buggy)      | First press genuinely swallowed (messenger home tabs, files selection); double-pop on agent chevron                                                     | NAV-04/05/06, BB-\* |
| 3    | "rapid use" lags                | 20 unguarded handler executions queue; back press waits behind them; heaviest amplifiers unguarded                                                      | NAV-10..17          |
| 4    | "sometimes" (intermittent)      | Focus-effect refetch storms + draft-flush partialize make the SAME gesture cheap or expensive depending on account size, network, and which screen pair | NAV-18..23          |
| 5    | correctness risk found en route | Pay button can duplicate real charges under this exact repro                                                                                            | NAV-12              |

---

## 7. Fix plan — EXECUTED 2026-08-26 (founder: "fix all"); statuses below

B-numbers claimed in sqa.md (B-664..B-679). Every fix is mutation-proved or behavior-tested; see the sqa entry for the pin-per-bug table.

| #   | Fix                                                                                                                                                                                                                     | Closes    | Status                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | `useEffect` → `useFocusEffect` on the three non-focus-scoped `BackHandler`s (`MessengerHomeScreen`, `FilesScreen`)                                                                                                      | NAV-04/05 | ✅ FIXED (B-664/665) — pin `navRapidUseGuards`                                                                     |
| 2   | `ObHeader`'s 600 ms ref guard ported into `NavHeader` — one component, closes 9 sites                                                                                                                                   | NAV-06    | ✅ FIXED (B-666) — pin `navHeaderTapGuard`                                                                         |
| 3   | `CreditPaywallScreen`: synchronous `processingRef` early-return + `disabled` on the pay button                                                                                                                          | NAV-12    | ✅ FIXED (B-667) — pin `rapidUseSourceGuards`                                                                      |
| 4   | `secureProStore`: `if (get().isSubmitting)` bail-out in ALL six mutators (accept/activate/renew/cancel/requestChanges/submit)                                                                                           | NAV-13    | ✅ FIXED (B-668) — pin `secureProStoreRapidUse`                                                                    |
| 5   | `activityStore` on the shared debounced `PersistStorage` (`@store/debouncedJsonStorage`, extracted from messengerStore) + idempotent `markRead`/`markAllRead`                                                           | NAV-14    | ✅ FIXED (B-669) — pins in `activityStore.test`                                                                    |
| 6   | `sameIdSet` identity guard before `setDeptGroupIds` in both list screens                                                                                                                                                | NAV-18/19 | ✅ FIXED (B-670) — pin `navRapidUseGuards`                                                                         |
| 7   | `navigateOnce` (forward twin of `goBackOnce`, per-nav + per-destination, 500 ms) wired into the dashboard cards, both tab bars, chat rows/headers, BookingHome, AgentDashboard (~45 sites)                              | NAV-10/11 | ✅ FIXED (B-675) — pins `tapGuard.test` + wiring scans. The shared-Button consolidation stays open (design-shaped) |
| 8   | Focus-effect dedupe: `loadApplication` single-flight (covers useProPlanGate ×9), BookingHome one-live-run + poll kept per focus, DeptHome `Promise.all` + in-flight ref                                                 | NAV-20/21 | ✅ FIXED (B-678). Deptchat channel screens deliberately untouched (B-593 pins)                                     |
| 9   | Draft flush deferred one macrotask off the unmount/pop commit (value captured first; MSG-10/P0-S3 strips stay in partialize)                                                                                            | NAV-22    | ✅ FIXED (B-671) — pin `navRapidUseGuards`                                                                         |
| 10  | `freezeOnBlur: true` on the 7 unfrozen stacks + selector-ized the three bare `useAuthStore()` sites (root tabs deliberately NOT frozen — call-overlay blast radius, device verify first)                                | NAV-23    | ✅ FIXED (B-679) — pins `rapidUseSourceGuards`                                                                     |
| 11  | Alert queue coalesces identical (title, message) requests — covers `confirmProductSwitch` ×20                                                                                                                           | NAV-16    | ✅ FIXED (B-672) — pins in `alert.test`                                                                            |
| 12  | ARCH: RNS `GestureDetectorProvider` + `goBackGesture` (true finger-following Android swipe-back) — must first resolve the per-bubble `PanGestureHandler` and `Swipeable` row conflicts; or wait for RNS predictive-back | NAV-01/02 | ⛔ NOT DONE — arch/design-gated, needs founder green-light + device matrix                                         |

Also fixed en route: NAV-07 stale `handleBack` closures (B-673 — `handleBackRef` on the four agent screens), NAV-08 timer-nav races (B-674 — isFocused guards), NAV-15 reaction bursts (B-676), NAV-17 misc unguarded mutation buttons (B-677 — biometric toggle, unblock, save-contact, incident assign, mark-all-read). Still owed: the BB-1..BB-13 fixes (2026-08-15, findings-only), and NAV-09 (hard-swallow UX feedback — design-gated).

## 8. Device verification owed (the honest close for B-279/B-285)

`adb devices` was empty this session — **nothing here was device-measured**. The owed capture (unchanged since 2026-08-26 sqa entry): release APK, device with real history, run the founder repro (button ×20 → rapid back/forward) and read `[LAGDIAG]` + `jsThreadWatchdog` (`src/utils/jsThreadWatchdog.ts:123`, started at `MainNavigator.tsx:790`).

**Attribution gap found today:** every existing `[LAGDIAG]` probe covers backup/media/send (`mirrorBootstrap.ts:311,329`, `messageMirror.ts:566,909,944`, `merkleCommit.ts:157`, `mediaFiles.ts:43`, `aesCbc.ts:210`, `productionRuntime.ts:3844,6734`). **Zero probes cover any navigation event** — a capture today would emit bare "JS thread blocked ~Nms" lines with nothing to attribute them to. Before the device pass, add focus-effect timing probes (`console.warn`, `[LAGDIAG][nav]` tag) around `MessengerHomeScreen.tsx:269/:465`, `GroupsScreen.tsx:132`, `BookingHomeScreen.tsx:183`, `DepartmentalHomeScreen.tsx:101` — that is what turns the watchdog lines into named causes.

## 9. Register

- sqa.md session entry 2026-08-26 (this audit) — audit ids NAV-01..NAV-23; next free B-number untouched (B-664).
- Related standing entries: B-261 (double-pop; fixed, residual lag OPEN), BB-1..BB-13 (findings-only), B-279/B-285 (JS-thread investigation OPEN), B-632..634 (fixed, device-verify owed), B-155 (drain yield fixed), B-649 (nav-race spinner fixed).
- Corrections recorded here: `MESSENGER_LAG_AUDIT_2026-08-24.md` N2 (`freezeOnBlur` is NOT a no-op without `enableFreeze()` — coverage is the issue); `storePerSetCost.test.ts` doc block stale ("UNFIXED" → fixed).
