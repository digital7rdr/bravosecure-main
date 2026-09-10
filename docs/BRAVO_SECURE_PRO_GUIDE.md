# Bravo Secure Pro — Complete Guide (App + Ops Console)

_Last updated: 3 Aug 2026. Every path and button below is verified against the
shipped product. **App path** = the mobile app. **Web path** = the Operations
Console (staging: `https://ops.94-136-184-52.sslip.io`, local dev:
`http://localhost:3002`)._

---

## 0. The two different "plans" (they never overlap)

|                     | **Bravo Secure Service plan** (this guide)                                                                 | **Messenger subscription tier**                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| What it is          | Your **physical protection** level: **Secure Lite**, **Bravo Secure Pro**, **Executive** (coming soon)     | An app-feature subscription (cloud vault, department channels…): **Bravo Messenger Lite**, **Bravo Messenger Pro**, **Enterprise** |
| How Pro is obtained | **Apply** → custom **proposal** from the Bravo Control System → accept → pay **once for the whole period** | **Subscribe yourself**, fixed price, billed every 30 days                                                                          |
| App path            | Home → **Bravo Secure Service** — or **Profile → Account → Secure Plans**                                  | **Profile → Billing → Messenger Plans** (`PricingScreen`)                                                                          |
| Web path            | **/pro-applications** and **/pro-management**                                                              | **/settings** → Subscription pricing card                                                                                          |
| Badge               | **Secure home** header chip **LITE ↔ PRO / PRO · FAMILY** (dynamic, flips on activation/expiry)            | **Messenger home** header chip **LITE / PRO / ENTERPRISE** (lapse-aware; org accounts read ENTERPRISE)                             |

If a screen asks you to _subscribe monthly_ → messenger tier. If it asks you to
_apply and wait for a proposal_ → Secure Service plan. Each dashboard wears only
its own family's chip: the Secure-home chip is always the **Secure plan**, the
Messenger-home chip is always the **messenger tier** — they never mix, and the
words "Bravo Secure Pro" never appear on a subscription screen (the messenger
paid tier is always called **Bravo Messenger Pro**).

---

# PART 1 — CLIENT APP

## 1.1 Entry: Bravo Secure Service → Secure Plans

> **App path:** Secure Services home → _PLANS & SERVICES_ → **Bravo Secure
> Service** card → **Secure Plans**

The **Secure Plans** screen shows three cards:

| Card                                  | Tap behaviour                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bravo Secure Lite** — from 86 BC/hr | Starts a normal Lite booking (Zone Map). Wears **CURRENT** until a Pro plan is active                                                                                                                                                                                                                                                                                                                                      |
| **Bravo Secure Pro**                  | **Smart routing:** no application → _Pro introduction_; application in flight → _My Pro Application_ (a status pill on the card shows where you are); plan **Active** → _Pro Dashboard_                                                                                                                                                                                                                                    |
| **Bravo Secure Lux**                  | **COMING SOON** — card opens the Lux teaser page (premium white-glove tier: private aircraft, armored fleet, maritime, dedicated Lux desk) with a "get notified at launch" hook. NOTE: **Executive Protection** — fixed 3–24 h blocks, own wizard, per-unit pricing (86 BC/CPO/hr + 30 BC/vehicle/hr), hourly check-ins instead of waypoints — is LIVE **under Bravo Secure Lite** (Select Service → Executive Protection) |

A note under the cards reminds you: applying never locks Lite.

## 1.2 The Pro introduction

> **App path:** Secure Plans → **Bravo Secure Pro** (first time)

Benefits overview (dedicated team, operational assistance, journey monitoring,
secure communications, AI itinerary planning, activity & reports), a 3-step
"how it works", **no pricing** (pricing is always a custom proposal), and two
buttons: **Apply for Bravo Secure Pro** and **Maybe later**.

## 1.3 The application form

> **App path:** Pro introduction → **Apply for Bravo Secure Pro** →
> _Build Your Requirements_

No documents, no member setup — your signup identity/KYC and existing family
members are reused automatically.

| Field               | Details                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intended use        | Family Support · Executive Protection · Travel Protection · Residential Support · Event Support · Custom (+ description box)                                                       |
| Coverage duration   | 1 / 3 / 6 / 12 Months chips, or Custom (+ description box)                                                                                                                         |
| Start date          | Native date picker, today or later                                                                                                                                                 |
| Coverage area       | Free text (min 3 chars)                                                                                                                                                            |
| Required personnel  | +/− steppers: Close Protection Officers · Drivers · Support Staff (≥ 1 person total)                                                                                               |
| Gender preference   | No Preference · Male Team · Female Team · Mixed Team                                                                                                                               |
| Additional services | Checkboxes: Secure Transfers · Medical Support · Advance Assessment · Secure Communications · Journey Monitoring · Event Support · Residential Support · Other (+ description box) |
| Notes               | Optional, up to 1000 chars                                                                                                                                                         |

The **Submit Pro Request** button stays dim until valid and names the missing
field. After submit you land on **My Pro Application** and the form is removed
from back-history — swiping back can never resurface it (re-entering the flow
always routes to your status instead).

## 1.4 My Pro Application (the status screen)

> **App paths:** Home → **My Pro Application** card · or Secure Plans →
> **Bravo Secure Pro** while in flight · or any Pro push notification

Contents: status hero + copy, progress strip
(_Submitted → Proposal → Acceptance → Activation_), **Your Request** summary,
live **Timeline** of every event, and **Previous Plans**. Updates arrive
instantly (socket push) with a 5-second poll as backup.

| Status             | Screen offers                                         |
| ------------------ | ----------------------------------------------------- |
| Pending Proposal   | Wait state — Lite untouched · **Cancel Application**  |
| Proposal Ready     | **View Proposal** · **Cancel Application**            |
| Revision Requested | Wait state — ops is revising · **Cancel Application** |
| Accepted           | **Pay & Activate** · **Cancel Application**           |
| Active             | **Open Pro Dashboard**                                |
| Rejected           | Reason box + **Apply Again**                          |
| Cancelled          | **Apply Again** (nothing was charged)                 |
| Expired            | **Renew With Current Details** + **Customize Plan**   |

**Cancel Application** (any pre-activation state, confirm dialog): withdraws the
application — terminal, nothing charged, re-apply free immediately. A paid
(Active) plan can never be cancelled; it runs to its coverage end. Ops can also
cancel on your behalf (below) — you get a push notification when they do.

## 1.5 The proposal

> **App path:** My Pro Application → **View Proposal** (status _Proposal Ready_)

Shows: proposal number (`PR-2026-XXXX`) and version, **TOTAL · FULL COVERAGE
PERIOD** in BC (one figure for the whole plan — never monthly), validity date,
service period (from → to), included services, assigned team, terms.

- **Accept Proposal** → payment screen.
- **Request Changes** → bottom sheet; your message goes into the shared thread,
  status becomes _Revision Requested_, ops answers with v2/v3….
- An expired proposal cannot be accepted.

## 1.6 Payment & activation

> **App path:** proposal → **Accept** → _Activate Your Pro Plan_ (also
> reachable from the status screen while _Accepted_)

- Shows **REQUIRED · FULL COVERAGE PERIOD**, your balance, plan total, and the
  after-payment balance (or the exact shortfall).
- **Top Up Bravo Credits** → the top-up screen: fixed packages **plus a
  Custom-amount tile — type any figure**.
- **Pay & Activate** → the debit and activation are one atomic step.
- Success: **“Bravo Secure Pro Activated”** — plan start, **covered until**,
  plan total, and **Open Pro Dashboard**. The home chip turns **PRO** (green);
  family members see **PRO · FAMILY**. It reverts to LITE automatically at
  expiry.

## 1.7 Pro Dashboard

> **App path:** Home chip / Secure Plans → Pro card (while Active) → _Pro
> Dashboard_ — anyone without an active plan is auto-bounced to the status
> screen.

Plan strip: **Covered until · Plan total · Plan details →**. Module grid:

| Tile                | Goes to                       |
| ------------------- | ----------------------------- |
| AI Itinerary        | **Coverage Calendar** (1.8)   |
| Designated Team     | Assigned team & vehicles      |
| Live Map            | Live mission tracking         |
| Booking Requests    | **Protection requests** (1.9) |
| Messenger           | Secure messenger tab          |
| Virtual Bodyguard   | VBG safety tools              |
| Linked Members      | **Family management** (1.10)  |
| Documents           | SOON                          |
| Activity & Reports  | Operational history           |
| Additional Services | SOON                          |
| Billing & Credits   | Wallet & invoices             |

## 1.8 Coverage Calendar (AI Itinerary)

> **App path:** Pro Dashboard → **AI Itinerary**

- Month pages spanning exactly your covered period (dots under the month name).
- **Solid blue** day = scheduled by ops · **amber ring** = requested, awaiting
  officers · outlined = today · dimmed = outside coverage.
- **Request Protection Dates** → select mode → tap future in-coverage days
  (green) → **Request N dates** → optional note → **Send Request**. Free —
  covered by the plan. The request appears instantly in the ops queue.

## 1.9 Booking Requests

> **App path:** Pro Dashboard → **Booking Requests**

Each request card: date chips, your note, and the outcome — _Awaiting
schedule_, **Scheduled** (with the officers assigned), or _Declined_ (with the
ops note). **Request Protection Dates** jumps to the calendar.

## 1.10 Linked Members (family)

> **App path:** Pro Dashboard → **Linked Members**

- **Add Member** → your **phone contacts matched against Bravo accounts**
  (messenger-style; only registered _individual_ accounts appear) → pick →
  **relationship** chips (Spouse · Father · Mother · Son · Daughter · Brother ·
  Sister · Guardian · Other) → optional **spend limit** → **Send Invite**.
- Member rows: photo, usage line (`spent / limit BC`), **last location line**
  (place name · how long ago, for active members whose device has reported),
  **relationship badge on the right**, PENDING/HOLD pills.
- Tap a member → manage sheet:
  - **LAST LOCATION** — a map card of their last reported fix with the area
    name and freshness, plus **Open in Maps**. Appears once the member's app
    has reported (they must have the app opened with location on); held
    members never share location while the hold lasts, and a member can opt
    out entirely via _Settings → Location → Never_.
  - **SPENDING · FROM YOUR CREDITS** — what they spent from your wallet,
    grouped **by feature** (protection bookings, …) with refunds shown, plus
    the itemised recent transactions.
  - **Save** a new spend limit · **Hold** 7/14/30 days (no owner credits + no
    shared dashboard until it lifts) · **Lift hold** · **Remove** (removing
    also deletes their stored location).
- Invitees accept from **their** app: _Profile → the blue invite card → Accept_
  (the card discloses that credits are shared to them and their last location
  is shared to you while active).
- Refund correctness: a cancelled/refunded member booking credits **your**
  wallet (you paid) and frees the member's cap by the refunded amount.
- Active members get your Pro Dashboard (**UNDER \<you\>** pill) and pay from
  your wallet inside their cap; their bookings are marked _under your plan_
  everywhere, including ops. Limits: 4 active members, one family per person.

## 1.11 Renewal & history

> **App path:** My Pro Application (status _Expired_)

- **Renew With Current Details** — one tap, same requirements, start date rolls
  to the day after the old coverage; goes straight to ops as a fresh
  application.
- **Customize Plan** — the form again, prefilled expectations.
- **Previous Plans** — every past application with period, total, outcome.

## 1.12 Client notifications

Application received · Proposal ready/revised · Rejected · Activated · Ops
thread reply · Protection request scheduled/declined. Each opens the right
screen when tapped, and the open screen updates live regardless.

---

# PART 2 — CPO APP

## 2.1 Login

Unchanged. Operations hands you a **user ID (email)** + **temporary password**
(generated when your account is created). Normal sign-in, normal activation.

## 2.2 Mission code

> **App path:** CPO shell → **Mission** tab → (no agency mission) →
> **“Have a Mission Code?”** → _Pro Mission_

- Enter the code from operations — format `PMC-XXXXXX` (no 0/O/1/I characters).
- **Valid + yours** → the dedicated view: protected member, protection window
  (**LIVE TODAY** inside it), organisation, coverage area, every scheduled
  protection date, ops note. The code is remembered; reopening the app
  re-validates and returns you here. The ⇄ button switches codes.
- **Denied** cleanly when: wrong code, another officer's code, cancelled, or
  already completed. (The app never reveals whether a foreign code exists.)
- No payment/payout — the assignment completes when ops finishes it or the
  window ends.

---

# PART 3 — OPERATIONS CONSOLE (web)

Sign in at the console URL with your ops account. All Pro surfaces live in the
sidebar group **Operations**.

## 3.1 Pro Applications — `/pro-applications`

> **Web path:** sidebar → **Pro Applications**

- Status tabs: **NEW · REVISION · PROPOSAL SENT · ACCEPTED · ACTIVE · EXPIRED
  · REJECTED · CANCELLED · ALL** — new client applications appear in **NEW**
  within seconds, no refresh.
- Click a card → detail: `/pro-applications/<id>`.

### Application detail — `/pro-applications/<id>`

- **REQUIREMENTS** (everything the client filled in + contact), **TIMELINE**,
  two-way **CLIENT THREAD**, **MISSION REQUESTS**, **DECISION**, **PROPOSALS**
  history, **CLIENT HISTORY** (their past applications — click through),
  **INTERNAL NOTES** (never client-visible).
- **CREATE PROPOSAL →** (SUPERVISOR/ADMIN): total BC for the **full period**,
  valid-until, coverage window, included services, team rows, terms, optional
  client note. Sends v2/v3 after revision requests.
- **REJECT APPLICATION** with a client-visible reason (terminal).
- **CANCEL APPLICATION** (SUPERVISOR/ADMIN, any pre-activation state incl.
  ACCEPTED): withdraws it on the client's behalf — e.g. a phone request —
  with an optional timeline note. Terminal; the client is push-notified and
  can re-apply immediately.
- **MISSION REQUESTS → ASSIGN CPOS →**: the officer pool opens pre-filtered to
  the request's dates; tick available officers; each gets a date-range
  assignment + mission code; the request flips to Scheduled; the client is
  notified instantly.

## 3.2 Pro Management — `/pro-management`

> **Web path:** sidebar → **Pro Management**

Four tabs; **REQUESTS** is the default and shows a live count:

- **REQUESTS** — _the global incoming queue_ (2-second refresh): every
  protection-date request from every client, oldest first, with member name,
  date chips, and note. **ASSIGN CPOS →** (same pool picker) or **DECLINE**
  right from the queue; **OPEN PLAN →** jumps to the application.
- **ASSIGNMENTS** — every officer↔member window: names, dates, **mission
  code**, status (ASSIGNED/COMPLETED/CANCELLED). **FINISH** (no payout) ·
  **CANCEL** · **OPEN PLAN →**. Past windows auto-complete.
- **CPO POOL** — approved officers with availability for any date window you
  set at the top. **+ CREATE CPO** (pick organisation, name, email, phone,
  system-generated password — **shown once**, hand it over immediately;
  officer is deployable instantly). Per officer: **ASSIGN →** (direct
  assignment to an active Pro member) · **SUSPEND 14D / REINSTATE**.
- **ORGANIZATIONS** — all provider orgs with CPO + live-assignment counts.
  **+ CREATE ORGANIZATION** → an **internal** (ops-owned) org with a manager
  login (credentials shown once) and a coverage country; **AGENT RECORD →**
  opens the org's agent file.

## 3.3 Scheduling guarantees (machine-enforced)

- An officer can **never** hold two overlapping protection assignments — the
  database itself rejects it and the console names the clash (who + dates).
- Duplicates are equally impossible; back-to-back windows (ends the 10th,
  starts the 11th) are allowed.
- FINISH/CANCEL frees the officer immediately; expiry auto-completes;
  suspended officers are unassignable until reinstated.

## 3.4 Related surfaces

- **/bookings** — Lite bookings; family-paid rows read “… · UNDER \<OWNER\>”,
  and the booking detail shows an **UNDER \<owner\>** pill on the client card.
- **/agents** — the classic agent/CPO application review (docs, KYC, decide).
- **/settings** — the **messenger** subscription pricing (the other "Pro").

---

# PART 4 — QUICK ANSWERS

- **Applying costs nothing**; you pay once, after accepting, for the whole
  period. No monthly billing on Secure plans.
- **Requests not showing on ops?** They land in **Pro Management → REQUESTS**
  (live count on the tab) _and_ on the application detail — both within
  seconds.
- **Member overspending?** Impossible past the cap — enforced at charge time.
- **Officer double-booked?** Impossible — see 3.3.
- **Lost mission code?** It's on the assignment row in **/pro-management →
  ASSIGNMENTS**.
- **Plan ended?** The client sees Expired with one-tap renewal; you'll get the
  renewal as a fresh application with their previous details.
