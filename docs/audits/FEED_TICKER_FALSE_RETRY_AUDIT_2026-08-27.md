# Bravo Feed deformation + false "Tap to retry" — Audit (B-682 / B-683) — 2026-08-27

> **Trigger:** two founder screenshots. (1) The BRAVO FEED screen deformed on a Samsung
> device: feed list cut to ~2 cards, a tall blue striped block on the left edge, the
> `▶ WIRE` ticker rendering mid-screen, everything below empty. (2) A group-chat message
> showing the red **TAP TO RETRY** chip even though the recipients demonstrably received
> it ("technically it was sent, the receiver got the message, but it shows it did not send").
>
> **Status: CO-SIGNED by the adversarial critic (3 rounds — C1 conceded/re-dated,
> C2/C3 respecified, R2-1/R2-2 folded) AND code-co-signed (zero defects; 2 NITs
> applied). FIXES IMPLEMENTED per §1.4/§2.4; pins mutation-proved; §1.6's mandatory
> device gate PASSED (feed correct at fontScale 1.0/1.3 on device) and the §2.6
> golden-path regression PASSED (1:1 both directions, group fan-out+receive, offline
> honest ticks, live v21 migration). Full gate record + the B-683-E2E open item:
> the sqa.md B-682/B-683 entry.**
> Bug numbers: **B-682** (feed deformation + the Register float-field sibling),
> **B-683** (false Tap to retry).
> Sister docs: `docs/audits/FONT_SCALE_LAYOUT_AUDIT_2026-08-27.md` (B-680 — the batch
> that introduced B-682), `docs/runbooks/MESSAGE_LOOP.md` (governs the B-683 fix),
> `DESIGN_REVIEW_LOOP.md` (governs the B-682 fix).
> Line numbers are stamped at audit time — **re-grep the symbol at implementation**
> (MESSAGE_LOOP §11 trap 1).

---

## Part 1 — B-682: Bravo Feed (IntelFeedScreen) deformed

### 1.1 What the user sees

- Feed list (`BRAVO FEED` tab) renders ~2 cards then cuts off mid-card.
- A tall, solid-blue, horizontally-striped rectangle occupies the left edge mid-screen.
- The `▶ WIRE` ticker bar — designed as a 28dp strip pinned to the bottom — floats in
  the middle of the screen with feed content bleeding around it.
- Everything below is blank navy.

### 1.2 Root cause — diff-verified; the resolution mode is abductive, and honestly labelled

The screen is `src/screens/news/IntelFeedScreen.tsx` (NOT `NewsFeedScreen.tsx`, which is
"My Feed"). Root layout: a column whose ONLY flexible band is `styles.content {flex:1}`
(`:566`, style `:884`); the ticker sits below it in `tickerOuter` (`:714`, style `:949`,
no flex → `flexShrink:0` default, it never shrinks — `content` absorbs whatever size the
ticker takes).

Commit **`a66f1310`** (the B-680 font-scale "fix all", executing audit row **FS-61**)
changed one line:

```diff
-  tickerWrap: {height:28,    flexDirection:'row', alignItems:'center', overflow:'hidden'},
+  tickerWrap: {minHeight:28, flexDirection:'row', alignItems:'center', overflow:'hidden'},
```

But its first child kept a **percentage height** (`IntelFeedScreen.tsx:951`):

```ts
tickerTag: {paddingHorizontal:8, height:'100%', justifyContent:'center',
            backgroundColor: Colors.primary /* #1E88FF cobalt */, ...}
```

`height:'100%'` had been paired with the parent's **definite** `height:28` since the
screen was created (both introduced together in `0b5f3711`, per `git log -L`). Removing
the definite height **orphans the percentage**.

**Epistemic split (per critic C4):** what is _verified in source_ is the diff, the
orphaned percentage, and the style tree. What is _abductive_ is the exact Yoga
resolution mode for an orphaned percentage (blow-up against an ancestor extent vs
collapse-to-auto — both exist across Yoga versions, and no jest test renders Yoga). The
screenshot decides it: **a collapse cannot produce a tall blue block**, and every
artifact matches the blow-up cascade below — but because the mechanism was never
reproduced locally, the device/layout verification in §1.6 is a **mandatory gate**, not
an owed nicety.

The cascade, each structural step verified against the style sheet:

1. `tickerTag` (`height:'100%'`, `:951`) blows up — **the blue block**.
2. `tickerWrap` (auto height now, `:950`) grows to contain it; its `overflow:'hidden'`
   clips nothing because the view's own bounds grew.
3. `tickerOuter` (no flex, `:949`) grows with it; the root's only `flex:1` band
   (`content`, `:884`) is crushed to a sliver — **the ~2-card feed**.
4. `alignItems:'center'` on the wrap + `justifyContent:'center'` on the tag put the
   `▶ WIRE` label and ticker text at the vertical middle of the huge band — **the
   mid-screen ticker**.
5. `SCANLINE_OVERLAY` (`:839`, styles `:961-962` — 220 bands of `rgba(0,0,0,0.08)` at
   `zIndex:1000`) is invisible over dark UI but reads as **horizontal stripes over the
   large flat `#1E88FF` fill** — the striping on the blue block.
6. Below the ticker text, the tall band is `tickerOuter`'s `#0D1929` — **the blank area**.

Ruled out: `c5ba459c` (ops-console only, no news files), `565d91b6` / B-656 (pure
memoisation/virtualisation, no height/flex edits — though its ScrollView→FlatList change
is why the crush reads as "2 cards then stops"), the RN font-scale patch itself (it
_reduces_ text height; it cannot grow a band), `scaleTextStyles` (text keys only).

### 1.3 Why it shipped (process cause)

- FS-61's goal was right: `height:28` + `overflow:'hidden'` **sheared the tag text** at
  high fontScale. The fix (`minHeight`) removed the shear — and with it, the anchor a
  dependent style relied on. **The edit changed a style's contract without enumerating
  the consumers of that contract** (the `height:'100%'` child is a consumer of the
  parent's definite height) — the same class as the CLAUDE.md self-diff rule: "for every
  piece of state your change deletes, enumerate its live consumers first."
- The commit's own record says **"Device fontScale sweep OWED"** — it was gated on
  typecheck + jest only. No jest test renders Yoga layout, so no automated gate CAN see
  this; the only gate that can is a device/screenshot pass, and it was deferred.
- The stale comment at `:709-713` still describes "the 28px marquee row".

### 1.4 Fix

**F0a — `IntelFeedScreen.tsx:951`: `height:'100%'` → `alignSelf:'stretch'`.**
`alignSelf:'stretch'` fills the row's cross-axis whether the parent's height is definite
(28dp floor) or content-driven (grown by fontScale) — it expresses the actual intent
("as tall as the row") without needing an anchor. Keep `minHeight:28` on the wrap (the
FS-61 shear fix stays). Update the stale `:709-713` comment. Verified compatible with
the row: sibling `tickerScroll {flex:1}`; capped 1.3× ticker text tops out ~11.7pt,
well under 28; **none of the affected parents has vertical padding** (padding is where
stretch and percentage diverge — checked for all four sites).

_Alternative weighed and rejected (per critic C9):_ reverting to `height:28` — the same
commit's live 1.3× cap arguably re-licenses it (tag text ≤ ~10.4pt). Rejected because it
re-arms the FS-61 shear the moment any ticker font grows or the cap changes, and it
keeps the fragile percentage-plus-anchor pairing instead of removing the dependency.

**F0b — `RegisterScreen.tsx:882` (`fieldInputWrap`), SAME class, SAME commit, LIVE.**
`a66f1310` converted **two** `height:58 → minHeight:58` blocks in `RegisterScreen.tsx`
(`field`, `:869-872`) while their child `fieldInputWrap` kept `height:'100%'` — the
float-label geometry (`fieldFloatLabel :883-887`, `translateY:-13` animation
`:294-298`) was positioned against a 58dp wrap and has silently drifted. Same
treatment: `alignSelf:'stretch'`.

**F0c — defensive: the two latent siblings.** `LoginScreen.tsx:523` and
`ProfileCompletionScreen.tsx:204` (`dialCode`) are the same pattern whose parents still
have fixed heights (60/56) — safe today, orphaned the day the FS-audit recipe ("fixed
height on a text-holding box → minHeight") reaches them. Swap to `alignSelf:'stretch'`
now (behaviour-identical under a definite, unpadded parent — verified). Scope note: this
is two one-token edits pinned by the same test, accepted as the cheapest way to make the
pin describe a rule ("these four sites use stretch") rather than an exception.

**Pin:** a source-scan test (app project) asserting, per file, at the style site
(brace-body scan, the `badgeGeometry.test.ts` house shape; **line-based / `\r?\n` —
these files are CRLF**): `tickerTag` and the three `fieldInputWrap`/`dialCode` blocks
carry `alignSelf: 'stretch'` and NOT `height: '100%'`; `tickerWrap` keeps `minHeight`.
Mutation-prove by reverting one style.

### 1.5 Edge cases + the class sweep (reconciled count, per critic C7)

Definitive re-run (`height:\s*'100%'` over `src/`): **32 style sites in 25 files**
(35 raw matches minus 2 in `FlexibleVideoTile.test.tsx` and 1 comment line,
`GroupCallScreen.tsx:3180`; 25 distinct files).

| Verdict                               | Sites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **THE BUG**                           | `IntelFeedScreen.tsx:951` (parent converted to `minHeight:28`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Same class, live (MAJOR)**          | `RegisterScreen.tsx:882` (parent converted to `minHeight:58` by the same commit)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Latent (MINOR)**                    | `LoginScreen.tsx:523` (parent `field` h60 fixed, `:512-516`), `ProfileCompletionScreen.tsx:204` (parent `phoneField` h56, `:203`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Safe — definite/absolute parents (28) | `IntelFeedScreen.tsx:945` (`sigBar`, track h3) · 13 progress/score fills: `TripHistoryScreen:309`, `ProActivityHistoryScreen:259,275`, `OpsDashboardScreen:299`, `AgentHomeScreen:246`, `FileVaultPurchaseScreen:232`, `CreditPaywallScreen:760`, `OrgCreateCpoScreen:324`, `IndividualProfileScreen:421`, `VBGGeoRiskScreen:651`, `VBGSRAScreen:219`, `ProfileCompletionScreen:177`, `FileViewer:569` · 8 avatar/media fills: `ProfileScreen:567,569`, `DashboardScreen:1116`, `SecureProCalendarScreen:504`, `ChatScreen:5110`, `VaultScreen:886`, `EvidenceSection:110`, `VerifyAttendanceScreen:200` · `GroupCallScreen:2399,3186,3197` (documented BS-GC-BLACKVIDEO pinned wrappers) · `ProfileDrawerModal:336` (Modal full-height) · `SplashScreen:322` (root) |

The sibling B-680 commit `e934321c` (messenger-surface conversions) was swept too:
none of its converted parents contain a `height:'100%'` child — damage class zero.

Other checks: no other consumer/measurement of the ticker styles (only `:715-716`; the
file's one `onLayout` is the drawer pager); the marquee translate (`-1200`, `:406`) is
height-independent; nothing absolute anchors to the ticker's height (landscape/foldable
n/a); `bottomPad(4)` (`:714`) is the keyboard-rule inset, unaffected.

### 1.6 Verification — the device pass is a GATE for this bug

- Jest: the new source-scan pin, RED first (against the current broken style).
- Typecheck ≤ baseline 47; lint clean on touched files.
- **Device/emulator screenshot of BRAVO FEED (fontScale 1.0 and 1.3) is MANDATORY
  before B-682 is called fixed** — ticker a bottom strip, tag filling exactly the strip,
  list filling the screen; plus the Register float-label fields at both scales. The
  mechanism was never reproduced locally (§1.2), and §3.2 below is this doc's own rule:
  layout changes are device-gated. If no device can be attached this session, the fix
  ships as "built, device gate pending" — it is not reported as fixed.

---

## Part 2 — B-683: group message shows "Tap to retry" though recipients received it

### 2.1 What the user sees

In a group chat, the sender's own message (in the founder's screenshot: a reply-to-photo
with text, sent 1:19–1:20pm) flips to the red **TAP TO RETRY** chip — while other
members demonstrably received it.

### 2.2 Root cause — the display chain is verified; the initiating destroy is UNDETERMINED

**The send path is NOT the culprit.** The group fan-out (`productionRuntime.ts:3534+`)
uses `Promise.allSettled`; ≥1 delivered leg ⇒ `'sent'` (`:4073`), 0 delivered ⇒
`'sending'` (`:4070`) — never `'failed'`. A single bad member cannot fail the send.

**Elimination of every `'failed'`/`'undelivered'` writer compatible with "recipients
received it" (per critic C5):**

| Writer                                                                                                              | Verdict                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failGroupSend` guards (`:3593`), group-encrypt/key catch (`:3665`), cert catch + failed deferred enqueue (`:3732`) | Pre-fan-out — nothing shipped, recipients could NOT have received. Excluded.                                                                                                                                                                                      |
| `sendMedia` catch (`:4734`)                                                                                         | Text reply, media path not taken. Excluded.                                                                                                                                                                                                                       |
| Outbox drain exhaustion (`:9935-9948`)                                                                              | Guarded (L17): flips only from `'sending'`, never a `'sent'` bubble. Excluded.                                                                                                                                                                                    |
| Pending-LRU eviction (`:928`)                                                                                       | Requires `status === 'sending'` + >1000 pendings. Excluded for a sent bubble.                                                                                                                                                                                     |
| **MSG-07 boot sweep (`:2341-2360`)**                                                                                | **Reachable**: app killed in the window between relay accept (recipients receive) and the `'sent'` flip → hydrates `'sending'`, outbox rows already deleted → flipped to `'failed'`. Predicts: chip appears only after an app restart. Addressed by **F4** below. |
| **`applyEnvelopeUndeliverable` any-leg flip (`decryptFailureSignal.ts:170-186`)**                                   | **The structural, repeatable mechanism**: any ONE member's device destroying its leg reds the whole bubble. Predicts: chip on a live session, any time a leg dies. The chain below.                                                                               |

The screenshot (chip observed hours after send; no restart data) cannot discriminate
between the last two — **both are real defects and both are fixed here** (F1, F4). The
receiver-driven chain is the one that recurs per-message and matches "shows failed while
others hold it", so it is the primary.

**The receiver-driven chain (steps 2–5 verified end-to-end; step 1 reframed after the
critic's git-dating falsified the original story):**

1. **One member's device destroys its leg — cause undetermined.** ~~"Old version lacks
   `replyTo` in `SEALED_PAYLOAD_KEYS`"~~ — **falsified by git archaeology (critic C1)**:
   the strict key allow-list (`packages/messenger-core/src/crypto/sealedSender.ts:~760`)
   was born 2026-05-25 (`92d06da9`) **with `replyTo` already in it**, and the
   `disposition:'discarded'` machinery a destroying device needs dates to 2026-07-03 —
   no build both destroys-on-`replyTo` and acks `'discarded'`. The in-chat "someone has
   old version" line is the tester's hypothesis, not evidence. Real candidate destroys
   on current-vintage builds (each verified to note-destroy → `'discarded'`): AAD
   reject non-stale (`productionRuntime.ts:8936`), group-key/epoch desync →
   **tamper-final** (`:9217`, B-262 family — the recoverable key-divergence tamper
   STASHES and acks `'delivered'` instead), non-member drop (W11), reaction membership
   drop (B-128), and `handledOk === false` unrecoverable throws. **NOT a candidate:
   the blocked-peer drop** — verified (critic round 2, `applyGroupText.ts:127-132`,
   same in `applyDirectText.ts:78-83`): it suppresses the render only and acks
   `'delivered'` BY DESIGN, so a blocked sender cannot detect the block. ⚠️ Never make
   that gate note-destroy (e.g. to build a repro) — the undeliverable signal would
   become a block-detection oracle, a privacy regression against a deliberately built
   property. **The fix does not depend on which candidate fired**: the bug is that ANY
   one leg's destroy reds a message the other members hold.
2. That device acks **`disposition:'discarded'`** (`ackDisposition.ts:25-27`,
   consumed at `productionRuntime.ts:~7709`).
3. The relay emits **`envelope.undeliverable`** for that leg
   (`apps/messenger-service/src/relay/envelope.service.ts:~468-476`; handled at
   `productionRuntime.ts:7202-7206`), and the 60s HTTP receipt poll maps a `'discarded'`
   verdict the same way (`httpReceiptReconcile.ts:106-121`).
4. **`applyEnvelopeUndeliverable` flips the WHOLE bubble on ANY leg match**
   (`decryptFailureSignal.ts:170-186`): `sent`/`delivered` → `'undelivered'`. The
   off-ladder status rule (`messengerStore.ts:554-598`) deliberately allows this write.
5. `messageTicks.ts` maps `'undelivered'` → tick `'failed'`; `tickIcon.ts:31` renders
   the red alert; `ChatScreen.tsx:3557-3572` shows **"Tap to retry"** (identically for
   `'failed'` and `'undelivered'` — the chip does not discriminate, which is why the
   C5 table above matters).

**And the state is sticky:** once the bubble left `'sent'`,
`envelopeDelivered.ts:51` (`if (msg.status !== 'sent') {return 0;}`) **drops every
subsequent delivered receipt from every other member** — the per-leg receipt is not even
recorded. The only escapes are an all-members read aggregate or the user tapping retry.

### 2.3 Why the code is this way (it was deliberate — and its justification has rotted)

- **B-143** (sqa.md `:8096-8113`) made the any-leg match deliberate: _"any leg destroyed
  ⇒ undelivered … a pessimistic display, chosen because the alternative — the status
  quo — is a SILENT loss."_ The per-leg partial-delivery model was recorded as the open
  question, at the function (`decryptFailureSignal.ts:156-168` — which itself calls the
  current rule "HALF a policy"). **This fix is that recorded open item, not a revert.**
- The comment justifies the pessimism as **symmetric** with the delivered handler's
  "any leg delivered ⇒ advance". **That symmetry claim is now stale:** since **B-187**,
  the delivered side flips the scalar only when **every** shipped leg has
  delivered|read (`messengerStore.ts:1218-1236` required-set rule;
  `envelopeDelivered.ts:15-21`). Delivered is all-legs; undeliverable stayed any-leg.
- Two aggravators make the pessimistic display worse than designed:
  - **Sticky:** the receipt drop at `envelopeDelivered.ts:51` means the pessimistic flip
    can never be contradicted by later evidence.
  - **The retry chip is a placebo for groups:** a group retry re-runs the whole fan-out
    under the SAME `clientMsgId` (`productionRuntime.ts:3524`; the B-122 fresh-wire-id
    logic at `:4184-4206` is 1:1-only). The critic verified the relay's dedup memo is a
    separate Redis key with its own TTL surviving the envelope's ack/delete
    (`envelope.store.ts:268-290`, `:685-687`) — a same-id retry gets the original
    accept back and delivers nothing to anyone. The auto-resend path refused groups
    entirely (`undeliverableResend.ts:107-111`) — reversed by §3b (2026-08-28) for
    map-bearing rows.

### 2.4 Fix — partial-delivery-lite (finish B-143's recorded open question)

Founder direction (this session's report) overrides the pessimistic-display trade for
the partial case: a message most members received must not display as unsent.

**F1 — per-leg failure record + all-legs flip predicate.**

- `LocalMessage` gains optional **`undeliverable_legs?: Record<UserId, number>`**
  (userId → first-noted ts) — additive, the `receipts` pattern (types.ts:28-37).
- New store action **`recordUndeliverableLeg(convId, msgId, userId, ts)`** mirroring
  `recordDeliveredReceipt` (`messengerStore.ts:1200-1240`):
  - **Idempotent at value level:** leg already recorded → return WITHOUT
    `set()`/`flushBackupDirty` (the 60s poll re-fires verdicts; a fresh ts each time
    would re-mirror the row every minute — the B-634/I1 backup-churn class).
  - Records the leg, then flips the scalar `sent`/`delivered` → `'undelivered'` only
    under the **completeness-guarded predicate**: participants (excl. own,
    `:1219-1221`) non-empty AND **every participant has a shipped leg in
    `envelope_ids`** AND every one has an undeliverable record AND none has a
    delivered/read receipt. The shipped-coverage clause guards the deferred-leg race
    (edge BLOCKER 1): failed send legs park durable outbox rows whose envelope ids are
    stamped only at drain (`:3851-3886`, `:9910-9915`), possibly hours later — a
    "participants ∩ shipped" required-set would flip while a parked leg still owes a
    delivery, and a wrong red is sticky where a premature ✓✓ self-heals.
  - Empty-required / all-recipients-removed ⇒ **never flip via legs** (an audience-less
    message must not go red on an ex-member's late destroy).
- `applyEnvelopeUndeliverable` discriminates on **map presence, not match pattern**
  (edge BLOCKER 2): rows WITH `envelope_ids` take the leg path — and an envelopeId
  matching only the stale scalar while absent from the map is **ignored**. Rows WITHOUT
  a map (1:1 + legacy) keep today's immediate flip, byte-identical 1:1 semantics.
  (Writer completeness per critic C10: `envelope_ids` writers are group-only —
  fan-out `:4048`, drain `:9911-9913` gated on `legIsGroup`; the FIVE scalar writers
  incl. `productionRuntime.ts:1227` and `:7406` never write the map.)
- **Why `envelopeDelivered.ts:51` stays untouched (critic C8):** post-F1, a flip
  implies every shipped leg was terminally destroyed, and delivered-then-discarded for
  one envelope is impossible server-side (one ack consumes the envelope,
  `envelope.service.ts:424-460`) — no contradicting delivered can arrive after a
  correct flip, so recovery-off-`'undelivered'` machinery would guard nothing.
  The delivered handler's own unmapped-scalar branch (`envelopeDelivered.ts:57-63`)
  is left asymmetric deliberately: it is unreachable for retried rows once F2 clears
  the scalar, and touching the delivered lane is not needed to fix this bug.
- Resulting properties: the new predicate flips a **strict subset** of today's cases;
  a 2-member group still flips on its one recipient's destroy; a 5-member group with 1
  dead leg stays `'sent'`, receipts keep flowing, ✓✓ still requires all legs; cross-leg
  batch ordering becomes order-independent.
- **Documented residues (accepted, same class):**
  1. _Deferred-drain corner:_ every shipped leg destroyed + a deferred leg's drain
     later exhausts `MAX_ATTEMPTS` (row deleted, leg never stamped) → bubble stays
     `'sent'` — an under-report in a rare double-failure corner, traded for killing the
     common sticky false-red.
  2. _Roster growth (critic C6):_ the predicate reads the roster at verdict time; a
     member **added after send** has no shipped leg, so an all-legs-dead message with a
     post-send joiner stays `'sent'`. Freezing the required set at send time would need
     new persisted state for a rare corner; documented instead, at the function.

**F2 — make the group retry real (extend B-122 to the group lane) — respecified after
critic C2.**
Under F1 the group chip only appears when **no member** got the message, so a
fresh-wire-id retry cannot duplicate on anyone — the B-122 trade that blocked this
before is dissolved by F1. Mirror the 1:1 fresh-id block (`:4184-4206`) in the group
branch — `opts.existingMsgId` + prior wire acceptance (scalar `envelope_id` OR non-empty
`envelope_ids`) ⇒ mint a fresh wire `clientMsgId` — with a **complete, atomic
wire-artifact reset** before the fan-out:

- clear scalar `envelope_id` AND scalar `retract_token` AND the `envelope_ids` map AND
  the `retract_tokens` map AND `undeliverable_legs`, in one store action.
  **Why full reset, not "maps overwrite":** `retract_tokens`/`retract_token` are
  **first-wins** (`messengerStore.ts:1283-1285`) — without the clear, round-2 envelope
  ids pair with round-1 dead tokens, the receipt poll's probes come back `'unknown'`
  forever (`httpReceiptReconcile.ts:59-65`, `:115-116`), and since groups have no WS
  delivered path (`productionRuntime.ts:9878-9884`, OM-03) the retried message could
  never leave single-tick. The clear also closes the stale-scalar window: a late
  round-1 `'discarded'` matches nothing at all (cleared), rather than depending on the
  map-presence rule; and a mapless-row probe of the dead scalar cannot happen because
  the scalar is gone and the row is `'sending'` (probes select `'sent'` only).
  `receipts` are provably empty for every required member on this path (the flip
  predicate requires it) and are left alone.
- **`sqlOutbox.deleteByClientMsgId(old)`** (the 1:1 precedent `:4201-4204`;
  `sqlOutboxStore.ts:271-284` documents the duplicate hazard) — without the purge,
  deferred rows drain under the OLD id alongside the new fan-out and recipients get two
  copies under different clientMsgIds no dedup can join. The group branch's existing
  same-id `resetFailed` block (`:3925-3932`) must be bypassed when the fresh-id path
  runs — reconciled, not left to double-ship.
- **Recorded verdict on wire identity (critic C3 — BS-REACT-AUTHOR / MESSAGE_LOOP W14):**
  the fresh wire id means recipients key the retried message under the NEW id while the
  author's bubble keeps the old id — a reaction/reply from a member then misses the
  author's own bubble, exactly the defect BS-REACT-AUTHOR fixed. **Decision: ACCEPT and
  document, mirroring the recorded 1:1 B-122 trade.** Bounded justification: this lane
  fires only for the all-legs-dead population (nobody holds the message; the
  alternative is a message that reaches no one), the same trade the 1:1 lane has carried
  since B-122, and reaction-miss on one retried bubble is strictly less wrong than
  permanent non-delivery. Re-keying the author's bubble to the fresh id was considered
  and rejected: it rewrites a persisted PK mid-flight (delete+insert inside the send
  path) for a rare lane — risk out of proportion. The verdict is recorded at the code
  site AND as a note against W14's wire-identity row in MESSAGE_LOOP.md so the next
  session sees a decision, not drift. The §5 sweep for this item must **enumerate the
  sites that resolve reactions/replies by `clientMsgId`**, so the accepted degradation
  is a named list, not a vibe. Implementation note: round-2 outbox rows carry the
  **fresh wire `clientMsgId` with the original `messageId`** — the 1:1 B-122 lane
  already exercises that divergence, so the outbox schema supports it.

**F3 — receipt-poll hygiene.** `selectReceiptProbes` gains an undeliverable-leg skip
mirroring its delivered/read skip (`httpReceiptReconcile.ts:63-64`): a terminally
destroyed leg stops being re-probed every 60s (it burns `MAX_PROBES=100` slots and
re-fires the handler forever; F1's idempotency makes the re-fire harmless, F3 makes it
stop).

**F4 — the MSG-07 boot sweep must honor acceptance artifacts (closes the C5 sibling).**
`productionRuntime.ts:2341-2360` flips a hydrated `'sending'` bubble with no retriable
outbox row to `'failed'`. When the row carries acceptance evidence, the relay provably
accepted the send — flip to **`'sent'`** instead of `'failed'` (receipts/undeliverable
signals then converge it honestly). No artifacts → `'failed'` as today.
**Acceptance evidence = scalar `envelope_id` OR `envelope_ids` OR scalar
`retract_token` OR `retract_tokens`** (critic R2-2): every lane writes the retract
token BEFORE the envelope id (group `:4037-4044` → `:4045-4049`; 1:1 HTTP `:4405` →
`:4411`; the WS lane flips `'sent'` before stamping so the sweep never sees it), so the
reachable kill-window residue is token-present/id-absent — an id-only predicate would
re-create a narrower edition of the very bug F4 fixes. A token can only come from a
relay accept, so it is the same evidence class; a token-only row cannot be poll-probed
(no id) and converges via drain/dedup — still strictly better than a false red.
**Documented transient (1:1 only):** `'undelivered'` → tap retry → kill before the new
enqueue: the 1:1 B-122 block purges outbox rows but leaves round-1 scalars
(`:4194-4205`), so F4 hydrates `'sent'` for ~60s until the poll returns the settled
round-1 `'discarded'` and honestly re-flips — accepted (the group lane has no such
transient: F2's full reset precedes the fan-out, and a kill after reset hydrates an
artifact-free `'sending'` row that F4 honestly fails — **F2 and F4 compose**).

**Persistence — three layers, one hands-off:**

- **SQLCipher:** new `undeliverable_legs_json` column + `SCHEMA_VERSION` 20→21
  (`db.ts:95`, ALTER pattern `:249-259`); write at `sqlMessageStore.ts:206-223` and the
  row→`LocalMessage` **read-back mapping** in the same file (critic C11b) — fields
  persist only via explicit columns.
- **Backup wire:** add to `backupWireV3.ts:121-145` serialize + `restoreMessages.ts:647-668`,
  using the documented hash-safe absent-field pattern.
- **Do NOT touch `messageMirror.ts` `serializeMessage`/versionHash (`:1110-1136`)** —
  widening the hash invalidates every ledger version = the B-94/I1 mass re-upload.
  `status` IS hashed, so the scalar flip ships; leg-only changes ride `flushBackupDirty`
  exactly as `receipts` do.

**Not in scope (documented, deliberate):**

- The `SEALED_PAYLOAD_KEYS` forward-compat rigidity is real but was NOT this incident's
  trigger (C1); loosening it is a sealed-envelope shape change = CLAUDE.md security
  stop-condition — escalated, untouched.
- A per-member "delivered to N of M" UI — display follow-up.
- `sendMedia`'s unconditional catch→`'failed'` (`:4715-4736`) — related finding only.
- ~~The group **auto**-resend refusal (`undeliverableResend.ts:107-111`) **stays** — the
  group retry lane is the manual chip only.~~ **REVERSED by §3b (2026-08-28, founder
  direction):** map-bearing group rows get ONE bounded automatic attempt via the F2
  lane; MAPLESS legacy rows remain manual-chip-only (critic D1 — duplicate hazard).

**Pins to re-anchor (never delete) — seed-verified:**

| Suite (project)                                   | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envelopeLegParity.test.ts` (crypto)              | `:78` first-leg destroy flips → becomes leg-recorded/NO flip (two-leg seed); `:92` second-leg → no-flip; `:98` delivered downgraded by one leg → stays delivered; `:104` order-independence kept, new expected state; ADD both-legs-dead → flips. `:117` (read wins) and `:125` (unknown id) survive. **Seeding trap: `seedTwoLegs` (`:58-65`) creates no conversation row — the new predicate reads `conversations[id].participants`, so re-anchored cases MUST seed a real group conv or they pass vacuously.** Fix the stale "matches the scalar ONLY" header while here (C11d). |
| `messageStatusMonotonic.test.ts` (crypto)         | `:111` — survives only if scalar-seeded; verify, else re-anchor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `httpReceiptReconcile.test.ts` (crypto)           | `:158-166` scalar 'discarded' flip survives; ADD group-leg cases (probe skip, idempotency).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `decryptFailureSignal.test.ts` (crypto)           | `:127-154` scalar rows — survive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `messageTicks` / `conversationListTicks` (crypto) | undelivered→failed tick — unaffected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `groupTickFirstLegWins.test.ts` (crypto)          | `:130-166` probe pins consistent; extend for the new skip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `receiptRestoreFidelity.test.ts` (crypto)         | `:82-100` extend for the new wire field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `undeliverableResend.test.ts` (crypto)            | group-refusal pin — RE-ANCHORED by 3b (2026-08-28): map-bearing groups resend once; mapless legacy rows keep the skip (legacy-no-legs, critic D1).                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ChatScreen chip (app)                             | pinned only via app-project messenger screen tests — the crypto project cannot mount it (C11c).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Housekeeping:** rewrite the `decryptFailureSignal.ts:156-168` half-policy comment —
its "do not paper over it here" is lawfully superseded by the recorded open item it
pointed at; keep the B-46 note. Log **B-682/B-683 in sqa.md** (summary table +
numbering — C11a).

### 2.5 Edge cases — verdicts (edge-case agent + critic, all code-verified)

| #   | Case                                                                                  | Verdict                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Undeliverable during fan-out / deferred legs unshipped                                | **BLOCKER — handled by the shipped-coverage clause in F1.** Live window narrow (ids stamped in one burst post-`allSettled`, `:4045-4049`); deferred window hours.                  |
| 2   | Stale scalar envelope_id after a fresh-id retry                                       | **BLOCKER — handled by F2's full atomic reset** (stronger than the earlier map-presence-only defense).                                                                             |
| 3   | Old outbox rows + stale leg records + first-wins tokens on retry                      | **BLOCKER — handled by F2** (purge + full artifact clear; tokens are first-wins `:1283-1285`, they can NOT self-heal by overwrite).                                                |
| 4   | 60s poll re-fires; backup byte-churn; probe-slot burn                                 | **MAJOR — handled by F1 idempotency + F3 probe skip.** After an all-dead flip the row leaves the probe set with every leg terminally settled.                                      |
| 5   | Persistence: SQL column + read-back, backup wire, versionHash                         | **MAJOR — handled as specified** (column+v21 both directions; wire add; mirror hash untouched).                                                                                    |
| 6   | Pin re-anchoring + the no-conversation-row seeding trap                               | **MAJOR — table above.**                                                                                                                                                           |
| 7   | delivered-then-discarded for one leg                                                  | **Impossible server-side** — one ack consumes the envelope (`envelope.service.ts:424-460`). Cross-leg mixed batches: order preserved; new predicate order-independent either way.  |
| 8   | Member removed after send / all recipients removed / **member ADDED after send (C6)** | Removed: neither blocks nor triggers. Empty required: never flip via legs. Added: documented residue 2 in F1 — stays `'sent'`; roster-at-verdict-time semantics stated explicitly. |
| 9   | 2-member group true failure                                                           | Handled — flips, chip shows, F2 makes the retry real.                                                                                                                              |
| 10  | 1:1 rows with envelope_ids                                                            | Cannot exist (all five scalar writers incl. `:1227` verified map-free; map writers group-only) — map presence is a safe discriminator.                                             |
| 11  | Live WS undeliverable racing the id stamp                                             | Matches nothing, returns 0; recovered by the next poll. Unchanged — do NOT "fix" by matching clientMsgId.                                                                          |
| 12  | Restored rows (pre-extension backups strip the new field)                             | Rows <7d re-converge via the poll (`httpReceiptReconcile.ts:55` window); older partial records lost → stays `'sent'` — same acceptance as grandfathered token-less rows.           |
| 13  | App restart between accept and `'sent'` flip (C5)                                     | **Was a live false-red writer — closed by F4** (acceptance artifacts → `'sent'`).                                                                                                  |

### 2.6 Verification (MESSAGE_LOOP.md governs)

- §5 caller-completeness for `applyEnvelopeUndeliverable` (call sites:
  `productionRuntime.ts:7202`, `httpReceiptReconcile.ts:112`), the new store actions,
  the group-branch retry edit, and the MSG-07 sweep edit.
- New tests RED-first; mutation-prove the flip predicate (revert to any-leg → red), the
  idempotency guard, the F2 reset (drop the token clear → red), and the F4 artifact
  check.
- Gates: invariant suites → `test:crypto` **twice** (B-126 flake rule) → app-project
  messenger screen tests → typecheck ≤ 47 → lint. The SQL schema bump additionally
  re-runs `sqlMessageStoreEngine` (real-engine DDL).
- **Device verification (rewritten twice — first the "old APK" repro fell to C1, then
  the blocked-peer repro fell to R2-1):** the blocked-peer gate acks `'delivered'` BY
  DESIGN (`applyGroupText.ts:127-132` — a blocked sender must not detect the block), so
  blocking CANNOT stage the chain, and every verified `'discarded'` producer on stock
  builds (AAD reject, tamper-final, non-member, reaction-membership) requires
  corrupting state to stage. Applying §3.4 (verify the staged trigger's disposition in
  source BEFORE writing the repro), the honest split is:
  1. **Device golden-path regression (this session, mandatory):** group send/receive on
     real devices — ticks advance, no red chip on healthy sends, retry chip absent.
  2. **Forced-destroy E2E (recorded as an OPEN ITEM, not silently skipped):** the full
     destroy→partial-keep→all-dead→retry loop needs a dev-build hook that forces a
     destroyed-note on the next group text. That hook touches the receive lane
     (security-sensitive, MESSAGE_LOOP territory), so it is its own one-commit item
     with founder sign-off — NOT smuggled into this fix. Until it exists, the
     F1/F2/F3/F4 logic is pinned by the unit suites (all node-testable modules), and
     the production-trigger hunt (which candidate destroy fired on the founder's
     device) stays open.
     ⚠️ Never make the blocked-peer gate note-destroy to enable a repro — block-detection
     oracle (see §2.2).

---

## 3. Mitigation beyond the two fixes (prevention)

1. **Percentage-height contract rule:** a `height:'100%'` is a dependency on the
   parent's definite height. Any fixed-height → `minHeight` conversion must grep its
   children for percentage heights first. The §1.5 sweep is the one-time payment; the
   source-scan pin holds the four converted/latent sites.
2. **Layout changes are device-gated, not jest-gated.** B-680's own record deferred the
   device sweep; B-682 is the cost — and §1.6 makes the device pass a gate for its own
   fix, not an IOU.
3. **"Deliberate pessimism" needs an expiry check.** B-143's any-leg rule was justified
   by a symmetry that B-187 later removed. When a comment justifies behaviour by
   pointing at sibling code, a change to the sibling must re-visit the comment.
4. **Date both sides before naming a culprit build (the C1 lesson).** A
   mechanism-that-fits is not a diagnosis until the feature timeline proves the actor
   could exist. Three `git log -S` commands falsified a story two mapping passes had
   accepted; cite shipped-build source when the actor is an old build.

---

## 3b. Addendum 2026-08-28 — WhatsApp-parity follow-up (founder: "do the same as WhatsApp")

WhatsApp avoids this bug class four ways; status per lane after this addendum:

| WhatsApp mechanism                                                            | Bravo status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sender ticks only move forward (accepted ⇒ never "failed")                    | **DONE** in the base fix (all-legs rule + F4 acceptance artifacts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Silent bounded auto-retry when a device destroys a message                    | **1:1 existed (B-46); GROUPS ADDED here — map-bearing rows only.** The historic group refusal's recorded reason ("cannot attribute the failing member") was retired by `undeliverable_legs`; under the all-legs rule a map-bearing group `'undelivered'` row is one NOBODY holds, so one automatic attempt cannot duplicate. Execution rides the manual chip's F2 lane verbatim (`sendText` + `existingMsgId` ⇒ fresh wire id + atomic reset + purge). Selector also matches per-leg ids (the B-143 scalar-only-match lesson resurfaced here, fixed pre-ship). **Critic D1:** a MAPLESS legacy row (pre-B-187 / pre-v19 restore) is flipped by the scalar path on a SINGLE leg's destroy — other members may HOLD it — so mapless rows skip (`legacy-no-legs`) and stay manual-chip-only. **This deliberately reverses the §2.4 "auto-resend refusal stays" scope line — founder-directed; pin re-anchored, never deleted.** Inherited wrinkle (named, not chosen here): like the manual chip, the group lane recomputes a disappearing message's TTL from the original window, extending the on-receiver deadline by the elapsed time; the 1:1 auto lane carries the absolute deadline. |
| Receiver-side failure display ("Waiting for this message" / placeholder rows) | **Already covered** — `insertDecryptFailurePlaceholder` at every terminal-destroy site with a known thread (AAD reject, tamper-final, recovery give-up), deduped, mirror/Merkle-consistent, B-262 reconcile-on-recovery; blocked-peer and non-member exclusions deliberate. Known limitation (accepted): a placeholder cannot be auto-replaced by the RESENT copy — the resend carries a new envelope id with no wire linkage, and adding linkage is a sealed-envelope shape change (stop-condition).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Per-member "Message info" (delivered/read per member)                         | **Existed (B-116); "Not delivered" ADDED here** — the info sheet renders `Not delivered <time>` + alert icon from `undeliverable_legs` when a member's device destroyed its copy and no receipt exists (a receipt always wins, `!r` guard). Pinned by `messageInfoUndeliverable.test.ts` (app).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Pins for this addendum (mutation-proved): `undeliverableResend` re-anchored + 6 new cases
(group-skip mutant → 3 red; the D1 mapless case RED-first); `groupRetryFreshWire` +
the resend-group-rides-F2 scan (flip-before-send ordering, inside the closure);
`messageInfoUndeliverable` (app source scan). The B-683-E2E open item is unchanged.

## 4. Reasoning trail (for the critic — including the round-1 corrections)

1. Started from the two screenshots; pulled main first (per instruction) — the pull
   landed `a66f1310`/B-680, which turned out to be B-682's cause.
2. Two independent code-mapping passes (news layout; messenger send status) with
   file:line evidence; load-bearing claims re-verified first-hand
   (`IntelFeedScreen.tsx:950-951`, `decryptFailureSignal.ts:170-186`,
   `envelopeDelivered.ts:42-67`, `messengerStore.ts:1200-1240`).
3. B-682: competing hypotheses ruled out with evidence; the surviving mechanism explains
   all four screenshot artifacts. **Round-1 correction (C4):** the Yoga resolution mode
   itself is abductive, not source-verified — the doc now says so, and the device pass
   became a gate.
4. B-683: "send path marks failed on partial fan-out" falsified by code; the
   receiver-driven chain replaced it. **Round-1 correction (C1):** the "old version
   destroys `replyTo`" trigger was accepted from a single source (the in-chat line + a
   matching mechanism) without dating either side; the critic's git archaeology
   falsified it. The trigger is now recorded as undetermined-with-candidates, the
   'failed'-writer elimination table was added (surfacing the MSG-07 boot sweep as a
   second live writer, now fixed as F4), and the device repro was rewritten.
5. Fix design mirrors the shipped delivered-side aggregate rather than inventing a
   model. The edge-case pass hardened it (shipped-coverage clause, map-presence rule,
   idempotency, persistence plan); the critic pass then forced the F2 respecification
   (first-wins tokens → full atomic reset), the recorded C3 wire-identity verdict, and
   the honest epistemic labels.
