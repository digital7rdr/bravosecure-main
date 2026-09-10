# Bravo Secure — What One Architect Built

**A production close-protection platform: encrypted messenger, WebRTC calling, and a
real-time dispatch marketplace — 255,000+ lines of TypeScript across five surfaces,
architected and predominantly built by a single engineer in under four months.**

_Last updated: 2026-07-19 · Shipping v1.0.117 · Every figure in this document is
independently verifiable — see [§7 Verify It Yourself](#7-verify-it-yourself)._

---

## 1. At a Glance

|                           |                                                                  |
| ------------------------- | ---------------------------------------------------------------- |
| **Production TypeScript** | **255,546 lines** across 5 independent surfaces                  |
| **Mobile app**            | 162,605 LOC · 169 screens · 8 domain modules · 10 state stores   |
| **Backend services**      | 68,067 LOC · **344 HTTP endpoints** · 2 NestJS services          |
| **Admin web console**     | 16,388 LOC · Next.js 15 App Router                               |
| **Shared crypto core**    | 8,486 LOC · one library, two platforms                           |
| **Test suite**            | 260 files · **2,118 test cases** · 3 isolated Jest projects      |
| **Database**              | 93 SQL migrations                                                |
| **Elapsed time**          | 2026-03-24 → 2026-07-19 (**~17 weeks**)                          |
| **Releases shipped**      | **36 tagged releases**, currently v1.0.117                       |
| **Quality artifacts**     | 30 audit reports · 11 operational runbooks · 117 tracked defects |

This is not a prototype, a design mockup, or a thin CRUD wrapper. It is a deployed,
versioned, continuously-released product with an end-to-end encrypted messenger and a
live two-sided marketplace inside it.

---

## 2. Five Products, Not One

Most startups at this stage have built one application. Bravo Secure is five
interlocking systems, each of which is independently non-trivial.

### 2.1 Mobile client — React Native 0.81 / Expo 54

163k lines. 169 screens serving **four distinct user roles** — clients booking
protection, close-protection officers (CPOs) running missions, service-provider
agencies managing officer pools, and operations staff. Signal-protocol messenger,
WebRTC voice and video, live GPS mission tracking, Mapbox mapping, biometric gates,
and an offline-capable SQLCipher-encrypted local database.

### 2.2 Auth & operations service — NestJS

47,717 lines, **310 HTTP endpoints**. Authentication with JWT rotation, device
binding, and single-device takeover. The full commercial engine: bookings, auto-dispatch
matching, mission lifecycle, escrow, payouts, the BC credits economy, and the
Lite/Pro/Enterprise tier system with ops-editable charge-time pricing.

### 2.3 Messenger relay — NestJS

20,350 lines, 34 endpoints plus a WebSocket gateway backed by Redis. Sealed-sender
envelope transport, sender-certificate issuance, group message fan-out, presence,
typing indicators, read receipts, and the encrypted file vault. **The relay is
cryptographically incapable of reading message content** — it moves ciphertext and
holds it transiently until delivery.

### 2.4 Operations console — Next.js 15

16,388 lines. A second full frontend for staff: dispatch approval, compliance and
armed-officer verification, booking and mission oversight, payouts, disputes, and
live Mapbox tracking. Critically, it runs **the same end-to-end encryption as mobile**
via a browser-side vault (IndexedDB + AES-GCM) — staff read encrypted threads without
the server ever holding a key.

### 2.5 Shared crypto core — `@bravo/messenger-core`

8,486 lines of platform-agnostic cryptography consumed by both React Native and the
browser. This is the architectural keystone: one audited implementation, two runtimes,
zero divergence.

---

## 3. Why This Is Hard

Line counts measure volume, not difficulty. These are the parts that normally require
named specialists.

### 3.1 Real end-to-end encryption

Signal Protocol via libsignal — **Double Ratchet** for message bodies, **X3DH** for key
agreement, **Sealed Sender v2** so the server cannot see who is talking to whom. Group
messaging uses a master key distributed over pairwise Signal sessions with **rekey on
member removal** and epoch handling. Media is AES-256-CBC with a unique key per file,
encrypted before upload, key shipped in-band inside the encrypted envelope.

Most companies claiming "encrypted messaging" ship TLS and call it a day. This is the
actual protocol, including the metadata-protection layer that is the hardest part to
get right.

### 3.2 Encrypted backup with cryptographic integrity proofs

A Merkle-tree commit and verification system for message backup and restore. The
verifier is deliberately fail-closed and is protected by a written architectural
contract that forbids weakening it — because a restore dead-end recurred five times,
each patch treating a symptom while the write path kept manufacturing drift. It was
ultimately killed at source with a persistent ledger and a pending-commit flag.

**That is the signature of real engineering maturity: not the absence of bugs, but a
documented refusal to paper over a bug class.**

### 3.3 WebRTC calling that survives the real world

One-to-one and group voice/video with DTLS-SRTP media encryption, SFrame for group
media, native call UI via CallKeep, foreground services, and push-wake ringing for
killed apps. Solved problems include lock-screen call continuity, calls dying at the
15-minute token wall (fixed with in-place WebSocket auth refresh), and a tile-rendering
race that made participants invisible despite healthy media.

Mobile WebRTC is where engineering teams go to lose quarters. This works on real devices.

### 3.4 A live two-sided marketplace

Client books → ops-gated auto-dispatch matches the nearest agency → agency assigns an
officer → officer runs a live GPS-tracked mission → escrow releases to payout. Every
step is notified, cancellable, and resumable, with real-time telemetry streaming over
WebSockets. This is Uber-class dispatch logic with money and physical safety attached.

### 3.5 Regulated-industry compliance features

Departmental Chat with ML Kit face-capture attendance verification, structured incident
reporting, dispute routing, and PDF export. Geo-risk intelligence blending GDELT and
NewsData threat feeds against mapped keypoint rings. Armed-officer and compliance
verification workflows. Next-of-kin emergency contacts.

---

## 4. Discipline Most Startups Never Build

Scope is only half the story. The operating system around the code is the other half.

**Automated quality gates.** Three isolated Jest projects (app / crypto / booking),
mutation testing on the crypto suite, flake detection, coverage reporting, a hard
TypeScript error-count baseline that blocks regression, ESLint, dead-code detection,
dependency auditing, SBOM generation, and bundle-size checks — bundled into fast local
and full CI commands, enforced by pre-push hooks.

**Security invariants encoded as tests.** A static log-audit test makes it _impossible
to merge_ code that logs plaintext message bodies, decrypted media, or key material.
The rule is not a guideline in a wiki; it fails the build.

**Written operating procedures.** 11 runbooks, including module-specific verification
loops for booking, backup, and design review. Each defines invariants, automated gates,
device probes, and explicit sign-off criteria that must hold before a change ships.

**Continuous delivery.** Push to main auto-deploys changed services to the production
VPS over SSH and Docker Compose. Mobile ships through EAS and Firebase App Distribution.
**36 releases in 17 weeks — roughly one every three days.**

**Adversarial QA.** 117 individually tracked defects with root-cause analysis, log
evidence, and files involved. 30 formal audit reports covering security, credits,
notifications, mapping, messenger, and data coverage — each with findings triaged and
remediated.

**A coherent design system.** A single obsidian/cobalt visual language enforced across
all 169 screens, with an accessibility and responsive matrix spanning 320–430dp phones,
foldables, tablets, and large font scales. All 252 native alert call sites were migrated
to one branded dialog component, with a static sweep preventing regression.

---

## 5. What This Would Normally Cost

A conventional organization shipping this scope in this timeframe would staff roughly:

| Role                             | Ownership here                                  | Heads     |
| -------------------------------- | ----------------------------------------------- | --------- |
| Mobile engineers (React Native)  | 163k LOC, 169 screens, native modules           | 2–3       |
| Backend engineers (NestJS)       | 344 endpoints, 93 migrations, marketplace logic | 2         |
| Cryptography / security engineer | Signal, sealed sender, Merkle backup, vault MFA | 1         |
| Real-time / WebRTC specialist    | Calling, SFU, CallKeep, push wake               | 1         |
| Frontend engineer (Next.js)      | Ops console + browser crypto vault              | 1         |
| DevOps / SRE                     | CI/CD, VPS, Docker, release pipeline            | 1         |
| QA engineer                      | 117 defects, audits, device matrix              | 1–2       |
| Product designer                 | Design system, 169 screens, accessibility       | 1         |
| Technical lead / PM              | Architecture, sequencing, specs                 | 1         |
| **Total**                        |                                                 | **11–13** |

At fully-loaded North American or Western European rates, a team of that size costs on
the order of **$2M annually**, or roughly **$600–700k for a four-month build** — before
the coordination overhead, hiring lead time, and architectural drift that come with
thirteen people touching five codebases.

_Estimates are directional and vary substantially by region and seniority mix._

---

## 6. How One Person Did It

Three factors, stated plainly:

1. **Unified architecture.** One mind across all five surfaces means no integration
   negotiation, no cross-team API disputes, and no duplicated crypto. The shared
   `messenger-core` package exists precisely because one person owned both consumers.

2. **Process as force multiplier.** The runbooks, quality gates, and bug log are not
   bureaucracy — they are how one person safely holds 255k lines in working order.
   Automated gates replace the code reviewer; written invariants replace tribal memory.

3. **Aggressive AI leverage.** Development is AI-assisted under a strict verification
   discipline: every change must pass direct tests, regression tests, and typecheck
   baselines before it counts as done. AI accelerates production; the gates guarantee
   correctness. This is a deliberate, documented operating model — not a shortcut.

The result is a **structurally lower burn rate for equivalent output**, with the
architectural coherence that distributed teams typically spend years recovering.

---

## 7. Verify It Yourself

Every headline number is reproducible from the repository:

```bash
# Total production TypeScript across all five surfaces  → 255,546
for d in src apps/auth-service/src apps/messenger-service/src \
         apps/ops-console/src packages/messenger-core/src; do
  find "$d" -name "*.ts" -o -name "*.tsx" | xargs cat | wc -l
done

# HTTP endpoints                                        → 310 + 34
grep -rhoE "@(Get|Post|Patch|Put|Delete)\(" apps/auth-service/src | wc -l
grep -rhoE "@(Get|Post|Patch|Put|Delete)\(" apps/messenger-service/src | wc -l

# Tests                                                 → 260 files / 2,118 cases
find . -name node_modules -prune -o -name "*.test.ts*" -print | wc -l

# Screens, migrations, releases                         → 169 / 93 / 36
find src/screens -name "*.tsx" | wc -l
find . -name node_modules -prune -o -name "*.sql" -print | wc -l
git log --oneline --grep="chore(release)" | wc -l

# Authorship and timeline
git shortlog -sne --all
git log --reverse --format=%ad --date=short | head -1
```

---

## 8. Credits — Stated Honestly

This document claims **architectural and majority authorship**, not sole authorship, and
the repository's own history is the reference:

- **Ranak** — 356 of 567 commits (63%), **+399,090 lines (~82% of all code added)**.
  The only contributor working across every surface: cryptography, backend, mobile,
  ops console, infrastructure, and design system. All architecture and all security-
  critical implementation.
- **A small support crew** — two additional contributors (192 and 23 commits) covering
  QA, release engineering, documentation, iOS build tooling, and targeted feature and
  bugfix work, principally in the auth service and calling stack.

The scope, the architecture, and the hard problems described in §3 are the work of one
engineer. The support around release and QA is credited above rather than absorbed —
because a claim that survives `git shortlog` is worth more than one that doesn't.
