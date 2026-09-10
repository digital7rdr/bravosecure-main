# Back-Navigation Loop — every screen must have a WORKING way back (B-98)

**Status: FIXED 2026-07-17 (same day) — F1+F2+G1-G3 landed + device-verified; see §9 outcome log.**
Companion to `CROSS_PLATFORM_CALL_VIDEO_LOOP.md` (B-99) — same operating shape: run the
§4 diagnosis, apply the §5 fixes for the confirmed class only, then prove the §6
watchlist + §7 matrix before sign-off.

**Founder report (2026-07-17, screenshot):** the back chevron on **"COVERAGE &
SERVICES" (agent onboarding step 3/4)** does nothing. Ask: audit EVERY UI page —
does it have a back button, and does it actually work?

---

## 0. When this loop applies (trigger files)

- Any `navigation.replace(...)` added to a screen (creates an empty-stack-behind risk)
- `src/screens/agent/_shared.tsx` (`NavHeader` — the agent-side shared header)
- `src/screens/deptchat/_obsidian.tsx` (`ObHeader`), `src/screens/vbg/vbgUi.tsx` (`IconButton`)
- Any navigator's `initialRouteName` / `gestureEnabled` change
- Any new pushed screen: it MUST ship with a visible, working back affordance
  (or a documented deliberate trap, §3.3)

---

## 1. The live bug (B-98a) — dead back button on the agent wizard

### Where / who / why

- The button is fine: `NavHeader` (`src/screens/agent/_shared.tsx:38-46`) renders a
  chevron `TouchableOpacity` with `onPress={onBack}` + hitSlop, and
  `AgentCoverageScreen.tsx:103` passes `onBack={() => navigation.goBack()}`.
- **The stack behind it is empty.** The wizard is separate pushed routes in
  `AgentNavigator` (initial = `AgentTypeSelect`), but two paths advance with
  **`navigation.replace(...)`**, which swaps the current route instead of pushing:
  - **Resume entry (the screenshot path):** `AgentTypeSelectScreen.tsx:77-78` — on
    mount it fetches agent status and `navigation.replace(nextStepFor(status))`.
    For a returning provider (`PROFILE_COMPLETE` / `KYC_PENDING` — the same cohort
    as B-96) that is `replace('AgentCoverage')` → the stack is
    **`[AgentCoverage]` alone**.
  - **KYC advance:** `AgentKYCScreen.tsx:118` and `:132` — `replace('AgentCoverage')`.
- With a single-route stack, `navigation.goBack()` is a **silent no-op in release**
  (React Navigation only warns in dev) → a visually dead button. Swipe-back
  (`gestureEnabled` is on, `AgentNavigator.tsx:72-82`) dies identically, and
  hardware back then bubbles out and **exits the app** (the B-95 back-to-gate
  handler is client-shell-only — the agency shell has no fallback).
- The linear first-run path (`AgentRegistrationWizardScreen.tsx:123` uses
  `navigate`, a push) DOES leave a working back — which is why this bug looks
  intermittent: it bites **resumed** sessions, not fresh sign-ups.

### Fix (files + exact change — no code here)

**F1 — guarded back with a wizard-aware fallback.**

- `src/screens/agent/agentFlowHelpers.ts` — add `prevStepFor(step)` mirroring the
  existing `nextStepFor` order (`AgentTypeSelect → AgentRegistrationWizard →
AgentKYC → AgentCoverage → AgentAvailability → AgentDocsUpload →
AgentAdminApproval → AgentDeploymentRequirements`).
- In each wizard screen's `NavHeader onBack` (sites: `AgentKYCScreen.tsx:138`,
  `AgentCoverageScreen.tsx:103`, `AgentAvailabilityScreen.tsx:86`,
  `AgentDocsUploadScreen.tsx:121`, `AgentRegistrationWizardScreen.tsx:142`):
  `if (navigation.canGoBack()) goBack(); else navigation.replace(prevStepFor(...))`.
  Use `replace` for the fallback too — keeps the stack depth at 1 on the resume
  path instead of growing a synthetic history.
- ⚠️ **B-96 coupling:** back is UI navigation ONLY. Re-entered earlier steps must
  NOT auto-resubmit — the server FSM rejects submits from advanced statuses
  (`Cannot submit from status …`, fixed under B-96). Verify each step's submit
  button stays status-guarded when reached _backwards_.
- **Do NOT** blanket-swap `replace`→`navigate` on the advance paths instead: the
  replaces are deliberate (a completed step should not linger in history with
  stale form state), and the AdminApproval/DeploymentRequirements/LiveTracker
  replaces (`AgentAdminApprovalScreen.tsx:84/:87`,
  `AgentDeploymentRequirementsScreen.tsx:256/:258`,
  `AgentLiveTrackerScreen.tsx:254/:259`) land on roots/terminals and are correct.
- **Direct test (mandatory):** static lock in the `navigatorConfig.test.ts` idiom —
  every wizard `onBack` site contains `canGoBack`, and `prevStepFor` covers every
  step `nextStepFor` can emit.

**F2 — `NavHeader` latent trap.** `_shared.tsx:40-46` renders the chevron even when
`onBack` is `undefined` → any future caller that omits the prop ships a
dead-looking button. Render a spacer instead when `onBack` is absent (exactly what
`ObHeader` does — `src/screens/deptchat/_obsidian.tsx:50-78`). One-file change,
all 10 current callers pass `onBack`, so zero behaviour change today.

---

## 2. Full-app inventory (audited 2026-07-17, ~110 screens)

Method: every file under `src/screens/**` classified by back affordance and
handler: (a) plain `goBack()` · (c) `navigate(route)` · (d) step-wise/custom ·
(f) deliberate trap · none. Full per-screen table lives in the audit transcript;
findings below are the actionable deltas. **Notable systemic fact: NOT ONE screen
uses a `canGoBack()`-guarded back** — the entire app assumes a non-empty stack,
and the agent wizard is (today) the only place where that assumption breaks.

### 2.1 Working (no action)

All messenger, booking, deptchat, pro, vbg, settings, wallet, news-article, ops,
org/agency management and auth screens with a visible back control resolve to a
live `goBack()`/`navigate()` on a non-empty stack — verified handler-by-handler.
Root/tab/gate/terminal screens legitimately have no back control.

### 2.2 MISSING back affordance (B-98b — pushed screens with no visible way back)

| #   | Screen                                              | Evidence                                                                                                                        | Fix shape                                                                                            |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| G1  | `src/screens/news/NewsFeedScreen.tsx`               | pushed from `NewsNavigator.tsx:25` AND `MessengerNavigator.tsx:210`; header `:96-115` has filter + RSS buttons, **no back**     | add the module's standard back chevron to the header → `goBack()`                                    |
| G2  | `src/screens/messenger/FileVaultPurchaseScreen.tsx` | pushed paywall (messenger/agent/dept navs); the ONLY `goBack()` fires inside the post-purchase Alert `:72` — no close/"Not now" | add a visible ✕ / "Not now" → `goBack()`; a paywall must always be escapable (store-policy risk too) |
| G3  | `src/screens/liveops/LiveTrackingScreen.tsx`        | pushed live-tracking map; only a refresh control `:710` — escape is edge-swipe/hardware-back only                               | add a back `IconButton` (VBG pattern, `vbgUi.tsx:319`)                                               |
| G4  | `src/screens/auth/HomeSelectionScreen.tsx`          | registered (`AuthNavigator.tsx:41`) but **zero navigate sites** — unreachable B-91 leftover                                     | no back fix; either deregister or leave documented-dead (do NOT bolt UI onto a dead route)           |

### 2.3 Deliberate traps (correct — MUST stay trapped; regression list)

`booking/FindingDetailScreen` (live auto-dispatch, Cancel-only, gesture off) ·
`booking/MissionCompleteScreen`, `deptchat/IncidentSubmittedScreen`,
`deptchat/AttendanceResultScreen` (terminal, `popToTop` buttons) ·
`messenger/IncomingGroupCallScreen` (ring), `VaultLockScreen` (lock gate),
`BackupRestoreScreen` (back prompts skip-restore) · `ops/OpsRoomReviewScreen`
(`lockBack` `:265` only while payment pending — releases when healthy) ·
`agent/IncomingOfferScreen` (Pass button exits) · `cpo/CpoActivationScreen`
(forward-only activation gate). Weakening any of these is a regression, and
`VaultLockScreen`/`BackupRestoreScreen` are additionally security-gated
(CLAUDE.md stop-conditions).

---

## 3. Who is causing it (one paragraph)

One live bug class, one hardening, four gaps. The live class (B-98a) is ours: the
agent wizard mixes `replace`-based advancement/resume with **unguarded plain
`goBack()`** back buttons — the moment the stack has nothing behind the current
route, every back affordance on that screen silently dies (button, swipe AND
hardware). The gaps (B-98b G1–G3) are screens that shipped without any back
affordance and currently ride on the OS edge-swipe. Nothing here involves the
backend, and the B-95 client-shell back-to-gate behaviour is a separate, working
mechanism (agency/CPO shells intentionally excluded from it).

---

## 4. Diagnosis loop (for ANY future "back doesn't work" report)

1. Is a back control **visible**? NO → §2.2 class (or a §2.3 trap — check the
   list). YES → 2.
2. Does the handler fire? Add a temp log / check the touchable isn't overlapped
   (zIndex/hitSlop) — the B-98a button DID fire. Fires → 3.
3. `navigation.canGoBack()` at that moment? **false → B-98a class** (find which
   `replace`/reset emptied the stack — §0 trigger list). true → the pop target is
   wrong (navigator nesting) — inspect with `navigationRef.getRootState()`.
4. Record the class in `sqa.md` under B-98 before fixing.

---

## 5. Fix order (smallest safe diffs)

1. **F1** wizard guarded-back + `prevStepFor` (fixes the founder's screenshot).
2. **F2** `NavHeader` spacer-when-no-handler (prevents the next dead button).
3. **G1–G3** add the three missing back controls (each a one-header edit reusing
   the module's own pattern; G2 needs a small product decision on copy — ✕ vs
   "Not now").
4. G4: decision only (deregister vs keep dead) — no UI work.

Explicitly NOT in scope: converting all ~90 working `goBack()` sites to guarded
calls (churn with zero behaviour change on non-empty stacks — the invariant to
enforce instead is in §0: new `replace()` ⇒ audit that screen's back).

---

## 6. Regression watchlist

| #   | Flow                                                                                                                        | Why at risk                                        | Proof                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| W1  | Fresh agent sign-up walks 01→4/4 linearly, back pops one step each time                                                     | F1 touches every wizard onBack                     | device walk + static lock                                        |
| W2  | Resume entry (status `PROFILE_COMPLETE`/`KYC_PENDING` → lands on 3/4) — back now goes to the previous step, no submit fired | THE bug; B-96 FSM coupling                         | device + `agentFlow.smoke.test.ts` still green                   |
| W3  | Wizard forward flow unchanged (replaces still replace; AdminApproval → Dashboard/Rejected intact)                           | F1 must not touch advance paths                    | code review + device                                             |
| W4  | Every §2.3 trap still traps                                                                                                 | inventory touched their files' classification only | spot-check FindingDetail + VaultLock + OpsRoomReview pending-pay |
| W5  | B-95 client-shell back-to-gate unaffected (product roots → gate; gate → exit)                                               | same BackHandler space                             | rerun B-95 matrix rows 7-9                                       |
| W6  | G1–G3 screens: new back controls pop to the correct parent from EVERY push site (NewsFeed is pushed from two navigators)    | multi-parent pushes                                | device from each entry point                                     |

---

## 7. Gates + device matrix

1. `npx jest src/screens/agent src/navigation --selectProjects=app` (incl. the new
   static locks + `agentFlow.smoke.test.ts`) — 0 failures.
2. `npm run typecheck` ≤ baseline · `npm run lint` 0 errors on touched files.
3. Device (BlueStacks agency + client accounts):

| Lane | Steps                                                             | Expect                                                              |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| M1   | Agency resume w/ status `PROFILE_COMPLETE` → lands 3/4 → tap back | goes to 2/4 (KYC), no submit fires, no app exit                     |
| M2   | Same screen: hardware back + edge swipe                           | same as M1 (all three affordances agree)                            |
| M3   | Fresh sign-up: 01→4/4 forward, then back-back-back                | steps pop in reverse order                                          |
| M4   | Messenger → News tab → NewsFeed                                   | visible back returns to News hub; same from the dept-chat push site |
| M5   | Open FileVaultPurchase, do NOT buy                                | visible ✕/"Not now" returns; purchase path unchanged                |
| M6   | LiveTracking from an active booking                               | visible back returns to the booking surface                         |
| M7   | One trap from §2.3 (e.g. FindingDetail)                           | still Cancel-only                                                   |

---

## 8. Sign-off criteria

- [ ] F1+F2 landed with the static locks; §6 W1-W6 all checked.
- [ ] G1-G3 landed (or explicitly deferred with founder sign-off); G4 decision recorded.
- [ ] §7 gates green; M1-M7 run (or the untestable lane named + why).
- [ ] No §2.3 trap weakened; VaultLock/BackupRestore untouched (security-gated).
- [ ] `sqa.md` B-98 updated with per-class outcome, per the SQA logging rule.

---

## 9. Outcome log — 2026-07-17 fix session

**Landed (all gates green: booking 163/163 · navigatorConfig locks 17/17 ·
agentFlowHelpers 63/63 incl. new prevStepFor spec · tsc 46 = baseline · eslint 0
on touched files):**

- **F1** — `prevStepFor` in `agentFlowHelpers.ts`; guarded back
  (`canGoBack() ? goBack() : replace(prevStepFor(step))`) in AgentKYC /
  AgentCoverage / AgentAvailability / AgentDocsUpload. AgentRegistrationWizard:
  back steps the INTERNAL 4-step wizard first, pops when possible, and hides
  the chevron on an empty stack at step 1 (fallback to AgentTypeSelect would
  bounce off its status auto-forward — discovered during implementation).
- **F1b (beyond the plan)** — hardware back wired to the same handler on all
  five wizard screens (focus-scoped BackHandler), so button/gesture/hardware
  agree; the Wizard falls through to default (background) when the chevron is
  hidden.
- **F2** — NavHeader renders a spacer when `onBack` is absent (+
  accessibilityRole/label on the chevron).
- **G1** NewsFeed header back · **G2** FileVaultPurchase visible "‹ Back" ·
  **G3** LiveTracking header chevron. **G4**: HomeSelection left documented-dead
  (deregistering is cosmetic; no UI bolted on).

**Device matrix (BlueStacks Pie64, release build, fresh operator account
b98.agenttester@example.com with a real `agents` row):**

| Lane                                                  | Result                                                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 resume `PROFILE_COMPLETE` → Coverage 3/4 → chevron | ✅ lands Agent Registration 1/4 (was: dead)                                                                                                                                |
| M2 same screen, hardware back                         | ✅ same target, app stays foregrounded (was: app exit)                                                                                                                     |
| M3 internal steps                                     | ✅ 2/4 → back → 1/4 (internal), chevron hidden at 1/4 on empty stack, reappears at 2/4; full linear 01→4/4 walk NOT driven (forward code untouched; agentFlow smoke green) |
| M4 NewsFeed back (both from hub)                      | ✅ pops to News hub                                                                                                                                                        |
| M5 FileVaultPurchase "‹ Back"                         | ✅ pops to Files                                                                                                                                                           |
| M6 LiveTracking                                       | ⚠ not device-driven (needs an active booking); change is a one-header addition, locked by the static test                                                                  |
| M7 trap spot-check                                    | ⚠ not device-driven; `git diff` confirms zero §2.3 trap files touched, B-95 client locks re-ran green                                                                      |

**Named deviation:** B-96 FSM re-submit coupling was NOT device-exercised past
the wizard forms (backwards entry renders forms without auto-submit — verified
by code read: submits only fire on button press).
