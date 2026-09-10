# Running Bravo Secure Locally — Build the App and Get It on a Phone

**Bravo Secure — developer onboarding + Android build reference**
_(Technical Code & System Handover, companion to §1.11 Build process)_

> ### New here? **Go straight to [Part 1](#part-1--get-the-app-running).**
>
> Five steps, about an hour, no database or secrets required.
> Parts 2 and 3 are reference — read them when something breaks or when you need
> to change how the build works.

<details>
<summary><b>Document provenance</b> — what was verified, and what wasn't (click to expand)</summary>

|                   |                                                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source commit** | `b38e42ea` (branch `main`)                                                                                                                                                                                                                                                    |
| **Scope**         | Android. iOS has a different pipeline — see §1a.13.                                                                                                                                                                                                                           |
| **Verified**      | The pipeline in this document was **executed end to end on 2026-08-22**. A release APK was built from this checkout (`BUILD SUCCESSFUL in 3m 9s`, arm64-only, 177.6 MB) and all four §1a.10 checks passed against it. Staging backends and database were probed live (§1a.0). |
| **NOT verified**  | On-device install and smoke test — no handset or emulator was attached when this was written.                                                                                                                                                                                 |
| **Prepared**      | 2026-08-22                                                                                                                                                                                                                                                                    |

Every path, flag, task name, size and timing was read out of the working tree, out
of `android/app/build.gradle` and `android/gradle.properties`, or measured directly
from a real build. Nothing here is a generic React Native recipe.

</details>

---

## Start here

**You are about to get the Bravo Secure app running on an Android phone from a
fresh clone.** It takes about **an hour**, most of which is the computer
compiling while you do something else.

**The good news, stated up front so you do not go looking for it:**

> You do **not** need a database. You do **not** need to run any backend. You do
> **not** need a single password, API key, or `.env` file. The app you build will
> connect to a live server and a live database automatically, because the
> settings it needs are already committed to the repository.
>
> The only thing you need from another human is **access to the GitHub repo**.

### Which path are you on?

| If you want to…                                      | Go to                    | Time        |
| ---------------------------------------------------- | ------------------------ | ----------- |
| **Run the app on a phone** (most people, start here) | **Part 1**, below        | ~1 hour     |
| Change backend code and run the servers locally      | Part 2 → §1a.0 "Mode B"  | +1 hour     |
| Understand how the build works before touching it    | Part 2 → §1a.1 and §1a.2 | 20 min read |
| Fix a build that is failing                          | **Part 3** → §1a.12      | —           |

---

# PART 1 — GET THE APP RUNNING

Five steps. Do them in order. **Each step ends with a check** — if the check
passes, move on; if it fails, the step tells you where to go.

---

## Step 1 — Install the tools (~20 min, once per machine)

Install these four things. Order does not matter.

| #   | Tool               | Version                  | Where                                                                                   |
| --- | ------------------ | ------------------------ | --------------------------------------------------------------------------------------- |
| 1   | **Node.js**        | 20 or newer (22 is fine) | <https://nodejs.org>                                                                    |
| 2   | **Android Studio** | current                  | <https://developer.android.com/studio> — installs the Android SDK **and** a bundled JDK |
| 3   | **Java (JDK)**     | **17 or 21**             | You already have it — Android Studio bundles it as "JBR". No separate install.          |
| 4   | **Git**            | any                      | <https://git-scm.com>                                                                   |

Then open Android Studio once and let it finish downloading the SDK. In
**Settings → Languages & Frameworks → Android SDK**, tick **Android API 36** if
it is not already installed.

### Tell your machine where those tools live

**Windows (PowerShell):**

```powershell
setx ANDROID_HOME "$env:LOCALAPPDATA\Android\Sdk"
setx JAVA_HOME    "C:\Program Files\Android\Android Studio\jbr"
```

Then add these two folders to your `Path`:
`%ANDROID_HOME%\platform-tools` and `%ANDROID_HOME%\emulator`.
**Close and reopen your terminal** — `setx` only affects new terminals.

**macOS / Linux** (add to `~/.zshrc` or `~/.bashrc`, then open a new terminal):

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"          # ~/Android/Sdk on Linux
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
```

> **If Android Studio is NOT in the default location**, `JAVA_HOME` above will be
> wrong. Find the real one — on the machine these docs were written on, Android
> Studio lives on another drive and `JAVA_HOME` is `E:\Android_Std\jbr`. Point it
> at wherever your `jbr` folder actually is. Getting this wrong is the single most
> common Step 1 mistake.

### ✅ Check Step 1

Run all four. Every one must answer.

```bash
node --version                     # v20.x or newer
"$JAVA_HOME/bin/java" -version     # 17.x or 21.x
adb --version                      # Android Debug Bridge version 1.0.x
echo $ANDROID_HOME                 # a real path (%ANDROID_HOME% on cmd)
```

Use `"$JAVA_HOME/bin/java"`, **not** plain `java` — a stale Android Studio
install can leave a broken `java` on your `PATH` that fails with
`could not open ...\jbr\lib\jvm.cfg` even though your build will work fine.

❌ **Something didn't answer?** → §1a.3 has the full toolchain detail.

---

## Step 2 — Get the code (~5 min)

```bash
git clone https://github.com/omnidevxstudiobit/Bravo_Secure.git bravo-secure
cd bravo-secure
npm install
```

`npm install` takes a few minutes and pulls a large dependency tree. It also
automatically applies 10 patches to third-party packages — **watch for errors
mentioning `patch-package`**. Those patches fix the crypto, database and calling
libraries; a build without them compiles fine and then misbehaves at runtime.

> ⚠️ **Never use `npm install --ignore-scripts`** here. It skips the patches and
> produces exactly that broken-at-runtime result.

### ✅ Check Step 2

```bash
ls node_modules | wc -l            # a big number (hundreds)
git ls-files android/ | wc -l      # must be exactly 21
```

That `21` matters: the Android folder is mostly generated, but 21 hand-written
files are stored in Git. If you see a different number, something removed them —
run `git checkout -- android/`.

---

## Step 3 — Build the APK (~10–25 min, mostly waiting)

```bash
npm run apk:staging
```

This bundles the JavaScript and compiles the Android app. Go make coffee.

> ⚠️ **THE FIRST BUILD ON A NEW MACHINE OFTEN FAILS. THIS IS NORMAL. RUN IT
> AGAIN.**
>
> If you see this:
>
> ```
> > Task :app:createBundleReleaseJsAndAssets FAILED
> > Process 'command 'cmd'' finished with non-zero exit value 1
> ```
>
> …it is almost certainly an empty bundler cache, not a problem with your setup.
> This was reproduced on 2026-08-22: the first attempt failed after 13m 39s, and
> **the identical command succeeded on the second attempt with no other change.**
> Only start investigating if attempt #2 also fails.

**Faster option.** If you are building for a real phone (not an emulator), this
builds a much smaller APK about three times faster — 177.6 MB instead of 492.4 MB,
because it skips three processor architectures your phone cannot use:

```bash
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
cd ..
```

### ✅ Check Step 3

Look for this line near the end of the output:

```
BUILD SUCCESSFUL in 3m 9s
```

and confirm the file exists:

```bash
ls -l android/app/build/outputs/apk/release/app-release.apk
```

You should see a file of roughly **180 MB** (single architecture) or **490 MB**
(all architectures). Both are normal — the app bundles WebRTC, Signal crypto,
SQLCipher and ML Kit, which are large native libraries.

> **Never judge the build by anything except the `BUILD SUCCESSFUL` /
> `BUILD FAILED` line.** If you pipe Gradle into another command (`| tail`,
> `| grep`), the exit code you get back is that command's, not Gradle's — a failed
> build can look like a success. This caught the author of this document.

❌ **Build failed twice?** → Part 3, §1a.12 troubleshooting matrix.

---

## Step 4 — Put it on a phone (~5 min)

**Use a real Android phone if you can.** Push notifications and calls do not work
properly on most emulators.

On the phone: **Settings → About phone → tap "Build number" seven times** →
go back → **Developer options → enable USB debugging**. Plug it in by USB and
accept the prompt that appears on the phone screen.

```bash
adb devices                        # your phone should be listed as "device"
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

The install takes **3–6 minutes** — the APK is large. Wait for `Success`.

### ✅ Check Step 4

`Success` printed, and **Bravo Secure** appears in the phone's app drawer.

❌ **`INSTALL_FAILED_UPDATE_INCOMPATIBLE`?** An older build with a different
signature is installed. Uninstall it first — but read the data-loss warning in
§1a.9 before uninstalling a phone that holds a real account.

---

## Step 5 — Prove it actually works (~10 min)

Open the app. Work down this list; each item exercises a different part of the
system, so where it stops tells you what is wrong.

| #   | Do this                                      | Proves                                     |
| --- | -------------------------------------------- | ------------------------------------------ |
| 1   | App opens past the loading screen            | The build is sound                         |
| 2   | Register or log in — an OTP arrives          | **The backend and database are reachable** |
| 3   | Open a chat, send and receive a message      | Encryption, local database, message relay  |
| 4   | Send and receive a **group** message         | Group encryption                           |
| 5   | Make a voice call, hear audio both ways      | WebRTC, TURN relay, native call screen     |
| 6   | Open a map, tap "Locate Me"                  | Maps and GPS                               |
| 7   | Background the app, have someone message you | Push notifications                         |

> **Steps 3–7 need a second account on a second device.** End-to-end encryption
> genuinely cannot be tested alone — there has to be someone on the other end.

**If step 2 works, you are done.** Everything past it is feature testing, not
setup: the app found the server, the server found the database, and your
environment is correct.

### Is the server actually up?

If login fails, check whether the problem is you or the server:

```bash
curl https://auth.94-136-184-52.sslip.io/auth/health
```

A healthy server answers `{"ok":true,"ts":"..."}`. Anything else — timeout,
502 — means the staging box is down and **no amount of local fixing will help**.
Ask the team.

---

## First aid — the five things that actually go wrong

| What you see                                          | What it means                                 | Do this                                                              |
| ----------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| First build fails in `createBundleReleaseJsAndAssets` | Empty bundler cache — normal on a new machine | **Run the build again**                                              |
| `JAVA_HOME is not set` / `jvm.cfg` error              | Step 1 pointed at the wrong folder            | Find your real `jbr` folder, re-set `JAVA_HOME`, open a new terminal |
| Weird runtime crashes, calls or database broken       | Patches were skipped during install           | `rm -rf node_modules && npm install` (no `--ignore-scripts`)         |
| `adb devices` shows nothing                           | USB debugging off, or cable is charge-only    | Re-check Developer options; try another cable                        |
| App opens but login times out                         | Staging server is down                        | `curl` the health URL above                                          |

Still stuck? **Part 3 (§1a.12)** has a 21-row troubleshooting matrix and a
clean-slate escalation ladder.

---

## What you did NOT have to do (and why)

New developers often go looking for these. They do not exist here, on purpose.

| You did not…              | Because                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Set up a database         | The app never talks to a database. It talks to a server, and that server owns the database credentials. |
| Fill in a `.env` file     | `.env.production` is committed and already holds the server addresses, map token and feature flags.     |
| Get any API keys          | The only keys the app carries are public ones — safe to ship inside an APK by design.                   |
| Run a backend             | You are using the shared staging servers.                                                               |
| Get a signing certificate | Local builds sign themselves with a debug key. You only need the real key to publish on Google Play.    |

**Everything below this line is reference material.** You do not need it to run
the app — come back when something breaks or when you need to change how the
build works.

---

# PART 2 — HOW IT WORKS (reference)

---

## 1a.0 Why it works on any machine with no configuration

Part 1 told you that you need no database, no secrets and no `.env` file. This
section is the evidence for that claim, and the detail behind it — useful when
you are handing the project to someone else, or when you need to know exactly
what a new developer must be given.

> **A fresh `git clone` on any machine with internet access builds an APK that is
> already wired to a live backend and a live database.** No `.env` file to fill
> in, no secret to obtain, no VPN, no SSH tunnel, no IP allowlist, no local
> Postgres. Install the toolchain, `npm install`, build, install on a phone — the
> app logs in, sends messages, and places calls against the staging stack.

### Why it works out of the box

Three things are **deliberately committed** to the repository, and together they
are everything the client needs to connect:

| Committed file                     | Supplies                                                                                                                                                                                                 | Consequence                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `.env.production`                  | `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_MSG_BASE_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_MAPBOX_TOKEN`, `EXPO_PUBLIC_AUTO_DISPATCH`, `EXPO_PUBLIC_DEPT_CHAT_V2` | Endpoints, database access, maps and feature flags are baked into any release build automatically |
| `android/app/google-services.json` | FCM sender id, API key, app id                                                                                                                                                                           | Push wake-ups work — calls and messages reach a locked phone                                      |
| `GoogleService-Info.plist`         | Same, for iOS                                                                                                                                                                                            | Same, on iOS                                                                                      |

None of these are private. The Supabase **anon** key is public by design (RLS
enforces row access); the Mapbox token is a publishable `pk.` token; Firebase
config keys are documented by Google as safe to distribute. The dangerous
counterparts — `SUPABASE_SERVICE_ROLE_KEY`, `JWT_ACCESS_SECRET`,
`SENDER_CERT_PRIVATE_KEY_B64` — live only on the servers and appear nowhere in
the client.

### Live proof (probed 2026-08-22, from a normal internet connection)

```
auth-service   GET  https://auth.94-136-184-52.sslip.io/auth/health
               -> HTTP 200 in 1.21s   {"ok":true,"ts":"2026-08-22T10:27:55.404Z"}

database path  POST https://auth.94-136-184-52.sslip.io/auth/login   (bogus account)
               -> HTTP 200 in 0.55s   {"userId":null,"otpSentTo":null,"devOtpCode":null}
                  A user lookup ran against Postgres and found nothing. A dead
                  database answers 500, not a well-formed null result.
                  (The nulls are deliberate anti-enumeration: the endpoint does not
                  reveal whether an account exists.)

messenger relay GET https://relay.94-136-184-52.sslip.io/envelopes
               -> HTTP 401 in 0.90s   correct - unauthenticated, service is up

ops console    GET  https://ops.94-136-184-52.sslip.io/login
               -> HTTP 200 in 1.28s

Supabase       GET  https://qkkfkicgoncxslbwhyhz.supabase.co/auth/v1/health
               -> HTTP 200            {"version":"v2.195.0","name":"GoTrue"}
               GET  /rest/v1/  -> HTTP 401 {"message":"Invalid API key",
                    "hint":"Only the `service_role` API key can be used for this endpoint."}
                  Benign. The PostgREST *root* endpoint requires service_role;
                  ordinary table reads with the anon key are unaffected.
```

Every tier answers. Nothing here is behind a firewall the new developer would
have to be added to.

### Connectivity matrix — what each build mode talks to

```
                     MODE A                MODE B                 MODE C
                     STAGING BUILD         LOCAL FULL STACK       DEBUG + METRO
                     (recommended)         (backend work only)    (UI iteration)
                  ---------------------------------------------------------------
 command           npm run apk:staging     npm run apk:local      npm run android
                   (or bare gradlew)                              + npm start

 API endpoint      auth.94-136-...         127.0.0.1:3001         from .env
                   .sslip.io               (via adb reverse)      (usually local)

 Relay / WS        relay.94-136-...        127.0.0.1:3100         from .env
                   .sslip.io               (via adb reverse)

 Database          Supabase cloud          local Supabase         depends on .env
                   (shared staging DB)     (npx supabase start,
                                            port 54322)

 Redis             on the Contabo box      your machine, :6379    n/a / local
                                           (Windows: use 7379)

 TURN / calls      coturn on Contabo       coturn via docker      as configured
                                           compose

 Push (FCM)        works                   works                  works
                   (google-services.json is committed - same in all modes)

 SETUP REQUIRED    none                    Docker + Supabase CLI  Metro running
                   just build              + Redis + 2 services   + adb reverse 8081
                                           + adb reverse x5

 TIME TO WORKING   ~30 min (mostly the     ~90 min first time     ~30 min
                   first native build)

 SECRETS NEEDED    none                    backend .env values    none
                                           (out-of-band)
```

**For a handover, Mode A is the answer.** Modes B and C exist for people changing
backend code; they are not required to get a working app.

### The ten-minute path on a brand-new machine

```bash
# prerequisites: JDK 17 or 21, Node >= 20, Android SDK 36, adb  (see 1a.3)
git clone https://github.com/omnidevxstudiobit/Bravo_Secure.git bravo-secure
cd bravo-secure
npm install                      # runs patch-package - do NOT skip scripts
npm run apk:staging              # ~9-18 min for the first native build
adb install -r android/app/build/outputs/apk/release/app-release.apk
# open the app -> register / log in -> it is already talking to staging
```

There is no step where a secret is typed in. If someone asks "where do I put the
database password?", the answer is that a mobile client never has one — the
device holds a JWT, and only `auth-service` holds `DATABASE_URL`.

### What must still be handed over separately, and what each unlocks

Nothing in this list is needed to _run_ the app. Each unlocks one specific
capability beyond that.

| Item                                              | Needed for                                  | Needed to get a working app? |
| ------------------------------------------------- | ------------------------------------------- | ---------------------------- |
| GitHub access to `omnidevxstudiobit/Bravo_Secure` | Getting the source at all                   | **Yes**                      |
| `ENV_SETUP.md` (gitignored, out-of-band)          | Running the backends locally, server work   | No                           |
| Firebase service-account JSON                     | _Uploading_ builds to App Distribution      | No                           |
| Upload keystore + `BRAVO_UPLOAD_*` passwords      | Publishing to Google Play                   | No                           |
| Contabo SSH key (`Staging.pem`)                   | Deploying or restarting the backends        | No                           |
| Supabase project access                           | Running migrations, reading the DB directly | No                           |
| Apple Developer / ASC key                         | iOS TestFlight builds                       | No                           |
| A test account on staging                         | Logging in without self-registering         | No - you can register        |

### Honest limits of "it just works"

1. **The staging database is shared.** Everyone building Mode A points at the
   same Supabase project and the same Contabo box. Two developers testing
   destructive flows will see each other's data. There is no per-developer
   environment.
2. **Staging is a single box** (`94.136.184.52`, 4 vCPU / 8 GB) running both
   services, Redis, coturn and the console. If it is down, every Mode A build is
   down with it. There is no second environment to fail over to (see the parent
   document, section 1.17 item 2 - no UAT tier exists).
3. **The endpoints are `sslip.io` hostnames over a raw IP.** They resolve
   publicly and carry TLS, but they are tied to that IP - if the box is ever
   replaced, `.env.production` and the `apk:staging` script must both be updated
   or every new build silently points at nothing.
4. **A debug-signed APK cannot be published.** Mode A produces a debug-signed
   artefact unless `BRAVO_UPLOAD_STORE_FILE` is set (section 1a.8). Fine for
   device testing and Firebase App Distribution; rejected by Play.
5. **Push needs a real device.** FCM wake-ups do not arrive on most emulators
   without Play Services; calls and locked-screen notifications must be tested on
   hardware.
6. **Two accounts, two devices.** Messaging and calling cannot be exercised
   single-device - the E2EE flows need a real second endpoint.

---

## 1a.1 What "a working mobile version" actually requires

A release APK is not one build — it is **six chained stages**, each with its own
inputs, its own failure mode, and its own artefact. A break in any one of them
produces an APK that installs fine and then behaves wrongly, which is why the
verification stage (§1a.10) is not optional.

```
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │                    BRAVO SECURE — LOCAL RELEASE APK PIPELINE                   │
 └───────────────────────────────────────────────────────────────────────────────┘

  STAGE 0            STAGE 1            STAGE 2             STAGE 3
  TOOLCHAIN          INSTALL            NATIVE PROJECT      JS BUNDLE
 ┌──────────┐      ┌───────────┐      ┌──────────────┐    ┌────────────────┐
 │ JDK 17/21│      │ npm       │      │ expo         │    │ expo           │
 │ Node ≥20 │─────▶│ install   │─────▶│ prebuild     │───▶│ export:embed   │
 │ Android  │      │  ↓        │      │ (CNG)        │    │  ↓             │
 │  SDK 36  │      │ postinstall      │  ↓           │    │ Metro graph    │
 │ ANDROID_ │      │ patch-    │      │ app.json  +  │    │  ↓             │
 │  HOME    │      │ package   │      │ plugins/  →  │    │ Babel          │
 │ JAVA_HOME│      │ (10)      │      │ android/     │    │ (prod env:     │
 └──────────┘      └───────────┘      └──────────────┘    │  strips        │
       │                 │                    │           │  console.log)  │
       │                 │                    │           │  ↓             │
       │                 │                    │           │ Hermes         │
       │                 │                    │           │ hermesc -O     │
       │                 │                    │           └────────┬───────┘
       │                 │                    │                    │
       │                 │                    │        assets/index.android.bundle
       │                 │                    │                8.8 MB
       ▼                 ▼                    ▼                    ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │  STAGE 4 — GRADLE  ./gradlew assembleRelease            ~9–18 min           │
 │                                                                             │
 │   :app:generateCodegenArtifactsFromSchema   (new arch / TurboModules)       │
 │   :app:createBundleReleaseJsAndAssets       (invokes STAGE 3)               │
 │   :app:compileReleaseKotlin                 (13 Bravo*.kt native modules)   │
 │   :app:mergeReleaseNativeLibs               (4 ABIs → 443 MB of .so)        │
 │   :app:processReleaseGoogleServices         (google-services.json → FCM)    │
 │   :app:packageRelease                       (zip + sign)                    │
 │   :app:uploadCrashlyticsMappingFileRelease                                  │
 └───────────────────────────────┬─────────────────────────────────────────────┘
                                 │
                    STAGE 5 — SIGN (inside packageRelease)
                                 │
                 ┌───────────────┴────────────────┐
                 │ BRAVO_UPLOAD_STORE_FILE set?   │
                 └───────┬────────────────┬───────┘
                    yes  │                │  no
                         ▼                ▼
                 upload keystore     debug.keystore
                 SHIPPABLE           NOT shippable to Play
                                     (loud gradle warning)
                                 │
                                 ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │  ARTEFACT                                                                   │
 │  android/app/build/outputs/apk/release/app-release.apk        492.4 MB      │
 │  android/app/build/outputs/apk/release/output-metadata.json                 │
 └───────────────────────────────┬─────────────────────────────────────────────┘
                                 │
       STAGE 6 — INSTALL + VERIFY │
                                 ▼
        adb install -r      →   grep the bundle for baked URLs + feature strings
        (~3–6 min at this size)   → confirm versionCode  → smoke the app
```

**The stage that silently produces a wrong-but-working app is Stage 3.** The JS
bundle bakes in `EXPO_PUBLIC_*` values — API endpoints, the Mapbox token, feature
flags. Nothing downstream checks them, the APK installs, the app opens, and it
talks to the wrong backend with half its features compiled out. §1a.10 exists for
exactly this.

---

## 1a.2 Build-input entity map (ER-style)

Which file feeds which stage, and what it determines. Read this before changing
any config — most "my build didn't pick that up" questions are answered here.

```
                          ┌──────────────────────┐
                          │      app.json        │
                          │  expo.version 1.0.245│──┐
                          │  expo.android.*      │  │  (1) ──▶ AndroidManifest
                          │  expo.plugins[15]    │  │           permissions, package
                          └──────────┬───────────┘  │
                                     │ (1:N)        │
                                     ▼              │
                          ┌──────────────────────┐  │
                          │   plugins/*.js (3)   │  │
                          │ withVoipCallKit      │──┼──▶ generated ios/ + android/
                          │ withIosBuildFixes    │  │    (CNG injection)
                          │ withBravoFrameCryptor│  │
                          └──────────────────────┘  │
                                                    │
   ┌────────────────────────┐                       │
   │ android/gradle.properties│──(1:1)──────────────┼──▶ JVM heap, worker cap,
   │  jvmargs 4g/1g          │                      │    ABI list, Hermes, newArch
   │  workers.max 3          │                      │
   │  reactNativeArchitectures│                     │
   │  hermesEnabled / newArch │                     │
   └────────────────────────┘                       │
                                                    │
   ┌────────────────────────┐                       │
   │ android/build.gradle    │──(1:N)───────────────┼──▶ plugin classpaths,
   │  playServicesLocation   │                      │    repos, version pins
   │   21.3.0 (forced)       │                      │
   └────────────────────────┘                       │
                                                    │
   ┌────────────────────────┐                       │
   │ android/app/build.gradle│◀──(N:1)──────────────┘
   │  versionCode 287        │
   │  versionName "1.0.245"  │──(1:1)──▶ output-metadata.json ──▶ the APK
   │  applicationId          │
   │  signingConfigs{}       │──(1:1)──▶ APK signature
   │  firebaseAppDistribution│──(0:1)──▶ upload task
   └───────────┬────────────┘
               │ (reads)
               ▼
   ┌────────────────────────┐
   │ google-services.json    │──(1:1)──▶ FCM sender id, API key, app id
   │ (force-added to git)    │            → push wake-ups work
   └────────────────────────┘

   ────────────── JS SIDE ──────────────

   ┌────────────────────────┐
   │ process.env (cross-env) │  precedence 1  ─┐
   ├────────────────────────┤                 │
   │ .env.production.local   │  precedence 2  ─┤
   ├────────────────────────┤                 ├──▶ @expo/env ──▶ EXPO_PUBLIC_*
   │ .env.local              │  precedence 3  ─┤                  inlined into
   ├────────────────────────┤                 │                  the JS bundle
   │ .env.production ✅committed│ precedence 4 ─┤                        │
   ├────────────────────────┤                 │                        ▼
   │ .env                    │  precedence 5  ─┘            assets/index.android.bundle
   └────────────────────────┘
                                    ▲
        ⚠ @expo/env NEVER overrides a var already in process.env.
          A cross-env prefix therefore BEATS every dotenv file.

   ┌────────────────────────┐
   │ babel.config.js         │──▶ env.production: transform-remove-console
   │                         │    (keeps error + warn — deliberate)
   │                         │──▶ module-resolver alias table (12 entries)
   └────────────────────────┘
   ┌────────────────────────┐
   │ metro.config.js         │──▶ package-exports resolution order
   │                         │    ['react-native','browser','require']
   └────────────────────────┘
   ┌────────────────────────┐
   │ patches/*.patch (10)    │──▶ applied by postinstall into node_modules/
   │                         │    BEFORE anything is bundled or compiled
   └────────────────────────┘
```

**Cardinality note that matters in practice:** `app.json` → `android/` is a
_generating_ relationship, not a _syncing_ one. Editing `app.json` does nothing
to an already-generated `android/` tree until you re-run `expo prebuild`. And
`versionName` lives in **both** `app.json` and `android/app/build.gradle` — they
are two separate rows that must be kept equal, which is the only reason
`scripts/release-apk.ps1` writes both.

---

## 1a.3 Stage 0 — toolchain prerequisites

| Tool            | Required                                                                                                                                                                         | Verify                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **JDK**         | **17 or 21** — Android Studio's bundled JBR. The README says 17; the machine that produces the shipped builds runs **OpenJDK 21.0.10** (JetBrains JBR) and AGP 8.x accepts both. | `"$JAVA_HOME/bin/java" -version`    |
| **Gradle**      | **8.14.3** (the wrapper — never install Gradle separately)                                                                                                                       | `cd android && ./gradlew --version` |
| **Node.js**     | ≥ 20 (root `engines` says ≥ 18). The build machine runs **v22.15.0** and it works.                                                                                               | `node --version`                    |
| **npm**         | ≥ 10 (machine: 10.9.2)                                                                                                                                                           | `npm --version`                     |
| **Android SDK** | Platform **36** + build-tools **36.x**. Machine has platforms 34/35/36/36.1 and build-tools 35.0.0/36.0.0/36.1.0/37.0.0.                                                         | `ls $ANDROID_HOME/platforms`        |
| **NDK**         | Version pinned by Expo SDK 54 (`ndkVersion`)                                                                                                                                     | installed by the first Gradle run   |
| **Disk**        | **~25 GB free** — see the warning below                                                                                                                                          | —                                   |
| **RAM**         | 16 GB comfortable, 8 GB works with the capped worker count                                                                                                                       |                                     |

> ⚠️ **Disk is a real constraint here, not boilerplate.** One release APK is
> **492 MB**, the debug APK is **340 MB**, and Gradle keeps intermediates for
> both variants plus a native-lib merge directory. A `~/.gradle` cache for this
> project runs to several GB. Building on a nearly-full disk fails deep inside
> `mergeReleaseNativeLibs` with an error that does not mention disk space.

### Machine environment variables

The repo ships a script that sets all of them permanently on Windows:

```powershell
npm run android:setup      # scripts/setup-android-env.ps1
```

> WARNING — **verified 2026-08-22: this script's JDK path is stale on the current
> build machine, and running it as-is would break the build.** It hardcodes
> `C:\Program Files\Android\Android Studio\jbr`, but Android Studio here lives at
> `E:\Android_Std`. The real `JAVA_HOME` is `E:\Android_Std\jbr` (OpenJDK 21.0.10),
> which is what Gradle uses and why builds succeed. The `C:\Program Files` path is a
> broken leftover: `java -version` resolved from `PATH` hits it and fails with
> `could not open ...\jbr\lib\jvm.cfg`.
>
> **Check `$JAVA_HOME` before running this script, and edit its `$jdk` variable to
> match your actual install.** Practical consequence today: `gradlew` is fine (it
> reads `JAVA_HOME`), but anything that shells out to bare `java` from `PATH` fails
> on this machine until the stale entry is removed.

It writes these to the **User** environment (restart the terminal afterwards):

| Variable           | Value it sets                                                   |
| ------------------ | --------------------------------------------------------------- |
| `ANDROID_HOME`     | `%LOCALAPPDATA%\Android\Sdk`                                    |
| `ANDROID_SDK_ROOT` | `%LOCALAPPDATA%\Android\Sdk`                                    |
| `JAVA_HOME`        | `C:\Program Files\Android\Android Studio\jbr`                   |
| `ANDROID_AVD_HOME` | `E:\AndroidAvd` _(moves AVDs off the system drive)_             |
| `GRADLE_USER_HOME` | `E:\.gradle` _(moves the cache off C:)_                         |
| `PATH` additions   | `%ANDROID_HOME%\platform-tools`, `\emulator`, `%JAVA_HOME%\bin` |

macOS / Linux equivalent:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"          # ~/Android/Sdk on Linux
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
```

Confirm before going further:

```bash
echo $JAVA_HOME                        # must point at a REAL jbr/jdk
"$JAVA_HOME/bin/java" -version         # 17.x or 21.x - use this, not bare `java`
node --version                          # v20+ (v22.15.0 verified working)
adb --version
echo $ANDROID_HOME
cd android && ./gradlew --version       # confirms which JVM Gradle will actually use
```

Real output from the build machine (2026-08-22):

```
Gradle 8.14.3
Launcher JVM:  21.0.10 (JetBrains s.r.o.)
Daemon JVM:    E:\Android_Std\jbr (no JDK specified, using current Java home)
OS:            Windows 11 10.0 amd64
```

The `Daemon JVM` line is the authoritative answer to "which Java is building this".
Check it first whenever a failure smells like a toolchain problem.

---

## 1a.4 Stage 1 — install dependencies (and why `postinstall` is load-bearing)

```bash
git clone https://github.com/omnidevxstudiobit/Bravo_Secure.git bravo-secure
cd bravo-secure
npm install
```

`npm install` runs `"postinstall": "patch-package"`, which re-applies **10
patches** into `node_modules`. These are not cosmetic — several fix native code
that is compiled into the APK:

| Patch                                      | What breaks without it                  |
| ------------------------------------------ | --------------------------------------- |
| `react-native+0.81.5.patch`                | Core RN fixes                           |
| `react-native-webrtc+125.0.12.patch`       | Calls — the LiveKit WebRTC fork         |
| `react-native-callkeep+4.3.16.patch`       | Native incoming-call UI                 |
| `react-native-incall-manager+4.2.1.patch`  | In-call audio routing                   |
| `react-native-quick-crypto+0.7.17.patch`   | Native crypto primitives                |
| `react-native-argon2+4.0.0.patch`          | Argon2 KDF (backup password derivation) |
| `@op-engineering+op-sqlite+14.1.4.patch`   | SQLCipher-encrypted local database      |
| `@stripe+stripe-react-native+0.50.3.patch` | Payments                                |
| `expo-constants+18.0.13.patch`             | Expo constants                          |
| `whatwg-fetch+3.6.20.patch`                | Fetch polyfill                          |

> ⚠️ **Never install with `--ignore-scripts`.** You get a tree that compiles and
> then misbehaves at runtime — the worst possible failure mode. If you see patch
> errors during install, **stop and fix them**; do not proceed to Gradle.

Only the root install is needed for an APK. The two NestJS services and the ops
console have their own `node_modules` and are irrelevant to the mobile build.

---

## 1a.5 Stage 2 — the native project (`android/`)

`android/` is **gitignored**, with **21 files force-added** because they contain
hand-written code Expo's generator does not produce.

### If `android/` is already present (normal case after clone)

The 21 tracked files come down with the clone. Everything else in `android/`
(Gradle wrapper, the rest of the generated project) is produced on first build.
**You do not need to run `expo prebuild`** — go straight to Stage 4.

### If you need to regenerate it

```bash
npx expo prebuild --platform android
```

> ⚠️ **`--clean` will delete the 21 tracked files.** After any `prebuild --clean`,
> immediately restore them:
>
> ```bash
> git checkout -- android/
> git status --porcelain android/     # should be empty
> ```
>
> The five Kotlin native modules (`BravoCallForegroundModule` +
> `CallForegroundService`, `BravoFrameCryptorModule`, `BravoRingtoneModule`,
> `BravoCallVolumeModule`, `BravoBatteryOptimizationModule`) plus
> `MainActivity.kt`, `MainApplication.kt`, the manifest, `colors.xml`,
> `styles.xml`, `ic_stat_bravo.xml`, `google-services.json` and the three
> `.gradle` files are all in that set. Losing any of them yields a build that
> compiles but has no foreground call service, no SFrame encryption, or no push.

> ⚠️ **Adding a new native file needs `git add -f`.** Because `android/` is
> ignored, a plain `git add` silently skips it and the next clone will not build
> the same app. This has bitten the project before (`colors.xml`, B-62..B-70).

### Fixed build configuration you inherit

From `android/gradle.properties`:

| Property                                 | Value                                  | Why                                                                                                                                  |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `org.gradle.jvmargs`                     | `-Xmx4096m -XX:MaxMetaspaceSize=1024m` | v1.0.16's `packageRelease` hit **JVM Metaspace OOM** at 512 m — the RN graph + Kotlin compiler + Lint together exceed it.            |
| `org.gradle.parallel`                    | `true`                                 |                                                                                                                                      |
| `org.gradle.workers.max`                 | **`3`**                                | A _background_ Gradle build on Windows crashes spawned workers with **exit `0xc0000142`** (DLL init) when unbounded. Local-only cap. |
| `reactNativeArchitectures`               | `armeabi-v7a,arm64-v8a,x86,x86_64`     | All four → a universal APK. This is the single biggest size lever (§1a.7).                                                           |
| `newArchEnabled`                         | `true`                                 | TurboModules + Fabric.                                                                                                               |
| `hermesEnabled`                          | `true`                                 | JS is compiled to Hermes bytecode.                                                                                                   |
| `edgeToEdgeEnabled`                      | `true`                                 | Mandatory here — it is why the keyboard-inset rule exists.                                                                           |
| `expo.useLegacyPackaging`                | `false`                                | Native libs stored **uncompressed** in the APK (faster load, bigger file).                                                           |
| `android.enablePngCrunchInReleaseBuilds` | `true`                                 |                                                                                                                                      |

From `android/build.gradle` — a pin worth knowing:

```groovy
force "com.google.android.gms:play-services-location:21.3.0"
```

> Without it, `react-native-geolocation-service` falls back to 18.0.0 where
> `FusedLocationProviderClient` is a **class**, while firebase-messaging pulls
> 21.x where it is an **interface** → runtime `IncompatibleClassChangeError` the
> moment the user taps "Locate Me". Do not relax this pin.

From `android/app/build.gradle` — defaults in effect:

| Setting                    | Effective value       | Note                                                                |
| -------------------------- | --------------------- | ------------------------------------------------------------------- |
| `applicationId`            | `com.bravosecure.app` |                                                                     |
| `versionCode`              | `287`                 | must match `output-metadata.json` after build                       |
| `versionName`              | `1.0.245`             | must equal `app.json` → `expo.version`                              |
| `minSdkVersion`            | **24**                | Android 7.0                                                         |
| `compileSdk` / `targetSdk` | **36**                | Android 16                                                          |
| `minifyEnabled`            | **`false`** (default) | R8 off — override with `-Pandroid.enableMinifyInReleaseBuilds=true` |
| `shrinkResources`          | **`false`** (default) |                                                                     |
| `bundleCommand`            | `export:embed`        | Expo CLI bundles, not the bare RN CLI                               |

---

## 1a.6 Stage 3 — environment: the step that decides what the app talks to

This is the stage that produces a _wrong-but-working_ app if you get it wrong.

### Precedence — memorise this one rule

```
     ┌──────────────────────────────────────────────────────────────────┐
     │  @expo/env NEVER overrides a variable already in process.env.    │
     └──────────────────────────────────────────────────────────────────┘

  cross-env prefix (npm script)   ██████████████████████  WINS
  .env.production.local           ████████████
  .env.local                      ██████████
  .env.production   (committed)   ████████
  .env                            ██████
```

So:

- `npm run apk:staging` → the inline `cross-env` values win; `.env.production` is
  ignored for those keys.
- A bare `cd android && ./gradlew assembleRelease` → nothing is in `process.env`,
  so **`.env.production` is what gets baked**.
- `npm run android` (debug) bundles in _development_ mode and never reads
  `.env.production` at all — local dev keeps using `.env` and `127.0.0.1`.

### What `.env.production` contains (it is committed, deliberately)

`EXPO_PUBLIC_*` only — values that are compiled into every shipped APK anyway:

```
EXPO_PUBLIC_API_BASE_URL=https://auth.94-136-184-52.sslip.io
EXPO_PUBLIC_MSG_BASE_URL=https://relay.94-136-184-52.sslip.io
EXPO_PUBLIC_SUPABASE_URL=https://qkkfkicgoncxslbwhyhz.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=…            # public by design; RLS enforces access
EXPO_PUBLIC_MAPBOX_TOKEN=pk.…              # publishable token
EXPO_PUBLIC_AUTO_DISPATCH=true
EXPO_PUBLIC_DEPT_CHAT_V2=true
```

> ⚠️ **Feature-flag lockstep — bug B-51, and it shipped.** Those last two flags
> once existed **only** inline in the `apk:staging` npm script. The Firebase
> release pipeline (`release-apk.ps1` → bare `gradlew`) bakes `.env.production`
> instead — so **v1.0.100 shipped with both flags silently OFF** and the
> Departmental module vanished for providers. **Any new `EXPO_PUBLIC_*` flag must
> be added to BOTH** the `apk:staging` script line **and** `.env.production`.

### Babel production env

`babel.config.js` applies `transform-remove-console` **only** under
`env.production`, and excludes `error` and `warn`. That is deliberate:
`console.warn` survives release builds, which is what makes the on-device
performance probes (`[LAGDIAG]`) and Crashlytics breadcrumbs usable in the only
build worth measuring.

---

## 1a.7 Stage 4 — Gradle: pick your command

### Decision tree

```
                    What do you need the APK for?
                                │
     ┌──────────────────┬───────┴────────┬───────────────────────┐
     │                  │                │                       │
  Fast local        Test against     Ship to QA testers      Publish to
  iteration          staging          (Firebase)            Google Play
     │                  │                │                       │
     ▼                  ▼                ▼                       ▼
 npm run android   npm run          npm run release        EAS profile
 (debug, Metro)    apk:staging      (bump+build+upload)    "production"
     │                  │                │                       │
  ~340 MB           ~492 MB          ~492 MB                AAB, autoIncrement
  debug-signed      debug-signed     debug-signed*          MUST set
  JS from Metro     JS baked         JS baked               BRAVO_UPLOAD_*
                                     * unless upload key set
```

### The commands

```bash
# ── Debug build, JS served live from Metro (fastest inner loop) ──
npm run android                 # expo run:android
npm start                       # Metro, if not auto-started

# ── Release APK pointed at Contabo staging ──
npm run apk:staging

# ── Release APK pointed at 127.0.0.1 (with adb reverse) ──
npm run apk:local

# ── Release APK + Firebase App Distribution upload ──
npm run apk:dist                # gradle assembleRelease + appDistributionUploadRelease

# ── The full managed pipeline (recommended for anything shipped) ──
npm run release                                 # auto-bump patch
npm run release -- -Version 1.0.246             # explicit version
npm run release -- -SkipUpload                  # build only
npm run release -- -SkipBuild                   # bump versions only
npm run release -- -Force                       # skip the preflight gate

# ── Raw Gradle (what all of the above eventually call) ──
cd android
./gradlew assembleRelease                       # or gradlew.bat on Windows
```

### What `npm run release` actually does

```
 scripts/release-apk.ps1
  │
  ├─ 0. PRE-FLIGHT (skippable with -Force / -SkipPreflight)
  │     ├─ git status --porcelain      → WARN only (tally of dirty files)
  │     ├─ jest --selectProjects messenger-crypto   → BLOCKS on failure
  │     └─ tsc --noEmit vs .tsc-baseline.json (47)  → BLOCKS on regression
  │
  ├─ 1. VERSION BUMP  (both files, kept in lockstep)
  │     ├─ app.json                     expo.version
  │     └─ android/app/build.gradle     versionCode +1, versionName
  │
  ├─ 2. cd android && gradlew.bat assembleRelease        ~9m20s measured
  │
  ├─ 3. REPORT  android/app/build/outputs/apk/release/app-release.apk  + size
  │
  └─ 4. DISTRIBUTE (unless -SkipUpload)
        firebase appdistribution:distribute <apk>
          --app 1:150226560672:android:ff3a71dcdb542556818bc5
          --project bravo-734da
          --groups qa
        Auth: GOOGLE_APPLICATION_CREDENTIALS = the repo-root service-account JSON.
        It temporarily moves aside ~/.config/configstore/firebase-tools.json
        (firebase-tools prefers a cached interactive login over the service
        account) and always restores it in a finally block.
```

> **Note on two upload paths.** `android/app/build.gradle` also applies the
> `com.google.firebase.appdistribution` Gradle plugin, configured from
> `FIREBASE_SERVICE_ACCOUNT` / `APP_DIST_TESTERS` / `APP_DIST_GROUPS` /
> `APP_DIST_NOTES`. `npm run apk:dist` uses that plugin task; `npm run release`
> uses the **Firebase CLI** instead. Both work; they are alternatives, not a
> sequence. (A stale comment inside `release-apk.ps1` claims the Gradle plugin is
> absent — it is not.)

### ⚠️ The two PowerShell traps in the release script

These have each cost a session and are the most likely thing to bite a newcomer
on Windows.

**(1) `NODE_ENV` must be set for the Gradle step, but NOT for the preflight.**

Expo emits a `NODE_ENV` warning on **stderr** during `export:embed`. Windows
PowerShell 5.1 wraps a native executable's stderr line in a `NativeCommandError`,
and with `$ErrorActionPreference = 'Stop'` at the top of the script that
**terminates the build on a warning**. But exporting `NODE_ENV=production`
_before_ the run breaks the Jest preflight instead. The working sequence:

```powershell
# 1. Run the gates yourself, with NODE_ENV unset
npm run typecheck
npx jest --selectProjects messenger-crypto      # twice — known flake

# 2. Then build with NODE_ENV set and the preflight skipped
$env:NODE_ENV = 'production'
$env:FIREBASE_SERVICE_ACCOUNT = "$PWD\bravo-734da-firebase-adminsdk-fbsvc-….json"
npm run release -- -SkipPreflight
```

Do **not** wrap the Gradle invocation in a stderr redirect (`2>&1`) — that is the
thing that converts a harmless warning into a fatal error.

**(2) A red preflight is often a Jest transform-cache corruption, not your code.**

The preflight has failed three times in a row with a _different_ failure set each
run (7 suites/34 tests → 2 suites/**0** tests → a third combination), while every
suite passed in isolation _and_ all of them passed together. Root cause: Babel
transform-cache misses on `node_modules/expo/virtual/env.js` and
`react-native/index.js` — a racing cache under parallel workers on Windows.

```bash
npx jest --clearCache        # took the run from flaky to 1957/1957
```

Do this **before** blaming a commit for a red preflight.

### Timing expectations

Measured on the build machine, 2026-08-22 (Gradle 8.14.3 / JDK 21 / `workers.max=3`):

| Build                                                  | Cold                                                 | Warm                                              |
| ------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------- |
| `npm run android` (debug, first ever)                  | 5–18 min                                             | ~30 s                                             |
| `assembleRelease` (universal, 4 ABIs)                  | **~9–18 min** (9m20s on a shipped build)             | ~6–9 min                                          |
| `assembleRelease -PreactNativeArchitectures=arm64-v8a` | —                                                    | **3m 9s** (measured)                              |
| `:app:createBundleReleaseJsAndAssets` alone            | **FAILED at 13m 39s** (cold Metro cache — see below) | **6m 2s** (measured; 203s bundling 3,128 modules) |
| `appDistributionUploadRelease`                         | ~1m37s                                               | —                                                 |
| `adb install -r` (492 MB APK)                          | 3–6 min over USB                                     | —                                                 |

> WARNING — **THE COLD-CACHE FIRST BUILD. This is the failure a new developer hits
> first, by definition, and Gradle's error names nothing useful.** Verified on this
> machine 2026-08-22: the very first `assembleRelease` on a cold Metro cache ran for
> **13m 39s** and died with
>
> ```
> > Task :app:createBundleReleaseJsAndAssets FAILED
> Execution failed for task ':app:createBundleReleaseJsAndAssets'.
> > Process 'command 'cmd'' finished with non-zero exit value 1
> ```
>
> The only clue is upstream in the log: `warning: Bundler cache is empty, rebuilding
(this may take a minute)`. **Just run it again.** The identical command with a warm
> cache bundled 3,128 modules in 203 s and reported `BUILD SUCCESSFUL in 6m 2s`; the
> subsequent full `assembleRelease` took `3m 9s`. Nothing about the toolchain, the
> `-P` flags, `NODE_ENV` or the shell was at fault.
>
> Budget **two** attempts and ~25 minutes for the first build on a new machine, and do
> not start debugging until the second one has also failed.

> WARNING — **NEVER PIPE A GRADLE BUILD, and never trust the wrapper's exit code.**
> Verified the hard way in this session: `./gradlew assembleRelease | tail -80`
> reported **exit 0 for a build that FAILED** (a shell pipeline returns the _last_
> command's status — `tail` succeeded), and the `tail` window simultaneously discarded
> the bundler's actual error, which prints earlier than the last 80 lines. This is the
> Android twin of the iOS `altool` trap in §1a.13. Always:
>
> ```bash
> ./gradlew assembleRelease --console=plain > build.log 2>&1
> echo "exit=$?"                      # a REAL Gradle exit code
> grep -E "BUILD (SUCCESSFUL|FAILED)" build.log     # the authoritative verdict
> ```
>
> **`BUILD SUCCESSFUL` / `BUILD FAILED` in the log is the verdict — not the exit
> status of whatever you wrapped Gradle in.**

---

## 1a.8 Stage 5 — signing

```
   ┌────────────────────────────────────────────────────────────────┐
   │  release {                                                     │
   │    hasUploadKey = BRAVO_UPLOAD_STORE_FILE present?             │
   │    signingConfig = hasUploadKey ? release : debug               │
   │  }                                                             │
   └────────────────────────────────────────────────────────────────┘
```

| Property                      | Read from                                                             |
| ----------------------------- | --------------------------------------------------------------------- |
| `BRAVO_UPLOAD_STORE_FILE`     | `gradle.properties`, `~/.gradle/gradle.properties`, `-P` flag, or env |
| `BRAVO_UPLOAD_STORE_PASSWORD` | same                                                                  |
| `BRAVO_UPLOAD_KEY_ALIAS`      | same                                                                  |
| `BRAVO_UPLOAD_KEY_PASSWORD`   | same                                                                  |

If the store file property is absent, Gradle **falls back to the debug keystore**
and prints:

```
WARNING: release build is DEBUG-SIGNED (BRAVO_UPLOAD_STORE_FILE not set). Not shippable to Play.
```

> This fallback is deliberate — it lets a local release build succeed without the
> production key. But it means **reading the build log is the only way to know
> whether your release APK is shippable.** A debug-signed APK is fine for Firebase
> App Distribution and for device QA; it is _trivially re-signable_ and Play will
> reject it.

Signing with the real key, without putting secrets on the command line:

```properties
# ~/.gradle/gradle.properties  (outside the repo)
BRAVO_UPLOAD_STORE_FILE=C:/keys/bravo-upload.keystore
BRAVO_UPLOAD_STORE_PASSWORD=…
BRAVO_UPLOAD_KEY_ALIAS=bravo-upload
BRAVO_UPLOAD_KEY_PASSWORD=…
```

Then verify what actually signed the APK:

```bash
"$ANDROID_HOME"/build-tools/36.0.0/apksigner.bat verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk
```

Real output for the APK currently in the build directory (verified 2026-08-22) -
this is exactly what **debug-signed** looks like:

```
Signer #1 certificate DN: CN=Android Debug, OU=Android, O=Unknown, L=Unknown, ST=Unknown, C=US
Signer #1 certificate SHA-256 digest: fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c
Signer #1 certificate SHA-1 digest:   5e8f16062ea3cd2c4a0d547876baa6f38cabf625
```

Any DN other than `CN=Android Debug` means a real upload key was used.

The upload keystore is **not in the repository** and must be transferred
separately. Losing it means you can never update the Play listing without Play
App Signing key reset.

---

## 1a.9 Stage 6 — install on a device

```bash
adb devices                     # confirm exactly one target
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

| Flag                | When                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `-r`                | Reinstall, keep app data. The normal case.                        |
| `-d`                | Allow version **downgrade** (needed when testing an older build). |
| _(uninstall first)_ | When the SQLCipher schema or keystore state must be reset.        |

> ⚠️ **Never uninstall the only device holding an account without booting the app
> first.** Uninstalling wipes the SQLCipher database and the keychain-held Signal
> identity. If that device is the only one holding the ratchet state, messages
> are unrecoverable except through the encrypted-backup restore path — and a
> restore that has never been exercised on that account is not a plan. Boot the
> app, confirm the backup is current, _then_ uninstall.

If you built `apk:local`, the phone must be able to reach your services:

```bash
adb reverse tcp:3001  tcp:3001     # auth-service
adb reverse tcp:3100  tcp:3100     # messenger-service
adb reverse tcp:8081  tcp:8081     # Metro (debug builds only)
adb reverse tcp:54321 tcp:54321    # Supabase API
adb reverse tcp:54322 tcp:54322    # Supabase Postgres
# or leave the watcher running:
npm run adb:watch
```

> ⚠️ **Wi-Fi AP isolation** blocks phone → PC on many networks, and Metro simply
> hangs with no error. If a debug build will not connect over Wi-Fi, **use USB**.
> It is not a code problem.

---

## 1a.10 Verify the APK before you trust it

**A version number does not catch a stale bundle, and nothing in the build fails
when the wrong environment is baked.** This is the gate that does.

### The four checks

```bash
cd "E:/Bravo Secure"

# 1. Version identity — did the bump actually land in the artefact?
cat android/app/build/outputs/apk/release/output-metadata.json
```

Real output from the current build:

```json
{
  "applicationId": "com.bravosecure.app",
  "variantName": "release",
  "elements": [{"versionCode": 287, "versionName": "1.0.245", "outputFile": "app-release.apk"}],
  "minSdkVersionForDexing": 24
}
```

```bash
# 2. Freshness — APK mtime must be LATER than your last commit.
#    This is what catches a cached build being re-shipped.
ls -l --time-style=full-iso android/app/build/outputs/apk/release/app-release.apk
git log -1 --format=%ci
```

```bash
# 3. Environment — which backend is baked into the JS bundle?
python -c "
import zipfile
z = zipfile.ZipFile('android/app/build/outputs/apk/release/app-release.apk')
b = z.read('assets/index.android.bundle')
print('bundle %.1f MB' % (len(b)/1048576))
for pat in [b'sslip.io', b'127.0.0.1:3001', b'auth.94-136-184-52',
            b'relay.94-136-184-52', b'qkkfkicgoncxslbwhyhz']:
    print('  %-24s %d hit(s)' % (pat.decode(), b.count(pat)))
"
```

**Executed against the current APK — real output:**

```
bundle 8.8 MB
  sslip.io                 2 hit(s)
  127.0.0.1:3001           0 hit(s)
  auth.94-136-184-52       1 hit(s)
  relay.94-136-184-52      1 hit(s)
  qkkfkicgoncxslbwhyhz     1 hit(s)
```

Read that as: **two `sslip.io` hits = the staging API and relay URLs both took**,
zero localhost hits, Supabase project present. If you built `apk:staging` and see
`0 hit(s)` for `sslip.io`, the `EXPO_PUBLIC_*` env did not reach the bundler —
**do not ship it.** That is precisely the `release-apk.ps1` trap.

```bash
# 4. Content — is THIS session's code actually in there?
#    Grep the bundle for a string only your change introduces.
python -c "
import zipfile
b = zipfile.ZipFile('android/app/build/outputs/apk/release/app-release.apk').read('assets/index.android.bundle')
for s in [b'Departmental Chat', b'Not connected yet', b'Share to']:
    print('%-22s %s' % (s.decode(), 'FOUND' if s in b else '*** MISSING ***'))
"
```

### The four checks, run against a freshly built APK (2026-08-22)

Executed immediately after `BUILD SUCCESSFUL`, on the arm64-only artefact:

```
1. version identity   applicationId : com.bravosecure.app
                      versionCode   : 287
                      versionName   : 1.0.245
                      minSdkDexing  : 24                       PASS

2. freshness          APK mtime     : 2026-08-22 16:44:39
                      last commit   : 2026-08-21 23:41:28
                      APK is NEWER  -> a real rebuild            PASS

3. environment        bundle 8.8 MB
                      sslip.io             2 hit(s)
                      127.0.0.1:3001       0 hit(s)
                      auth.94-136-184-52   1 hit(s)
                      relay.94-136-184-52  1 hit(s)
                      qkkfkicgoncxslbwhyhz 1 hit(s)
                      -> staging API + relay + Supabase baked    PASS

4. ABI content        arm64-v8a  129.8 MB   (single ABI, as requested)
                      entries    2109                            PASS

5. signing            "WARNING: release build is DEBUG-SIGNED
                       (BRAVO_UPLOAD_STORE_FILE not set).
                       Not shippable to Play."
                      -> expected for a local build              PASS
```

The bundler log for the same build also confirms the §1a.6 precedence rule directly:

```
env: load .env.production .env
env: export EXPO_PUBLIC_SUPABASE_URL EXPO_PUBLIC_SUPABASE_ANON_KEY
            EXPO_PUBLIC_API_BASE_URL EXPO_PUBLIC_MSG_BASE_URL
            EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY EXPO_PUBLIC_MAPBOX_TOKEN
            EXPO_PUBLIC_GUARDIAN_API_KEY EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_PEM
            EXPO_PUBLIC_AUTO_DISPATCH EXPO_PUBLIC_DEPT_CHAT_V2
```

`.env.production` is loaded **before** `.env`, and both B-51 feature flags reach the
bundle. This is the observed mechanism behind the zero-config claim in §1a.0.

### Verification checklist

| #   | Check                                                | Pass condition                                 |
| --- | ---------------------------------------------------- | ---------------------------------------------- |
| 1   | `output-metadata.json` versionCode / versionName     | Matches the version you intended to build      |
| 2   | APK mtime vs last commit time                        | APK is **newer**                               |
| 3   | Bundle grep for the target backend host              | ≥ 1 hit; zero hits for the _wrong_ environment |
| 4   | Bundle grep for a string unique to this change       | FOUND                                          |
| 5   | Gradle log for the debug-signing warning             | Absent if you intended a shippable build       |
| 6   | Feature flags in `.env.production` and `apk:staging` | In lockstep (B-51)                             |

### Smoke test on the device (the minimum "working" bar)

1. App launches past the loading screen (BiometricGate → shield badge).
2. Log in — OTP arrives, session established.
3. Open a chat, **send and receive a 1:1 message** (exercises Signal session,
   SQLCipher write, relay round-trip).
4. **Send and receive a group message** (exercises group crypto + sealed sender).
5. Place a **1:1 call** and confirm audio both ways (WebRTC + TURN + CallKeep +
   the foreground service).
6. Open a map screen (Mapbox token took) and tap **Locate Me** (the
   play-services-location pin).
7. Background the app and confirm a push wake arrives (`google-services.json`
   took).

Steps 3–7 each cover a different native module. A build that passes 1–2 but fails
5 is usually a missing force-added Kotlin file (§1a.5).

---

## 1a.11 Size: why the APK is ~492 MB, and how to shrink it

Measured from the actual artefact:

| Metric                     | Value                        |
| -------------------------- | ---------------------------- |
| APK on disk                | **516,286,655 B = 492.4 MB** |
| Entries                    | 2,305                        |
| Uncompressed content       | 541 MB                       |
| JS bundle                  | 9,249,280 B = 8.8 MB         |
| Debug APK (for comparison) | 356,241,612 B = 339.7 MB     |

Native libraries, by ABI:

```
  arm64-v8a      ████████████████████  129.8 MB
  x86_64         ████████████████      110.1 MB     ← emulator only
  x86            ███████████████       109.1 MB     ← emulator only
  armeabi-v7a    █████████████          93.9 MB     ← very old devices
                                       ─────────
                                        442.9 MB
```

Three compounding causes:

1. **Universal APK** — `reactNativeArchitectures` lists all four ABIs, so every
   device carries three sets of libraries it can never execute.
2. **`expo.useLegacyPackaging=false`** — `.so` files are stored **uncompressed**
   (`extractNativeLibs=false`). Faster startup, larger file.
3. **`minifyEnabled=false`** by default — R8 is off, so nothing is stripped.

### Building a smaller / faster APK for local testing

```bash
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Every modern physical Android device is `arm64-v8a`. Use `x86_64` instead if you
are targeting an emulator.

**Measured, not estimated** — this exact command was run on 2026-08-22:

|             | Universal (4 ABIs)           | `-PreactNativeArchitectures=arm64-v8a` |
| ----------- | ---------------------------- | -------------------------------------- |
| APK size    | 516,286,655 B = **492.4 MB** | 186,217,104 B = **177.6 MB**           |
| Zip entries | 2,305                        | 2,109                                  |
| Native libs | 442.9 MB                     | **129.8 MB** (arm64-v8a only)          |
| JS bundle   | 8.8 MB                       | 8.8 MB (identical)                     |
| Build time  | ~9–18 min                    | **3m 9s** warm                         |

**A 64 % size reduction and a much faster build, for an artefact that runs on every
modern handset.** This is the single highest-value flag in this document for local
iteration.

Optional further reduction (**test thoroughly before shipping** — R8 can strip
reflectively-referenced classes, and this project has Hermes + native modules

- Crashlytics mapping upload in play):

```bash
./gradlew assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  -Pandroid.enableMinifyInReleaseBuilds=true \
  -Pandroid.enableShrinkResourcesInReleaseBuilds=true
```

For Play, the `production` EAS profile already builds an **app-bundle** (AAB),
which lets Play generate per-device splits — the correct fix for store
distribution.

---

# PART 3 — WHEN IT BREAKS

## 1a.12 Troubleshooting matrix

| Symptom                                                                                                                                | Cause                                                                                                                                                      | Fix                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **First ever build fails at `:app:createBundleReleaseJsAndAssets`** with `Process 'command 'cmd'' finished with non-zero exit value 1` | **Cold Metro bundler cache** (`warning: Bundler cache is empty, rebuilding` appears upstream in the log). VERIFIED 2026-08-22.                             | **Run it again.** Second attempt succeeded with no other change. Only investigate if attempt #2 also fails.                              |
| Gradle "succeeded" but there is no APK / a stale one                                                                                   | You piped Gradle (`\| tail`, `\| grep`) — the pipeline returns the _last_ command's exit code, masking `BUILD FAILED`, and the window drops the real error | `> build.log 2>&1`, read `$?` from Gradle, and grep the log for `BUILD SUCCESSFUL\|BUILD FAILED`                                         |
| A file you put in `app/build/outputs/apk/release/` vanished                                                                            | `assembleRelease` **cleans its own output directory**. VERIFIED — a backup `.apk.bak` placed there was deleted by the next build                           | Copy artefacts **outside** `android/app/build/` before rebuilding                                                                        |
| Worker crashes with **exit `0xc0000142`**                                                                                              | Unbounded Gradle workers on Windows (DLL init)                                                                                                             | `org.gradle.workers.max=3` is already set — do not raise it locally.                                                                     |
| **"Daemon will expire after running out of JVM Metaspace"**, then `IncrementalSplitterRunnable` dies in `packageRelease`               | Metaspace too small for RN graph + Kotlin + Lint                                                                                                           | `org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m` — already set.                                                                 |
| Preflight red, **different tests each run**, all pass in isolation                                                                     | Babel transform-cache race under parallel Jest workers on Windows                                                                                          | `npx jest --clearCache`, then re-run.                                                                                                    |
| Build dies on the **first stderr line** of `expo export:embed`                                                                         | PS 5.1 `NativeCommandError` + `$ErrorActionPreference='Stop'`                                                                                              | Set `NODE_ENV=production`; **never** wrap gradle in `2>&1`.                                                                              |
| Preflight fails immediately when `NODE_ENV=production` is exported                                                                     | Jest behaves differently under that env                                                                                                                    | Run the gates first with `NODE_ENV` unset, _then_ set it and use `-SkipPreflight`.                                                       |
| App runs but hits the **wrong backend**                                                                                                | `EXPO_PUBLIC_*` never reached the bundler                                                                                                                  | Check #3 in §1a.10. Build via the npm script, not bare `gradlew`.                                                                        |
| A **feature is missing** from a release build only                                                                                     | `EXPO_PUBLIC_*` flag missing from `.env.production` (B-51)                                                                                                 | Add it to **both** `.env.production` and the `apk:staging` script line.                                                                  |
| `IncompatibleClassChangeError` on **Locate Me**                                                                                        | `play-services-location` resolved to 18.0.0                                                                                                                | The `force "…:21.3.0"` in `android/build.gradle` must stay.                                                                              |
| No push wake-ups; FCM silent                                                                                                           | `google-services.json` missing or `applicationId` mismatch                                                                                                 | Confirm the file is present and its client entry is `com.bravosecure.app`.                                                               |
| No incoming-call UI / call dies when backgrounded                                                                                      | A force-added Kotlin file was lost (usually after `prebuild --clean`)                                                                                      | `git checkout -- android/`; confirm `git ls-files android/ \| wc -l` = 21.                                                               |
| Notifee dependency fails to resolve                                                                                                    | `notifee.app` remote 404 / unreachable                                                                                                                     | Already handled — `android/build.gradle` points at the bundled local maven repo under `node_modules/@notifee/react-native/android/libs`. |
| Release APK rejected by Play as debug-signed                                                                                           | `BRAVO_UPLOAD_STORE_FILE` unset → debug fallback                                                                                                           | Set the four `BRAVO_UPLOAD_*` properties (§1a.8) and re-check the gradle log.                                                            |
| Runtime crashes only in release, works in debug                                                                                        | `transform-remove-console` / Hermes / R8 differences                                                                                                       | Reproduce with `assembleRelease` + `adb logcat`; `console.warn` survives release and is your probe.                                      |
| Build fails deep in `mergeReleaseNativeLibs` with an unrelated error                                                                   | Disk full                                                                                                                                                  | Free space; one variant pair plus intermediates needs many GB.                                                                           |
| Native modules behave oddly after a fresh clone                                                                                        | `postinstall`/patch-package skipped                                                                                                                        | `npm install` again without `--ignore-scripts`; check for patch errors.                                                                  |
| `adb install` fails `INSTALL_FAILED_UPDATE_INCOMPATIBLE`                                                                               | Signature changed (debug ↔ upload key)                                                                                                                     | Uninstall first — **read the data-loss warning in §1a.9**.                                                                               |
| `adb install` fails `INSTALL_FAILED_VERSION_DOWNGRADE`                                                                                 | Installing an older `versionCode`                                                                                                                          | `adb install -r -d …`                                                                                                                    |

### Clean-slate escalation (in increasing order of cost)

```bash
# 1. Gradle only  (~2 min to re-run)
cd android && ./gradlew clean

# 2. Gradle + caches  (~10 min)
cd android && ./gradlew clean --refresh-dependencies
npx jest --clearCache

# 3. Node modules  (~5 min + full rebuild)
rm -rf node_modules && npm install          # re-applies the 10 patches

# 4. Regenerate the native project  (DANGEROUS — see §1a.5)
npx expo prebuild --platform android --clean
git checkout -- android/                    # ← MANDATORY, restores the 21 files
git status --porcelain android/             # must be empty
```

---

## 1a.13 iOS — pointer, not a procedure

iOS does **not** follow this pipeline and is not covered here beyond the entry
point, because `ios/` is not in the repository at all (`git ls-files ios/` → 0).

```bash
npx expo prebuild --platform ios     # generates ios/ from app.json + plugins/
npm run ios:release:check            # guards only, no compile — RUN THIS FIRST
npm run ios:release                  # archive → export → TestFlight
```

The one thing worth carrying over: **CallKit wiring lives in the generated `ios/`
tree and can vanish after a prebuild**, and shipping without it defeats the whole
VoIP feature. `scripts/ios-release.sh --check` exists to catch that plus three
other traps (hardcoded `Info.plist` versions ignoring `xcodebuild` overrides,
altool error 90592 from `ITSAppUsesNonExemptEncryption`, and altool exiting
non-zero inside a wrapper that still reports 0 — _the log is the only trustworthy
verdict_). Full procedure: `docs/runbooks/IOS_BUILD.md`.

---

## 1a.14 Quick reference card

```
 ── FIRST TIME ────────────────────────────────────────────────────────────
 npm run android:setup                # set ANDROID_HOME / JAVA_HOME / PATH  (Win)
 git clone … && cd bravo-secure
 npm install                          # runs patch-package — do NOT skip scripts
 java -version                        # must be 17

 ── DEBUG LOOP ────────────────────────────────────────────────────────────
 npm start                            # Metro
 npm run android                      # debug APK, live JS
 adb reverse tcp:3001 tcp:3001        # + 3100 / 8081 / 54321 / 54322
 npm run adb:watch                    # keeps the tunnels alive

 ── RELEASE APK (staging) ─────────────────────────────────────────────────
 npm run apk:staging
 # small/fast variant:
 cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a

 ── FULL SHIP PIPELINE ────────────────────────────────────────────────────
 npm run typecheck                              # gates first, NODE_ENV unset
 npx jest --selectProjects messenger-crypto     # twice (known flake)
 $env:NODE_ENV='production'
 $env:FIREBASE_SERVICE_ACCOUNT='<path to sa.json>'
 npm run release -- -SkipPreflight

 ── ARTEFACT ──────────────────────────────────────────────────────────────
 android/app/build/outputs/apk/release/app-release.apk        492 MB
 android/app/build/outputs/apk/release/output-metadata.json

 ── VERIFY (never skip) ───────────────────────────────────────────────────
 cat  …/output-metadata.json                    # versionCode / versionName
 ls -l --time-style=full-iso …/app-release.apk  # newer than last commit?
 <bundle grep from §1a.10>                      # right backend + your code in it
 grep -i "DEBUG-SIGNED" <gradle log>            # shippable or not

 ── INSTALL ───────────────────────────────────────────────────────────────
 adb install -r …/app-release.apk               # 3–6 min at this size
 # smoke: launch → login → 1:1 msg → group msg → call → map → push

 ── WHEN IT BREAKS ────────────────────────────────────────────────────────
 npx jest --clearCache                          # flaky preflight
 cd android && ./gradlew clean                  # first escalation
 git ls-files android/ | wc -l                  # must be 21
```

---

**End of §1a.** The parent section is
`docs/handover/01_SOURCE_CODE_AND_REPOSITORY.md` (§1.11 Build process);
architecture is `02_CODE_ARCHITECTURE_AND_APPLICATION_FLOW.md`; database is
`03_DATABASE_ARCHITECTURE.md`.
