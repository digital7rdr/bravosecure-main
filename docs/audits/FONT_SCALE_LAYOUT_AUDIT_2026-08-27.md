# Font-Scale / Constrained-Layout Audit — 2026-08-27 (B-680)

> **Trigger:** founder's side-by-side screenshots of `ProDashboardScreen` (Bravo Secure Pro
> home). Client's phone: "Designated T…", "Booking Requ…", clipped subtitles, the red `29`
> notification badge colliding with the `UNDER BAINE` status pill, plan values wrapping, and
> excess dead space. Founder's phone: renders exactly as designed. Same build.
>
> **Status: FIXED same day (founder "fix all", 2026-08-27).** The §7 plan was executed:
> the global 1.3 cap is patched into RN (`patches/react-native+0.81.5.patch`, pinned by
> `textScaleCap.test.tsx`), the badge class by `badgeGeometry.test.ts`, the tab bars by
> `tabLabelFit.test.ts`, and the site-level Critical/Major fixes landed across ~45 files —
> see the 2026-08-27 "fix all" section in `sqa.md` (B-680) for the full fix record and
> gates. Device verification per §8 still OWED. Findings numbered FS-01…; umbrella bug
> **B-680**. Sister documents: `DESIGN_REVIEW_LOOP.md` (§2 matrix requires fontScale ≥ 1.3),
> `docs/qa/KEYBOARD_UI_TEST_PLAN.md`.

---

## 1. Root cause — VERIFIED, not inferred

### FS-01 · CRITICAL · The app-wide font-scale cap is INERT

`src/utils/textDefaults.ts` (shipped 2026-08-24, v1.0.253, for the "Welcome back, Shira…"
client report) sets:

```ts
Text.defaultProps.maxFontSizeMultiplier = 1.3; // and TextInput
```

**This does nothing.** Verified against the installed source this session:

- `node_modules/react-native/Libraries/Text/Text.js` — RN 0.81's `Text` is a **function
  component** (`const TextImpl: component(...)`) and contains **zero** reads of
  `defaultProps` anywhere under `Libraries/Text/`.
- React 19 removed `defaultProps` resolution for function components entirely.
- So the assignment is a no-op: **every `<Text>` in the app renders at the user's raw system
  fontScale (Android allows up to ~2.0)** unless the element sets `maxFontSizeMultiplier`
  itself.

Exactly **11 Text elements app-wide** do (see §6 safe list) — out of 199 screens. The
2026-08-26 session already discovered the inertness (comment at
`BookingHomeScreen.tsx:348-352`, and `messengerHeaderFit.test.ts` asserts it) but only
patched two headers; the knowledge never propagated.

**Decorative test:** `src/utils/__tests__/textDefaults.test.ts` asserts
`Text.defaultProps.maxFontSizeMultiplier === 1.3` — it pins the _assignment_, which passes
forever while the _mechanism_ is dead. This is exactly the "pin is decorative" class from the
CLAUDE.md call-registry lessons.

### FS-02 · MAJOR · `scaleTextStyles` multiplies ON TOP of fontScale

`src/utils/scaling.ts` `scaleFont` scales for **device width** (clamped 0.85–1.2×) and the
OS multiplies fontScale on top. A 9pt badge label on a ≥393dp phone becomes ~11pt before
fontScale; at fontScale 2.0 it renders ~22pt. Every arithmetic below includes this. 190 of
199 screens wrap their styles in `scaleTextStyles`, so the compounding is app-wide.

### Why the two phones disagree

Founder's phone: fontScale 1.0 → designed layout. Client's phone: large system font
(fontScale ≳1.3, possibly with a larger display-size setting) → uncapped text in
fixed-geometry layouts. Every symptom in the screenshot maps to a finding below:

| Screenshot symptom                                          | Finding                                                                                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Designated T…", "Booking Requ…" tile titles                | FS-10                                                                                                                                                                                               |
| `29` badge over the bell, colliding with `UNDER BAINE` pill | FS-03 (broken even at fontScale 1.0)                                                                                                                                                                |
| `UNDER BAINE` pill crowding the header                      | FS-11                                                                                                                                                                                               |
| "19 Sept 2026" wrapping / "PLAN Details" desync             | FS-12                                                                                                                                                                                               |
| Clipped tile subtitles ("…booked dates hig…")               | FS-10 (`numberOfLines={2}` at grown lineHeight)                                                                                                                                                     |
| Dead space ("space" annotation)                             | Sibling tiles stretch to the tallest tile in the row; grown 2-line descriptions inflate row height, one-line tiles show the gap. Fixed section margins (22+18dp) read huge once content compresses. |

---

## 2. Defect-class taxonomy (used in every table below)

| Class | Pattern                                                                           | Failure                                |
| ----- | --------------------------------------------------------------------------------- | -------------------------------------- |
| C1    | `numberOfLines={1}` on meaningful text, no `maxFontSizeMultiplier`                | truncated meaning                      |
| C2    | fixed `height:` (not `minHeight`) on a text-holding box                           | vertical clipping                      |
| C3    | absolutely-positioned badge/pill with fixed box + uncapped count                  | overlap / escape                       |
| C4    | text row missing `flexShrink`/`minWidth:0`, or rigid sibling wins the space fight | ejected siblings / overflow            |
| C5    | numeric `width:`/`maxWidth:` on a text container                                  | truncation that flex would have solved |
| C6    | text in fixed-size touch targets (tabs, chips, buttons) uncapped                  | wrap → geometry break                  |
| C7    | hardcoded dp constants consumed as layout truth                                   | consumers desync when content scales   |
| C8    | screen with no font-sizing discipline at all (no `scaleTextStyles`, no caps)      | everything raw                         |

---

## 3. CRITICAL findings (visible breakage at fontScale ≤ 1.3, or broken at 1.0)

### Shared components & navigation

| #     | Where                                                                              | Class  | What breaks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FS-03 | `src/components/ActivityBell.tsx:27-33`                                            | C3, C2 | **The screenshot's badge collision — and the geometry is wrong even at fontScale 1.0.** Badge is `position:absolute, top:4, right:4, minWidth:16, height:16` (fixed height, right-anchored) with 9pt text that `scaleFont` already lifts to ~11pt on ≥393dp devices. Width = max(16, text+9). "29" ⇒ ~23dp at 1.0 (left edge x≈15, already over the 22dp bell glyph), ~36dp at 2.0 (covers the button). "99+" ⇒ ~50dp ⇒ left edge **12dp outside the button**, over whatever sits left of it — on `BookingHomeScreen:379` the plan chip, on `ProDashboardScreen:255` the `UNDER <name>` pill, on `AgentDashboardScreen:653` the title. Fixed `height:16` minus 1.5dp borders clips the digits vertically from ~1.3 up. Three mount sites, all dashboards. |
| FS-04 | `src/navigation/MainNavigator.tsx:344` (styles :1627-1653)                         | C1, C6 | **Root tab bar labels.** Raw `<Text numberOfLines={1}>` — and this stylesheet is one of the few NOT `scaleTextStyles`-wrapped. Flow mode renders HOME/BOOK/SUMMARY/MESSENGER at `fontSize:10` uppercase in ~86dp cells (360dp device). "MESSENGER" truncates at fontScale ≈1.4 (≈1.25 on 320dp). **The sibling `ObsidianTabBar.tsx:238` already fixed this exact problem with `<FitLine floorScale={0.75}>`** — the two bars visibly disagree at large fontScale despite the code comment claiming "same renderer, same styles".                                                                                                                                                                                                                          |
| FS-05 | `src/screens/messenger/CallScreen.tsx:3118-3145` (styles :3866-3871)               | C4     | Video-call top bar: `videoName` (13pt, uppercase, `letterSpacing:2`, **no numberOfLines/flex**) vs the right cluster (signal bars + AES/DTLS-SRTP badge) in a `space-between` row where **neither side can shrink**. A long name at 1.3 pushes the **security indicator** clean off-screen — on a secure-comms product.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| FS-06 | `src/screens/messenger/FloatingCallOverlay.tsx:377-380, 665-668` (styles :726-742) | C5, C1 | Floating video card is a hard `width:120` box; footer = name (`flex:1`) + timer (**no flexShrink**). At 1.3 the timer + padding leave ~58dp ≈ 4 characters of name; at 2.0 one glyph. Fixed width can never recover.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| FS-07 | `src/screens/vbg/VBGHomeScreen.tsx:195-217` (style :463)                           | C4     | VBG topbar: avatar + "Virtual Dashboard" (11pt, `letterSpacing:2.4` — tracking alone ~41dp) + PROTECTED/ALERT badge, **none shrinkable**, `space-between`. Sums past 360dp at fontScale ~1.4 (320dp: ~1.15); the status badge runs off the right edge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| FS-08 | `src/screens/vbg/VBGHomeScreen.tsx:230-233` (styles :483-486)                      | C4, C1 | Principal name row: `principalName` (16.5pt, user data, **no flexShrink** — RN default is 0) beside the tier `sosTag`. The name keeps intrinsic width and the tag is clipped past the card edge for any moderately long name at 1.3. (`ProfileScreen.tsx:573` gets the same pattern right with `flexShrink:1`.)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| FS-09 | `src/screens/news/NewsFeedScreen.tsx:208-214` (styles :439-443)                    | C4     | "Regional News Feed" (17pt, no flexShrink) + LIVE badge in a gap row with ~254dp budget: fits at 1.3 with ~0dp spare, **badge clipped from ≈1.35** — the only "feed is live" affordance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### ProDashboardScreen (the reported screen)

| #     | Where                                        | Class  | What breaks                                                                                                                                                                                                                                                         |
| ----- | -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FS-10 | `src/screens/pro/ProDashboardScreen.tsx:365` | C1, C6 | **"Designated T…".** `tileTitle` (13.5→~17.5pt at 1.3) `numberOfLines={1}` in a `width:'48%', minWidth:150` tile (~134dp inner at 360dp). Six of eight module titles ellipsize at 1.3. `tileDesc` `numberOfLines={2}` clips the subtitle the same way.              |
| FS-11 | `ProDashboardScreen.tsx:236-243`             | C4, C3 | Header `labelRow`: "BRAVO SECURE PRO" (no shrink) beside `activePill` (**`flexShrink:0`**) rendering `UNDER <OWNER>`. Neither yields — with a `via_owner` account the pill overruns into the bell/region chip. Guaranteed overflow, not marginal.                   |
| FS-12 | `ProDashboardScreen.tsx:280-305`             | C4, C8 | Plan strip: three `flex:1` cells (~97dp) with tracked uppercase caps. "COVERED UNTIL" ≈82dp at 1.0 → wraps at 1.3 while "PLAN TOTAL" stays one line — the three values desynchronise vertically (the screenshot's wrapped "19 Sept 2026" / clipped "PLAN Details"). |

### Booking flow

| #     | Where                                                       | Class  | What breaks                                                                                                                                                                                                                                                             |
| ----- | ----------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FS-13 | `src/screens/booking/AddOnsScreen.tsx:205, 292`             | C1, C4 | `opsBadge` renders the 23-char "Control System Approval" with **no flexShrink**, taking ~145dp of a ~215dp column; `addonInfo: {flex:1}` **missing `minWidth:0`**. Approval-gated add-on names are already ellipsized at fontScale 1.0; at 1.3, 3-4 characters survive. |
| FS-14 | `src/screens/booking/CustomizeAddOnsScreen.tsx:1071, 1074`  | C1     | Add-on title (~115dp left after icon+price+toggle at 1.3 → ~6 chars) and full-sentence description pinned to `numberOfLines={1}`. Meaning destroyed at every scale.                                                                                                     |
| FS-15 | `src/screens/booking/BookingConfirmationScreen.tsx:321-328` | C4     | Nav row: `navTitle` "BOOKING CONFIRMED" (13pt, `letterSpacing:1.5`, no numberOfLines/shrink) + `stepPill` (no maxWidth). At 1.3 neither yields; the **mission-state pill is pushed off-screen**.                                                                        |
| FS-16 | `src/screens/booking/ZoneMapScreen.tsx:122-125`             | C1     | Zone selector: `{region.country}` + cities in one `numberOfLines={1}` Text (~199dp budget). At 1.3 the **country name itself** is cut — the choice the screen exists for.                                                                                               |
| FS-17 | `src/screens/securepro/SecureProStatusScreen.tsx:260-262`   | C1, C6 | 4-step progress strip, ~69dp cells: "ACCEPTANCE" ≈63dp at 1.0 (already at the wall) → "ACCEPTANC…" at 1.3.                                                                                                                                                              |
| FS-18 | `src/screens/booking/CreditPaywallScreen.tsx:313-315, 736`  | C1, C4 | `'Booking paused · insufficient balance'` `numberOfLines={1}` in `headerMeta: {flex:1}` (missing `minWidth:0`) — truncates at 1.3. This is the string that explains **why the user is on a paywall**.                                                                   |

---

## 4. MAJOR findings (break at fontScale 1.5–2.0 or <360dp)

### Booking / Pro / SecurePro

| #     | Where                                             | Class      | Issue                                                                                                                                                                                                                                                     |
| ----- | ------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FS-19 | `ProDashboardScreen.tsx:331`                      | C1         | "Additional Services" (15.5pt) truncates at 1.5+ beside 46dp icon + chevron.                                                                                                                                                                              |
| FS-20 | `ProDashboardScreen.tsx:356-360`                  | C3         | `soonPill` grows into the 40dp tile icon inside a ~134dp tile.                                                                                                                                                                                            |
| FS-21 | `BookingHomeScreen.tsx:524-532, 660-668`          | C4         | `bookingRight` status chip unshrinkable → all growth charged to `bookingRef`/`bookingType` (`numberOfLines={1}`). Long statuses truncate the booking reference.                                                                                           |
| FS-22 | `BookingHomeScreen.tsx:548-556`                   | C6         | Four trust tiles (~72dp cells): "Tracking"/"Encrypted" wrap at 1.3 → ragged tile heights.                                                                                                                                                                 |
| FS-23 | `BookingDateTimeScreen.tsx:319-326, 387-395, 648` | C6, C1, C5 | Segmented "Choose date & time" truncates ~1.6; "Mon, 24 Aug 2026" drops the year at 1.3 (user can't verify mission date); `counterVal: {width:34}` clips 3-digit hours / any digits at ≥1.7. Same `width:34` stepper at `CustomizeAddOnsScreen.tsx:1394`. |
| FS-24 | `TripSummaryScreen.tsx:531-539, 251, 262`         | C4, C1     | `rowK` labels **explicitly `flexShrink:0`** opposite `numberOfLines={2}` values — all growth charged to the trip facts. Crew/vehicle lines concatenate two dynamic fields in one line.                                                                    |
| FS-25 | `BookingConfirmationScreen.tsx:625-631, 560-570`  | C4, C2     | Summary keys rigid vs `sumV` values; 32dp avatar circles clip initials at 2.0.                                                                                                                                                                            |
| FS-26 | `BookingHistoryScreen.tsx:154-158, 186`           | C4         | Status chip (no flexShrink/maxWidth) grows; `ref`/`meta` truncate — chip's own `numberOfLines` never fires because the chip expands instead.                                                                                                              |
| FS-27 | `TripHistoryScreen.tsx:271, 283-285, 297-308`     | C8, C4, C6 | **No `scaleTextStyles` at all** (one of four such files, see FS-54). Stat tiles wrap at 1.5; `tripLeft: {flex:1}` missing `minWidth:0` opposite `tripRight: {flexShrink:0}` → route column collapses to ~110dp at 2.0; TAP-TO-TRACK/status pills collide. |
| FS-28 | `SecureSummaryScreen.tsx:165, 129`                | C8, C1     | No font discipline; 18pt one-line service label truncates the active-mission identity.                                                                                                                                                                    |
| FS-29 | `SecureProStatusScreen.tsx:573, 320-326`          | C5, C4     | `sumLabel: {width:92}` hard-fixed → wraps 2-4 lines at 1.3-2.0 and refuses to give width back; history rows' status chip ejects the plan name.                                                                                                            |
| FS-30 | `SecureProPaymentScreen.tsx:331-332`              | C4         | Rigid labels vs shrinking **payment values** — amount/period/method truncate. Trust defect.                                                                                                                                                               |
| FS-31 | `SecureProMembersScreen.tsx:349-350, 862`         | C4         | `"1,250 / 5,000 BC used"` one line beside a rigid relationship badge — the **spend limit** is what gets cut.                                                                                                                                              |
| FS-32 | `ProAssignedTeamScreen.tsx:292, 280-282, 304-306` | C4, C6     | `cpoInfo: {flex:1}` missing `minWidth:0` vs `availRow: {flexShrink:0}`; equal-width tab labels wrap; 3 stat cells wrap tracked uppercase labels at 1.3.                                                                                                   |
| FS-33 | `CreditPaywallScreen.tsx:767`                     | C3         | `pkgBadge` absolute at `top:-9, right:14` grows leftward over the package-card title at 1.5+.                                                                                                                                                             |
| FS-34 | `MissionCompleteScreen.tsx:95, 57`                | C5         | `crewLine: {maxWidth:280}` + `numberOfLines={2}`: a 3-CPO detail loses the last call sign inside the fixed box at 1.3.                                                                                                                                    |

### Messenger

| #     | Where                                                            | Class      | Issue                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | ---------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FS-35 | `MessengerHomeScreen.tsx:1503-1506` (styles :1788-1793)          | C3         | Chat-list unread badge: fixed `height:20`, count rendered **raw — no 99+ clamp** (unlike `UnreadPill`). Clips at 2.0; 3-4 digit counts squeeze the preview row to nothing.                                                                                                                                                                                                                           |
| FS-36 | `MessengerHomeScreen.tsx:1491-1494`                              | C4         | `rowHandle` (no flexShrink/numberOfLines) is unshrinkable — the contact **name** absorbs the whole overflow while a secondary `· HANDLE` renders in full.                                                                                                                                                                                                                                            |
| FS-37 | `MessengerTabBar.tsx:38, 161, 181-185`                           | C7, C6     | `MSG_TAB_HEIGHT = 60` exported as compile-time truth to 4 layout consumers (list padding, FAB bottom, body pads); uncapped uppercase labels ("CHANNELS") wrap at 2.0 → real bar height exceeds 60 → FAB lands on the bar, last row buried.                                                                                                                                                           |
| FS-38 | `DepartmentChatScreen.tsx:1049, 1050-1058`                       | C1, C4     | Channel-chat header title is the **exact sibling of the patched `ChatScreen.tsx:2024`** but was missed by the B-660/661 sweep — no cap, truncates at 1.3. `metaRow` ("N members"/"Encrypted") has no shrink and clips under the admin cog.                                                                                                                                                           |
| FS-39 | `DepartmentChannelsScreen.tsx:1144-1148, 1263-1276`              | C4, C2, C6 | BROADCAST/READ-ONLY badge (~100dp at 2.0) eats the channel name whole; `searchRow: {height:42}` clips input; stat chips wrap ragged.                                                                                                                                                                                                                                                                 |
| FS-40 | `deptchat/UnreadPill.tsx:35-41`                                  | C3         | THE shared unread badge: count correctly clamped 99+ but **fixed `height:24`** clips vertically at 1.5-2.0 — on every channel row at once.                                                                                                                                                                                                                                                           |
| FS-41 | `GroupCallScreen.tsx:3254, 2525-2537, 2952, 2699`                | C5, C2, C3 | `namePlateTxt maxWidth:130` (redundant — parent already has `maxWidth:'85%'` — and destructive: ~8 chars at 1.3); control dock heights `166/224 + insets` are magic numbers for scaling content — "SPEAKER" wraps at 2.0 and the dock overlaps the video hero; `dockBadge` (fixed 16dp, `top:-2, right:-2`) escapes into the neighbouring dock slot; "RINGING…" clipped in `height:36, minWidth:80`. |
| FS-42 | `CallScreen.tsx:4047, 3859-3863`                                 | C6, C2     | Control-tray uppercase labels (SPEAKER/MESSAGE/BLUETOOTH, `letterSpacing:1.5`, no width/numberOfLines) collide at 2.0; fixed 160/200dp gradient scrims — scaled labels escape onto raw video, killing contrast.                                                                                                                                                                                      |
| FS-43 | `CallsLogScreen.tsx:404-419, 686-690`                            | C4, C6     | `callMeta` children (duration + "Group · " + "Ended by host") have no shrink/numberOfLines → overflow into the timestamp column at 1.3; filter tabs wrap.                                                                                                                                                                                                                                            |
| FS-44 | `FilesScreen.tsx:1375, 1411-1420, 1437-1438`                     | C1, C2, C6 | Vault promo "…in your File Va…" at 1.3; `searchRow height:40` clips; 5 `flex:1` tabs with an absolute `left/right:'22%'` underline that desyncs from a wrapped label.                                                                                                                                                                                                                                |
| FS-45 | `VaultScreen.tsx:551-575, 713`                                   | C2, C5     | Tab row has **no flex and no ScrollView**: intrinsic widths sum ~398dp at 2.0 on a 360dp screen — the "Audio" tab is **unreachable**. Grid filenames ~5 chars at 2.0.                                                                                                                                                                                                                                |
| FS-46 | `albumUi.tsx:104, 243, 264-268` · `LinksScreen.tsx:198, 222-223` | C5, C2     | Album chip `maxWidth:190` / chat chip `maxWidth:110, flexShrink:0` (refuses to shrink AND grow → ~4 chars at 2.0); rename input `height:46` clips.                                                                                                                                                                                                                                                   |
| FS-47 | `GroupsScreen.tsx:99, 295-296`                                   | C3         | Same badge defect as FS-35 but 2dp tighter (`height:18`), raw unclamped count.                                                                                                                                                                                                                                                                                                                       |
| FS-48 | `ChatInfoScreen.tsx:970-978, 1364-1372`                          | C4         | ALIAS + ADMIN + YOU tags all unshrinkable — a member with two tags **loses their name entirely** at 1.3.                                                                                                                                                                                                                                                                                             |
| FS-49 | `modules/messenger/ui/PremiumBanner.tsx:35-62`                   | C4         | Unshrinkable `detail` wins the layout fight; the primary label ("LOOPBACK MODE") is what disappears.                                                                                                                                                                                                                                                                                                 |
| FS-50 | `ChatScreen.tsx:2266-2270, 4089, 5032-5039`                      | C2, C3     | In-chat search box `height:42` and mention rows `height:52` clip at 1.5+; scroll-FAB badge (fixed 18dp, unclamped count) escapes the FAB circle.                                                                                                                                                                                                                                                     |

### Navigation / shared / auth / agent / news / settings

| #     | Where                                                                            | Class      | Issue                                                                                                                                                                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FS-51 | `ObsidianTabBar.tsx:214-218, 267-271`                                            | C3         | Tab badge: fixed `height:16`, anchored `right:-8` → grows left over the tab icon and, past ~40dp, into the neighbouring cell; digits sheared by the borderRadius clip at 2.0. (Labels themselves are safe — FitLine.)                                                                              |
| FS-52 | `MainNavigator.tsx:333, 1655-1669`                                               | C2         | Tab-bar avatar initials: 10pt text in a fixed 24dp circle — glyphs ride the border ring at 2.0.                                                                                                                                                                                                    |
| FS-53 | `ProfileDrawerModal.tsx:249-258, 353-364` · `SwitchDashboardSection.tsx:341-377` | C4         | Drawer rows: `rowLeft` no flex/minWidth:0, label no numberOfLines/shrink, vs pill+chevron. "Departmental Chat" is at the limit at 1.3; pill+chevron pushed off the panel at 1.5+. `SwitchDashboardSection` adds a third unshrinkable child ("CURRENT").                                            |
| FS-54 | `BravoAlertHost.tsx:114-118` + `utils/alert.ts:148-152`                          | C6         | `resolveAlertLayout` forces `axis:'row'` for ANY 2-button alert → 121dp of text per button; at 2.0 a two-word verb hits `numberOfLines={2}` and truncates — on confirm/destructive dialogs.                                                                                                        |
| FS-55 | `OTPVerificationScreen.tsx:117, 463-476, 506-515` · `OtpVerifyScreen.tsx:369`    | C2, C6     | OTP digit cells: `height:64` + **`overflow:'hidden'`** + `scaleFont(27)→~32pt` → at 2.0 a ~64px glyph in a 64dp clipping box — **sheared digits on the login-critical screen**. Keypad keys `height:56` with 24pt digits bleed into the next key row (no clip there).                              |
| FS-56 | `RegisterScreen.tsx:870-904`                                                     | C2, C3     | Float-label fields: `height:58` + `overflow:'hidden'` + absolute label + hard `paddingTop:14` ⇒ ~69dp of content in a 58dp clipping box at 2.0 — the floating label (the field's only name once filled) is cut. Unshrinkable `dialBox` leaves <200dp for the phone input at 2.0 (<160dp at 320dp). |
| FS-57 | `ProductGateScreen.tsx:134-137`                                                  | C4         | Product title (16pt, no shrink/numberOfLines) next to a badge in ~222dp — badge ejected at 2.0, on the **first authenticated screen** a new user sees.                                                                                                                                             |
| FS-58 | `HomeSelectionScreen.tsx:169-171, 258-264`                                       | C4, C1     | `altNameRow`: neither name nor badge shrinks → badge pushed past the chevron at 1.5+.                                                                                                                                                                                                              |
| FS-59 | `AgentDashboardScreen.tsx:641-666, 762-777, 970-978`                             | C4, C1, C3 | Header title + FS-03 bell badge collision; `dutyKicker` `MANAGER · {ORG}` (`letterSpacing:2` — ~50dp of pure tracking at 1.3) truncates the org name ("the only way to tell whose board you are looking at" per its own comment); nav rows' title+badge both rigid.                                |
| FS-60 | `IncomingOfferScreen.tsx:280-303`                                                | C5         | `track: {width:180}` hardcoded (56% of a 320dp screen, off-centre); offer fee/duration `numberOfLines={1}` truncate — on a time-boxed accept/decline screen.                                                                                                                                       |
| FS-61 | `IntelFeedScreen.tsx:848-849, 715-730, 941-957`                                  | C5, C2     | `sigLeft: {width:120}` → ~6 chars/row at 2.0 across the whole signals matrix; wire ticker `height:28` + `overflow:'hidden'` shears the tag on wide devices at high scale.                                                                                                                          |
| FS-62 | `ProfileScreen.tsx:448, 600-605`                                                 | C1, C6     | Settings row labels single-line beside unshrinkable trailing groups — "Notification Settings" ambiguous at 1.5.                                                                                                                                                                                    |
| FS-63 | `IndividualProfileScreen.tsx:211, 389-392, 161-169`                              | C6, C1     | 4 family-seat slots (~70dp): every first name ellipsizes at 2.0 — the screen's primary identification affordance; 23pt ID-card name leaves ~5 chars at 2.0.                                                                                                                                        |

---

## 5. MINOR findings (cosmetic, or degrade gracefully)

- `ProDashboardScreen`: fixed section margins read oversized once content compresses (the "space" annotation) — spacing is design-fixed, revisit only with a designed compact variant.
- `ChatScreen.tsx:4875-4879` composer `maxHeight:116/90`: 2 visible lines instead of 5 at 2.0 (scrollable). Same class: `DepartmentChatScreen.tsx:1713` `COMPOSER_MAX_H = 6*21` yields 3 lines at 2.0.
- `maxWidth`-capped single-liners that degrade to early ellipsis but never overlap: `TypingBubble.tsx:76` (180), `DepartmentChatScreen.tsx:1776` (200), `PeerPresence.tsx:232` ("Last…" at 2.0).
- Fixed-height CTAs that survive 2.0 with zero headroom (one copy change from breaking): `LoginScreen.tsx:549/561`, `RegisterScreen.tsx:926/965/970`, `RoleSelectionScreen.tsx:517`, `SignupSuccessScreen.tsx:157`, `ProfileCompletionScreen.tsx:193-203`, `BookingDateTimeScreen.tsx:667`, `ProfileDrawerModal.tsx:365`, `BiometricGate.tsx:508`, `TimeDropdownField.tsx:194`.
- `StepperBar.tsx:72-77` rail labels (`width:42`, 7.5pt): mostly defused by the `PixelRatio.getFontScale() < 1.2` gate at `:41`, **but the gate reads OS fontScale, not the effective size** — `scaleFont` separately inflates 1.2× on wide devices, so at fontScale 1.15 on a 414dp phone labels still ellipsize.
- Well-built rows that merely truncate early (cap, don't re-layout): `VBGNearbyScreen:151`, `VBGGeoRiskScreen:359`, `VBGOSINTScreen:138`, `VBGMapScreen:106`, `NextOfKinModal:247`, `NewsFeedScreen:236` breaking ticker, `NewsHubScreen:203/228`, CPO mission rows, `ActivityCenterScreen:150` header, `ActivityRow:34` timestamp, `ProfileScreen:389` credits value (**promote to Major if balances exceed 4 digits — a truncated currency figure is a meaning change**), `CallScreen:3067` add-picker, `FilesScreen:1106` (all four row lines ellipsize simultaneously at 2.0), `BookingHomeScreen:375` `LITE` badge (asymmetric with its patched `PRO` sibling), `MessengerSettingsScreen:650`, `OrgRosterScreen:560` skeleton-pill width jump, `TripSummaryScreen:171` nav spacer.
- `MessengerHomeScreen.tsx:1752-1758` search `height:44`, `MessengerHomeScreen:1831` swipe actions `width:88` ("UNMUTE" wraps at 2.0 inside the fixed swipe geometry).

**Verified NOT findings:** `LoadingView` (fully shrink-wired), `SettingsScreen` rows (labels wrap by design), `VBGSRAScreen:183` (`minWidth/minHeight` — the correct badge pattern), `ZoneMapScreen:159` (`maxWidth:'86%'` percentage cap — good pattern), `BookingConfirmationScreen:638` `paidRow` (reference-correct shrink pairing), `MessengerHomeScreen:1841` selection badge (icon-only), `ChatScreen:4818` msgMeta (sits outside the bubble, never overlaps text).

---

## 6. What is already safe (complete app-wide list — 11 elements)

| Site                                                                                                                                                                                        | Cap |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `components/ui/FitLine.tsx` (default 1.2, applied to twin AND visible line — measurement includes the user's setting, which is why FitLine is correct where `adjustsFontSizeToFit` was not) | 1.2 |
| `navigation/ObsidianTabBar.tsx:238` — every Secure/CPO/Departmental tab label via FitLine                                                                                                   | 1.2 |
| `components/ui/StepperBar.tsx:86` (caption only — rail labels NOT capped)                                                                                                                   | 1.4 |
| `BookingHomeScreen.tsx:357, 370, 396` (header, PRO chip, region chip — the B-660 fix)                                                                                                       | 1.2 |
| `ChatScreen.tsx:2025, 3679, 3683` · `MessengerHomeScreen.tsx:1050`                                                                                                                          | 1.2 |
| `NewsFeedScreen.tsx:400` (region code)                                                                                                                                                      | 1.1 |

Pinned by `headerFitContract.test.ts` and `messengerHeaderFit.test.ts` — **no scan asserts
caps on tab labels, badges, or fixed-height controls**, which is why FS-03/04/55 shipped
unprotected.

---

## 7. Fix directions (NOT applied — for the fix session)

Ordered by leverage; ~80% of the findings are "correct layout, uncapped glyph" and die with №1.

1. **Restore a real global cap (kills FS-01 and most C1/C2/C6 findings at the root).**
   `Text.defaultProps` cannot work again — the honest options:
   - a wrapped `AppText`/module shim (`react-native` moduleNameMapper or a patch-package on
     `Libraries/Text/Text.js` injecting `maxFontSizeMultiplier ?? 1.3`) — one change, whole
     app, TextInput too;
   - or a codemod + ESLint rule requiring the prop. The shim is the only variant that also
     covers third-party components' internal `<Text>`.
     Delete or repoint the decorative `textDefaults.test.ts` at the REAL mechanism (render a
     Text at mocked fontScale 2.0 and assert the effective size) — red first, then fix.
2. **`ActivityBell` badge geometry (FS-03)** — broken at fontScale 1.0: `height→minHeight`,
   clamp stays, cap the text, and anchor so growth doesn't escape the 42dp button (or adopt
   `UnreadPill` once fixed). Same recipe for `ObsidianTabBar` badge (FS-51), MessengerHome/
   Groups badges + 99+ clamp (FS-35/47 — adopt `UnreadPill` as the single authority, per its
   own doc comment), GroupCall dock badge, ChatScreen scroll-FAB badge.
3. **Mechanical class sweeps** (each fixes a whole class, not a site):
   - fixed `height:` on any text-holding box → `minHeight:` + padding (badges, search bars
     42/44/46, mention rows, OTP cells, register float-fields, ticker);
   - the rigid-label/shrinking-value pairs → `flexShrink:1, minWidth:0` on the text holder,
     `flexShrink:0` **only** on true pills, `maxWidth` on pills next to single-line text
     (`BookingConfirmationScreen:638` `paidRow` is the in-repo reference pattern);
   - numeric `maxWidth`/`width` on text → remove and let the flex parent bound it
     (`namePlateTxt 130`, `LinksScreen 110`, `albumUi 190`, `sigLeft 120`, `sumLabel 92`,
     `track 180`, `counterVal 34`, `crewLine 280`).
4. **`MainNavigator` tab labels (FS-04)** → `<FitLine floorScale={0.75}>`, identical to
   `ObsidianTabBar.tsx:238` — the fix already exists next door. Add the missing
   `scaleTextStyles` wrap (or deliberate caps) to the four undisciplined files:
   `TripHistoryScreen`, `SecureSummaryScreen`, `TimeDropdownField`, `WheelTimePicker`.
5. **`MSG_TAB_HEIGHT` (FS-37)** — measure via `onLayout` (or cap its labels so 60 stays
   true); four consumers currently trust the constant.
6. **Per-screen flex repairs that a cap alone does NOT fix** (missing flexShrink ejects
   siblings even at 1.3 capped): FS-08 VBG principal, FS-09 news LIVE badge, FS-11 Pro
   header pill, FS-13 add-on badge, FS-15 confirmation pill, FS-53 drawer rows, FS-57/58
   auth cards, FS-05 call top bar.
7. **Contract test for the future** (the bug-regression rule): a static scan suite in the
   app project asserting (a) the global cap mechanism is alive (behavioral render test, not
   a defaultProps read), (b) every `position:'absolute'` badge style uses `minHeight` not
   `height`, (c) tab-bar labels go through FitLine. Mutation-prove each RED first.

---

## 8. Verification plan (device — owed after the fix session)

```bash
# Reproduce the client phone on any test device (sqa.md §4):
adb shell settings put system font_scale 1.3   # then 1.5, 2.0; reset: 1.0
# Optional: smaller width via display density
adb shell wm density 440        # reset: adb shell wm density reset
adb exec-out screencap -p > fs13_<screen>.png
```

Screens to screenshot at 1.0 / 1.3 / 2.0, portrait, 360dp-class device:
ProDashboard (the reported one), BookingHome, tab bar (both bars), MessengerHome,
DepartmentChat header, CallScreen + GroupCall in-call, OTP entry, Register (focused field),
VBG home, NewsFeed header, CreditPaywall, AddOns/CustomizeAddOns. Pass = no truncated
meaning, no overlap, no clipped glyphs at 1.3; graceful degradation (ellipsis with meaning
retained) at 2.0. Per DESIGN_REVIEW_LOOP §5, interleave A/B if measuring anything.

---

## 9. Summary

| Severity | Count         | Themes                                                                                                                                           |
| -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Critical | 18 (FS-01…18) | inert global cap; ActivityBell badge (broken at 1.0); root tab bar; Pro dashboard (3); call surfaces (2); VBG (2); booking flow (6); news header |
| Major    | 45 (FS-19…63) | fixed-height badges/inputs; rigid-pill-vs-name rows; numeric width caps; OTP/register clipping; undisciplined stylesheets                        |
| Minor    | ~25           | zero-headroom CTAs; early ellipsis in well-built rows; composer line budgets                                                                     |

One mechanism (FS-01) explains the founder-vs-client discrepancy entirely; one component
(FS-03) explains the badge collision **including at fontScale 1.0**; the rest is the
long tail the DESIGN_REVIEW_LOOP fontScale-matrix row was supposed to catch but had no
enforcement for. Nothing here is fixed yet — this document is the work order.
