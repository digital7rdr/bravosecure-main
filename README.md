# Bravo Secure

Tactical-luxury private security app: end-to-end encrypted messenger, secure voice/video calls, booking flow, intel feed, agent marketplace.

React Native (Expo SDK 54) · NestJS · Supabase · Redis · Signal Protocol · CallKit (iOS) · Telecom (Android).

---

## Release pipeline (build + Firebase in one command)

```powershell
npm run release                       # auto-bumps patch, runs pre-flight, builds, uploads
npm run release -- -Version 1.0.20    # explicit target version
npm run release -- -SkipUpload        # build only (no Firebase)
npm run release -- -SkipBuild         # bump versions only
npm run release -- -Force             # skip the typecheck/jest pre-flight gate
```

The `release` script is a single-command pipeline: pre-flight (typecheck regression + jest) → version bump (`app.json` + `build.gradle`) → `gradlew assembleRelease appDistributionUploadRelease` → tester emails go out via Firebase App Distribution.

Requires `FIREBASE_SERVICE_ACCOUNT` env var pointing at a Firebase Admin SDK service-account JSON. See [scripts/release-apk.ps1](scripts/release-apk.ps1) for the full spec.

---

## Quick start — for a new teammate

> **Goal:** clone → 15 minutes → running on a phone.

### 0. One-time prerequisites

Install these globally (any order):

| Tool                                                                                                     | Version                                      | Check                            |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------- |
| [Node.js](https://nodejs.org)                                                                            | ≥ 20.x                                       | `node --version`                 |
| npm                                                                                                      | ≥ 10.x (ships with Node 20)                  | `npm --version`                  |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/)                                        | current                                      | `docker --version` + GUI running |
| [Redis](https://github.com/redis-windows/redis-windows/releases) (Windows) or `brew install redis` (mac) | ≥ 7.x                                        | `redis-cli --version`            |
| [Android Studio](https://developer.android.com/studio)                                                   | Hedgehog+                                    | installs SDK + platform-tools    |
| JDK                                                                                                      | **17** (bundled with Android Studio is fine) | `java -version`                  |
| Git                                                                                                      | any                                          | `git --version`                  |

Environment variables you must set (once per machine):

```powershell
# Windows (PowerShell) — replace paths with yours
setx ANDROID_HOME "C:\Users\<you>\AppData\Local\Android\Sdk"
setx JAVA_HOME "C:\Program Files\Android\Android Studio\jbr"
# Add to PATH:   %ANDROID_HOME%\platform-tools   and   %ANDROID_HOME%\emulator
```

```bash
# macOS / Linux — add to ~/.zshrc or ~/.bashrc
export ANDROID_HOME="$HOME/Library/Android/sdk"       # or ~/Android/Sdk on Linux
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
```

Restart your terminal after `setx`.

### 1. Clone + install

```bash
git clone <repo-url> bravo-secure
cd bravo-secure
npm install
cd apps/auth-service      && npm install && cd ../..
cd apps/messenger-service && npm install && cd ../..
```

### 2. Copy env files

```bash
cp .env.example .env
# Fill in Twilio / Stripe / Maps keys if you need them; dev mode works without.
```

`apps/auth-service/.env` and `apps/messenger-service/.env` ship with working **dev-bypass** values already (OTP accepts any 6 digits, biometric step-up skipped).

### 3. Start the infrastructure

Open **four separate terminals**. Leave them running.

**Terminal 1 — Supabase** (Postgres + Auth + Storage):

```bash
npx supabase start
```

First run pulls ~2 GB of Docker images. Subsequent runs: ~15 s. Requires Docker Desktop running.

**Terminal 2 — Redis:**

```bash
# Windows
"C:\Program Files\Redis\redis-server.exe" --port 6379
# macOS / Linux
redis-server --port 6379
```

**Terminal 3 — Auth service:**

```bash
cd apps/auth-service
npm run start:dev
# Listens on :3001
```

**Terminal 4 — Messenger service:**

```bash
cd apps/messenger-service
npm run start:dev
# Listens on :3100 (REST + WebSocket at /ws)
```

Verify all four are up:

```bash
curl http://127.0.0.1:3001/auth/health          # {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/envelopes  # 401 (unauthenticated — expected)
redis-cli -p 6379 ping                           # PONG
npx supabase status                              # API URL, DB URL, anon key
```

### 4. Seed dev users (optional but recommended)

Creates Alice / Bob / Carol so the messenger has people to chat with:

```bash
node scripts/seed-dev-users.mjs
```

The 3 printed UUIDs are already hardcoded in `src/modules/messenger/dev/devContacts.ts`.

### 5. Build + install the app on a device

Pick one:

#### Option A — Android emulator

```bash
# In Android Studio: Device Manager → create a Pixel 6 (Android 14+)
# Launch it, then:
adb devices                      # should show  emulator-5554 device
npx expo run:android             # ~5–10 min first build
```

#### Option B — Physical Android phone via USB

```bash
# On phone: Settings → About → tap Build number 7× → enable Developer options
# → enable USB debugging. Plug in, accept the RSA prompt.
adb devices                      # should show your device id
npx expo run:android             # ~5–10 min first build
```

#### Option C — Physical phone over Wi-Fi (no cable)

```bash
# Phone: Settings → Developer options → Wireless debugging → ON
#        → tap "Pair device with pairing code" → note the IP:PORT + 6-digit code
adb pair <pair-ip>:<pair-port>    # enter code when prompted
# Back on phone main screen: note "IP address and port" under Wireless debugging
adb connect <connect-ip>:<connect-port>
adb devices                       # should show the device
npx expo run:android
```

The first build links all ~50 native modules (Signal crypto, SQLCipher, Agora, Stripe, Firebase, expo-camera, expo-av, etc.) and takes 5-18 min. Subsequent incremental builds are ~30 s.

### 6. Wire the phone to localhost (physical device only)

Run **adb reverse** once after every USB connect / Wi-Fi reconnect so the phone reaches your dev services on localhost:

```bash
adb reverse tcp:3001 tcp:3001     # auth-service
adb reverse tcp:3100 tcp:3100     # messenger-service
adb reverse tcp:8081 tcp:8081     # Metro bundler
adb reverse tcp:54321 tcp:54321   # Supabase API
adb reverse tcp:54322 tcp:54322   # Supabase Postgres
```

Or use the watcher that does this automatically whenever the device reconnects:

```bash
npm run adb:watch
```

### 7. Log in

The seeder script above creates three test accounts. Any of these works:

| Email                        | Password                  |
| ---------------------------- | ------------------------- |
| `alice.dev@bravosecure.test` | `alice-dev-password-123!` |
| `bob.dev@bravosecure.test`   | `bob-dev-password-123!`   |
| `carol.dev@bravosecure.test` | `carol-dev-password-123!` |

On the OTP screen, **any 6-digit code** works (dev bypass is on). Lands on Dashboard.

You can also register a fresh account from the app — OTP flow is dev-bypassed, no SMS sent.

---

### 8. Two-device / two-emulator testing (real prod-mode messenger)

The app switches from loopback (messages echo back to verify crypto) to
**production** mode as soon as you're logged in and the messenger
runtime can reach `EXPO_PUBLIC_MSG_BASE_URL`. To see presence, typing
indicators, and real send/deliver between **two** devices, both have
to be able to reach the same backend.

**Pick one networking setup:**

- **Mac + mixed sims (iOS simulator + Android emulator):** put your
  Mac's LAN IP in `.env` so both sandboxes resolve the same host:

  ```
  # get it with: ipconfig getifaddr en0
  EXPO_PUBLIC_API_BASE_URL=http://192.168.x.x:3001
  EXPO_PUBLIC_MSG_BASE_URL=http://192.168.x.x:3100
  EXPO_PUBLIC_SUPABASE_URL=http://192.168.x.x:54321
  ```

- **Two Android emulators:** either use `10.0.2.2` in `.env` (the
  emulator's alias for the host), or keep `127.0.0.1` and `adb reverse`
  each emulator (run per serial from `adb devices`):

  ```
  adb -s emulator-5554 reverse tcp:3001 tcp:3001
  adb -s emulator-5554 reverse tcp:3100 tcp:3100
  adb -s emulator-5554 reverse tcp:54321 tcp:54321
  # repeat for emulator-5556
  ```

- **Two physical phones on Wi-Fi:** put your Mac/PC's LAN IP in `.env`
  (same as the mixed-sim setup above).

**Then:**

1. Sign in as **different** accounts on each device — e.g. Alice on
   phone A and Bob on phone B. Using the same account on both collides
   on device-id routing.
2. The LOOPBACK MODE banner at the top of the chat should disappear.
   When it does, you're in production mode.
3. Open the same chat on both devices. You should see:
   - real presence dots (online → active → away)
   - typing indicator bubble animating on the peer device
   - gray double-check for `delivered` (blue read-receipt ticks are
     not yet wired — see `docs/architecture/MESSENGER_BACKEND.md`)

**Audio echo during voice/video calls on one machine is physical**
(both sims share the host mic + speakers). Use headphones or mute one
side — no app-level fix.

---

## Project layout

```
bravo-secure/
├── App.tsx                      RN app entry
├── index.js                     registers the root + polyfills
├── app.json                     Expo config (plugins, permissions)
├── src/
│   ├── components/              shared UI (LoadingView, BiometricGate, CountryPicker, ...)
│   ├── modules/
│   │   └── messenger/
│   │       ├── crypto/          Signal primitives, SQLCipher store, WebCrypto polyfills
│   │       ├── runtime/         orchestration (runtime, productionRuntime, expirySweeper, keychain)
│   │       ├── transport/       WS client + HTTP relay fallback
│   │       ├── media/           AES-256-CBC attachment encrypt/upload
│   │       ├── groups/          sealed-sender broadcast
│   │       ├── webrtc/          peer connection, signalling, Agora fallback
│   │       ├── store/           zustand + immer + AsyncStorage persist
│   │       └── dev/             devContacts (Alice/Bob/Carol)
│   ├── screens/                 every screen, grouped by feature
│   ├── navigation/              root / auth / main / messenger / booking stacks
│   ├── services/                api clients (auth, supabase)
│   ├── store/                   zustand slices (authStore, ...)
│   ├── theme/                   colors, spacing
│   ├── types/                   shared TS types
│   └── utils/                   constants, helpers
├── apps/
│   ├── auth-service/            NestJS — users, OTP, JWT, TOTP, biometric, Signal keys, sender-cert
│   └── messenger-service/       NestJS — WS gateway, envelope relay, media presign, file-vault MFA
├── supabase/
│   ├── migrations/              SQL (versioned, ordered)
│   └── seed.sql                 reference data (intel sources); does NOT seed users
├── scripts/
│   ├── seed-dev-users.mjs       creates Alice/Bob/Carol against a running auth-service
│   ├── run-emulator.ps1         launches the default AVD
│   └── adb-reverse-watcher.ps1  re-applies reverse tunnels on reconnect
├── android/                     Expo-prebuilt native project
├── ios/                         (generated by `npx expo prebuild` when you need it)
├── README.md                    ← you are here
├── CLAUDE.md                    agent rules + security constraints
├── sqa.md                       running QA reference + bug log
└── docs/                        architecture, audits, QA, planning (see docs/README.md)
```

---

## Common tasks

### Run tests

```bash
npm test                                    # app unit tests (Jest)
npm run test:crypto                         # messenger-crypto integration tests only
cd apps/auth-service      && npm test       # auth-service Jest
cd apps/messenger-service && npm test       # messenger-service Jest
```

### Type-check + lint

```bash
npm run lint
cd apps/auth-service      && npm run typecheck
cd apps/messenger-service && npm run typecheck
```

### Reset everything

```bash
# Wipe local Postgres + Redis, re-run migrations + seeds
npx supabase db reset
redis-cli -p 6379 FLUSHALL
# Re-seed dev users
node scripts/seed-dev-users.mjs
```

### Rebuild from scratch (when native deps change)

```bash
cd android && ./gradlew clean && cd ..
npx expo start -c            # clears Metro cache
npx expo run:android
```

### Query the dev database

```bash
docker exec -it supabase_db_Bravo_Secure psql -U postgres -d postgres
\dt public.*                                -- list tables
SELECT id, email, role FROM users;
SELECT COUNT(*) FROM message_envelopes;     -- server never has plaintext
SELECT COUNT(*) FROM signal_identities;     -- identity keys (public part only)
```

---

## Gotchas

- **Docker Desktop must be running** before `npx supabase start`. If it's off the error is misleading (`cannot find container`).
- **JDK version.** RN 0.81 requires JDK 17. JDK 11 or 21 will fail at Gradle configuration.
- **Metro reload ≠ APK reinstall.** Pure JS changes hot-reload over Metro. Adding / changing any `react-native-*` or `expo-*` native module requires `npx expo run:android` again.
- **`adb reverse` dies on every unplug/reconnect.** Use `npm run adb:watch` or re-run the block above.
- **First messenger open is ~1-2 s** while libsignal generates X25519 keypairs on the JS thread (5 own + 2 peer OPKs in loopback dev mode). Pre-warm fires from MainNavigator so the Dashboard → Messenger transition is instant.
- **Wireless debugging port rotates** every time the phone toggles the setting. You'll need a fresh `adb connect <ip>:<port>` and re-apply `adb reverse`.
- **Biometric gate re-locks on app background.** Device fingerprint/face unlock is required to re-enter. On emulator you can enrol a synthetic fingerprint: `adb -e emu finger touch 1`.
- **Android 15 (16KB-page emulator)** shows a blue compatibility banner on launch — harmless, the app runs in 4KB-page compat mode. Use a 4KB Android 14 emulator to avoid.

---

## Services reference

| Service           | Port  | Purpose                        | Health check                                      |
| ----------------- | ----- | ------------------------------ | ------------------------------------------------- |
| Supabase Postgres | 54322 | data                           | `docker exec supabase_db_Bravo_Secure pg_isready` |
| Supabase API      | 54321 | PostgREST / Auth / Storage     | `curl http://127.0.0.1:54321/`                    |
| Supabase Studio   | 54323 | browser UI for Postgres        | open in browser                                   |
| Redis             | 6379  | JTI allowlist + envelope store | `redis-cli -p 6379 ping`                          |
| Auth service      | 3001  | users, OTP, JWT, keys, certs   | `curl http://127.0.0.1:3001/auth/health`          |
| Messenger service | 3100  | relay + WS + presign + MFA     | REST 401 unauth; WS at `/ws`                      |
| Metro bundler     | 8081  | JS bundle for dev-client       | `curl http://127.0.0.1:8081/status`               |

---

## Further reading

- [docs/README.md](docs/README.md) — documentation index
- [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md) — codebase hunting tree
- [docs/architecture/MESSENGER_BACKEND.md](docs/architecture/MESSENGER_BACKEND.md) — full crypto + architecture walkthrough
- [docs/development/AUTH_TESTING.md](docs/development/AUTH_TESTING.md) — every auth endpoint with `curl` examples
- [docs/architecture/AUTH_COMPLIANCE.md](docs/architecture/AUTH_COMPLIANCE.md) — spec vs implementation matrix
- [docs/planning/REMAINING_TODO.md](docs/planning/REMAINING_TODO.md) — open milestones, deferrals, and prereqs

If you get stuck, ping the team — most setup pain is Docker / JDK / ANDROID_HOME env, fixable in <5 minutes.

---

## CallKit (iOS) + Telecom (Android) — system call UI

End-to-end encrypted calls now ring with the platform's native call UI alongside the existing in-app screens.

### Status by platform

| Platform    | Status                               | What works                                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Android** | ✅ Live (this build)                 | `react-native-callkeep@4.3.16` wired through Telecom `ConnectionService`. System call UI on lock screen, Bluetooth headset auto-routing, coexistence with WhatsApp / SIM calls (no audio-focus fights), Decline → `call.hangup` to peer (caller stops ringing immediately instead of waiting for the 30s no-answer timeout) |
| **iOS**     | ⚠️ Skeleton (code complete, dormant) | All bridge code written + APNs HTTP/2 sender ready on the server. Single flag flip to activate once Apple VoIP cert lands. See "iOS handoff" below.                                                                                                                                                                         |

### Architecture

Two parallel rings fire on incoming calls (de-duped by `callId`):

1. **notifee path** ([callNotification.ts](src/modules/messenger/push/callNotification.ts)) — guaranteed baseline. Lock-screen full-screen, ringtone, vibration, custom WAV asset (works on Android 14 ContentResolver-broken Pixels).
2. **CallKit / Telecom path** ([callKitBridge.ts](src/modules/messenger/push/callKitBridge.ts)) — system call UI on top, with Bluetooth routing + recents-app integration. Falls back silently to notifee-only if Telecom setup fails (OEM stripped Telecom, user denied phone-account permission).

If either path fails, the user still gets a ring from the other. Calling has never depended on Telecom being available.

### Files

| File                                                                                               | Purpose                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [src/modules/messenger/push/callKitBridge.ts](src/modules/messenger/push/callKitBridge.ts)         | Cross-platform thin wrapper around `react-native-callkeep`. Lazy-loads native module; no-ops cleanly when unavailable.               |
| [src/modules/messenger/push/incomingCallCache.ts](src/modules/messenger/push/incomingCallCache.ts) | In-memory payload cache (60s TTL) so Telecom event handlers can navigate when the user taps Accept/End from the lock screen.         |
| [src/modules/messenger/push/voipPush.ts](src/modules/messenger/push/voipPush.ts)                   | iOS PushKit registration. Mirrors `fcmBootstrap.ts`. Inert until iOS prerequisites land.                                             |
| [src/modules/messenger/push/fcmBootstrap.ts](src/modules/messenger/push/fcmBootstrap.ts)           | Wires Telecom event handlers into Bravo's call flow. Decline → `call.hangup` to peer.                                                |
| [apps/messenger-service/src/push/apnsClient.ts](apps/messenger-service/src/push/apnsClient.ts)     | Hand-rolled APNs HTTP/2 client (zero new deps — uses `node:http2` + ES256 JWT).                                                      |
| [apps/messenger-service/src/push/push.service.ts](apps/messenger-service/src/push/push.service.ts) | iOS branch wired behind `APNS_VOIP_*` env probe. Same HMAC + nonce envelope as Android FCM, so on-device verifier works identically. |

### Android manifest entries

The official Expo config plugin (`@config-plugins/react-native-callkeep`) handles this on a clean prebuild. Because this project has custom Kotlin (`CallForegroundService.kt`) that prebuild would overwrite, the entries are also patched directly into [android/app/src/main/AndroidManifest.xml](android/app/src/main/AndroidManifest.xml):

- Permissions: `BIND_TELECOM_CONNECTION_SERVICE`, `READ_PHONE_STATE`, `READ_PHONE_NUMBERS`, `CALL_PHONE`
- Services: `io.wazo.callkeep.VoiceConnectionService` (Telecom-bound), `io.wazo.callkeep.RNCallKeepBackgroundMessagingService`

First app launch prompts the user once: _"Allow Bravo Secure to manage phone calls?"_ — same one-time Android dialog Signal/Wire show. Tap Allow.

### iOS handoff (when Apple cert lands)

Single-day milestone once you have:

- Apple VoIP Services Certificate (issue at developer.apple.com → Certificates → +)
- `.p8` auth key file deployed to messenger-service host

Then:

1. Set 4 env vars on messenger-service (any orchestration — systemd, EC2 user-data, k8s secret):
   ```
   APNS_VOIP_KEY_ID=ABC1234DEF
   APNS_VOIP_TEAM_ID=YOUR_10_CHAR_TEAM
   APNS_VOIP_BUNDLE_ID=com.bravosecure.app
   APNS_VOIP_KEY_PATH=/etc/bravo/AuthKey_ABC1234DEF.p8
   APNS_VOIP_SANDBOX=1                   # optional, for TestFlight smoke
   ```
2. Flip `IOS_RUNTIME_ENABLED = true` in [src/modules/messenger/push/callKitBridge.ts](src/modules/messenger/push/callKitBridge.ts) (one line).
3. EAS iOS build (`npx eas build --profile preview-staging --platform ios`).
4. Real-device TestFlight smoke: lock-screen ring + system Accept/Decline + background→foreground answer.

The whole iOS path is dormant code today — flipping the flag activates it without further integration work.

### iOS contract (already respected)

iOS 13+: every PushKit notification MUST report a CallKit incoming call within ~5s. Miss it once and Apple revokes the VoIP entitlement (no warning, no appeal — kills the app on the App Store). [voipPush.ts](src/modules/messenger/push/voipPush.ts) calls `reportIncomingCall` synchronously BEFORE any HMAC verification or network work; if verification later rejects the wake, it calls `reportEnded(callId, 'failed')` so CallKit dismisses (½-second flash of UI in the worst case, far better than entitlement loss).

---
