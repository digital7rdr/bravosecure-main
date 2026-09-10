# Item 4 — "multiple organisations per account": the decision, explained

**Status:** the last of 18 client-review items. Not started. Blocked on two product
decisions, not on effort.

This document is self-contained — it assumes no access to the codebase. Every claim below
was checked against the live code and the staging database on 2026-08-11, and the
file/line references are there so anything can be re-verified.

---

## 1. What the client asked for

An account can belong to more than one organisation, and switch between them.

## 2. Why it does not work today

One line of SQL, added on 2026-06-22 as an anti-fraud measure:

```sql
-- supabase/migrations/20260622110000_antifraud_integrity.sql:29
CREATE UNIQUE INDEX org_members_one_active_agency
  ON public.org_members (member_user_id)
  WHERE status = 'active';
```

Read it in English: **one person may have at most one ACTIVE membership row, anywhere in
the system.** Not one per organisation — one, full stop.

When someone tries to join a second organisation, the database rejects it and the server
turns that into the error `already_active_in_another_org`
(`enterprise-join.service.ts:746`, pre-checked at `:282` so the invite is greyed out
rather than failing on tap).

### What that index was protecting

Its own comment says: _"a CPO cannot be simultaneously active at two agencies via any
other path."_ That is a real integrity rule for **security work**. A close protection
officer is a person with a shift, a location and a duty status. If two agencies could both
hold them as active staff, both could roster them for the same hour, both could dispatch
them to a job, and the attendance and payout records would disagree about who employed
them. Blocking that is correct.

### What it also blocks, accidentally

The same index applies to the `org_members` table's **other** roles. Staging today:

| role       | active | note                                         |
| ---------- | ------ | -------------------------------------------- |
| `cpo`      | 11     | security officers — exclusivity is the point |
| `employee` | 7      | ordinary workspace members                   |
| `manager`  | 3      | delegated admins                             |

**21 people total.** The 10 `employee` + `manager` rows are ordinary office staff in an
enterprise workspace — the Slack-shaped side of the product. There is no safety reason a
consultant cannot be in two companies' workspaces, and that is exactly what the client
asked for.

So: one index is doing two jobs, and only one of them is wanted.

---

## 3. The proposed change

Replace the single index with two narrower ones:

```sql
-- Keep exclusivity where it means something: security employment.
CREATE UNIQUE INDEX org_members_one_active_cpo
  ON public.org_members (member_user_id)
  WHERE status = 'active' AND member_role = 'cpo';

-- Everyone else: at most one row PER ORG, but any number of orgs.
CREATE UNIQUE INDEX org_members_one_per_org
  ON public.org_members (member_user_id, org_user_id);
```

CPO employment stays exclusive. Workspace membership becomes multi.

**Pre-flight check before this can run.** The second index asserts (member, org) is
already unique. Nothing enforces that today — the code path that grants membership
reactivates an existing row rather than inserting a duplicate, so it _should_ hold, but
"should" is not "does". A single historical duplicate pair would make the migration fail
hard, mid-deploy. A duplicate-pair probe has to run on real data first.

---

## 4. Why this is not a small change

Roughly nine places in the server answer the question _"which organisation is this request
about?"_ — and every one of them was written when the answer could only be one thing. Once
a person can be in three organisations, each of these has to be told **which one**.

| Where                                   | Today                     | Has to become                           |
| --------------------------------------- | ------------------------- | --------------------------------------- |
| Account resolution (`account-kind.ts`)  | takes the first org found | a default, plus the full list           |
| Manager guard (`org-manager.guard.ts`)  | "the org they manage"     | the org they manage **in this context** |
| Department-chat access guard            | one active org            | same                                    |
| Attendance service                      | oldest membership wins    | context-scoped                          |
| Incident service                        | one org                   | context-scoped                          |
| Roster / rollup services                | one org                   | context-scoped                          |
| CPO assignment, org-CPO, agent services | CPO lanes                 | **unchanged** — CPO rows stay exclusive |
| Workspace settings (built this week)    | caller's org              | already built context-ready             |
| Invite acceptance (client)              | "at most one membership"  | switcher-aware                          |

The mechanism for carrying "which one" would be a context header on each request,
validated server-side against what that person is actually a member of — never trusted
from the client.

### What already exists

Some scaffolding is in place from earlier phases, which is why this is a large change and
not a rewrite:

- `/auth/me` already returns a `workspaces[]` array. It is capped at 2 only by how the
  query is written, not by design.
- There is already a Workspace Hub screen that lists workspaces and switches between them.
- There is already a client-side "active workspace" store, and several screens already
  send the active org as a query parameter.

---

## 5. DECISION 1 — do we do it at all?

**Yes** means: narrow the index, add the context header, touch nine server sites, and
re-test attendance, incidents, rosters, invites and channels — because all of them derive
their answer from the org resolution being changed.

**No / not yet** means the client's item 4 stays unbuilt and multi-org remains a
single-org product. Everything else in the 18-item review is done.

**A third option worth considering:** narrow the index now (it is one migration and a
pre-flight probe) but **do not** build the context switching yet. That unblocks the
database-level restriction and lets a person hold memberships in two workspaces, while the
app continues to show them their default one. It is a smaller, reversible first step — but
be clear-eyed that it delivers no visible feature on its own, and it creates a state the
UI cannot yet express, which has its own risk of confusing support.

---

## 6. DECISION 2 — the question inside the question

**If someone is a MANAGER of two organisations, should their management authority follow
the organisation they are currently viewing?**

Concretely: Sarah is a delegated manager at both Acme Security and Borough Facilities. She
opens the app and switches to Borough.

### Option A — context-scoped (authority follows the view)

Sarah sees Borough's rosters, approves Borough's attendance, manages Borough's channels.
Switch to Acme and everything re-points.

- Matches what a user expects from a workspace switcher (Slack, Notion, Google Workspace
  all behave this way).
- **Cost:** every one of those nine sites must read the context and be tested for the
  wrong-org case. The failure mode if one is missed is the serious one: a manager
  approving _the wrong company's_ timesheets, or reading another company's incident
  queue. That is a cross-tenant data leak, not a cosmetic bug.

### Option B — pinned (authority stays with one "primary" org)

Sarah can _view_ Borough but only _administer_ Acme.

- Much smaller change; the guard keeps a single answer.
- **Cost:** it is confusing in a way users will report as a bug. Sarah is a manager at
  Borough in real life, and the app will tell her she is not. There is also no obvious
  place to explain why.

### Option C — no multi-org for managers at all

Multi-membership for `employee` only. A manager stays single-org.

- Smallest change and the safest.
- **Cost:** the person most likely to _need_ multi-org — someone who consults for two
  companies — is usually senior enough to be a manager, so this may miss the actual use
  case.

---

## 7. What I would want to know before choosing

These are the questions that would actually decide it, and I do not have the answers:

1. **Who asked for this, and what were they trying to do?** A consultant working with two
   client companies is a different design from one company that has split into two legal
   entities.
2. **Is anyone hitting the error today?** The `already_active_in_another_org` message is
   already reachable, so if real users are seeing it there will be support reports naming
   what they were trying to do.
3. **Should a manager at two organisations be a manager at both — in real life?** If the
   honest answer is "no, in practice they'd be an admin at one and a member at the other",
   Option B stops being a compromise and becomes correct.
4. **Is this urgent, or is it a completeness item?** Everything else in the review is
   deployed. If item 4 is "nice to have", the third option in §5 (index only, no switching)
   buys time cheaply.

---

## 8. My recommendation

**Option A (context-scoped), but not yet — and not in one piece.**

A is the only option that matches what a workspace switcher promises, and shipping B would
generate support load that costs more than A's engineering. But A's failure mode is
cross-tenant data exposure, and the last six review rounds on this same feature area each
found a defect created by the _previous_ round's fix — including one where a feature was
silently dead for the largest group of admins in the app. That is not a track record that
should be followed by a nine-site change to how the server decides which company's data
you are looking at.

So I would sequence it:

1. Run the duplicate-pair probe on production data. Cheap, and it either clears the
   migration or reveals a data problem worth knowing about regardless.
2. Narrow the index. One migration, reversible.
3. Build the context header and convert the nine sites **one at a time**, each with a
   wrong-org test that must fail first.
4. Only then turn on multi-org in the UI.

And before any of that: **the device pass that is already owed.** Seventeen items are
deployed and unverified on hardware, including three navigation lanes that had never once
executed and a car-Bluetooth fix that has been "fixed" three times without anyone testing
it in a car. Verifying what is already shipped is worth more right now than starting the
largest remaining change.

---

## 9. Reference — where to look

| Thing                                        | Location                                                           |
| -------------------------------------------- | ------------------------------------------------------------------ |
| The index                                    | `supabase/migrations/20260622110000_antifraud_integrity.sql:29-31` |
| The error surfaced to users                  | `apps/auth-service/src/department/enterprise-join.service.ts:746`  |
| The pre-check that greys out the invite      | same file, `:282`                                                  |
| Role constraint (`cpo`/`manager`/`employee`) | `supabase/migrations/20260717150000_org_employee_role.sql:12`      |
| Account/org resolution                       | `apps/auth-service/src/auth/account-kind.ts`                       |
| Manager authority                            | `apps/auth-service/src/org/org-manager.guard.ts`                   |
| Full technical plan for this item            | `docs/planning/BRAVO_CHANNELS_VS2_PLAN_2026-08-10.md` §9           |
