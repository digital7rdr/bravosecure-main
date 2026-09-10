# Case Study — Why the Frontend (Call/Render) Bugs Never Get Solved

**Author:** QA (from `sqa.md` + `CLAUDE.md` evidence)
**Date:** 2026-06-15
**Scope:** The ~18 App/frontend bugs, focused on the call-screen render cluster
**Companion docs:** `CASE_STUDY_recurring_bugs.md` (whole project), `B-05_Server_WebSocket_Drop_Detailed_Report.md`

---

## 0. The one-sentence diagnosis

The frontend bugs survive every build because **the team keeps fixing the symptom that was filed instead of the one shared root cause behind them**, and then marks the fix "done" on a green _unit_ test **without ever verifying it renders on a device** — so the same bug returns next build wearing a different mask.

---

## 1. The frontend bug landscape

~18 of 20 bugs are App/frontend. They are **not 18 independent problems** — they collapse into **4 root causes**, and one of those causes (#3) accounts for the entire call-screen cluster:

| Root cause                                  | Bugs it generates                                   | Nature                                                                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#3 Render decoupled from the data layer** | **B-01, B-06, B-16, B-17, B-19, B-18(group), B-25** | tiles/messages keyed on index / `participant.joined` / remote events instead of bound off `consume`/`ontrack`/append → media arrives + decrypts but never reaches a render surface |
| **#4 1:1 append not unified with group**    | **B-18(1:1)**                                       | group append fixed; `direct:` convos still don't append to the visible thread                                                                                                      |
| **Key-state not gating render**             | **B-22, B-18(no_key)**                              | renders raw JSON / blank when the receiver lacks the master key                                                                                                                    |
| **App-lifecycle not handled**               | **B-23, B-24, B-25**                                | call dies on screen-off / app-switch; tiles lost on navigate-away                                                                                                                  |

**The tell:** the _oldest_ open bug (B-01, every session) and the _newest_ call bugs (B-24, B-25, vc78) sit in the **same call-screen file cluster** — `GroupCallScreen.tsx`, `groupCallLayout.ts`, `useGroupCall.ts`, `useCall.ts`. That's not bad luck; it's one unfixed foundation generating new cracks.

---

## 2. WHAT is going wrong (the five mechanisms)

### 2.1 Symptom-patching instead of fixing the root (the #1 driver)

Root cause #3 is **one** bug wearing many masks. Each build fixes the _filed_ mask and the next mask appears:

- vc71–74: fix **B-17** (zombie-tag prune — `computeTilePrune` extracted, unit test added).
- vc73/78: **B-19** (tile video displaced) still present on all 3 devices.
- vc78: **B-25** appears (navigate away → all remote tiles lost, timer resets 0:00).

All three are "render not bound to a stable participant/conversation id." The fix that was _identified in `sqa.md`_ — _"render off the consume/append path keyed on a stable participant tag / conversation id"_ — **was never taken.** Instead each session ships a tactical patch for the one tile that was reported. **You cannot drain a cluster by bailing one symptom at a time while the source keeps filling it.**

### 2.2 "FIXED" is declared on a unit test, not a device

The 2026-06-09 developer session marked **B-18 "FIXED (rebuild to verify)"**, **B-20 "FIXED · device-verify"**, **B-21 "HARDENED · device-verify"** — each shipping a new Jest test (`directConversationMerge`, `groupCallTilePrune`, `recoverCamera`).

But `CLAUDE.md` says it plainly: _"type-checking and unit tests verify code correctness, not feature correctness."_ A passing `groupCallTilePrune.test.ts` proves the **pure function** prunes a tag — it does **not** prove a `SurfaceView` renders a frame on a phone. The render bugs (B-01/B-19) are precisely the kind that **only a device shows** (BLAST buffer rejects, surface dimensions, aspect ratio) — and those never appear in a unit test. So "FIXED" was reported from the one place that _can't see the bug_.

### 2.3 The device-verify step never closes before the next build ships

Every "device-verify" tag is an **unfinished** status sitting in a **finished** column. The branch was _"Not pushed (hold until sign-off)."_ The rebuild-and-verify-on-a-device step is exactly the step that doesn't happen, so the next QA session re-files the same bug. **The fix and its verification live on different calendars.**

### 2.4 The build doesn't match the source ("APK ahead of / behind repo")

- **B-13**: APK shipped uncommitted code (ahead of repo) → QA tested code the repo didn't have.
- **B-18**: 1.0.49 APK built _behind_ the fix commit (`0933d8a`) → QA tested code that predated the fix.

So "fixed in source" and "still broken in the build QA has" are **both true at once**, and neither side trusts the other's status. No build → commit-SHA stamping exists to catch it.

### 2.5 Observability too coarse to prove a render fix

On vc78, group inbound logs only `[recv.enter] → handled=true`. **PLAIN, RAW-JSON (B-22), and BLANK/no_key (B-18) all log identically.** When the logs can't distinguish a rendered message from a blank bubble, **a render fix cannot be confirmed from logcat** — it has to be eyeballed via uiautomator, which is slow and easy to skip. An unconfirmable fix stays "open" and recurs in the ledger.

---

## 3. WHO is responsible (by role — process accountability, not blame)

These bugs are nobody's single fault; they're the output of **four roles each missing one handoff.**

| Role                                    | What they own             | Where it's going wrong                                                                                                                                                | What they must do differently                                                                                                                                                             |
| --------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Developer / Claude (implementation)** | Writing the fix           | Patches the filed symptom; marks "FIXED" off a green unit test; doesn't take the identified structural refactor (#3); leaves "device-verify" as the open step         | Fix the **root** (render bound off consume/append, keyed on stable id) **once**; never report "FIXED" without a device pass; flag "code done, unverified" as a distinct status, not green |
| **Release / build process**             | Cutting the APK           | Builds aren't tied to a pushed commit SHA → ahead/behind-repo desync (B-13, B-18); fixes held "not pushed" so QA tests stale bits                                     | Stamp every APK with `vc + commit SHA`; never ship a build QA can't tie to a pushed commit; don't hold fix branches indefinitely                                                          |
| **QA (tester)**                         | Reproducing + documenting | Strong evidence work, but verifies render bugs on **BlueStacks** which can't reproduce some (B-20/B-21) and shows fake camera frames; sometimes trusts `handled=true` | Run the physical-device pass as a gate; verify every render claim via uiautomator; confirm the fix code path is _in the build_ before testing it                                          |
| **Tech lead / architecture owner**      | Prioritization            | No one owns the structural #3 refactor; each session does tactical patches; no triage gate stops new feature builds while the cluster is open                         | Schedule the #3 refactor as one funded piece of work; define "FIXED = device-verified on the shipping vc"; gate new builds on the open cluster                                            |

**The honest distribution:** most of the recurrence traces to **implementation + release process** (symptom-patching, unit-green-as-done, build/repo desync). QA's contribution is smaller and mostly tooling-bound (BlueStacks can't see the bug). The structural fix not being scheduled is an **ownership/prioritization gap**, not an individual's error.

---

## 4. WHY each frontend bug is specifically still open

| Bug                                     | Root               | Why it keeps coming back                                                                                                                  |
| --------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **B-01** (black host tiles)             | #3                 | BLAST buffer rejects frame on a 4×2 surface; fix needs render-on-real-layout, never taken — only symptom patches.                         |
| **B-17** (zombie/blank tile)            | #3                 | Zombie-tag prune shipped (unit-tested), but the render-timing race underneath survives → blank tile still appears.                        |
| **B-19** (video in wrong tile)          | #3                 | Same binding flaw as B-01/B-17; never addressed at the binding layer.                                                                     |
| **B-25** (tiles lost on navigate-back)  | #3 + lifecycle     | New face of #3 — tiles not rebuilt from live producers on remount.                                                                        |
| **B-18 (1:1)**                          | #4                 | `direct:` append not unified with group append; "FIXED in source" but device-verify never closed + tested behind the commit.              |
| **B-18 (no_key)**                       | key-state          | vc78 added a banner, but stashed envelopes only render after **app restart** — no live auto-drain on key arrival.                         |
| **B-22** (raw JSON render)              | key-state          | Render path doesn't gate on key presence; only "not reproduced" when all senders happen to hold the key.                                  |
| **B-24 / B-23**                         | lifecycle          | Call teardown on foreground-loss never handled; B-23's "9-min spontaneous close" was this all along (screen timeout → background → drop). |
| **B-20 / B-21**                         | native camera/ring | Fixed in code but **BlueStacks can't reproduce**; physical-device verify keeps slipping.                                                  |
| **B-26** (restore replays deleted msgs) | sync               | Restore has no deletion-awareness / dedup against the server sealed archive.                                                              |

---

## 5. What would actually fix this (frontend)

Highest-leverage first:

1. **Do the #3 refactor once.** Bind tiles **and** message bubbles off the `consume`/`ontrack`/append event, keyed on a **stable participant tag / conversation id** (not array index, not `participant.joined`). For tiles specifically: don't bind `RTCView` to the stream until `onLayout` returns >10px on both axes, then force-remount with a changed `key` so a full-size `SurfaceView` exists before the first frame (the fix already written up under B-01). **This single change retires B-01/B-06/B-16/B-17/B-19 and guards B-25.**
2. **Redefine "FIXED" = device-verified on the shipping vc.** Add a status column: `unit ✓ / build-present ✓ / device-verified ✓`. No frontend bug leaves "open" until all three are checked on the **same** build.
3. **Stamp builds with commit SHA**; refuse to QA a build not tied to a pushed commit. Kills the ahead/behind-repo class (B-13, B-18 confusion).
4. **Gate render on key-state** so B-22 can't render raw JSON and B-18 surfaces a banner **and live-drains** the stash on key arrival (no restart).
5. **Add render-level breadcrumbs** distinguishing PLAIN / RAW-JSON / BLANK / no_key, so a render fix is provable from logcat.
6. **Handle the call lifecycle** — keep the call alive across screen-off / app-switch / navigate-away, and rebuild tiles from live producers on remount (B-23/B-24/B-25).
7. **Physical-device verification gate** for the BlueStacks-blind bugs (B-20, B-21).

---

## 6. Bottom line

The frontend bugs aren't hard — **B-01's fix is literally written out in `sqa.md`.** They persist because:

- the **root (#3) is patched per-symptom** instead of fixed once,
- **"FIXED" is declared from a unit test that can't see the bug**, and
- the **device-verify + build-provenance loop never closes** before the next build ships.

Fix the binding layer once, redefine "done" as device-verified-on-the-shipping-build, and stamp builds with their commit — and the call-screen cluster stops regenerating. Everything else is tightening that loop.

---

_Meta-analysis, intentionally outside the B-## numbering. All claims trace to cited sessions in `sqa.md` and the Developer Fix Session 2026-06-09._
