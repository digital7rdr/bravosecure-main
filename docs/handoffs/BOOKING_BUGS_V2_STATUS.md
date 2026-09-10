# BOOKING BUGS V2 — Fix Status

> **Updated:** 2026-07-26 — migration applied, auth-service deployed. `main` @ `5bc10d0`.
> **Plan:** `docs/handoffs/BOOKING_BUGS_V2_FIX_PLAN.md`
> **PDF:** `BRAVO SECURE App Testing Issues V2.pdf` — issues 11 + 18–45 are the booking lane.

---

## Verdict

**All 30 issues have code landed. 29 are complete. 1 (Issue 41) is deliberately
partial — its remaining half is a finance decision, not an engineering gap.**

This round closed the four partials the previous status report listed:

| Issue                          | Was                                     | Now                                                          |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------ |
| **18/19** Dept-chat entries    | partial — "needs a device repro"        | ✅ **root cause found in source** — `b5843c1`                |
| **11** Mission comms (CRIT)    | partial — failure was loud but not safe | ✅ **fails safely** — `ed93ecc`                              |
| **44** SOS console (CRIT)      | partial — backend only                  | ✅ **persistent + audible console-wide** — `7ee167a`         |
| **39** Roster profile          | ✅ with expiry + audit owed             | ✅ **both landed** — `de2485e`                               |
| **41** Agent acceptance (CRIT) | partial — escrow blocked                | 🟡 **decline now notifies**; escrow still §10 Q4 — `dad55c0` |

---

## What each fix actually was

### Issues 18/19 — the entry was DEAD in the Agent shell (`b5843c1`)

The previous pass could not reproduce these from source and said so honestly.
**The cause was in source after all, and the `as never` casts that pass removed
were what hid it.**

`GroupsScreen` is registered in TWO shells — `MessengerNavigator` AND
`AgentNavigator` — but `DepartmentChannels` is registered in
`MessengerNavigator` ONLY. `MainNavigator` renders exactly one shell at a time,
so for a **service-provider account in the Agent shell** there is no such route
anywhere in the mounted tree: `navigate()` finds no target, bubbles to the root,
and is **dropped**. Silent in a release build — "the card does not open", on
precisely the role most likely to hold the entitlement.

It typechecked because the screen types its navigation as
`MessengerStackParamList` at _both_ mount points, so TS validated the route
against a param list only one of the two shells implements.

Fixed with one shared resolver (`src/navigation/departmentalEntry.ts`) rather
than per-layout copies, which is what the PDF asks for. Issue 19 carried two
more defects on the same seam: the shell probe was a single-level `getParent()`
(reads false in deeper nesting → re-enters a mounted shell → also a dead tap),
and `navigate('Departmental')` passed no params so it landed on the shell's Home
tab rather than Attendance.

### Issue 11 — activation now fails safely (`ed93ecc`)

`assignCrew` inserts the mission at step 3 and opens the Ops Room at step 5. A
step-5 failure left a crew dispatched to a mission nobody could reach.

A **fresh** assign that cannot open a room is now rolled back — mission
`ABORTED`, crew stood down, arrival clock cleared — and fails with
`comms_room_unavailable`. The booking returns to the needs-crew list and a retry
is a clean fresh assign. No push fires, so nobody is told a mission is live.

Three deliberate boundaries: a **resume** is never rolled back (that mission may
be in flight — it keeps the marker and returns 200, and re-running `assignCrew`
re-drives the room, which is the repair path); the abort is conditional on
`status='DISPATCHED' AND pickup_at IS NULL` so a lead already at PICKUP wins; and
**escrow is untouched**, carried to the retry exactly as the no-show re-dispatch
leaves it.

The crew stand-down is load-bearing: `mission_crew_agent_active_uq` is scoped to
`status <> 'off'` regardless of mission status, so skipping it would leave every
CPO permanently "busy".

### Issue 44 — persistent + audible (`7ee167a`)

The only SOS banner lived on `/live`; an operator on `/bookings` saw a bell
badge. `SosAlertBar` is now mounted in the Shell, shows on every page, cannot be
dismissed while an SOS is unresolved, and reads unresolved `sos_events` rather
than filtering `missions.status` — so it also catches mission-less client and
VBG panics the old banner could not represent.

Audio is synthesised with Web Audio (no asset to 404, no CSP `media-src`, works
offline). Two judgement calls: the chime sounds only while **unacknowledged** and
repeats every 20s — once acknowledged the bar stays but goes quiet, because
punishing the operator already working it is how alarms get muted for real; and
because browsers block audio before a user gesture, the bar **says the sound is
off** and offers a control rather than failing silently.

### Issue 39 — expiry + access audit (`de2485e`)

Capability tags say an officer _once_ held a certificate, not that it is still
valid. Added nullable `expires_at` + `issuing_body` to `agent_documents`
(migration `20260725190000_qualification_expiry.sql`), returned alongside the
soonest live armed-permit expiry, rendered as EXPIRED / expiring-in-30-days /
valid-to. **A missing expiry is "none recorded", never expired** — most rows
predate the column.

The PDF's security clause (data minimisation + permission control + **audit of
access**) had only its first two thirds. Every profile open now writes an
`org_audit_log` row — ORG tier, append-only, naming the individual manager, and
written **before** the row lookup so an unauthorised probe that then 403s is
still recorded. Metadata is coarse ids only; the payload carries no `file_url`,
`file_hash` or `permit_ref`.

### Issue 41 — the decline now reaches someone (`dad55c0`)

A decline wrote `declined_at` and stopped. Nobody watched that column, so the
client's rail sat at "assigning team" until a manager happened to look. Both
answers now wake the assigned provider, on first write only.

**Still open, and correctly so:** provider-accept RESERVES, escrow holds at agent
acceptance, decline/timeout triggers automatic reassignment. That needs fix plan
**§10 Q4**. The fork is real — hold early and client funds are tied up on a job
nobody takes; hold late and a mission dispatches with nothing behind it. This
increment touches neither escrow nor `missions.status`, and a test pins that
boundary so the next pass cannot cross it by accident.

---

## Gates at `a38aefc`

| Gate                             | Result                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mobile `typecheck`               | **47** = `.tsc-baseline.json`, unchanged                                                                                                                       |
| mobile `lint`                    | 5 errors — **all pre-existing**, in files not touched here (3 × `scripts/e2e-*.ts` parser config; `NetworkLatencyChip.tsx:37`; `OrgCpoMissionsScreen.tsx:148`) |
| `booking` project                | **515 / 515**                                                                                                                                                  |
| `app` project                    | **611 passed**, 4 skipped                                                                                                                                      |
| `messenger-crypto`               | **3374 / 3374, twice** (B-126 flake rule)                                                                                                                      |
| `app` → `screens/messenger`      | **124 passed**, 4 skipped                                                                                                                                      |
| `auth-service`                   | **1890 passed**, 3 failed                                                                                                                                      |
| ops-console `typecheck` + `lint` | clean                                                                                                                                                          |

The 3 auth-service failures are `vbg.service.spec.ts › regionThreats`. **Verified
pre-existing**: stashed every change on this branch and they fail identically on
the untouched tree. Same 3 the previous session recorded.

~57 new tests. The Issue 11 set was mutation-proved: 7 go RED with the rollback
removed.

---

## Deploy — staging state 2026-07-26

The order mattered and was respected. `getMemberProfile` selects
`agent_documents.expires_at`, and that query backs BOTH the roster profile and
the departmental-chat sender tap — restarting before the columns existed would
have 500'd both. Migration first, then the image.

| Step                                                               | State                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 1. `20260725190000_qualification_expiry.sql` → Supabase            | ✅ **APPLIED** via MCP (`qkkfkicgoncxslbwhyhz`)                      |
| 2. Rebuild + restart `auth-service` on Contabo                     | ✅ **LIVE** — healthy, `/ready` 200                                  |
| 3. Redeploy `ops-console` (Issue 44's SosAlertBar is console-only) | ⛔ **NOT DONE** — the tar step was refused by the sandbox classifier |

**Verification actually performed** (not inferred):

- both columns present + nullable, partial index
  `agent_documents_expiry_idx … WHERE expires_at IS NOT NULL` created;
- the two new sub-selects from `getMemberProfile` run standalone against live
  data — returned 6 real document slots, every `expires_at` NULL, i.e. the
  "no expiry recorded" branch, which is the designed behaviour for pre-existing
  rows;
- container `healthy`; `/ready` 200; `/org/cpos/:id/profile` and
  `/agents/me/missions/:id/respond` both answer **401** (auth gate — the route
  exists and does not 500); no errors in the startup log.

**Issue 44 is inert until step 3.** The SOS alert bar is an ops-console
component; auth-service carries none of it. Everything else in this batch is
live.

Contabo facts: `admin@94.136.184.52`, `~/bravo`, compose
`docker-compose.staging.yml`, **service name `auth-service`** (not `auth`),
container `bravo-staging-auth`. No `rsync` on this machine — sync by
`tar` + `ssh 'cat > …'` + remote extract. The service `.env` lives at the
compose ROOT (`~/bravo/.env`), not under `apps/auth-service/`, so extracting a
source tarball over the app dir does not disturb it. The auth DB is
**Supabase**, not the `bravo-staging-pg` container that also runs on the box.

---

## Still owed on all 30

1. **Device QA.** Everything is verified by tests, typecheck and lint only. Issue
   18's fix in particular wants a service-provider account in the Agent shell —
   that is the exact configuration that was broken and the one no test can
   physically prove. Issue 20 needs two accounts on one device.
2. **`sqa.md` B-rows** for the whole V2 batch — still not written. Fetch `origin`
   before numbering; B-221..B-236 are reserved by a parallel session and B-247 is
   taken.
3. **§10 Q4** (escrow timing) — the only thing standing between Issue 41 and done.
4. **Ops data seeding** — `vehicles.colour` (Issue 30), first partner referral
   codes (Issue 28), and now qualification expiry dates, which are NULL for every
   existing document until someone fills them in. Until then the roster shows
   "no expiry recorded", which is honest.

---

_Verified 2026-07-25 against git history and a full gate run._
