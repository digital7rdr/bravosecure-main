# Virtual Bodyguard — Client Feature Brief

_A plain-language summary of what the Virtual Bodyguard (VBG) module does today._

---

## What it is

**Virtual Bodyguard** turns the principal's phone into a quiet, always-on safety companion. It does three things at once:

1. **Watches where the principal is** — encrypted GPS tracking with safe/danger zones.
2. **Tells the principal what's happening around them** — live, region-specific threat intelligence.
3. **Escalates to the Ops Room automatically** — when a check-in is missed, a zone is breached, or the panic button is pressed.

Everything is tied to the **signed-in user** (the "principal") and their **current location** — there is no hardcoded demo data anywhere in the experience. Location is read from the device GPS, and the safety picture is built fresh for wherever the principal actually is.

---

## 🛡️ The four screens

### 1. Home (Dashboard)

The principal's at-a-glance safety overview:

- **Principal card** — name, subscription tier, current status (e.g. _PROTECTED_ / _ALERT_), and last-updated time.
- **Live location** — the region the principal is in, the current geofence status, and a count of live and critical alerts.
- **Intel snapshot** — three mini cards summarising the Security Risk level, the OSINT threat feed, and the nearest key points.
- **Panic button** — a hold-to-trigger button (held for ~1.6 seconds to avoid accidental presses) that instantly alerts the Ops Room.
- **Quick actions** — contact Ops, or request a CPO / Secure Transfer (which routes into the standard Bravo booking flow).

While Home is open, the app quietly sends an **encrypted location update every 3 seconds** and refreshes the regional threat feed about every 45 seconds.

### 2. SRA — Security Risk Assessment

A briefing on how safe the principal's current area is right now:

- **Executive summary** — a short narrative describing the area and its risk picture.
- **Risk meter** — a single score from **0 to 100**, mapped to a level: **LOW → MEDIUM → HIGH → CRITICAL**.
- **Risk breakdown** — four categories rated low / medium / high: **Violent Crime, Robbery & Theft, Civil Disruption, Opportunistic Crime**.
- **Recommendations** — practical guidance (vary your routine, stay aware of surroundings, keep valuables out of sight, plan alternative routes).
- **Enable Face-Scan Monitoring** — a button that turns on biometric check-ins (see below).

The risk score is calculated from live incident data for the principal's region — weighted toward serious incidents — so it reflects the actual area, not a generic baseline. Every assessment shown to the principal is **saved**, so the Ops Room can later see exactly what the principal was advised.

### 3. OSINT — Live Threat Feed

Open-source intelligence for the principal's current region:

- A live, filterable list of recent local incidents (filter by **All / Critical / Caution / Information**).
- Each item shows a **severity badge**, how long ago it was reported, a headline, a topic tag, and the source.
- Tap any item to open the original article.

This feed is **live** — it is not stored, it simply reflects what's being reported in the area right now.

### 4. Nearby — Key Points

A quick map of safe havens around the principal:

- The nearest **police stations, hospitals, embassies, and fire services**, each with its distance from the principal.
- A clean tactical-style layout with the principal centred and key points pinned by category colour.
- A **"Request Secure Transfer"** action to book a vehicle out of the area.

---

## 📍 Location tracking & geofencing

### Safe & danger zones

The principal (or the Ops team) can draw two kinds of zones on the map:

- **Safe zones** — areas the principal _should stay inside_. Leaving one raises an alert.
- **Danger zones** — areas the principal _should stay outside_. Entering one raises an alert.

Zones can be created, listed, and removed at any time. They are evaluated automatically on **every location update**.

### How breaches work

A breach alert only fires when the principal **crosses a boundary** — moving from "OK" into a zone, or out of a safe area. Sitting still inside a zone does **not** spam alerts. When a breach happens, the Ops Room is notified, the event is logged, and the principal receives an SMS confirming Ops has been alerted.

---

## ✅ Biometric check-ins (face scans)

Once enabled, the principal is prompted for a **face scan on a set interval** (default every 60 minutes; configurable from 15 minutes up to 24 hours).

- **A successful scan** quietly resets the timer.
- **Three missed or failed scans in a row** automatically escalate to the Ops Room: an alert appears on the Ops live feed, an SMS goes out, and the case is queued for action (e.g. an Ops callback).

There is also a **heartbeat safety net**: if no check-in is received for three times longer than the chosen interval (e.g. 3 hours on a 60-minute setting), the system escalates on its own — even if the principal's phone has gone quiet.

---

## 🚨 Panic button

A single hold of the panic button fans out an alert across every channel at once:

- The **Ops Room** receives an immediate SOS on its live feed.
- The principal's registered phone receives a **confirming SMS**.
- Connected Ops dashboards and the principal's own devices are **notified in real time**.
- The event is **logged** for audit.

The principal sees an instant "Ops Room Alerted" confirmation.

---

## 🔒 Security & privacy

- **Encrypted location data.** Every GPS update is sealed on the device using **AES-256-GCM** (a strong, tamper-evident encryption standard) before it leaves the phone.
- **Per-device key.** Each device is issued its own unique encryption key when monitoring is first enabled. The key is stored in the device's secure keychain and is shown only once. Re-enrolling rotates it.
- **Tamper protection.** If an encrypted update is altered in transit, it is rejected — it cannot be quietly forged.
- **Scoped to the principal.** Every request is tied to the signed-in user; no one can pull another person's location or status.
- **Short retention.** Live tracking history is kept only briefly (a rolling recent window) for the Ops live map, with a durable last-known-position fallback.

---

## 🧭 How the intelligence is built

- **Where am I?** The principal's GPS fix is turned into a real place name (region + surrounding context).
- **What's happening here?** Recent local incidents are pulled from an open-source global news intelligence feed, filtered to the principal's region and classified by severity.
- **Where can I go?** Nearby police, hospitals, embassies, and fire services are located and ranked by distance.

If any of these data sources is briefly unavailable, the app **degrades gracefully** — it shows a sensible fallback rather than failing — so the safety experience never hard-stops.

---

## 📋 At a glance — what triggers an Ops alert

| Trigger                                          | What happens                                                   |
| ------------------------------------------------ | -------------------------------------------------------------- |
| **Panic button held**                            | Immediate Ops SOS + SMS + real-time notification + audit log   |
| **3 missed/failed face scans**                   | Ops alert + SMS + queued for callback, then the counter resets |
| **No check-in for 3× the interval**              | Automatic escalation to Ops                                    |
| **Entering a danger zone / leaving a safe zone** | Ops alert + SMS + real-time breach notification                |

---

_All figures (60-minute default interval, 3-strike escalation, 0–100 risk scale, 3-second tracking tick) reflect the current build and can be tuned per deployment._
