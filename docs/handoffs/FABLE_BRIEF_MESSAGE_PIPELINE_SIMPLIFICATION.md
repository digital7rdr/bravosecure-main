# Brief for Fable — Message Pipeline Simplification

**Status:** input packet. This document is _evidence_, not a plan.
**Produced:** 2026-07-21, from a 16-agent read-only audit of HEAD `cea64f8` (branch `fix/b121-b123-ios-group-video`).
**Nothing in the codebase was changed to produce this.**

---

## 1. Read this first

The messenger works. The problem is that **fixing one message bug reliably creates another**, and the reason is
measurable, not vague:

1. One file — `src/modules/messenger/runtime/productionRuntime.ts`, **8,031 lines** — contains the entire message
   pipeline as a handful of enormous functions.
2. **No test imports that file.** Not one. Two test files say so in comments: _"productionRuntime.ts is too heavy to
   import in jest"_. The tests that exist are hand-copied **mirrors** of the logic, and the copies have already drifted
   from the originals.
3. Because the file cannot be tested, every rule inside it got copied into a smaller module so it _could_ be tested.
   There are now **5 live implementations of "is this a group chat?"**, **19 copies of the encrypt→ship sequence**,
   **16 places that build a message row**, and **10 places that parse a `direct:` id**. They disagree.
4. So a change made in the _call_ subsystem silently changes _messaging_ behaviour, with a green test suite.
   That is not hypothetical — it happened on 2026-07-18 and produced a **CRITICAL data-loss bug 48 hours later**.

The runbook you are asked to write must make it possible to cut these giant functions into small ones **without a
single behaviour change**, in an order where each step is independently shippable and provable.

---

## 2. The task for you, Fable

Write a **step-by-step simplification runbook** as a markdown file at
`docs/runbooks/MESSAGE_LOOP.md`, modelled structurally on the existing `docs/runbooks/BACKUP_LOOP.md`
(194 lines, 9 numbered invariants, 8 of them pinned to a named test file — that document killed a bug class that had
shipped **five times**; it is the proven in-house template).

### The runbook must contain

1. **A numbered invariant table (M1…Mn)** — copy §7 of this brief, refine it. Every row: the rule in one sentence, the
   bug that proves it matters, where it is enforced today (`file:line`) or `NOT ENFORCED`, and the test that pins it or
   `NEEDS TEST`.
2. **An ordered list of cuts.** Each cut is one commit. For each cut, state:
   - exactly which lines move and where they move to,
   - the **characterization test that must exist and be green _before_ the cut**,
   - the verification command and its expected result,
   - the rollback (`git revert <sha>` must be sufficient — no cut may require a follow-up fix to be safe),
   - what "unchanged behaviour" means concretely for that cut.
3. **A stop-condition list** — situations where the implementer must halt and ask a human.
4. **A §0 trigger-file list** (the files that make this runbook mandatory reading) and a routing snippet to paste into
   `CLAUDE.md`, matching how `BACKUP_LOOP.md` is routed today.
5. **A sign-off section** — what must hold before a message change is called done.

### Hard constraints on what you write

- **CALLER COMPLETENESS — the rule that makes or breaks this whole programme.**
  When one function becomes several, **every existing caller must end up invoking all of the new
  pieces that apply to it.** A caller that used to get five behaviours from one call and now gets
  three is a silent, invisible regression — nothing fails to compile and no test goes red.
  Therefore **every cut step in the runbook MUST include, as a mandatory sub-step:**
  1. **Enumerate the callers first** — `grep -rn "<symbol>(" src packages --include=*.ts --include=*.tsx`,
     plus the graph (`query_graph` pattern `callers_of`). Write the list into the step. This repo hides
     callers well: `appendMessage` has **18** non-test call sites across 8 files; `sendText` has 8;
     `productionRuntime.ts` loads siblings via lazy `require()` inside function bodies, so a
     top-of-file import scan **misses them**.
  2. **For each caller, state which new functions it must now call, and in what order.** If a caller
     needs only a subset, say so explicitly and say why — an unstated subset is how a behaviour gets
     dropped.
  3. **Do not leave the old function as a silent pass-through wrapper.** Either every caller is
     migrated in the same commit, or the old name keeps its exact old behaviour by composing the new
     pieces. Half-migrated is the dangerous state.
  4. **Watch the return value.** `appendMessage` can _rewrite_ the message id (`messengerStore.ts:539-545`)
     and returns `void`; any split must return the **effective** id or downstream
     `updateMessageStatus` calls silently no-op (invariant M12).
  5. **Behaviour changes to a SHARED function reach every caller, not just the one you are fixing.**
     Changing `messagingLogic.isGroupConversation` also changes reactions, the reaction wire-stamp and
     read-receipt acceptance. The runbook must require each inherited caller to be checked and the
     verdict recorded — _fixes it / no change / regresses it_ — before the commit lands.
  6. **Verify mechanically, not by reading.** After the cut, re-run the caller grep and diff it against
     the list from sub-step 1.
- **One seam per commit.** Never two. A commit that moves code must not also change behaviour.
- **Tests before moves.** A cut with no characterization test is not permitted; say so and order the test first.
- **No big-bang rewrite.** Do not propose rewriting `productionRuntime.ts`. Propose extractions in an order where the
  file shrinks and every intermediate state ships.
- **Do not touch crypto primitives** — no changes to algorithms, key lengths, IV/nonce handling, sealed-sender envelope
  shape, sender-cert verification, AAD binding, group master-key distribution, or the file-vault MFA gate.
  `CLAUDE.md` declares these architecture-gated. Extraction that _moves_ such code without altering it is fine;
  changing what it checks is not.
- **Do not change on-the-wire shapes or the SQL schema** in any cut. Both are cross-device contracts;
  `PRIMARY KEY (conversation_id, id)` is the only thing preventing duplicate messages (see §7 M8).
- **Never weaken an existing check** to make a refactor easier (`verifySenderCert`, `verifySealedAad`, the membership
  gate, the blocked-peer gate, the epoch guard). If a check is in the way, stop and say so.
- **No "while I'm here" cleanups.** No renames, no lint fixes, no comment rewrites inside a moving block.
- **Cite function names before line numbers.** `productionRuntime.ts` moved ~170 lines in 10 days; `sqa.md` entries
  written on 2026-07-11 already point at the wrong lines. Anchor on symbols.
- **Do not propose code in the runbook.** Describe the cut; the implementer writes it.

---

## 3. Repo orientation

| Thing           | Value                                                         |
| --------------- | ------------------------------------------------------------- |
| Repo root       | `C:\Users\User\OneDrive\Documents\brave_secure\Bravo_Secure`  |
| Mobile app      | `src/` (React Native 0.81 + Expo SDK 54, TypeScript, Zustand) |
| Message runtime | `src/modules/messenger/runtime/`                              |
| Message store   | `src/modules/messenger/store/`                                |
| Shared crypto   | `packages/messenger-core/src/`                                |
| Backend relay   | `apps/messenger-service/src/`                                 |
| Bug log         | `sqa.md` (repo root, 5,793 lines, 119 bug IDs `B-01`…`B-125`) |
| Proven template | `docs/runbooks/BACKUP_LOOP.md`                                |

### Verification commands

```
npm run test:crypto                 # messenger-crypto project — the fastest real signal (~1,787 tests)
npx jest --selectProjects app       # ~284 tests
npm run typecheck                   # must NOT exceed .tsc-baseline.json = 47 errors
npm test                            # everything (slow)
```

### The good pattern already exists in-house — reuse it, do not invent one

`src/modules/messenger/runtime/` already holds **~29 sibling modules**, nearly all **≤425 lines**, and **26 of 30 are
covered by tests**. Named examples to imitate: `messagingLogic.ts` (148 lines, pure, no React/store imports — that
constraint is _what makes it testable and must survive any consolidation_), `groupConversationUpsert.ts`,
`undeliverableResend.ts`, `envelopeDelivered.ts`, `decryptFailureSignal.ts`, `outboxCertFreshness.ts`,
`transportRegistry.ts`, `receiveTransaction.ts`.

**The extraction target is not a new architecture. It is: move decisions out of the god-file into siblings of these.**

### Known traps for anyone working here

| Trap                                | Detail                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Graph line drift                    | The `code-review-graph` MCP reports line numbers **30–96 lines off** on this file despite an auto-update hook. On Windows it stores backslash paths, so a `file_path_pattern` filter silently returns zero hits and looks like "not indexed". **Verify with grep before acting on a graph line number.**                                                                                                     |
| Pre-push selects zero tests         | `.husky/pre-push` runs `jest --changedSince=origin/main --passWithNoTests`. Because **no test imports `productionRuntime.ts`**, a diff to it selects **zero tests** and pushes clean. This is the literal hole the B-106 fix went through.                                                                                                                                                                   |
| CI is dead                          | GitHub Actions has been failing on **account billing** since ~2026-07-10 (12 workflows down, incl. `flake-watch` and `mutation`). The CI `TypeScript` job also runs bare `tsc --noEmit` against 47 known errors, so it can never pass — yet it is a _required_ check. **0 of the last 100 commits went through a PR.**                                                                                       |
| Backend is unlinted                 | `.eslintignore` excludes `apps/` entirely.                                                                                                                                                                                                                                                                                                                                                                   |
| Two tsc baselines                   | `.tsc-baseline.json` = 47 (read by pre-push); `.tsc-baseline` = 100 (read by `scripts/release-apk.ps1:141`). The release gate is 53 errors looser than the push gate.                                                                                                                                                                                                                                        |
| Two files named `messengerStore.ts` | `src/store/messengerStore.ts` (120 lines, **dead**, Twilio-era) and `src/modules/messenger/store/messengerStore.ts` (**the real one**, 1,517 lines). Its only consumer chain (`src/hooks/useRealtimeMessages.ts`) is also dead. A grep-driven refactor will hit the wrong file.                                                                                                                              |
| A second runtime exists             | `src/modules/messenger/runtime/runtime.ts` (923 lines) is a **full second implementation** — its own `sendText` at `:585`, its own `appendMessage` calls at `:794/:863/:890/:900`. It is reachable from production code (`useGroupCall.ts:179`, `LinksScreen.tsx:29`, `useAttachmentUri.ts:25`). Every "one true implementation" extraction must decide whether `runtime.ts` adopts it or forks permanently. |

---

## 4. The bug-factory leaderboard

Distinct fix commits measured with `git log -L <start>,<end>:<file>` at HEAD `cea64f8`. Every range confirmed by
Read/grep, not by the graph.

| #   | Function                 | Location                         | Lines     | Params | Fix commits | Tests                                            |
| --- | ------------------------ | -------------------------------- | --------- | ------ | ----------- | ------------------------------------------------ |
| 1   | `buildProductionRuntime` | `productionRuntime.ts:397-4660`  | **4,264** | 1      | **68**      | **NONE**                                         |
| 2   | `doHandleIncoming`       | `productionRuntime.ts:6298-7321` | **1,024** | **13** | **41**      | **NONE** (5 mirror tests)                        |
| 3   | `ChatScreenInner`        | `ChatScreen.tsx:181-1846`        | **1,666** | –      | **33**      | **NONE**                                         |
| 4   | `sendText`               | `productionRuntime.ts:2295-3050` | **756**   | 3      | **29**      | **NONE** (a _divergent copy_ is tested)          |
| 5   | `handleServerFrame`      | `productionRuntime.ts:5044-5294` | 251       | 2      | 22          | NONE                                             |
| 6   | `handleDeliverInner`     | `productionRuntime.ts:5372-5704` | 333       | 2      | 22          | NONE                                             |
| 7   | `drainRelay`             | `productionRuntime.ts:7531-7907` | 377       | **13** | 21          | NONE                                             |
| 8   | `MessageBubbleImpl`      | `ChatScreen.tsx:1936-2450`       | 515       | –      | 18          | NONE                                             |
| 9   | `appendMessage`          | `messengerStore.ts:516-728`      | 213       | 2      | 13          | **8 files** (the only well-covered hot function) |
| 10  | `handleIncoming`         | `productionRuntime.ts:5849-5968` | 120       | **14** | 12          | NONE                                             |
| 11  | `addGroupMember`         | `productionRuntime.ts:4074-4316` | 243       | –      | 9           | –                                                |
| 12  | `ensureCallGroupKey`     | `productionRuntime.ts:4317-4487` | 171       | 1      | 8           | mirror-only                                      |
| 13  | `drainOutbox`            | `productionRuntime.ts:7394-7529` | 136       | –      | 5           | store-only                                       |
| 14  | **`isGroup` predicate**  | `productionRuntime.ts:2351-2356` | **6**     | –      | 3           | tests a _different file_                         |

File totals: `productionRuntime.ts` **79 commits**, `ChatScreen.tsx` 40, `messengerStore.ts` 31, `messagingLogic.ts` 1.

**Note row 14.** Six lines, three commits in 15 months — and it is the named root cause of both B-124 (duplicate chat)
and B-125 (CRITICAL data loss). **Churn is not the only risk signal. Concentration of meaning is.**

### The regression chains — the evidence that this is systemic

| Chain                   | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 (marquee, 2 days)** | `b034b36` (2026-07-18, _"fix(calls): B-106 call-group chat-list leaks"_) added 10 lines to `ensureCallGroupKey` and 48 to `appendMessage`. It shipped with **7 new passing tests** and green gates. 2026-07-19: `IOSMSG-4` — a genuine group named `"Call"` deleted on every boot. 2026-07-20: **B-124** (duplicate chat thread) + **B-125** (CRITICAL, typed text destroyed on send). The _write_ landed in the call subsystem; the _break_ landed in `sendText`. Nothing failed, because no test imports `productionRuntime.ts`. |
| **2 (same day)**        | `3ae4790` (2026-07-11, B-72/73/74 fixes) made `saveIdentity` queue its own txn on the global chain → self-deadlock → inbound stops committing, backup mirrors a frozen snapshot **with a GREEN verify**. Logged as **B-75, CRITICAL P0**, fixed the same day by `2bdda3b`. `sqa.md:1050` names the gap: _"the new B-72 tests cover saveIdentity-inside-runWithRatchetTxn but NOT saveIdentity-inside-runOnTxnChain"_.                                                                                                              |
| **3**                   | `docs/audits/MESSENGER_AUDIT_2026-07-09.md:19` — _"The one P0 is a regression introduced by the 2026-07-06 M-14 fix"_: two independent mutexes on one SQLCipher connection → a receive `BEGIN IMMEDIATE` lands inside an open flush txn, throws, and is acked `discarded` = **silent message destruction**. Same class as B-75 five days later.                                                                                                                                                                                    |
| **4**                   | `BACKUP_LOOP.md:10` — the `root_mismatch` class shipped **five times** (B-45r3 → B-50 → B-67 → B-81 → B-94). Each fix patched the read side while the write side kept manufacturing drift. **Then the runbook was written and it stopped.**                                                                                                                                                                                                                                                                                        |
| **5 (open)**            | B-18/B-15 group render recurs across builds (`sqa.md:4175`, `:4196`, `:4329`). Patched at two different stages (`doHandleIncoming` and `ChatScreenInner`); neither closed it.                                                                                                                                                                                                                                                                                                                                                      |

---

## 5. Per-function dossiers

> **Line numbers are as measured at `cea64f8`.** Anchor on the symbol name first.

---

### 5.1 `doHandleIncoming` — `productionRuntime.ts:6298-7321` · 1,024 lines · 13 positional params

**Rank 2. The single read-side funnel. Module-level (not inside the factory), so its shared state is module-level
singletons plus the global Zustand store.**

**What it does, in order:**

1. `:6313` — logs peer prefix + envelope id
2. `:6322` — `own.decrypt` — Signal Double-Ratchet advance (writes the libsignal session row inside the call)
3. `:6327-6355` — decrypt-failure classification; evicts `peerIdentityCache` at `:6332`
4. `:6361-6363` — clears the global recovery banner on success
5. `:6368` — `rememberSuccessfulDecrypt` → module-level session-wipe-protection map
6. `:6371` — `clearFirstMsgRetryBudget` → module-level LRU
7. `:6378-6380` — `seenEnvelopes.markSeen` — **the dedupe write**
8. `:6386-6394` — `unsealPayload`; sealed-version reject → crashLog + rethrow
9. `:6399-6404` — `resolveExpectedSenderIdentity` — **can perform an HTTP keys-bundle fetch while holding the SQLite write lock**
10. `:6405-6409` — `verifySenderCert`
11. `:6448-6458` — `verifySealedAad` against a computed `expectedConversationId`
12. `:6584-6592` — **routing**: unconditionally adopts the sender's `group.groupId` if present, else resolves the direct slot
13. `:6601-6616` — group-stamped **reaction** lane (calls `applyReaction` and returns)
14. `:6624-6628` — group text: `parseGroupMessage` under the local master key
15. `:6700-6725` — group tamper: destroyed-envelope marker + decrypt-failure placeholder
16. `:6727-6771` — group **no_key**: durable stash → error banner → keyless placeholder row → post-txn key-request
17. `:6799-6819` — legacy/plaintext fall-through behind a membership gate
18. `:6850-7130` — **admin actions** (create / rekey / add / remove): signature verify, epoch monotonicity, G-04 same-epoch fork heal, MEDIUM-2 rollback guard via the superseded-key ledger, commit
19. `:7017-7024` — **the receiver-side `'Call'` key alias onto `direct:<owner>`**
20. `:7041-7046` — inbox-row suppression for `'Call'` groups (reads the **wire** name, so it works cross-device)
21. `:7210` / `:7278` — builds the LocalMessage (group / 1:1)
22. `:7253` / `:7315` — `store.appendMessage`, immediately followed by `sqlMessages.upsert` at `:7255` / `:7320`

**Hidden rules a refactorer will break:**

- **A bare `return` here means COMMIT.** The caller's txn commits the ratchet advance _and_ the `markSeen` row, and
  `handleDeliverInner`/`drainRelay` then **ack the envelope off the relay**. There are **20+ early returns**. Each one
  is a silent decision about whether a message is destroyed.
- `own.decrypt` (`:6322`) must be the first DB-touching statement; everything downstream assumes the ratchet already
  advanced inside the caller's `BEGIN IMMEDIATE`.
- `markSeen` (`:6378`) runs **before** cert verify (`:6405`) — deliberately, so a rejection rolls both back together.
  **But see M6 below: this has a live defect, and "fixing" the order would be a fix, not a break.**
- It returns a **`PostTxnRequest` discriminated union** rather than doing the work. Five variants. This is the _only_
  sanctioned way to reach the send stack from here; calling a send helper directly runs network I/O inside the write lock.
- `store.appendMessage` is **not a pure store write** — it can invent a conversation row (§5.3).
- **13 positional params, four of them nullable stores.** `handleIncoming` calls it twice: `:5908` with the full set
  inside a txn, and `:5914` with `null, null, null, null`. On the second path there is **no persistence, no dedup, no
  stash, no admin queue**. "It works in the loopback" is therefore not evidence about production.

**Cut seams, in safe order:**

| Seam            | Range                                                                                                          | Verdict                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| S1 authenticate | `:6386-6428` — unseal + resolve identity + `verifySenderCert` + claim/device checks → returns claims or throws | **SAFE**                                |
| S2 bind         | `:6448-6458` — expected-conversation-id computation + `verifySealedAad` → returns a verdict                    | **SAFE**                                |
| S3 route        | `:6584-6592` **only** — id selection                                                                           | **SAFE** — but see the correction below |
| S4 build        | the three LocalMessage builders (`:6182`, `:6820`, `:7210`) → one shared builder                               | **SAFE, high value**                    |
| S5 lanes        | group-text / group-admin / 1:1-text / reaction appliers, each owning its own writes                            | **medium** — do last                    |

> **VERIFIER CORRECTION (important).** The original audit proposed extracting the whole routing block `:6584-6624` as a
> _pure_ function. It is **not pure**: the reaction lane at `:6601-6616` calls `applyReaction` at `:6608` and `return`s,
> and runs a blocked-peer gate at `:6604` with a side-effecting return — extracting that range as a "decision function"
> silently drops those effects. The admin lane also consumes `claims` produced by `verifySenderCert` at `:6405`
> (used at `:6886`), so S1's output must carry cert claims across the boundary. **The genuinely pure slice is
> `:6584-6592` only.**

---

### 5.2 `sendText` — `productionRuntime.ts:2295-3050` · 756 lines · 3 params

**Rank 4. Not one function — two complete implementations bolted together: a group fan-out branch (`:2387-2744`) and a
1:1 branch (`:2746-3049`), selected by a 6-line inline predicate.**

**What it does, in order:**

1. `:2306-2315` — canonicalises `direct:<peer>` → server-UUID row. **Reassigns its own `conversationId` parameter.**
2. `:2351-2356` — **classifies group vs direct** (the B-124/B-125 seam)
3. `:2364-2374` — TOFU identity send-gate (1:1 only)
4. `:2378-2384` — mints `msgId`; forces `clientMsgId === msgId`
5. **GROUP:** `:2394-2397` resolve recipients from `convo.participants`, 250-recipient cap, **throw on empty**
6. **GROUP:** `:2423-2448` append the optimistic bubble
7. **GROUP:** `:2468-2471` acquire the per-group admin lock, **re-read the master key inside it**, encrypt, fetch cert
8. **GROUP:** `:2539` stamp `group:{groupId, …}` on the wire
9. **1:1:** `:2747-2790` resolve peer, append a **second, different** optimistic bubble
10. **1:1:** X3DH/session establishment, seal, wrap, transport-or-relay, outbox write
11. flip the bubble to `failed` on downstream reject

**Hidden rules:**

- `!!groupState` at `:2355` has **no `convo?.type !== 'direct'` guard**, while the participants clause at `:2356`
  explicitly does. **That asymmetry is the bug.**
- **FOUR exits above the optimistic append destroy the user's typed text** (the composer is already cleared by
  `ChatScreen.tsx:652/:657`):
  - `:2372` — TOFU gate: `setError` + **silent `return`**, no bubble, no outbox row, no throw. _Currently dark behind
    `EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE` — a latent B-125 the moment that flag is enabled._
  - `:2397` — `throw` "group has no other participants" — **this is B-125**
  - `:2412` — `throw`
  - `:2748` — `throw` "production mode requires explicit peer address"
  - The comment at `:2415-2417` asserts the _opposite_ invariant (append first). **Any fix must move the guards below
    the append, not delete them.**
- Two **separate** optimistic-append blocks (`:2424` group, `:2761` direct) with different comments (P1-1/P2-12 vs
  M-15/BS-SELF-MEDIA-TYPE) and slightly different field sets. A change applied to one silently misses the other.
- `clientMsgId` **must** equal the local `msgId` (`:2384`) or group authors never see reactions/replies on their own
  messages (BS-REACT-AUTHOR).
- Membership comes from `convo.participants` (`:2394`) — a **different source** than the `groups[]` map used to classify
  at `:2355`. Nothing cross-checks them.
- The recipient list must be **server-authoritative** (`:2388-2393`); unioning local `GroupState.members` back in
  re-introduces the stale-dev-contact leak.
- The master key must be re-read **inside** `runWithGroupAdminLock` (`:2468-2471`), never captured before it (P2-4).
- `opts.isGroup === true` (`:2352`) is the **highest-priority** clause and comes straight from
  `ChatScreen.tsx:182` `route.params` — see §5.6.

**Cut seams:**

1. Extract `:2351-2356` into `messagingLogic` so send/reactions/receipts share **one** predicate. **SAFE.**
2. Split into `planSend(state, conversationId, opts) → {topology, recipients, msgId, replyMeta}` — a pure planner that
   **throws before anything is appended** — then `appendOptimistic(plan)` as a single shared writer, then two thin
   transport executors. **This is the cut that kills B-125 structurally.**

---

### 5.3 `appendMessage` — `messengerStore.ts:516-728` · 213 lines · 2 params · **18 call sites**

**Rank 9. Named "append". Is actually a router, deduper, chronological splicer, conversation-row _factory_,
unread counter, list reorderer and typing-indicator clearer — in one immer producer.**

**What it does, in order:**

1. `:518` — lazily create `messages[conversationId]`
2. `:539-546` — id-collision dedup **with a content-divergence fork that REWRITES the id** to `` `${id}#${len}` ``
3. `:547` — `envelope_id` dedup
4. `:554-565` — L18 chronological **binary splice** for out-of-order rows, else fast append
5. `:582-627` — **DIRECT shadow-create**, _and_ a **RE-ROUTE**: if a server-UUID row exists for the same peer, move the
   message there, splice it out of the slot the caller chose, and **`return` early** at `:626`
6. `:628-652` — otherwise invent a `Bravo · <8-hex>` direct conversation row + unshift into `conversationOrder`
7. `:653-683` — **GROUP placeholder** row invention, suppressed when `groups[cid].name === 'Call'` (`:660`)
8. `:685-710` — `last_message`, `unread_count` (mute-aware), MSG-12 pinned-aware reordering
9. `:711-727` — BS-TY2 typing-indicator clear for the sender

**Hidden rules:**

- **An append silently CREATES a conversation.** This is how the B-124 ghost row appears.
- > **VERIFIER CORRECTION — this narrows the fix surface and matters a lot.** Both shadow-create branches are gated on
  > `msg.sender_id !== 'self'` (`:582` and `:653-661`). `sendText`'s optimistic bubbles at `:2424` and `:2761` both set
  > `sender_id: 'self'`, so **an outbound append can never invent a row**. Only an **inbound** append can.
  > **The seam to guard is the receive path, not the send path.** Additionally, the direct branch requires
  > `msg.peer` truthy — an inbound direct-shaped id with no peer appends into `s.messages` **with no conversation row
  > at all**, a third outcome nobody has named.
- **The id-rewrite at `:539-545` is a silent contract with `sendText`.** `sendText` holds the original `msgId`
  (`:2378`) and later calls `updateMessageStatus(conversationId, msgId, …)` at `:2739/:2742`, which does
  `find(m => m.id === messageId)` at `messengerStore.ts:732`. After a rewrite there is **no match**, so the bubble is
  stranded in `sending` forever with no error anywhere. **Any seam that splits `appendMessage` must return the
  EFFECTIVE id, not `void`.**
- The re-route early-return at `:600-627` skips **more than the unread block**: it also skips the typing-clear block
  (`:711-727`, B-117), so a rerouted message leaves the peer's "typing…" bubble stuck on. It also uses a **drifted
  copy** of the unread rule at `:619` that **omits the mute check** present at `:690`.
- Runs inside an immer producer, so **every early `return` commits the partial mutations already made above it**.
- `:564` `list.push` happens **before** the reroute branch splices it back out at `:613-614`. Reordering double-inserts.
- The out-of-order splice depends on `created_at` being the **sender's seal timestamp** for drained rows.

**All 18 non-test call sites** (recount by the verifier; the original audit's list was wrong in 4 places):
`productionRuntime.ts:2447, :2787, :3070, :6216, :6842, :7253, :7315`; `runtime.ts:794, :863, :890, :900`;
`useGroupCall.ts:4467, :4524`; `callDispatcher.ts:137`; `CallScreen.tsx:1405`; `ChatScreen.tsx:834`;
`decryptFailureSignal.ts:106`; `groupEventMessage.ts:89`.
_(`restoreMessages.ts` contains **no** `appendMessage(` call — its per-row implementation was replaced by a bulk
transaction; `:523` is a `LocalMessage` builder.)_

**Cut seams — all three are decisions, not mutations, so all three are SAFE:**

- `:539-547` → pure `dedupVerdict(state, msg) → 'skip' | 'fork' | 'insert'`
- `:554-562` → pure insert-position computation
- `:582-683` → pure `materialisationIntent(state, id, msg) → {reroute-to | create-direct | create-group | none}`,
  applied by a thin applier
- **UNSAFE:** the re-route's early `return`. Its skip-set is load-bearing and currently drifted; do not "clean it up"
  in the same commit that moves it.

---

### 5.4 `ensureCallGroupKey` — `productionRuntime.ts:4317-4487` · 171 lines

**Only 8 commits — and the highest-leverage cross-stage writer in the codebase. It is CALL code that writes MESSAGING
state under MESSAGING ids.**

**What it does:** `:4323` reject callless conversations → `:4339-4374` BS-CALL-OWNER resync (re-broadcast only if this
device owns the state) → `:4389-4394` `isReal` guard (refuse to mint over a real group owned by someone else) →
`:4408-4414` mint a fresh `name:'Call'` GroupState → **`:4433` file the key under the minted 32-hex id** →
**`:4434` alias under `direct:<own userId>`** → **`:4442-4443` alias under the ORIGINATING conversation id when
direct-shaped** → `:4446-4482` sealed fan-out → `:4483` roll back if the key reached zero peers.

**Hidden rules:**

- `setGroupState` is a **full overwrite** (`messengerStore.ts:1047`).
- The `direct:<own userId>` alias at `:4434` names a slot that can never be a legitimate chat (you have no 1:1 with
  yourself) — **and nothing ever removes it.** No cleanup path, no TTL, no call-end teardown.
- The ad-hoc group is **never registered server-side**, so `/conversations/mine` can never reconcile it away.
- A throw here is treated as fail-closed by `useGroupCall.ts:1549-1580`, which **string-matches the error message**.
- > **VERIFIER CORRECTION — dangerous framing to avoid.** The original audit said the B-10 comment at `:4423-4432`
  > ("we deliberately do NOT alias onto conversationId") is now **FALSE**. That is **overstated**. The `:4442` alias is
  > double-gated (`conversationId !== state.groupId && (startsWith('direct:') || convType === 'direct')`), and the
  > `isReal` guard at `:4389-4394` has already returned/thrown for any real group row. **The hazard B-10 describes is
  > still structurally prevented.** The comment is stale prose, not a live contradiction. A refactorer told "the comment
  > is false" may "restore" it by deleting `:4442-4444` — **that re-opens B-106** (a fresh `'Call'` group minted on every
  > re-escalation, unbounded `groups[]` growth) **without touching B-124 at all.**
- > **VERIFIER CORRECTION.** The rollback at `:4483` calls `removeGroupState`, which captures `stale = masterKeyB64`
  > (`messengerStore.ts:1087`) and queues `disposeGroupKey(stale)` (`:1095-1099`) **keyed on the key STRING** — which is
  > byte-identical across all three aliases. So one removal evicts the cache entry for a key the `direct:<own>` alias at
  > `:4434` still points at, and **that alias is never removed by anything.**

**Cut seam (the single highest-value structural fix in the whole brief):** give call keys **their own namespace** — a
separate `callKeys` map, or a required `isCallGroup`/`ephemeral` boolean on `GroupState` — so "transient key carrier"
stops being encoded as a **device-local name string**, and `groups[id]` regains its meaning of _"this id is a real
group"_. Every downstream `name === 'Call'` sentinel then disappears. **This is a wire/type change — architecture-gated.
Flag it for human approval; do not let the implementer do it unilaterally.**

---

### 5.5 `handleDeliverInner` (`:5372-5704`, 333 L) **and** `drainRelay` (`:7531-7907`, 377 L, 13 params)

**Two independent implementations of "receive one envelope and decide how to ack it". Every delivery-semantics fix must
be made twice and has historically drifted.** `handleDeliverInner` is the WebSocket path; `drainRelay` is the HTTP
catch-up path used by FCM msg-wake, ChatScreen mount, AppState-active and WS reconnect — **i.e. the path users actually
hit after being offline.**

**Verified divergences:**

| #   | WS (`handleDeliverInner`)                                                            | HTTP (`drainRelay`)                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `wasSeen` is `try/catch`-wrapped (`:5391-5398`) — a store hiccup degrades gracefully | `wasSeen` at `:7627` is **unguarded** — a SQLCipher hiccup throws out of the whole loop, **abandoning every remaining envelope in the page and every remaining page** |
| 2   | in-flight guard runs **first** (in wrapper `handleDeliver:5357-5371`)                | in-flight guard applied at `:7739` — **after** unwrap and after cert verify, so the cert catch can ack-`discarded` an envelope the WS path is concurrently processing |
| 3   | variable `handledOk`                                                                 | variable `handled` — **so a grep for one misses the other**                                                                                                           |
| 4   | ack site `:5674-5693`                                                                | ack site `:7878-7882` — duplicated disposition computation, not a shared helper                                                                                       |

**Hidden rules:**

- **The ack disposition is a REMOTE-DEVICE UI CONTRACT.** `'discarded'` makes the _sender's_ device flip the bubble to
  `undelivered` (`handleServerFrame:5137-5147`) and fire a B-46 auto-resend. A change to when `handledOk` is set changes
  another user's screen with no code change on their device.
- `takeDestroyedEnvelope` (`:5682`) is a **consuming** read from a **200-entry FIFO map** (`decryptFailureSignal.ts:48-58`)
  that evicts oldest-first. A drain burst larger than 200 envelopes between the note and the ack silently downgrades
  `'discarded'` to `'delivered'`.
- In `drainRelay`, `continue` **means leave-on-relay (no ack)**. Converting a `continue` to anything else changes
  delivery semantics.
- The `finally` at `:7864` must stay a `finally` — the catch block's `continue`s rely on it to release `inFlightEnvelopes`.
- The bootstrap-done flag may only be written on an **empty** page (`:7582-7587`), **never** on a short page
  (`:7884-7897`) — a prior "optimisation" that did so permanently truncated multi-week backlogs.
- `ownIdentity` is fetched **once** at `:7564` for the whole drain; an identity rotation mid-drain is not observed.

**Cut seam — the single highest-value cut in the inbound stage:** extract the shared _"unwrap + establish
trustedPeer"_ block (`handleDeliverInner:5411-5549` ≡ `drainRelay:7591-7715`, ~120 duplicated lines) into **one**
function. Also safe: `:5390-5407` "dedup + re-ack"; `:5674-5702` "ack disposition"; and `drainRelay`'s
`:7563-7589 + :7884-7900` pagination/bootstrap policy as its own iterator.
**UNSAFE without characterization tests:** the `:7750-7863` / `:5581-5669` error-triage chains.

---

### 5.6 `ChatScreenInner` — `ChatScreen.tsx:181-1846` · 1,666 lines · **ZERO tests**

19 `useEffect`, 8 `useMemo`, 18 `useRef`, 18 `useState`, 8 `useCallback`, 8 separate store subscriptions, ≥14 unrelated
concerns. **Confirmed: no test file renders `ChatScreen`** — the only files matching the name mention it in doc comments.
Its commits average **34.3 files each**, making any regression here near-impossible to bisect.

**The one thing that matters most:** `:182` destructures `isGroup` from `route.params` and passes it **verbatim** into
`runtime.sendText(..., {isGroup})` at `:678` and `:746`, and `sendMedia` at `:990`. In `productionRuntime.ts:2352`,
`opts.isGroup === true` is the **first and highest-priority** clause of the group decision. **A navigation parameter
overrides the store.**

**Other confirmed defects in this screen:**

- **The retry chip can permanently kill a message.** `:741` sets `'sending'`, then `:744` calls `sendText` with
  `existingMsgId`. If `sendText` takes any of its four early exits, no bubble is appended and no `'failed'` flip
  happens — the message is stuck in `sending` with no recovery.
- Render-phase `getState()` reads and _writes_ at `:331-335`, `:1170`, `:1660`, `:1691-1693`, `:2605`, `:2612`;
  `resolveSenderName` fires `ensureDirectoryNames(...)` **during render** at `:2616`.
- `MessageBubbleImpl`'s memo comparator (`:1921-1934`) ignores `media_object_key`, `media_key`, `media_iv`,
  `media_meta`, `receipts` and `envelope_id` — media only repaints today by accident of a sibling re-render.
- `:281` parses the id with the **magic number** `conversationId.slice(7)` instead of `'direct:'.length`.

**Ordering rules that look removable and are not:**

- `:657` `inputRef.current?.clear()` must fire in the same tick as `setText('')` at `:652`, before the await at `:676`
  (B-73).
- `:331-335` (render-phase unread snapshot) must precede `:346` `setActive(...)`, which zeroes `unread_count` — moving
  it into a `useEffect` kills the "Unread N messages" divider.
- `:2092` (`useNativeDriver: false`) and `:2097` (`useNativeDriver: true`) must remain **two separate `.start()` calls**.
  Combining them into `Animated.parallel` is a **native FATAL** when a disappearing message burns.
- `:911-912` / `:2148-2149` ref-mirrors exist because the memo comparator ignores function props; the effect at `:912`
  has **no dependency array on purpose** — adding one reintroduces F-14 (jump-to-wrong-bubble).

---

### 5.7 The persistence floor — `SqlMessageStore` + the write-through subscriber

**There is exactly one writer to the SQLCipher `messages` table (`sqlMessageStore.ts`, 412 lines) — and three
independent producers feeding it that do not agree:**

| Producer      | Mechanism                                                                                                                  | Durability contract                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Receive       | explicit `await sqlMessages.upsert(msg)` **inside** the receive txn (`:7255`, `:7320`, `:6217`, `:6507`, `:6722`, `:6845`) | transactional                       |
| Send          | **never calls SQL at all** — rides entirely on a Zustand diff-subscriber at `productionRuntime.ts:1768-1891`               | fire-and-forget `.catch`, next tick |
| Restore       | `upsertBatch`, with the subscriber **suppressed** (`restoreWriteThrough.ts`)                                               | bulk                                |
| Backup mirror | a **second** subscriber to the same store (`mirrorBootstrap.ts:173-204`) with its own, differently-keyed dedup             | —                                   |

**The answer to "what guarantees N messages → N rows, in order, no duplicates":**

> **`PRIMARY KEY (conversation_id, id)` at `src/modules/messenger/crypto/db.ts:164`, combined with
> `INSERT OR REPLACE INTO messages` at `sqlMessageStore.ts:131`. That is the entire guarantee. It is DDL, not logic.**

Everything else — `appendMessage`'s three dedups, `seenEnvelopeStore`, `inFlightEnvelopes` — is defence in depth on top
of it. And:

- **Nothing would fail loudly if it broke.** No `UNIQUE` on `envelope_id` (only a non-unique index at `db.ts:170-171`),
  no row-count assertion, no post-write verify, **and no test in the repo runs real SQLite**.
- The PK **includes `conversation_id`**, so the same message under two slots (`direct:<peer>` vs server-UUID) is **two
  legitimate rows** — the database cannot catch B-124-class aliasing.
- The id is `unwrapped.clientMsgId ?? makeId()` — **sender-supplied**. That is what collapses the group fan-out's N
  pairwise copies into one row. **Any change to id minting silently converts REPLACEs into INSERTs.** There are three
  separate private `makeId()` implementations (`productionRuntime.ts:7937`, `runtime.ts:914`, `pendingRosterIntents.ts:59`).
- **`LocalMessage.receipts` is persisted NOWHERE** — not in the DDL, not in `doUpsert`'s column list, not in
  `rowToMessage`, not in the backup wire. B-116 per-member read attribution does not survive a restart.
- **An AB-BA lock-order inversion exists:** `upsertBatch` takes the per-conversation chain before the global `txnChain`
  (`sqlMessageStore.ts:120` → `:355`); `doHandleIncoming` takes the global chain first (`:5908`) then the
  per-conversation chain (`:7320`). This is the family that produced B-75 and the 2026-07-09 P0.
- `SqlMessageStore.wipe()` (`:368-370`) is **unreferenced dead code** that deletes the entire messages table without
  going through `chainOp`. **Someone doing this refactor will wire it up. Do not.**

---

## 6. One rule, many copies

Every row is a rule implemented more than once, with **verified divergence**. This table is the core of the
simplification work: **collapsing these is worth more than splitting any single function.**

| Rule                         | Copies                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Divergence                                                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"Is this a group?"**       | **5 live**: `productionRuntime.ts:2351-2356` (send, 5 clauses, `!!groupState` **ungated**) · `messagingLogic.ts:31-43` (reactions + receipt acceptance — the **only tested** copy, **same missing guard**, and **no `opts.isGroup` clause**) · `launchCall.ts:101-107` (**same exported name**, different rule: type OR ≥2 _other_ members) · `messengerStore.ts:762` `recordReadReceipts` (**omits `ops_channel`**) · `backgroundMessageNotifier.ts:163` | `messagingLogic` and `productionRuntime` disagree whenever a caller passes `opts.isGroup`. `launchCall` disagrees for 2-person groups **by design**. `recordReadReceipts` blue-ticks an ops-channel early. |
| Parsing `direct:`            | **10 sites**: `productionRuntime.ts:2309, :2367, :3058`; `messengerStore.ts:505, :592, :1418`; `launchCall.ts:81`; `callNotification.ts:263`; `mutedLookup.ts:107`; `ChatScreen.tsx:281`                                                                                                                                                                                                                                                                  | `ChatScreen` uses the magic number `.slice(7)`.                                                                                                                                                            |
| Creating a conversation row  | **12+ sites** incl. `messengerStore.ts:638-649` & `:665-678`; `groupConversationUpsert.ts:36-49` & `:74-84`; `productionRuntime.ts:3560-3570`, `:3735-3745`; `runtime.ts:663, :682, :754`; `MainNavigator.tsx:616`; `ChatScreen.tsx:437`; `MessengerHomeScreen.tsx:199-217`; `NewChatScreen`                                                                                                                                                              | four call sites pass a hard `unread_count: 0` and reset the badge                                                                                                                                          |
| Building a `LocalMessage`    | **16 verified literal sites**                                                                                                                                                                                                                                                                                                                                                                                                                             | the three group builders (`:6182` drained, `:6820` legacy, `:7210` live) differ in status, `envelope_id` and timestamp handling — a field added to one is silently absent from drained messages            |
| `encrypt → wrapOuter → ship` | **19 sequences** in `productionRuntime.ts` alone (`:805, 863, 2030, 2093, 2177, 2264, 2553, 2831, 3030, 3319, 3518, 3621, 3771, 3863, 4022, 4128, 4360, 4467, 7971`) + `groupClient.ts:138-269`                                                                                                                                                                                                                                                           | 4 transport policies, 3 membership sources, **only 3 of 19 write a durable outbox row**                                                                                                                    |
| is-own-message               | `sender_id === 'self'` at ~20 sites; `AgentLiveTrackerScreen.tsx:404` and `DepartmentChatScreen.tsx:422` also accept `ownUserId`                                                                                                                                                                                                                                                                                                                          | a restored row carrying the owner UUID is "mine" in two screens and "theirs" everywhere else                                                                                                               |
| unread-should-increment      | `messengerStore.ts:690` (mute-gated) vs `:619` (**same function**, reroute branch, **not** mute-gated)                                                                                                                                                                                                                                                                                                                                                    | a muted chat gains badges only via the reroute path                                                                                                                                                        |
| should-notify / mute         | `backgroundMessageNotifier.ts:159` (live store) · `mutedLookup.ts:74` (headless, re-parses AsyncStorage) · `messengerStore.ts:690` (badge)                                                                                                                                                                                                                                                                                                                | drift in the window between a mute toggle and the persist                                                                                                                                                  |
| message-id derivation        | 3 × private `makeId()` + `genId()` + `genCallId()`                                                                                                                                                                                                                                                                                                                                                                                                        | see §5.7 — this is the exactly-once guarantee                                                                                                                                                              |
| participant resolution       | `messagingLogic.ts:59-61` · `productionRuntime.ts:2394-2395` · `launchCall.ts:85/:94` · `ChatScreen.tsx:301-303` · `groupConversationUpsert.ts:99-102` · `IncomingGroupCallScreen.tsx:149`                                                                                                                                                                                                                                                                | some filter the literal `'self'`, some `ownId`, some both                                                                                                                                                  |
| display-name placeholder     | **minted** as `` `Bravo · ${shortId}` `` at `messengerStore.ts:641`; **detected** by `name.startsWith('Bravo · ')` at `useRegisteredNames.ts:23`                                                                                                                                                                                                                                                                                                          | changing the format silently disables registered-name backfill                                                                                                                                             |
| the `'Call'` sentinel        | **5 guards**, not 4: `productionRuntime.ts:7041` (**wire** name — effective cross-device) · `:6979` (**local** state — the missed fifth) · `groupConversationUpsert.ts:73` (**local**) · `messengerStore.ts:660` (**local**) · `:1323` (**mixed** — also matches `row.name`)                                                                                                                                                                              | `GroupState` has **no** `isCallGroup`/`ephemeral` field; the type system knows nothing                                                                                                                     |
| ack disposition              | `productionRuntime.ts:5674-5693` (WS) and `:7878-7882` (drain)                                                                                                                                                                                                                                                                                                                                                                                            | duplicated computation, different variable names                                                                                                                                                           |

---

## 7. Invariants that must survive any refactor

Format modelled on `BACKUP_LOOP.md` §2. **`NEEDS TEST` means no test asserts this today — that is the work.**

| #       | Invariant                                                                                                                                                         | Proven by                              | Enforced today                                                                                                                                                                                                                                                                                                                                        | Pinned by                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **M1**  | A conversation whose row `type` is `direct` must **never** be routed as a group, regardless of what key material exists at its id                                 | B-124, B-125                           | **NOT ENFORCED** — `productionRuntime.ts:2355` and `messagingLogic.ts:40` both lack the `type !== 'direct'` veto                                                                                                                                                                                                                                      | **NEEDS TEST**                                                                         |
| **M2**  | Exactly **one** function answers "is this a group?" for message fan-out; call routing uses a **differently named** function                                       | B-124; the `launchCall` name collision | **NOT ENFORCED** — 5 live copies (§6)                                                                                                                                                                                                                                                                                                                 | `messagingLogic.test.ts` (tests one copy only)                                         |
| **M3**  | `sendText` must **never** throw or return above the optimistic append. All validation happens in a planner that runs **before** the composer is cleared           | B-125 (CRITICAL data loss)             | **NOT ENFORCED** — 4 exits above the append (`:2372`, `:2397`, `:2412`, `:2748`)                                                                                                                                                                                                                                                                      | **NEEDS TEST**                                                                         |
| **M4**  | Group key material is **never** filed under a `direct:`-shaped id without an explicit ephemeral/call marker on the state itself                                   | B-10, B-106, B-124                     | partially — `ensureCallGroupKey:4389-4394` `isReal` guard; the marker is a **device-local name string**                                                                                                                                                                                                                                               | `adhocCallKeyLookup.test.ts` (**mirror only**)                                         |
| **M5**  | The WS receive path (`handleDeliverInner`) and the HTTP drain path (`drainRelay`) implement the **same** validation set and the **same** ack-disposition rule     | B-30, B-46                             | **NOT ENFORCED** — 4 verified divergences (§5.5)                                                                                                                                                                                                                                                                                                      | **NEEDS TEST**                                                                         |
| **M6**  | An envelope whose cert verification fails **transiently** must remain redeliverable                                                                               | —                                      | **VIOLATED TODAY**: `markSeen` (`:6379`) runs **before** `verifySenderCert` (`:6405`), so the relay's redelivery is dropped by the `wasSeen` gate (`:5393`/`:7627`). A clock-skew blip = **permanent message loss**                                                                                                                                   | **NEEDS TEST** — _and note: reordering these two would be a **fix**, not a regression_ |
| **M7**  | Never log plaintext bodies, decrypted media, key material, or key-bearing ArrayBuffers                                                                            | `CLAUDE.md` security section           | `src/modules/messenger/__tests__/logAudit.test.ts` — but it scans only `src/modules/messenger` + `apps/messenger-service/src`. **`packages/messenger-core` is NOT scanned** and has 7 live `console.*` calls (`identity.ts:60,114`; `groupClient.ts:198,240,252,287`; `client.ts:100`). _`CLAUDE.md` cites a path for this test that does not exist._ | ✅ (with a hole)                                                                       |
| **M8**  | N inbound envelopes → exactly N rows, in order, no duplicates                                                                                                     | —                                      | **DDL ONLY** — `db.ts:164` PK + `sqlMessageStore.ts:131` `INSERT OR REPLACE`                                                                                                                                                                                                                                                                          | **NEEDS TEST — and no test in the repo runs real SQLite**                              |
| **M9**  | `store.appendMessage` must be immediately followed by `sqlMessages.upsert` inside the **same** txn, and the relay ack must happen only **after** that txn commits | P0-1, P0-N14                           | `:7253→:7255`, `:7315→:7320`, ack at `:5674` / `:7878`                                                                                                                                                                                                                                                                                                | `receiveTransaction.test.ts` (partial)                                                 |
| **M10** | A bare `return` inside `doHandleIncoming` **commits and acks**. Any new early return is a decision to destroy a message                                           | 20+ existing returns                   | **NOT ENFORCED** — convention only                                                                                                                                                                                                                                                                                                                    | **NEEDS TEST**                                                                         |
| **M11** | An inbound append may not invent a conversation row without an explicit, auditable intent                                                                         | B-124                                  | **NOT ENFORCED** — two inline branches with different guards (`:582-652`, `:653-683`)                                                                                                                                                                                                                                                                 | `appendMessageDedup.test.ts` (partial)                                                 |
| **M12** | `appendMessage` must return the **effective** message id (it can rewrite it at `:539-545`), or downstream status updates silently no-op                           | bubbles stuck in `sending`             | **NOT ENFORCED** — returns `void`                                                                                                                                                                                                                                                                                                                     | **NEEDS TEST**                                                                         |
| **M13** | Drains and replays run **outside** the receive txn, each opening its own                                                                                          | B-75 (CRITICAL)                        | comments at `:7049-7052`, `:6214`; `handleIncoming` voids the drain at `:5951`                                                                                                                                                                                                                                                                        | `receiveTransaction.test.ts`                                                           |
| **M14** | Lock acquisition order (global `txnChain` → per-conversation chain) is the same everywhere                                                                        | B-75, 2026-07-09 P0                    | **VIOLATED** — `upsertBatch` takes them in the opposite order (§5.7)                                                                                                                                                                                                                                                                                  | **NEEDS TEST**                                                                         |
| **M15** | The stash-drain path applies the **same** gates as the live path                                                                                                  | —                                      | **NOT ENFORCED** — `replayGroupSealedDecode:6145-6220` has the membership gate but **not** `isPeerBlocked`, **not** `isRestoreTombstoned`, **not** expiry. _Blocking a peer does not stop a stashed envelope from rendering._                                                                                                                         | **NEEDS TEST**                                                                         |
| **M16** | A notification never fires for a message that was not committed                                                                                                   | —                                      | **VIOLATED** — `appendMessage` runs inside `BEGIN IMMEDIATE`; Zustand notifies **synchronously**, so a rollback removes the row but not the banner or the badge                                                                                                                                                                                       | **NEEDS TEST**                                                                         |

---

## 8. Safety-net status — what must be written **before** any cut

### The current situation, measured

- **No test imports `productionRuntime.ts`.** The only two references are `jest.mock` stubs
  (`BackupRestoreScreen.legacy.test.tsx:55`, `authStore.signOut.test.ts:32`).
- **The tests are mirrors, and they have drifted.** These files say so in their own comments:
  `bootGroupStashDrain.test.ts:12` (_"too heavy to import in jest"_), `messagingLogic.test.ts:12`,
  `adhocCallKeyLookup.test.ts:72/:81/:89/:261` (_"Mirrors …"_), `groupCreateEpochBootstrap.test.ts:22`,
  `tamperKeyDivergenceStash.test.ts:9/:115/:240`, `directConvoAadId.test.ts:20`, `directConvoAadRoundtrip.test.ts:27`,
  `groupBroadcast.test.ts:631`.
  **A green suite is not evidence that a `productionRuntime` change is safe. It is evidence that a parallel copy still
  behaves the way it used to.**
- **Proof the copies drift:** `messagingLogic.ts:31-43` lacks the `opts.isGroup === true` clause that
  `productionRuntime.ts:2352` has had since `4d7a57d` (2026-06-08).
- **A regression test can pin the wrong thing.** `callGroupGhostGuards.test.ts` (153 lines, 10 cases) shipped _with_ the
  B-106 fix and passed the entire time B-124/B-125 existed. `grep -c direct` on it returns **0**.
- > **VERIFIER CORRECTION.** An earlier claim said `messagingLogic.test.ts:32` _pins_ the B-124 behaviour and would go
  > red when the guard is added. **It does not.** That assertion uses an **untyped** row (`state({g:{}},{g:{}})`), so
  > `undefined !== 'direct'` keeps it green. **The test that would have caught B-124 simply does not exist.** The suite
  > is _silent_ on the defect, which is worse than pinning it — it implies coverage that is absent.
- **No test runs real SQLite.** Every `DbHandle` is a hand-written fake: `sqlOutboxStore.test.ts:29-33`
  (_"Hand-rolled mini SQLite engine that understands only the queries the outbox store actually emits"_),
  `sqlMessageStoreResend.test.ts:33` (`makeFakeDb`, regex-matches SQL text), `receiveTransaction.test.ts:152`.
  Since M8 is a **DDL** property, it is **invisible to the suite by construction**.
- **`receiveTransaction.test.ts` is the closest thing to a real end-to-end receive test** — it already imports the
  **real** `SqlMessageStore` and drives its real `upsertBatch` SQL. **Only the storage engine is faked.** Swapping that
  one fake for an in-memory SQLite is the cheapest path to M8.

### The mechanism to copy — static source-scanning tests

The repo already ships **six** tests that _read source files_ and fail CI with a `file:line`. They are the one form of
enforcement an AI cannot talk its way past, they need no new dependency, and they cost ~40 lines each:

| Test                                                             | What it enforces                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/__tests__/alert.test.ts:127-158`                      | walks all of `src/` and fails if any file imports `Alert` from `react-native` — **a working, CI-enforced import boundary with a single-file exemption** |
| `src/modules/messenger/__tests__/logAudit.test.ts`               | walks two roots with 14 banned regexes to block plaintext logging (M7)                                                                                  |
| `groupCallVideoEncodings.test.ts`                                | asserts _every_ video producer routes through `videoEncodings()` — born from B-121's lesson that _"a device test only walks the path it walks"_         |
| `navigatorConfig.test.ts:27-28`, `opsReviewCancel.test.ts:26-28` | assert required code is **present**                                                                                                                     |

**Fable: the runbook must instruct the implementer to write these first, one per invariant, before the corresponding
cut.**

### Ordered list of tests required before each cut

| Order | Test                                                                                                             | Pins       | Writable today?                                                                                                                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `isGroupConversation(state({d:{type:'direct',participants:[…]}}, {d:{}}), 'd') === false`                        | **M1**     | ✅ — add a 5th case to `messagingLogic.test.ts`                                                                                                                                                                 |
| 2     | Static scan: no `!!groupState`-style disjunct in the group decision without an adjacent `type !== 'direct'` veto | **M1, M2** | ✅ — copy `groupCallVideoEncodings.test.ts`                                                                                                                                                                     |
| 3     | Static scan: `sendText` contains no `throw`/`return` between its start and the optimistic-append anchor          | **M3**     | ✅                                                                                                                                                                                                              |
| 4     | Static scan: exactly one exported symbol answers message topology; `launchCall`'s is named differently           | **M2**     | ✅                                                                                                                                                                                                              |
| 5     | `handleDeliverInner` and `drainRelay` produce the same disposition for the same inputs                           | **M5**     | ⚠️ needs the shared trust block extracted first — **chicken-and-egg: write it as a static scan of the two ranges first, upgrade to behavioural after the cut**                                                  |
| 6     | **Burst test:** feed N envelopes → assert exactly N rows, correct order, no duplicates                           | **M8**     | ⚠️ needs **in-memory SQLite** (`better-sqlite3`) swapped into `receiveTransaction.test.ts`. **Confirm whether it is already a devDependency; if not, this is the one new piece of infra the whole plan needs.** |
| 7     | `appendMessage` returns the effective id after a content-divergent collision                                     | **M12**    | ✅                                                                                                                                                                                                              |
| 8     | An inbound append with an unknown id creates a row **only** via an explicit intent                               | **M11**    | ✅                                                                                                                                                                                                              |
| 9     | A rolled-back receive txn fires no notification and leaves no unread badge                                       | **M16**    | ⚠️ needs the store subscriber under test                                                                                                                                                                        |
| 10    | Stash-drain applies the blocked-peer / tombstone / expiry gates                                                  | **M15**    | ✅                                                                                                                                                                                                              |

---

## 9. Suggested target shape

**Not a rewrite.** Every box below is a sibling module in `src/modules/messenger/runtime/`, matching the ~29 modules
already there. **Target: no file over ~400 lines, no function over ~80.**

```
OUTBOUND
  planSend(state, convoId, opts) -> SendPlan | PlanError     pure · all validation · ≤120 ln
  appendOptimistic(plan) -> effectiveMsgId                   single writer for BOTH branches
  sendGroup(plan) / sendDirect(plan)                         thin transport executors
  outbox                                                     already exists

INBOUND
  openEnvelope(frame, deps) -> Opened | Recovery             unseal + cert + AAD   (seam S1+S2)
  routeEnvelope(state, opened) -> Route                      PURE · ≤60 ln         (seam S3, :6584-6592 only)
  buildIncomingMessage(opened, route) -> LocalMessage        ONE builder, replaces 3   (seam S4)
  applyGroupText / applyGroupAdmin / applyDirect / applyReaction   one lane each   (seam S5)
  establishTrustedPeer(frame, deps)                          shared by WS + HTTP  ← highest-value cut
  ackDisposition(handledOk, destroyed) -> Disposition        shared by both ack sites

TOPOLOGY (the anti-B-124 layer)
  conversationTopology(state, id) -> 'direct' | 'group'      THE one message rule
  callRoutesToSfu(state, id) -> boolean                      renamed from launchCall's isGroupConversation
  hasGroupKeyMaterial(state, id) -> boolean                  for the genuinely-crypto questions
  parseConversationId(id) -> {kind, peerId?}                 replaces 10 hand-rolled parses

STORE
  appendMessage stays, but returns the effective id and never invents a row;
  materialisation moves to an explicit ensureConversationFor(id, msg)
```

> **On `conversationTopology`:** the correct fix for `:2355` is probably **deletion, not a veto**. Because `:2353/:2354`
> already return `true` for `group`/`ops_channel`, the `!!groupState` clause **only ever decides anything when the row
> is `direct`, `undefined`, or absent** — i.e. _its entire live behaviour is the bug_. Replace it with an explicit
> `hasGroupKeyMaterial()` at the two genuinely-crypto call sites. **Fable: evaluate both options and recommend one.**

### Two cuts the audit proposed that a verifier judged **UNSAFE** — do not put these in the runbook

1. **Splitting `setGroupState` into `setGroupKeyState` + `syncGroupMembership`.** The participants sync at
   `messengerStore.ts:1055-1058` is **already gated** on `type === 'group' || 'ops_channel'`, so the hazard it claims to
   fix cannot occur. Splitting converts an _enforced_ invariant into a _convention_ across 11 call sites, three of which
   (`:6281`, `:7010`, `:7112`) run **inside the receive txn**, where a forgotten sync call is silent and surfaces days
   later as _"added member gets keys but no messages"_ — the exact bug the choke point was created to kill.
   **Net risk strongly negative.**
2. **Widening `pruneCallGroupGhostRows` to also prune `groups[]` aliases.** It runs at `onRehydrateStorage`, and
   `partialize` **strips `masterKeyB64`** from the persisted snapshot — so at that moment every `groups[]` entry is a
   keyless shell awaiting its SQLCipher sink read. A boot sweep **cannot distinguish a real group's shell from a call
   alias**, and deleting a real one drops the group into the no-key path. If aliases must be swept, it has to happen
   **after** the sink rehydrates.

---

## 10. Cross-stage traps (the "why a small change breaks something far away" list)

1. **A CALL changes MESSAGING.** `launchCall.ts:190` → `useGroupCall.ts:1543` → `ensureCallGroupKey:4317` →
   `setGroupState` at `:4434`/`:4443` → `sendText`'s `!!groupState` at `:2355`. **Escalating a 1:1 call permanently
   re-classifies that chat as a group.** No messaging code changed; no messaging test noticed.
2. **A CRYPTO write changes SEND ROUTING.** `setGroupState:1055-1058` overwrites `conversations[gid].participants`, and
   `sendText:2394` reads exactly that list to pick recipients. **Every group-key change is a change to who receives
   messages, invisible in the send diff.**
3. **A REMOTE device changes LOCAL classification.** `doHandleIncoming:6585-6586` adopts the sender's **device-local**
   `group.groupId` verbatim; `:7019` files a key at `direct:<owner>` on receipt.
4. **INBOUND writes the state OUTBOUND reads.** The whole B-124/B-125 mechanism in one line.
5. **Call screens write into the message store with call-scoped ids.** `CallScreen.tsx:1405`, `useGroupCall.ts:4467`
   and `:4524`, `callDispatcher.ts:137` all call `appendMessage` with an id taken from the **call layer**.
6. **Notifications are fired by a store subscription with no call edge.** `backgroundMessageNotifier.ts:195` subscribes
   to the store; `onStoreChange` reads **only the tail** of each list (`:147`). So `appendMessage`'s out-of-order binary
   splice means **a drained/stashed group message produces no notification at all**.
7. **Every `s.messages` mutation is a disk write.** `productionRuntime.ts:1768-1880` diffs the store into SQLCipher:
   a vanished conversation **key** deletes every persisted row for it (`:1793-1806`) plus its media blob cache and
   decrypted temp files.
8. **Every status flip calls `notifyBackupDirty`** (`messengerStore.ts:740, 751, 778, 792, 799`). A change that flips
   ticks more often silently multiplies backup-mirror traffic and Merkle recommits — **the module `BACKUP_LOOP.md`
   guards. That runbook is mandatory reading for any change that reaches it.**
9. **Frame handling is unordered.** `dispatchFrame` does `void handleServerFrame(...)` (`:989`). Adding an `await`
   inside any switch case reorders it relative to every other frame class.
10. **Typing state is co-owned by the message path.** `appendMessage:711-727` clears it inline; the frame watchdog
    (`:5237-5248`) clears it per (conversation, sender). A dedup change alters typing behaviour with no diff in typing code.
11. **Group ✓✓ is a lie by construction.** The fan-out stores only the **first** recipient's `envelopeId` and
    `retractToken` (`:2689-2718`), so delivered advances when **one** member acks, and the disappearing-message retract
    pulls back only one member's copy.
12. **Group replies never reach the wire.** The 1:1 path stamps `replyTo` (`:2809`); the group path's `sealPayload`
    (`:2524-2549`) omits it. Replying in a group gives a correct local bubble and a reply-less envelope for everyone else.
13. **Multi-device fan-out is 1:1-only** (`:3008-3049`). A group message never reaches any member's second device.
14. **In-call chat multiplies bubbles.** `GroupCallScreen.tsx:1197` issues **N parallel `sendText` calls** for one typed
    message; each mints its own `msgId` and appends its own bubble.
15. **The sealed-archive restore replays history through the LIVE path.** `liveReplayArchive:1369-1409` fabricates
    `envelope.deliver` frames with **no `ackToken`**, so every user-visible side effect in `doHandleIncoming` — banners,
    unread bumps, reordering, `setGroupState`, placeholder creation — fires again during a restore.
16. **FCM msg-wake and ChatScreen share one promise.** The `coalescedDrain` mutex returns the shared in-flight promise,
    so a wake arriving mid-drain resolves **without its own envelope having been pulled** — and `fcmBootstrap.ts:1598`
    records `pulled = true`.
17. **`loadRecent` hard-deletes expired messages** (`sqlMessageStore.ts:218-221`) **outside** the store, so
    `mirrorRemoval` never fires and no tombstone reaches the backup. The `ExpirySweeper` path **does** tombstone.
    Same user action, two different backup outcomes.

---

## 11. Open questions for the owner

1. **Is `better-sqlite3` (or an in-memory `op-sqlite`) available as a devDependency?** M8 — the "N messages → N rows"
   test — is impossible without it, and it is the single most valuable missing test. This is the only new infrastructure
   the whole plan needs.
2. **Is `src/modules/messenger/runtime/runtime.ts` (923 lines, the second runtime) still needed?** It is reachable from
   production code but is a full duplicate implementation. Deleting it removes an entire class of drift; keeping it means
   every extraction must decide whether it adopts the shared module or forks.
3. **Is the `'Call'`-group namespace change (§5.4) approved?** It touches `GroupState`, which is a cross-device shape —
   architecture-gated per `CLAUDE.md`. It is the correct structural fix; it cannot be done unilaterally.
4. **Should the `markSeen`-before-`verifySenderCert` order (M6) be corrected in this programme or tracked as its own
   bug?** It is a live message-loss path, not a refactor concern.
5. **`EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE`** — is this intended to ship? If yes, `sendText:2372` is a latent B-125
   and must be fixed _before_ the flag is enabled.
6. **Priority between B-124/B-125 (a live CRITICAL) and the structural work.** The recommendation is: fix the predicate
   first as a standalone commit **with the test that was never written**, then start the extraction — the fix doubles as
   the first proof that the invariant discipline works.

---

## 12. Provenance & confidence

| Stage                  | Mapper                                                                         | Adversarial verifier                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| group-vs-direct        | ✅ 17 functions                                                                | ✅ **verified — 12 line-number corrections, 8 refutations, 8 missed functions, 6 missed hidden rules** |
| inbound-receive        | ✅ 16 functions                                                                | ❌ not run (session limit)                                                                             |
| outbound-send          | ✅ 15 functions                                                                | ❌ not run                                                                                             |
| persistence            | ✅ 16 functions                                                                | ❌ not run                                                                                             |
| store-ui               | ✅ 11 functions                                                                | ❌ not run                                                                                             |
| receipts-notifications | ✅ 21 functions                                                                | ❌ not run                                                                                             |
| bug-attribution        | ✅ 13 functions                                                                | ❌ not run                                                                                             |
| test-safety            | ❌ **not run** — §8 is assembled from a prior verified audit plus direct reads | —                                                                                                      |

**Read this the right way:** the group-vs-direct stage was independently re-measured and **12 of its line numbers were
wrong**. Assume a similar error rate in the six unverified stages. **Every line number in this brief must be
re-confirmed by grep at the moment of use.** Function names, sizes-of-magnitude, the duplication counts, the bug
attributions and the structural claims are corroborated across multiple independent agents and are reliable; specific
line offsets are not.

`productionRuntime.ts` grew **+143% in 8 weeks** (3,308 → 8,031 lines, 23 May → 19 July). `sqa.md` entries written on
2026-07-11 already cite lines ~170 rows off. **Anchor on symbols, never on offsets.**
