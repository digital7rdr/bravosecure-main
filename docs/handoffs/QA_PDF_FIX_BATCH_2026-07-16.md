# QA PDF Fix Batch — 2026-07-16 (Handoff)

> **Source:** boss QA PDF (`46137b37-9bca-4a1a-93ea-16be374b6d48_Untitled.pdf`, 23 pages,
> 11 annotated screenshots) + 2 extra requests from the product owner (chat link previews,
> global blue-background sweep). **This document is the task list AND the operating
> procedure.** No code was changed while writing it — investigation only.
>
> **For the implementing Claude session:**
>
> 1. Read `LOOP.md` (root) — the maker → verifier → auditor → risk-reviewer loop applies to
>    every task here.
> 2. Read `DESIGN_REVIEW_LOOP.md` (root) — most tasks below are UI tasks; the obsidian
>    design-system gate **G8** (`#07090D` bg / cobalt `#5B8DEF`) and the device matrix apply.
> 3. Read `sqa.md` §Device & Identity Reference for ADB serials + test accounts.
> 4. Work ONE task at a time. Run that task's **Fix Loop** (below) until its exit criteria
>    hold. This batch is registered in `sqa.md` as **B-90** — log each completed fix as a
>    `B-90 UPDATE` entry there (or claim a fresh `B-##`; re-check the last used number first,
>    parallel sessions ship).
> 5. Version bump / release: follow the release-state memory gotchas (pull first, check
>    `android/app/build.gradle` versionCode, `npm install` after pull, split build & upload).

---

## 0. THE FIX LOOP (mandatory, run per task)

Every task below MUST be driven through this loop. Do not mark a task done after one pass.

```
┌─▶ 1. REPRODUCE  — build/install via ADB (or Metro dev), see the bug with your own eyes.
│         If you cannot reproduce, say so in sqa.md — do NOT "fix" blind.
│  2. ROOT-CAUSE  — confirm the cause matches the "Why it happens" section of the task.
│         If reality differs, update this doc's task section BEFORE coding.
│  3. FIX         — smallest possible diff, in the files listed. No drive-by refactors.
│  4. SELF-VERIFY — re-run the repro from step 1: bug gone? golden path works?
│         Also exercise ONE error path (offline / denied permission / cancelled flow).
│  5. IMPACT PASS (the "second perspective") — MANDATORY for every task:
│         a. Run `get_impact_radius` (code-review-graph MCP) on every function/file touched.
│         b. List every OTHER screen/flow that imports or renders the changed code
│            (the task's "Blast radius" section pre-lists the known ones — verify it).
│         c. Manually smoke each listed adjacent flow on device.
│         d. Ask adversarially: "what did this change break?" — check props/contracts,
│            navigation params, shared styles, shared components, backend consumers.
│  6. GATES       — `npm run typecheck` (≤ baseline 47), `npm run lint`, targeted Jest
│         project (task lists which), then `npm test` before final sign-off of the batch.
│  7. DESIGN PASS — for UI tasks: DESIGN_REVIEW_LOOP.md audit categories (responsive
│         320–430dp, fontScale 1.3, safe-area, contrast ≥ 4.5:1, states). G8: obsidian only.
│  8. EXIT?       — ALL exit criteria of the task hold AND impact pass found nothing new?
│         ── no ──▶ loop back to 3 (or to 2 if the root cause was wrong).
│         ── yes ─▶ log in sqa.md, commit (small, per-task), next task.
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Hard rules during the loop**

- A fix that breaks any adjacent flow in step 5c is NOT done — loop again.
- Never bypass security gates (sealed sender, vault MFA, cert verification) to make UI work.
- Screens are E2EE-adjacent: never log message plaintext/keys while debugging (log-audit test enforces).
- Do not commit on a red gate; never `--no-verify`.

---

_Sections T-01 … T-13 follow. Each has: Problem → Why it happens → Fix (files) → Blast
radius → Task-specific loop additions → Exit criteria._

---

## Task index

| ID   | PDF pages | Area           | One-liner                                                                 |
| ---- | --------- | -------------- | ------------------------------------------------------------------------- |
| T-01 | 2–3       | CPO onboarding | Rename "SIA Licence" → "Security License" on Document Upload              |
| T-02 | 4–5       | Booking        | "Number of passengers / Excluding CPO and driver" text overflows its box  |
| T-03 | 6–7       | Home/News      | VIRTUAL BODY GUARD banner button does nothing                             |
| T-04 | 8–9       | Messenger      | Calls-screen LINKS button dead + build WhatsApp-style Links browser       |
| T-05 | 10–11     | Client drawer  | Remove dead "Agent Portal" item (Bravo Pro is ALSO dead — see note)       |
| T-06 | 12–13     | Messenger      | Chat Info: phone below name, "Recovery" text unreadable, navy bg          |
| T-07 | 14–15     | Booking/Region | Add South Africa zone, 3-letter codes, region flag, map preload           |
| T-08 | 16–17     | Auth           | Kill yellow Android autofill highlight on sign-in inputs                  |
| T-09 | 18–19     | Auth           | Sign-in header visual hierarchy ("SIGN IN" eyebrow too small/faint)       |
| T-10 | 20–21     | Agent app      | "AG" avatar → real initials algorithm + "(AGENT)" suffix + photo upload   |
| T-11 | 22–23     | Messenger      | "Last seen 13h ago" pill overlaps call icons in chat header               |
| T-12 | —         | Messenger      | Link previews for URLs (YouTube etc.) — partially built; finish + privacy |
| T-13 | —         | Design system  | Global sweep: every navy/blue page background → obsidian `#07090D`        |

**Suggested order:** T-01, T-08, T-09, T-05, T-03, T-02, T-11, T-06, T-04, T-12, T-10, T-07, T-13
(quick wins first; T-13 last because earlier tasks already migrate some screens and T-13 is the
sweep that catches the rest; T-07 has backend + release coordination).

---

## T-01 — "SIA Licence / CPO Profile" → "Security License / CPO Profile"

**Problem (PDF p2–3).** On the CPO onboarding **Document Upload** screen (Compliance Pack),
the first item reads "SIA Licence / CPO Profile". Boss: _"Change to security license."_ SIA is
a UK-only term; the product now spans UAE/KSA/BD/etc.

**Why it happens.** The label is a hardcoded local string in the screen's `META` map:

- `src/screens/agent/AgentDocsUploadScreen.tsx:30` —
  `sia: {icon: 'certificate-outline', title: 'SIA Licence / CPO Profile', req: 'REQ'}`
- The screen always renders its own local `META` title; the server `refresh()` only overrides
  document `state`, never the title (lines 55–58). So this is **display-only**.

**Fix.**

1. `src/screens/agent/AgentDocsUploadScreen.tsx:30` — change title to
   `'Security License / CPO Profile'`.
2. **Do NOT rename** the slot key `'sia'` (type at line 26) — the backend keys documents by
   slot: `apps/auth-service/src/agents/dto/agent.dto.ts:12` (`DOC_SLOTS = ['sia', ...]`).
   Changing the key breaks existing uploaded documents.
3. Optional consistency: the backend seeds a stored display title
   `'SIA Licence / CPO Profile'` at `apps/auth-service/src/agents/agent.service.ts:254` and
   `apps/auth-service/src/org/org-cpo.service.ts:18`. Update those strings ONLY if the
   ops-console displays the stored title (check `apps/ops-console` usage first). If updated,
   remember existing DB rows keep the old title — a data update (SQL) would be needed for
   already-seeded agents; decide with the impact pass whether that's worth it.
4. **Out of scope trap:** a _different_ screen (`src/screens/agent/AgentKYCScreen.tsx:46`,
   kind `sia_licence`, and ops-console label map
   `apps/ops-console/src/app/agents/[id]/page.tsx:46`) also says "SIA Licence" — that's the
   4-slot KYC flow, not this screen. Ask the boss whether that flow's label should change too;
   default: change the visible label there as well for consistency, keep the `sia_licence`
   kind key untouched.

**Blast radius.** Slot keys `'sia'` / KYC kind `sia_licence` feed backend validation and
ops-console review — keys must stay. Label-only change has near-zero radius.

**Task loop additions (run inside §0 loop).**

- Verify: build → CPO account → Document Upload screen shows "Security License / CPO Profile";
  upload a doc into that slot → still lands in slot `sia` and shows DONE; ops-console agent
  review page still lists the document.
- Impact pass: grep `SIA` (case-insensitive) across `src/`, `apps/` — confirm no other
  user-visible surface still shows the old term unless intentionally deferred; confirm no code
  compares against the _title_ string anywhere (`grep "SIA Licence"`).
- Regression: submit-for-review flow end-to-end (all 6 slots DONE → submit button works).

**Exit criteria.** New label on device; upload + admin review unaffected; grep shows no
`title`-string comparisons; typecheck/lint green.

---

## T-02 — Booking Schedule: passengers label overflows its box

**Problem (PDF p4–5).** On Schedule (STEP 3 · PICK-UP & TIME), the row "Number of
passengers / Excluding CPO and driver" doesn't fit — the sublabel is clipped mid-word
("Excluding CPO and driv…" / cut at the box edge). _"It not fitting in text box."_

**Why it happens.** `src/screens/booking/BookingDateTimeScreen.tsx`:

- Row markup lines 366–406; the label block (374–377) is `flex:1, minWidth:0` with BOTH texts
  `numberOfLines={1}`.
- The right control cluster is **~136px of fixed widths** (`counterBtn` 38 + `counterVal` 44 +
  `counterBtnPri` 38 + two `gap:8` — styles 592–604), icon column 30 + gap 12 (585–589),
  container `height: 60` **fixed** with 26px padding (577–582). On a 360dp screen the text
  column gets ≈ 116px — "Number of passengers" needs ~150px+ at 14px.
- **Aggravator:** the sheet is wrapped in `scaleTextStyles(...)` (line 488 →
  `src/utils/scaling.ts:68-74,92-108`): on ≥414dp phones fonts scale up to 1.2× but the fixed
  widths don't, so bigger phones overflow MORE.

**Fix.** In `BookingDateTimeScreen.tsx` styles 577–604 + label block 374–377 (pick the
combination, iterate in the design pass):

1. Relax `counter` `height: 60` → `minHeight: 60` + vertical padding.
2. Sublabel `numberOfLines={2}` so "Excluding CPO and driver" wraps instead of clipping.
3. Trim fixed widths: `counterVal` 44 → 36, keep buttons ≥ 38 for touch targets (44dp min
   with hitSlop), or drop the icon column at < 360dp.
4. Re-check at fontScale 1.3 AND on a 414dp+ device (the scaling aggravator) — this is the
   test the current layout fails.

**Blast radius.** This screen is part of the **Lite booking flow** → per CLAUDE.md the
`docs/runbooks/LITE_BOOKING_LOOP.md` companion loop applies (check its trigger list; a
style-only change still needs the client-lane smoke). Check whether the `counter*` styles are
used by other counters on the same screen (protectors/vehicles rows) — a shared style change
moves them all.

**Task loop additions.**

- Verify at 320 / 360 / 390 / 414 / 430dp + fontScale 1.3: full label + sublabel visible, no
  clip, counter buttons still aligned; +/- still work; the info card below still reads.
- Impact pass: complete a booking end-to-end (schedule → confirm → dispatch happens) —
  passengers count reaches the API unchanged; run `npm test -- --selectProjects=booking`.
- Regression: the hour/min wheel above the row unaffected (same ScrollView).

**Exit criteria.** No clipped text at any matrix width/scale; booking project tests green;
one end-to-end booking passes.

---

## T-03 — "VIRTUAL BODY GUARD" banner does nothing

**Problem (PDF p6–7).** The purple VIRTUAL BODY GUARD banner at the bottom of the news hub
does nothing when pressed. It must open the VBG page.

**Why it happens.** `src/screens/news/NewsHubScreen.tsx:181-187` — the `TouchableOpacity`
(line 183) has **no `onPress` prop at all**. It shows the press animation
(`activeOpacity={0.85}`) so it _feels_ broken rather than decorative. Sibling `SectionCard`s
in the same file navigate fine (lines 160, 174) — only this CTA was left unwired.

**Fix.**

1. `NewsHubScreen.tsx:183` — add
   `onPress={() => navigation.navigate('SecureTab', {screen: 'VBGHome'})}`.
2. Type problem to solve properly: the screen's `Nav` is typed against
   `MessengerStackParamList` (lines 13–18) and VBG routes live in `BookingStackParamList`
   (`src/navigation/types.ts:188-193`, registered in
   `src/navigation/BookingNavigator.tsx:88-153`, mounted as tab `SecureTab` in
   `MainNavigator.tsx:655-656`). Widen `Nav` to a `CompositeNavigationProp` (copy the working
   pattern from `src/screens/dashboard/DashboardScreen.tsx:73-75`, whose `goToVBG` at line 245
   does exactly this navigation) — do NOT paper over it with an `as unknown as` cast; that
   exact cast is what hid T-05's dead routes from typecheck.

**Blast radius.** Cross-stack navigation from the Messenger stack to the Secure tab — verify
back behavior (hardware back from VBGHome should return sensibly, not exit). NewsHub is
reachable from more than one place — test each entry.

**Task loop additions.**

- Verify: Home → news hub → press banner → VBGHome opens; back returns; repeat from every
  NewsHub entry point (dashboard card / tab).
- Impact pass: other NewsHub cards (OPEN INTEL FEED, OPEN MY FEED, BROWSE ALL / NewsAds)
  still navigate; VBG flows (Nearby/SRA/OSINT/GeoRisk/Emergency) unaffected — they're
  untouched, smoke VBGHome loads its location prompt correctly when arriving via this new path.
- Typecheck MUST pass without new casts.

**Exit criteria.** Banner navigates on device from all entry points; back works; typecheck
green with the composite type (no cast).

---

## T-04 — Calls screen "LINKS" button dead + WhatsApp-style Links browser

**Problem (PDF p8–9).** The CALLS screen header has a "LINKS >" button that does nothing.
Boss wants WhatsApp-parity: a browser of all links shared in chats. Also asked: _"find out the
backend for links — does it exist or not."_

**Why it happens.**

- `src/screens/messenger/CallsLogScreen.tsx:160-163` — the `TouchableOpacity` has **no
  `onPress` at all**. It's a static mock control that shipped unwired.
- There is **no Links/SharedMedia screen anywhere** (grep `MediaGallery|SharedMedia|LinksScreen`
  → nothing) and no `Links` route in `src/navigation/types.ts`.
- **Backend answer: does not exist and CANNOT exist.** Messages are E2EE (sealed sender); the
  relay never sees plaintext, so it can't index links (`apps/messenger-service` has no
  links/preview route — confirmed). Links MUST be computed client-side from the local
  SQLCipher DB.
- What DOES exist client-side: the local messages table (`src/modules/messenger/crypto/db.ts:101-156`)
  stores decrypted `content` per message (indexes at 159–162; **no url column/index**), and a
  URL regex + extractor already exists: `src/modules/messenger/ui/linkPreview.ts:23` (`URL_RE`)
  and `firstUrlIn()` (26–30).

**Fix.**

1. New screen `src/screens/messenger/LinksScreen.tsx` (follow `CallsLogScreen` structure):
   query the local DB for text messages containing links —
   `SELECT conversation_id, id, content, created_at FROM messages WHERE type='text' AND content LIKE '%http%' ORDER BY created_at DESC LIMIT …`
   (paginate), extract URLs with the existing `URL_RE` (reuse — do NOT write a second regex),
   render rows: favicon/preview (reuse `LinkPreviewCard` or a slim variant), URL, chat name,
   date. Tap → `Linking.openURL`; long-press → jump to conversation (navigate to `Chat` with
   the conversation id).
2. Register route `Links` in `src/navigation/MessengerNavigator.tsx` (next to `CallsLog`
   registration, lines 135–136) + add to the param list in `src/navigation/types.ts` (~line 65).
3. Wire the button: `CallsLogScreen.tsx:160` add
   `onPress={() => navigation.navigate('Links')}`.
4. DB access must go through the existing message-store layer
   (`src/modules/messenger/store/sqlMessageStore.ts`) — add a `queryLinkMessages(offset, limit)`
   helper there rather than raw SQL in the screen. No schema change needed for v1 (LIKE scan
   is fine at current message volumes); if slow on huge DBs, a derived `has_link` column can
   be added later as schema v14 — do NOT do that pre-emptively.

**Security rails.** Read-only over already-decrypted local rows — no crypto surface touched.
NEVER log message `content` while debugging (log-audit test). The screen must respect
disappearing messages (deleted rows disappear naturally since it queries live).

**Blast radius.** `sqlMessageStore` is shared by the whole messenger — the new query must be
additive only. `MessengerNavigator`/`types.ts` param-list edits can break typecheck on other
screens if done sloppily. LinkPreviewCard reuse touches T-12's file.

**Task loop additions.**

- Verify: send 3 links (YouTube, plain https, bare `www.`) in a 1:1 and a group → Calls →
  LINKS shows all, newest first; tap opens browser; empty state renders when a fresh account
  has no links.
- Impact pass: run messenger regression — send/receive 1:1 + group text, open CallsLog tabs
  (ALL/MISSED/VOICE/VIDEO still work), `npm run test:crypto` (store layer touched).
- Perf: 1k-message conversation — screen opens < 1s; scrolling smooth (paginate, don't load all).
- Design pass: obsidian bg (`#07090D`) — do not copy CallsLogScreen's navy tokens (see T-13;
  CallsLogScreen itself is on the navy palette today).

**Exit criteria.** Button navigates; links listed from local DB across all chats; no plaintext
logged; crypto suite green; adjacent Calls tabs unaffected.

---

## T-05 — Remove "Agent Portal" from the client profile drawer

**Problem (PDF p10–11).** In the client profile drawer (Baine K. / Individual), "Agent
Portal" does nothing when pressed. Boss: _"This button not working. remove these button Agent
portal."_

**Why it happens.** `src/screens/dashboard/DashboardScreen.tsx`:

- Menu item defined at line 99:
  `{icon: 'headset', label: 'Agent Portal', action: 'agent', enabled: true, divider: true}`.
- Its handler (lines 667–669) calls `navigate('AgentTab')` — **`AgentTab` is not a registered
  route anywhere** (client Tab.Navigator registers only Dashboard/MessengerTab/SecureTab/
  ProfileTab — `src/navigation/MainNavigator.tsx:637-676`; `AgentNavigator` mounts only for
  `authedRoute === 'agency'`, line 633–635). The `as unknown as` cast hid this from typecheck.
  Result: silent no-op.

**Fix.**

1. Delete the `PROFILE_MENU` entry at `DashboardScreen.tsx:99`.
2. Cleanup: remove `'agent'` from the action union (line 91) and the `case 'agent'` block
   (lines 667–669).
3. The removed entry carried `divider: true` (renders the separator, line 679) — move
   `divider: true` to the "Bravo Pro" entry (line 98) so the visual separation before Log Out
   survives.

**⚠️ Found during investigation — decide, don't ignore:** "Bravo Pro" (line 98, handler 664–666)
is **also dead** — it navigates to `'ProTab'`, which is equally unregistered. The real screen is
`ProLanding` inside the booking stack (`src/navigation/BookingNavigator.tsx:251-252`); the
working pattern is `navigate('SecureTab', {screen: 'ProLanding'})` (cf. `MainNavigator.tsx:249`).
The PDF's red marks touch both rows. Recommended: fix Bravo Pro's navigate in the same diff
(1 line) rather than shipping a drawer with another dead item. If the boss wants it removed
instead, remove it the same way as Agent Portal.

**Blast radius.** Drawer only. Check nothing else reads `PROFILE_MENU` or the `'agent'`
action (grep both). Removing a switch case — make sure the switch still has a default/no
fall-through issue.

**Task loop additions.**

- Verify: open drawer → Agent Portal gone; divider before Log Out still renders; My Profile /
  My Bookings / Bravo Pro / Log Out all still work (Bravo Pro now lands on ProLanding if fixed).
- Impact pass: agency accounts still get their real Agent portal (log in as agency →
  `AgentNavigator` mounts — untouched code path, but smoke it anyway).
- fontScale 1.3 + 320dp: drawer rows unchanged.

**Exit criteria.** Item gone, drawer fully functional, agency flow untouched, typecheck/lint
green.

---

## T-06 — Chat Info: phone number under name · "Recovery" text unreadable · navy bg

**Problem (PDF p12–13).** Three issues on CHAT INFO (1:1): (a) boss wants the contact's
phone **number shown below the name** like WhatsApp ("Add number of person"); (b) the
"Recovery" label next to Reset Secure Session renders near-**black on dark bg** (unreadable);
(c) the screen's background is **navy blue**, not the app's obsidian.

**Why it happens.** All in `src/screens/messenger/ChatInfoScreen.tsx`:

- (b) Line 658 `<Text style={styles.settingRight}>Recovery</Text>`; style at line 922 is
  `{fontSize: 11, fontWeight: '700'}` — **no `color`**, so RN's default (near-black) applies.
  The two sibling usages override inline with `{color: '#1E88FF'}` (lines 632, 641); this one
  was missed.
- (c) Line 880 `root: {flex: 1, backgroundColor: Colors.background}` where
  `Colors.background = '#0A1F3F'` (Command Navy — `src/theme/colors.ts:15`). Borders/dividers
  also navy (`#1C3B66`/`#244C82`, e.g. lines 882, 899). The chat thread itself already uses
  obsidian `CHAT_BG = '#07090D'` (`ChatScreen.tsx:72`).
- (a) The render slot **already exists and renders empty**: line 521
  `{!!subtitle && <Text style={styles.profilePhone}>{subtitle}</Text>}`. `subtitle` comes from
  `resolveUserPhone(conversation.peer.userId)` (lines 398–400), and `resolveUserPhone`
  (lines 90–93) only knows the **dev fixture** `DEV_CONTACTS` — real users → `undefined`.
  The peer's real phone exists in the model ONLY at contact-discovery time:
  `POST /users/lookup` → `DiscoveredContact.phone`
  (`packages/messenger-core/src/transport/usersClient.ts:14-20`), surfaced in
  `src/modules/messenger/contacts/useDiscoveredContacts.ts:167-173` (`phoneE164`), but the
  conversation upsert (lines 190–196) persists only the `name` and **drops the phone**.
  `UserProfile` from `/users/profiles` has no phone either (`usersClient.ts:23-27`).

**Fix.**

- (b) Give `settingRight` (line 922) a default muted color (e.g. `#7E8AA6`) — inline overrides
  at 632/641 keep their blue. Contrast-check ≥ 4.5:1 against the NEW obsidian bg from (c).
- (c) Migrate the screen to obsidian: `root.backgroundColor` → `#07090D` (use the same
  token/source `ChatScreen` uses — `CHAT_BG` pattern, or the shared obsidian token object if
  one exists per T-13's report; do NOT invent a new constant). Re-tune the navy borders
  (`#1C3B66`/`#244C82`) to the obsidian-family hairlines used by `ChatScreen`'s styles so the
  cards don't look glued-on. **Then re-check every text color on this screen against the new
  bg** — the boss explicitly warned about faded text after bg swaps.
- (a) Persist the phone at discovery (client-only fix, no backend):
  1. Add optional `phoneE164?: string` to `LocalConversation` (`src/modules/messenger/store/types.ts:131`).
  2. In `useDiscoveredContacts.ts:190-196`, include `phoneE164: r.phoneE164` in the
     `upsertConversation` payload.
  3. In `ChatInfoScreen.tsx:398-400`, prefer `conversation.phoneE164` then fall back to
     `resolveUserPhone(...)` (keeps dev fixtures working).
  4. If conversations are persisted in the local DB with an explicit column list (check the
     conversations table in `crypto/db.ts`), add the column via the existing schema-migration
     pattern; if they serialize a JSON blob, no migration needed — **verify which before coding**.
  - **Privacy note:** do NOT add phone to the public `/users/profiles` endpoint as the
    shortcut — that would expose any user's phone to anyone holding a userId (server change,
    architecture-gated). The discovery path is correct: you only ever see numbers already in
    your own address book.
  - Limitation to accept: chats started WITHOUT contact discovery (e.g. group-member DM) have
    no number — the slot stays hidden (`!!subtitle` guard already handles this). State this in
    the sqa log; it matches WhatsApp behavior for unknown numbers ONLY having the number, not
    the reverse.

**Blast radius.** `LocalConversation` type is used across the messenger store — adding an
optional field is additive but run the full messenger flows. `upsertConversation` at discovery
runs on every sync — must not clobber existing fields (it spreads `...existing`; keep that).
Obsidian migration on this screen overlaps T-13 — mark this screen done in T-13's checklist.

**Task loop additions.**

- Verify: discover a contact by phone → open 1:1 → Chat Info shows number under name;
  "Recovery" readable; bg obsidian; all rows readable (walk EVERY text on the screen).
- Impact pass: `npm run test:crypto` (store types touched); conversation list still renders
  names; group Chat Info (if same screen handles groups) unaffected — check `title`/`subtitle`
  logic for the group branch; Disappearing Messages / Safety Number / Clear / Delete rows all
  still navigate.
- Contrast audit per DESIGN_REVIEW_LOOP §3.4 on the recolored screen at fontScale 1.3.

**Exit criteria.** Number shows for discovered contacts; no unreadable text on the screen;
bg `#07090D`; crypto suite + messenger smoke green.

---

## T-07 — Regions: South Africa zone · 3-letter badges · live region flag · map preload

**Problem (PDF p14–15).** Four asks: (1) South Africa must appear in booking Select
Location; (2) zone badges should be 3-letter ("UAE not AE"); (3) the client home top-right
region flag should reflect the user's region (SA user → SA flag); (4) the booking map takes
too long to open — preload it "like Uber".

**Why it happens.**

- (1) South Africa (`ZA`) is ALREADY canonical nearly everywhere — backend
  `apps/auth-service/src/common/regions.ts:25-31` (`REGIONS` incl. ZA + ZAR),
  `SUPPORTED_REGION_CODES` (40), booking-create gate accepts it
  (`booking.service.ts:231-237`; spec `booking.region.spec.ts:74` asserts AE/SA/BD/GB/**ZA**),
  mobile mirrors `src/utils/regions.ts:21-27` + `REGION_BBOX:60-66` and
  `src/utils/constants.ts:50-56` all have ZA. The ONLY gap: the booking picker's hardcoded
  client seed `REGION_SEED` at `src/screens/booking/ZoneMapScreen.tsx:70-75` lists AE/SA/BD/GB
  and **omits ZA** — so the screen never shows it. (`region_code` in DB is plain TEXT, no
  enum — nothing to migrate.)
- (2) The badge is literally `region.code` (`ZoneMapScreen.tsx:100,104`, also the map card at
  231–232). Codes are the **dispatch key** (DB rows, booking gate, job-feed scoping —
  `agent.service.ts:759,1979-1985`) and must NOT change.
- (3) The home chip is **hardcoded** `🇦🇪` + "UAE" —
  `src/screens/booking/BookingHomeScreen.tsx:227-240` (even the accessibilityLabel says
  "currently UAE", line 235). It never reads the selected region
  (`ZoneMapScreen.handleContinue` writes `updateDraft({zone_code, zone_label, region})`,
  line 224). There is **no shared code→flag map**: flags exist only in `DIAL_CODES`
  (`src/utils/constants.ts:60-71`, incl. ZA 🇿🇦 and SA 🇸🇦).
- (4) The picker map is a WebView **created on screen mount** —
  `src/screens/booking/LocationPickerScreen.tsx:70-86` builds the HTML, WebView rendered
  inline (371–390), and the HTML cold-loads mapbox-gl JS/CSS/style from CDN every time
  (`src/modules/booking/bravoLocationPickerMapHtml.ts:24-29,44`). Nothing is pre-warmed
  (repo-wide grep: no map prefetch/hidden WebView exists; `mapToken.ts:12` is just a
  bundle-time constant). Cross-ref: `docs/audits/MAP_GPS_ROUTE_AUDIT_2026-07-16.md` (MG-04
  token pinning, MG-11 error handling) — coordinate, don't collide.

**Fix.**

1. **Add ZA to the picker:** `ZoneMapScreen.tsx:70-75` — add
   `{code:'ZA', name:'South Africa — Johannesburg, Cape Town', country:'South Africa', cities:'…', cpos:0, available:true}`.
   Availability/counts auto-populate from `bookingApi.regionsAvailability()` (lines 199–210;
   server enumerates `SUPPORTED_REGIONS` which already includes ZA — `booking.service.ts:1006-1029`).
   **Ops prerequisite for real dispatch:** ZA needs `cpo_pool`/`vehicle_pool` rows with
   `region_code='ZA'` and at least one dispatch-eligible agency (same seeding gap as the
   staging-deploy memory) — without it the zone lists but bookings can't assign. State this in
   the sqa log; it's data, not code.
2. **3-letter badges — display field, not code change:** add `badge` to the `Region` seed
   entries: AE→`UAE`, SA→`KSA`, BD→`BGD`, GB→`GBR`, ZA→`RSA` (or `ZAF`), render `region.badge`
   at `ZoneMapScreen.tsx:100,104` and in the map card (231–232). Keep `code` untouched
   everywhere else. **⚠️ Naming collision to confirm with the boss:** internal `SA` =
   Saudi Arabia; the boss's "SA (South Africa)" as a _badge_ would collide with Saudi — the
   doc's default is KSA (Saudi) / RSA (South Africa), which resolves it. Get a yes/no before
   shipping; do not silently pick different strings than requested without flagging it.
3. **Live region chip:** `BookingHomeScreen.tsx:227-240` — derive flag+label from the booking
   store's selected region (fallback: profile/GPS region via the existing region feature, see
   `src/utils/regions.ts` `COUNTRY_TO_REGION`); add a shared `REGION_FLAGS` (or
   `flag` field on `SUPPORTED_REGIONS` in `src/utils/constants.ts:50-56`) — do NOT duplicate
   another ad-hoc map; update the accessibilityLabel too. Chip must update after the user
   changes zone in ZoneMap (store-driven re-render, not a one-shot read).
4. **Map preload (scoped, pragmatic):**
   - v1 (cheap, big win): when `BookingHomeScreen` mounts (booking intent is likely), mount a
     **hidden 1×1 warm-up WebView** rendering the same picker HTML with the region's
     `REGION_BBOX` center — Chromium's HTTP cache then holds mapbox-gl JS/CSS/style/tile
     responses, so the real picker boots warm. Gate it: only once per app session, only on
     wifi/any-network after interactive, torn down after `ready` posts.
   - Also center the real picker at the user's region bbox immediately (no world-view flash).
   - Do NOT build a persistent shared map instance in v1 (memory + the MG-audit recovery
     machinery assumes per-screen WebViews).
   - Alternative if the warm-up WebView proves flaky on the low-end TECNO device: bundle
     mapbox-gl JS/CSS as local assets in the HTML (removes CDN round-trips entirely) — bigger
     change, coordinate with the MAP_GPS audit owner (MG-10 lists the CDN dependency).

**Blast radius.** ZoneMap feeds the booking draft (`zone_code` → dispatch region matching —
the WHOLE Lite dispatch chain keys on it): the badge field must not leak into any API payload.
The warm-up WebView touches app-start perf and memory — measure on the TECNO KM5. Chip change
touches BookingHomeScreen (the Secure/Lite home — B-82 watchlist). **Run
`docs/runbooks/LITE_BOOKING_LOOP.md`** (this is squarely its trigger list): baseline before,
regression after, all three lanes for the ZA + chip changes.

**Task loop additions.**

- Verify: ZA listed with live CPO count; select ZA → Continue → picker opens centered on ZA;
  booking-create with region ZA passes the gate (server accepts). Badges read UAE/KSA/BGD/GBR/RSA.
  Chip shows the selected region's flag after zone change and after app restart.
- Preload: measure picker time-to-ready cold vs warm (logcat timestamps `ready` post) on
  Redmi + TECNO; target ≥ 2× faster warm; verify NO regression in picker recovery (kill the
  network mid-load → MapFailedOverlay still appears; watchdog still remounts).
- Impact pass: full LITE_BOOKING_LOOP §7 sign-off (client/agency/CPO lanes); job-feed region
  filter still scopes (`agent.service.ts:759`); UAE booking end-to-end unchanged; ops-console
  live map unaffected.
- Backend: no deploy strictly needed (ZA already live server-side) — CONFIRM the deployed
  Contabo build actually has `common/regions.ts` with ZA before trusting this (memory: box
  drifts from git; check `/bookings/regions-availability` response on staging first).

**Exit criteria.** ZA bookable end-to-end on staging (or explicitly blocked-on-ops-seeding,
logged); badges 3-letter with boss-confirmed strings; chip live; warm picker measurably
faster with recovery intact; LITE_BOOKING_LOOP sign-off held.

---

## T-08 — Sign-in: remove the yellow autofill highlight

**Problem (PDF p16–17).** When credentials are autofilled/pasted from the password manager,
the email + password inputs paint **yellow**, clashing with the dark UI. Boss: _"take the
yellow away."_

**Why it happens.** `src/screens/auth/LoginScreen.tsx` uses a local `Field` component
(lines 110–226) whose `TextInput` (lines 206–220) sets **none** of `importantForAutofill` /
`autoComplete` / `textContentType`. The yellow is the **Android system autofill highlight**
drawn because autofill importance is left on "auto". No yellow exists in the app styles
(field bg is `rgba(255,255,255,0.03)`).

**Fix.** Thread autofill props through `Field` to the TextInput (`LoginScreen.tsx:206-220`)
for the email (usage lines 359–373) and password (374–399) fields. Two options — pick ONE
deliberately:

- **Option A (recommended):** keep autofill working but restyle-proof it — set
  `autoComplete="email"` + `textContentType="emailAddress"` (email) and
  `autoComplete="password"` + `textContentType="password"` (password), and suppress the
  highlight with `importantForAutofill="no"` ONLY if the yellow persists (test first: on many
  Android versions the highlight is unavoidable while autofill is active).
- **Option B (what the repo already does elsewhere):** kill autofill outright with
  `autoComplete="off"`, `textContentType="oneTimeCode"`, `importantForAutofill="no"` — the
  exact pattern at `src/screens/messenger/BackupSetupScreen.tsx:530-532` and
  `BackupRestoreScreen.tsx:746-748`. Downside: users lose password-manager fill on the login
  form, which is hostile for a security app. Prefer A; fall back to B only if A still shows
  yellow on the Redmi/TECNO test devices.

**Blast radius.** Login only — but `Field` is local to LoginScreen; confirm no other screen
imports it. If registration (`Create account`) has its own inputs with the same gap, fix them
in the same pass (check `src/screens/auth/` siblings).

**Task loop additions.**

- Verify ON REAL DEVICE (autofill doesn't trigger on all emulators): save credentials in
  Google Password Manager → relaunch → autofill → no yellow; manual typing unaffected; login
  works.
- Error path: wrong password still shows the error state correctly.
- Impact pass: registration + forgot-password inputs; keyboard avoid behavior (B-84 fixed
  keyboard covering inputs across 17 screens — don't regress it).

**Exit criteria.** No yellow on autofill on ≥1 real device; login + registration functional.

---

## T-09 — Sign-in header visual hierarchy ("Sign in too small")

**Problem (PDF p18–19).** Boss circled the whole `SIGN IN / Welcome / Sign in to your Bravo
Secure account` block: _"adjust for visual effect the sign in and welcome. The Sign in too
small."_ Interpretation (confirmed by the screenshot): the eyebrow label **"SIGN IN"** is
visually lost — 10px, low-opacity mute color — while "Welcome" is 34px; the block reads
unbalanced.

**Why it happens.** `src/screens/auth/LoginScreen.tsx` styles (lines 494–496):

- `eyebrow` (494): `fontSize: 10`, `color: T.textMute = 'rgba(180,188,204,0.45)'` (line 35),
  `letterSpacing: 3` — tiny + 45% opacity = barely visible.
- `title` (495): 34px/700. `subtitle` (496): 14.5px.

**Fix.** `LoginScreen.tsx` styles 494–496. Suggested rebalance (design pass will iterate):
eyebrow → `fontSize: 12`, color `T.textDim` or cobalt `#5B8DEF` at full opacity, keep
letterSpacing; optionally tighten `marginTop` so eyebrow+title read as one lockup; subtitle
stays. Keep the 8pt grid and Manrope weights (DESIGN_REVIEW_LOOP §1). Do NOT grow "Welcome"
past 34 — the ask is to lift "SIGN IN", not inflate the title.

**Blast radius.** One screen's styles. Check whether the Create-account screen shares the
same eyebrow/title pattern — if yes, apply the same treatment for consistency.

**Task loop additions.**

- Verify at 320dp / 360dp / 430dp and fontScale 1.3: no wrap/clip of "Welcome back" or the
  subtitle; eyebrow clearly legible.
- Contrast ≥ 4.5:1 for the new eyebrow color on `#07090D`.
- Screenshot before/after for the boss (drop in `docs/qa/`).

**Exit criteria.** Eyebrow legible at arm's length; hierarchy eyebrow < subtitle < title
preserved; no regressions at small widths / large font scale.

---

## T-10 — Agent avatar: real initials + "(AGENT)" tag + profile photo

**Problem (PDF p20–21).** Agent Dashboard shows "AG" in the header avatar and duty card, and
the name reads "AGENT". Boss wants: the real agent/company name shown with an "(AGENT)"
marker; initials computed from the actual name — 1 word → first 2 letters (ARIFUL → AR),
2 words → 2 initials (ARIFUL ISLAM → AI), 3+ words → first 3 initials (ARIFUL ISLAM SHANTO →
AIS, 4-5 words still just 3); and profile-picture upload.

**Why it happens.** `src/screens/agent/AgentDashboardScreen.tsx`:

- Line 440: `const displayName = (me?.agent.display_name ?? 'Agent').toUpperCase()` —
  **`agents.display_name` is NULL in the DB** for auto-created agents: the create call
  (`src/screens/agent/_useAgent.ts:34` → `agentApi.create`) sends no display_name and the
  backend inserts `dto.display_name ?? null`
  (`apps/auth-service/src/agents/agent.service.ts:169,186-189`). So the literal fallback
  `'Agent'` → "AGENT" → initials "AG".
- Line 443: `pickInitials(displayName)` (`src/screens/agent/agentFlowHelpers.ts:105-111`) —
  single word → first 2 chars; **two+ words → first + LAST initial** (not first 3) — doesn't
  match the boss's algorithm for 3+ word names.
- Three render spots fall back to initials only when `user?.avatar_url` is empty: header
  avatar (532–544), duty card (616–626), drawer (823–833).
- **Photo upload ALREADY EXISTS and is wired** — drawer avatar `onPress={() => setPhotoSheet(true)}`
  (line 823) → `useAvatarPicker` (`src/modules/profile/useAvatarPicker.ts`, role-agnostic:
  library/camera/remove → `supabase.uploadAvatar` → `users.avatar_url` → authStore) +
  `AvatarPhotoSheet` (rendered lines 894–901). The boss likely never found it because the
  header/duty-card avatars aren't photo-tappable and nothing hints at the drawer path.

**Fix.**

1. **Name:** stop falling back to `'Agent'`. Preference order at
   `AgentDashboardScreen.tsx:440`: `me?.agent.display_name` → auth-store user's full name /
   company name → `'Agent'`. ALSO fix the source: pass `display_name` at agent creation
   (`_useAgent.ts:34` — include the user's name; backend already accepts it,
   `agent.service.ts:186-189`). For existing NULL rows the frontend fallback covers display;
   optionally backfill via SQL (ops decision — note it, don't run unprompted).
2. **"(AGENT)" marker:** render `${displayName} (AGENT)` in the duty card name slot (line
   ~620 area) — company accounts show the company name + "(AGENT)". Confirm with the boss
   whether the marker belongs on the dashboard only or everywhere the agent name shows.
3. **Initials algorithm:** update `pickInitials` (`agentFlowHelpers.ts:105-111`) to the
   boss's spec: `parts.length === 1 → slice(0,2)`; `=== 2 → 2 initials`; `>= 3 → first 3
words' initials`. Update its test (`src/screens/agent/__tests__/agentFlowHelpers.test.ts:130-142`)
   FIRST (red → green). Note the app has ~10 duplicated local initials helpers
   (MainNavigator:83, DashboardScreen:201, AgentHomeScreen:33, OrgRosterScreen:55, …) — do
   NOT consolidate them in this task (scope creep); only `pickInitials` + its callers.
4. **Photo:** make the header avatar's photo path discoverable — keep header-tap = drawer
   (existing), but make the DUTY CARD avatar tappable → `setPhotoSheet(true)` (currently not
   tappable, lines 616–626), and verify the existing drawer flow works on device end-to-end
   (pick → upload → all three avatars show the photo). Reuse `useAvatarPicker` exactly; no
   new upload code.

**Blast radius.** `pickInitials` is imported by other agent screens — check every caller
renders sensibly with 3-char output (avatar circles sized for 2 chars may need fontSize
tweak). `display_name` at creation touches the backend create path — run the auth-service
agent tests; the ops-console agent list shows display_name too. Avatar upload path is shared
with client profile — don't fork it.

**Task loop additions.**

- Verify: fresh agent register with 1/2/3/5-word names → initials AR / AI / AIS / first-3;
  dashboard shows real name + "(AGENT)"; photo upload from duty card and drawer; photo
  survives app restart; remove-photo returns to initials.
- Impact pass: client profile photo flow unaffected; OrgRoster/OrgMissions initials render;
  ops-console agents page shows the new display_name; `npm test` agent suites +
  `agentFlowHelpers.test.ts` green.
- Backend: if create-path changed, redeploy auth-service (tar-sync gotcha — memory: rsync
  missing, CI secret missing) and verify `/agents/me` returns display_name on staging.

**Exit criteria.** Real initials per spec (tests prove the algorithm); name + (AGENT) on
device; photo upload verified end-to-end; existing avatar surfaces unaffected; backend
deployed if touched.

---

## T-11 — Chat header: "Last seen 13h ago" pill overlaps the call icons

**Problem (PDF p22–23).** In the 1:1 chat header, the presence pill ("● Last seen 13h ago")
collides with the voice/video icon buttons on the right.

**Why it happens.** `src/screens/messenger/ChatScreen.tsx` header (JSX 1321–1359):

- The name column is `flex:1, minWidth:0` (line 1337) — correct — but the pill inside
  `presenceRow` (style line 2783) has **no `flexShrink`/`maxWidth`/`overflow:'hidden'`**, and
  the pill component itself (`src/screens/messenger/PeerPresence.tsx`, `s.pill` lines 207-212,
  `s.pillTxt` line 213) is content-sized with **no `flexShrink`**; its `numberOfLines={1}`
  (line 99) never truncates because nothing constrains its width. RN default
  `overflow:'visible'` lets it render past the column into `headerActions`.
- `headerActions` (style line 2790) also lacks `flexShrink:0`, so it doesn't defend its space.

**Fix.**

1. `ChatScreen.tsx:2783` `presenceRow`: add `flexShrink: 1, minWidth: 0` (and let it clip).
2. `PeerPresence.tsx` `s.pill` (207–212): add `flexShrink: 1, minWidth: 0`; `s.pillTxt` (213):
   add `flexShrink: 1` so `numberOfLines={1}` can actually ellipsize.
3. `ChatScreen.tsx:2790` `headerActions`: add `flexShrink: 0`.
   Result: long labels ellipsize ("Last seen 13h a…") instead of overlapping — WhatsApp behavior.

**Blast radius.** `PeerPresence` pill is likely reused (conversation list? group header?) —
grep `PeerPresencePill` usages and re-check each after adding flexShrink (a pill inside a
non-constrained row must not collapse to zero width). Group chat header shows member count in
the same slot — verify.

**Task loop additions.**

- Verify matrix: long contact name + "Last seen 13h ago" at 320dp; short name; group header;
  fontScale 1.3; RTL not required but don't hardcode left/right paddings asymmetrically.
- Impact pass: every `PeerPresencePill` call site rendered and eyeballed.

**Exit criteria.** No overlap at 320dp with the longest realistic label; all pill call sites
still render; typecheck green.

---

## T-12 — Link previews in chat (YouTube/posts → title + thumbnail like WhatsApp)

**Problem (user request).** When a user sends a URL (YouTube video, post, article), the
bubble should show a preview — title/caption/thumbnail — like WhatsApp.

**Status: PARTIALLY BUILT ALREADY — verify before writing anything.**

- `src/modules/messenger/ui/linkPreview.ts` — a complete hand-rolled OpenGraph scraper:
  `URL_RE` (23), `firstUrlIn` (26–30), `getLinkPreview` + in-memory cache (32–40),
  `fetchPreview` (42–73, 5s timeout, 128KB cap), `parseMeta` for `og:title/og:image/
og:description/twitter:*` (75–95). No npm dep.
- `src/modules/messenger/ui/LinkPreviewCard.tsx` — the card UI (image, site name, title,
  2-line description; taps open via `Linking.openURL`, line 33).
- It IS wired into text bubbles: `ChatScreen.tsx:2302-2307` renders
  `<LinkPreviewCard text={msg.content} />` under the message text.

**So first loop iteration = REPRODUCE:** send a YouTube link on device and observe. If cards
don't show in the field, root-cause WHY (fetch blocked? YouTube serving no OG tags to the
custom User-Agent `BravoSecure/1.0 LinkPreview`? card silently returning null?) — fix the
actual failure, don't rebuild the feature.

**Known gaps to close (confirmed by code):**

1. **No in-bubble linkification** — `ChatScreen.tsx:2304` renders `msg.content` as plain
   `<Text>`; the URL itself isn't tappable/styled. Split the text on `URL_RE` and render URL
   segments as styled, tappable spans (cobalt `#5B8DEF`, underline). Keep it inside the same
   `<Text>` (nested Text spans) to preserve wrapping.
2. **Privacy leak — significant for THIS app:** `linkPreview.ts:46` fetches the URL directly
   from the device, and the card mounts for **both sender and receiver** — so merely RECEIVING
   a message pings the third-party server from the recipient's IP (tracking/deanonymization
   vector; Signal never does this). Correct E2EE pattern: **sender-generated preview embedded
   in the encrypted envelope** — add optional
   `linkPreview?: {url, title, description, imageThumbB64, siteName}` to `SealedPayload`
   (`packages/messenger-core/src/crypto/sealedSender.ts:194-241`, mirroring the optional
   `replyTo`/`reaction` fields), persist on the message via a new JSON column following the
   `media_meta_json` pattern (`crypto/db.ts:147-158`, `SCHEMA_VERSION` bump), and have the
   receiver render ONLY the embedded preview (never fetch).
   **⚠️ STOP CONDITION (CLAUDE.md): changing the SealedPayload envelope shape is
   architecture-gated.** Adding an optional field is the same class of change as `replyTo`
   (precedent exists), but the implementing session MUST verify against the System
   Architecture Documentation / get approval BEFORE touching `sealedSender.ts`. If approval
   isn't available: ship in-bubble linkification + sender-side card now, and gate the
   receiver-side fetch behind a per-chat "tap to load preview" consent (no auto-fetch on
   receive) as the interim privacy fix — that stays entirely client-side and touches no
   envelope.
3. Thumbnail inside the envelope must be a small base64 (reuse the `thumbB64` convention from
   `SealedAttachment`, lines 97–101) — never ship multi-hundred-KB images through the relay.

**Blast radius.** `sealedSender.ts` is shared mobile + ops-console (`@bravo/messenger-core`)
— an envelope field addition must be tolerated by old clients (they must ignore unknown
fields — verify decode path). Schema bump touches the migration chain (v13 → v14) — run the
backup/restore suite (B-45 saga: Merkle counts must converge). `npm run test:crypto` mandatory.
The log-audit test will catch accidental logging of preview content — don't.

**Task loop additions.**

- Verify: YouTube link, news article, bare domain, URL-only message, two URLs in one message
  (first wins), 4000-char message with URL — sender AND receiver render; offline receiver
  still sees preview (embedded), no fetch fired from receiver (verify via proxy/logcat).
- Impact pass: group messages, reply-to a preview message, disappearing messages with preview,
  backup → restore → preview survives, ops-console still decrypts (messenger-core shared).
- `npm run test:crypto` + log-audit + full messenger device smoke (1:1 + group send/receive).

**Exit criteria.** Tappable URLs in bubbles; previews render for sender and receiver;
receiver makes zero network fetches for previews (or interim consent-gated fetch if envelope
change deferred); crypto + log-audit suites green; envelope change arch-approved or explicitly
deferred in sqa.md.

---

## T-13 — Global sweep: navy/blue page backgrounds → obsidian `#07090D`

**Problem (user request + PDF p13).** Several screens still sit on the legacy Command-Navy
palette (`#0A1F3F`) instead of the obsidian design system (`#07090D` bg / cobalt `#5B8DEF`).
Boss: _"find out all the bg that is blue make them like our app bg. also make sure the text
and contrast is visible."_ DESIGN_REVIEW_LOOP gate **G8** already declares any legacy screen a
Major.

**Why it happens.** Two palettes coexist:

- Obsidian (target): `src/components/ui/tokens.ts` — `UI.bg = '#07090D'` (line 8),
  `UI.accent = '#5B8DEF'` (line 14). ~55+ screens already comply (many via local
  `bg:'#07090D'` consts).
- Legacy: `src/theme/colors.ts` — `Colors.background = '#0A1F3F'` (line 15, "Command Navy"),
  `backgroundDepth = '#06142B'` (16), navy surfaces/borders (`#1B3A66/#162F54/#122747`,
  `#1C3B66/#244C82`); and `src/theme/bravo.ts` — `Bravo.bg = '#0A1F3F'` (13),
  `bgSoft = '#06142B'` (14). Screens that were never migrated still import these.

**Full inventory to migrate (file → bg style line(s); all currently `Colors.background`
`#0A1F3F` unless noted).** Migrate `backgroundColor` to the obsidian token (`UI.bg` from
`@components/ui/tokens`, or the sibling-screen local-const pattern — match whatever the
already-migrated screens in the same module use):

| #                                                                                           | File                                                                                                                                                                                                                                                                                                                                                              | Line(s)                                                                                                       |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Navigators (`contentStyle` — these tint EVERY screen in their stack during transitions)** |                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                               |
| 1                                                                                           | src/navigation/CpoOnboardingNavigator.tsx                                                                                                                                                                                                                                                                                                                         | 48, 63                                                                                                        |
| 2                                                                                           | src/navigation/AgentNavigator.tsx                                                                                                                                                                                                                                                                                                                                 | 78                                                                                                            |
| 3                                                                                           | src/navigation/BookingNavigator.tsx                                                                                                                                                                                                                                                                                                                               | 63                                                                                                            |
| 4                                                                                           | src/navigation/NewsNavigator.tsx                                                                                                                                                                                                                                                                                                                                  | 20                                                                                                            |
| 5                                                                                           | src/navigation/MessengerNavigator.tsx                                                                                                                                                                                                                                                                                                                             | 53                                                                                                            |
| **Messenger**                                                                               |                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                               |
| 6                                                                                           | messenger/CallsLogScreen.tsx _(PDF p8)_                                                                                                                                                                                                                                                                                                                           | 282                                                                                                           |
| 7                                                                                           | messenger/ChatInfoScreen.tsx _(PDF p12 — also T-06)_                                                                                                                                                                                                                                                                                                              | 880 (+ StatusBar 493)                                                                                         |
| 8                                                                                           | messenger/NewChatScreen.tsx                                                                                                                                                                                                                                                                                                                                       | 732                                                                                                           |
| 9                                                                                           | messenger/MessengerSettingsScreen.tsx                                                                                                                                                                                                                                                                                                                             | 372                                                                                                           |
| 10                                                                                          | messenger/GroupsScreen.tsx                                                                                                                                                                                                                                                                                                                                        | 249                                                                                                           |
| 11                                                                                          | messenger/FileVaultPurchaseScreen.tsx                                                                                                                                                                                                                                                                                                                             | 178, 188                                                                                                      |
| 12                                                                                          | messenger/VaultScreen.tsx                                                                                                                                                                                                                                                                                                                                         | 445                                                                                                           |
| 13                                                                                          | messenger/VaultLockScreen.tsx                                                                                                                                                                                                                                                                                                                                     | 271                                                                                                           |
| 14                                                                                          | messenger/VaultNewPinScreen.tsx                                                                                                                                                                                                                                                                                                                                   | 175                                                                                                           |
| 15                                                                                          | messenger/VaultOTPVerifyScreen.tsx                                                                                                                                                                                                                                                                                                                                | 221                                                                                                           |
| 16                                                                                          | messenger/VaultForgotScreen.tsx                                                                                                                                                                                                                                                                                                                                   | 138                                                                                                           |
| 17                                                                                          | messenger/\_ComingSoonScreen.tsx                                                                                                                                                                                                                                                                                                                                  | 57                                                                                                            |
| 18                                                                                          | messenger/MessengerHomeScreen.tsx                                                                                                                                                                                                                                                                                                                                 | 896 — base `root` is `Bravo.bg` navy, overridden inline by `MSG_BG='#07090D'` (406/407); remove the navy base |
| **Agent / CPO onboarding**                                                                  |                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                               |
| 19                                                                                          | agent/AgentDocsUploadScreen.tsx _(PDF p2 — also T-01)_                                                                                                                                                                                                                                                                                                            | 199 (+ StatusBar 120)                                                                                         |
| 20                                                                                          | agent/AgentKYCScreen.tsx                                                                                                                                                                                                                                                                                                                                          | 223                                                                                                           |
| 21                                                                                          | agent/AgentHomeScreen.tsx                                                                                                                                                                                                                                                                                                                                         | 194                                                                                                           |
| 22                                                                                          | agent/AgentAvailabilityScreen.tsx                                                                                                                                                                                                                                                                                                                                 | 147 (+ depth fill 169)                                                                                        |
| 23                                                                                          | agent/AgentAdminApprovalScreen.tsx                                                                                                                                                                                                                                                                                                                                | 197                                                                                                           |
| 24                                                                                          | agent/AgentCoverageScreen.tsx                                                                                                                                                                                                                                                                                                                                     | 173                                                                                                           |
| 25                                                                                          | agent/AgentDeploymentRequirementsScreen.tsx                                                                                                                                                                                                                                                                                                                       | 267 (+ depth 288)                                                                                             |
| 26                                                                                          | agent/AgentRegistrationScreen.tsx                                                                                                                                                                                                                                                                                                                                 | 250, 296                                                                                                      |
| 27                                                                                          | agent/AgentRegistrationWizardScreen.tsx                                                                                                                                                                                                                                                                                                                           | 262                                                                                                           |
| 28                                                                                          | agent/AgentVerifiedScreen.tsx                                                                                                                                                                                                                                                                                                                                     | 121, 163                                                                                                      |
| 29                                                                                          | agent/AgentVerificationStatusScreen.tsx                                                                                                                                                                                                                                                                                                                           | 188                                                                                                           |
| 30                                                                                          | agent/AgentRejectedScreen.tsx                                                                                                                                                                                                                                                                                                                                     | 148, 179                                                                                                      |
| 31                                                                                          | agent/AgentTypeSelectScreen.tsx                                                                                                                                                                                                                                                                                                                                   | 207 (+ depth 266/284)                                                                                         |
| 32                                                                                          | agent/MissionSummaryScreen.tsx                                                                                                                                                                                                                                                                                                                                    | 239, 243                                                                                                      |
| 33                                                                                          | agent/MissionLeadConsoleScreen.tsx                                                                                                                                                                                                                                                                                                                                | 427 (+ depth 488)                                                                                             |
| 34                                                                                          | agent/EarningsScreen.tsx                                                                                                                                                                                                                                                                                                                                          | 362                                                                                                           |
| 35                                                                                          | agent/\_shared.tsx                                                                                                                                                                                                                                                                                                                                                | 186                                                                                                           |
| **Pro**                                                                                     |                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                               |
| 36–47                                                                                       | pro/ProDashboardScreen 126 · ProLandingScreen 155,225 · ProTeamConfigScreen 162,200 · ProRiskReviewScreen 61,120 · ProRetainersScreen 142,181 · ProPaywallScreen 237,278 · ProLiveMissionScreen 53 · ProActivityHistoryScreen 199,272 · ProClientProfileScreen 149,202 · ProAssignedTeamScreen 184,238 · ProAISchedulingScreen 62,117 · ItineraryUploadScreen 275 |                                                                                                               |
| **Ops**                                                                                     |                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                               |
| 48–50                                                                                       | ops/OpsDashboardScreen 225 · OpsMissionDetailScreen 451 · OpsRoomReviewScreen 595,704                                                                                                                                                                                                                                                                             |                                                                                                               |
| **News**                                                                                    |                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                               |
| 51–55                                                                                       | news/NewsHubScreen 193,195 _(also T-03)_ · NewsFeedScreen 233 · NewsArticleScreen 160,215 · NewsAdsScreen 275 · NewsPreferencesScreen 169,197                                                                                                                                                                                                                     |                                                                                                               |
| **Liveops**                                                                                 |                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                               |
| 56                                                                                          | liveops/SOSScreen.tsx                                                                                                                                                                                                                                                                                                                                             | 284, 316                                                                                                      |
| 57                                                                                          | liveops/LiveTrackingScreen.tsx                                                                                                                                                                                                                                                                                                                                    | 1026, 1180 (+ `backgroundDepth` 1093/1096)                                                                    |
| **Auth / Settings**                                                                         |                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                               |
| 58                                                                                          | auth/HomeSelectionScreen.tsx                                                                                                                                                                                                                                                                                                                                      | 192, 263                                                                                                      |
| 59                                                                                          | auth/ProfileCompletionScreen.tsx                                                                                                                                                                                                                                                                                                                                  | 162, 203                                                                                                      |
| 60                                                                                          | settings/CorporateProfileScreen.tsx                                                                                                                                                                                                                                                                                                                               | 184                                                                                                           |

Also: `src/modules/messenger/ui/AmbientBg.tsx:27` defaults to `Bravo.bg` navy when no `bg`
prop is passed — flip its default to obsidian and check each caller.

**How to execute (this task is a CAMPAIGN — batch it, don't big-bang):**

1. Work module-by-module in this order: messenger → agent/CPO → pro → news → ops → liveops →
   auth/settings → navigators LAST (navigators affect every screen; doing them after their
   screens keeps transitions consistent while you go).
2. Per batch: swap page bg → obsidian; then **walk every text/border/surface on each screen**
   — navy borders (`#1C3B66`/`#244C82`) and navy surfaces look detached on obsidian; retune to
   the hairline/surface tokens the migrated sibling screens use. The boss explicitly warned:
   contrast after the swap is part of the task, not a follow-up.
3. Per batch, run the §0 impact pass + device screenshots at 360dp; log per-batch progress in
   sqa.md so a context-reset session can resume mid-campaign.
4. Screens covered by other tasks in this doc (T-01/T-03/T-04/T-06) — migrate them WITH their
   functional fix; tick them off here.
5. `Colors`/`Bravo` are also used for NON-bg purposes (bubbles, fonts via `BravoFont`) — do
   NOT delete the theme files; only retarget page/StatusBar/`contentStyle` backgrounds and
   the surfaces/borders on migrated screens. When the table is empty, `Colors.background`
   should have zero importers using it as a page bg — enforce with a final grep.

**Blast radius.** Everything visual. The vault screens (11–16) sit on the File-Vault MFA
flow — restyle ONLY; do not touch the MFA gate logic. LiveTrackingScreen was just reworked
(map audit, pulled today) — rebase carefully and re-run its map smoke. StatusBar colors ride
along (grep `StatusBar` in each migrated file).

**Task loop additions (per batch AND at campaign end).**

- Visual: screenshot each migrated screen (360dp) before/after; no navy remnant visible in
  normal use AND during screen transitions (navigator `contentStyle`).
- Contrast: spot-check body text ≥ 4.5:1 on `#07090D` per DESIGN_REVIEW_LOOP §3.4 — navy-era
  `textMute` values were tuned for `#0A1F3F` and may need lightening.
- Impact: full app tab-walk (Home/Messenger/Secure/Profile) + one flow per migrated module
  (send a message, open vault with MFA, run a booking, open live tracking, read a news
  article, agent duty toggle).
- Final: `grep -rn "Colors.background\|Bravo.bg" src/` → only non-page-bg uses remain;
  typecheck/lint/`npm test` green.

**Exit criteria.** Inventory table fully ticked in sqa.md; final grep clean; G8 gate passes
(no legacy page bg anywhere); per-module smokes green; vault MFA + booking + tracking flows
verified untouched.

---

## Batch-wide final gates (after the LAST task, before release)

1. `npm run typecheck` (≤ 47 baseline) · `cd apps/ops-console && npm run typecheck` ·
   `npm run lint`.
2. `npm test` (all projects) — plus `npm run test:crypto` if T-04/T-06/T-12 touched the
   store/envelope, `--selectProjects=booking` if T-02/T-07 shipped.
3. Device pass on ≥ 2 devices (Redmi + one BlueStacks/TECNO): golden path per task's exit
   criteria + the §0 impact list.
4. Log every shipped fix in `sqa.md` (next free B-numbers; keep the summary table format).
5. Release per the release-state memory: pull first, re-check versionCode (parallel sessions
   claim numbers), `npm install` after pull, build + Firebase upload as SEPARATE commands.
6. Backend touched? (T-07 confirm-only; T-10 create-path; T-12 none server-side) → tar-sync
   deploy to Contabo + verify endpoints live; remember the box reverts on next git-pull-CI
   mismatch (memory: CONTABO_SSH_KEY secret missing, deploys are manual).

---

## Open questions for the boss (answer before the affected task ships)

1. **T-01:** should the OTHER "SIA Licence" surface (AgentKYCScreen + ops-console label) also
   say "Security License"? (Recommended: yes.)
2. **T-05:** remove Bravo Pro too, or fix its navigation (it's equally dead — one-line fix)?
3. **T-07:** 3-letter badge strings — confirm `KSA` (Saudi) vs `RSA`/`ZAF` (South Africa);
   the requested "SA" for South Africa collides with Saudi Arabia's internal code.
4. **T-10:** "(AGENT)" marker on the dashboard only, or everywhere the agent's name appears?
5. **T-12:** approve the SealedPayload optional `linkPreview` field (architecture-gated), or
   ship the interim consent-gated client-only version?
