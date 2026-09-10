# Case Study — Why Bravo Secure Bugs Recur Every Build

**Author:** QA (from `sqa.md` evidence)
**Date:** 2026-06-15
**Scope:** Builds 1.0.47 (vc69) → 1.0.54 (vc78), BlueStacks 3-device + physical Pixel/Xiaomi/Redmi
**Question being answered:** _Where, why, and when do the bugs occur — and why do the same ones survive every new build instead of being solved?_

---

## 0. Executive Summary

Across **8 builds and ~7 weeks**, the same handful of bugs keep coming back. The recurrence is **not random** and it is **not "the fix didn't work."** It is the predictable output of four structural gaps:

1. **Build ↔ repo desync** — the APK QA tests is rarely the source tree the fix lives in. Some builds ship code _ahead_ of the repo (uncommitted), others ship _behind_ committed fixes. So "fixed in source" and "still fails in the build QA has" are both true at once.
2. **The most damaging bug is not a code bug at all.** B-05 (calls die to a WebSocket drop) is "code done, **ops pending**" — it needs a server-side deploy (`WS_HEARTBEAT_GRACE`, restart policy, uptime monitor) that nobody with host access has shipped. It has therefore failed **15/15 calls on every single build** since first logged.
3. **One symptom, many band-aids.** The biggest _frontend_ cluster (B-01/B-06/B-16/B-17/B-19, group side of B-18) all share **one** root cause — _render decoupled from the data layer_. Each build patches the symptom that was filed, not the shared cause, so a new face of the same bug appears next build.
4. **The verification loop is broken in two places.** (a) Fixes are marked "FIXED (rebuild to verify)" in source but the rebuild+device-retest doesn't close the loop before the next build ships. (b) Key bugs can't be reproduced on the only always-available hardware (BlueStacks), so they're never confirmed fixed (B-20/B-21).

**The honest one-liner:** these bugs aren't unsolved because they're hard — most have a known fix. They're unsolved because the **fix, the build, and the test never line up on the same version at the same time**, and because one of them (B-05) lives on a server nobody is deploying to.

---

## 1. WHERE the bugs occur

### 1.1 By side (from `sqa.md` "Count by side & status")

| Side               | Resolved | Open     | Inconclusive | Total   |
| ------------------ | -------- | -------- | ------------ | ------- |
| **App (frontend)** | 8        | 3+       | 7            | **~18** |
| **Backend**        | 0        | 1 (B-05) | 1 (B-14)     | **~2**  |

**~18 of 20 bugs are frontend.** But the single backend bug (B-05) is the most damaging — it blocks _every_ call regardless of client.

### 1.2 By feature area — the hot spots

| Cluster                                              | Bugs                                     | Location                                                                                          |
| ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Group/call render layer** (biggest by count)       | B-01, B-06, B-16, B-17, B-19, B-24, B-25 | `GroupCallScreen.tsx`, `groupCallLayout.ts`, `useGroupCall.ts`, `useCall.ts`, WebRTC tile binding |
| **Inbound message render/append**                    | B-18 (1:1 + group), B-22                 | `messengerStore.ts` append/upsert, `direct:` vs group path                                        |
| **Key delivery / device identity** (mostly resolved) | B-11, B-12, B-15b, B-02, B-13            | `productionRuntime.ts`, sealed-sender, `signalDeviceId`                                           |
| **Backend transport**                                | B-05, B-14                               | `messenger-service` WS gateway, heartbeat/deploy                                                  |
| **Sync / restore**                                   | B-26                                     | server sealed-archive replay on restore                                                           |

**The densest knot is the call screen.** Both the _oldest_ open bug (B-01) and the _newest_ call bugs (B-24 foreground-loss, B-25 navigate-away) live in the same call-screen lifecycle/render code.

---

## 2. WHY the bugs occur (technical root causes)

From the `sqa.md` "Most probable root causes" table:

1. **`messenger-service` WS instability** — heartbeat grace too tight / crash with no restart policy → all clients kicked simultaneously. → **B-05, B-14**
2. **`signalDeviceId = 1` hardcoded** (now fixed) — shared `(userId:deviceId)` key → socket supersession churn → key-delivery + sealed-sender desync. → **B-11, B-12, B-15b**
3. **Render decoupled from the data layer** — tiles/messages keyed on index / `participant.joined` / remote events instead of bound off `consume` / `ontrack` / append. Media arrives and decrypts but never reaches a render surface. → **B-01, B-06, B-16, B-17, B-19, B-18(group)**
4. **1:1 inbound append not unified with group** — group append was fixed, `direct:` convos still don't append to the visible thread. → **B-18(1:1)**
5. **Non-owner-host key shortcut** — `resolveKeyId` looks under the wrong id / non-owner host refuses to broadcast. → **B-02, B-13**
6. **APK ahead of repo** — shipped builds contain uncommitted code paths. → **B-03, B-13**

**Root cause #3 is the one that pays the most rent** — it alone explains 6 frontend bugs. Fixing the symptom (one tile) never retires the cause (the binding pattern), which is why the cluster regenerates.

---

## 3. WHEN they occur — the recurrence timeline

The same "STILL NOT FIXED / STILL PRESENT" line repeats build after build:

| Build (vc)  | B-05 (call survival)                     | B-18                               | B-17                        | B-19                  | New bugs logged      |
| ----------- | ---------------------------------------- | ---------------------------------- | --------------------------- | --------------------- | -------------------- |
| 1.0.48 (71) | STILL FAIL                               | group FIXED, 1:1 FAIL              | STILL PRESENT               | improved              | —                    |
| 1.0.49 (72) | STILL FAIL                               | 1:1 STILL FAIL                     | STILL PRESENT (all 3)       | —                     | B-20                 |
| 1.0.50 (73) | STILL FAIL                               | —                                  | —                           | STILL PRESENT (all 3) | —                    |
| 1.0.51 (74) | STILL FAIL (new record ~24m30s)          | —                                  | STILL PRESENT (render race) | —                     | B-15b root corrected |
| 1.0.52 (75) | —                                        | group BLANK (no_key)               | —                           | —                     | **B-22, B-23**       |
| 1.0.54 (78) | WS died ~50s, media rode dead WS ~11m53s | banner added, still no live render | —                           | STILL PRESENT (all 3) | **B-24, B-25, B-26** |

**Reading the table:** the _open_ bugs never flip to PASS, and **each new build adds new bugs** (B-20 → B-22/B-23 → B-24/B-25/B-26). The backlog grows faster than it drains. B-05 has now failed on **six consecutive builds**.

---

## 4. WHY they aren't solved (the real answer — process failures)

This is the part the version table can't show. Each recurring bug survives for a _specific, identifiable reason_:

### 4.1 The build is never the same version as the fix ("APK ahead of / behind repo")

- **B-13** failed in the _installed APK_ because the build shipped a non-owner-host code path that was **uncommitted** ("APK ahead of repo"). QA was testing code the repo didn't have.
- **B-18** went the _other_ way: the 1.0.49 APK was built **behind** the B-18 thread-merge commit (`0933d8a`) — "several 'unchanged in 1.0.49' bugs were already partly fixed in source." QA was testing code that _predated_ the fix.
- **Net effect:** "fixed" and "still broken" are simultaneously true, and neither side can trust the other's status. **You cannot close a bug when the tester and the developer are never on the same bits.**

### 4.2 The fix exists but was never shipped to where it runs

- **B-05** is **"Code done · OPS pending."** `WS_HEARTBEAT_GRACE=25000` is already in `configuration.ts`; `.env.example` footgun fixed; `/healthz` healthcheck present. **But the actual server (`relay.94-136-184-52.sslip.io`) was never redeployed** with the restart policy + uptime monitor — that needs **host access nobody in the loop has.** So the single most damaging bug is "solved" in the repo and **100% unsolved in production**, every build, forever, until someone deploys.

### 4.3 Fixes are marked done in source but the device-verify loop never closes

- The 2026-06-09 developer session marked **B-18 "FIXED (rebuild to verify)"**, **B-20 "FIXED (1:1) · device-verify"**, **B-21 "HARDENED · device-verify"** — and the branch was **"Not pushed (hold until sign-off)."**
- The "rebuild and verify on a device" step is exactly the step that **didn't happen before the next build shipped**, so the next QA session re-files the same bug. The fix and the verification are on different calendars.

### 4.4 Some "bugs" are working-as-designed and were never going to be fixed

- **B-13** is **"BLOCKED — security stop-condition (by design)."** A non-owner host _correctly refuses_ to mint/broadcast a group's master key (owner-poison guard). The only residual failure — a member who never got the owner's key — is **fail-closed by design (never plaintext).** Real recovery requires an **owner-side key resync = architecture sign-off.** **DECIDED 2026-06-09: keep fail-closed.**
- So B-13 keeps appearing in logs not because it's unfixed, but because **it's a decision, not a defect** — and that decision hasn't been propagated into the bug's status, so QA keeps re-testing it.

### 4.5 The only always-on test hardware can't reproduce the bug

- **B-20** (camera not restored): "**BlueStacks can't reproduce** (magenta = 'live' track) — verify on Pixel/Xiaomi/Redmi."
- **B-21** (background ring): "Residual is the BlueStacks full-screen-intent/callkeep limitation — **verify on a physical device.**"
- These are stuck in limbo: fixed in code, **unverifiable on the rig QA uses daily**, and the physical-device pass keeps slipping.

### 4.6 The structural root is patched per-symptom, not at the cause

- B-01/B-06/B-16/B-17/B-19 are **one** bug (render decoupled from data) wearing five masks. Each build fixes the _filed_ mask (e.g. B-17 zombie-tag prune) and the **next mask** (B-19 tile displacement, B-25 tiles lost on navigate-back) surfaces. Until rendering is **bound off the consume/append path keyed on a stable participant/conversation id**, this cluster will keep producing "new" bugs that are the same bug.

### 4.7 Observability is too coarse to confirm a fix

- On vc78, inbound **group** text logs only `[recv.enter] → handled=true` — **PLAIN, RAW-JSON (B-22), and BLANK/no_key (B-18) all log identically.** "`handled=true`" is necessary-but-not-sufficient; render outcome has to be read off the _screen_ (uiautomator), not the logs.
- When you can't tell a success from a failure in the logs, **you can't prove a fix landed** — so the bug stays "open" out of caution and recurs in the ledger.

---

## 5. What **we** (team/QA/process) are doing wrong

1. **Shipping builds that don't match a known commit.** No build → commit-SHA stamping. "APK ahead of repo" (B-13) and "APK behind the fix" (B-18) are both symptoms of builds not being cut from a tagged, pushed commit.
2. **Treating B-05 as a code task when it's an ops task.** It has been "code done" for weeks; the missing step is a **deploy + restart policy + uptime monitor on the relay host**, which keeps not happening because ownership of the host isn't assigned.
3. **Not closing the device-verify loop before the next build.** Fixes get marked "device-verify" and then the next build ships before anyone verifies on a physical device.
4. **Letting "fixed in source, not pushed (hold for sign-off)" sit.** Held branches mean QA permanently tests stale bits.
5. **Re-testing decided-by-design behavior as if it were open** (B-13) — wastes cycles and inflates the "still failing" count.
6. **Growing the backlog faster than draining it** — every session adds new bugs (B-22→B-26) while the old ones stay open, with no triage gate that says "no new feature build until B-05/B-01 are verified."

## 6. What **Claude** (the dev assistant) is doing wrong

Being candid about the assistant's own contribution to the recurrence:

1. **Marking bugs "FIXED" on a source diff + green unit tests, without a device/integration pass.** "FIXED (rebuild to verify)" is an _unfinished_ state being reported in a _finished_ column. Unit tests (`directConversationMerge`, `groupCallTilePrune`, `recoverCamera`) prove the function does what the test says — **not that the feature works on a phone.** The project's own CLAUDE.md says exactly this ("type-checking and unit tests verify code correctness, not feature correctness").
2. **Fixing the filed symptom instead of the shared root.** Patching B-17's zombie-tag while leaving the render-binding pattern intact means B-19/B-25 were always going to appear. The higher-leverage fix (render off the consume/append path) was _identified_ but not _taken_.
3. **Leaving the highest-impact item (B-05) at "code done"** without escalating hard that it is **0% effective until deployed** — a code-side change to a server bug is worthless un-shipped, and that should be flagged as RED, not "done."
4. **Not enforcing build provenance.** The assistant has the repo context to refuse/flag a "test this APK" request when the APK can't be tied to a pushed commit — and didn't, so the ahead/behind-repo desync kept biting.
5. **Trusting `handled=true` as a proxy for "rendered."** Several "should be fixed" conclusions leaned on logs that can't distinguish a rendered message from a blank one. The assistant should have demanded screen-level evidence (which QA eventually did via uiautomator).

---

## 7. Corrective actions (what would actually break the cycle)

Highest-leverage first:

1. **Deploy B-05 today.** `WS_HEARTBEAT_GRACE=25000` + `--restart=unless-stopped` + external uptime monitor on `relay.94-136-184-52.sslip.io` + pull `messenger-service` logs at the recorded drop timestamps to confirm crash-vs-heartbeat. **This unblocks every call on every build at once.** Assign a host owner.
2. **Stamp every APK with its commit SHA** and refuse to QA a build that isn't from a pushed, tagged commit. Kills the entire "ahead/behind repo" class (B-03, B-13, B-18 confusion).
3. **Fix the render binding once, structurally** — bind tiles/messages off `consume`/`ontrack`/append keyed on a stable participant tag / conversation id. Retires B-01/B-06/B-16/B-17/B-19 and guards B-24/B-25 as a family instead of one mask at a time.
4. **Define "FIXED" = device-verified, not source-merged.** Add a required column: _unit ✓ / build ✓ / device-retest ✓_. No bug leaves "open" until all three are checked **on the same vc**.
5. **Add render-level breadcrumbs** so logs distinguish PLAIN / RAW-JSON / BLANK / no_key (B-22/B-18) without uiautomator — makes "is it fixed?" answerable from logcat.
6. **Triage gate:** no new feature build while a P0 (B-05) is unverified. Stop the backlog from outrunning the fixes.
7. **Re-status decided-by-design items** (B-13) out of the active-failing list so they stop consuming retest cycles.
8. **Physical-device verification pass** for the BlueStacks-blind bugs (B-20, B-21) — schedule it as a gate, not "when we get to it."

---

## 8. Per-bug recurrence ledger (why each one is still here)

| Bug                     | Root cause                                   | Why it recurs every build                                                                                                     |
| ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **B-05**                | Backend WS instability                       | Fix is "code done"; **server never redeployed** (ops/host access). 0% effective unshipped.                                    |
| **B-01**                | Render decoupled from data (#3)              | Symptom-level fixes only; binding pattern unchanged.                                                                          |
| **B-17 / B-19 / B-25**  | Render decoupled from data (#3)              | Same root as B-01; each build fixes one mask, next mask appears.                                                              |
| **B-18 (1:1)**          | `direct:` append not unified with group (#4) | Fixed in source ("rebuild to verify"); device-verify loop not closed; builds tested behind the commit.                        |
| **B-18 (group no_key)** | Key not present + no live stash-drain        | vc78 added a banner but stashed envelopes still need an app restart to render (no live auto-drain).                           |
| **B-22**                | Render path doesn't gate on key-state        | Renders raw JSON when sender lacks key; not reproduced when all hold the key, so intermittently "not seen" rather than fixed. |
| **B-13**                | Non-owner-host key shortcut (#5)             | **Working as designed (fail-closed); DECIDED keep.** Recurs in logs because status not propagated.                            |
| **B-15b**               | `signalDeviceId` supersession residue (#2)   | Mostly fixed; trigger is an intermittent emulator keychain miss → one silent first-message drop, self-heals.                  |
| **B-20 / B-21**         | Camera/ring native paths                     | Fixed in code but **BlueStacks can't reproduce**; physical-device verify keeps slipping.                                      |
| **B-24 / B-23**         | Call dies on foreground loss                 | New; teardown on background not handled. B-23 was this all along (screen-timeout ≈ 9 min misread as a timer).                 |
| **B-26**                | Restore replays server sealed archive        | Locally-deleted messages reappear on restore (no deletion-awareness / dedup in replay).                                       |

---

_This is a meta-analysis, not a new bug entry — it is intentionally kept out of the B-## numbering and the Summary Table in `sqa.md`. All claims are traceable to the cited sessions in `sqa.md`._
