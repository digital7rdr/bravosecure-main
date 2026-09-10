# Chat-open animation lag — root cause & fix plan

**Date:** 2026-08-29 · **Branch:** `main` @ `82ce4d13`
**Complaint (founder):** tapping a chat opens it, but the opening animation is laggy instead of
WhatsApp-fluid. Same complaint as B-279's _"when I open a chat to go into the chat there is a
lagging animation"_ (2026-07-26) — this report extends that still-open item.
**Method:** two-agent — one reviewed all prior on-device evidence (B-279/B-285, the dead-phone
plan, the W3 perf-run reports), the other traced the live code path from chat-row tap to the end
of the open transition. Investigation only; no code changed.
**Line numbers go stale fast in this repo — re-grep the symbol, never trust a stamped line.**

---

## 0. The answer in plain English

The opening slide is a **native** animation (native-stack), so the GPU is not the problem — it
was measured idle twice. But the slide has two dependencies on the busy threads:

1. **It cannot START until JavaScript has built the ChatScreen.** That first render costs
   ~82 ms on the reference device on a quiet thread — and the JS thread is often NOT quiet
   (backup Merkle walks after send bursts, message-decrypt backlogs). A tap landing in one of
   those windows shows press feedback instantly (that part runs without JS) and then the slide
   starts visibly late. That is the "tap registers late" feeling.
2. **It stutters whenever the UI thread has to mount views mid-slide.** ChatScreen fires five
   side effects on mount, and every one of them lands **inside** the 220 ms animation window —
   including a mark-as-read store commit on a 200 ms timer that fires at the _tail_ of the
   220 ms slide, re-rendering the whole screen exactly while the animation is finishing.

Analogy: the curtain is motorized (native animation), but the stage crew (JS/UI thread) must
finish setting the stage before the curtain may move — and here the crew is still dragging
furniture across the stage _while_ the curtain moves, so it judders. WhatsApp feels fluid
because its chat screen keeps the animation window effect-free and does its bookkeeping after
the curtain has stopped. That is fix **F2** below, and it is cheap.

---

## 1. Evidence — all measured, none guessed

| source                                                                  | what it showed                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dumpsys gfxinfo`, Redmi Note 11, scripted 4× chat-open (B-279, sqa.md) | chat-open **20.5 % janky**, 99th **61 ms** (budget 16.7 ms), **64/419 frames "Slow UI thread"**, GPU 50th **7 ms** (idle). The jank is view MOUNTING, never drawing.           |
| `[PERFDIAG]` release-build probes (B-279)                               | ChatScreen render#1: hooks 2 ms, **body 82 ms**, 10 bubbles 6 ms, composer 0 ms. The cost is the commit (view count), not any one child.                                       |
| jsThreadWatchdog + Android `Looper PerfMonitor` (B-285)                 | JS-thread stalls up to **6.2 s** in a single queue message; ~350–500 ms per send compounding under fast sends.                                                                 |
| Founder's device, 2026-08-28 night (W2 evidence, dead-phone plan)       | after send bursts, **14 Merkle walk-commits back-to-back at 8.8–33.8 s each** (~4.5 min of re-download + re-hash). Any tap in that window starts its transition late.          |
| W3 perf run `PERF_20260829-0107` (yesterday)                            | **408 ms JS stall — FAIL** vs the 250 ms budget and **26.6 % janky** frames on a journey of _swipes only, zero chat-opens_. The stall generator is alive even without tapping. |
| B-279 closing note (sqa.md)                                             | "The chat-open frame is NOT fixed. 61–105 ms per open remains… next step is to cut view COUNT in the first commit… or profile the commit itself."                              |

---

## 2. The traced code path (tap → transition end)

### 2.1 Stack + animation config

- ChatScreen lives in a **native stack** — `createNativeStackNavigator`
  (`src/navigation/MessengerNavigator.tsx`), `@react-navigation/native-stack ^6.11.0`,
  `react-native-screens ~4.16.0`, New Architecture on.
- Stack-wide options: `freezeOnBlur: true`, `animation: 'slide_from_right'`,
  `animationDuration: 220`, full-screen gesture on Android. `AgentNavigator.tsx` mirrors the
  same options for its Chat registration. The `Chat` route adds nothing route-specific.
- **`freezeOnBlur` only activates after the transition completes** — the outgoing chat list is
  still live (and still re-renderable) during the slide. That matters for cause 2 below.
- Native-stack consequence: the slide runs on the OS animator, but it (a) can't start until
  React mounts ChatScreen's native views (JS work first), and (b) drops frames when the UI
  thread is busy mounting/updating views mid-slide. Both match the measurements exactly.

### 2.2 The press path is light (not the problem)

Row tap → `goChat` dup-tap ref guard (`MessengerHomeScreen.tsx`) → `openConversation`
(one local-store dept lookup, `src/screens/messenger/openConversation.ts`) →
`navigate('Chat')`. No SQL, no network before the dispatch.

### 2.3 ChatScreen's first render

- One **5,153-line component**, measured **~82 ms per render** on the reference device (its own
  code comment records it). That is the floor of tap→animation-start latency even on a quiet
  thread — several× worse on a Go-class phone.
- Messages are **already in memory** at open: zustand map capped at `MAX_HYDRATE_PER_CONVO = 200`
  (`messengerStore.ts`); the selector is a map lookup. **There is no SQL read on open** — so
  "pre-warm the hydration at press time" has nothing to warm. Don't propose it.
- The list is an inverted FlatList already measured-tuned (`initialNumToRender={10}`,
  `maxToRenderPerBatch={8}`, `windowSize={5}`, `removeClippedSubviews` on Android). Modal
  subtrees are gated. More list-prop fiddling is a measured dead end.

### 2.4 Mount effects that land INSIDE the 220 ms slide — the new finding

Nothing in ChatScreen defers to `transitionEnd` or `InteractionManager`. Every mount effect
fires during the animation window:

| effect                           | where                                     | why it hurts mid-slide                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setActive(conversationId)`      | `ChatScreen.tsx` → `messengerStore.ts`    | immer commit zeroing unread across sibling slots → re-renders every subscriber, **including the not-yet-frozen chat list behind the slide**                                                                                |
| notification dismiss             | `ChatScreen.tsx`                          | notifee async — cheap, but it's in the window                                                                                                                                                                              |
| `pullEnvelopes()` relay drain    | `ChatScreen.tsx` → `productionRuntime.ts` | backlog decrypt in **pure-JS crypto** (B-688 floor: sha256 ≈1.45 ms/KB, 100 KB codec ≈260 ms) + a store commit per message — heaviest exactly when the chat has unread traffic, i.e. the chats you tap                     |
| group roster `listMine` fetch    | `ChatScreen.tsx`                          | network + one upsert (groups without participants only)                                                                                                                                                                    |
| **`markRead` on a 200 ms timer** | `ChatScreen.tsx` → `productionRuntime.ts` | fires at t≈200 ms — **the tail of the 220 ms animation**: bulk status flip → another ~82 ms-class re-render + per-row backup-dirty nudges + WS receipt frames, committing view updates while the animator is still running |
| presence subscribe               | `ChatScreen.tsx`                          | WS frame — cheap                                                                                                                                                                                                           |

Each store commit → reconcile → native view-update batch competes with the animator on the UI
thread. This is precisely the gfxinfo signature: 64/419 Slow-UI-thread frames, GPU idle.

---

## 3. Root causes, ranked

1. **JS thread busy at tap time → the slide STARTS late.** The 408 ms stall measured yesterday
   with zero taps, and the 8.8–33.8 s Merkle walk-commits after send bursts, mean a tap
   frequently lands in a stall window. Feedback-now/slide-later is the founder's historical
   phrasing verbatim. Structural; already the W2/W5 roadmap lanes.
2. **Mount-effect work inside the animation window → the slide STUTTERS mid-flight.** The §2.4
   table — especially the markRead timer detonating at the animation's tail and `setActive`
   re-rendering the unfrozen list behind the slide.
3. **First-commit view mounting** (~10 bubbles + header + banner + composer chrome on the UI
   thread during the slide) — B-279's measured residue. Already tuned once (20→10); further
   reducible only by moving work out of the window, not by more prop tuning.
4. **The 82 ms JS render floor of the monolithic ChatScreen** — minimum latency before the
   animation can begin, even on a quiet thread.

---

## 4. Fix plan, ranked

- **F1 — Ship the W2 flip (Merkle commit from the leaf cache; kill the full walk).**
  Attacks cause 1, the biggest recurring stall generator. Already BUILT in shadow mode
  (`merkleLeafCache.ts`, soak 2-for-2 `match=true`); the flip is gated on the soak criteria in
  `DEAD_PHONE_SMOOTHNESS_PLAN.md` W2 + `BACKUP_LOOP.md` §2/§4. Highest impact, program-approved
  shape, verifier untouched.
- **F2 — Defer ChatScreen's open side effects to `navigation.addListener('transitionEnd')`**
  (native-stack emits it; add a ~400 ms fallback timeout): the `pullEnvelopes` drain, the
  notification dismiss, the group `listMine` sync — and start the 200 ms markRead timer from
  transitionEnd instead of mount. Result: an **effect-free 220 ms window** — directly kills
  cause 2. **This is NOT the measured-worse list deferral**: the content still mounts in the
  first commit, one mount pass; only side effects move. Risk: receipts/pull delayed ~¼ s (the
  runtime dedupes; the WS drain is belt-and-braces anyway). Gates: MESSAGE_LOOP §5 caller
  sweep + its suites (markRead/pull are runtime territory), NAV_RAPID_USE_LOOP §7 sign-off
  (ChatScreen is on its trigger list), full messenger gate both projects.
- **F3 — Split `setActive`:** keep `activeConversationId` set at mount (it gates inbound
  routing and notification suppression — must stay immediate), defer only the
  unread-zeroing store commit to transitionEnd so the outgoing list doesn't re-render behind
  the slide. Small win; store change → needs its own pin.
- **F4 — Close the measurement hole FIRST (cheap, do alongside F2):** a `[LAGDIAG]`
  tap→transitionEnd bracket in ChatScreen (`console.warn` — survives release), and a **tap
  step in `scripts/perf-journey.ps1`** — today the repo's only automated perf harness is
  swipes-only and never exercises the exact interaction the founder complains about. Then A/B
  F1/F2 interleaved (OLD/NEW/OLD/NEW — thermal drift lies) per the founder's
  device-verify-before-handover rule.
- **F5 (optional, founder taste):** `animation: 'fade'` (~150 ms) for the Chat route — a
  dropped frame in a fade is far less visible than a 16 px-per-frame jump in a full-width
  slide. Mitigation only, not a fix; any `animation` option change takes the NAV loop gates.
- **F6 — W5 native crypto floor** (native `subtle.digest` + utf-8 codec) makes the
  pullEnvelopes decrypt cheap. ARCH-GATED, sequenced after W3 numbers per the dead-phone plan.
  Not a quick win; listed for completeness.

**Suggested order:** F4 (bracket + harness tap step, get the baseline number) → F2 + F3 (one
change set, one A/B) → F1 rides its existing W2 soak gate → F5 only if the founder wants the
perceptual cushion → F6 stays on the W5 lane.

> **STATUS 2026-08-29:** F2+F3+F4 BUILT as **B-691** (sqa.md entry has the full record;
> gates green, 3 mutation proofs). F1 and F6 shipped the same day via the dead-phone
> program (B-687 flip + W5 native crypto, both device-proven) — causes 1 and 2 are now
> both addressed in code. F5 not taken (founder taste). OWED: the interleaved
> OLD/NEW `-ChatOpen` device A/B reading the new `[chat.open]` bracket off the Redmi.

---

## 5. What NOT to do (all measured dead ends — CLAUDE.md "app feels laggy" table)

- Deleting shadows / gradients / blur (GPU idle, twice-measured).
- Hook-count, bubble, or composer "optimizations" (2 ms / 6–11 ms / 0 ms).
- FlatList window tuning beyond the current numbers (inside noise).
- **Deferring the message LIST to `runAfterInteractions`** — measured **2× WORSE** both rounds
  (splits one commit into two + a placeholder→list layout pass). F2 differs: it defers side
  effects, never the content commit.
- Pre-warming message hydration at press time — messages are already in memory; no SQL on open.
- Softening any backup verifier / ARCH-GATED control to reduce backup cost — F1 is the
  sanctioned shape.

---

## 6. Sign-off criteria (when is this actually fixed?)

1. `[LAGDIAG]` tap→transitionEnd bracket reads **< 300 ms** (dead-phone plan §3 budget) on the
   Redmi Note 11, on a release build, read off the device (founder rule).
2. gfxinfo chat-open janky % back at/under the 20.5 % baseline and trending toward the 7.2 %
   scroll figure; Slow-UI-thread bucket materially down from 64/419.
3. The perf-journey harness includes the tap step and records both numbers per build, so a
   regression here fails a run instead of waiting for the founder to feel it.
4. Messenger gate green (both Jest projects, crypto ×2 per the flake rule) and the F2/F3
   deferral pinned by a new regression test (mount effects must not fire before transitionEnd).
