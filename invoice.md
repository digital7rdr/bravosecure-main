# INVOICE

**OmniDevX Studio**
Software Design & Development

---

|               |                                                 |
| ------------- | ----------------------------------------------- |
| **Invoice #** | ODX-2026-001                                    |
| **Date**      | 2026-08-03                                      |
| **Project**   | Bravo Secure — Platform Development & Valuation |
| **Currency**  | USD                                             |

**Bill To:**
_Client name_
_Client address_
_Client email_

---

## Project Background

**Bravo Secure** is a full-stack, tactical-luxury private security platform: on-demand protection bookings, live mission tracking, a threat-intelligence feed, and a fully private, end-to-end encrypted communications suite — delivered as a cross-platform mobile app, a web-based operations console, and the backend services that power both. The engagement covered product design, architecture, and development of the complete system.

### Scope at a Glance

| Metric                              | Delivered                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| TypeScript source files             | 1,650+                                                                                               |
| Lines of code                       | ~350,000                                                                                             |
| Mobile screens                      | 185                                                                                                  |
| Operations console pages            | 33                                                                                                   |
| Database migrations (versioned SQL) | 101                                                                                                  |
| Automated test files                | 555                                                                                                  |
| Integrated native modules           | ~50 (Signal crypto, SQLCipher, WebRTC, CallKeep, Firebase, Stripe, Mapbox, camera/AV, biometrics, …) |

### Mobile Application (iOS / Android — React Native / Expo)

One app serving three distinct user roles:

- **Clients** book protection services on demand (Secure Lite, pay-per-booking) or apply for **Bravo Secure Pro** — a custom, operations-priced protection plan with a proposal/acceptance flow, one payment for the whole coverage period, an AI itinerary calendar of covered dates, in-plan protection-date requests at no extra charge, and a designated team with live map tracking. Clients can link **family members** from their contacts, who then operate under the primary plan with per-member spend limits, temporary holds, and relationship badges — all payable from the plan owner's credits.
- **Close Protection Officers (CPOs)** receive assigned missions or redeem operations-issued mission codes, then run the full mission lifecycle — pickup, go-live, real-time GPS telemetry, and completion — from a dedicated operational view.
- All roles share the **credits wallet** (Bravo Credits), top-ups with packages or custom amounts, booking history, and push notifications at every state change.

The **booking engine** itself computes team composition and pricing from the request — headcount-to-vehicle ratios, driver-only mode with client-vehicle seat caps, per-service rates — with the client app mirroring server pricing for instant quotes. Bookings flow through an ops-gated dispatch pipeline (request → operations approval → cascade to providers → CPO assignment), support cancellation with accurate refunds at every pre-mission stage, issue a **team verification code** so the client can authenticate the arriving officers, and settle through an **escrow → payout** lifecycle on completion. The UI ships in a consistent obsidian/cobalt design system with full accessibility, font-scaling, and small-screen/foldable support.

### Encrypted Messenger & Calls

A privately built secure-communications suite, integrated into the app:

- **Signal Protocol** end-to-end encryption (Double Ratchet, X3DH key agreement, Sealed Sender metadata protection) for one-to-one and group messaging — the relay server never sees plaintext or group membership.
- **Encrypted voice & video calls** (WebRTC, DTLS-SRTP), including group calls, with native system call UI integration — Android Telecom `ConnectionService` and an iOS CallKit path — for lock-screen ringing, Bluetooth routing, and coexistence with regular phone calls.
- **Encrypted media attachments** (AES-256, unique key per file, encrypted before upload), voice notes, link previews, replies, reactions, disappearing messages, typing/presence indicators, and delivery receipts.
- **Local-first encrypted storage** (SQLCipher database on device) with **Merkle-verified encrypted backup & restore**, plus an MFA-gated file vault requiring a fresh biometric/TOTP challenge for downloads.
- **Reliability engineering** across the pipeline: offline queueing and redelivery, killed-app call wake-up via high-priority push with HMAC-verified payloads, headless message drain so notifications show real content without opening the app, contact discovery with E.164 phone normalization, and multi-device session handling.
- **Tiered feature subscriptions** (Lite / Pro / Enterprise) gating vault capacity and premium messenger features, with ops-editable pricing.

### Virtual Bodyguard & Intelligence

A safety-intelligence layer: a live news/threat feed blending curated OSINT sources with region- and category-filtered coverage across 190+ countries, geo-risk area search with radius and time-window controls, keypoint mapping, and next-of-kin quick-dial favorites.

### Backend Platform (NestJS / PostgreSQL / Redis)

- **Auth service** — registration and OTP login, JWT/refresh session management, TOTP and biometric step-up, Signal key distribution, bookings and pricing, ops-gated dispatch, escrow and payouts, pro applications/proposals, and push notification fan-out (FCM, with an APNs VoIP path prepared for iOS).
- **Messenger service** — the sealed-sender envelope relay (transient store, bounded dwell time), real-time WebSocket gateway for presence/typing/receipts, media presign, and the file-vault MFA gate.
- Conflict-safe scheduling enforced at the database level (no overlapping CPO assignments, no duplicate missions), versioned SQL migrations, and Redis-backed session/envelope handling.

### Operations Console (Next.js web)

The command center for the business: booking oversight and CPO assignment, live mission monitoring on a map, **Pro Applications** management (review, custom proposals with revisions, date-window CPO assignment with availability filtering), **Pro Management** (assignment ledger, CPO pool with system-generated credentials, provider organizations), payouts, and role-based access control.

The console also carries **provider-organization tenancy** — service-provider companies own managed CPOs, act as payees, and get their own end-to-end encrypted chat workspace with attendance verification — alongside finance views, dispute handling, user administration, and a browser-side encrypted vault (IndexedDB + AES-GCM) so the console itself never holds plaintext at rest.

### Technology Stack

| Layer             | Technology                                                                       |
| ----------------- | -------------------------------------------------------------------------------- |
| Mobile            | React Native 0.81 + Expo SDK 54, TypeScript, React 19, Zustand, React Navigation |
| Cryptography      | Signal Protocol (libsignal), Sealed Sender v2, AES-256, SQLCipher                |
| Real-time & calls | WebRTC (DTLS-SRTP), WebSockets, CallKeep (Telecom / CallKit)                     |
| Ops console       | Next.js 15 (App Router), React 19, Tailwind, SWR, Mapbox GL                      |
| Backend           | NestJS (Node.js), PostgreSQL, Redis, S3-compatible object storage                |
| Notifications     | Firebase Cloud Messaging, APNs (VoIP path prepared)                              |
| Shared core       | Platform-agnostic crypto/transport package consumed by mobile and web            |

### Quality & Security Engineering

Delivered with an extensive automated test suite (split Jest projects for app, crypto, and booking flows), static security gates (no-plaintext-logging audit, invariant scans on the crypto pipeline), mutation and flake testing on the cryptography layer, typecheck/lint CI gates, and a documented architecture and QA trail.

The valuation below reflects the software deliverables only; hosting and infrastructure are provisioned and operated by the client.

---

## Project Valuation & Deliverables

| #   | Description                                                                                                     | Amount (USD) |
| --- | --------------------------------------------------------------------------------------------------------------- | -----------: |
| 1   | Mobile application — React Native / Expo client (booking, missions, live GPS tracking, VBG intel)               |       $7,000 |
| 2   | End-to-end encrypted messenger — Signal Protocol, sealed sender, group calls (WebRTC), encrypted media & backup |       $6,000 |
| 3   | Backend services — auth-service & messenger-service (NestJS), dispatch, escrow/payouts, notifications           |       $4,000 |
| 4   | Ops Console — Next.js admin dashboard (bookings, pro management, live monitoring)                               |       $2,500 |
| 5   | QA, security review & documentation                                                                             |         $500 |

---

|              |                    |
| ------------ | -----------------: |
| **Subtotal** |         $20,000.00 |
| **Tax (0%)** |              $0.00 |
| **TOTAL**    | **$20,000.00 USD** |

---

## Payment

- Payment method: _bank transfer / other — details on request._

**Payment Details:**
_Account name / IBAN / SWIFT — to be provided_

---

Thank you for your business.

**OmniDevX Studio**
_contact@omnidevx.studio_
