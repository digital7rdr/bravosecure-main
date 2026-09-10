# 1. Source Code & Repository

**Bravo Secure — Technical Code & System Handover, Section 1**

|                   |                                                                               |
| ----------------- | ----------------------------------------------------------------------------- |
| **Document**      | Source Code & Repository                                                      |
| **Covers**        | Handover checklist §1, items 1–16 incl. the required clone/configure/run demo |
| **Scope**         | Self-contained — every fact needed for §1 is stated here, not linked out      |
| **Source commit** | `b38e42ea` (branch `main`, 2026-08-21)                                        |
| **Prepared**      | 2026-08-22                                                                    |

> **How this document was produced.** Every remote URL, branch name, script,
> dependency version, environment variable and file path below was read out of
> the working tree at commit `b38e42ea`. Counts were produced by scanning the
> source, not estimated. Where a behaviour is non-obvious the document names the
> file that implements it so the claim can be re-checked; **file paths and script
> names are the durable anchor — re-read the file rather than trusting a line
> number**, which moves with every commit.
>
> Where the answer to a checklist item is "this does not exist yet" or "this is
> currently done by hand", the document says so plainly and lists it in the
> **§1.17 open items** table rather than describing an intention as if it were a
> fact.

---

## 1.1 Source code repositories and access

The entire system — mobile app, two backend services, operator console and the
shared crypto library — lives in **one Git repository**. There is no second
codebase to hand over.

| Remote   | URL                                                     | Role                                                                                                   |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `origin` | `https://github.com/omnidevxstudiobit/Bravo_Secure.git` | **Source of truth.** Full history, all branches, CI, secrets, internal docs. Development happens here. |
| `mirror` | `https://github.com/digital7rdr/bravosecure-app.git`    | **Client-facing snapshot.** A single squashed commit of `main`, force-pushed on every `main` update.   |

Both are configured in the working checkout:

```bash
$ git remote -v
mirror  https://github.com/digital7rdr/bravosecure-app.git (fetch/push)
origin  https://github.com/omnidevxstudiobit/Bravo_Secure.git (fetch/push)
```

### What the mirror is and why it exists

`.github/workflows/mirror-to-client.yml` runs on every push to `main`. It checks
out `main`, **strips** a fixed set of internal paths, rebuilds the tree as a
single fresh commit with no upstream trailers, and force-pushes it to the client
repo. It is a _snapshot_, not a fork — the client repo has no upstream history.

Stripped before publishing:

| Removed                          | Reason                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `.github/`                       | So the client repo does not attempt to run our CI or our deploys.                  |
| `.claude/`                       | Internal AI-assistant configuration, skills and commands.                          |
| `docs/planning/BUILD_RUNBOOK.md` | Internal build spec — carries security stop-conditions and architecture internals. |

The workflow also carries commented-out lines for stripping `sqa.md` (the
internal bug log, which contains unfixed security findings) and
`docs/handoffs docs/qa docs/audits`. **These are currently NOT stripped** — the
client mirror today contains the full internal bug log. If that is not intended,
uncomment those lines before the next push to `main`.

The mirror needs a repository secret `MIRROR_TOKEN` — a GitHub PAT (or a
fine-grained token with `Contents: write`) that can push to
`digital7rdr/bravosecure-app`. Without it the job fails loudly rather than
silently skipping.

### Granting access to a new party

1. **GitHub** — add the user to `omnidevxstudiobit/Bravo_Secure` (Settings →
   Collaborators, or via the org team). `Write` is enough for day-to-day work;
   `Admin` is only needed to change rulesets or secrets.
2. **Secrets are not in the repo** — see §1.14. The developer additionally needs
   the out-of-band `ENV_SETUP.md` handoff document, which is deliberately
   gitignored.
3. **Third-party consoles** are separate grants and are not controlled by GitHub
   access: Supabase project, Contabo staging box (SSH key), Firebase / Google
   Play Console, Apple Developer (App Store Connect), Mapbox, Twilio, Stripe.

---

## 1.2 Repository / folder structure

### The one-line mental model

> Four deployable surfaces + one shared library, in one repo, joined by
> **TypeScript path aliases** — **not** npm workspaces. Each backend has its own
> `package.json` and its own `node_modules`.

That last point is the single most common source of confusion. `npm install` at
the repo root installs the **mobile app's** dependencies only. The two NestJS
services must each be installed separately from inside their own directory.

```
Bravo Secure/
│
├── App.tsx  index.js                    ← mobile entry point
├── src/                                 ← MOBILE FRONTEND  (1,426 .ts/.tsx files)
│   ├── screens/                             196 .tsx (177 *Screen.tsx)
│   ├── components/                          shared UI
│   ├── navigation/                          React Navigation stacks/tabs
│   ├── services/                            api.ts — the HTTP client
│   ├── store/                               Zustand stores
│   ├── hooks/  utils/  theme/  types/  i18n/
│   ├── modules/                             cross-cutting domains:
│   │   ├── messenger/                         E2EE chat, calls, backup, vault
│   │   ├── booking/                           Lite/Secure booking + maps HTML
│   │   ├── agent/                             CPO mission surfaces
│   │   ├── maps/                              Mapbox token + WebView bridge
│   │   ├── news/  vbg/                        intel feed, geo-risk
│   │   ├── profile/  observability/
│   └── __tests__/
│
├── apps/                                ← BACKENDS + CONSOLE
│   ├── auth-service/                        NestJS :3001   (393 .ts files)
│   ├── messenger-service/                   NestJS :3100   (120 .ts files)
│   └── ops-console/                         Next.js :3002  ( 73 .ts/.tsx files)
│
├── packages/
│   └── messenger-core/                  ← SHARED CRYPTO LIB (30 .ts files)
│                                           libsignal wrapper, sealed-sender v2,
│                                           group crypto, wire types
│
├── android/                             ← ANDROID NATIVE (mostly gitignored —
│                                           21 files force-added, see §1.6)
├── native/ios/                          ← iOS native sources kept OUTSIDE ios/
│                                           (BravoFrameCryptor .swift + .m)
├── plugins/                             ← Expo config plugins (3) that inject
│                                           native code at prebuild time
├── patches/                             ← 10 patch-package patches
│
├── supabase/                            ← 150 SQL migrations + config + seed
├── infra/                               ← systemd units, bootstrap, env templates
├── scripts/                             ← 27 build / release / E2E / diag scripts
├── docs/                                ← architecture, audits, runbooks, QA
├── .github/                             ← 12 workflows + CODEOWNERS + labeler
├── .husky/                              ← pre-commit, commit-msg, pre-push gates
│
├── package.json                         ← mobile deps + the 3-project Jest config
├── tsconfig.json  babel.config.js  metro.config.js
├── app.json  eas.json                   ← Expo app config + EAS build profiles
├── docker-compose.yml                   ← local redis + messenger-service + coturn
├── CLAUDE.md  AGENTS.md  LOOP.md  sqa.md  README.md
└── .gitignore  .gitleaks.toml  .tsc-baseline.json  knip.json
```

### Root files that are not obvious

| File                      | What it is                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md` / `AGENTS.md` | Operating instructions for AI coding assistants. Encodes the repo's hard rules (test gates, security stop-conditions).     |
| `LOOP.md`                 | The verify → audit → risk-review procedure every change is expected to follow.                                             |
| `DESIGN_REVIEW_LOOP.md`   | The UI/design review procedure and quality gates.                                                                          |
| `sqa.md`                  | The running QA bug log (B-01 … B-600+) with root cause, evidence and files involved. Not auto-loaded; read it for QA work. |
| `.tsc-baseline.json`      | The typecheck error ratchet — see §1.11.                                                                                   |
| `knip.json`               | Dead-code detection config (`npm run deadcode`).                                                                           |
| `skills-lock.json`        | Pinned versions of the assistant skill files under `skills/`.                                                              |

### Path aliases (how the surfaces are joined)

`tsconfig.json` and `babel.config.js` define the **same** alias table. Both must
be edited together — TypeScript resolves for the typechecker, Babel's
`module-resolver` resolves for the Metro bundler at runtime.

| Alias                   | Resolves to                   |
| ----------------------- | ----------------------------- |
| `@/*`                   | `src/*`                       |
| `@screens/*`            | `src/screens/*`               |
| `@components/*`         | `src/components/*`            |
| `@navigation/*`         | `src/navigation/*`            |
| `@services/*`           | `src/services/*`              |
| `@store/*`              | `src/store/*`                 |
| `@hooks/*`              | `src/hooks/*`                 |
| `@utils/*`              | `src/utils/*`                 |
| `@theme/*`              | `src/theme/*`                 |
| `@appTypes/*`           | `src/types/*`                 |
| `@modules/*`            | `src/modules/*`               |
| `@bravo/messenger-core` | `packages/messenger-core/src` |

`@bravo/messenger-core` is the alias that makes the shared library work without
npm workspaces. The ops console declares the same alias in its own
`tsconfig.json`, and the Jest `messenger-crypto` project maps it a third time in
`package.json`. **Mobile is the source of truth for that package** — ops-console
consumes it read-only.

---

## 1.3 Frontend code

"Frontend" in this system means **two** distinct applications, both TypeScript,
sharing no UI code.

### A. The mobile app — `src/` + `App.tsx` + `index.js`

React Native 0.81.5 on Expo SDK 54. **One binary, three product shells** — a
client, an agency/service operator, and a CPO (Close Protection Officer) all run
the same install; the navigator chooses the shell from the authenticated user's
role and product tier.

| Directory         | Contents                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/screens/`    | 196 `.tsx` files grouped by product area (`booking/`, `agent/`, `messenger/`, `vbg/`, …); 177 are named `*Screen.tsx`, the rest are screen-local subcomponents. |
| `src/components/` | Shared presentational components and the design-system primitives.                                                                                              |
| `src/navigation/` | React Navigation 6 — native-stack + bottom-tabs. `MainNavigator` owns the custom tab bar.                                                                       |
| `src/services/`   | `api.ts` (3,268 lines) — the single axios client. 28 exported API groups. Token attach + refresh interceptors live here.                                        |
| `src/store/`      | Zustand 5 stores (auth, booking, messenger, presence, …).                                                                                                       |
| `src/modules/`    | Cross-cutting domain logic that is not a screen: crypto runtime, transport, push, maps, backup.                                                                 |
| `src/hooks/`      | Reusable hooks, incl. `useKeyboardLayout` — the app-wide keyboard-inset rule.                                                                                   |
| `src/theme/`      | The design system: obsidian `#07090D` surface, cobalt `#5B8DEF` accent, typography, spacing.                                                                    |
| `src/utils/`      | `alert.ts` (the app's own alert host), `datetime.ts` (UTC everywhere), `constants.ts`.                                                                          |
| `src/i18n/`       | Translation catalogues.                                                                                                                                         |

### B. The operator console — `apps/ops-console/`

Next.js 15.5.20 App Router. Covered in full in §1.7.

### What is deliberately _not_ frontend

`packages/messenger-core/` is imported **by** both frontends but contains no UI —
it is platform-agnostic crypto and wire types with no React dependency. Treat it
as a library, not a frontend module.

---

## 1.4 Backend / API code

Two independent NestJS 10 services. They do **not** import each other. They
communicate only through **Redis** (pub/sub and shared keys) and through a
**shared JWT signing secret**, so a token minted by `auth-service` verifies
inside `messenger-service` without a network call.

```
 ┌────────────────────────────────────┐                   ┌────────────────────────────────────┐
 │  apps/auth-service          :3001  │   Redis pub/sub   │  apps/messenger-service     :3100   │
 │  NestJS 10 · Express · pg · jose   │◀─────────────────▶│  NestJS 10 · socket.io · mediasoup  │
 │                                    │   push:events     │                                     │
 │  THE BUSINESS API                  │   dispatch:*      │  REAL-TIME + E2EE TRANSPORT         │
 │  auth · bookings · dispatch        │   jti:<jti>       │  relay · WS gateway · SFU           │
 │  missions · wallet/escrow · orgs   │                   │  file vault · FCM/APNs push         │
 │  departments · /ops/* console API  │                   │  encrypted backup mirror            │
 └──────────────┬─────────────────────┘                   └────────────────┬───────────────────┘
                │                                                          │
                ▼                                                          ▼
      PostgreSQL 17.6 (Supabase)                             Redis  +  S3-compatible object store
      103 tables · 150 migrations                            transient envelopes · presence · media
```

### `apps/auth-service` — the business API (393 files)

Port **3001**. Postgres is its database, accessed through the `pg` driver
directly — **there is no ORM**. Module directories under `src/`:

```
agents        attendance    auth          biometric     booking       common
compliance    config        conversations database      department    dispatch
events        family        incident      kafka         keys          notifications
observability ops           org           pro-applications             pro-management
protection    redis         sender-cert   settlement    sos           subscription
telemetry     totp          users         vbg           wallet
```

Notable: `ops/` is the entire operator-console API surface; `keys/` mints and
serves Signal prekey bundles; `sender-cert/` signs sealed-sender certificates;
`database/` contains the whole data-access layer in one file
(`database.service.ts`, ~120 lines).

Dependencies: `@nestjs/{common,core,config,platform-express,throttler}`, `pg`,
`ioredis`, `jose` (JWT), `argon2` (passwords), `otpauth` (TOTP), `twilio` (OTP
SMS), `class-validator` + `class-transformer` (DTO validation), `multer`
(uploads), `kafkajs` (audit event stream), `@privacyresearch/curve25519-typescript`
(XEd25519 sender-cert signing).

### `apps/messenger-service` — real-time and E2EE transport (120 files)

Port **3100**. Redis is its primary datastore; Postgres is reached only through
`@supabase/supabase-js` with the service-role key for the encrypted-backup
tables. Module directories under `src/`:

```
auth    backup    common    config    gateway    media
push    redis     relay     sfu       turn       users     vault
```

- `relay/` — transient encrypted envelopes. The relay only transports; dwell is
  capped at 30 days (`RELAY_DWELL_SECONDS=2592000`).
- `gateway/` — the socket.io WebSocket gateway: presence, typing, read receipts,
  call signalling. 37 `@SubscribeMessage` handlers.
- `sfu/` — mediasoup selective forwarding unit for group calls.
- `turn/` — issues time-limited coturn REST credentials.
- `vault/` — the file vault, behind a fresh biometric/TOTP MFA gate.
- `backup/` — the Merkle-committed encrypted message backup mirror.
- `push/` — Firebase Admin (FCM) and APNs VoIP wakes.

Dependencies: `@nestjs/{websockets,platform-socket.io,schedule}`,
`@socket.io/redis-adapter`, `socket.io`, `ioredis`, `mediasoup`,
`firebase-admin`, `@aws-sdk/client-s3` + `s3-request-presigner`,
`@supabase/supabase-js`, `helmet`, `jose`.

### Where the API contract lives

- REST specs: `docs/openapi/*.yaml`.
- Route inventory as of `b38e42ea`: **auth-service 49 controllers / 436 routes /
  44 named prefixes**; **messenger-service 8 controllers / 37 routes** plus 37
  WebSocket events.

---

## 1.5 iOS application code

**Read this section before attempting an iOS build — the layout is not the Expo
default and the difference has cost real time.**

### There is no `ios/` directory in the repository

`.gitignore` contains:

```
# Native build output
android/
ios/
```

`ios/` is **not present in the working tree at all** and **zero files under it
are tracked** (`git ls-files ios/` → 0). The Xcode project is _generated_ by
Expo's Continuous Native Generation:

```bash
npx expo prebuild --platform ios     # generates ios/ from app.json + plugins/
```

### Where the iOS-specific source actually lives

Because `ios/` is regenerated (and can be wiped by a prebuild), anything
hand-written must live outside it and be **injected** at prebuild time.

| Location                               | What it is                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `native/ios/BravoFrameCryptor.swift`   | Native SFrame frame-encryptor for group-call media.                                            |
| `native/ios/BravoFrameCryptor.m`       | Its Objective-C bridge.                                                                        |
| `plugins/withBravoFrameCryptor.js`     | Expo config plugin that copies the above into the generated Xcode project.                     |
| `plugins/withVoipCallKit.js`           | Expo config plugin that wires PushKit/CallKit (VoIP push, incoming-call UI).                   |
| `plugins/withIosBuildFixes.js`         | Expo config plugin applying build-settings fixes to the generated project.                     |
| `GoogleService-Info.plist` (repo root) | Firebase iOS config. Tracked — see §1.14 for why that is safe.                                 |
| `app.json` → `expo.ios`                | Bundle id, build number, entitlements, `UIBackgroundModes`, all `NS*UsageDescription` strings. |

From `app.json` at `b38e42ea`:

| Key                      | Value                                  |
| ------------------------ | -------------------------------------- |
| `ios.bundleIdentifier`   | `com.bravosecure.mobile`               |
| `ios.buildNumber`        | `163`                                  |
| `expo.version`           | `1.0.245`                              |
| `ios.supportsTablet`     | `false` (portrait phone only)          |
| `ios.entitlements`       | `aps-environment: production`          |
| `ios.googleServicesFile` | `./GoogleService-Info.plist`           |
| `UIBackgroundModes`      | `voip`, `audio`, `remote-notification` |

### The iOS release pipeline

`scripts/ios-release.sh` wraps archive → export → TestFlight upload. Its own
header documents the four traps it exists to prevent, all of which have bitten
this project:

1. `Info.plist` versions are **hardcoded**, not `$(MARKETING_VERSION)` — so
   `xcodebuild` command-line version overrides are silently ignored.
2. `ITSAppUsesNonExemptEncryption` in `Info.plist` triggers altool error **90592**
   because App Store Connect holds saved compliance docs expecting a paired code.
3. **CallKit wiring lives in the gitignored `ios/` tree and can vanish after a
   prebuild.** Shipping without it defeats the entire VoIP feature. The script
   guards for it.
4. `altool` can exit non-zero inside a wrapper that still reports `0` — **the log
   is the only trustworthy verdict.**

```bash
npm run ios:release            # version from app.json, build number derived from ASC
npm run ios:release:check      # run the guards only, no compile (fast)
npm run ios:release:noupload   # archive + export, skip TestFlight
npm run ios:status             # query App Store Connect for the latest build
```

Signing identity defaults baked into the script (override via env):

| Variable        | Default                                           |
| --------------- | ------------------------------------------------- |
| `TEAM_ID`       | `88X6H88A4R`                                      |
| `SIGN_IDENTITY` | `Apple Distribution: Michele Cioffi (88X6H88A4R)` |
| `PROFILE_NAME`  | `Bravo Secure App Store`                          |
| `BUNDLE_ID`     | `com.bravosecure.mobile`                          |
| `SCHEME`        | `BravoSecure`                                     |
| `ASC_KEY_ID`    | `S6379ZCA56`                                      |
| `ASC_ISSUER_ID` | `413b1e93-d5ea-46d2-85c0-838c6aebfba7`            |

The App Store Connect API private key is an `.p8` file. `.gitignore` blocks
`*.p8` and `AuthKey_*.p8` explicitly, with the reason stated inline: _"a single
one of these can send push to EVERY user of every app on the team, and Apple
only lets you download it once."_

Detailed iOS procedures: `docs/runbooks/IOS_BUILD.md`, `IOS_CALLKIT_VOIP.md`,
`IOS_README.md`.

---

## 1.6 Android application code

Same CNG model as iOS — `android/` is gitignored — **but with a deliberate
exception**: 21 files are force-added (`git add -f`) because they contain
hand-written native code and build configuration that a prebuild would otherwise
lose.

```
$ git ls-files android/            # 21 files
android/build.gradle
android/gradle.properties
android/app/build.gradle
android/app/google-services.json
android/app/src/main/AndroidManifest.xml
android/app/src/main/java/com/bravosecure/app/
    MainActivity.kt
    MainApplication.kt
    BravoBatteryOptimizationModule.kt   + Package.kt
    BravoCallForegroundModule.kt        + Package.kt
    CallForegroundService.kt
    BravoCallVolumeModule.kt            + Package.kt
    BravoFrameCryptorModule.kt          + Package.kt
    BravoRingtoneModule.kt              + Package.kt
android/app/src/main/res/drawable/ic_stat_bravo.xml
android/app/src/main/res/values/colors.xml
android/app/src/main/res/values/styles.xml
```

> **Operational rule:** because `android/` is in `.gitignore`, a plain `git add`
> will silently skip a new native file. Any new Kotlin module, manifest change or
> resource must be added with **`git add -f`** or it will not be committed and
> the next clone will not build the same app.

The five native modules are Kotlin and exist because no JS-side API covers them:

| Module                                                | Purpose                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `BravoCallForegroundModule` + `CallForegroundService` | Foreground service so a call survives backgrounding / Doze.               |
| `BravoFrameCryptorModule`                             | SFrame media frame encryption for group calls.                            |
| `BravoRingtoneModule`                                 | Ringtone/tone playback with the correct audio focus and stream.           |
| `BravoCallVolumeModule`                               | In-call volume and audio routing.                                         |
| `BravoBatteryOptimizationModule`                      | Battery-optimisation exemption prompt (required for reliable call wakes). |

### Identity and versioning

| Key             | Value / source                                            |
| --------------- | --------------------------------------------------------- |
| `applicationId` | `com.bravosecure.app` (`android/app/build.gradle:105`)    |
| `versionCode`   | `287`                                                     |
| `versionName`   | `1.0.245` (kept in step with `app.json` → `expo.version`) |
| SDK levels      | From `rootProject.ext` in `android/build.gradle`          |
| JDK             | **17** (Android Studio's bundled JBR is fine)             |

`npm run release` (`scripts/release-apk.ps1`) bumps **both** `app.json` and
`android/app/build.gradle` so the two never drift.

### Signing

`android/app/build.gradle` defines two signing configs:

- `debug` — the checked-in `debug.keystore` with the standard `android`/
  `androiddebugkey` credentials.
- `release` — populated **only** when `BRAVO_UPLOAD_STORE_FILE` (plus the
  matching password/alias properties) is supplied via `gradle.properties`,
  `~/.gradle`, a `-P` flag, or the environment.

If the upload key is absent, the release build **falls back to debug signing and
logs a loud warning**:

```
WARNING: release build is DEBUG-SIGNED (BRAVO_UPLOAD_STORE_FILE not set). Not shippable to Play.
```

This is intentional so local release builds still work, but it means **checking
the build log is the only way to know a release APK is actually shippable.** The
upload keystore is not in the repository and must be handed over separately.

### Distribution

- QA / internal: **Firebase App Distribution**, group `qa`, via `npm run apk:dist`
  or the full `npm run release` pipeline.
- Play Store: `eas.json` profile `production` builds an **app-bundle** (AAB) with
  `autoIncrement: true`.

---

## 1.7 Desk Console code

The Desk Console (referred to in the codebase as the **ops console**) is
`apps/ops-console/` — a Next.js 15.5.20 App Router application, 73 `.ts`/`.tsx`
files, 35 route pages. It runs on port **3002**.

```
apps/ops-console/
├── src/
│   ├── middleware.ts          ← edge session gate + per-request CSP nonce
│   ├── app/                   ← App Router; one directory per page
│   │   ├── layout.tsx  page.tsx  globals.css
│   │   ├── login/  accept-invite/          ← the only PUBLIC_PATHS
│   │   ├── dashboard/  live/  dispatch/  dispatch-inspector/
│   │   ├── bookings/  jobs/  protection/  sos/  incidents/
│   │   ├── agents/  users/  admins/  departments/  dept-attendance/
│   │   ├── pro-applications/  pro-management/  referral-codes/
│   │   ├── finance/  analytics/  audit/  compliance/
│   │   ├── messenger/  vbg/  settings/
│   ├── components/            ← BravoMap.tsx, BravoMapLazy.tsx, tables, forms
│   └── lib/                   ← fetchers, datetime, the IndexedDB crypto vault
├── package.json               ← its OWN dependency tree
├── tsconfig.json  tailwind.config  postcss.config
```

Stack: Next.js 15 + React 19, **SWR** for data fetching, **Tailwind** for
styling, **mapbox-gl** ^3.9.0 for the live map, **socket.io-client** for the
real-time feed, **idb** for the IndexedDB vault, and
`@privacyresearch/libsignal-protocol-typescript` — the console is a real E2EE
participant, not a plaintext observer.

### Session model (differs from mobile)

Mobile holds a bearer token in the keychain. The console uses an **httpOnly
cookie session with CSRF double-submit**. `src/middleware.ts` is an _edge_ gate:
it redirects to `/login` when the cookie is absent, injects a per-request CSP
nonce, and allowlists the Mapbox hosts (`api.mapbox.com`, `events.mapbox.com`,
`*.tiles.mapbox.com`). It **deliberately does not verify the JWT signature** —
that is the API's job; the middleware only decides whether to render a page or
bounce to login.

### Commands

```bash
cd apps/ops-console
npm install
npm run dev          # next dev --port 3002
npm run build        # next build   (a type error here FAILS the build)
npm start            # next start --port 3002
npm run lint         # next lint
npm run typecheck    # tsc --noEmit
```

---

## 1.8 Frameworks, libraries and programming languages

### Languages

| Language                | Where                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript**          | ~2,040 `.ts`/`.tsx` files across all five surfaces. The primary language.                                                                                                       |
| **Kotlin**              | 13 Android native files under `android/app/src/main/java/com/bravosecure/app/` (`MainActivity`, `MainApplication`, 5 native modules + their packages, `CallForegroundService`). |
| **Swift / Objective-C** | `native/ios/BravoFrameCryptor.swift` + `.m`.                                                                                                                                    |
| **SQL**                 | 150 migrations under `supabase/migrations/`, plus `seed.sql` and snippets.                                                                                                      |
| **JavaScript**          | Build/tooling config only — `babel.config.js`, `metro.config.js`, `index.js`, the three Expo plugins, `.mjs` scripts.                                                           |
| **Groovy**              | Gradle build files.                                                                                                                                                             |
| **PowerShell / Bash**   | `scripts/` — release, deploy, emulator, ADB, E2E harnesses.                                                                                                                     |
| **Python**              | One script: `scripts/ios-asc-latest-build.py` (App Store Connect query).                                                                                                        |

### Mobile — runtime frameworks and libraries

| Concern                  | Package(s)                                                                                                            | Version  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------- |
| Framework                | `react-native`                                                                                                        | 0.81.5   |
| Toolchain                | `expo`                                                                                                                | SDK 54   |
| UI runtime               | `react`                                                                                                               | 19.1.0   |
| Language                 | `typescript`                                                                                                          | ~5.9.2   |
| Navigation               | `@react-navigation/{native,native-stack,stack,bottom-tabs}`                                                           | 6.x      |
| State                    | `zustand` 5 · `immer`                                                                                                 | 5.0.3    |
| HTTP / WS                | `axios` 1.7 · `socket.io-client` 4.8                                                                                  |          |
| **Signal crypto**        | `@privacyresearch/libsignal-protocol-typescript`                                                                      | 0.0.16   |
| Hashing                  | `@noble/hashes`                                                                                                       | 2.2      |
| Native crypto            | `react-native-quick-crypto` · `react-native-argon2` · `react-native-get-random-values`                                |          |
| **Encrypted local DB**   | `@op-engineering/op-sqlite` with `"op-sqlite": {"sqlcipher": true}` in `package.json`                                 | 14.x     |
| Secret storage           | `react-native-keychain`                                                                                               | 9.2      |
| Fast KV                  | `react-native-mmkv`                                                                                                   | 3.2      |
| **WebRTC**               | `react-native-webrtc` → aliased to `npm:@livekit/react-native-webrtc@125.0.12`                                        | 125.0.12 |
| Group-call SFU client    | `mediasoup-client`                                                                                                    | 3.7      |
| Native call UI           | `react-native-callkeep` · `react-native-voip-push-notification` · `react-native-incall-manager`                       |          |
| Push / crash / analytics | `@react-native-firebase/{app,messaging,crashlytics,analytics,app-check}`                                              | 21.14    |
| Local notifications      | `@notifee/react-native`                                                                                               | 9.1      |
| Maps                     | `react-native-webview` (Mapbox GL JS runs **inside a WebView**)                                                       | 13.15    |
| Location                 | `react-native-geolocation-service`                                                                                    | 5.3      |
| Payments                 | `@stripe/stripe-react-native`                                                                                         | 0.50.3   |
| Biometrics               | `expo-local-authentication`                                                                                           |          |
| Face capture             | `@react-native-ml-kit/face-detection`                                                                                 | 2.0      |
| Backend-as-a-service     | `@supabase/supabase-js`                                                                                               | 2.47     |
| JWT (client-side)        | `jose`                                                                                                                | 5.10     |
| Animation / gestures     | `react-native-reanimated` 4.1 · `react-native-worklets` · `react-native-gesture-handler` 2.28                         |          |
| Media / files            | `expo-{camera,av,audio,video,image-picker,document-picker,file-system,image-manipulator,sharing}` · `react-native-fs` |          |
| Fonts / icons            | `@expo-google-fonts/manrope` · `@expo/vector-icons` · `react-native-vector-icons`                                     |          |

> **Two library facts worth knowing before you touch call code.**
> `react-native-webrtc` is an **alias** to LiveKit's fork — do not "fix" it back
> to the upstream package. And `react-native-agora` is present in
> `dependencies` but the production 1:1/group call path uses WebRTC + mediasoup;
> Agora is legacy surface area, not the live stack.

### Mobile — build/dev tooling

`@babel/*` 7.25 · `babel-preset-expo` 54 · `babel-plugin-module-resolver` (the
alias table) · `babel-plugin-transform-remove-console` · `@react-native/metro-config`
· `jest` 29.7 + `@testing-library/react-native` 13.2 · `eslint` 8.57 +
`@react-native/eslint-config` · `prettier` 3.4 · `husky` 9 + `lint-staged` 16 ·
`patch-package` 8 · `eas-cli` 18.7 · `cross-env` · `dotenv-cli` · `supabase` CLI.

### Backends

| Concern       | auth-service                                                            | messenger-service                                           |
| ------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| Framework     | NestJS 10 on `@nestjs/platform-express`                                 | NestJS 10 + `@nestjs/websockets` + `platform-socket.io`     |
| Language      | TypeScript ~5.7.3, Node ≥ 18                                            | TypeScript ~5.7.3, Node ≥ 18                                |
| Database      | `pg` (raw driver, **no ORM**)                                           | `@supabase/supabase-js` (service role, backup tables only)  |
| Cache / bus   | `ioredis`                                                               | `ioredis` + `@socket.io/redis-adapter`                      |
| Auth          | `jose` (HS256 JWT) · `argon2` · `otpauth` (TOTP) · `twilio` (OTP SMS)   | `jose` (verify only)                                        |
| Validation    | `class-validator` + `class-transformer`                                 | `class-validator` + `class-transformer`                     |
| Rate limiting | `@nestjs/throttler`                                                     | `@nestjs/throttler` + `helmet`                              |
| Media / SFU   | `multer` (uploads)                                                      | `mediasoup` · `@aws-sdk/client-s3` + `s3-request-presigner` |
| Push          | —                                                                       | `firebase-admin`                                            |
| Scheduling    | manual `setInterval` sweeps with Redis `SET NX` locks                   | `@nestjs/schedule`                                          |
| Audit stream  | `kafkajs`                                                               | —                                                           |
| Crypto        | `@privacyresearch/curve25519-typescript` (XEd25519 sender-cert signing) | —                                                           |
| Test          | `jest` + `ts-jest` (unit **and** an integration project)                | `jest` + `ts-jest` + `ioredis-mock`                         |

### Ops console

`next` 15.5.20 · `react` 19 + `react-dom` · `swr` · `tailwindcss` +
`autoprefixer` + `postcss` · `mapbox-gl` 3.9 · `socket.io-client` · `idb` ·
`buffer` · `@privacyresearch/libsignal-protocol-typescript` · `eslint-config-next`.

### Shared package — `packages/messenger-core`

Only two runtime dependencies:
`@privacyresearch/libsignal-protocol-typescript` and `@noble/hashes`. That
minimalism is deliberate — it must import cleanly into React Native, a browser,
and a Node Jest environment.

### Infrastructure

PostgreSQL 17.6 (Supabase-hosted) · Redis 7 · coturn 4.6 (TURN relay) ·
S3-compatible object storage (Cloudflare R2 in staging; MinIO locally) · Docker

- Docker Compose · systemd units in `infra/systemd/` · GitHub Actions.

---

## 1.9 Git branching strategy

### The rule

**`main` is the single long-lived branch and the source of truth.** Everything
else is a short-lived topic branch cut from `main` and merged back via pull
request. There is no `develop`, no `release/*` train, and no GitFlow.

```
                        ┌── feat/dept-chat-v2 ────────────┐
                        │                                 │
  main ─────●───────────●────●────────────●───────────────●──────●────▶  (protected)
            │                │            │                      │
            │                └── fix/calling-b419-b427 ──────────┘
            │
            └── release/1.0.35-audit-fixes  (a snapshot, not a train)
                                                             │
                                                             └─▶ mirror/main
                                                                (squashed snapshot,
                                                                 force-pushed)
```

### Branch naming

Enforced by convention, and visible across every branch in the repo:

| Prefix     | Meaning                                        | Live examples                                                                    |
| ---------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `feat/`    | New capability                                 | `feat/dept-chat-v2`, `feat/messenger-mentions-edit-delete`, `feat/auto-dispatch` |
| `fix/`     | Bug fix, usually tied to a `sqa.md` bug number | `fix/calling-b419-b427`, `fix/messenger-audit-b121`, `fix/slow-network-timeouts` |
| `wip/`     | Parked work, not ready                         | `wip/calling-b424-b429-parked`                                                   |
| `release/` | A pinned snapshot for a specific build         | `release/1.0.35-audit-fixes`                                                     |
| `ios/`     | Platform-scoped work                           | `ios/build-setup`                                                                |
| _(bare)_   | Occasional ad-hoc names                        | `b184-keyboard`                                                                  |

Branch names commonly embed the `sqa.md` bug identifier (`b121`, `b419-b427`),
which is how a branch is traced back to its bug report.

### Commit messages — enforced, not suggested

`.husky/commit-msg` blocks any commit whose first line does not match:

```
^(feat|fix|chore|docs|refactor|test|perf|build|ci|revert|wip)(\([a-z0-9._-]+\))?: .{1,80}$
```

Merge and revert commits are exempt. Real examples from `main`:

```
fix(files): B-607 r2 - make the move an actual move, not a second label
feat(pro): show the assigned vehicle + plate on the team screen (Issue 30, Layer 3)
feat(ops-console): Pro fleet + resources CRUD + assign UI (Issue 30, Layer 2)
```

### Protection on `main`

`scripts/setup-branch-protection.ps1` applies a GitHub **ruleset** (the rulesets
API, not classic branch protection — classic requires GitHub Pro on private
repos) to `omnidevxstudiobit/Bravo_Secure`:

- Pull request required — **no direct pushes to `main`**
- Branch must be up to date before merge (strict)
- Force pushes blocked (`non_fast_forward`)
- Branch deletion blocked
- These status checks must be green:

  `TypeScript` · `ESLint` · `Jest (app)` · `Jest (messenger-crypto)` ·
  `Jest (booking)` · `Secret Scan (gitleaks)` · `Bundle size budget` ·
  `Generate SBOM (CycloneDX)` · `OSV vulnerability scan`

Run it with an authenticated `gh` CLI:

```powershell
gh auth login
pwsh scripts/setup-branch-protection.ps1
```

### Code review routing

`.github/CODEOWNERS` auto-requests review by path. Every pattern currently
resolves to a single owner, `@ranak` — including the high-stakes paths called
out separately: `src/modules/messenger/{crypto,transport,runtime,push}/`,
`android/`, `ios/`, `app.json`, `eas.json`, `.github/`, `scripts/`,
`tsconfig.json`, `package.json`, `package-lock.json`, `src/theme/`,
`src/components/`, `apps/`, `supabase/`.

> The file's own header says _"Replace @ranak with your actual GitHub usernames
> as the team grows."_ Splitting these owners across the receiving team is a
> concrete handover action — see §1.17.

---

## 1.10 Development / Test / UAT / Production branches

**Stated plainly: this repository does not use per-environment branches.** There
is exactly one long-lived branch. Environments are selected by **build-time
configuration**, not by which branch you are on.

| Environment             | Branch           | How it is produced                                                                              | Endpoints                                                                                                |
| ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Local development**   | any topic branch | `npm run android` / `npm run ios`; services via `npm run start:dev`                             | `http://127.0.0.1:3001` · `http://127.0.0.1:3100` · Supabase at `127.0.0.1:54321`                        |
| **Staging / Test / QA** | `main`           | `npm run apk:staging` / EAS profile `preview-staging`; backends via `scripts/deploy-staging.sh` | `https://auth.94-136-184-52.sslip.io` · `https://relay.94-136-184-52.sslip.io` (Contabo `94.136.184.52`) |
| **UAT**                 | _(none)_         | **Does not exist as a separate tier.** UAT is performed on staging.                             | same as staging                                                                                          |
| **Production**          | `main`           | EAS profile `production` (AAB, `autoIncrement: true`)                                           | Not yet pointed at a distinct production backend — the profile inherits staging URLs unless overridden.  |

Where the environment is actually chosen:

1. **`eas.json` build profiles** — `preview-staging`, `preview-local`,
   `preview-staging-device`, `production`, `development`. Each carries its own
   `env` block of `EXPO_PUBLIC_*` values baked into the bundle at build time.
2. **npm script `cross-env` prefixes** — `apk:staging` vs `apk:local` differ only
   in the `EXPO_PUBLIC_API_BASE_URL` / `EXPO_PUBLIC_MSG_BASE_URL` they inject.
3. **`.env.*` files on the backends** — `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`,
   secrets. Never committed.
4. **EAS update channels** — `preview-staging`, `preview-local`, `production`.

> ⚠️ **The trap this has already caused.** A release build reads its endpoints
> from `.env.production` (loaded by `expo export:embed` during
> `gradlew assembleRelease`), **unless** a `cross-env` prefix already put the
> variable in `process.env` — `@expo/env` never overrides an existing process
> variable. So `npm run apk:staging` wins over the file, and a bare `gradlew`
> call falls back to the file. If neither supplies a value, **the wrong base URL
> is baked into the bundle** and the app silently talks to the wrong backend.
> Always build through the npm script, and **verify the baked URL** in the
> resulting artefact before shipping.
>
> `npm run android` bundles in _development_ mode and never reads
> `.env.production`, so local dev keeps using `.env` and `127.0.0.1`.

If the receiving team wants true Dev/Test/UAT/Prod separation, the change is to
add environment branches _plus_ matching EAS profiles and backend `.env` sets —
the profile mechanism already supports it; the branches and the second backend
box do not exist yet. Listed in §1.17.

---

## 1.11 Build process

### The three local quality gates (they run whether you want them or not)

```
  git commit ──▶ .husky/pre-commit
                 ├─ lint-staged   → ESLint --fix + Prettier on STAGED files only
                 └─ gitleaks protect --staged   → blocks leaked secrets
                    (skipped with a notice if gitleaks isn't installed; CI still runs it)
                 target: < 10 s

  git commit ──▶ .husky/commit-msg
                 └─ Conventional Commits regex on line 1

  git push   ──▶ .husky/pre-push
                 ├─ 1. tsc RATCHET   npx tsc --noEmit | grep -c "error TS"
                 │      compared against .tsc-baseline.json (currently 47).
                 │      MORE than baseline → push ABORTED.
                 │      FEWER → it tells you to lock the win in:  npm run tsc:rebaseline
                 ├─ 2. jest --changedSince=origin/main
                 └─ 3. static-scan sweep  (see the warning below)
```

> **Why the static-scan sweep is unconditional.** `--changedSince` selects a test
> only if that test _transitively imports_ the changed file. A scanner test reads
> its target with `readFileSync`, which creates **no module-graph edge**, so it is
> invisible to the selection — a `productionRuntime.ts`-only diff selects 37
> suites and **not one** of the five that exist to guard it. That is the hole bug
> B-106 shipped through. The hook therefore greps for `readFileSync` in test files
> and runs every match, chunked through `xargs -n 40` because 80+ suites blow past
> Windows' ~8 KB command-line limit (which once failed a push _with every test
> green_).

Bypass is `--no-verify` on either hook. **Do not** — the project rule is no
commits on a red gate.

### Manual gate commands

| Gate                | Command                                     | Notes                                                                     |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| Typecheck (mobile)  | `npm run typecheck`                         | Must not exceed `.tsc-baseline.json` (**47**).                            |
| Typecheck (console) | `cd apps/ops-console && npm run typecheck`  | Own baseline.                                                             |
| Typecheck (service) | `cd apps/auth-service && npm run typecheck` | Same in `messenger-service`.                                              |
| Lint                | `npm run lint` / `npm run lint:fix`         | `eslint . --ext .ts,.tsx`                                                 |
| Tests (all)         | `npm test`                                  | Runs all three Jest projects.                                             |
| Tests (crypto)      | `npm run test:crypto`                       | Fastest meaningful signal. **Run it twice** — known moving flake (B-126). |
| Tests (booking)     | `npm test -- --selectProjects=booking`      |                                                                           |
| Tests (changed)     | `npm run test:changed`                      | `--changedSince=origin/main`                                              |
| Coverage            | `npm run test:coverage`                     |                                                                           |
| Mutation (crypto)   | `npm run mutation:crypto`                   | Stryker; slow, weekly in CI.                                              |
| Flake detection     | `npm run flake:crypto`                      |                                                                           |
| Dead code           | `npm run deadcode`                          | knip                                                                      |
| Vulnerabilities     | `npm run audit:high`                        | `npm audit --audit-level=high --omit=dev`                                 |
| SBOM                | `npm run sbom`                              | CycloneDX JSON                                                            |
| Bundle size         | `npm run size`                              | size-limit                                                                |
| Fast CI bundle      | `npm run ci:local`                          | typecheck + lint + changed tests                                          |
| Full CI bundle      | `npm run ci:full`                           | typecheck + lint + all tests + deadcode                                   |

### The Jest project split (this trips people up)

`package.json` defines **three** Jest projects, each with a different
environment. A green run of one is not a green run of the suite.

| Project            | Environment           | Matches                                                                                                                                                                      |
| ------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`              | `react-native` preset | Everything under `src/` **except** the messenger crypto, booking and agent test dirs. Mounts RN screens.                                                                     |
| `messenger-crypto` | `node`                | `src/modules/messenger/__tests__/**` and `packages/messenger-core/__tests__/**`. React Native, op-sqlite, Firebase, argon2 and quick-crypto are all replaced by stubs/mocks. |
| `booking`          | `node`                | `src/screens/{booking,agent}/__tests__/**`                                                                                                                                   |

> **The messenger gate is BOTH projects.** The `messenger-crypto` project does
> _not_ include the screen render tests under `src/screens/messenger/__tests__/**`
> (they mount RN screens and only run in the `app` project). Touching
> `src/modules/messenger/**` or `src/screens/messenger/**` means running:
>
> ```bash
> npx jest --selectProjects messenger-crypto                       # twice — flake rule
> npx jest --selectProjects app --testPathPattern "screens/messenger"
> ```

The backends have their **own** Jest configs (`cd apps/auth-service && npm test`),
including an integration project that boots a real Postgres via testcontainers
(`npm run test:integration`).

### Mobile build

Expo **Continuous Native Generation** — `android/` and `ios/` are generated from
`app.json` + `plugins/`. Debug/dev builds:

```bash
npm start                 # Metro only
npm run android           # expo run:android
npm run ios               # expo run:ios
npm run start:staging     # Metro with staging URLs injected
npm run android:staging:hot   # dotenv -e .env.staging.local -- expo run:android
```

Release APK builds (note the `cross-env` prefix — see the §1.10 warning):

```bash
npm run apk:staging       # release APK pointed at the Contabo staging backend
npm run apk:local         # release APK pointed at 127.0.0.1
npm run apk:dist          # release + upload to Firebase App Distribution
npm run release           # THE full pipeline (below)
```

`npm run release` → `scripts/release-apk.ps1`:

```
pre-flight (typecheck regression + jest)
      ↓
version bump  (app.json  +  android/app/build.gradle — kept in step)
      ↓
gradlew assembleRelease appDistributionUploadRelease
      ↓
Firebase App Distribution → tester emails go out
```

```powershell
npm run release                       # auto-bump patch, full pipeline
npm run release -- -Version 1.0.20    # explicit version
npm run release -- -SkipUpload        # build only
npm run release -- -SkipBuild         # bump versions only
npm run release -- -Force             # skip the typecheck/jest pre-flight
```

Requires `FIREBASE_SERVICE_ACCOUNT` pointing at a Firebase Admin SDK
service-account JSON.

Cloud builds via EAS:

```bash
npm run eas:build:staging       # android, profile preview-staging
npm run eas:build:local         # android, profile preview-local
npm run eas:build:ios:staging   # ios simulator build
npm run eas:build:ios:device    # ios device build
npm run eas:builds              # list recent builds
```

`babel.config.js` applies `transform-remove-console` **only in the `production`
Babel env**, and it excludes `error` and `warn` — so `console.warn` survives a
release build. That is deliberate: it is what makes on-device performance
probes (`[LAGDIAG]`) and Crashlytics breadcrumbs work in the only build worth
measuring.

### Backend build

Both services build the same way:

```bash
cd apps/auth-service        # or apps/messenger-service
npm install
npm run start:dev           # nest start --watch
npm run build               # nest build  → dist/
npm start                   # node dist/main
npm run typecheck           # tsc -p tsconfig.json --noEmit
npm test
```

### Ops console build

`next build` runs the TypeScript compiler with `ignoreBuildErrors: false`, so a
type error is a build failure. This is load-bearing for the deploy — see below.

### Deployment build (staging)

`scripts/deploy-staging.sh` is the proven manual flow, scripted:

```
rsync each service's source → admin@94.136.184.52:/home/admin/bravo
      ↓
docker compose -f docker-compose.staging.yml build <svc>
      ↓
docker compose up -d <svc>
      ↓
verify the container is healthy
```

The Docker build runs each service's own typecheck/build, **so a broken commit
fails the build and the previous container keeps running — the build gates the
deploy.**

```bash
SSH_KEY=~/.ssh/bravo-staging.pem scripts/deploy-staging.sh ops-console
scripts/deploy-staging.sh auth-service ops-console
scripts/deploy-staging.sh all
```

Overridable env: `BOX_HOST` (default `94.136.184.52`), `BOX_USER` (`admin`),
`BOX_DIR` (`/home/admin/bravo`), `SSH_KEY`, `COMPOSE`
(`docker-compose.staging.yml`).

> ⚠️ **`rsync --delete` is used.** `main` is the source of truth: any file that
> exists on the box but not in the checkout is **removed**. A server-side hotfix
> that is not committed to `main` will be silently destroyed by the next deploy.
> `.env*` and build artefacts are excluded from the sync, so server env files
> survive.
>
> ⚠️ **`rsync` is not present in Git Bash on Windows**, which is where this repo
> is normally developed. The script has a tool preflight that says so rather than
> failing halfway.

### CI — 12 GitHub Actions workflows

| Workflow                | Trigger                                           | What it does                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                | push + PR on `main`                               | The main gate: TypeScript · ESLint · Jest matrix (app, messenger-crypto, booking) · Jest (auth-service) · Integration (auth-service, real Postgres via testcontainers) · Dead Code (knip) · Secret Scan (gitleaks) · Dependency Review · npm audit |
| `deploy-staging.yml`    | push to `main` touching `apps/**` + manual        | Runs `scripts/deploy-staging.sh` against Contabo.                                                                                                                                                                                                  |
| `deploy-migrations.yml` | push to `main` touching `supabase/migrations/**`  | Applies Supabase migrations. Concurrency-limited to one in-flight apply.                                                                                                                                                                           |
| `build-mobile.yml`      | push to `main` touching `src/**` + manual         | EAS build; profile selectable on manual dispatch.                                                                                                                                                                                                  |
| `mirror-to-client.yml`  | push to `main`                                    | Publishes the stripped snapshot to the client repo (§1.1).                                                                                                                                                                                         |
| `supply-chain.yml`      | push, PR, daily 05:00 UTC                         | CycloneDX SBOM + OSV vulnerability scan.                                                                                                                                                                                                           |
| `bundle-size.yml`       | PR + push on `main`                               | Bundle size budget.                                                                                                                                                                                                                                |
| `mutation.yml`          | weekly Mon 04:00 UTC, PRs touching crypto, manual | Stryker mutation testing on the crypto package.                                                                                                                                                                                                    |
| `flake-watch.yml`       | daily 03:00 UTC                                   | Repeated crypto-suite runs to track the known flake.                                                                                                                                                                                               |
| `pr-analysis.yml`       | PR opened/synchronised                            | Risk scoring (`scripts/pr-risk-score.mjs`).                                                                                                                                                                                                        |
| `labeler.yml`           | `pull_request_target`                             | Path-based PR labels.                                                                                                                                                                                                                              |
| `static.yml`            | push to `main`                                    | GitHub Pages deploy of static content.                                                                                                                                                                                                             |

> **Current operating reality (flagged, not hidden):** GitHub Actions has been
> **unavailable on this account due to billing**, so staging deploys have been
> performed **manually over SSH** using the same `scripts/deploy-staging.sh`
> mechanism (and, when `rsync` was unavailable, a `git archive` → `tar` overlay).
> The workflows above are correct and will resume working once Actions billing is
> restored; until then, treat the branch-protection required-checks list as
> aspirational and run `npm run ci:full` locally before merging. Listed in §1.17.

---

## 1.12 Dependency / package management

### npm, with four independent lockfile scopes

There are **no npm workspaces**. `npm install` at the root does _not_ install the
backends.

| Scope                     | Install command                            | Installs                       |
| ------------------------- | ------------------------------------------ | ------------------------------ |
| Mobile (root)             | `npm install`                              | RN, Expo, all native modules   |
| Auth service              | `cd apps/auth-service && npm install`      | NestJS + `pg` + `ioredis`      |
| Messenger service         | `cd apps/messenger-service && npm install` | NestJS + socket.io + mediasoup |
| Ops console               | `cd apps/ops-console && npm install`       | Next.js + SWR + mapbox-gl      |
| `packages/messenger-core` | **none** — consumed via path alias         | (its two deps come from root)  |

`package-lock.json` is committed at the root and in each app. Node **≥ 18** is
declared in root `engines`; the README asks for **≥ 20** in practice, and JDK
**17** for Android.

### `postinstall` runs patch-package — this is load-bearing

```json
"postinstall": "patch-package"
```

Ten patches under `patches/` are re-applied on every install. Skipping
`postinstall` (or running with `--ignore-scripts`) produces a tree that compiles
but misbehaves at runtime:

| Patch                                      | Package being fixed      |
| ------------------------------------------ | ------------------------ |
| `react-native+0.81.5.patch`                | React Native core        |
| `react-native-webrtc+125.0.12.patch`       | The LiveKit WebRTC fork  |
| `react-native-callkeep+4.3.16.patch`       | Native call UI           |
| `react-native-incall-manager+4.2.1.patch`  | In-call audio routing    |
| `react-native-quick-crypto+0.7.17.patch`   | Native crypto            |
| `react-native-argon2+4.0.0.patch`          | Argon2 KDF               |
| `@op-engineering+op-sqlite+14.1.4.patch`   | SQLCipher-enabled SQLite |
| `@stripe+stripe-react-native+0.50.3.patch` | Payments                 |
| `expo-constants+18.0.13.patch`             | Expo constants           |
| `whatwg-fetch+3.6.20.patch`                | Fetch polyfill           |

To change one: edit inside `node_modules/<pkg>`, then
`npx patch-package <pkg>`, then commit the regenerated `.patch`.

### Version pinning conventions

- Expo-managed native modules use `~` (e.g. `expo-camera: ~17.0.10`) so
  `npx expo install --check` can hold them at the SDK-54-compatible versions.
  **Use `npx expo install <pkg>`, not `npm install <pkg>`, for anything Expo
  manages** — a plain `npm install` will pull a version the SDK does not support.
- Exact pins where drift has caused breakage: `react: 19.1.0`,
  `react-native: 0.81.5`, `react-native-svg: 15.12.1`,
  `react-native-webview: 13.15.0`, `@stripe/stripe-react-native: 0.50.3`,
  `react-native-worklets: 0.5.1`, `@react-native-firebase/app-check: 21.14.0`.
- `overrides: { "tar": "^7.5.20" }` forces a transitive security fix.
- `react-native` is an **alias**:
  `"react-native-webrtc": "npm:@livekit/react-native-webrtc@125.0.12"`.

### Supply-chain controls

| Control           | Where                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Vulnerabilities   | `npm run audit:high` locally; `npm audit` + **OSV scan** in CI daily.  |
| SBOM              | `npm run sbom` → CycloneDX JSON; generated in CI (`supply-chain.yml`). |
| Dependency review | `ci.yml` job `deps` reviews dependency changes on PRs.                 |
| Dead code         | `npm run deadcode` (knip, config in `knip.json`).                      |
| Bundle budget     | `npm run size` (size-limit) + the `bundle-size.yml` workflow.          |

### Module resolution gotcha worth knowing

`metro.config.js` enables `unstable_enablePackageExports` and forces the
condition order `['react-native', 'browser', 'require']`. This exists because
packages with separate Node/browser builds resolve to the **Node** build by
default, which imports `node:buffer` and crashes the RN bundler. The file's
comment names `jose` as the historical example and explicitly warns: **do not
remove the override on the strength of that example being stale** — other
transitive packages now rely on browser-condition resolution.

---

## 1.13 Environment configuration

### The layout

Nothing with a real value is committed. Every `.env` file in the tree is
gitignored; every `.env.example` is committed as the template.

| Path                                     | Committed? | Purpose                                                                                                                                                                                                                                 |
| ---------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.example`                           | ✅ yes     | Root template — mobile + shared server values, heavily commented.                                                                                                                                                                       |
| `.env`                                   | ❌ no      | Local mobile/dev values.                                                                                                                                                                                                                |
| `.env.staging` / `.env.staging.local`    | ❌ no      | Staging endpoint overrides for `npm run *:staging:hot`.                                                                                                                                                                                 |
| `.env.staging.local.example`             | ✅ yes     | Template for the above.                                                                                                                                                                                                                 |
| `.env.production`                        | ✅ **yes** | **Deliberately committed.** `EXPO_PUBLIC_*` (client-public) values only — endpoints, the Supabase anon key, the Mapbox token, and two feature flags. Loaded by `expo export:embed` during `gradlew assembleRelease`. See the box below. |
| `.env.contabo`                           | ❌ no      | Contabo staging box values.                                                                                                                                                                                                             |
| `apps/auth-service/.env.example`         | ✅ yes     | auth-service template with working dev-bypass defaults.                                                                                                                                                                                 |
| `apps/auth-service/.env`                 | ❌ no      | Real auth-service values.                                                                                                                                                                                                               |
| `apps/messenger-service/.env{,.example}` | example ✅ | messenger-service.                                                                                                                                                                                                                      |
| `apps/ops-console/.env.local{,.example}` | example ✅ | Console.                                                                                                                                                                                                                                |
| `infra/env/auth.env.example`             | ✅ yes     | Server-side (systemd/docker) template.                                                                                                                                                                                                  |
| `infra/env/messenger.env.example`        | ✅ yes     | Server-side template.                                                                                                                                                                                                                   |
| `ENV_SETUP.md`                           | ❌ no      | **The out-of-band developer handoff doc containing real secrets.**                                                                                                                                                                      |

> ⚠️ **`.env.production` and the `apk:staging` script must stay in lockstep
> (bug B-51).** Feature flags were once set **only** inline in the `apk:staging`
> npm script. The Firebase release pipeline (`release-apk.ps1` / a bare
> `gradlew`) bakes `.env.production` instead — so **v1.0.100 shipped with
> `EXPO_PUBLIC_AUTO_DISPATCH` and `EXPO_PUBLIC_DEPT_CHAT_V2` silently OFF** and
> the Departmental card vanished for providers. Any flag added to one must be
> added to the other. Both files carry the warning inline.

### The prefix rule — the most important thing in this section

> **`EXPO_PUBLIC_*` values are compiled into the JavaScript bundle and are
> readable by anyone with the APK.** A secret must never carry that prefix.

The same applies to `NEXT_PUBLIC_*` in the ops console. The root `.env.example`
states the rule inline next to the Twilio block: _"server-only — never prefixed
`EXPO_PUBLIC_`"_.

28 `EXPO_PUBLIC_*` variables are read by mobile source at `b38e42ea`. Grouped:

| Group              | Variables                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoints          | `API_BASE_URL`, `MSG_BASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`                                                                                                 |
| Public API keys    | `MAPBOX_TOKEN`, `GOOGLE_MAPS_API_KEY`, `STRIPE_PUBLISHABLE_KEY`, `AGORA_APP_ID`, `GUARDIAN_API_KEY`, `RSS2JSON_KEY`, `SENTRY_DSN`                                   |
| Crypto public half | `SENDER_CERT_PUBLIC_KEY_B64`                                                                                                                                        |
| Feature flags      | `AUTO_DISPATCH`, `DEPT_CHAT_V2`, `MULTI_DEVICE`, `P01_PROOF_OF_LIFE`, `P01_PROTECTED_WINDOW_MS`, `RESEND_PROTOCOL`, `OUTER_WIRE_V2`                                 |
| Security switches  | `STRICT_IDENTITY_TRUST`, `STRICT_IDENTITY_SEND_GATE`, `ALLOW_UNSIGNED_CALL_OFFER`, `SEALED_AAD_LEGACY`, `VOIP_WAKE_LEGACY`, `DTLS_PIN_LEGACY`, `DTLS_CIPHER_LEGACY` |
| Diagnostics        | `ICE_RELAY_ONLY`, `GROUPCALL_FILELOG`                                                                                                                               |

> ⚠️ The `*_LEGACY` and `ALLOW_UNSIGNED_*` flags relax security checks for
> backward compatibility during a rollout. **They must be off in any shipped
> build.** Treat any of them being true in a release config as a release blocker.

### Backend configuration

Both services read config through NestJS `ConfigService`, backed by a
`src/config/configuration.ts` module. Each reads ~15 distinct `process.env`
keys. `apps/auth-service/src/config/` also carries `configuration.spec.ts`,
`jwtSecret.spec.ts` and `platform-accounts.spec.ts` — the configuration itself is
unit-tested, including that the JWT secret is not a default.

Selected auth-service keys with their meaning:

| Variable                                  | Default in template      | Meaning                                                                                |
| ----------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `PORT` / `NODE_ENV`                       | `3001` / `development`   |                                                                                        |
| `DATABASE_URL`                            | local Supabase Postgres  | `postgresql://…:54322/postgres`                                                        |
| `REDIS_URL`                               | `redis://127.0.0.1:7379` | **Windows note:** Hyper-V reserves 6379, so dev uses **7379**.                         |
| `JWT_ACCESS_SECRET` / `JWT_ACTION_SECRET` | dev placeholders         | HS256 signing secrets.                                                                 |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL`      | `15m` / `30d`            |                                                                                        |
| `OTP_DEV_RETURN_CODE`                     | `true`                   | **Returns the OTP in the API response. NEVER true in prod.**                           |
| `BIOMETRIC_DEV_BYPASS`                    | `true`                   | **Skips the biometric step-up. NEVER true in prod.**                                   |
| `TOTP_ENCRYPTION_KEY`                     | 64 hex chars             | AES-256 key for TOTP secrets. Template says _"Production: load from HashiCorp Vault."_ |
| `SENDER_CERT_PRIVATE_KEY_B64`             | _(blank)_                | XEd25519 private half that signs sealed-sender certs.                                  |
| `RATE_LIMIT_AUTH_PER_HOUR`                | `5`                      |                                                                                        |
| `DEPT_CHAT_V2_ENABLED`                    | `false`                  | Dark-launch flag; pair with `EXPO_PUBLIC_DEPT_CHAT_V2`.                                |

Selected messenger-service keys:

| Variable                                                     | Value / meaning                                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`                                          | **MUST match auth-service's.** Tokens are verified cross-service without a call. |
| `WS_PATH` / `WS_HEARTBEAT_MS`                                | `/ws` · `30000`                                                                  |
| `WS_HEARTBEAT_GRACE`                                         | `25000` — **must stay ≥ 25000** (see the warning below)                          |
| `RELAY_DWELL_SECONDS`                                        | `2592000` (30 days — the Signal-protocol default and the documented relay cap)   |
| `RELAY_MAX_PULL_LIMIT` / `RELAY_MAX_CIPHERTEXT_BYTES`        | `100` · `262144`                                                                 |
| `VAULT_PRESIGN_TTL_SECONDS`                                  | `60`                                                                             |
| `VAULT_MFA_MAX_AGE_SEC`                                      | `300` — how fresh the biometric/TOTP proof must be                               |
| `VAULT_MFA_PURPOSES`                                         | `vault-access,biometric-verified,totp-verified`                                  |
| `TURN_STATIC_AUTH_SECRET` / `TURN_URLS` / `TURN_TTL_SECONDS` | Must match coturn's `static-auth-secret`. Ship **both** UDP and TCP transports.  |
| `TURN_STUN_URLS`                                             | `stun:stun.l.google.com:19302`                                                   |
| `SENDER_CERT_TTL_SECONDS`                                    | `86400` (24 h)                                                                   |
| `MEDIA_S3_*`                                                 | R2/S3 endpoint, bucket, region, credentials, presign TTL, 50 MB max upload       |
| `SUPABASE_SERVICE_ROLE_KEY`                                  | **Bypasses RLS.** Server-only, never in a client bundle.                         |
| `BACKUP_MAX_FAILED_ATTEMPTS` / `BACKUP_LOCKOUT_SECONDS`      | `5` · `3600` — matches WhatsApp's HSM-backed throttle                            |

> ⚠️ **`WS_HEARTBEAT_GRACE` (bug B-05).** This feeds socket.io's `pingTimeout`.
> At `10000` a late pong under Contabo/TURN latency spikes reaped the socket and
> **kicked every participant of a live call at once**. The code default is
> `25000`; an older version of the `.env.example` shipped `10000` and would
> silently re-introduce the bug on any deploy that copied it verbatim. The
> template now carries the warning inline. Do not lower it.

### Local infrastructure

`docker-compose.yml` at the root brings up the pieces a laptop needs:

| Service             | Notes                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redis`             | `redis:7-alpine`, port 6379, persistence disabled, health-checked.                                                                                 |
| `messenger-service` | Built from `apps/messenger-service/Dockerfile`, port 3100, depends on healthy Redis.                                                               |
| `coturn`            | `coturn/coturn:4.6` on **host network** — bridged networking would make the relay advertise an unreachable container IP. Ports 3478 + 49160–49200. |

Postgres is **not** in this compose file — local Postgres comes from
`npx supabase start` (API 54321, DB 54322).

---

## 1.14 Secrets and API key management

### The model

1. **No _private_ value is committed.** `.gitignore` blocks `.env`,
   `.env.local`, `.env.staging`, `.env.*.local`, `.env.contabo`,
   `apps/**/.env*`, every `*.pem`/`*.key`/`*.p12`/`*.p8`,
   `*firebase-adminsdk*.json`, `firebase-service-account.json`, and
   `ENV_SETUP.md` itself. The one committed env file, `.env.production`, is
   `EXPO_PUBLIC_*`-only by construction — those values are compiled into the APK
   anyway, so committing them leaks nothing that shipping the app does not.
2. **Templates are committed** with placeholder values and inline instructions
   for generating the real ones.
3. **Real values are handed over out of band** in `ENV_SETUP.md`, which is
   gitignored and carries its own banner:

   > ⚠️ **THIS FILE CONTAINS SECRETS. DO NOT COMMIT IT. DO NOT PUSH IT TO ANY
   > REMOTE.** … Share it only over a secure channel (encrypted DM, password
   > manager, secrets vault) — never paste it into a public chat, issue, or PR.
   > Several values below are flagged for **rotation** — rotate them after handover.

4. **On the server**, secrets live outside the checkout: `.env*` is excluded from
   the deploy rsync, the Firebase service account sits at
   `/home/ubuntu/bravo/firebase-service-account.json` and is mounted into the
   container, and the APNs `.p8` is referenced by `APNS_VOIP_KEY_PATH`.
5. **Two automated scanners** enforce it: `gitleaks protect --staged` in the
   pre-commit hook, and the `Secret Scan (gitleaks)` job in `ci.yml` (a required
   status check on `main`).

### Untracked secret material currently sitting in the working directory

These are **correctly gitignored and not in Git history** — verified with
`git ls-files --error-unmatch` on each — but they are present on the development
machine and are part of what must be handed over (or rotated):

| File                                         | What it is                                         |
| -------------------------------------------- | -------------------------------------------------- |
| `AuthKey_B9U74KX24U.p8`                      | APNs auth key — can push to every app on the team. |
| `bravo-734da-firebase-adminsdk-fbsvc-*.json` | Firebase Admin service account.                    |
| `Staging.pem`, `Staging (2).pem`             | SSH private keys for the staging box.              |
| `Aws creds`                                  | AWS credentials.                                   |

### What _is_ committed, and why that is intentional

`.gitleaks.toml` maintains a **path-scoped** allowlist — the same patterns are
still scanned everywhere else in the repo. Its own header gives the reasoning:

| Allowlisted                                                    | Reason                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `android/app/google-services.json`, `GoogleService-Info.plist` | Firebase ships **per-project public API keys**. Google documents these as safe to distribute; real protection is SHA-1 fingerprint + package-name restrictions in GCP.                                                                                                                                                                                                                                                         |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` in `package.json` + `eas.json` | Supabase anon keys are **public by design** — RLS policies enforce row access. The dangerous `SERVICE_ROLE` key never appears in client code.                                                                                                                                                                                                                                                                                  |
| `.env.example` placeholder values                              | Empty by convention.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `.env.production`                                              | `EXPO_PUBLIC_*`-only; the same public values already baked into every shipped APK. **Note: this path is _not_ in the gitleaks allowlist** — nor is the root-level `GoogleService-Info.plist` (the allowlist pattern is `ios/.*GoogleService-Info\.plist`, but the file lives at the repo root). Neither has tripped the scan to date; tighten or extend the allowlist deliberately rather than discovering it on a red CI run. |
| `docs/openapi/*.yaml`                                          | Request/response examples use placeholder tokens.                                                                                                                                                                                                                                                                                                                                                                              |

### Two things a reviewer will notice — stated honestly

**(a) A live Mapbox public token is committed** in `package.json` scripts and in
four `eas.json` profiles: `pk.<mapbox-public-token>…`. It is a `pk.`
(publishable) token, so this is not a private-key leak — but a publishable
Mapbox token is metered and billable, and this one is **not URL-restricted**
because it is consumed by a WebView and by native builds rather than a fixed web
origin. Recommended handover actions: apply URL/scope restrictions in the Mapbox
account where possible, set a usage alert, and rotate it as part of the ownership
transfer.

**(b) The templates ship dev bypasses set to `true`** —
`OTP_DEV_RETURN_CODE=true` (returns the OTP in the API response) and
`BIOMETRIC_DEV_BYPASS=true` (skips biometric step-up). Both are commented
_"NEVER true in prod"_. Verify both are `false` in every non-local environment
before go-live; they are the two settings that most obviously convert a working
system into an open one.

### Secrets held in GitHub

| Secret                              | Used by                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `MIRROR_TOKEN`                      | `mirror-to-client.yml` — PAT with write access to the client repo. |
| Contabo `BOX_*` + SSH key           | `deploy-staging.yml`.                                              |
| Supabase access token / project ref | `deploy-migrations.yml`.                                           |
| EAS / Expo token                    | `build-mobile.yml`.                                                |

### Key-generation recipes are in the templates

Rather than describing them abstractly, the templates carry runnable one-liners —
e.g. the sealed-sender XEd25519 keypair generator in both `.env.example` files,
which prints the base64 private half (→ `SENDER_CERT_PRIVATE_KEY_B64` on
auth-service) and public half (→ `EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64` for
mobile and `NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64` for the console). Rotation
procedure: `docs/runbooks/KEY_ROTATION_RUNBOOK.md`.

---

## 1.15 Repository owners and access permissions

### Ownership as configured today

| Layer                       | Current state                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| GitHub org / repo owner     | `omnidevxstudiobit` org, repository `Bravo_Secure`.                                                    |
| Code review routing         | `.github/CODEOWNERS` — **every path maps to `@ranak`**, including all high-stakes paths.               |
| Branch protection           | Ruleset `main-protection` (see §1.9): PR required, force-push and deletion blocked, 9 required checks. |
| Required approving reviews  | **`required_approving_review_count = 0`** — a PR is required, but an approval is not.                  |
| Commit authorship on `main` | `Ranak <piyaldeb87@gmail.com>`                                                                         |
| Client mirror               | `digital7rdr/bravosecure-app` — receives a squashed snapshot; the client has no push path back.        |

### Access that is _not_ GitHub

Handing over the repository is not the same as handing over the system. These are
separate grants, each with its own owner:

| System                               | What it controls                            | Evidence in-repo                                                                                  |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Supabase** project                 | Production Postgres, storage, RLS policies  | `supabase/config.toml`, project ref `qkkfkicgoncxslbwhyhz`                                        |
| **Contabo** staging box              | Both backends + console + Redis + coturn    | `94.136.184.52`, user `admin`, dir `/home/admin/bravo`                                            |
| **Firebase** (project `bravo-734da`) | FCM push, Crashlytics, App Distribution     | `google-services.json`, `GoogleService-Info.plist`                                                |
| **Google Play Console**              | Android release, upload key                 | `applicationId com.bravosecure.app`                                                               |
| **Apple Developer / ASC**            | iOS signing, TestFlight, App Store          | Team `88X6H88A4R`, identity _Apple Distribution: Michele Cioffi_, bundle `com.bravosecure.mobile` |
| **Mapbox**                           | Map tiles, Directions, Geocoding — billable | `EXPO_PUBLIC_MAPBOX_TOKEN`                                                                        |
| **Twilio**                           | OTP SMS / Verify                            | `TWILIO_*`                                                                                        |
| **Stripe**                           | Payments                                    | `STRIPE_SECRET_KEY`, `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`                                         |
| **Cloudflare R2 / S3**               | Encrypted media object storage              | `MEDIA_S3_*`                                                                                      |

> **A note on the Apple signing identity.** The distribution certificate is
> issued to _Michele Cioffi_ under team `88X6H88A4R`. Confirm during handover
> whether that Apple Developer account transfers with the project or whether the
> receiving team must re-provision under their own team — the latter changes the
> bundle's signing identity and requires new provisioning profiles.

### Recommended handover actions

1. Split `CODEOWNERS` across the receiving team, at minimum separating crypto/
   transport/runtime from general application code.
2. Raise `required_approving_review_count` from `0` to `1` once there is more than
   one reviewer.
3. Transfer or re-grant each third-party account above, and rotate every
   credential flagged in `ENV_SETUP.md`.
4. Decide whether the client mirror should continue, and if so whether `sqa.md`
   and `docs/{handoffs,qa,audits}` should be stripped (§1.1).

---

## 1.16 Required demonstration — clone, configure and run

> **Target: clone → running on a phone in about 15 minutes of hands-on time**
> (plus a one-off 5–18 minute native build). This is the README's documented
> quick-start, restated here in full so §1 stands alone.

### Step 0 — one-time machine prerequisites

| Tool                   | Version                                       | Check                         |
| ---------------------- | --------------------------------------------- | ----------------------------- |
| Node.js                | ≥ 20.x                                        | `node --version`              |
| npm                    | ≥ 10.x (ships with Node 20)                   | `npm --version`               |
| Docker Desktop         | current, **running**                          | `docker --version`            |
| Redis                  | ≥ 7.x                                         | `redis-cli --version`         |
| Android Studio         | Hedgehog+                                     | installs SDK + platform-tools |
| JDK                    | **17** (Android Studio's bundled JBR is fine) | `java -version`               |
| Git                    | any                                           | `git --version`               |
| Xcode (macOS, for iOS) | current                                       | `xcodebuild -version`         |

Machine environment variables:

```powershell
# Windows (PowerShell)
setx ANDROID_HOME "C:\Users\<you>\AppData\Local\Android\Sdk"
setx JAVA_HOME "C:\Program Files\Android\Android Studio\jbr"
# Add to PATH:  %ANDROID_HOME%\platform-tools   and   %ANDROID_HOME%\emulator
# Restart the terminal after setx.
```

```bash
# macOS / Linux — append to ~/.zshrc or ~/.bashrc
export ANDROID_HOME="$HOME/Library/Android/sdk"          # ~/Android/Sdk on Linux
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
```

### Step 1 — clone and install (four installs, not one)

```bash
git clone https://github.com/omnidevxstudiobit/Bravo_Secure.git bravo-secure
cd bravo-secure

npm install                                            # mobile — runs patch-package
cd apps/auth-service      && npm install && cd ../..
cd apps/messenger-service && npm install && cd ../..
cd apps/ops-console       && npm install && cd ../..   # only if you need the console
```

`npm install` at the root triggers `postinstall` → `patch-package`, applying all
10 patches. **If you see patch errors, stop and fix them** — the app will build
without them and then misbehave at runtime.

### Step 2 — configure environment

```bash
cp .env.example .env
# Fill in Twilio / Stripe / Maps keys only if you need those features.
# Dev mode works without them.
```

`apps/auth-service/.env` and `apps/messenger-service/.env` ship working
**dev-bypass** defaults: OTP accepts any 6 digits and the biometric step-up is
skipped. For real staging or production values, use the out-of-band
`ENV_SETUP.md`.

### Step 3 — start the infrastructure (four terminals, left running)

```bash
# Terminal 1 — Supabase (Postgres + Auth + Storage)
npx supabase start
#   First run pulls ~2 GB of Docker images. Later runs: ~15 s. Needs Docker running.

# Terminal 2 — Redis
"C:\Program Files\Redis\redis-server.exe" --port 6379     # Windows
redis-server --port 6379                                   # macOS / Linux

# Terminal 3 — auth-service
cd apps/auth-service && npm run start:dev                  # :3001

# Terminal 4 — messenger-service
cd apps/messenger-service && npm run start:dev             # :3100 (REST + WS at /ws)
```

Verify all four:

```bash
curl http://127.0.0.1:3001/auth/health                                     # {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/envelopes   # 401 — expected
redis-cli -p 6379 ping                                                     # PONG
npx supabase status                                                        # API URL, DB URL, anon key
```

> **Windows note:** Hyper-V reserves port 6379. `apps/auth-service/.env.example`
> therefore defaults `REDIS_URL` to **7379**. Either start Redis on 7379 or
> change the env — but keep the two consistent.

### Step 4 — seed dev users (recommended)

```bash
node scripts/seed-dev-users.mjs
```

Creates Alice / Bob / Carol so the messenger has people to talk to. The three
printed UUIDs are already hardcoded in `src/modules/messenger/dev/devContacts.ts`.

### Step 5 — build and install on a device

```bash
# A — Android emulator
#   Android Studio → Device Manager → create a Pixel 6 (Android 14+), launch it
adb devices                  # emulator-5554 device
npx expo run:android         # first build 5–18 min; incremental ~30 s

# B — physical Android over USB
#   Phone: Settings → About → tap Build number 7× → Developer options → USB debugging
adb devices
npx expo run:android

# C — physical Android over Wi-Fi
#   Phone: Developer options → Wireless debugging → ON → "Pair device with pairing code"
adb pair <pair-ip>:<pair-port>
adb connect <connect-ip>:<connect-port>
adb devices
npx expo run:android

# D — iOS (macOS only)
npx expo prebuild --platform ios
npx expo run:ios
```

The first build links roughly 50 native modules — Signal crypto, SQLCipher,
WebRTC, mediasoup, CallKeep, Firebase, Stripe, camera/AV, ML Kit — which is why
it takes 5–18 minutes.

### Step 6 — wire a physical device to your localhost

Required after **every** USB connect or Wi-Fi reconnect:

```bash
adb reverse tcp:3001  tcp:3001     # auth-service
adb reverse tcp:3100  tcp:3100     # messenger-service
adb reverse tcp:8081  tcp:8081     # Metro bundler
adb reverse tcp:54321 tcp:54321    # Supabase API
adb reverse tcp:54322 tcp:54322    # Supabase Postgres
```

Or run the watcher that re-applies them automatically on every reconnect:

```bash
npm run adb:watch
```

> ⚠️ **Wi-Fi AP isolation.** On many networks the phone cannot reach the
> development PC at all, and Metro will appear to hang with no error. If Metro
> will not connect over Wi-Fi, **use USB** — this has cost time before and is not
> a code problem.

### Step 7 — run against staging instead of local

If you want a device pointed at the deployed staging backend rather than your
laptop, skip Steps 3–4 and 6 entirely:

```bash
npm run start:staging        # Metro with staging URLs
npm run apk:staging          # or a full release APK against staging
```

### Step 8 — verify the toolchain end to end

```bash
npm run typecheck            # must not exceed .tsc-baseline.json (47)
npm run lint
npm run test:crypto          # run twice — known moving flake (B-126)
npm test                     # all three Jest projects
cd apps/auth-service && npm test && cd ../..
```

A clean run of these is the definition of "the checkout is healthy".

### Step 9 — run the operator console (optional)

```bash
cd apps/ops-console
npm run dev                  # http://localhost:3002
```

It expects `auth-service` reachable at the URL in `apps/ops-console/.env.local`.

---

## 1.17 Open items and honest gaps

Everything in this table is a real state of the repository at `b38e42ea`, not a
criticism — it is the list a receiving team needs so nothing is discovered by
surprise.

| #   | Item                                                                                                                                     | Impact                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **GitHub Actions is currently unavailable (billing).** Deploys are done manually over SSH with `scripts/deploy-staging.sh`.              | The 9 required status checks on `main` cannot currently gate a merge. Run `npm run ci:full` locally until Actions is restored. |
| 2   | **No UAT environment or branch.** UAT is performed on staging.                                                                           | No isolated tier for client acceptance testing.                                                                                |
| 3   | **The `production` EAS profile does not set its own API URLs**, so it inherits staging endpoints unless overridden.                      | A production build could silently ship pointed at staging. Set explicit `env` on the `production` profile before go-live.      |
| 4   | **No git tags.** `git tag` returns nothing; releases are identified by `versionName`/`versionCode` and Firebase App Distribution builds. | No immutable marker of what shipped. Consider tagging each release.                                                            |
| 5   | **`CODEOWNERS` maps every path to one person**, and `required_approving_review_count` is `0`.                                            | No enforced second pair of eyes, including on crypto paths.                                                                    |
| 6   | **A live Mapbox `pk.` token is committed** in `package.json` and `eas.json`, unrestricted.                                               | Billable usage exposure. Restrict + rotate on transfer.                                                                        |
| 7   | **Dev bypasses default to `true` in the env templates** (`OTP_DEV_RETURN_CODE`, `BIOMETRIC_DEV_BYPASS`).                                 | A copied template in a real environment opens auth. Verify both are `false` outside local dev.                                 |
| 8   | **The client mirror does not currently strip `sqa.md`** or `docs/{handoffs,qa,audits}` (the lines exist, commented out).                 | The internal bug log — including unfixed security findings — is published to the client repo.                                  |
| 9   | **`android/` is gitignored with 21 force-added exceptions.**                                                                             | A new native file added with plain `git add` is silently dropped. Always `git add -f` under `android/`.                        |
| 10  | **`ios/` is not in the repo at all**; CallKit wiring lives in the generated tree and can vanish after a prebuild.                        | `scripts/ios-release.sh --check` exists precisely to catch this. Run it before every iOS release.                              |
| 11  | **`.tsc-baseline.json` is 47** — a legacy pile of type errors is tolerated, with new ones blocked by the ratchet.                        | Not a defect, but the number should trend down, not sideways.                                                                  |
| 12  | **`test:crypto` flakes intermittently (B-126)**, with a moving failure.                                                                  | One red run is not evidence. Run it twice; a failure naming the same test both times is real.                                  |
| 13  | **`rsync` is absent from Git Bash on Windows**, the primary dev environment, so `deploy-staging.sh` needs a preflight.                   | Deploys from Windows may need the `git archive` → `tar` overlay path.                                                          |

---

## 1.18 Verification appendix — reproduce every count in this document

```bash
# Commit this document describes
git log -1 --format='%H %ci %an'                 # b38e42ea… 2026-08-21 Ranak

# Remotes and branches
git remote -v
git branch -a
git tag --sort=-creatordate | head              # (empty — no tags)

# Surface file counts
for d in src apps/auth-service/src apps/messenger-service/src \
         apps/ops-console/src packages/messenger-core/src; do
  printf '%-40s %s\n' "$d" "$(find $d -name '*.ts' -o -name '*.tsx' | wc -l)"
done
# src 1426 · auth-service 393 · messenger-service 120 · ops-console 73 · messenger-core 30

# Screens and console pages
find src/screens -name '*.tsx' -not -path '*__tests__*' | wc -l   # 196
find apps/ops-console/src/app -name 'page.tsx' | wc -l            # 35

# Native code actually tracked
git ls-files android/ | wc -l                    # 21
git ls-files ios/     | wc -l                    # 0
find native -type f                              # 2 (BravoFrameCryptor .swift + .m)

# Migrations and patches
ls supabase/migrations | wc -l                   # 150
ls patches/ | wc -l                              # 10
ls plugins/ | wc -l                              # 3
ls scripts/ | wc -l                              # 27
ls .github/workflows/ | wc -l                    # 12

# Confirm no real secret is tracked
for f in "AuthKey_B9U74KX24U.p8" "Aws creds" "Staging.pem" \
         "bravo-734da-firebase-adminsdk-fbsvc-f74f8bec45.json"; do
  printf '%-55s ' "$f"
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 && echo TRACKED || echo not-tracked
done
# all four: not-tracked

# Public env vars compiled into the mobile bundle
grep -ohE "EXPO_PUBLIC_[A-Z0-9_]+" -r src App.tsx --include=*.ts --include=*.tsx \
  | sort -u | wc -l                              # 28

# Backend env keys
grep -oE "process\.env\.[A-Z0-9_]+" -r apps/auth-service/src --include=*.ts \
  | sed 's/.*process\.env\.//' | sort -u | wc -l # 15  (same for messenger-service)

# The gates themselves
cat .husky/pre-commit .husky/commit-msg .husky/pre-push
node -e "console.log(require('./.tsc-baseline.json').errorCount)"   # 47
```

---

**End of Section 1.** Section 2 (Code Architecture & Application Flow) is
`docs/handover/02_CODE_ARCHITECTURE_AND_APPLICATION_FLOW.md`; Section 3 (Database
Architecture) is `docs/handover/03_DATABASE_ARCHITECTURE.md` with its data
dictionary at `03a_DATA_DICTIONARY.md` and the schema dump at `schema.sql`.
