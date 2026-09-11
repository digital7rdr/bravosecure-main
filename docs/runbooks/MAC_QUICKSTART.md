# macOS quick start — Android emulator against the staging backend

The repo's own quick start is Windows-first (`.ps1` scripts, `gradlew.bat`) and assumes a
working tree that already has a generated `android/`. This is the macOS path from a fresh
clone or zip download, pointing the app at the hosted Contabo staging backend so you need
**no Docker, no Supabase, no local NestJS services**.

Target: app running on an Android emulator in ~30 minutes.

---

## 0. Shell environment (once per machine)

Add to `~/.zshrc`, then `source ~/.zshrc`:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
```

Verify — **`java -version` must say 17.** RN 0.81 fails at Gradle configuration on 11 or 21:

```bash
node -v          # >= 20
java -version    # 17.x
adb --version
```

## 1. Install dependencies

```bash
cd ~/Projects/Bravo_Secure-main
npm install                       # also applies patches/ via patch-package — required
```

Do **not** skip `npm install` before a build. An unresolvable import fails at the *last*
phase of the bundle, after everything else has compiled (build 163 died exactly this way).

## 2. Rebuild the native Android project

`android/` in this repo is a partial, curated tree — it is missing `settings.gradle`, the
Gradle wrapper, `res/values/strings.xml`, the launcher icons and the splash drawables, so it
cannot build as-is. But a plain `expo prebuild` would overwrite the curated files, and the
losses are silent (call foreground service, CallKeep ConnectionService, the WebRTC AEC3
override, the play-services-location pin, the release signing config).

`scripts/mac-android-prebuild.sh` does both halves: backs up the curated files, prebuilds
clean, overlays them back, then asserts each silent-failure item is still present.

```bash
bash scripts/mac-android-prebuild.sh
```

It leaves a timestamped `android.curated-<stamp>/` backup and, if the current Expo template
differs from a curated file, a `.android-prebuild-drift-<stamp>.diff` worth reading.

## 3. Emulator

Android Studio → Device Manager → create a **Pixel 6, Android 14 (API 34)**. Prefer API 34
over 15/16: Android 15's 16 KB-page images show a compatibility banner and this stack runs in
4 KB compat mode there.

```bash
emulator -list-avds
emulator -avd <name> &
adb devices          # expect: emulator-5554  device
```

## 4. Build and run

`config/staging.env` holds the staging values (copied from `eas.json`). It points the app at
the hosted backend, so no Docker and no local services are needed.

```bash
npm run android:staging:mac     # first build: 5–18 min. Later JS changes hot-reload.
```

Rebuild natively (`npx expo run:android`) only when a `react-native-*` / `expo-*` native
module changes; pure JS changes reload over Metro.

### ⚠ Never name a local env file `.env*.local` on Expo SDK 54

The repo's `start:staging:hot` / `android:staging:hot` scripts read `.env.staging.local`.
**That file name breaks the dev bundle on SDK 54**, with an error that points at the env file
and looks like a corrupt source file:

```
Android Bundling failed 12901ms index.js (3445 modules)
ERROR SyntaxError: /…/.env.staging.local: Unexpected token (1:0)
```

Expo's **development** bundler pulls every root-level `.env*.local` file into the Metro module
graph and hands it to Babel, which cannot parse `KEY=value`. Verified by bisection:

| File in project root | Pulled into the dev graph? |
| --- | --- |
| `.env.staging.local` | yes → bundle fails |
| `.env.zzz.local` (arbitrary name) | yes → bundle fails |
| `.env.production`, `.env.example` | no |
| `config/staging.env` | no → bundle succeeds |

It is the **name**, not the contents: a comment-free file fails too (`KEY=https://x` parses as
`KEY = https :` — a syntax error). Release bundles (`--dev false`) are unaffected, which is why
`apk:staging` and the EAS profiles still work — they also pass values inline via `cross-env`
rather than through a file.

So the macOS scripts (`*:staging:mac`) read `config/staging.env` instead. The three `:hot`
scripts remain broken until someone repoints them; fixing them repo-wide is a one-line change
per script.

## 4a. The Mapbox token is no longer in the repo

GitHub push protection flags Mapbox tokens (`pk.` and `sk.` alike), so the public
token was removed from `package.json`, `eas.json`, `.env.production` and the build
scripts. Builds read it from the environment:

- **Local** — `config/staging.env` already carries `EXPO_PUBLIC_MAPBOX_TOKEN`; the
  `*:staging:mac` scripts load it. For `apk:staging` / `apk:dist`, export it first.
- **EAS cloud builds** — store it once as a project secret; EAS injects it into
  every profile's build env:

  ```bash
  npx eas secret:create --scope project --name EXPO_PUBLIC_MAPBOX_TOKEN --value 'pk.…' --type string
  ```

- **Production box** — `deploy/production/.env` (`NEXT_PUBLIC_MAPBOX_TOKEN`).

## 4b. Building against production (bravosecure.cloud)

Every endpoint the app talks to comes from `EXPO_PUBLIC_*` at bundle time — nothing
is hardcoded to staging in source. `config/production.env` points them all at the
VPS; two of its values (the Supabase anon key, the sender-cert public key) are minted
on the box, so a script fetches them over SSH rather than having you retype them:

```bash
bash scripts/pull-prod-client-env.sh      # writes config/production.env (gitignored)
npm run android:prod:mac                  # debug build against production
npm run apk:prod:mac                      # release APK against production
```

| Value | Source |
| --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | `https://auth.bravosecure.cloud` |
| `EXPO_PUBLIC_MSG_BASE_URL` | `https://relay.bravosecure.cloud` |
| `EXPO_PUBLIC_SUPABASE_URL` | `https://api.bravosecure.cloud` (self-hosted gateway) |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `/opt/supabase/.env` on the box |
| `EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64` | `deploy/production/.env` on the box |
| `EXPO_PUBLIC_MAPBOX_TOKEN` | the one external dependency kept (tiles) |

For EAS cloud builds the URLs live in the `production` / `production-apk` profiles
of `eas.json`; the two keys go in as project secrets:

```bash
npx eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value '<anon>' --type string
npx eas secret:create --scope project --name EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64 --value '<pub>' --type string
```

> Until the mobile login screens are updated for the TOTP contract, a production
> build reaches the server but cannot complete sign-in (the app posts `/auth/verify`
> without `challengeId`). Connectivity, TLS and the Supabase gateway can still be
> smoke-tested with it.

## 5. Sign in

Staging accounts are whatever exists on the Contabo backend. Against a **local** stack you'd
seed `alice.dev@bravosecure.test` / `alice-dev-password-123!` with
`node scripts/seed-dev-users.mjs`. On the OTP screen any 6 digits work (dev bypass).

---

## Release APK

```bash
cd android && ./gradlew assembleRelease && cd ..
# → android/app/build/outputs/apk/release/app-release.apk
```

Without `BRAVO_UPLOAD_STORE_FILE` this is **debug-signed** — installable for QA, not
publishable, and trivially re-signable. For a real one:

```bash
keytool -genkeypair -v -storetype PKCS12 \
  -keystore ~/keys/bravo-upload.p12 -alias bravo-upload \
  -keyalg RSA -keysize 4096 -validity 10000
```

then put the four properties in `~/.gradle/gradle.properties` (never in
`android/gradle.properties`, which is tracked):

```
BRAVO_UPLOAD_STORE_FILE=/Users/<you>/keys/bravo-upload.p12
BRAVO_UPLOAD_STORE_PASSWORD=…
BRAVO_UPLOAD_KEY_ALIAS=bravo-upload
BRAVO_UPLOAD_KEY_PASSWORD=…
```

**Back that keystore up.** Lose it and the app can never be updated under the same signature.

The repo's `npm run release` and `npm run apk:dist` are PowerShell / `gradlew.bat` and do not
run here — use the Gradle commands directly, or EAS (`npm run eas:build:staging`).

---

## macOS-specific notes

- `android/gradle.properties` caps `org.gradle.workers.max=3` for a Windows worker-crash bug.
  Commenting it out speeds the build up on a Mac.
- Every `.ps1` script in `scripts/` is Windows-only: `apk:user`, `release`, `emu`,
  `adb:watch`, `android:setup`. `adb reverse` is only needed for a *local* backend, which the
  staging path avoids.
- Full local stack instead of staging: see the repo README §3–§7 (Supabase + Redis + both
  NestJS services). You must create `apps/auth-service/.env` and
  `apps/messenger-service/.env` from their `.env.example` files — contrary to the README they
  are not shipped — and `JWT_ACCESS_SECRET` must be identical in both or every messenger
  request 401s.
