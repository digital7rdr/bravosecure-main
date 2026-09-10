# Lite Booking (Secure Transfer) — A→Z Simulation Flow

> Simple, step-by-step walkthrough of one full bodyguard booking, showing **who acts**
> at each moment: 👤 Client · 🏢 Agency · 🖥️ Ops Console · 🛡️ CPO.
>
> **Reality check:** in the normal (happy) path the **Ops Console mostly just watches**.
> It only _does_ something when the flow breaks (no agency found, someone stuck, an SOS).
> Don't wait for Ops to act during a smooth run — it's marked below where it actually steps in.

---

## 0. Before you start (setup)

- 🏢 **Agency** is onboarded, has **accepted the DPA + set its region**, has **≥1 CPO in the roster**, and the app is **open** on the dashboard.
- 🛡️ **CPO** is logged in and toggled **On Duty**.
- 👤 **Client** account has **credits** topped up.
- 🖥️ **Ops** staff has the bookings / dispatch board open (watching).

> ⚠️ The **region** of the client's booking must **match the agency's region**, or nobody gets the job (→ `NO_PROVIDER`).

---

## 1. Client requests a detail

- 👤 **Client:** open app → **"Protect me now"** (or Book wizard) → choose **Secure Transfer** → time = _now_ → set **pickup + drop-off** → pick package / add-ons → **pay screen** → **Submit**.
- ➡️ Booking status: `DRAFT → DISPATCHING`. Client sees **"Finding your detail…"** spinner.
- 🖥️ **Ops:** new booking appears on the board as **DISPATCHING**. _(watch only)_

## 2. System offers the job to an agency

- ⚙️ The system ranks nearby eligible agencies and sends an **offer to the best one** (30-second timer; it tries up to 8 agencies, one by one).
- 🏢 **Agency:** an **Incoming Offer** card appears (app must be open) — shows area, price, countdown. Buttons: **Accept / Decline**.
- 👤 **Client:** still "Finding your detail…"

## 3. Agency accepts

- 🏢 **Agency:** tap **Accept** before the timer runs out.
- ➡️ Client's money is **held in escrow** (reserved, not paid yet). Booking: `DISPATCHING → CONFIRMED`. Agency now has **15 minutes to assign a crew**. Other agencies' offers are cancelled.
- 👤 **Client:** screen flips to **"Agency accepted" → "Booking confirmed."**
- 🖥️ **Ops:** booking shows **CONFIRMED** with the assigned agency.

## 4. Agency assigns a CPO (crew)

- 🏢 **Agency:** go to **Missions** → open the booking → **assign sheet** → pick an available **CPO as lead** → confirm.
- ➡️ A **Mission** is created (status `DISPATCHED`). The CPO gets **20 minutes to arrive / start**.
- 🛡️ **CPO:** gets a **"New mission"** → opens **Assigned Mission Detail** (pickup, drop-off, principal, deploy checks, and a **verify code**).
- 👤 **Client:** sees "Your detail is being prepared."

## 5. CPO heads to pickup

- 🛡️ **CPO (lead):** drive to pickup → tap **Start / Pickup**.
- ➡️ Mission `DISPATCHED → PICKUP`.
- 👤 **Client:** **Live Tracking** shows the guard en route + a **"Verify your guard" 6-digit code** — client and CPO check the code matches (confirms it's the right guard).
- 🏢 **Agency:** watches on the **live monitor**.

## 6. Mission goes LIVE

- 🛡️ **CPO (lead):** principal is with them / protection starts → tap **Go-Live**.
- ➡️ Mission `PICKUP → LIVE`, and booking `CONFIRMED → LIVE`.
- 👤 **Client:** Live Tracking shows **protection in progress** (map + ETA). _(Client can NOT cancel now.)_
- 🏢 **Agency** + 🖥️ **Ops:** watching live. Any **SOS** shows up here.

## 7. Mission completes

- 🛡️ **CPO (lead):** reach destination / detail finished → tap **Complete**.
- ➡️ Mission `LIVE → COMPLETED`, booking `LIVE → COMPLETED`. Payout process starts.
- 👤 **Client:** **"Mission complete"** screen → **Rate agency** → **View invoice / receipt**.
- 🏢 **Agency:** mission shows completed, earnings pending.

## 8. Money settles

- ⚙️ After a short window (~1 min), the held money is **released to the agency's wallet** (the agency pays its CPO internally). An **invoice** is generated.
- 🏢 **Agency:** **Earnings** shows the payout (gross / fee / net).
- 🛡️ **CPO:** mission summary shows **"paid via your agency."**
- 👤 **Client:** receipt available.
- 🖥️ **Ops:** booking is **COMPLETED / settled**.

---

## Where things can go wrong (and who fixes it)

| Situation                                 | What happens                                                      | Who acts                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| No agency accepts                         | Booking → **NO_PROVIDER**                                         | 👤 Client retries · 🖥️ Ops can **force-assign**                               |
| Agency accepts but doesn't crew in 15 min | **AGENCY_NO_SHOW** → auto **full refund**                         | ⚙️ automatic                                                                  |
| CPO never arrives in 20 min               | Mission **ABORTED** → booking **re-dispatched** to another agency | ⚙️ automatic                                                                  |
| Client cancels                            | Free before accept · fee/window after · **blocked once LIVE**     | 👤 Client                                                                     |
| Emergency during mission                  | **SOS** alert                                                     | 🛡️ CPO triggers → 🏢 Agency + 🖥️ Ops see it                                   |
| Something stuck                           | Manual override                                                   | 🖥️ **Ops**: cancel dispatch / force-assign / complete booking / abort mission |

---

## The four roles in one line

- 👤 **Client** = requests → pays → tracks → rates.
- 🏢 **Agency** = accepts the offer → assigns a CPO → monitors → gets paid.
- 🛡️ **CPO** = accepts mission → Pickup → Go-Live → Complete (the one who actually runs it).
- 🖥️ **Ops Console** = watches everything; only steps in to rescue/override when the flow breaks.

---

## Status cheat-sheet

**Booking:** `DRAFT → DISPATCHING → CONFIRMED → LIVE → COMPLETED`
Branches: `→ NO_PROVIDER`, `→ AGENCY_NO_SHOW`, `→ CANCELLED`, `CONFIRMED → DISPATCHING` (re-dispatch).

**Mission:** `DISPATCHED → PICKUP → LIVE → COMPLETED` (plus `→ SOS`, `→ ABORTED`).

**Money (escrow):** `HELD` (on accept) → released to agency after completion + dispute window.

---

## Per-device run checklist

Tick each as you go across your devices.

**👤 Client device**

- [ ] Signed in, credits topped up
- [ ] Submitted booking → saw "Finding your detail…"
- [ ] Saw "Agency accepted" → "Booking confirmed"
- [ ] Live Tracking showed guard + verify code
- [ ] Saw "protection in progress" (LIVE)
- [ ] Got "Mission complete" → rated agency → saw invoice

**🏢 Agency device**

- [ ] App open, dispatch-eligible (DPA + region), roster has a CPO
- [ ] Received Incoming Offer → Accepted in time
- [ ] Assigned a CPO in Missions (within 15 min)
- [ ] Monitored the mission live
- [ ] Earnings shows the payout after settlement

**🛡️ CPO device**

- [ ] On Duty
- [ ] Got the new mission → opened Assigned Mission Detail
- [ ] Tapped Pickup (within 20 min) → verify code matched client
- [ ] Tapped Go-Live
- [ ] Tapped Complete → saw mission summary

**🖥️ Ops Console**

- [ ] Booking appeared and tracked DISPATCHING → CONFIRMED → LIVE → COMPLETED
- [ ] (If needed) used an override — force-assign / abort / complete
