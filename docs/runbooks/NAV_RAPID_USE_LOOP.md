# NAV_RAPID_USE_LOOP — back navigation & rapid-use verification loop

**Born:** 2026-08-27, the day after the B-664..B-679 remediation shipped (v1.0.264).
**Companion to** the root `LOOP.md` — this is the module-specific loop for everything that
decides whether a back press or a tap burst behaves. Run it at the **start** of a task touching
a trigger file (baseline) and **after** the change (regression).

**Why it exists.** The client's "app is sometimes buggy — not smooth swipe back (back button
also) and rapid use" decomposed into FOUR mechanisms (audit:
`docs/audits/NAV_BACK_RAPID_USE_AUDIT_2026-08-26.md`), and the fixes are easy to silently
regrow: a new screen hand-rolls a `useEffect` BackHandler, a new button ships a raw
`navigation.navigate`, a new store uses bare `createJSONStorage`. Every one of those re-creates
a bug this loop's invariants killed. The first fix cut ALSO shipped six real defects that an
adversarial critic caught pre-commit — §8 pins those lessons so nobody re-derives them.

---

## §0 Trigger files — read this doc when a diff touches any of:

- `src/navigation/**` (navigators, `tapGuard.ts`, tab bars, `MainNavigator`, `index.tsx`)
- Any `BackHandler.addEventListener`, `beforeRemove`, or hardware-back handling in a screen
- Any `onPress` that navigates, or any new button whose handler mutates/spends (network, store
  write, crypto, payment)
- Any `useFocusEffect` that fetches or rebuilds a list; any screen's focus/blur lifecycle
- Any zustand store gaining `persist`; `src/store/debouncedJsonStorage.ts`
- `src/utils/alert.ts`; `confirmSwitchDashboard` callers
- Timer-driven navigation (`setTimeout(...navigate/goBack...)`)
- `freezeOnBlur` / `unmountOnBlur` / screen `animation` options anywhere

---

## §1 The four mechanisms (the triage map for any new sighting)

| Symptom                                      | Mechanism                                                                                                | First question                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "First back press does nothing, second pops" | **Swallowed event** — a mount-scoped `BackHandler` on a screen UNDER the pushed one (RN dispatches LIFO) | grep the screens beneath for `useEffect(...)`-scoped `BackHandler` (must be `useFocusEffect`)                                                                 |
| "Back popped TWO screens"                    | **Double-fire** — second `GO_BACK` carries a stale source and bubbles to the parent (B-261)              | is the press site on `goBackOnce` / a guarded shared header?                                                                                                  |
| "Tap registers late after mashing"           | **JS-thread queue** — N unguarded handler runs queued ahead of the next action                           | is the press site on `navigateOnce` / a sync in-flight ref? THEN read the CLAUDE.md lag dossier — eight causes are MEASURED DEAD ENDS, do not re-propose them |
| "Sometimes smooth, sometimes not"            | **Re-entry cost** — focus effects refetch/re-sort per return; blurred screens rendering through the pop  | in-flight dedupe present? Set/array identity preserved? `freezeOnBlur` on that stack?                                                                         |

And one ceiling no code change lifts: **Android has NO in-app swipe-back** (NAV-01/02 —
`gestureEnabled`/`fullScreenGestureEnabled` are iOS-only props, predictive back is correctly
disabled in the manifest). Swipe == back button by construction. Fixing that is §6 arch-gated.

## §2 Invariants (N1–N11) — check EVERY one against your diff

- **N1 — Focus-scoped BackHandlers.** A screen that stays mounted under pushed routes registers
  `hardwareBackPress` inside `useFocusEffect`, never `useEffect`. Pinned by
  `navRapidUseGuards` (nearest-preceding-hook scan, MessengerHome + Files). A NEW list/host
  screen adding a BackHandler must join that scan.
- **N2 — Tappable backs through `goBackOnce`; programmatic backs NEVER guarded.** The repo-wide
  scan in `tapGuard.test.ts` forbids `onPress={() => navigation.goBack()}`. A call ending or a
  save completing fires from a legitimately-blurred screen — wrapping it strands the screen
  (B-213). The scope rule is itself a test; do not "finish the job".
- **N3 — Hot forward-nav presses through `navigateOnce`.** Keyed per navigation object AND
  name+params (a name-only key ate the Secure→VBG cross-tap — §8), 500 ms leading edge,
  original call arity preserved. `onPress` only — never resume flows, deep links, redirects.
  Pinned by `tapGuard.test.ts` + the wiring scans in `rapidUseSourceGuards`.
- **N4 — Mutation buttons carry a SYNCHRONOUS guard.** `disabled={state}` needs a committed
  re-render, which lands late exactly when the JS thread is lagging — the guard is a ref or a
  `get().isSubmitting`-style store read (authStore signOut idiom), reset in `finally`
  (a throw latched the save-contact ref — §8). Money paths (CreditPaywall `processingRef`,
  the six secureProStore mutators) are the stop-condition tier: see §6.
- **N5 — Shared back components guard ONCE.** `ObHeader` (deptchat) and `NavHeader` (agent)
  carry the 600 ms ref guard so their ~35 call sites don't hand-roll it. A consumer whose
  `onBack` is an instant STEP-BACK (state change, not a pop) opts out via `backGuardMs`
  (`backGuardMs={stepIndex > 0 ? 0 : 600}` — the wizard), keeping B-98a chevron/hardware-key
  parity. Pinned by `navHeaderTapGuard`.
- **N6 — Timer navigation is focus-safe AND re-arming.** A deferred `navigate`/`goBack` checks
  focus (a stale `GO_BACK` bubbles to the parent — B-261 from a timer). But an isFocused-skip
  alone is NOT the fix for an auto-dismiss: it must re-arm on refocus (`useFocusEffect`), or
  the screen parks forever — the IncomingOffer watcher-swallow (§8). Pinned by
  `rapidUseSourceGuards`.
- **N7 — Focus fetches dedupe; derived collections keep identity.** One live run per screen
  (in-flight ref or store single-flight like `loadApplication`); a re-derived Set/array that is
  value-equal keeps the PREVIOUS identity (`sameIdSet`, `@utils/setEquals`) or every focus
  invalidates the list memos mid-transition. Pinned by `navRapidUseGuards`,
  `secureProStoreRapidUse`. **Deptchat channel screens are exempt-by-fiat** — their focus
  logic sits on the B-593 mint-time registry pins; do not "dedupe" them without that context.
- **N8 — Persisted stores use the shared debounced adapter.** `@store/debouncedJsonStorage`
  (`makeDebouncedJsonStorage(ms, tag)`), never bare `createJSONStorage` — that shape stringifies
  the whole slice synchronously on EVERY `set()` (the B-633 defect; activityStore regrew it as
  B-669). Read path must stay tick-for-tick (`getItem` never `async` — the G4 hydration trap);
  security strips (MSG-10 / P0-S3) stay in `partialize`, NEVER in the adapter. Pinned by
  `storePerSetCost.test.ts`.
- **N9 — Freeze posture.** `freezeOnBlur: true` on all nine stacks (pinned per-navigator in
  `rapidUseSourceGuards`); the Departmental **News TAB keeps `unmountOnBlur`** (freeze would
  skip its cleanups — scoped absence pin in `workspaceBottomNav`); the ROOT tabs stay
  UNfrozen until a device pass clears the call-overlay blast radius.
- **N10 — Alert coalescing is handler-less-only.** `@utils/alert` drops a duplicate
  (title, message) request ONLY when it carries no `onPress`/`onDismiss` — several call sites
  wrap Alert in a Promise settled solely by their own handlers (locationPermission,
  ShiftEditor); dropping one strands that await forever (§8). Handler-carrying confirms latch
  at their own source (`confirmSwitchDashboard`'s 600 ms module latch). Pinned in `alert.test`.
- **N11 — The navigation root subscribes by selector.** No bare `useAuthStore()` destructuring
  in `navigation/index.tsx`, `MainNavigator`, or the tab bars — a bare hook re-renders the
  whole container on every auth write. Pinned by `rapidUseSourceGuards`.

## §3 New-sighting protocol

1. Classify with the §1 table BEFORE proposing a fix.
2. If it smells like raw lag, read the CLAUDE.md "app feels laggy" dossier FIRST — eight
   candidates are measured dead ends, and the honest close for the residual is still the
   `[LAGDIAG]` device capture (§5), which has never been read off a phone.
3. If it is a swallowed/double-fired press, the fix is almost always one of N1/N2/N3/N5 —
   reuse the existing guard, never invent a new one (there were once THREE competing guard
   implementations; the audit spent a day unifying them).
4. Log the bug in `sqa.md` (numbering rules there) and extend the matching pin suite — the
   B-143+ contract applies.

## §4 Automated gates

```bash
# The loop's own pins (fast — run these FIRST):
npx jest --selectProjects app --testPathPattern "(tapGuard|rapidUseSourceGuards|backAffordanceGuards|navigatorConfig|utils/__tests__/alert|setEquals|secureProStoreRapidUse|activityStore|secureFlowFooter|workspaceBottomNav|activityCenterWiring|obsidianTabBarFocus)"
npx jest --selectProjects booking --testPathPattern "(navHeaderTapGuard|bookingHomeNav|agentDashboardOrgScoping|incomingOfferParams|wizardSwipeStepBack|cpoOnboardingBack)"
# Messenger-side pins live in the app project's messenger screens + the crypto project:
npx jest --selectProjects app --testPathPattern "screens/messenger"       # incl. navRapidUseGuards, messengerFooterAndBack
npx jest --selectProjects messenger-crypto --testPathPattern "(messengerHomeDeptFlash|draftsPersistence|storePerSetCost)"
```

Then the standard tier: if the diff touched `src/modules/messenger/**` or
`src/screens/messenger/**`, the FULL messenger gate applies (both projects, crypto twice —
CLAUDE.md flake rule). Typecheck vs baseline; changed-file eslint.

**Two operational traps, each of which cost this loop's birth-session real time:**

- **The pre-push hook coin-flips on the B-126 moving flake.** `test:changed` pulls the
  group-call timing suites in, and ONE random one (`groupCallHookReconcile`,
  `callAudioSessionArbitration`, …) fails under load, green in isolation. A failure that MOVES
  between attempts is the flake; retry the push on a QUIET machine. Never `--no-verify`.
- **`TaskStop` on a backgrounded jest run ORPHANS its workers.** One orphan pegged a core for
  90 minutes and made every later suite look broken (240 s timeouts in innocent suites). If a
  jest run must die, kill the node process tree (`Stop-Process`), and check
  `Get-Process node` before trusting any timing-sensitive red.

## §5 Device probes (the founder-rule pass for any release carrying a change here)

1. **Back-press sweep:** MessengerHome on a non-Chats tab → open a chat/article → ONE back
   returns (never a silent tab flip); Files multi-select → back exits selection, next back
   leaves; agent chevron double-tap → one pop, never two.
2. **The founder repro:** one dashboard module card ×20 fast → open Messenger → back/forward
   rapidly. Feedback may lag on a slow device (JS-thread ceiling stands) but nothing
   double-fires, nothing navigates twice, back lands where expected. Device-dependence is
   EXPECTED (a Pixel 6a absorbs what a throttled device cannot) — test on the slowest device
   available, ideally the client's model.
3. **Money:** pay button double-tap → ONE charge (watch the wallet ledger); SecurePro
   accept/activate mash → one API call, no premature Payment screen.
4. **Product-switch mash → ONE confirm dialog.** Wizard step-back taps 4→3→2→1 all land.
5. **Offer lifecycle:** bury IncomingOffer under a pushed screen through a cascade → returning
   shows the LIVE offer, never a parked "passed" card.
6. **Still owed from the audit (B-279/B-285):** the `[LAGDIAG]` release-APK capture during
   repro #2 — and note §8 of the audit doc: no nav-tagged probes exist yet, so add
   `[LAGDIAG][nav]` focus probes first or the watchdog lines are unattributable.

## §6 Stop conditions — verify before proceeding, or don't proceed

- **NAV-01/02 are ARCH-GATED.** Do not mount `GestureDetectorProvider`/`goBackGesture` or flip
  `android:enableOnBackInvokedCallback` as a side quest — the manifest flag's 40-line
  justification is real (flipping it backgrounds the app on every back press), and the gesture
  path conflicts with the per-bubble `PanGestureHandler` and row `Swipeable`s. Founder
  green-light + device matrix first.
- **Money-path guards** (CreditPaywall, secureProStore) are correctness-critical: weakening one
  re-opens duplicate real charges (B-667). A repeat on a navigating mutator must THROW, never
  silently resolve — callers navigate on resolve (§8).
- **`goBackOnce` semantics** (isFocused + per-nav timestamp, programmatic exemption) closed
  B-261 across ~230 sites; changes there need the full B-261/BB-6 context in sqa.md.
- **Adapter read-path timing** (N8) and **partialize security strips** — the G4 and MSG-10
  traps respectively; both have dedicated pins, neither may be "simplified".

## §7 Sign-off criteria

A change under this loop is complete when: every §2 invariant re-checked against the diff;
§4 gates green (crypto twice where applicable); a NEW guard/surface joined the matching pin
suite (red-first or mutation-proved); sqa.md updated for any new bug; and the §5 device pass
done or explicitly recorded as owed (founder rule). State which lane you could not exercise
and why.

## §8 DO-NOT-RE-PROPOSE — ideas already tried and corrected (critic pass, 2026-08-26)

| Idea                                                                     | Why it is wrong                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Silent `return` on an in-flight mutator guard                            | Callers `await` then navigate — the repeat resolves into the SUCCESS path (Payment screen for a never-accepted proposal). Throw; callers already catch.                         |
| `navigateOnce` keyed on route name alone                                 | Two buttons legitimately share a destination with different params (Dashboard Secure vs VBG → 'SecureTab'); the second real tap is eaten. Key = name + stable params stringify. |
| Alert dedupe for ALL duplicate requests                                  | Promise-wrapped alerts settle only via their own handlers; dropping one hangs the caller's await forever (live-mission location gate). Handler-less only + source latches.      |
| `isFocused()` skip on a one-shot auto-dismiss timer                      | Skipped-while-buried never re-arms → screen parks → the IncomingOffer watcher-swallow returns. Focus-scope the timer so it re-arms.                                             |
| The 600 ms back guard on wizard STEP-backs                               | Step-back is an instant state change, not a pop; guarding it throttles 4→3→2→1 and breaks chevron/hardware parity. `backGuardMs` opt-out.                                       |
| In-flight ref reset outside `finally`                                    | One rejection latches the ref and kills the button until remount.                                                                                                               |
| `freezeOnBlur` on the Departmental News tab or the root tabs             | News NEEDS `unmountOnBlur` (cleanups must run); root tabs carry call-overlay blast radius — device pass first.                                                                  |
| "Fix the lag" via shadows/gradients/windowSize/runAfterInteractions/etc. | The eight measured dead ends in the CLAUDE.md lag dossier. Numbers first.                                                                                                       |

**Register:** audit `docs/audits/NAV_BACK_RAPID_USE_AUDIT_2026-08-26.md` · sqa.md 2026-08-26
entries (B-664..B-679, next free B-680) · shipped `26f9df3d` + `5a432ce8` (v1.0.264/308,
Firebase qa) · related standing items: BB-1..BB-13 (findings-only), B-279/B-285 (device capture
owed), NAV-01/02 (arch-gated), NAV-09 (design-gated).
