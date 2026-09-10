# Decision brief — should "my shifts" and "my reports" be scoped to one organisation?

**Date:** 2026-08-12 · **Status:** open, needs a product decision · **Blocks:** nothing shipped; the
inconsistency is live on `main` but the multi-org migration is not yet applied, so nobody can hit it today.

This document is self-contained. It assumes no knowledge of the codebase.

---

## 1. The one-paragraph version

Bravo now lets a person belong to more than one organisation at once. When they are looking at
Company A, the app tells the server "this request is about Company A", and the server honours that
for everything a **manager** sees and for everything anyone **writes**. But four screens that show a
person _their own_ records — my shifts, my attendance history, my incident reports, and the
clock-out button — ignore it. So a security officer employed by an agency who is also an office
employee of a client company sees **both companies' records mixed together**, in whichever company's
app screen they happen to be standing in. Nothing is wrong or lost; it is a question of what the
list is supposed to mean.

---

## 2. Background: what "multi-organisation" means here

Bravo has two kinds of organisation:

| Kind          | What it is                                         | Who is in it               |
| ------------- | -------------------------------------------------- | -------------------------- |
| **Agency**    | A security company that supplies officers          | Officers (`cpo`), managers |
| **Workspace** | An ordinary company using Bravo for internal staff | Employees, managers        |

Until this month a person could be active in **exactly one** organisation, enforced by a database
constraint. A recent decision removed that limit for office roles: _"users can also join multiple
workspaces, don't restrict them; managers can handle multiple workspaces if they want, no
restriction."_ Officer employment stays exclusive — two agencies must not both roster the same
officer for the same hour — but an officer at an agency **may** also be an employee of a company.

That combination is the whole point of the change, and it is the persona this document is about.
Call him **Chidi**:

- `cpo` (security officer) at agency **Meridian Protective**
- `employee` at workspace **Acme Corp** (he does office work for them too)

### How the app knows which company you are looking at

The app has a **Workspace Hub** — a list of tiles, one per organisation you belong to. Tapping a
tile sets an "active workspace", and from then on every request carries a header naming that
organisation. The server uses the header only to **narrow** what the person can already see; it can
never grant access to an organisation they do not belong to.

Two properties of the header matter for this decision:

1. **It is not persisted.** Close the app and it is gone. It is set only by tapping a hub tile.
2. **It is only set on that one path.** Notification taps, the side drawer, and the officer's own
   home screen all reach the same screens with no header at all.

---

## 3. What is actually inconsistent

Four endpoints answer "your own records". They filter by **who you are** and nothing else.

| Endpoint                         | Screen(s)                                       | Filters on                              | Sees the header? |
| -------------------------------- | ----------------------------------------------- | --------------------------------------- | ---------------- |
| `GET /attendance/me`             | My Attendance, Departmental Home, Officer Home  | `cpo_user_id = you`                     | **No**           |
| `GET /attendance/my-shift/today` | Attendance, Departmental Home, Agency Dashboard | `cpo_user_id = you`                     | **No**           |
| `GET /incidents/mine`            | My Incidents                                    | `submitter_id = you`                    | **No**           |
| `POST /attendance/clock-out`     | Verify Attendance                               | `cpo_user_id = you AND status = 'open'` | **No**           |

Everything around them **is** scoped:

- Manager views (`/attendance/org/sessions`, `/incidents/queue`, roster, approvals) — scoped.
- Every **write** that creates a record (`clock-in`, `submit incident`) — scoped, as of this week.
- Workspace settings, channels, invites, employees — scoped.

So today: Chidi's clock-in lands correctly on Acme, and Acme's manager sees it correctly. But
Chidi's own "My Attendance" list, viewed inside Acme, also contains his Meridian shifts.

### Why this only just became a question

Before multi-org, a person had one organisation, so "my records" and "my records at this company"
were the same set. They are now different sets, and nobody has said which one these four screens
should show.

---

## 4. Concrete example

Chidi opens the app, taps the **Acme Corp** tile, and goes to _My Attendance_.

**Today (unscoped):**

```
My Attendance
  Mon 11 Aug   08:00–16:00   Meridian — Gate B, Sandton     Present
  Fri 08 Aug   09:00–17:00   Acme Corp — Head Office        Present
  Thu 07 Aug   20:00–04:00   Meridian — Night patrol        Late
```

He is inside Acme's app surface, under Acme's branding, and two of the three rows are another
company's shifts — including the site names.

**If scoped:**

```
My Attendance  ·  Acme Corp
  Fri 08 Aug   09:00–17:00   Head Office                    Present
```

...and his Meridian shifts would be visible when he is looking at Meridian.

---

## 5. Does this leak anything?

**No.** Every row is his own record. Nothing is exposed to a person who should not see it, and no
manager sees another company's data. The manager-facing side is already correctly scoped.

The real costs are:

1. **Confusion.** Another company's site names and addresses appear under this company's branding.
2. **Inconsistency.** The same screen writes to one company and reads from both.
3. **One genuine functional edge**, below.

---

## 6. The one case with a functional consequence: clock-out

Clock-out finds "your currently open shift" with no organisation filter, and the database allows a
person **one open session at a time** across all organisations (`cpo_shift_sessions_open_unique` is
on the person alone).

So if Chidi is clocked in at Meridian and opens the Acme surface, the clock-out button there will
close **the Meridian session**. He probably intends that — he only has one — but the app gives no
indication which shift it is ending.

Three ways to read this:

- **It is correct.** A person has one body and can only be on one shift. Whichever screen they use,
  ending "the shift" is unambiguous.
- **It is correct but should say so.** Same behaviour, plus the button naming the shift it will end.
- **It is wrong.** The Acme surface should not be able to touch a Meridian record at all.

This is the sub-question most worth a firm answer, because it is a state change rather than a list.

---

## 7. Current scale (measured on staging, 2026-08-12)

|                                           |                      |
| ----------------------------------------- | -------------------- |
| Attendance sessions                       | 14, across 13 people |
| People with sessions in 2+ organisations  | **0**                |
| Incident reports                          | 15                   |
| People with incidents in 2+ organisations | **0**                |
| Active officers                           | 11                   |
| Active office staff (employee/manager)    | 10                   |

**Nobody is affected yet**, because the migration that permits multi-org membership has not been
applied. That is the reason this is a decision rather than an incident — it can be settled before
anyone experiences it. It also means either option can be implemented without a data migration.

---

## 8. The options

### Option A — Scope them (make the reads match the writes)

Each of the four endpoints honours the header. Inside Acme you see Acme; inside Meridian you see
Meridian; with no organisation selected you see your primary one.

**For**

- One rule everywhere: a screen shows the company it is branded as.
- Matches every other list in the product.
- Kills the confusing mixed list.

**Against**

- **A person with no organisation selected sees only one company's records.** Because the header is
  not persisted, this is the state after _every_ app restart, and after every entry that is not a
  hub tile — a notification tap, the drawer, the officer's home screen. Chidi could restart the app
  and find shifts "missing" until he goes through the hub. This is the strongest argument against A,
  and it is a real usability regression for the officer shell, which has no hub at all.
- Officers overwhelmingly have exactly one employer, so most users get a behaviour change that
  benefits only the rare consultant.

### Option B — Leave them cross-org, and say so on screen

Keep the query unchanged; label each row with the organisation it belongs to and title the list
"All organisations".

**For**

- Nothing can go missing. One place to see your whole working life.
- No regression for the officer shell or for restart/notification entry.
- Smallest change; least risk to a lane that currently works.

**Against**

- A screen inside Acme showing Meridian rows still reads oddly, however well labelled.
- Leaves the read/write asymmetry in place, which the next reviewer will flag again unless the
  reasoning is written down where they will find it.

### Option C — Scope with an escape hatch

Default to the current organisation; add an "All organisations" toggle on the list, remembered per
user.

**For**

- The correct default, without the disappearing-records problem.
- Degrades safely: no organisation selected → show everything.

**Against**

- Most work. New UI control, a persisted preference, and a new state to test on four screens.
- Solving a problem that currently affects zero users.

### Sub-decision for clock-out (independent of A/B/C)

- **C1** Leave it — one body, one shift, any screen can end it.
- **C2** Leave it, but name the shift on the button ("End shift — Meridian, Gate B").
- **C3** Refuse it — from Acme you may only end an Acme shift.

_C3 has a trap:_ an officer who clocks in at Meridian and then, for whatever reason, has only the
Acme surface in front of them could not clock out at all. Given the one-open-shift rule, refusing is
probably worse than allowing.

---

## 9. My recommendation

**Option B for the lists, C2 for clock-out.**

Reasoning:

- The strongest objection to scoping (A) is not aesthetic — it is that the organisation context
  **vanishes on every restart and on every non-hub entry**. Scoping a list against a context that is
  usually absent means "my shifts" quietly becomes "some of my shifts", and a missing shift is a far
  worse failure than a confusing extra row.
- "Everything about me, labelled" is a defensible product statement in its own right. It is how a
  person actually experiences their own work: they have one life and two employers.
- Clock-out ends the one shift they have; naming it removes the entire ambiguity for the price of a
  string.
- If the context ever becomes persistent and reliable on every entry path, Option C becomes cheap
  and is the better end state. B does not block that.

The one thing I would not do is leave it as it is _without_ labelling. The current screen is the
worst of both: mixed data, no explanation.

---

## 10. Questions for the discussion

1. When Chidi opens "My Attendance", what does he expect — this company's shifts, or all of them?
2. Is a **missing** record worse than a **confusing** one? (This decides A vs B.)
3. Should an officer's own home screen — which has no organisation picker at all — behave the same
   as the workspace screen that does?
4. For clock-out: is "end my shift" a personal action or an organisational one?
5. Does the answer differ between **attendance** (an employment record, tied to payroll) and
   **incidents** (a report the person authored)? They are currently treated identically, and there
   may be a reason to split them — attendance is arguably the employer's record and incidents
   arguably the author's.
6. Is there any compliance or payroll requirement that an attendance list be filterable to one
   employer?

---

## 11. Implementation notes (for whoever builds it, whichever option wins)

- **All three options are small.** The scoping mechanism already exists and is used by roughly a
  dozen endpoints; applying it to four more is a handful of lines each. Option B is mostly UI.
- **The client already sends the header on these routes** — the allowlist covers `/attendance` and
  `/incidents`. The server simply discards it. So Option A needs no client change at all beyond
  what already ships.
- **One endpoint is shared by three different shells** (agency, officer, workspace):
  `GET /attendance/me` is called from `AttendanceScreen`, `OnDutyHomeScreen`, `DepartmentalHomeScreen`
  and `MyAttendanceScreen`. Any change affects all four. This is why the decision cannot be made
  screen-by-screen.
- **Whichever is chosen, write the reasoning into the code.** This has now been raised by four
  separate reviews; without a recorded decision it will be raised a fifth time.

---

## 12. Glossary

| Term                     | Meaning                                                                   |
| ------------------------ | ------------------------------------------------------------------------- |
| **CPO**                  | Close Protection Officer — a security guard on the agency side            |
| **Workspace**            | An ordinary company using Bravo for its own staff (not a security agency) |
| **Org context / header** | The app telling the server "this request is about company X"              |
| **Scoped**               | Filtered to one organisation                                              |
| **Clock-in / clock-out** | Starting and ending a work shift, with location capture                   |
| **Staging**              | The test environment with real-shaped but non-production data             |
