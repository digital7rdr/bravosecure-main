# Client batch — 2026-08-23 (B-637 … B-641)

Five items the client reported on 2026-08-23, with screenshots. This document is the **contract**
for the fixes: each item states what the client asked for verbatim, what the code does today, what
will change, what it must not break, and how it will be proved.

> **Evidence levels — read them literally.** Claims marked with a `file:line` were **checked against
> source**. Claims about live systems were **measured** and say so (the DNS probe in B-637, the SQL
> probes in B-640). Everything else is **inference** and is labelled as such. Review round 1 found
> ten claims in the first draft that were wrong or overstated; each is now corrected **in place with
> the correction visible**, because a spec that quietly rewrites its own history teaches nobody.

> **Process (founder's instruction).** This doc goes through a critic agent and an edge-case agent and
> is revised until all three of us agree, BEFORE any code is written. Then each fix is built and put
> through the same builder → critic → edge-case loop until consensus, one item at a time.

> **Status: rev 4 — CONSENSUS REACHED, ready to build.**
>
> | Round | Critic                                       | Edge cases                             |
> | ----- | -------------------------------------------- | -------------------------------------- |
> | 1     | **NOT READY** — 5 blockers, 10 wrong facts   | **65 findings**                        |
> | 2     | **READY WITH CHANGES** — only B-639 blocking | **NO, close** — B-639 + B-637 blocking |
> | rev 4 | every round-2 item addressed below           | every round-2 item addressed below     |
>
> The two reviewers **disagreed once** — on whether B-641's font cap must come first. Resolved
> against the edge reviewer, with reasoning recorded at F-53, because the client's own screenshot
> shows truncation at default font scale where a cap cannot help.
>
> **Build order:** B-640 (the F3 cleanup fix — source-provable, no device needed) → B-638 → B-641
> Part 1 → B-639 → B-637 plumbing. B-637's actual feature and B-639's phase 2 stay blocked on the
> founder decisions listed in each section.

> **Three findings changed what gets built, and all three came from review, not from the author:**
>
> 1. **B-637 cannot be delivered at all** — measured: the domain does not resolve, and messaging apps
>    do not linkify custom schemes. The first plan's "shippable Phase 1" satisfied neither clause of
>    the request. It also surfaced a **live bug**: the app ships a dead install link to real users.
> 2. **B-639 as first written would have broken agencies** — deleting their only create-a-channel
>    door, silently shipping a deferred 4th tier, and (worst) **downgrading the most common agency
>    shape** from real level labels to undifferentiated cards.
> 3. **B-640 has a source-provable fix that needs no device** — the dominant failure path skips the
>    camera/mic release whose own comment names _"the 'Call failed' loop"_.

| #     | Item                                             | Verdict on scope                                                        |
| ----- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| B-637 | Invite: a clickable link + app-download fallback | **Partly blocked** — needs a hosted domain + an install destination     |
| B-638 | Emergency card back; remove LINKS                | Client-only, but **removing LINKS orphans a screen** — needs a call     |
| B-639 | Agencies onto the departmental-channel system    | Client-only; **0 of 11 agencies have parentage** — needs the level pill |
| B-640 | Mission (Ops Room) call fails; check messaging   | Server probed **CLEAN**; root-cause candidate found in the client       |
| B-641 | Text truncated app-wide; consistent type scale   | 19 defects found; the repo already contains the remedy, ungeneralised   |

---

## Numbering

`sqa.md` header says **next free number: B-637**, and `origin/main` was re-fetched at the time of
writing with zero divergence. B-637..B-641 are claimed by this document. A parallel session has
already collided once today (B-632 → B-635), so **re-fetch before assuming these are still free**,
and claim by pushing an `sqa.md` header edit first.

---

## B-637 — The workspace invite must carry a clickable link, with a download fallback

**Client, verbatim:** _"when I invite someone to a channel, there must be a link that can be clicked
or if the person doesn't have the app, it must allow them to download the app."_ Quoted the current
message:

> You're invited to join our workspace on Bravo Secure. Open the app, choose "Join workspace" and
> enter the code NR6KJFNJ.

### What exists today

- **One** site composes that string — `src/screens/deptchat/InviteMemberScreen.tsx:480-489`, via
  `Share.share({message})`. No drifted copies, and **no test pins the string**, so the copy is free
  to change.
- The code is minted **server-side**: `apps/auth-service/src/department/enterprise-join.service.ts:1641-1648`
  — 8 chars from an unambiguous alphabet (no O/0/I/1). Default expiry **7 days** (max 90),
  **single-use**, bound to one contact, revocable.
- Redeemed at `POST /enterprise/invites/accept` — `enterprise-join.controller.ts:154`.
- **The receiving screen already accepts a prefilled code.** `JoinWorkspaceScreen.tsx:88-91`
  auto-resolves `params.code`, and the route type is `JoinWorkspace: {code?: string} | undefined`
  (`src/navigation/types.ts:127`). Nothing in the app has ever passed it — the comment calling it a
  "deep link" is aspirational. **This half of the work is already done.**
- **A link-bearing share already exists elsewhere** — `src/screens/messenger/NewChatScreen.tsx:52-59`
  ships `https://bravosecure.com/get` as the install link for inviting a non-Bravo contact. That is
  the precedent to follow, and the domain the app already claims in copy.

### What does NOT exist — deep linking, at all

Verified from zero, not assumed:

| Thing                                               | State                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `scheme` in `app.json`                              | **absent**                                                                                  |
| Android `https` intent-filter                       | **absent** — only the Expo dev-client `exp+bravo-secure` filter (`AndroidManifest:150-155`) |
| `autoVerify`                                        | **absent** (0 in the merged release manifest)                                               |
| iOS `associatedDomains`                             | **absent** (no `ios/` dir; managed prebuild)                                                |
| `assetlinks.json` / AASA                            | **neither file exists in the repo**                                                         |
| `linking` prop on NavigationContainer               | **absent** (`src/navigation/index.tsx:61`)                                                  |
| `Linking.getInitialURL` / `addEventListener('url')` | **zero hits** in `src/` — every `Linking` use is outbound                                   |
| `expo-linking`                                      | installed (`package.json:99`) but **never imported**                                        |

> ⚠️ **TRAP — `android/` is committed to git** (`git ls-files` confirms
> `android/app/src/main/AndroidManifest.xml`). An `app.json` `intentFilters` change is applied by
> prebuild and **would not reach the shipped APK**, because the build uses the checked-in manifest.
> The manifest must be hand-edited. Getting this wrong produces a change that tests green, builds
> clean, and silently does nothing on device — this repo's `EXPO_PUBLIC` bake trap in a new costume.

### What is genuinely blocked, and why it is not an excuse

Two external facts, neither of which code can invent:

1. **No hosted domain serves anything.** `bravosecure.com` / `bravosecure.app` appear in copy
   (`NewChatScreen.tsx:53`, `ProfileScreen.tsx:105-107`) but nothing in this repo serves them. App
   Links and Universal Links **require** `/.well-known/assetlinks.json` and
   `apple-app-site-association` on the real domain, served over HTTPS. Without that, an `https://`
   link opens a browser, not the app.
2. **There is no Play Store or App Store listing.** Zero `play.google.com` / `apps.apple.com` URLs
   anywhere. Distribution is Firebase App Distribution, whose links are **per-release and
   tester-email gated** — there is no stable public install URL to point a stranger at. The
   manifest comment says so outright.

### ⛔ MEASURED 2026-08-23 — the domain does not exist

```
https://bravosecure.com/get   → Could not resolve host
https://bravosecure.com/      → Could not resolve host
https://bravosecure.app/      → Could not resolve host
control: https://example.com  → HTTP 200      (so DNS in this lane works)
control: staging auth-service → HTTP 404      (resolves and answers)
```

**Neither domain resolves.** Two consequences:

1. **A LIVE BUG, unrelated to this batch:** `src/screens/messenger/NewChatScreen.tsx:53` ships
   `https://bravosecure.com/get` to real users today as "Get the app". **Every person who has ever
   been invited to Bravo by a non-Bravo contact received a dead link.** This should be fixed or
   removed regardless of what happens to B-637.
2. B-637's link half is blocked on **registering and hosting a domain** — not on engineering.

### ⛔ AND A CUSTOM SCHEME DOES NOT SOLVE THIS — the first plan was wrong

The invite ships through `Share.share({message})` → SMS / WhatsApp / Signal / iMessage. **Those
clients autolink `http(s)`, `tel:` and `mailto:` — they do not linkify arbitrary custom schemes.**
`bravosecure://join?code=…` arrives in the recipient's chat bubble as **dead grey text**.

So a `bravosecure://` scheme delivers:

- **the "clickable link" clause:** nothing — it is not tappable in the medium it ships through;
- **the "download the app" clause:** nothing — by construction a custom scheme only does anything on
  a device that already has the app.

**There is no client-only version of this feature.** Any plan that claims otherwise is describing a
link nobody can tap. That has to be said plainly rather than dressed up as "Phase 1".

### Plan — build the plumbing, be honest about the blocker

**Now (client-only, real value, but explicitly NOT the client's ask):**

1. **Fix the invite copy so it is useful and true today.** Lead with the code, which is the only
   thing that works on every recipient's device right now. **No dead URL.** Copy in the appendix.
2. **Fix or remove the dead `bravosecure.com/get` link** at `NewChatScreen.tsx:53`.
3. **Build the deep-link plumbing so the switch-on is one config change**: `"scheme": "bravosecure"`
   in `app.json` **and** the hand-added `<intent-filter>` in the committed `AndroidManifest.xml`; a
   URL handler (`getInitialURL` + `addEventListener('url')`); the cross-login park. This is genuinely
   useful — it makes the app-to-app case work and it is everything Phase 2 needs except the domain —
   but it must not be reported to the client as "the link works now".
   - **⛔ WORK ITEM ZERO — the resolver DROPS the code today, and the repo says so in writing.**
     `src/navigation/departmentalEntry.ts:222-228` carries a standing note:

     > _"PHASE 6 NOTE — this resolver deliberately carries no CALLER params: every branch passes only
     > the route (plus the `initial` flag above). **M5's `{code}` deep link therefore cannot be wired
     > by adding a `linking` config alone; the param has to be threaded through here first, or the
     > code will be silently dropped on three of the five branches.**"_

     Verified: all five branches of `openJoinFlowScreen` pass route-only (`:247`, `:252`, `:257`,
     `:262`, `:275`). So the first draft's instruction — "resolve the shell via `departmentalEntry`" —
     would have shipped a link that opens the right screen **with an empty code box**, which is
     indistinguishable from a broken link.
     **Thread a `params` argument through all five branches BEFORE anything else**, and make the gate
     a test asserting `{code}` survives **each named branch**, not just one.

   - `JoinWorkspace` is registered in **two** navigators (`MessengerNavigator.tsx:239`,
     `DepartmentalNavigator.tsx:158`), and hard-coding one path is the B-257/B-258 class.

   - **The replay waits for `showMain`, not for "authenticated".** `src/navigation/index.tsx:56-77`
     has **four** exclusive root states — `accessEnded` → `showAuth` → `showPerms` → `showMain` — and
     `permsShown` is read asynchronously from AsyncStorage. A replay fired on the auth flip lands
     while `PermissionsScreen` is mounted, finds no `MessengerTab`, falls to
     `Alert.alert('Not available here')` (`:281-284`) — **and the parked code is consumed and lost**.
     That is the first-ever-login path, i.e. exactly the invitee's. Gate the replay on
     `showMain === true`, clear the park **only** after the open reports success, and **never park
     when `accessEnded` is true** (a revoked account never reaches `Main` at all).
   - **The park is a capability store, not a convenience.** It must: clear on sign-out **and on
     user-id change** (the code is bound to one contact server-side; replaying it into a different
     account shows a stranger someone else's org name); carry a **TTL ≤ the code's 7-day life**; and
     the storage choice (AsyncStorage vs Keychain) is a **decision to record**, because
     `enterprise-join.service.ts:1633-1640` calls the code a capability and CLAUDE.md lists session
     storage under stop-conditions.
   - **`JoinWorkspaceScreen` needs a params→state sync.** `:51` is
     `useState((params?.code ?? '').toUpperCase())` — **initial state only**. A warm
     `navigate('JoinWorkspace', {code})` onto a route already in the stack re-runs the resolve at
     `:89-91` but leaves the `TextInput` showing the stale value. That is exactly the
     deep-link-while-the-app-is-open case, so "this half is already done" is true for a **cold push
     only**.

**Blocked on the founder — this IS the feature:**

4. Register and host a domain. Then: `/.well-known/assetlinks.json` (needs the release signing cert
   SHA-256) + `apple-app-site-association`, `autoVerify` on Android, `associatedDomains` on iOS, and
   a public `/join?code=…` landing page. `apps/ops-console` already has the exact pattern — a
   pre-auth `/accept-invite` page allowlisted at `middleware.ts:32-34`.
5. An install destination for someone without the app. There is **no Play/App Store listing and no
   stable public App Distribution URL**, so until one exists the landing page can only show the code
   and instructions — which does not satisfy "let them download the app" either.

**Two decisions only the founder can make:** which domain to register and host, and where a stranger
without the app should be sent. **Until both are answered, the client's request cannot be
delivered** — and saying so now is cheaper than shipping a link that goes nowhere.

### Review round 2 — five more that shape the build

**F-05 — an invite shared INTO a Bravo chat is the worst case, and our own code causes it.**
`src/modules/messenger/ui/linkPreview.ts:23` matches **https only**, and `LinkifiedText.tsx:129` only
makes those matches tappable. So a `bravosecure://` link forwarded in-app renders as **inert text**,
while an https link would be tappable and lead to a domain serving nothing. Admins forwarding invites
in-app is a likely path. Either add the scheme to `URL_RE` (blast radius: every message body) or state
that in-app sharing stays code-only until the domain exists.

**F-06 — a forwarded link leaks the org and team name, then offers a Join button that can only fail.**
`resolveReferralLink` is JWT-guarded but performs **no contact-binding check** — it returns
`{valid:true, org_name, team_name, invited_role}` to **any** authenticated caller holding the code
(`enterprise-join.service.ts:248-303`). Binding is enforced only at accept (`:1214-1222`), and email
binding is surfacing-only by deliberate design (`:1187-1189`). So a wrong recipient sees
"Join {Org} · {Team}", taps Join, and gets _"This invite is no longer valid."_ — the dangling-CTA class
B-413 already fixed twice. **A URL is far more forwardable than "type this code."** This is the
concrete form of the capability-exposure stop-condition already flagged, and it must be decided
**before** the copy change, not after.

**F-12 / M2 — the park record, specified. The four rules do NOT compose as prose, so here is the
shape rather than the adjectives.**

The first draft said "clear on sign-out, clear on user-id change, TTL, replay once". Those contradict
each other: the park's primary case is written **while signed out** (the invitee's first-ever login),
so a blanket clear-on-sign-out destroys it — and register/takeover flows do call `signOut()`. And
"clear only after the open succeeds" contradicts "replay at most once": a failed open would retain
the park _and_ burn the flag, leaving a code that can never replay and never expires.

```ts
type ParkedInvite = {
  code: string;
  parkedAtMs: number;
  boundUserId: string | null;
  attempts: number;
};
```

Replay predicate, evaluated when the root reaches `showMain`:

- `now - parkedAtMs < TTL` (24 h — well inside the code's 7-day server life), else drop;
- `boundUserId === null` → **bind to the live user now**; else require `boundUserId === liveUserId`;
- increment `attempts` **before** attempting the open; drop at `attempts >= 2`;
- a newer park always overwrites an older one.

**The identity check is at CONSUMPTION, not a clear-on-change listener** — a process kill between
sign-out and the next launch defeats any listener, and that is the path that would otherwise replay
A's invite into B's session. An **unbound** park survives sign-out; a **bound** one does not.
Precedent for the clear: `authStore.signOut` already clears `pendingProvider`
(`src/store/authStore.ts:1003`).

**M3 — `showMain` is necessary but NOT sufficient, and on CPO/agency shells the open can never
succeed.** `JoinWorkspace` is registered only on `MessengerNavigator:239` / `DepartmentalNavigator:158`,
and `openJoinFlowScreen`'s last resort requires `mountedTreeHasRoute('MessengerTab')`
(`departmentalEntry.ts:270`) before falling through to `Alert.alert('Not available here')`
(`:285-288`). For a role with no host route every replay returns failure **forever**. Hence the
bounded `attempts`, plus a **terminal fallback**: surface the code with "enter it under Join
workspace" rather than retrying invisibly.

**S4 — thread the param at the right nesting depth per branch.** Three branches nest
(`{screen: route, initial: false}`) and the shell branch nests **twice**
(`departmentalEntry.ts:260`). `initial: false` is load-bearing (R9-2, `:212-222`), so a `params`
merge that flattens it re-ships the dead-end stack. **The per-branch test asserts both `{code}`
survival and `initial === false`.**

> **Phase 1 ships NO URL, so two findings are phase-2 entry criteria, not work in this batch.**
> Since the appendix is code-only, `linkPreview.ts`'s `URL_RE` is untouched (F-05) and no forwardable
> URL exists, so the `resolveReferralLink` contact-binding exposure (F-06) cannot be triggered by
> anything this batch ships. **Both must be decided before the domain goes live** — list them beside
> the domain and the store listing, not in the build queue.

**F-08/09/13 — arrival races.** `navigate` to an already-focused route with identical params is a
no-op, so a second tap of the same link does nothing — carry an arrival nonce. `check()`
(`JoinWorkspaceScreen.tsx:71-88`) has **no request-generation guard**, so a slow first resolve can
overwrite a newer one with the wrong org. And RN's `onNewIntent` calls `setIntent()`, so
`getInitialURL()` returns the consumed URL for the rest of the process — the "already handled" guard
must be **module-level**, not component-scoped.

**F-07 — the new intent filter is a new `onNewIntent` producer.**
`MainActivity.kt:39-56` runs `applyCallLaunchFlagsIfNeeded` on every `onNewIntent`, clearing
`setShowWhenLocked` / `setTurnScreenOn` for any non-call intent, and `AndroidManifest.xml:145` is
`singleTask`. So a link tapped during a live call strips the call surface's lock-screen posture.
Exclude the VIEW intent from that branch, or prove on device it is harmless while a call is live.

**F-14 — two Phase-2 traps worth writing down now.** The Android package (`com.bravosecure.app`) and
the iOS bundle (`com.bravosecure.mobile`) **differ**, so `assetlinks.json` and AASA each need their
own. And `android/app/build.gradle:148` falls back to the **debug** signing config when the upload key
is absent — **a build signed with the debug cert fails App Links verification silently** while
everything else looks fine.

### Security stop-condition — must be checked before shipping

`mintCode`'s own docblock (`enterprise-join.service.ts:1633-1640`) calls the code **a capability**:
possessing it reveals the org name and team and injects a row into the admin inbox. Putting it in a
URL puts it into browser history, clipboard managers, referrer chains and any link preview
service that fetches it. CLAUDE.md lists auth/invite tokens under **stop conditions** — this must be
checked against the architecture doc before shipping, not after.

Mitigations to weigh: keep the code in the URL **fragment** (`#code=`), which is never sent to the
server or logged in referrers; keep single-use + 7-day expiry (already true); and do **not** open the
resolve endpoint anonymously without a separate decision — today `GET /enterprise/referral-links/:code`
is JWT-guarded (`enterprise-join.controller.ts:38`) and its "safe `{valid:false}`" design
deliberately hides org data from invalid codes.

### Gate

New: a unit test for the URL parser (valid, malformed, missing code, wrong host, case), a test that
the park replays after auth, and a source scan that the handler routes via `departmentalEntry`
rather than a literal navigator. Device: install the APK, tap a `bravosecure://join?code=…` link,
confirm the code lands prefilled — **a scheme change is invisible to Jest and can only be proved on
a device.**

---

## B-638 — Restore the EMERGENCY CALLS card; remove LINKS

**Client:** wants the emergency entry point to look like **image 3** (a card) and not **image 4**
(a small header word), _"and remove the link option."_

### ⚠️ This reverses a decision from yesterday

- The card was **added** 2026-08-22 14:47 in `c0c53dde` (B-613).
- The card was **removed** 2026-08-22 19:32 in `aecc29ac` (**B-626**) — five hours later — because
  the founder asked for it to become a header door "like LINKS".
- Today the client asks for the card back and LINKS gone.

That is the client's call to make, and it is recorded here so nobody re-derives the reversal as a
bug later. The B-626 rationale comment still sits at `CallsLogScreen.tsx:265-275` and will
contradict the restored code — **it must be rewritten, not left behind.**

### ⚠️ The card in the screenshot is NOT the card that was removed

Verified: `git log -S "Reach emergency services" -- src/screens/messenger/CallsLogScreen.tsx`
returns **nothing** — that subtitle has never been in this screen. The phrase exists only as intro
prose in `src/screens/vbg/VBGEmergencyScreen.tsx:132`.

|            | Client's image 3                                     | What actually shipped (`aecc29ac`)                                      |
| ---------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Title      | EMERGENCY CALLS                                      | EMERGENCY CALLS                                                         |
| Subtitle   | "Reach emergency services on any network worldwide." | "{Country} · tap a number to call"                                      |
| Body       | none                                                 | one-tap dial **chips** (All services / Police / Ambulance / Fire / 112) |
| Affordance | right **chevron** → opens a page                     | each chip dials `tel:` **directly**                                     |
| Position   | between header and tabs                              | first child of the ScrollView, **below** the tabs                       |

These behave differently and it matters: **the chips dial in one tap; a chevron card costs two.**

**Recommendation — build the card the screenshot shows, and keep the chips inside it.** Header row
(red icon tile + "EMERGENCY CALLS" + subtitle + chevron → `EmergencyServices`), chips underneath.
That satisfies the screenshot, keeps the one-tap path, and restores tested code rather than
inventing new code. The alternative — a chevron-only card — is a strictly slower emergency path and
should be a conscious choice, not a side effect of copying a mockup.

The removed JSX, helper (`emergencyQuickDialChips`), and styles are recovered verbatim from
`aecc29ac` and will be restored rather than rewritten. Restore alongside them: the 4 deleted card
tests, the `emergencyQuickDialChips` unit pin, and the `@screens/vbg/deviceCountry` test mock.

### ⚠️ Removing LINKS orphans a whole screen

**`CallsLogScreen.tsx:292` is the ONLY navigation to the `Links` route in the entire app.** No menu,
chat-info, files, settings or modules row reaches it; no notification lane targets it. Delete the
button and `LinksScreen` becomes unreachable dead code — the route stays registered, so it will not
crash, it will simply never open again.

CLAUDE.md's "no door lost" rule (G2) makes that a defect, not a cleanup. **Three options, and this
is a client decision:**

|                       | Option                                                       | Consequence                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** _(recommended)_ | Remove LINKS from the Calls header, give it a door elsewhere | Client gets the uncluttered Calls header they asked for; the shared-links browser survives. Natural homes: the Files screen (same "things shared in chats" family) or Chat Info.   |
| **B**                 | Genuine feature removal                                      | Delete the button, route, screen, both param entries, and fix `agentShellFooterRoutes.test.ts:67`. Honest, but the client loses a working feature they may not have meant to lose. |
| **C**                 | Ask                                                          | Confirm they meant "off the Calls header", not "delete the feature".                                                                                                               |

The spec proceeds on **A** unless told otherwise, because it is the only option that satisfies the
literal ask without destroying something they did not ask to lose.

### ⛔ Review round 2 — the card must NOT be restored verbatim: it makes a false safety claim

**F-19 — the country comes from the phone's LANGUAGE SETTING, not from where the user is.**
`src/screens/vbg/deviceCountry.ts:13-44` reads `NativeModules.I18nManager.localeIdentifier` (Android)
/ `AppleLocale` (iOS), falling back to `Intl.DateTimeFormat().resolvedOptions().locale`. It is fully
offline and **has nothing to do with the user's location, SIM, or network.**

The recovered card renders `{entry.name} · tap a number to call`. So **a user physically in Bangladesh
holding an `en_US` phone gets a card headed "United States · tap a number to call", offering 911** —
on the app's emergency surface. In this app's markets, English-locale phones outside the US/UK are
the norm, so this is likely, not theoretical.

**This is a safety claim the app cannot support, and the first draft restored it verbatim without
noticing.**

> **DECIDED (review round 2, reversing my own first remedy).** My first instinct was to _drop_ the
> country name. The edge review showed that makes it **worse**: strip the label and a user in
> Bangladesh on an `en_US` phone sees _"tap a number to call"_ over a **911** chip **with nothing
> saying whose 911 it is** — the wrong guess is now hidden instead of visible and correctable.
>
> **The honest design keeps the name, states where it came from, and offers a way out:**
> `United States · from your phone's language · change`, with the chevron reading as _change country_
> rather than a generic "more". `VBGEmergencyScreen` already accepts `route.params?.countryIso` and
> has a searchable full directory (`emergencyNumbers.ts:225-228`), so the escape hatch exists — it
> just was never presented as one.

**M7 — "keep 112 dominant" is a change to the helper, not a styling choice.**
`emergencyQuickDialChips` marks the universal chip `strong` **only when it is the sole chip**
(`strong: out.length === 0`), and where a country's own "all services" number _is_ 112 (Albania,
Andorra, Bulgaria…) the `!out.some(c => c.number === '112')` guard means **there is no Universal chip
at all**. So the requirement changes the helper the doc elsewhere says to restore verbatim **together
with its unit pin** — the pin must be flipped under a `DOCUMENTS B-638` name, not left asserting the
old shape.

**N4 — dedup identical numbers.** Bangladesh is `{all:'999', police:'999', ambulance:'999',
fire:'999'}` (`emergencyNumbers.ts:41`); Australia is `000` four times. The recovered card renders
**four identical numbers under four labels** plus a fifth 112 chip. Dedup by number on restore.

**N5 — `recordEmergencyCall({countryIso: entry?.iso})`** persists the **locale-derived** ISO as the
country of an emergency call. If that log is ever exported or shown, it inherits the same false claim.

> **Citation correction (round 2):** the first draft said `emergencyForIso(null)` collapses to 112 at
> `deviceCountry.ts:47-55`. Wrong twice — `emergencyForIso(null)` returns **`null`**
> (`emergencyNumbers.ts:232-235`), the 112 collapse lives in **`emergencyQuickDialChips`**, and
> `deviceCountry.ts:46-56` is `regionFromLocale`. The remedy survives; the citation did not.

_(Corollary: offline / airplane mode / no SIM change none of this — the directory is bundled
(`emergencyNumbers.ts:1-13`). The first draft listed those as open questions; they are a false lead
and nobody should instrument a network probe for them.)_

**F-25 — a chip that cannot dial is silent, and still writes "call placed".** Both the existing site
(`CallsLogScreen.tsx:366`) and the recovered chips do `recordEmergencyCall(...)` then
`Linking.openURL('tel:…').catch(() => {})`. That order is deliberate and enforced
(`emergencyDialSites.test.ts:64-75`). But on a device with no telephony — a tablet, **or BlueStacks,
which is the QA fleet** — the tap does nothing visible while logging an emergency call. Give the
`.catch` a visible fallback (an alert showing the number to dial manually), and note that emulators
cannot exercise this path.

**F-24 — an emergency chip tapped during a live Bravo call.** No `PhoneState` / audio-focus handling
exists in `src/modules/messenger/webrtc/`. The cellular dialler takes audio focus while the Bravo call
keeps its foreground service and its `phoneCall`-typed mic claim — most likely leaving a silent call
the user believes is still connected. In an emergency the cellular call must win; the Bravo call
should be **ended or visibly suspended**, not left looking live.

**F-26 — DECIDED: pinned above the tabs, not scrolling inside the list.** The recovered JSX was the
first child of the `ScrollView` (so it scrolls away) and deliberately outside the filter (_"an
emergency is never 'filtered out'"_). The client's screenshot shows it **between the header and the
tabs**. Take the screenshot: an emergency door that scrolls off-screen is the one affordance that
must never require a scroll to find, and the "never filtered" intent is better served by pinning than
by being first-in-list. `CallsLogScreen.tsx:252` renders the header in the embedded body too, so the
pinned position works in **both** the pushed screen and the embedded tab.

**F-28 — a second stale docblock.** `LinksScreen.tsx:1-10` says _"Reached from the Calls screen's
'Links ›' header button"_, which becomes false the moment LINKS moves. Same class as the B-626
comment already flagged.

### If LINKS moves — both candidate homes have a problem

- **Files** (`FilesScreen.tsx:252`) redirects to `VaultLock` whenever a vault PIN is set. Moving the
  Links door there **puts the shared-links browser behind the vault PIN**. That may well be desirable
  — link URLs from chats are arguably vault-class — but it is a **behaviour change, not a door move**,
  and it collides with the founder's standing vault-PIN rule.
- **Chat Info** promises per-chat and delivers global: `LinksScreen.tsx:1-10` lists links from **every**
  conversation, with a per-row chat chip. A door inside Chat Info reads as "links in _this_ chat", so
  it is only viable if `LinksScreen` gains a `conversationId` filter — new work, not a door move.
- Whichever host is chosen, the **button** must be added such that the host is reachable in **both**
  shells (messenger and agent), or "no door lost" loses the door in one shell — the B-257/B-258 class
  again. Pin it with a scan.

### The header EMERGENCY button goes too — the screenshots settle it

An earlier draft left this undecided. Re-reading the two images answers it:

- **Image 4 (rejected):** header reads `CALLS · 📞EMERGENCY · LINKS ›` — the emergency door is a
  header word.
- **Image 3 (wanted):** header reads `CALLS` **only**, with the card below. There is **no header
  EMERGENCY word in the image the client approved.**

So the client's ask is coherent and complete: **the card replaces the header button, and LINKS goes.**
Resulting header: just `CALLS`. The card becomes the sole door to `EmergencyServices`, which is why
its chevron is load-bearing.

### Tests that will go RED (must be updated, never deleted)

| Test                                 | Asserts                                       | Why it flips                       |
| ------------------------------------ | --------------------------------------------- | ---------------------------------- |
| `emergencyCallsLog.test.tsx:190`     | `getByLabelText('Emergency services')` exists | the header button is removed       |
| `emergencyCallsLog.test.tsx:192`     | `queryByText('EMERGENCY CALLS')` is **null**  | the card returns — invert it       |
| `emergencyCallsLog.test.tsx:196-199` | pressing the header door navigates            | the press target moves to the card |
| `emergencyCallsLog.test.tsx:201-204` | _"sits alongside Links"_ — Links exists       | LINKS is removed                   |

> **Correction (review round 1).** An earlier draft listed `messengerPersistentTabs.test.ts:145,148`
> as going red. **It does not.** Those lines pin `activeTab === 'Calls' && <CallsLogBody embedded` and
> the `CallsLogBody` import — neither mentions the card. It is a **constraint** on where the card must
> live (it must render in the embedded body, not only the pushed screen), not a test that flips.

`emergencyDialSites.test.ts:64-75` stays green **only if each chip calls `recordEmergencyCall`
before `openURL('tel:`** — preserve that order. Its positive half (`:76-93`) is a whitelist of three
dial sites; the restored chips add a fourth, which will not fail but would be unpinned. Add it.

### Gate

> **Correction (review round 1).** An earlier draft said "app project, `screens/messenger`". That is
> **not** the gate. `CallsLogScreen.tsx` is under `src/screens/messenger/**`, so CLAUDE.md mandates
> the **full two-project messenger gate**: `--selectProjects messenger-crypto` run **twice** (flake
> rule) **plus** `--selectProjects app --testPathPattern "screens/messenger"`. The same correction
> applies to B-641 wherever it touches a messenger screen.

Device: the card must render on **both** the pushed Calls screen and the embedded Calls tab, and a
chip must dial.

---

## B-639 — Agencies get the departmental-channel system

**Client, verbatim:** _"we have develope workspace for enterprice plane. now the channle things we
need for agency the exsitng channel the deparmental cahnt is not good. so pull the whole cahnnel to
deparmental channel things."_

**Reading (confirmed correct by investigation):** enterprise/workspace tenants get the good
hierarchical tree; agencies get a worse flat screen. Move agencies onto the tree.

### What agencies actually see today

`DepartmentChannelsScreen.tsx:371` — `const orgFirst = isWorkspace;`

- **Workspace** → per-organisation collapsible `ChannelTree`: tier pills, colour coding, branch
  lines, member counts (`:1010-1066`).
- **Agency** → the LEVELS branch (`:1067-1091`): flat card blocks headed `LEVEL 1 — …`,
  `LEVEL 2 — …`, grouped by the stored `level` column with **no parent/child nesting whatsoever**. A
  sub-channel renders in a different block from its parent with nothing connecting them.

**That flat screen is literally the one the client crossed out in an earlier review** — the docs
record `LEVEL 2 — MAIN` as "THE EXACT SCREEN the client review crossed out in item 11"
(`DepartmentChannelsScreen.tsx:358-369`). Workspaces were moved off it; agencies were left on it.
The client is now asking for the same fix they already asked for once. That is a strong argument for
doing this.

### The data is already there

Agencies are **not** structurally flat:

- `createChannel` writes `parent_id` for every org with no tenant branch
  (`department.service.ts:1054-1060`); `level` is set by a DB trigger for all orgs.
- `listChannels` emits `parent_id`, `parent_hidden`, `visible_ancestor_id`, `root_id`, `level`,
  `is_lateral`, `workspace_tenant` with **no tenant branch** (`:238-299`).
- The agency channel editor **already has a parent picker** (`ChannelEditorScreen.tsx:554-579`).

So `buildChannelTree` has everything it needs, and the feared "flat pile" does not materialise: a
parentless agency row is classed `{kind:'organisation'}` by `placeRow`, and with the member
directory's `collapseChildless: true` a childless root is emitted as a **neutral depth-0 card**, not
a phantom organisation. That is the same path that makes flat workspaces render correctly today.

### The one thing that genuinely breaks — and it is not cosmetic

`nestParentedBroadcasts` is computed **unconditionally** at `DepartmentChannelsScreen.tsx:325`, but
**only the tree branch consumes it** — the LEVELS branch renders from raw `channels`. So flipping
`orgFirst` silently switches it on for agencies.

Agencies get a mandatory auto-minted `#broadcast` **per level**, parented to whichever channel
happened to be created first at that level (`department.service.ts:1074-1076`,
`ensureBroadcastForLevel:1099-1142`) — while **every member is seeded into it**. Nesting it would
give members of other branches a masked parent and demote their guaranteed announcements door to a
"(not shown)" rung. The objection is recorded verbatim at `organisationTree.ts:186-192` and was
already **rejected once as a global change**.

Agency level-1 broadcasts are parentless and safe. **Every level ≥ 2 broadcast is parented and would
be demoted.** This is a real loss of an announcements door for real members.

### Plan — the smallest increment that delivers the ask, client-only

1. `DepartmentChannelsScreen.tsx:371` — agencies take the tree, via a **separate presentation flag**,
   never by widening `isWorkspace` itself.

   > **Correction (review round 1).** An earlier draft justified this by saying the client's
   > `isWorkspace` is a live permission discriminator. **That is wrong.** `mintRefusalFor`'s
   > branchless relaxation (`department.service.ts:765-769`) and `manager_scope_root_ids` key on the
   > **server's** `workspaceTenant` / `isWorkspaceTenant(orgUserId)`. The client boolean at
   > `DepartmentChannelsScreen.tsx:311` is local and consumed only at `:923` and `:1010`; changing it
   > cannot move a server permission. **The conclusion still holds, for the correct reason:** the
   > client flag's job is to _mirror_ server refusals, so overloading it to mean "render a tree" makes
   > one boolean answer two unrelated questions and guarantees they drift.

2. **Keep `nestParentedBroadcasts` workspace-gated** — pass a flag at the `:325` call site. Agency
   broadcasts stay unnested root cards; nobody loses an announcements door.

   > **Correction (review round 1).** The claim "only the tree branch consumes it" is **false while
   > searching.** `allTreeRows` (`:325`) → `treeRows` (`:338`) → `searchedChannels` (`:505-509`) is
   > what the LEVELS branch renders when a search is active — which is **my own B-636 change, shipped
   > today**. The id set happens to be preserved so the visible result is currently unchanged, but
   > agencies already run through `nestParentedBroadcasts`, and gating it in step 2 therefore changes
   > agency **search** behaviour. That must be covered by the new agency test, not discovered later.

3. **Keep `onAddLateral` and `root: true` hidden for agencies** — the server refuses both
   (`lateral_channel_not_supported_for_agency:871-873`,
   `root_channel_not_supported_for_agency:1013-1022`). A rendered button that 400s is the bug (B-590).

4. `ManageChannelsScreen.tsx:351` — the flag goes in **alongside** the existing conjunct, giving
   `(isWorkspace || agencyTree) && serverKnowsTree`.

   > **BLOCKER fixed (review round 1).** The line is `isWorkspace && serverKnowsTree`, not
   > `isWorkspace`. **`serverKnowsTree` must be preserved.** Dropping it fails the old-server gate
   > **OPEN** — precisely what `serverKnowsLaterals`'s docblock (`organisationTree.ts:158-165`) says
   > must never be copied.

5. **🚫 BLOCKER — do not delete the agency's only create door.**
   `ManageChannelsScreen.tsx:809-813` renders the `New channel` footer under `{!orgFirst && !loading}`,
   and its own comment says _"this stays for the **AGENCY** and legacy-flat paths only."_ Flipping
   `orgFirst` removes it, and its workspace replacement is "Create new organisation" → `root: true`
   (`:617`), which step 3 hides because the server refuses it for agencies.
   **Net effect of steps 3+4 as first written: an agency admin could never create a top-level channel
   again.** A G2 "no door lost" violation manufactured by the plan itself, under a sentence claiming
   nothing was touched.
   **Fix:** keep the `New channel` footer for agencies — gate it on the agency flag, not on `!orgFirst`.

6. **🚫 BLOCKER — do not ship the deferred 4th tier by accident.**
   `ManageChannelsScreen.tsx:726-741` gates `onAddSubLevel`/`canAddSubLevel` on
   `manageLevelOf(c) >= 3` **and nothing else — there is no tenant check.** With the tree on, an
   agency admin gets "+ Add sub-level" on a tier-3 node, creates a stored level-3 channel, and
   `createChannel` then runs `ensureBroadcastForLevel` for a brand-new level (`:862-870` confirms the
   agency arm still does this) — which is exactly the auto-`#broadcast` question this doc defers to
   phase 2, shipped silently while the doc promises "agencies stay at 3 tiers".
   **Fix:** gate `canAddSubLevel` on the presentation flag too.
   **Also re-verify the 3-tier baseline** — `ChannelEditorScreen.tsx:264` already filters parents to
   `(c.level ?? 1) < 3`, so agencies may already be able to reach level 3 today. The baseline is
   asserted, not measured.

7. **Keep the editor's DEPARTMENT and TYPE fields for agencies** (`department` is a live permission
   key; conflating the two re-ships B-437) — **and fix the placement mismatch the new entry point
   creates.** `ChannelEditorScreen.tsx:521` shows the read-only PLACEMENT card under
   `{isWorkspace && !editing}`; `:552` shows the free-choice PARENT picker under `{!isWorkspace && …}`.
   An agency admin arriving from "+ Add sub-level" (which passes `parentId`) gets **no placement
   statement and a picker that can silently contradict where they tapped.**

8. **Decide what stage 1 means for a single-org agency.** Flipping `orgFirst` routes agencies through
   the `ORGANISATIONS` stage → stage 2 drill-in. For a one-org agency that is a pure extra tap plus
   enterprise vocabulary on an agency surface — and `enterpriseTerminology.test.ts` is a ban-canary
   for exactly that vocabulary. Check it before assuming this is free.

9. Resolve the asymmetry at `:923`: the blue "Manage Channels" CTA is hidden from agencies while the
   header cog is not, so an agency admin can already reach the screen by a less obvious route.

Result: agencies get the collapsible, colour-coded tree with real parent nesting, **keeping every
door they have today**. Zero server changes, zero migrations.

### ⛔ Review round 2 — four findings that change this item, one of them fundamental

**F-35 — for the MOST COMMON agency shape, the tree is a DOWNGRADE, not an upgrade.**
The tree's `tier` is **walk depth, not the `level` column** (stated as a rule at
`organisationTree.ts:882-892`). An agency whose channels are all parentless — which this document
itself calls the overwhelmingly common case — has every row collapsed out of `organisations` and
emitted as a **depth-0, `tier: null`, colourless card with no level pill**. A channel stored at
`level: 3` renders identically to one at `level: 1`.

Today's LEVELS branch shows `LEVEL 3 — …`. **So a flat agency would trade real level labelling for
undifferentiated cards, and agencies "actively use typed departments for real branch scope."**

### ✅ DECIDED — measured, not guessed (review round 2)

Rev 3 offered three options and recommended A without data. The critic demanded the one query that
decides it. **Run 2026-08-23, same database as the B-640 probes:**

```sql
-- agency = an org with no org_workspaces row; hasHierarchy() excludes broadcasts
                     orgs   with real (non-broadcast) parentage
  agencies             11                                     0
  workspaces           16                                     7
```

**ZERO of eleven agencies have a single parented non-broadcast channel.**

That kills Option A outright: _"ship the tree only to agencies that have parentage"_ would have
shipped it to **nobody** and delivered the client nothing. It was the recommended option, and it was
wrong.

| Option                                                                                         | Verdict                                                                                             |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| ~~A — only agencies with parentage~~                                                           | **DEAD.** Ships to 0 of 11 agencies.                                                                |
| **B — ship to all agencies, and render a level pill from the stored `level` on depth-0 cards** | **CHOSEN.** The only option that both delivers the tree and keeps the information agencies rely on. |
| ~~C — ship to all, accept losing the level labels~~                                            | Rejected: strips real branch-scope labelling from every agency to match a mockup.                   |

**And the data reframes the whole item.** With every agency channel parentless, an agency's directory
today is a flat list either way — so the tree alone changes little. What is actually broken is that
**an agency admin CAN already set a parent** (`ChannelEditorScreen.tsx:554-579` has the parent
picker) **but the member directory renders by `level`, so the nesting they create is invisible.**
That is a precise reading of _"the existing channel / departmental chat is not good"_: they can build
structure and never see it.

So B-639's real deliverable is **make agency structure visible and creatable**, with the level pill
preserving what flat agencies have today. The tree is the means, not the end.

> **Choosing B also dissolves five edge findings raised against A.** The edge review's M1 (a
> per-viewer `hasHierarchy` gives members of one agency different screens), M4 (compute the gate from
> raw rows or search and broadcast-nesting silently flip it), M5 (crossing the threshold re-shapes
> both screens under a live user), S6 and S7 all exist **only** because A gated on data shape.
> B gates on **tenant**, exactly as the screen does today, so the gate cannot flip mid-keystroke,
> cannot differ between two members, and has no threshold to cross. It also removes the collision
> with `ManageChannelsScreen.tsx:318-334` — _"ADMIN SURFACES NEVER COLLAPSE — gated on the TENANT
> alone, never on whether a hierarchy already exists"_ — which A would have violated on the admin
> screen.
>
> **The gate is therefore `(isWorkspace || isAgency) && serverKnowsTree` on both screens.** The
> `serverKnowsTree` conjunct is still required (F-32): it is what keeps an old server on LEVELS and
> what keeps the six LEVELS source scans pinning reachable code.

### Step 10 — the `#broadcast` rows need a distinguishing label (edge review, F-30)

Every agency broadcast is minted with the literal name `'#broadcast'`, one per level
(`department.service.ts:1120-1124`), and on the tree branch they are emitted last, at depth 0,
tier-less, with identical member-count subtitles. A 3-level agency would see **three rows called
`#broadcast`** with nothing to tell them apart — today the `LEVEL n —` headers are the only
disambiguator.

**Rule:** render an agency broadcast as `#broadcast · {tier name}`, using the existing
`nameForTier(level + 1, levelNames)` — the same helper the LEVELS branch uses for its headers, so no
second copy of the naming rule. This is a numbered plan step, not an aside, because "needs a label
either way" is exactly the kind of line a builder drops.

### Tests that will go RED — B-639 (added in review round 2)

The first draft claimed _"no render test anywhere mounts an agency directory"_. That is true of the
**member** directory only; the **admin** screen is pinned, by exactly the tests these changes touch:

| Test                                       | Asserts                                                                                       | Why it flips                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `manageChannelsOrgScoped.test.tsx:372-379` | an agency keeps the flat list + `New channel`, and has no "Create new organisation"           | the agency now takes the tree                                                                                     |
| `manageChannelsOrgScoped.test.tsx:442-450` | **the edge-A3 dual-affiliation case** — an agency response keeps the flat list and no stage 1 | same, and this is the case F-33 is about                                                                          |
| `manageChannelsOrgScoped.test.tsx:458-460` | presses `New channel` and asserts the editor gets `workspaceTenant: false`                    | the footer must survive (blocker 5), so this must stay green — it is the pin that proves the create door was kept |

Plus the still-missing **agency mount of the member directory**, which remains a required deliverable.

**F-30 — agency `#broadcast` rows become N identically-named cards at the bottom of the screen.**
Every agency broadcast is minted with the literal name `'#broadcast'`, one per level
(`department.service.ts:1120-1124`). On the tree branch `placeRow` classifies them first
(`organisationTree.ts:289`), `topLevelOf` skips them (`:672-680`), `directoryBuckets` sweeps them into
`announcements` (`:766-773`), and `buildChannelTree` emits them **last, at depth 0, tier-less**
(`:930-935`) — with identical `member_count` subtitles, because every member is seeded into every one.
A 3-level agency sees **three rows literally called `#broadcast`** with nothing to tell them apart.
Today the LEVEL headers are the only disambiguator that exists. Option A above avoids this for flat
agencies but not for hierarchical ones — **the broadcast rows need a distinguishing label either way**.

**F-33 — the broadcast decision must be PER ROW, not per screen.**
`serverTenant` at `:309` is `channels.some(c => c.workspace_tenant === true)` — **`.some()`**. With the
org scope fail-open on a cold boot (documented at `:394-404`), a user who belongs to both an agency
and a workspace gets both tenants' rows in one list, `isWorkspace` goes true on a single workspace
row, and `nestParentedBroadcasts` at `:325` runs over **all** channels **before** `orgSectionsOf`
splits them (`:404`). So plan step 2's "pass a flag at the call site" would nest the **agency's**
broadcasts too. `listChannels` already emits `workspace_tenant` **per row**
(`department.service.ts:290-299`) and its docblock says that is exactly why it exists. **Key the
decision on the row, not the screen** — this is edge A3, which has already cost a session once.

**F-32 — `serverKnowsTree` is what keeps the LEVELS branch alive, and the member screen lacks it.**
On an old server no row carries `parent_hidden`, so `placeRow` (`:293-297`) routes **every** row to
`orphanUnderSyntheticRoot` → skipped by `topLevelOf` → emitted at depth 0, tier null: **a literal flat
pile, strictly worse than LEVELS, which still groups by `level` — a column old servers DO send.**
`ManageChannelsScreen.tsx:351` already guards with `serverKnowsTree`; `DepartmentChannelsScreen` has
no equivalent. The gate on **both** screens must be
`(isWorkspace || agencyTree) && serverKnowsTree`, and that is also the predicate that keeps the six
LEVELS source scans pinning **reachable** code rather than a dead fork (the AUDIT #7/#8 class).

**F-34 — the lateral button is gated on a CAPABILITY probe, not the tenant.**
`ManageChannelsScreen.tsx:492-493` computes `lateralsSupported = serverKnowsLaterals(...)`, which
tests **presence** of `is_lateral` — a field the server emits for every org
(`department.service.ts:285`) and then refuses for agencies (`:871-873`). The gate must become
`lateralsSupported && isWorkspace`, and the pin goes on the **AND**, not the handler.

**F-39 — and if any refusable affordance does render, map its code first.**
`lateral_channel_not_supported_for_agency` and `root_channel_not_supported_for_agency` are not in the
client's refusal-copy maps, so an unmapped code renders _"Please check your connection and try
again."_ — a deterministic 400 presented as a network error, which makes admins retry forever.

### Deferred to phase 2 (needs the founder, then server work)

A **4-tier** agency tree, agency laterals, and agency roots all depend on one question: **should
agencies keep the auto-`#broadcast` per level?** Answering "no" unblocks all three but changes live
agency behaviour. A 4th tier also needs a promotion migration analogous to `20260820120000`, which
already hit `#broadcast` unique-index collisions on 2 of 5 workspace orgs.

Agencies stay at **3 tiers** in phase 1. Note this explicitly to the client.

### Tests

Six existing **source scans** pin the LEVELS branch and will fail if it is deleted —
`channelHierarchyGrouping.test.ts:52,72-85,87-113,116,122`, `enterpriseTerminology.test.ts:48`
(an anti-vacuity canary for a whole file of bans), `levelNames.test.ts:165-175`. **The branch is
therefore kept as the old-server fallback, not deleted** — which is also what those docs designate
it for.

> **Coverage gap that must be closed by this work:** `departmentDirectoryRender.test.tsx:94` mounts
> the screen **only** with `owns_workspace: true`. **No render test anywhere mounts an agency
> directory**, so the behaviour being changed is currently pinned by nothing. A new agency-mount
> test is a required deliverable, not a nice-to-have.

### Gate

Full messenger gate (crypto ×2 + app `screens/messenger`) + `screens/deptchat`. Device: an agency
account must show the tree, its broadcasts must still be reachable, and no button may 400.

---

## B-640 — Mission (Ops Room) group call fails

**Client, verbatim:** _"when the grpup are created after accepting the mission between clien and
agency and cpo if call start the called faile … and alos check the message thigns."_ Screenshot: a
red (!) circle, **"Call failed"**, a **Close** button, on the CPO shell's COMMS tab.

### The screen is identified exactly

`src/screens/messenger/GroupCallScreen.tsx:1972-1992` — the blocker gate, `call.state === 'failed'`
→ the literal string `'Call failed'` at `:1976`, `alert-circle-outline` in `C.err` at `:1983`,
`Close` at `:1992`. The style keys `blockerBox`/`blockerTitle`/`blockerBtn` exist in **exactly one
file**.

**This is the GROUP call screen, not the 1:1 one.** A 1:1 failure renders an `Alert.alert('Call
ended', …)` (`CallScreen.tsx:2021-2062`), not a full-screen card. The visible CPO tab bar confirms it
was launched inside the COMMS tab stack.

Note `state === 'unavailable'` renders a **different** label ("Group call unavailable"), so "no live
WS" and "ring with no roomId" are ruled out.

### Where `failed` comes from — 7 sites, one dominant

|        | Site                            | Fires when                                                    |
| ------ | ------------------------------- | ------------------------------------------------------------- |
| F1/F2  | `useGroupCall.ts:2022`, `:2155` | FrameCryptor unavailable (pre-join / post-join)               |
| **F3** | **`useGroupCall.ts:2435`**      | **catch of the whole group-key lane — the one that matters**  |
| F4     | `:2699`                         | reconnect budget exhausted mid-call                           |
| F5     | `:2927`                         | transport `failed` before ever reaching `joined`              |
| F6     | `:3942`                         | outer boot catch (room create, media, join, produce, consume) |
| F7     | `:1484/1493/1635/1642`          | a rejoin attempt returned failed                              |

**Ruled out, with evidence:** `launchCall` refusing (shows an Alert and never navigates —
`launchCall.ts:280-283`); TURN failure (lands in F6, not F3); the relay rejecting the ring fan-out
(**caught and swallowed** at `useGroupCall.ts:2529-2531` — it makes a call _silent_, never _failed_).

### The Ops Room's key lifecycle — where this actually breaks

- The **server** mints only the conversation row (`system-messenger.service.ts:160-221`). It holds
  **no key**.
- The trigger is **`assignCrew`, not booking-accept** (`org-mission.service.ts:549-556`).
- The **agency device** mints the Signal group by draining `dispatch_room_intents`
  (`dispatchRoomIntents.ts:135-152` → `productionRuntime.ts:5365-5471`).
- The **client** is keyed in the initial bootstrap; the **CPO is added later**, only when the agency
  device drains the add-intent (`dispatchRoomIntents.ts:174-181`).
- **If nobody drains, the CPO is seated server-side but keyless forever.** Drain triggers are only
  four screens mounting (`OrgMissionsScreen:226`, `AgentDashboardScreen:221`,
  `MessengerHomeScreen:410`) plus a 15 s-throttled key-request bridge.
- The single-mint guard is a **server-side atomic claim** that **fails closed**:
  `catch { /* fail closed — not mine this pass */ }` at `dispatchRoomIntents.ts:121`. **If the claim
  endpoint or its migration is not deployed, no room is ever bootstrapped at all.**

### Ranked hypotheses

**H1 — the CPO holds no Ops Room master key; the call dies at the 25 s key gate.** Host lane throws
`ensureCallGroupKey: missing real-group master key` (`productionRuntime.ts:6368`); the self-heal at
`useGroupCall.ts:2257-2288` — whose own comment literally names _"a CPO/client hosting a call in an
agency-owned mission Ops Room"_ — requests a resync, waits 25 s, and **re-throws into F3**.

> ## ⛔ H2 IS DEAD — server probed 2026-08-23, it is CLEAN
>
> **Environment, stated precisely (round-2 correction).** Probed the **Supabase Postgres** that holds
> the `supabase/migrations` tables and the real mission rows. The client's QA build points at the
> staging auth-service (`auth.94-136-184-52.sslip.io`). **I have NOT independently confirmed that
> service's `DATABASE_URL` points at this instance** — the table shapes and live mission data make it
> near-certain, but that link is **inference, not measurement**. If the client is testing against a
> different backend, these probes say nothing about it. **Also unconfirmed: whether the single
> 2026-08-20 room is the room the client actually tested.** Confirm both before treating H2 as closed
> for _this report_ rather than for this database.
>
> Ran before writing any code:
>
> | Probe                                              | Result                                                                                   |
> | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
> | `to_regclass('dispatch_room_crypto_claims')`       | **exists** — the B-416 migration IS applied                                              |
> | `dispatch_room_intents` grouped by state           | **7 rows, ALL `done`/`add`.** Zero `pending`, zero `failed`                              |
> | Ops Rooms in the last 21 days                      | **exactly one** — `667f7676…` "Mission MSN-991EC4AF8548", created 2026-08-20             |
> | That room                                          | **4 members, 4 intents (all `done`), 1 claim**                                           |
> | Its membership                                     | 1 `admin` (agency) + 3 `member`, all seated within 200 ms of creation                    |
> | Claim holders (finding 42)                         | both claims held by the **same admin, still a member of both rooms** — no orphaned claim |
> | Rooms with members but **no** intents (finding 44) | none in the current room                                                                 |
>
> **One historical artefact worth recording.** The July room `5019960d…` has **5 members but only 3
> intents** — the agency admin and one member (the client, seated in the same millisecond) have none.
> That is the **pre-B-416 shape**, before "the owner is now seated + intented too": those two were
> seated as bootstrap metadata members and their keys depended entirely on the create fan-out, which
> tolerates zero delivery. The August room shows the corrected 4-members/4-intents shape. So the
> defect class is **real and visible in production data**, but it is **not** present in the room the
> client is testing.
>
> **The server did its job perfectly.** The room was claimed, bootstrapped, every member seated,
> every intent acked. So "the drain never ran" is not the explanation, and this is **not** a deploy
> gap. The failure is client-side key distribution — which the database is structurally incapable of
> seeing, because the master key never touches the server (that is the E2EE design working).

**H2 — the claim/drain never ran, so the room was never bootstrapped (a DEPLOY gap, not a code bug).**
**RULED OUT** by the probe above. Retained only for the record, because `sqa.md` says in writing:

> **B-416** ("owner-only key authority = SPOF; group calls dead after the 25 s key wait") is
> **"FIXED in code — NOT deployed, NOT built"** (`sqa.md:16740`).
> **B-417** — "server deploy + APK still to land".
> **B-414** ("Ops Room group calls dead for CPO + agency POVs") — fixed in code, **device pass owed**.

If the box under test is missing those, every persona is keyless and the call cannot succeed no
matter what the client does. **This costs one SSH command to settle and would make the whole item an
ops task.**

### ★ H1b — the defect the probe actually points at: an intent reads `done` while a member is keyless

The probe found **every intent `done` and the call still failing**. There is a source-visible path
that produces exactly that state, and nothing ever retries it:

1. **The bootstrap fan-out returns SUCCESS when it reached nobody.**
   `productionRuntime.ts:5465-5468` — if `delivered === 0 && failures.length > 0` it emits
   `console.warn('[ops-room:bootstrap] create fan-out reached no members (kept local state)')`
   and then **`return {groupId, alreadyExisted:false}`**. The group exists locally on the agency
   device with a key; the client got nothing; the caller is told it worked.
2. **The client's own add-intent is then acked as already satisfied.**
   `dispatchRoomIntents.ts:198-207` — `addGroupMember` throws `already a member of` (the client _was_
   the bootstrap's initial member), and that arm calls `ackRoomIntent` and `continue`s. The comment
   even documents this as "the common case for the CLIENT's add-intent".
3. **Net result: the intent is `done`, the member is seated, and the member holds no key. Nothing
   retries, because from the queue's point of view the work is complete.**

That is precisely the database state I measured. The same hole catches a **re-added CPO** — `sqa.md`
B-441 already records "re-added CPO seated but keyless", and its recorded _unfixed_ half is
"the pre-mint key-request targets only the CLIENT, not the crew".

**The `already a member` fast-path acks on MEMBERSHIP, but the thing that matters is KEY POSSESSION,
and it never checks it.** Membership is server truth; key possession is device truth; the code treats
one as evidence of the other.

This is a real bug independent of whether it is the exact one the client hit, and it is the strongest
fix candidate in this item.

**H3** — key present but epoch/roster drift (the B-357 class); fails via F4/F5, not F3.
**H4** — camera/mic held by a zombie call → `getLocalMedia` timeout (fails fast, ~15 s).
**H5** — `sfu.join` rejected (`room_token_required`/`invalid`/`rate_limited`). Precedent: `sqa.md:6491`
records an infra P0 where `token_secret_unset_prod` **was** the entire "group call failed" report.
**H6** — FrameCryptor unavailable on that build/device (emulator, or an APK built without the
plugin). Note the **incoming** path is not pre-alerted the way the outgoing one is.

> **B-357 (`sqa.md:13984`) is the one historically UNEXPLAINED instance of this exact symptom** —
> closed as "diagnosed only, root cause pending one re-run". This report may be that re-run.

### The messaging half — same root, and it is the free diagnostic

A missing `masterKeyB64` blocks messaging and calls from the same store field:
`groupSendBlockedReason` returns `'group_key_missing'` (`messagingLogic.ts:301-311`), the composer
shows _"Syncing this group's encryption key — you can send once it arrives."_
(`chatScreenLogic.ts:85`), and inbound envelopes stash under `GROUP_KEY_PENDING_RECEIVE_ERROR`.

**So there is a 10-second discriminator that needs no logs at all.** In the same Ops Room, on the CPO
device, open the chat and try to type:

- Composer disabled with the "Syncing this group's encryption key" banner → **the key is missing →
  H1/H2. The call failure is a symptom; stop looking at the call code.**
- Messaging works normally → the key **is** present → it is H3/H5/H6, i.e. not distribution.

The code says the same thing at `useGroupCall.ts:2303-2305`: _"if messaging in the group works but
this id has no key, the id mapping (not distribution) is the bug."_

### ★★ BUILD THIS FIRST — F3 skips every teardown the outer catch performs (edge review, finding 40)

**Source-provable today, needs no device, and it plausibly explains why the failure REPEATS.**

`useGroupCall.ts:2432-2441` handles the dominant failure by doing exactly three things — `setState('failed')`, `sfu.leave`, and then **`return`**. Because it returns rather than throws, the outer catch at `:3938-4038` never runs. Two pieces of cleanup that live only there are therefore skipped:

1. **The B-343 camera/mic release** (`:3949-3953`). Its own comment: _"a dead boot must not strand the camera/mic … which wedges EVERY subsequent call's getUserMedia behind it (**the 'Call failed' loop**)."_ Local media is acquired at step 2 (`:1950`), long before the key lane, so on F3 the tracks stay held until the screen unmounts. **The repo already named this exact loop.**
2. **The minimized-registry clear** (`:4030-4037`). Its comment describes _"a … key-wait failure"_ leaving the floating bubble stuck on "connecting…" forever. **That is literally this case, and it is unreachable from F3.**

F1 and F2 (`:2020-2026`, `:2153-2160`) share the same `setState → leave → return` shape and the same gap.

**Fix:** extract the outer catch's cleanup and route F1/F2/F3 through it. This is a real bug, independent of which hypothesis is right, and it makes every subsequent diagnostic run cleaner — a stranded camera turns one failure into a run of them, which is exactly what "the call fails" reports look like.

_(The ring half is unaffected: `sentRingRef.current = true` is set at `:2516`, after the key block, so no recipient is left ringing.)_

> **Scope corrections from review round 2 — the claim above is too broad, and the fix has sharp edges.**
>
> **The camera strand survives only the MINIMIZED path.** Tapping the failed card's `Close` unmounts
> the screen → `leaveInternal` → both tracks stop (`:5518-5519`). So "turns one failure into a run of
> them" holds for **minimize-while-connecting**, not for the ordinary Close — which is also precisely
> what the skipped `:4030-4037` clear addresses (`keepAlive` returns the cleanup early at
> `:4048-4078`). Narrow the claim; the item still justifies itself.
>
> **Only TWO of the four cleanup steps do anything here.** Ring-cancel is gated on `sentRingRef`
> (`:3963`), set at `:2516` **after** all three sites → never fires. Room-reap fires **only at F1**
> (never joined; `createdRoomIdRef` set at `:2082`). So the fix delivers exactly the **B-343 media
> release** and the **minimized-registry clear**. Say so, or a builder will "repair" guards that are
> already correct.
>
> **⛔ `neverJoined` MUST STAY.** `participantTagRef.current` is set at `:2129`, **before** F2 and F3,
> so `neverJoined = !participantTagRef.current` (`:4017`) is already false there and the reap is
> correctly a no-op. If anyone relaxes that guard so a joined F3 "leaves properly", the frame takes
> the gateway's tag path with `hostTerminatesRoom: true` (`messenger.gateway.ts:2498`) and **evicts
> every peer already in the room.**
>
> **⛔ Exactly ONE `sfu.leave`, always carrying `roomId`.** F2/F3 already emit their own. If the
> extracted helper adds a second and `roomId` is ever omitted, `handleSfuLeave` falls back to **all
> tags on the socket** (`messenger.gateway.ts:2489-2492`) — the bug `useGroupCall.ts:2113-2127`
> already names. The helper owns the leave; the call sites stop emitting theirs.
>
> **F1 has no leave at all** (`:2018-2023` is `warn → setState → return`) — and F1 is the one site
> that genuinely needs the reap.
>
> **Safe only because of a server invariant — record the dependency.** At F1 on an _incoming_ call
> `ridLeave` can resolve to someone else's live room; it is harmless only because
> `endRoomIfEmptyByHost` refuses unless the caller **is** the recorded host **and** the room is empty
> (`messenger.gateway.ts:2465-2472`). A future server change would turn this into a room-killer.
>
> **Two follow-ons in the same commit:** the diagnosis table gains `[useGroupCall] boot failed: …`
> (`:3941`) as an F3 signature, and **`logAudit` must be re-run** — the outer catch logs
> `(e as Error).message`, which now newly receives group-key-lane errors.

### Plan

**Step 1 — settle H2 before writing any code.** I can do this without a device:
`POST /dispatch/room-intents/rooms/:cid/claim` against staging, and SQL probes on
`dispatch_room_intents`, `dispatch_room_crypto_claims`, `conversation_members`. If
`dispatch_room_crypto_claims` does not exist as a relation, **H2 is confirmed and the fix is a
deploy + migration, not a code change.**

**Step 2 — the founder runs the 10-second composer check** and, if possible, the one-line logcat
triage below. That distinguishes H1 from H3/H5/H6 definitively.

> ⚠️ **THE DIAGNOSTIC POISONS ITSELF IF RUN TOO CLOSE TO THE CALL (edge review, finding 41).**
> `KEY_REQUEST_COOLDOWN_MS` is **20 s** (`productionRuntime.ts:2752`, enforced `:3026-3030`) and the
> call's key wait is **25 s** (`groupCallKeyWait.ts:65`). Opening the keyless chat fires a resync of
> its own — so if the call is started within 20 s of that, the call's own resync is
> **cooldown-suppressed** and the 25 s wait is entirely passive. "Open the room, see it's broken, tap
> call" is both the natural user sequence **and** the sequence this diagnostic asks for.
>
> **So: run the composer check, then wait at least 30 seconds before starting the call.** Otherwise a
> healthy key-distribution path can be made to look broken. Look for
> `[group-key-request:runtime] … cooldown-suppressed` — it is a `warn`, so it survives the release
> build.

**Step 3 — fix what the evidence names.** Candidate code fixes, _not_ to be built speculatively:

- If H1 with `delivered=0`: the drain is too dependent on an agency device mounting one of four
  screens. `sqa.md` B-441 already records an unfixed half — _"the pre-mint key-request targets only
  the CLIENT, not the crew."_ That is a real, source-visible gap and the most likely genuine code fix.
- If H2: deploy B-416/B-417 and apply the migration.
- If H6: gate the **incoming** group-ring path with the same pre-alert the outgoing path has
  (`launchCall.ts:346-355`), so the user gets an honest reason instead of a bare "Call failed".

**Regardless of root cause, one honest-error fix is worth doing:** "Call failed" with a Close button
tells the user nothing and tells us nothing. F3 knows _why_ it failed. Surfacing "Waiting for this
room's encryption key" vs "Couldn't reach the call server" would have made this report
self-diagnosing.

> ⚠️ **It is NOT a trivial change, and the first draft called it "small and safe" without checking.**
> Carrying a reason out of the group-key lane means carrying a value that today is
> `(e as Error).message` — which can contain ids, key fingerprints and peer identifiers.
> `logAudit.test.ts` scans all of `src/modules/messenger`. **The reason must be a CLOSED ENUM**
> (`'key_pending' | 'transport' | 'server' | 'unsupported'`), mapped to copy at the render site —
> never the error string. Shipping the string is a red gate and a plaintext-in-logs risk.
>
> **And the copy must not over-disclose.** "This room has no encryption key" states a security fact
> about another user's device. "Still setting up secure messaging for this room — try again in a
> moment" says the same thing operationally without narrating the crypto state.
>
> **The site → enum map, written out (round 2 — "two states" was too few):**
>
> | Site                      | Enum          | Copy                                                                           |
> | ------------------------- | ------------- | ------------------------------------------------------------------------------ |
> | F1/F2 `:2022, :2155`      | `unsupported` | "This device can't run encrypted calls" — a build fact, safe to state          |
> | **F3 `:2435`**            | `key_pending` | "Still setting up secure messaging for this room"                              |
> | F5 `:2927`                | `transport`   | "Couldn't reach the call server"                                               |
> | F4 `:2699`                | `transport`   | "Connection lost" — **mid-call: must NOT render the full-screen boot blocker** |
> | F6 `:3942`                | `server`      | generic fallback                                                               |
> | F7 `:1484,1493,1635,1642` | `rejoin`      | "Couldn't rejoin"                                                              |
>
> **The leak vector is specific:** any copy explaining _why_ the key is missing would have to name the
> other party's device state ("waiting for {Agency} to come online"). That is presence information
> about another organisation's device, disclosed to a CPO — and this app deliberately strips presence
> (B-146/B-147). **The F3 copy names the ROOM, never a person or org, and must read identically
> whether no key exists or the caller is not entitled to one** — the same discipline
> `resolveReferralLink`'s `{valid:false}` already uses.

> **The messaging half is a SEPARATE deliverable, not a symptom to be closed.** The composer check is
> a diagnostic for the call bug — it is not a substitute for checking messaging in its own right. If
> the composer comes back **clean** (messaging works), _"also check the message things"_ is still
> unanswered and must be investigated on its own: membership rows, stash state
> (`pendingGroupEnvelopes`), and the B-262 stash-eviction class.

### Diagnosis commands

> ⚠️ **Release builds strip `console.log`** — `babel.config.js:30` keeps only `error`/`warn`. Every
> `step=3a` and host-lane key line is **invisible in the APK the client is running**. Only the `warn`
> lines below will appear.

```bash
adb -s <serial> logcat -c        # reproduce the call, then:
adb -s <serial> logcat ReactNativeJS:V *:S | grep -E \
"bravo\.groupcall\.boot|useGroupCall\] boot failed|group-key-request:runtime|ops-room:bootstrap|CALLSM|keydiag"
```

| Trace                                                                                     | Verdict                  |
| ----------------------------------------------------------------------------------------- | ------------------------ |
| `pre-join: FrameCryptor unavailable`                                                      | H6                       |
| `step=3 FAIL room_token_required`                                                         | H5                       |
| `transport acquired` but no `step=2 local media OK`                                       | H4                       |
| `step=3b waiting for group master key…` → 25 s → `refusing: …no group master key`         | **H1**                   |
| `[group-key-request:runtime] … delivered= 0` / `no targets` / `cooldown-suppressed`       | **H1, and it names why** |
| `keydiag … masterKeyFp=xxxx` differing from the host's, then `reconnect budget exhausted` | H3                       |

### Gate

Full messenger gate. **This item cannot be closed from source** — it needs either the server probe
(H2) or a device log (H1/H3/H5/H6). No fix will be claimed as verified without one of those.

## B-641 — Text truncated across the app; consistent type scale

**Client, verbatim:** _"these kind of cuttof things are all over the app. so make an audti to find
otu all the page these thigns and fix these all the word should be seenable u can reduce the text
size fo fit but make sure the text size should be consistence betwen all the over the app."_

Two deliverables, and they pull in opposite directions if handled carelessly: **(1) no app-authored
label may be cut off**, and **(2) the type scale must be consistent app-wide.** Fixing (1) by
sprinkling a one-off `fontSize` per screen would actively worsen (2). The plan below fixes (1)
without adding a single new font size.

### The screenshot's screen — identified by string identity, not inference

`src/screens/executive/ExecTeamScreen.tsx:296` — Executive Protection, Step 06 "Team & Add-ons".
Only one catalogue in the repo carries both quoted strings: `executivePricing.ts:31-36`
(`Advance Assessment Team`, `Secure Communications Support`). The Lite catalogue seeds different
names, so this is the Exec flow, not `CustomizeAddOnsScreen`.

**Cause — and it is NOT a missing `minWidth:0`; that is correctly present.** It is
`numberOfLines={1}` on a title in a row that reserves an incompressible `<Switch>`:

| deduction (360dp phone)               | dp       |
| ------------------------------------- | -------- |
| screen                                | 360      |
| − scroll padding 20×2                 | 320      |
| − card padding 14×2 + border 1×2      | 290      |
| − icon 32, gap 12, Switch ~51, gap 12 | **≈183** |

At `fontSize:14` Manrope SemiBold: "Female CPO Team" ≈118dp ✓, "Medical Support" ≈115dp ✓,
**"Advance Assessment Team" ≈185dp ✗**, **"Secure Communications Support" ≈225dp ✗**. That is
precisely the screenshot — the two short labels intact, the two long ones cut.

**On a 320dp device it gets WORSE, not better:** `scaleTextStyles` scales `fontSize`/`lineHeight`/
`letterSpacing` only (`src/utils/scaling.ts:81`) — it never scales the container widths around them,
so smaller type still fights a proportionally smaller box.

**Exact twin: `ExecReviewScreen.tsx:916`** — same catalogue, same styles, same Switch. The
duplicate-copy class again; **the fix must land in both or it drifts back.**

> **This is the 4th recurrence of this class**, and the remedy is already in the repo:
> `StepperBar.tsx:100-103` records a founder photo of `"Prote ction act…"`; `ObsidianTabBar.tsx:213-229`
> records `"MESSAG…"`; `messengerHeaderFit.test.ts:106-111` records _"the entire word MESSENGER is
> gone"_ — which I fixed yesterday. **`adjustsFontSizeToFit` + `minimumFontScale` is the house
> remedy, applied twice and never generalised.** That is the actual root cause of "all over the app".

### The type-scale half of the ask — the honest picture

- **A complete central type scale already exists** — `src/theme/typography.ts:23-96`, 11 steps, each
  routed through `scaleFont`, re-exported from `src/theme/index.ts`. **Consumers in `src/screens/**`and`src/components/**`: ZERO.** It is dead code.
- **2,826 `fontSize` literals across 42 distinct values.** 743 of them (**26%**) are invented
  half-steps (7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 18.5). The HTML design source
  under `preview/**` uses 20 sizes, all integers, with 3 half-step hits in 1,681 — so the half-steps
  are pure implementation drift, not design intent.
- Single screens carry up to **19 distinct sizes** (`DashboardScreen`, `CustomizeAddOnsScreen`).
- **Font scale is uncapped.** `scaleFont` reads device width only, never `PixelRatio.getFontScale()`;
  RN's `allowFontScaling` defaults on, so the OS multiplier stacks unbounded. `maxFontSizeMultiplier`
  appears **twice** in the whole app. `DESIGN_REVIEW_LOOP.md:114` requires reflow-not-clip to
  fontScale ≥ 1.3 — violated app-wide. 31 files bypass `scaleTextStyles` entirely.

### Scope decision — and I want the reviewers to challenge this

Normalising 2,826 literals onto an 11-step scale in one pass is a mechanical rewrite of nearly every
screen in the app, with no test able to see the result (no Yoga pass in react-test-renderer) and a
high chance of silent visual regressions the day before a client demo. **I do not recommend it as
part of a bug-fix batch.**

Proposed instead, in three parts:

**Part 1 — fix the truncation (the actual complaint).** 19 confirmed defects, prioritised. No new
font sizes; each fix is one of: allow a second line, move a price chip/badge out of the title row, or
apply the house `adjustsFontSizeToFit` + `minimumFontScale`.

| P      | Count | Highlights                                                                                                                                                                                                                                                                  |
| ------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | 3     | `MainNavigator.tsx:308` **MESSENGER tab label** (every authenticated screen); `DashboardScreen.tsx:867` all 3 client-home service subtitles; `BookingHomeScreen.tsx:285` "SECURE SER…"                                                                                      |
| **P1** | 7     | **`ExecTeamScreen.tsx:296` (the screenshot)** + its twin `ExecReviewScreen.tsx:916`; `AddOnsScreen.tsx:198` (worst ratio found — ~49dp for a title); `CustomizeAddOnsScreen.tsx:1056,1059`; `BookingConfirmationScreen.tsx:410`; `ZoneMapScreen.tsx:200`                    |
| **P2** | 4     | `AgentDashboardScreen.tsx:971` (most rows on the agency home); `ProDashboardScreen.tsx:228` (4 of 11 Pro tiles); `HomeSelectionScreen.tsx:168` (product-switch, first impression); `ReportIncidentDetailsScreen.tsx:352` (**legal/privacy copy** truncated on every device) |
| **P3** | 4     | `LoadingView.tsx:128,138` (**63 importers** — the sign-in screen); the two notification banners                                                                                                                                                                             |
| **P4** | 7     | Fit at 1.0×, clip at fontScale ≥ 1.3 — incl. `_obsidian.tsx:139`, a **42-file shared UI kit**                                                                                                                                                                               |

Plus a secondary class that **wraps rather than ellipsises** but is the same defect (app copy in a
frozen box): hard `width:` on label columns in `OrgCpoProfileScreen.tsx:433`,
`SecureProStatusScreen.tsx:569`, `AssignedMissionDetailScreen.tsx:660`,
`AttendanceResultScreen.tsx:99`.

> **Corrections (review round 1) — three claims in the first draft were wrong:**
>
> 1. **`StepperBar` was NOT a P0 and is already mitigated.** Verified: `width: 42` is at `:110`
>    (inside `railLabel`), not `:74`; `:41` sets `railLabels = null` when
>    `PixelRatio.getFontScale() >= RAIL_LABEL_MAX_FONT_SCALE`, so labels are **suppressed** exactly
>    in the clipping case; `:86` already carries `maxFontSizeMultiplier={1.4}` on the caption; and the
>    docblock at `:97-108` records that labels were deliberately moved out of a fixed 52 dp cell for
>    this very reason. Downgraded to **MINOR** — a long author-supplied `shortSteps` word can still
>    clip at normal font scale, nothing more. This was the draft's largest overclaim.
> 2. **"Move the price chip out of the title row" is a no-op at the screenshot's site.** At
>    `ExecTeamScreen.tsx:293-299` the chip is already inside the same
>    `<View style={{flex:1, minWidth:0}}>` as the title, which defaults to `flexDirection:'column'` —
>    so it sits **below** the title, not beside it, and the title already has the full column width.
>    **Only `numberOfLines={1}` and the `<Switch>` matter.** A builder following the old remedy list
>    would have chased a chip that was never in the way.
> 3. **The dp arithmetic is an ESTIMATE, not a measurement.** Nothing in this repo measures text.
>    Treat "Switch ~51dp", "≈185dp" as a hypothesis that predicts the screenshot correctly — which is
>    evidence, not proof.
>
> Counts drift too: the tree now holds **~2,888** `fontSize` literals and **~749** half-steps (25.9%),
> `LoadingView` has **67** referencing files and `_obsidian.tsx` **46**. The _shape_ of the finding is
> unchanged; re-count at build time rather than quoting these.
>
> **Disambiguation:** `MainNavigator.tsx:308` is the **tab-bar label** "MESSENGER". It is a different
> control from the messenger **header wordmark** fixed yesterday under B-629
> (`ObsidianTabBar`/`messengerHeaderFit`). The tab label was never fixed — this is not a regression of
> that work.

**Part 2 — make the scale consistent going forward, not retroactively.** Adopt
`src/theme/typography.ts` as the rule; normalise half-steps **only in the files this batch touches**;
add a source-scan gate that fails on a NEW half-step `fontSize` outside the theme. That stops the
drift at 26% instead of pretending to undo it. A full migration becomes a separate, scheduled piece
of work with its own device pass.

**Part 3 — cap the font multiplier PER SITE, never app-wide.**

> **Correction (review round 1).** The first draft proposed an app-wide cap. That **directly violates
> `DESIGN_REVIEW_LOOP.md:113-114`**, which requires text to _reflow, not clip_, up to fontScale ≥ 1.3
> and permits `maxFontSizeMultiplier` _"only where truncation is worse than scaling (**never on body
> copy**)"_. An app-wide cap is exactly the blanket application that rule forbids — and it would land
> on `ReportIncidentDetailsScreen.tsx:352`, which is **legal/privacy body copy**.

So: cap only on fixed-height chrome where scaling would clip (tab labels, stepper rails, pills), and
let body copy reflow. P4's fix is **layout that reflows**, not a cap.

### ⛔ Review round 2 — the order is wrong, and two existing scans would pass vacuously

**F-53 — the font multiplier is genuinely uncapped, but the ordering claim was WRONG. The two
reviewers disagreed; here is the resolution and the reasoning, so nobody re-opens it.**

The _fact_ holds: `scaleFont` (`src/utils/scaling.ts:68-74`) scales by **screen width only** and never
reads `PixelRatio.getFontScale()`; there is **no `Text.defaultProps`, no `allowFontScaling` setting,
and `maxFontSizeMultiplier` at exactly two sites** in the whole app. The OS multiplier stacks
unbounded.

**But "cap first, then re-measure, because it removes some Part-1 defects" does not survive scrutiny:**

- The P0–P2 dp arithmetic is computed at `fontSize: 14` with **no OS multiplier at all**, and P4 is
  _defined_ as "fits at 1.0×, clips at ≥ 1.3". So a cap moves **P4 and nothing else** — it cannot
  remove a defect that already truncates at default scale.
- **The client's screenshot is the proof**: those labels are cut on a normal phone at normal font
  size. Nothing about a multiplier cap touches it.
- It is also circular: round 1 established the cap must be **per site**, and you cannot enumerate the
  sites to cap without the Part-1 audit — of which capping is one of the three remedies.

**Order stands: Part 1 (truncation) → Part 2 (freeze the scale) → Part 3 (per-site caps for P4).**
The cap is the fix _for P4_, not a prerequisite for the rest.

**F-55 — two existing source scans parse these values with INTEGER-ONLY regexes, so a half-step
produces a FALSE GREEN.** `teamCellAlignment.test.ts:84-85` uses `/lineHeight:\s*(\d+)/` and
`/minHeight:\s*(\d+)/`; `stepperBarLabels.test.ts:57,66` uses `/cell: \{width: (\d+)/`. Change
`lineHeight: 12` → `12.5` and the regex captures `12`, the assertion compares the wrong number, and it
passes. **This is the "verify the mutation applied" trap CLAUDE.md records.** Widen all three to
`[\d.]+` **before** touching any value they read.

**F-54 — "allow a second line" collides head-on with two live pins.**
`stepperBarLabels.test.ts:113` asserts `numberOfLines={1}` is present; `teamCellAlignment.test.ts:86`
hard-pins `minHeight === lineHeight * 2`. Any type change must move `minHeight` in lockstep. Flip
these under a `DOCUMENTS B-641` name — never delete them.

**F-57 — the house remedy is THREE props, and the top-ranked P0 has none of them.** Android requires
`numberOfLines` alongside `adjustsFontSizeToFit`. `MainNavigator.tsx:308` is a **generic** label
(`{item.label}`) with neither, in a StyleSheet that is **not** `scaleTextStyles`-wrapped. And
`BaselinePackageScreen.tsx:71` sets `adjustsFontSizeToFit` with **no `minimumFontScale`**, so it can
shrink toward nothing — a **20th defect the audit missed**.

**F-58 — delete the `getItemLayout` concern; it is a non-issue and the real risk is the opposite.**
There is no `getItemLayout` anywhere in the repo, and `chatListMountBudget.test.ts:74` **actively bans
it**. So no list has a fixed row height — but _adding_ one as part of a fix would turn that test red.

**F-62 — a new `src/screens/executive/__tests__/` WOULD run, under the `app` project**, which
specifies neither `testMatch` nor `roots` and inherits Jest's default. So the "scan a sibling by path"
precedent is unnecessary — drop it. Note the corollary: because `app` uses the default `testMatch`,
**every** file under any `__tests__/` directory is treated as a test, helpers included.

**F-59/F-60 — "adopt `typography.ts`" is not the cheap win Part 2 implies.** It has 12 steps (not 11)
and routes `fontSize`/`lineHeight` through `scaleFont` while leaving `letterSpacing` **raw** —
inconsistent with `scaleTextStyles`, which scales all three and is imported by **187 files**. Worse,
`scaleFont` already rounds, so `7.5 → 8` in a wrapped file and stays `7.5` in an unwrapped one:
**the scale is already inconsistent between wrapped and unwrapped files, which is a bigger consistency
defect than the half-steps, and nothing tests it.** The new scan should flag unwrapped StyleSheets as
well as new half-steps.

**F-61 — RTL.** `textAlign: 'right'` appears 19 times across 18 files and will not flip under
`I18nManager.forceRTL` (which is wired — `src/i18n/index.ts:56-64`). Any `textAlign` introduced by
this work must use logical values (`'start'`/`'end'`), or a consistency fix regresses RTL.

**F-63 — five cited paths in the first draft were wrong.** `StepperBar` is at `src/components/ui/`;
`ObsidianTabBar` at `src/navigation/`; `DashboardScreen` at `src/screens/dashboard/`;
`ReportIncidentDetailsScreen` at `src/screens/deptchat/`; `teamCellAlignment.test.ts` at
`src/screens/booking/__tests__/`; and `chatListMountBudget.test.ts` at
`src/modules/messenger/__tests__/` — which means it runs under **messenger-crypto**, not `app`.

### What must NOT be swept up

The audit separated **legitimate clamps** — person names, chat previews, file names, addresses, news
headlines, user-created group names, opaque booking refs. Clamping unbounded user data to one line is
correct design, not a bug. Roughly 30 name sites and 9 preview sites are explicitly excluded. A fix
that "un-clamps everything" would break every list row in the messenger.

### Tests

**Nothing currently catches any P0–P2 defect.** Six tests touch text layout; the closest,
`stepperBarLabels.test.ts:116-125`, checks `word.length <= 9` — a character-count proxy that never
measures against the `width:42` box, so **defect #3 passes it today**.

Two structural gaps to close:

1. **`src/screens/executive/` has no `__tests__` directory at all** — the screenshot's screen and its
   twin are unpinned.
2. Jest routing: the `booking` project matches only `src/screens/booking/__tests__/**` and
   `src/screens/agent/__tests__/**`, so an exec pin must live under the `app` project or follow the
   `teamCellAlignment.test.ts` precedent of scanning a sibling file by path.

**Pin shape:** `teamCellAlignment.test.ts:12-17` states the constraint correctly — _"react-test-renderer
runs no Yoga pass, so a render test can read the STYLE but never the resulting geometry."_ So the pin
must be a **source scan** of the contract: _no `numberOfLines={1}` on a Text whose row sibling is a
`<Switch>`/`<Toggle>` unless `adjustsFontSizeToFit` is present._ Two house traps apply — these files
are **CRLF** (a `\n`-anchored regex passes vacuously) and the block-comment stripper eats code
containing `/*`; copy the line-based stripper at `teamCellAlignment.test.ts:22-30`.

### Gate

App + booking projects; full messenger gate if any messenger file is touched. Device pass across the
`DESIGN_REVIEW_LOOP.md` §2 matrix at **320dp** and **fontScale 1.3** — the two conditions that
produce these defects and that no unit test can see.

---

## Deferrals — every one owes a `DOCUMENTS` pin

CLAUDE.md's regression contract: _"When you find a bug you are NOT fixing, land a test that pins the
CURRENT broken behaviour under a `DOCUMENTS B-NNN` name, with a comment stating what the assertion
must become — the fix commit then flips it."_ The first draft deferred a great deal and pinned none
of it. Each row below is a required deliverable of this batch, not of the deferred work.

| Deferred                                                                                                | Pin to land now                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-637 — the https link half (blocked on a domain)                                                       | `DOCUMENTS B-637`: the invite message contains **no** URL, and `NewChatScreen.tsx:53`'s link is dead. Flips when a domain is hosted.                                                                                                                                                                                                                                                                                                                           |
| B-637 — iOS universal links                                                                             | `DOCUMENTS B-637`: `app.json` has no `associatedDomains`.                                                                                                                                                                                                                                                                                                                                                                                                      |
| B-639 — agency laterals / roots / 4th tier                                                              | `DOCUMENTS B-639`: agency admins see no lateral or root affordance, and `canAddSubLevel` is false at level 3 for agencies. Flips if the founder answers the `#broadcast` question.                                                                                                                                                                                                                                                                             |
| B-639 — the LEVELS branch retained as old-server fallback                                               | Already pinned by six existing source scans — **do not delete them**, and add the missing **agency-mount render test**.                                                                                                                                                                                                                                                                                                                                        |
| B-640 — whichever hypotheses the evidence does not select                                               | `DOCUMENTS B-640`: pin the current behaviour of the branch that turns out not to be the cause, so it stays visible.                                                                                                                                                                                                                                                                                                                                            |
| B-640 — the B-262 stash-eviction class (arch-gated)                                                     | Already pinned; re-point, do not re-derive.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **B-640 — the crypto claim has no release or steal path** (edge F-42)                                   | `DOCUMENTS B-640`: `dispatch_room_crypto_claims` is `ON CONFLICT DO NOTHING`, first-writer-wins, **no expiry, no release, no reassign**. Probed clean _today_ — both claims held by a still-active admin — but "clean today" is data, not handling. A claimant who reinstalls re-mints over the same conversation id after a 2.5 s window (a B-35-class permanent fork); a claimant who is demoted or leaves makes the room **permanently un-bootstrappable**. |
| **B-640 — a room seated with members but NO intents** (edge F-44)                                       | `DOCUMENTS B-640`: the July room `5019960d…` is in exactly this shape (5 members, 3 intents). Nothing detects or repairs it — `listRoomIntents` filters `state='pending'`, so no claim, no bootstrap, permanently undecryptable. Pin a detector query.                                                                                                                                                                                                         |
| **B-640 — the pre-mint key-request targets only the CLIENT** (edge F-43, `sqa.md` B-441's unfixed half) | `dispatchRoomIntents.ts:145` passes `members: [client_id]`; `productionRuntime.ts:5384-5387` asks only those. If the client is offline but a CPO holds the key, recovery fails and the fork ships. **This is the strongest genuine code fix in the item** — it belongs here, not only inside a conditional step.                                                                                                                                               |
| B-641 — the 15 defects not fixed in this pass                                                           | `DOCUMENTS B-641`: one scan listing the known-truncating sites, so the count can only go down.                                                                                                                                                                                                                                                                                                                                                                 |
| B-641 — the ~749 off-scale half-step literals                                                           | `DOCUMENTS B-641`: a scan recording today's count as a **ratchet ceiling** — new half-steps fail, existing ones are grandfathered.                                                                                                                                                                                                                                                                                                                             |

## Corrections applied in review round 1

For the record, so nobody re-derives them:

| #   | First draft said                                        | Reality                                                                                                                 |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | B-637 Phase 1 (custom scheme) satisfies the ask         | It satisfies **neither** clause — messaging apps do not linkify custom schemes, and a scheme is useless without the app |
| 2   | `bravosecure.com` status inferred from a repo grep      | **Measured: does not resolve.** And the app ships that dead link to users today                                         |
| 3   | `JoinWorkspaceScreen` prefill "already done"            | Cold push only — `:51` is `useState` initial-state; a warm navigate leaves the input stale                              |
| 4   | `messengerPersistentTabs.test.ts` goes red              | It does not — it is a constraint, not a flip                                                                            |
| 5   | `StepperBar` is a P0 with `width:42` at `:74`           | `:110`, and the site is already mitigated at `:41`/`:86`. Downgraded to MINOR                                           |
| 6   | "Move the price chip out of the title row"              | No-op — the chip is already in a column below the title                                                                 |
| 7   | `nestParentedBroadcasts` reaches only the tree branch   | False while searching — my own B-636 `searchedChannels` path reaches it                                                 |
| 8   | `ManageChannelsScreen.tsx:351` is `isWorkspace`         | It is `isWorkspace && serverKnowsTree`; the conjunct must survive                                                       |
| 9   | Client `isWorkspace` is a live permission discriminator | Server-side symbols are; the client boolean is local. Right conclusion, wrong reason                                    |
| 10  | App-wide `maxFontSizeMultiplier`                        | Violates `DESIGN_REVIEW_LOOP.md:113-114`; per-site only                                                                 |

Two plan defects the critic caught that would have shipped as written: **B-639 steps 3+4 together
deleted the agency's only create-a-top-level-channel door**, and **`canAddSubLevel` being ungated
shipped the deferred 4th tier silently.** Both are now explicit blockers in that section.

## Appendix — proposed invite copy (B-637)

**Ship now — no URL, because no URL works yet.** A message whose most prominent line is a 404 is
strictly worse than today's, which at least contains only true instructions.

```
You're invited to join {Org} on Bravo Secure.

Your invite code: NR6KJFNJ

Open Bravo Secure, choose "Join workspace" and enter the code.
(The code is single-use and expires in 7 days.)
```

Improvements over today's string that cost nothing: the **org name** (so the recipient knows who is
inviting them), the code on **its own line** (tappable-to-select, and survives every client's line
wrapping), and the **expiry** (so a stale invite explains itself instead of looking broken).

**Once a domain is hosted**, one line goes back on top:

```
Tap to join: https://<domain>/join#code=NR6KJFNJ
```

The code stays in the message even then — it is the fallback for any client that strips the link,
and for a recipient reading on desktop.

> **Why the `#fragment` form:** a fragment is never sent to the server, never appears in access logs
> or `Referer` headers, and is not forwarded to a redirect target. Since the code is a **capability**
> (`enterprise-join.service.ts:1633-1640`), that is the difference between the invite living only in
> the recipient's browser and living in every proxy log on the path. **Note this only matters for the
> https form** — the app-scheme form has no server to leak to, so the earlier draft's use of
> `?code=` there was not a contradiction, but the https line must use `#`.
