# Family Hierarchy — Client Feature Brief

_A plain-language summary of what the Family Hierarchy (shared credits) module does today._

---

## What it is

**Family Hierarchy** lets one Bravo Secure account holder share their Bravo Credits with up to **four** family members or colleagues — in a controlled, fully transparent way.

The account holder invites people, optionally caps how much each can spend, and watches a live usage dashboard. When an invited member books a service, the charge comes straight out of the **holder's wallet** — the member never has to top up their own balance.

Think of it like a family plan with a clear spending picture: one payer, several users, full visibility.

---

## 👥 Roles

- **Account holder** — owns the wallet and the credits. Invites members, sets spend caps, can remove anyone at any time, and sees the full usage breakdown.
- **Member** — accepts an invite and then simply books as normal. Their bookings are paid by the holder automatically. Members can be capped or unlimited.

A person can be an **active member of only one family at a time**.

---

## ✉️ Inviting members

The holder invites people **by phone number**. Two things can happen:

1. **The number already has a Bravo account** — the invite lands in that person's app straight away, ready to accept.
2. **The number isn't registered yet** — the invite is held against the phone number. The moment that person signs up for Bravo Secure, the pending invite automatically appears in their app. (So you can invite family before they've even installed the app.)

At invite time, the holder can optionally set a **spend cap** for that member (e.g. "Alice can use up to 500 credits"). Leave it blank for unlimited use within the holder's balance.

**Built-in safeguards:**

- Up to **4 active members** per family.
- You can't invite **yourself**.
- You can't invite someone who's **already active in another family**.
- You can't send a **duplicate** pending invite to the same number.

---

## 🔄 Accepting, declining, and leaving

### Member side

- A member sees the invite with the holder's name and a short note: _"[Holder] invited you to their family. You'll be able to use their Bravo Credits."_
- **Accept** → they're linked. From that moment, their bookings are paid by the holder.
- **Decline** → the invite is dismissed and can't be reused.

### Holder side

- The holder can **revoke** any member at any time. The member instantly loses access to the shared credits.
- The member's spending history is kept for the holder's records, but stops updating once they're removed.

Every member sits in one of four clear states: **Pending → Active → (Revoked or Declined)**.

---

## 💳 How shared credits work

When a member books a service and chooses **"Pay with Bravo Credits"**:

1. The system checks whether the member belongs to a family.
2. **If they do**, the holder's wallet is charged — not the member's.
3. **If they don't**, the member pays from their own wallet as normal (non-members are completely unaffected).

To the member, it's seamless — they just book. The family billing happens automatically behind the scenes.

### Spend caps

If the holder set a cap for a member, it's checked **before** every charge:

| Member | Spent so far | Cap    | Booking of 100 cr?                                |
| ------ | ------------ | ------ | ------------------------------------------------- |
| Alice  | 200 cr       | 500 cr | ✅ Allowed (now 300)                              |
| Bob    | 480 cr       | 500 cr | ❌ Blocked — would exceed the cap                 |
| Carol  | 100 cr       | _none_ | ✅ Allowed — only limited by the holder's balance |

If a member hits their cap, the booking is politely blocked with a message to ask the holder to raise the limit or top up. The holder can **change or remove a cap** at any time.

### Safe by design

Each charge runs as a **single locked transaction** against the holder's wallet. That means two members booking at the exact same moment can't accidentally overspend the balance or slip past a cap — the system processes them one after another and always sees an accurate balance.

---

## 📊 The credit-usage dashboard

The holder gets a clear, real-time view of where the family's credits are going — similar in spirit to a usage page:

- **Total family spend** — a single headline number across all members.
- **Per-member breakdown** — for each member: their name, how much they've spent (and their cap if set), their **share of the total as a percentage**, and a colour-coded **progress bar**.
- **Recent charges** — the latest family transactions, each showing the date, the amount, and a link to the booking.

For members who haven't registered yet, the dashboard shows their invited phone number until they sign up and their name becomes available.

---

## 📱 What members see

- **Before accepting** — a pending invite from the holder, with **Accept** / **Decline**.
- **After accepting** — a "Membership" section on their profile showing who they're linked to, their spend cap (or "Shared credits" if unlimited), and how much they've used.
- **When booking** — "Pay with Bravo Credits" works exactly as it always has. If they ever hit a cap, they get a clear prompt to ask the holder.

Profiles throughout the app reflect the **real signed-in user** — there's no placeholder family data anywhere.

---

## 📋 At a glance

| Capability        | Detail                                                                             |
| ----------------- | ---------------------------------------------------------------------------------- |
| **Family size**   | Up to 4 active members per holder                                                  |
| **Invite method** | By phone number; works even before the person registers                            |
| **Spend caps**    | Optional, per member, changeable any time                                          |
| **Who pays**      | The holder's wallet, automatically, for every member booking                       |
| **Visibility**    | Live dashboard: total, per-member share %, and recent charges                      |
| **Control**       | Holder can revoke any member instantly                                             |
| **Safety**        | Caps and balances enforced in locked transactions — no overspend, no double-charge |

---

_All limits (4 members, optional caps, last-20 recent charges) reflect the current build and can be tuned per deployment._
