# Messenger / nav-bar / news-share lag audit — 2026-08-24

**Branch:** `main` @ `c97faada`
**Trigger commit:** `a47c692d` — "2026-08-24 device-day batch — B-646r4..B-654, native map default, perf spine"
**Reported by:** founder, on device, immediately after pulling that commit.

> "in messenger nav bar — if i tap to call menu it laggy; if i want to go other menu
> from messenger it laggy; whole messenger module is laggy. and news share is also laggy."

**Method:** static source audit, three independent auditors on separate lanes
(tab-switch / navigate-out / news-share), then an adversarial critic pass whose
brief was to REFUTE, not agree.
**No device was attached** (`adb devices` → empty). Per CLAUDE.md's lag section a
static pass is **not** proof; the device A/B is recorded as OWED in §8.

> **Revision 2 — after the critic pass.** The first draft got the headline wrong
> and the ranking backwards. Corrections, all re-verified by me against source
> before acceptance:
>
> - **M2's magnitude was wrong by ~2 orders of magnitude.** I cited "5 k–40 k
>   messages" from B-632 — that is the **SQLCipher history**, not the in-memory
>   `s.messages` map, which is capped at `MAX_HYDRATE_PER_CONVO = 200` per
>   conversation (`messengerStore.ts:591`). Measured floor is ~0.3 ms/scan, not a
>   350–500 ms stall. M2 is the _cheapest_ of M1–M4, not the headline.
> - **M3 double-counted against M2.** `appendMessage` bumps
>   `s.conversations[…].last_message` inside the **same** immer recipe that
>   touches `s.messages` (`messengerStore.ts:1088-1092`), and React 19 batches the
>   synchronous burst into one render. It does not add a second render per message.
> - **M7 is REFUTED from source, no device needed.** See M7 below.
> - **M1–M4 are ONE defect, not four.** `CallsLogScreen`'s own diff in `a47c692d`
>   is net **−108 lines**; M2/M3/M4 are pre-existing properties of that file. M1
>   is the only regression — it promoted them from "paid while Calls is open" to
>   "paid always". Correct priority: **M1 (root) → M4 (dominant residual) → M3 → M2.**
> - **Neither draft actually explained the reported symptom.** M1–M4 predict cost
>   proportional to _message traffic_, not to _taps_. The tap-shaped causes are
>   NEW-1 and the M7-inverse, added below.

---

## 0. Baseline captured before any change

| Gate                                                 | Result                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx jest --selectProjects messenger-crypto` — run 1 | 3 suites / 11 tests failed (`backupBootDecisionTable`)                                                                                                                                                                                                                                                                              |
| `npx jest --selectProjects messenger-crypto` — run 2 | 1 suite / 2 tests failed (`attachmentUriPipeline`)                                                                                                                                                                                                                                                                                  |
| **Verdict**                                          | The failures **move** between runs → the known B-126 moving flake, not a regression. Baseline is green-modulo-flake.                                                                                                                                                                                                                |
| `npm run typecheck`                                  | **48** errors vs `.tsc-baseline.json` = **47**. `main` is **+1 over baseline and would fail the pre-push gate today.** Pre-existing on the pulled commit, unrelated to this audit. The new-file errors are in `src/modules/maps/BravoMap.tsx`, `src/modules/maps/nativeMapbox.ts`, `src/modules/messenger/backup/messageMirror.ts`. |

---

## 1. The one-paragraph answer

`a47c692d` shipped a "perf spine" that stopped unmounting the Messenger home's
Chats and Calls tab bodies, toggling `display:'none'` instead. `display` is a
**Yoga layout property** — React does not know about it. The hidden subtree still
renders, still reconciles, and still holds every store subscription it declares.

What got permanently mounted is `CallsLogBody` — a **non-virtualised `ScrollView`
that mounts every call-log row**, is not `React.memo`'d, and holds two store
subscriptions that force a re-render on message traffic.

So the trade the commit actually made was:

> _pay the Calls-tab mount once per visit_ → _keep a non-virtualised list of every
> call permanently mounted, re-reconciling ~15 elements per row on every batched
> store commit, forever — including while the user is looking at Chats._

**And for the tap itself** (the thing the founder actually reported), two further
consequences of the same change:

1. The Chats pane is no longer skipped by a conditional, so **one tab tap now
   re-renders both panes** synchronously (NEW-1).
2. Yoga **skips layout entirely** for a `display:'none'` subtree, so flipping back
   to `flex:1` dirties the whole subtree at once — a single full layout + draw
   pass over that non-virtualised list, **on the UI thread, at tap time**
   (M7-inverse). That is B-279's measured "Slow UI thread" bucket.

That is the messenger-wide lag. The other two symptoms are **separate, independent
causes** — this is not one bug with three faces:

- **News share** — the share picker now re-reads the **entire device address book**
  on every open, with no cache (§3, NS1).
- **Navigating out of messenger** — `SecureLandingScreen` runs
  `navigation.reset` on a **500 ms `setInterval`** with keyless routes, so it
  remounts the whole destination subtree on every tick, while the messenger tree it
  is leaving keeps re-rendering because `enableFreeze()` is never called and
  `freezeOnBlur` is therefore a no-op app-wide (§3b, N1 + N2).

All three trace to the same commit except N2, which is pre-existing and acts as a
multiplier.

---

## 2. Findings — Messenger module & the Calls tab

### M1 — `display:'none'` does not stop React; the "perf spine" swapped a bounded cost for an unbounded one — **HIGH**

`src/screens/messenger/MessengerHomeScreen.tsx:1053-1054`

```tsx
<View style={activeTab === 'Calls' ? styles.tabShown : styles.tabHidden}>
  <CallsLogBody embedded bottomPad={MSG_TAB_HEIGHT} />
</View>
```

was, before the commit:

```tsx
{
  activeTab === 'Calls' && <CallsLogBody embedded bottomPad={MSG_TAB_HEIGHT} />;
}
```

`src/screens/messenger/MessengerHomeScreen.tsx:1555-1559`

```tsx
// display toggling skips the remount every switch used to pay; `display:'none'`
// detaches from layout AND touch, so no pointerEvents juggling needed.
tabShown:  {flex: 1},
tabHidden: {display: 'none'},
```

`display` is declared in `react-native/Libraries/StyleSheet/StyleSheetTypes.js`
and `ReactNativeStyleAttributes.js` as a layout attribute. The comment's first
claim (it detaches from layout and touch) is true. The implied second claim (so it
is cheap) is false: the component renders, its hooks run, its subscriptions stay
live, and the reconciler walks its children exactly as if it were visible.

**The screen's own code documents the rule this broke** —
`src/screens/messenger/MessengerHomeScreen.tsx:105-109`:

```tsx
// Why: M-18 — useShallow so a store commit that leaves every conversation
// entry identical doesn't re-render Home. The whole-map `presence` and
// `messages` subscriptions are gone: presence is per-row (RowOnlineDot)
// and search reads messages via getState() at filter time.
```

MessengerHome was deliberately engineered to hold **no** whole-`messages`
subscription. The always-mounted child re-imports one through the back door, where
the parent's `useShallow` discipline cannot reach it.

---

### M2 — the permanently-mounted selector does a full O(all messages) scan + `Date.parse` sort on every messages mutation — **HIGH**

`src/screens/messenger/CallsLogScreen.tsx:273`

```ts
const callMessages = useMessengerStore(selectCallMessages);
```

`src/modules/messenger/store/messengerStore.ts:2452-2467`

```ts
export const selectCallMessages = (s: MessengerState): readonly LocalMessage[] => {
  const map = s.messages;
  const cached = callMessagesCache.get(map);
  if (cached) {return cached;}
  const out: LocalMessage[] = [];
  for (const list of Object.values(map)) {
    for (const m of list) {
      if (m.type === 'call' && m.call_meta) {out.push(m);}
    }
  }
  out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
```

**Mechanism, verified end to end:**

1. zustand is `useSyncExternalStore` — confirmed at `node_modules/zustand/react.js:7-13`:
   ```js
   const slice = React.useSyncExternalStore(
     api.subscribe,
     React.useCallback(() => selector(api.getState()), [api, selector]),
   ```
   React therefore runs **the selector itself** for every mounted subscriber on
   every store notification, whether or not a re-render follows.
2. The `WeakMap` is keyed on the live `s.messages` object. Immer mints a fresh
   `messages` root on every mutation that touches it, so every such mutation is a
   guaranteed cache **miss** → full walk of every message in every conversation,
   then a sort of the call subset with **two `Date.parse` calls per comparison**
   (Hermes `Date.parse` on an ISO string is not cheap).
3. One user-visible message is **not** one commit. All of these are separate
   `set()` calls, each minting a fresh `messages` root (verified present in
   `messengerStore.ts`): `appendMessage` `:949`, `updateMessageStatus` `:1211`,
   `updateMessageStatusBulk` `:1228`, `recordReadReceipts` `:1245`,
   `recordDeliveredReceipt` `:1321`, `updateMessageRetractToken` `:1391`,
   `updateMessageEnvelopeId` `:1415`. For a **group** send,
   `updateMessageEnvelopeId` and `updateMessageRetractToken` fire once **per
   recipient** — so roughly `2N + 4` full scans per group message.

**Scale — CORRECTED after the critic pass.** `s.messages` is capped at
`MAX_HYDRATE_PER_CONVO = 200` per conversation (`messengerStore.ts:591`), so the
scan is bounded. Measured V8 floor on the exact selector body:

| convos | total msgs | call msgs | per scan                     |
| ------ | ---------- | --------- | ---------------------------- |
| 20     | 4 000      | 99        | 0.32 ms                      |
| 50     | 10 000     | 221       | 0.69 ms                      |
| 250    | 50 000     | 1 001     | 4.63 ms (absurd upper bound) |

A realistic account pays **~0.3 ms × 5–10 commits ≈ 3 ms per message** (V8 floor;
~10–15 ms on Hermes).

**My first draft claimed this was "a direct match for CLAUDE.md's 350–500 ms
per-message stall". That was wrong by roughly an order of magnitude** — I cited
B-632's 5 k–40 k figure, which describes the SQLCipher history, not the in-memory
map. Two different datasets. M2 is worth fixing for hygiene; **it is not the lag.**

**One real thing the first draft missed inside its own citation:** the selector
returns `Object.freeze(out)` — **a new array identity on every miss, even when
`out` is empty**. So an account with **zero call history** still gets a forced
re-render of the whole Calls pane on every messages commit. This is also why a
`useShallow` half-measure on the `conversations` selector fixes nothing on its own:
`callMessages` alone forces the render.

---

### M3 — bare whole-`conversations` subscription, the exact pattern the repo already bans elsewhere — **HIGH**

`src/screens/messenger/CallsLogScreen.tsx:274`

```ts
const conversations = useMessengerStore(s => s.conversations); // no useShallow
```

Immer mints a new `conversations` map on every conversation mutation, which
invalidates the row-model memo:

`src/screens/messenger/CallsLogScreen.tsx:279`

```ts
const calls: CallLog[] = useMemo(() => {
  /* O(all call messages) rebuild */
}, [callMessages, conversations]);
```

The repo already pinned this exact defect — `src/modules/messenger/__tests__/messengerRenderPerf.test.ts:88-100`
asserts `ForwardList` uses `useShallow(s => s.conversations)` and explicitly bans
the bare form:

> _"re-renders the open picker on EVERY store commit that produces a new map
> object — which, with immer, is every inbound message anywhere."_

**That pin covers `ChatScreen` only.** `CallsLogScreen` was never covered, and
until `a47c692d` it did not matter, because the component was unmounted.

> **⚠️ `useShallow` is NOT the fix here — and the existing pin's comment is
> misleading about this.** `useShallow` compares the map ONE level deep. Every
> inbound message replaces the _member object_ for its conversation
> (`last_message`, `unread_count`), so the shallow compare **still fails** and the
> component **still re-renders**. `useShallow` only helps when the map object is
> new but every member is referentially identical.
>
> The correct fix is the pattern `messengerStore.ts` already documents for
> `selectCallMessages` — a **WeakMap-cached selector returning a NARROW derived
> shape** (`{convId: {name, type, peerId}}` is all the call rows actually read),
> consumed with `useShallow`. Then a `last_message` bump produces an identical
> derived shape and no re-render happens at all.
>
> This also means finding NS5 is correct that `ForwardList`'s existing
> `useShallow` does not protect it either, and that the B-158 pin is weaker than
> its own comment claims.

**CORRECTED after the critic pass — this does NOT add a second render per
message.** `appendMessage` bumps `s.conversations[serverRowId].last_message` and
`unread_count` inside the **same** immer recipe that mutates `s.messages`
(`messengerStore.ts:1088-1092`, verified), and React 19 batches the synchronous
`set()` burst — including the whole `2N` fan-out loop — into **one** render.

M3 therefore adds renders only on commits that touch `conversations` **without**
touching `messages`: mute, pin, read-clear, and the `upsertConversation` discovery
sweep (which is NS1's storm). Real, but much rarer than the first draft claimed.

---

### M4 — the calls list is not virtualised, so every commit re-reconciles every row — **HIGH**

`src/screens/messenger/CallsLogScreen.tsx:434-450`

```tsx
<ScrollView style={{flex: 1}} contentContainerStyle={…} showsVerticalScrollIndicator={false}>
  …
  {visible.map(row => {
```

No `FlatList`, no windowing, no cap. Every row in the entire call history is a
real element and a real native view (~15 elements each: `TouchableOpacity` →
`UserAvatar` → `View`/`Text`/`Icon` × ~10 → nested `TouchableOpacity` → `Icon`).
`CallsLogBody` is not `React.memo`'d (`CallsLogScreen.tsx:262`), so M2/M3 push a
new `callMessages` / `conversations` identity in and the whole list re-renders:
`calls` rebuilds (`initialsOf`, `avatarBg`, `fmtDuration`, `fmtRelative`,
`Date.parse` per row), `visible` re-merges and re-sorts (`:336`), then
`visible.map(...)` re-creates every element.

Each row's `<UserAvatar userId={…}>` is also its own zustand subscriber
(`src/modules/messenger/ui/UserAvatar.tsx:64`) — though the critic is right that
this sub-claim is padding: that selector is a single property read returning a
stable string, so N of them is noise next to the reconciliation.

**CORRECTED: the unit is per _render_, not per `set()`** — batching collapses a
message's 5–10 commits into ~1–2 renders. But each render rebuilds _every_ row
(~15 elements each); a 100-entry log is ~1 500 elements reconciled, which dwarfs
M2's 0.3 ms.

**M4 is the dominant residual cost, and the first draft ranked it fourth.**

---

### M5 — the chat `FlatList` cannot bail out: `contentContainerStyle` is an inline object — **MED**

`src/screens/messenger/MessengerHomeScreen.tsx:1027`

```tsx
contentContainerStyle={{paddingBottom: insets.bottom + MSG_TAB_HEIGHT + 144}}
```

`FlatList` is a `React.PureComponent` (`react-native/Libraries/Lists/FlatList.js:307`).
A fresh object literal per render defeats the shallow prop compare, so
`VirtualizedList` re-renders on every parent render — every `setActiveTab`, every
keystroke, every `connectionState` change.

**Mitigating and stated honestly:** `data`, `renderItem`, `keyExtractor` and
`ListHeaderComponent` are all stable, and `ChatListRow` is `React.memo`
(`:1084`), so the row _bodies_ still bail out. The cost is the `VirtualizedList`
render + cell-window recompute, not the rows. Real, but second-order next to M1–M4.

---

### M6 — with a search query active, every inbound message fires a fresh SQLCipher full-history scan — **MED**

`src/screens/messenger/MessengerHomeScreen.tsx:535-557` (new in this commit)

```tsx
const msgs = await runtime.searchMessages?.(q, {
  conversationIds: ordered.map(c => c.id), limit: 50,
}) ?? [];
…
}, [debouncedQuery, ordered, runtime]);
```

`ordered` is a `useMemo` over `[conversationOrder, conversations, deptGroupIds, isDept]`
(`:481-489`), so it gets a new array identity on **every** conversation mutation.
With ≥2 characters in the box, every inbound message therefore re-fires a full
`searchContent` `LIKE` query against SQLCipher (`productionRuntime.ts:6559`), plus
an `ordered.map(c => c.id)` allocation of the whole id list. The 150 ms
`debouncedQuery` debounce (`:425-428`) gates the query **text**, not `ordered`, so
it does not cover this. The cleanup only sets an `alive` flag; it does not cancel
the in-flight query, so scans pile up under traffic.

The file already has the correct pattern at `:590` — `peerIdsKey = peerIds.join('|')`.

---

### M7 — ~~the hidden pane loses its rendered window~~ — **REFUTED**

The original hypothesis was that a `display:'none'` ancestor yields a 0-height
layout, collapsing `VirtualizedList`'s `visibleLength` and (with
`removeClippedSubviews`) detaching the resident rows.

**That cannot happen.** `react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:729-732`:

```cpp
childNode.setLayoutMetrics(newLayoutMetrics);

if (newLayoutMetrics.displayType != DisplayType::None) {
  childNode.layout(layoutContext);
}
```

and `android/gradle.properties:46` → `newArchEnabled=true`, so this is the live
path. The hidden wrapper gets zeroed metrics, but **layout never recurses into
it** — the inner `VirtualizedList` is never re-laid-out, never receives an
`onLayout`, and keeps the `visibleLength` it had while visible. The premise is
false. Delete this finding.

---

### M7-inverse — the fact above is the _actual_ tap-shaped cost — **HIGH**

Because layout is **skipped entirely** while the pane is hidden, flipping back to
`flex:1` dirties the **whole subtree at once**: a single full Yoga layout + draw
pass over a **non-virtualised** call list, on the **UI thread**, at tap time.

That is precisely B-279's measured "Slow UI thread — mounting/laying out views"
bucket, and unlike M1–M4 it is **tap-shaped**, which is what the founder actually
reported.

---

### M8 — no test in the tree can see M1–M4 — **HIGH (process finding)**

`src/screens/messenger/__tests__/emergencyCallsLog.test.tsx:44-49`

```ts
jest.mock('@/modules/messenger/store', () => ({
  useMessengerStore: (sel: (s: unknown) => unknown) => sel({messages: {}, conversations: {}}),
  selectCallMessages: () => mockCallMessages,
}));
```

`useMessengerStore` is replaced by a plain function call — no
`useSyncExternalStore`, no subscription, no commit loop — and `selectCallMessages`
never runs. And `messengerPersistentTabs.test.ts` is a **source scan** whose new
assertions check the `display` toggle string is present, i.e. it asserts that the
regression _is_ the desired shape.

The commit's stated gate ("messenger screens green") was structurally blind to
every finding above. This is the same class as CLAUDE.md's standing warning that a
green suite is not evidence for `productionRuntime.ts`.

---

### M9 — layout regression (not perf): the compose FAB is ~84 dp too high — **MED-HIGH**

`src/screens/messenger/MessengerHomeScreen.tsx:1033` + `:1686-1690`

```tsx
style={[styles.fabWrap, {bottom: insets.bottom + 72 + MSG_TAB_HEIGHT}]}
…
fabWrap: {position: 'absolute', right: 22, width: 56, height: 56, …},
```

The FAB is absolutely positioned and used to be a direct child of the root
(`root: {flex:1}`, `:1553`), so `bottom` measured from the screen bottom — hence
the deliberate `+ MSG_TAB_HEIGHT` to clear the footer. The commit wrapped the
whole Chats pane in `<View style={styles.tabShown}>` (`:768`), which is a
**sibling** of `<MessengerTabBar>` (`:1059`) and therefore already ends at the top
of the bar. The containing block changed, so `+ MSG_TAB_HEIGHT + insets.bottom` is
now double-counted.

Not a lag finding — caught while reading the same diff, and worth fixing in the
same pass. Not visually confirmed on a device.

---

### M10 — News tab: full remount + two network round-trips per tap (pre-existing) — **HIGH mechanism, not a regression**

`src/screens/messenger/MessengerHomeScreen.tsx:1056` keeps News conditional by
design. `src/screens/news/NewsHubScreen.tsx:88,93-116` — `useIntelFeed('ALL')`
plus a `useFocusEffect` that runs `loadNewsPrefs()` then `newsApi.getFeed(...)`.
`useFocusEffect` runs on mount when the host is already focused, so every News tap
remounts and re-fetches.

This is real "News is slow", but it is **unchanged by `a47c692d`** and does not
explain the Calls complaint. `useIntelFeed`'s own cadence was not read — UNVERIFIED.

---

### NEW-1 — every tab tap now re-renders the **Chats** pane too — **HIGH, and this is the tap-shaped cause**

Before the commit, `MessengerHomeScreen.tsx:768` was
`{activeTab === 'Chats' && ( … )}` — tapping Calls rendered `false` for ~280
lines of Chats JSX. After it, the Chats pane is permanently in the tree, so
`setActiveTab` re-renders **the full Chats subtree _and_ the full Calls subtree in
one synchronous discrete-event commit**: banners, header, search box, and the
`FlatList` element with its fresh inline `contentContainerStyle` (M5 — so
`VirtualizedList` cannot bail out and recomputes its cell window), plus
`visible.map` rebuilding every call row (M4, no memo).

**This corrects a self-contradiction in the first draft.** §4 ruled out "the chat
list re-rendering on tab tap" on the grounds that `ChatListRow` is memoised and
the rows bail out. That answers the wrong question: the **rows** bail, the
**pane** does not — and it contradicts M5, three sections earlier, which says the
`FlatList` itself cannot bail because of the inline style prop.

---

### NEW-2 — the Calls-tab mount cost was _relocated_ onto MessengerHome's mount — **HIGH**

M1 is written above purely as a background-subscription cost. It is also a
**relocation**: the whole non-virtualised call log's element tree and native views
are now created when `MessengerHomeScreen` mounts — i.e. on **every cold entry
into the messenger tab** — alongside what the commit's own comment calls "the
priciest mount on this screen" (the chat list).

That is a direct, previously un-cited candidate for the founder's _"the whole
messenger module is laggy"_.

---

## 3. Findings — News share

### NS1 — the share picker re-reads the ENTIRE device address book on every open — **HIGH**

`src/screens/messenger/ChatScreen.tsx:4109-4111` (new in this commit)

```ts
const {matches: discovered} = useDiscoveredContacts({
  users: usersClient,
  ownPhoneE164,
  enabled: true,
  passive: true,
});
```

`ForwardList` is what the News share sheet renders
(`src/modules/news/ShareNewsSheet.tsx:254`). RN's `Modal` returns `null` when not
visible (`react-native/Libraries/Modal/Modal.js:280-289`), so the picker
**unmounts on close and remounts on open** — and the effect at
`useDiscoveredContacts.ts:229-231` (`useEffect(() => { void run(); }, [run])`)
re-runs the whole sweep every single time:

1. `:126` `Contacts.getContactsAsync({pageSize: 0})` — the **entire** address book.
   ⚠️ **CORRECTED: this does NOT block the JS thread.**
   `node_modules/expo-contacts/android/.../ContactsModule.kt:175` declares it as
   `AsyncFunction("getContactsAsync")`, so the ContentResolver cursor walk runs on
   the module's own queue. Only result marshalling lands on JS.
2. `:130-142` `normalizeSingle` → `normalizeBatch` per phone number.
   ⚠️ **CORRECTED — my first draft's claim that this is libphonenumber-js was
   FABRICATED.** `libphonenumber-js` appears **zero times in `package.json`** and
   only inside two _comments_ in `src/`. `normalizeToE164`
   (`phoneNormalize.ts:37-95`) is hand-rolled: a `.trim()`, two `.replace()`
   regexes and one `E164_RE.test()`. I read the docblock at
   `useDiscoveredContacts.ts:78` — _"Normalize every phone string to E.164
   (libphonenumber-js,"_ — and reported the prose as the implementation. This is
   precisely the CLAUDE.md comment-stripper failure mode.
   Measured V8 floor for the real algorithm, full `phoneToLocalName` build:
   0.89 ms @ 500 contacts · 2.61 ms @ 2 000 · 6.60 ms @ 5 000.
3. `:157-163` `/users/lookup` over the network in 500-phone chunks, awaited
   serially. Network-bound — it does not block, it just means rows appear late.
4. `:190-221` a walk of the whole `conversations` map issuing a **separate
   `upsertConversation` store commit per row that needs a restamp**.

`matches` is component-local `useState` (`:94`) — no module cache, no store slice,
no in-flight dedup. All of this lands on the JS thread _during_ the
`animationType="slide"` sheet animation.

**The correct pattern already exists one directory over** —
`src/modules/messenger/contacts/savedContacts.ts:36-37` keeps a module-level index
plus a single in-flight promise, built once per session.
`MessengerHomeScreen.tsx:186` has already run this identical sweep and holds the
answer; the picker throws it away and redoes it.

**CORRECTED severity: OVERSTATED.** What survives is real and worth fixing — **no
cache, no in-flight dedup, re-runs per mount**, and `MessengerHomeScreen.tsx:186`
has already run the identical sweep and thrown the answer away. But the cost is a
**duplicated network round trip plus ~1–7 ms of JS**, not a JS-thread stall during
the slide-in. My first draft's headline framing was wrong on both of its two
load-bearing sub-claims.

---

### NS2 — `Object.entries()` allocated once _per conversation_, inside the render body — **HIGH (measured)**

`src/screens/messenger/ChatScreen.tsx:4115-4118`

```ts
const rows = conversationOrder
  .map(id => conversations[id])
  .filter(
    c =>
      c &&
      c.id !== currentConvId &&
      !resolveDeptConversation(c.id, {deptConversationIds, deptGroupByChannel}),
  );
```

`src/modules/messenger/push/deptChannelTarget.ts:78-79`

```ts
for (const [channelId, convoId] of Object.entries(maps.deptGroupByChannel ?? {})) {
  if (convoId === conversationId) {
    return {channelId, orgId};
  }
}
```

A fresh `Object.entries` array is built **for every conversation**, then linearly
scanned — O(conversations × channels) _plus one array allocation per
conversation_. No `useMemo`. It re-runs on mount, on every sheet state change, on
every store commit, and on **every keystroke** in the new search box
(`ChatScreen.tsx:4239`, `onChangeText={setQuery}`, undebounced).

Microbenchmarked (V8, so a **floor** — Hermes is several times slower):

| convs × channels | as shipped  | entries hoisted | reverse-index `Map` |
| ---------------- | ----------- | --------------- | ------------------- |
| 100 × 20         | 0.47 ms     | —               | —                   |
| 300 × 60         | **3.60 ms** | 0.11 ms (33×)   | 0.011 ms (327×)     |
| 600 × 120        | **14.7 ms** | —               | —                   |
| 1000 × 200       | **40.0 ms** | —               | —                   |

The allocation is the whole cost: hoisting the same linear scan is 29× faster; a
prebuilt reverse `Map` is 294× faster.

⚠️ **CORRECTED: the benchmark reproduces, but the SCENARIO was invented.** The
table's second axis assumes `channels ≈ conversations / 5` — a scaling law nobody
checked. `deptGroupByChannel` is written only by the dept-channel learn path
(`messengerStore.ts:1641`), so it is **empty for any account with no workspace
channels**. Same benchmark, that account:

| convs × channels | cost                                   |
| ---------------- | -------------------------------------- |
| 100 × 0          | 0.009 ms                               |
| 1000 × 0         | **0.086 ms** (vs the 40.0 ms headline) |
| 300 × 5          | 0.125 ms                               |

Real allocation waste, worth the reverse-index `Map` — but it costs **~0.1 ms**
unless the account holds dozens of department channels. Publishing 40 ms without
stating that assumption was inflation.

---

### NS3 — `forwardTargets.ts` re-derives everything per render, including an ICU sort — **HIGH**

`src/screens/messenger/forwardTargets.ts:34-37`

```ts
export function matchesForwardQuery(name: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return !q || name.toLocaleLowerCase().includes(q);
}
```

`src/screens/messenger/forwardTargets.ts:50-61`

```ts
const knownPeers = new Set(conversationRows.filter(…).map(…).filter(…));
return discovered.filter(…).filter(m => matchesForwardQuery(contactRowName(m), query))
  .sort((a, b) => contactRowName(a).localeCompare(contactRowName(b)));
```

Called unmemoised at `ChatScreen.tsx:4124-4125`.

Four costs, all per keystroke: the query is re-folded **inside the per-row
predicate** (the caller already has the folded `q` at `:4113` and does not pass
it); `knownPeers` is rebuilt from all rows; the **whole contact list is re-sorted
on every keystroke** although the order never changes — 1.48 ms vs 0.22 ms for a
plain comparator at 1 000 contacts (**6.7×**), because Hermes ships Intl and each
`localeCompare` is an ICU call; and `contactRowName` is re-evaluated ~2·n log n
times inside the comparator.

Combined with NS2, the full per-keystroke derivation measured **0.03 / 0.11 / 1.04
/ 3.99 / 12.02 ms** at 20/60/150/300/500 conversations. The ICU multiplier
reaching the device is inferred from the RN 0.81 Android artifact, not verified
on-device.

---

### NS4 — the sheet fires a 1–20-page serial network call and 3+ full re-renders per open — **HIGH**

`src/modules/news/ShareNewsSheet.tsx:78-103` runs `departmentApi.listChannels()`
on open; `src/services/api.ts:2290-2312` implements it as a **sequential cursor
loop, up to 20 awaited pages**. Then `shareWorkspaceGroups` builds the tree, and
`setLoadingGroups(true)` / `setGroups` / `setLoadingGroups(false)` produce three
re-renders — each re-running all of NS2 and NS3, because `ForwardList` is not
`React.memo`'d (`ChatScreen.tsx:4065`) and `onPick` is a fresh closure anyway
(`ShareNewsSheet.tsx:254`).

The no-cache choice is deliberate and correct **for the roles** (the comment at
`:69-71` says so). That does not require re-paying the tree build and the render
storm.

---

### NS5 — the discovery sweep's `upsertConversation` storm re-renders the open picker once per commit — **MED-HIGH**

`src/modules/messenger/contacts/useDiscoveredContacts.ts:201-221` issues one
`store.upsertConversation({...})` per row needing a restamp — each a full
zustand+immer commit. Every commit fans out to `ForwardList`'s
`useShallow(s => s.conversations)` (`ChatScreen.tsx:4069`), and because immer
mints a new object for the changed conversation the **shallow check still fails**,
so the picker re-renders → NS2 + NS3 again, per commit. It also hits the mirror
subscriber's `Object.entries` walks (`mirrorBootstrap.ts:194,224`).

Note the nuance: `useShallow` is the right pattern and the `messengerRenderPerf`
pin is correct, but `useShallow` over a **map whose members are replaced** does
not stop this class. K is account-dependent and UNVERIFIED.

---

### NS6 — every `FlatList` prop is a new identity, so a keystroke re-renders the whole window — **HIGH mechanism, MED cost**

`src/screens/messenger/ChatScreen.tsx:4171-4178, 4186, 4251-4266` — `items`,
`keyExtractor={i => i.key}`, `renderPickerItem`, `ListEmptyComponent` and
`initialsDisc` are all recreated per render, so `VirtualizedList` cannot bail out
and the mounted window (`initialNumToRender={14}`, `windowSize={7}`) re-renders per
keystroke, each row carrying its own `UserAvatar` store subscription.

**Stated fairly:** the virtualisation added by this commit is a **real
improvement** over the previous `ScrollView` that mounted every row. This finding
is about what it still leaves on the table, not a regression.

---

### NS7 — the share tap re-renders the entire non-virtualised news feed before the sheet can even mount — **HIGH**

`src/screens/news/NewsFeedScreen.tsx:95-99, 261, 368, 373`. `shareItem` lives at
the screen root, so tapping Share re-renders `NewsFeedScreen` — and every
`ArticleRow` with it, because `ArticleRow` is a bare function (`:373`), not
`React.memo`. The feed is a plain `ScrollView` and `remaining` (`:172`) is
unbounded, so **all** articles are mounted and all re-render. `onClose` pays it a
second time. `shareArticle` is already `useCallback`'d, so `React.memo` on
`ArticleRow` is a one-line fix.

---

### NS8 — `IntelFeedScreen` rebuilds a 220-`<View>` scanline overlay on the share tap — **HIGH mechanism, LOW-MED cost**

`src/screens/news/IntelFeedScreen.tsx:643, 649-653` — `Array.from({length: 220}).map(...)`
in the render body; `setShareItem` re-renders the screen and re-creates 220
elements, twice per share (open + close). Host views are not re-mounted, so this
is JS reconciliation only. Hoisting the overlay to a module-level constant is free.

---

### NS9 — `treeGuides` is O(n²) and unmemoised on drill-in — **MED**

`src/modules/news/shareChannelTargets.ts:82-95`, called in the render body at
`src/modules/news/ShareChannelPicker.tsx:115`. Only paid after a workspace
drill-in and the inner loop breaks early on a shallower row, so it is benign for a
normal workspace and degrades on a wide flat one. Real channel counts UNVERIFIED.

---

## 3b. Findings — navigating OUT of messenger into another menu

### N1 — `SecureLandingScreen` re-runs `navigation.reset` every 500 ms with keyless routes, remounting the whole destination each time — **HIGH**

`src/screens/securepro/SecureLandingScreen.tsx:88-98`

```ts
const dispatch = () => {
  const routes = target.current as TargetRoutes;
  navigation.reset({index: routes.length - 1, routes});
};
dispatch();
// B-649 — self-heal: still mounted means the reset above went nowhere.
const timer = setInterval(dispatch, RETRY_MS);          // RETRY_MS = 500 (:61)
return () => clearInterval(timer);
}, [hasLoaded, application, navigation]);
```

The routes carry **no `key`**, and `@react-navigation/routers/src/BaseRouter.tsx:63`
mints a fresh one on every RESET — verified:

```ts
route.key ? route : {...route, key: `${route.name}-${nanoid()}`};
```

A new key is a **different route** to React Navigation, so each dispatch unmounts
and remounts the entire destination: `SecureShell` → `SecureTabNavigator` →
`BookingHomeScreen` for LITE, or `[BookingHome, ProDashboard]` for PRO.

The B-649 safety argument — _"a successful reset UNMOUNTS this screen, so the
retry can never double-navigate"_ — only holds if React commits that unmount
inside 500 ms. The commit it is racing is the mount of `BookingNavigator` +
`SecureTabNavigator` + `BookingHomeScreen`, and **the same comment records the
measured stalls in that window as 300-400 ms.** That is a positive feedback loop:
the slower the mount, the more likely a retry fires mid-mount, discards the
in-flight work, and starts over.

This sits on exactly the path the founder describes. The drawer product switch
(reachable from the MessengerHome header avatar) remounts the tab tree via
`key={activeProduct}` (`MainNavigator.tsx:1478`), so `BookingNavigator`
initialises fresh and `useNavigationBuilder.tsx:498` routes it to `SecureLanding`
— the resolver — **every single time**.

⚠️ **CORRECTED: OVERSTATED — the 500 ms loop is not the steady state.**

BaseRouter rejects a RESET naming an unregistered route, and all three targets
_are_ registered (`BookingNavigator.tsx:87` BookingHome, `:92` ProDashboard,
`:333` SecureShell). So the reset **succeeds**, `SecureLandingScreen` is not in the
target stack, it unmounts, and `:97`'s `return () => clearInterval(timer)` fires.
**One dispatch, not a loop.** The interval only bites in the specific B-95
deferred-cleanup race its own comment documents — which is exactly what B-649 was
built for.

**And the cited evidence is the wrong branch.** `navigation.reset({index, routes})`
emits `{type:'RESET', payload}` with no `stale` field, so `BaseRouter.tsx:63`'s
`if (nextState.stale === false)` path — the one I quoted — is **not taken**. The
keys are minted at `StackRouter.tsx:144` instead. The conclusion (keyless routes
get fresh keys) survives; my evidence for it did not.

**Path relevance holds, though** — `MessengerHomeScreen.tsx:869`
(`navigate('SecureTab')`), `MainNavigator.tsx:1543` (the tabPress listener) and
`SwitchDashboardSection.tsx:182` all land on `SecureLanding`.

The real per-hop cost is not the race — see N7 below, which is what the keyless
routes actually buy you.

---

### N2 — `freezeOnBlur` is a no-op app-wide: `enableFreeze()` is never called — **HIGH**

> **CORRECTION (2026-08-26, NAV_BACK_RAPID_USE_AUDIT §4/NAV-23): this finding's
> mechanism is WRONG.** `freezeEnabled()` supplies only the _destructuring
> default_ at `Screen.tsx:77` — an **explicit** `freezeOnBlur: true` forwarded
> by native-stack (`NativeStackView.native.tsx:180,330`) works with no
> `enableFreeze()` call, so MessengerNavigator's stack-wide `freezeOnBlur` was
> never a no-op. The real gap was COVERAGE (7 of 9 stacks never set it), fixed
> in the NAV-23 rollout. The `enableFreeze()` objection below still stands
> against flipping the global default.

Verified by grep — `enableFreeze` and `enableScreens` appear **nowhere** in
`src/`, `App.tsx` or `index.js`. And `react-native-screens/src/core.ts:26`:

```ts
let ENABLE_FREEZE = false;
```

`Screen.tsx:77` defaults `freezeOnBlur = freezeEnabled()`, and `:185-186`
computes `const freeze = freezeOnBlur && (...)` → **always `false`**.
_(See the correction above — this chain holds only for screens that never pass
the prop explicitly.)_

None of the three root `<Tab.Screen>`s in `MainNavigator.tsx:1496-1546` sets
`freezeOnBlur` either. `detachInactiveScreens` still detaches the **native
views**, but the blurred tab's **React tree keeps rendering**.

`MessengerNavigator.tsx:68` does set `freezeOnBlur: true`, but that governs
screens _within_ the messenger stack — it does not freeze the stack when its
parent tab blurs.

So during and after the hop out of messenger, `MessengerHomeScreen` and
everything in it is **still re-rendering on every store mutation**, competing for
the same JS thread as the destination's mount. This is pre-existing, not caused by
`a47c692d` — but it is the multiplier that makes M1–M4 hurt on the way out.

Confirmed by the critic: `react-native-screens/package.json:30` sets
`"react-native": "src/index"`, so `src/core.ts` is what Metro ships, and a full
`node_modules` sweep for `enableFreeze(` returns only definition sites — react-
navigation never calls it either.

> **⚠️ Severity objection, accepted: `enableFreeze()` is NOT a safe one-liner.**
> Calling it app-wide suspends _every_ blurred subtree — that changes when effects
> and timers run everywhere in the app, including calls, backup and the mission
> lanes. **The targeted fix is `freezeOnBlur: true` on the three root
> `Tab.Screen`s** (`MainNavigator.tsx:1496-1546`), which works without the global
> flag. And the HIGH rating was unearned: it is a mechanism with no measurement.

---

### N3 — the PRO destination re-arms a network fetch and a WS subscription on every N1 remount — **MED**

`src/screens/pro/ProDashboardScreen.tsx` (added in this commit) runs
`secureProApi.missions(appId)` from a `useFocusEffect`, plus
`useProAppRealtime(appId, …)` which does `transport.subscribeMission()` +
`addFrameListener` on mount and tears both down on unmount. Because N1 re-mints
the route key, each retry pays a **fresh** subscribe/unsubscribe pair and a fresh
HTTP round trip. The greeting also gained `adjustsFontSizeToFit
minimumFontScale={0.72}`, an iterative text-measure pass on the already-hot UI
thread.

Its share of the perceived stall is not measured.

---

### N4 — cold Secure entry still blocks on a network round trip before the resolver can aim — **MED**

`secureProStore.loadApplication` now skips `isLoading` when `hasLoaded` (B-648
stale-while-revalidate), but `SecureLandingScreen` gates on `hasLoaded`, not
`isLoading` (`SecureLandingScreen.tsx:78`). On a **cold** Secure entry the
resolver shows a bare spinner for the full `/pro-applications/me` round trip
before it can even pick a target. Same door as N1; the two compound.

---

### N5 — `textDefaults` is a no-op on RN 0.81 + React 19 (correctness, not perf) — **HIGH**

`src/utils/textDefaults.ts:26-36`, imported first in `App.tsx:6`:

```ts
const T = Text as unknown as WithDefaults;
T.defaultProps = T.defaultProps ?? {};
T.defaultProps.maxFontSizeMultiplier = MAX_FONT_SCALE;
```

`react-native/Libraries/Text/Text.js` ends with `export default TextImpl;` — a
plain **function** component, and the file contains no `defaultProps` reference at
all. React 19.1's RN renderer resolves `defaultProps` only in
`resolveClassComponentProps` (`ReactNativeRenderer-dev.js:6845-6858`) — **class
components only**.

So the client-reported header clipping on large system fonts is **still
unfixed**. `src/utils/__tests__/textDefaults.test.ts` only asserts the constant is
`1.3` and that `App.tsx` contains the import string — it never renders a `<Text>`
and checks the resolved prop, which is why it went green.

Flagged here because it was found in the same diff. Not a lag finding.

**Strengthened by the critic, decisively:** `babel-preset-expo/build/index.js:262`
defaults `runtime: 'automatic'` and `babel.config.js` does not override it, so JSX
compiles to `react/jsx-runtime`, which contains **zero** `defaultProps`
references. `React.createElement` _does_ still resolve them
(`react.production.js:432`) — but the app never calls it. `applyTextDefaults()` is
inert. **Gap in my own audit: I never checked `TextInput` separately** — confirm
that before writing the fix.

---

### N7 — the real per-hop cost: `BookingHomeScreen` mounts TWICE on every messenger→Secure hop — **HIGH (missed by the first draft)**

`MainNavigator.tsx:1520` seeds the stack `initial: false` → `[BookingHome,
SecureLanding]`, so the **734-line** `BookingHomeScreen` mounts as the stack floor
_while the spinner is showing_. N1's reset then replaces the stack: a LITE client
unmounts it and mounts a **second** copy inside `SecureTabNavigator`'s Home tab
(`SecureTabNavigator.tsx:96`); a PRO client re-mints its key and remounts it in
place.

**This is what N1's keyless routes actually buy you** — I named the mechanism and
then priced it as a race condition instead of an every-hop double mount.

---

### N8 — a duplicated round trip plus a permanent 8-second poll installed on arrival — **HIGH (missed by the first draft)**

`BookingHomeScreen.tsx:176` calls `loadProApplication()` — **the same
`/pro-applications/me` that `SecureLandingScreen` just awaited** — then
`loadBookings()`, an `AsyncStorage.getItem`, and:

```ts
setInterval(loadBookings, 8000); // BookingHomeScreen.tsx:181
```

which then runs for as long as the Secure home is focused. Nothing in the first
draft mentioned any of this.

---

### N9 — the other door was never checked — **OPEN GAP**

`ProfileTab` (`MainNavigator.tsx:1546`) is also "another menu from messenger" and
touches **no** `SecureLanding` at all. **If that is the founder's actual gesture,
N1/N3/N4/N7/N8 are all irrelevant and this audit has no explanation for the
symptom.** This must be settled by asking the founder which menu they meant, or by
a device trace — it is not decidable from source.

---

### N6 — `BravoAlertHost`'s "mounted ONCE" rationale does not hold on Android — **MED**

`src/components/BravoAlertHost.tsx` now renders `<Modal visible={!!request}>`
permanently, on the stated rationale that a conditionally-rendered Modal
starts/stops an Android surface each time. But `Modal.js:280-288` —
`_shouldShowModal()` returns `this.props.visible === true` on Android (the
`isRendered` branch is `Platform.OS === 'ios'` only) and `render()` returns `null`
when false. The surface churns exactly as before on Android, so if the B-647 crash
mechanism was surface churn, this change does not address it.

---

## 4. Checked and RULED OUT — do not re-propose without new evidence

| Candidate                                                          | Why it is dead                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~The chat list re-rendering on tab tap~~                          | **WITHDRAWN — this entry was wrong.** `ChatListRow` is `React.memo` (`:1084`) and `renderChatRow`'s deps (`:749`) exclude `activeTab`, so the **rows** bail out — but the **pane** does not, and the `FlatList` itself cannot bail because of M5's inline style prop. See NEW-1.                                |
| `useFocusEffect` handlers re-firing on a tab tap                   | `activeTab` is local `useState`; no navigation event fires, so none of the four focus effects (`:245`, `:411`, `:441`) re-run.                                                                                                                                                                                  |
| `ordered` / `filtered` / `renderChatRow` recomputing on tab tap    | All memoised on stable deps; `isDept` is a `useCallback` over two immer-stable refs.                                                                                                                                                                                                                            |
| `selectCallMessages` being the churn source _by itself_            | The WeakMap does return a stable frozen reference **per `messages` identity**. The defect is that the identity changes 5–10× per message (M2), not that the cache is broken.                                                                                                                                    |
| A closed modal rendering its subtree                               | RN `Modal` returns `null` when not visible (`Modal.js:280-289`). Confirmed — and this is _also_ why NS1 re-runs on every open.                                                                                                                                                                                  |
| A B-623 server role re-check blocking the sheet                    | `departmentApi.listMembers` sits in `sendToChannel` (`ShareNewsSheet.tsx:150-182`) — at **send** time, not open time. `allowShareToChannel` is pure.                                                                                                                                                            |
| Crypto / SQLCipher work on the share-open path                     | `getMessengerRuntime('production')` is reached only inside `send`/`sendToChannel`. Avatar backfill is debounced 300 ms and batched.                                                                                                                                                                             |
| `ChatScreen`'s +225 lines in this commit                           | Confined to `ForwardList`, which renders only inside the forward sheet. Not in the messenger hot path.                                                                                                                                                                                                          |
| `messageMirror.ts`'s new `computeConvMirrorVersion`                | `mirrorConversation` has two callers (`mirrorBootstrap.ts:243,289` boot sweep, `messengerStore.ts:671` delete). Not per-message. B-648 is a net boot **win**.                                                                                                                                                   |
| `MessengerTabBar` itself                                           | 5 static items, no store reads, `onSelectTab={setActiveTab}` stable. Negligible.                                                                                                                                                                                                                                |
| Shadows / gradients / blur                                         | Measured dead ends (B-279 / B-285). GPU idle at 3–7 ms vs a 16.7 ms budget. Not re-opened.                                                                                                                                                                                                                      |
| **A native Mapbox view mounting on the messenger→other-menu path** | `BravoMap` has exactly two consumers — `AgentNavigator.tsx:167` and `CpoNavigator.tsx:81`. The client shell's map screens are **WebView** (`ProLiveMissionScreen.tsx:20,446`). `BookingNavigator` registers `VBGMap`, `ProLiveMission`, `ZoneMap` and none reach `BravoMap`. No native map mounts on this path. |
| `findNavigatorWithRoute` walking the tree per tap                  | `departmentalEntry.ts:66-78` is a bounded ancestor walk, `MAX_DEPTH = 10` (`:59`), one `getState()` per level. Negligible — and it is not on the messenger→Secure path at all (only the Channels exit-hop uses it).                                                                                             |
| `InteractionManager` / `setTimeout` delaying the transition        | The only `InteractionManager` uses are `MainNavigator.tsx:594` and `:711`, both in the boot pipeline. The 30 ms `setTimeout` at `:377` is the deliberate B-95 hold-frame.                                                                                                                                       |
| `tapGuard` swallowing the first tap                                | `src/navigation/tapGuard.ts` guards `goBack` only, is unchanged in these three commits, and the tab/chevron doors do not route through it.                                                                                                                                                                      |
| Something new in `App.tsx` running per render                      | The entire `App.tsx` diff is one side-effect import at `:6` — which is N5.                                                                                                                                                                                                                                      |
| `detachInactiveScreens` being off                                  | It is on (bottom-tabs default), so native views _are_ detached. The real gap is `freezeOnBlur` — see N2.                                                                                                                                                                                                        |
| `@rnmapbox/maps` **mounting a map** on this path                   | Dead: `BravoMap` has two consumers only (above) and no map mounts on the messenger→Secure path. _(Its module-eval-at-boot cost is a separate OPEN question — moved out of this table, see below.)_                                                                                                              |

**Moved OUT of the ruled-out list — an UNVERIFIED item does not belong in a
"do not re-propose" table** (process correction from the critic pass):

- **`@rnmapbox/maps` is now module-evaluated at JS boot for every account**
  (`MainNavigator.tsx:48` → `AgentNavigator.tsx:19` → `AgentLiveTrackerScreen.tsx:45`
  → `BravoMap.tsx:33`), and `NATIVE_MAP_ENABLED` now defaults **on**
  (`nativeMapbox.ts:31`). Boot-time only, not per-navigation — but **how much
  native work the module evaluation triggers was never measured.** OPEN.
- **`useIntelFeed`'s own polling cadence** (M10) was never read. OPEN.

---

## 5. Not touched — security stop-condition

`src/modules/messenger/crypto/db.ts:557` and `:727` set
`PRAGMA cipher_memory_security=ON`. B-650 (this same commit) capped SQLCipher's
**log** verbosity, which was real and worth doing. The setting itself still forces
a memset-on-free allocator and a failing `mlock()` per allocation, and SQLCipher
documents a throughput cost that every messenger read pays.

**This is a security control under the CLAUDE.md stop-conditions. Recorded here as
context only. It must not be changed without architecture approval.**

---

## 6. Fix plan, in dependency order

**Root-cause ordering after the critic pass: M1 is the only regression; M2/M3/M4
are pre-existing properties it promoted. Fix M1 first — the rest stop mattering.**

| #   | Fix                                                                                                                                                                                                                                                                                            | Addresses                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | **Restore the conditional mount** (`{activeTab === 'Calls' && …}` and the same for Chats). This is the root fix and it is a partial revert of one hunk.                                                                                                                                        | M1, NEW-1, NEW-2, M7-inverse                    |
| 2   | Virtualise the calls list (`FlatList`) + `React.memo` the row, so the mount fix 1 restores is cheap — otherwise fix 1 reintroduces the founder's _original_ "switch then back is laggy" complaint, which is what the perf spine was trying to solve. **Fixes 1 and 2 must ship together.**     | M4 (dominant residual)                          |
| 2b  | `CallsLogBody`: replace the whole-map `conversations` subscription with a **WeakMap-cached narrow selector** (`{convId: {name, type, peerId}}`) consumed via `useShallow` — NOT a bare `useShallow(s => s.conversations)`, which does not help (see the note under M3). Hygiene once 1+2 land. | M2, M3                                          |
| 3   | `React.memo` `ArticleRow` in `NewsFeedScreen` — the share tap currently re-renders every article in an uncapped, non-virtualised `ScrollView`. `shareArticle` is already `useCallback`'d, so this is a **one-line fix**. **Both critics rate this the strongest finding in the news lane.**    | NS7                                             |
| 4   | Give `useDiscoveredContacts` a module-level session cache + in-flight dedup, the way `savedContacts.ts:36-37` already does — kills a duplicated network round trip on every picker open, at all 6 call sites                                                                                   | NS1, NS5                                        |
| 5   | `freezeOnBlur: true` on the three root `Tab.Screen`s (**NOT** a global `enableFreeze()` — see the objection under N2)                                                                                                                                                                          | N2                                              |
| 6   | Hoist `contentContainerStyle` out of the render body                                                                                                                                                                                                                                           | M5                                              |
| 7   | Key the search effect on a joined id string, not `ordered`'s object identity                                                                                                                                                                                                                   | M6                                              |
| 8   | Reverse index for `deptGroupByChannel`; `useMemo` `rows`/`items`; `useCallback` `renderItem`/`initialsDisc`/`pickContact`; pass the pre-folded `q`                                                                                                                                             | NS2, NS3, NS6                                   |
| 9   | Fix the FAB `bottom` double-count                                                                                                                                                                                                                                                              | M9                                              |
| 10  | Extend `messengerRenderPerf.test.ts` to cover `CallsLogBody`, and stop stubbing `useMessengerStore` in `emergencyCallsLog.test.tsx` so the subscription is observable                                                                                                                          | M8 — the pin that would have caught all of this |

**Deliberately NOT fixed in this pass** (mechanism real, cost sub-millisecond on a
realistic account, or off-symptom): NS8 (IntelFeed already re-renders at 1 Hz from
its own clock, and it is the wrong screen for this share), NS9 (drill-in only),
M10 (pre-existing, not a regression).

**Separate tickets, not lag:**

- **N5** — `textDefaults` is inert, so the large-font header clipping shipped as
  fixed and is not. Deserves its own B-number. Check `TextInput` too.
- **N6** — `BravoAlertHost`'s Android surface-churn rationale does not hold.
- **N7 / N8** — the `BookingHome` double mount, the duplicated
  `/pro-applications/me`, and the 8 s poll. These are the real navigate-out cost
  and they need their own change; they are not a messenger fix.

> **⚠️ N9 is an open gap in this audit.** `ProfileTab` is also "another menu from
> messenger" and touches no `SecureLanding`. If that is the founder's actual
> gesture, the entire navigate-out lane is irrelevant. **Ask which menu before
> spending effort on N7/N8.**

---

## 7. Regression contract

Per CLAUDE.md, every fix needs a test that was **RED first**, mutation-proved by
reverting the fix. Fixes 1, 3, 4, 6 are source-scan-pinnable (comment-strip first;
these files are CRLF, so anchor on `\r?\n`). Fixes 2, 5, 7 are behavioural and
belong in the `app` project.

**Gates:** `npx jest --selectProjects messenger-crypto` **twice** (B-126 flake
rule) + `npx jest --selectProjects app --testPathPattern "screens/messenger"` +
`npm run typecheck` (must not exceed 47 — note `main` is already at 48).

---

## 7b. What was actually SHIPPED (2026-08-24)

| Fix                                                                                                                                                                                                                                                                        | Files                                      | Pinned by                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Conditional tab mounts restored** — the `display:'none'` panes are gone, `tabShown`/`tabHidden` deleted. Fixes M1, and with it NEW-1, NEW-2 and the M7-inverse UI-thread layout burst.                                                                                   | `MessengerHomeScreen.tsx`                  | `messengerPersistentTabs.test.ts` (**assertion REVERSED** — it used to pin the regression) |
| **Calls log virtualised** — `ScrollView` + `visible.map` → `FlatList` with a `React.memo` row, stable `keyExtractor`/`renderItem`/`contentContainerStyle`. The paired half of the fix above.                                                                               | `CallsLogScreen.tsx`                       | `callsLogVirtualized.test.ts` (**NEW**, mutation-proved 7/7 RED against pre-fix source)    |
| **Chat list `contentContainerStyle` memoised** (M5)                                                                                                                                                                                                                        | `MessengerHomeScreen.tsx`                  | —                                                                                          |
| **Search effect keyed on a joined id string**, not `ordered`'s identity (M6)                                                                                                                                                                                               | `MessengerHomeScreen.tsx`                  | —                                                                                          |
| **FAB `bottom` double-count** (M9) — fixed _for free_ by removing the wrapper that changed its containing block                                                                                                                                                            | `MessengerHomeScreen.tsx`                  | —                                                                                          |
| **`React.memo(ArticleRow)`** — the share tap no longer re-renders every article in an uncapped `ScrollView` (NS7)                                                                                                                                                          | `NewsFeedScreen.tsx`                       | —                                                                                          |
| **Contact-discovery session cache** (5 min TTL, keyed `${ownPhoneE164}:${region}`, cleared on sign-out) — the share picker no longer re-sweeps the address book and re-hits `/users/lookup` on every open (NS1, NS5)                                                       | `useDiscoveredContacts.ts`, `authStore.ts` | `contactDiscoveryHooks.test.tsx` (**4 NEW**, the load-bearing one mutation-proved RED)     |
| **ForwardList model memoised** — `rows`/buckets/`contacts`/`items` in `useMemo`, module-level `keyExtractor` (NS2, NS3, NS6)                                                                                                                                               | `ChatScreen.tsx`                           | —                                                                                          |
| **Two lying comments corrected** in `useDiscoveredContacts.ts`: the docblock that claimed libphonenumber-js (it is hand-rolled regex — this prose is what misled the first draft of this audit), and a cache comment describing a single-flight that was never implemented | `useDiscoveredContacts.ts`                 | —                                                                                          |

**A real bug this work introduced and caught:** the first pass put `items`'s
`useMemo` _after_ `ForwardList`'s empty-state early return, making a hook
conditional. Hook order would then differ between the "no targets" and "some
targets" renders — a crash waiting for the first user whose last chat disappears
while the picker is open. **Caught by `eslint react-hooks/rules-of-hooks`, by no
test.** Worth remembering: the suites were fully green with it in place.

### Deliberately NOT shipped

- **N2 (`freezeOnBlur` on the root tabs).** This is the one change with app-wide
  blast radius — freezing blurred subtrees changes when effects and timers run
  everywhere, including calls, backup and the mission lanes. It is also
  **pre-existing, not part of the regression the founder reported.** It needs its
  own change and its own device pass; applying it blind with no device attached
  would be reckless. Recommended, not done.
- **Fix 2b (narrow WeakMap selector for M2/M3).** With M1 fixed, `CallsLogBody`
  unmounts again, so these are back to their pre-regression cost and are bounded
  by the new virtualisation. Hygiene, not lag. Both critics agreed: fix M1 and
  these stop mattering.
- **N7/N8** (`BookingHome` double mount, duplicated `/pro-applications/me`, the
  8 s poll), **N5** (`textDefaults` inert), **N6** (`BravoAlertHost`), **M10**,
  **NS8**, **NS9** — separate tickets, listed in §6.

### Gates run

| Gate                                                                                  | Result                                                                           |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `npx jest --selectProjects messenger-crypto` ×2 (B-126 flake rule)                    | **548/548 suites, 6725/6725 tests** — green both runs                            |
| `npx jest --selectProjects app --testPathPattern "screens/messenger"`                 | **699 passed** (baseline 688; +11 from the new pins)                             |
| `npx jest --selectProjects app --testPathPattern "screens/messenger\|news\|contacts"` | **810 passed**, 0 failed                                                         |
| `npm run typecheck`                                                                   | **48** — unchanged from the pre-existing count on `main` (baseline file says 47) |
| `npx eslint` on all changed files                                                     | **0 errors** (pre-existing warnings only)                                        |

---

## 8. OWED

- **Device A/B sign-off.** No device was attached. M7 in particular is unresolved
  without one, and every ms figure here is either a V8 microbenchmark floor or an
  unmeasured mechanism. Interleave runs OLD/NEW/OLD/NEW — thermal drift makes
  sequential runs lie.
- **The `+1` typecheck regression already on `main`** is unrelated to this work but
  blocks a push until fixed or re-baselined.
- **Lane 3 (navigating _out_ of messenger into another shell)** is reported
  separately below once its audit lands.
