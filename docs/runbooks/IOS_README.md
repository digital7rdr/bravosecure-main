# iOS Setup — Developer Handoff

**Status as of 2026-07-17.** The app builds and runs on a physical iPhone. It is not
yet in a shippable signing state. This document explains what works, what doesn't,
and the decisions that need to be made to finish.

For the build mechanics (patches, pods, known limitations), see
[`docs/runbooks/IOS_BUILD.md`](docs/runbooks/IOS_BUILD.md). This document is about
signing, bundle IDs, Firebase, and push — read it first.

---

## 1. Where things stand

|                                                       | Status                                             |
| ----------------------------------------------------- | -------------------------------------------------- |
| Builds (simulator + device)                           | Green                                              |
| Runs on physical iPhone                               | Yes                                                |
| Firebase Analytics / Crashlytics                      | Working                                            |
| Push notifications                                    | **Not working**                                    |
| Background modes (VoIP / audio / remote-notification) | **Not in the binary**                              |
| TestFlight / App Store                                | **Blocked**                                        |
| Current signing                                       | Personal team `622QE445GT`, **expires 2026-07-23** |

The current build is signed by an individual's personal Apple team as a stopgap. It
stops launching on **23 July 2026** and cannot be distributed.

---

## 2. The core problem

There are two Apple teams in play:

- **Org team `88X6H88A4R`** (Michele Cioffi) — the real Apple Developer Program account.
  This is what we need to sign with.
- **Personal team `622QE445GT`** — a free individual team.

The App ID `com.bravosecure.app` is **already registered to the personal team**. App IDs
are globally unique across all of Apple, so the org team cannot claim it while the
personal team holds it.

This happened by accident: building with a free personal team auto-creates the App ID.
There is no self-service way to release it — the Developer portal shows "Access
Unavailable" for free teams, the API is team-scoped, and Xcode has no UI for it.

**An Apple Support ticket has been filed** to release the ID. Expected 1–3 business
days, outcome not guaranteed.

Because the org team can't sign `com.bravosecure.app`, everything that requires a real
team is blocked: push notifications, background modes, TestFlight, App Store, and
profiles that last longer than 7 days.

---

## 3. Recommended fix: split the bundle IDs

**Do not wait for Apple.** Use a different bundle ID on iOS and unblock immediately:

- **iOS:** `com.bravosecure.mobile` (org team `88X6H88A4R`)
- **Android:** `com.bravosecure.app` (unchanged)

Different bundle IDs per platform is normal and fully supported. Bundle IDs are
invisible to users. A single Firebase project holds separate iOS and Android apps by
design — that's exactly what this is for.

This is **reversible**. If Apple releases `com.bravosecure.app`, point `app.json` back
at it and the `.mobile` Firebase app just goes unused. Filing the ticket and doing this
are not in conflict.

### Why this is safe here

The codebase was checked for bundle-ID assumptions. It is clean. The only real
dependency is APNs, and it is already an environment variable, not hardcoded:

```ts
// apps/messenger-service/src/push/push.service.ts:1163
const bundleId = process.env.APNS_VOIP_BUNDLE_ID;
```

The APNs topic is derived at runtime as `${bundleId}.voip`
(`apps/messenger-service/src/push/apnsClient.ts:109`), so it follows the env var. The
`com.bravosecure.app` visible in `apnsClient.ts:47` is a comment, not code.

Also verified:

- `ANDROID_PACKAGE_NAME=com.bravosecure` — biometric service, Android-only, unaffected.
- No universal links or associated domains — nothing to re-host, no
  `apple-app-site-association` to update.
- Remaining `com.bravosecure.app` matches in source are comments about Android logcat
  and `/sdcard/` paths.

> **One thing to confirm:** this verified the _code_. Check that no deployed staging or
> production environment has `APNS_VOIP_BUNDLE_ID` pinned to `com.bravosecure.app` in an
> env file outside the repo. If it does, iOS push fails **silently** rather than loudly.

### Android and Firebase App Distribution are NOT affected

Adding an iOS app to a Firebase project is **purely additive**. It cannot modify or break
existing apps. Concretely:

- **`google-services.json` only lists Android clients.** iOS config lives in a separate
  `GoogleService-Info.plist`. Adding an iOS app does not rewrite it — no re-download
  needed, no Android rebuild needed.
- **App Distribution targets an explicit app ID.** The Android pipeline uploads with
  `--app 1:150226560672:android:ff3a71dcdb542556818bc5`, which belongs to
  `com.bravosecure.app` (Android) and does not change. The
  `gradlew assembleRelease appDistributionUploadRelease` flow is untouched.
- **Testers and groups are per-app, not per-project.** The `qa` group stays attached to
  the Android app.

This project **already runs two Android apps in one Firebase project**
(`com.bravo.bravosecure` legacy + `com.bravosecure.app`), and distribution works. A third
app that happens to be iOS changes nothing.

> **Opportunity:** once iOS is on the org team, Firebase App Distribution works for iOS
> too, reusing the existing pipeline. It requires ad-hoc provisioning and testers' UDIDs
> registered in advance (an Apple constraint, not a Firebase one) — more friction than
> Android, but it delivers iOS builds to QA without waiting on TestFlight review.

---

## 4. Action items

| #   | Task                                                                                                                                                            | Owner                       | Blocked by |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------- |
| 1   | Firebase console → project `bravo-734da` → Add app → iOS → bundle ID `com.bravosecure.mobile`. Download `GoogleService-Info.plist`.                             | Whoever has Firebase access | —          |
| 2   | Apple Developer → Certificates, IDs & Profiles → **Keys** → new key with **APNs** enabled. Download the `.p8` (one download only — it cannot be re-downloaded). | Michele (org team)          | —          |
| 3   | **Register `com.bravosecure.mobile` as a new explicit App ID** with **Push Notifications** enabled. It does not exist yet — see the warning below.              | Michele (org team)          | —          |
| 4   | Upload the APNs key to Firebase → Project Settings → Cloud Messaging → iOS app.                                                                                 | Firebase access             | 1, 2       |
| 5   | `app.json` → set `ios.bundleIdentifier` to `com.bravosecure.mobile` and point `ios.googleServicesFile` at the new plist.                                        | Dev                         | 1          |
| 6   | messenger-service env → `APNS_VOIP_BUNDLE_ID=com.bravosecure.mobile` (all environments).                                                                        | Dev / ops                   | —          |
| 7   | Convert the `ios/Podfile` `USE_FRAMEWORKS` fix into an Expo config plugin **before** anyone runs prebuild. See §5.                                              | Dev                         | —          |
| 8   | `npx expo prebuild -p ios --clean`, rebuild, verify push end to end.                                                                                            | Dev                         | 5, 6, 7    |

**APNs keys are team-wide, not per-App-ID.** The `.p8` from step 2 works for
`com.bravosecure.mobile` now and for `com.bravosecure.app` later if Apple releases it.
This step never has to be redone.

### ⚠️ `com.bravosecure.mobile` does not exist yet — the wildcard is hiding this

Verified against the App Store Connect API on 2026-07-17, team `88X6H88A4R` has exactly
**one** App ID and **zero** provisioning profiles:

```
identifier: *   | UNIVERSAL | XC Wildcard   (id KK27SA59HK, no capabilities)
```

The `.mobile` build that signed and ran on a device did so against that **wildcard App
ID**, not a real one. This is easy to misread as "`.mobile` is already set up." It isn't.

**Wildcard App IDs cannot carry push notifications.** APNs requires an explicit App ID.
The same applies to app groups, associated domains, and most other entitlements. So
`com.bravosecure.mobile` must be _created_ as an explicit App ID with Push Notifications
enabled (action item 3) — enabling a capability on the wildcard is not possible.

Expect this failure mode: everything builds and installs fine on the wildcard, and push
just never arrives, with no signing error to point at.

---

## 5. Traps — read before touching the iOS build

### `ios/` is gitignored and generated

This is an Expo prebuild project. `app.json` is the source of truth; `ios/` is
regenerated from it. **Nothing in `ios/` is in version control.**

### Running prebuild right now will break the build

`ios/Podfile` carries a hand-added `USE_FRAMEWORKS` export that the entire build depends
on. React Native's `install_modules_dependencies` only adds the `React_*.framework`
header search paths when `ENV['USE_FRAMEWORKS']` is set — the Expo build property alone
is not enough.

`npx expo prebuild` regenerates the Podfile and **silently deletes this**. Since `ios/`
is gitignored, nothing restores it, and the build fails with
`react/utils/FollyConvert.h not found`.

**Convert it to a config plugin before prebuilding** (action item 7). The same applies to
the `react-native-xcode.sh` quoting fix in the generated Xcode project — the repo path
contains a space ("Office Work") and the unquoted path breaks the bundle phase.

### The current `ios/` folder is stale

It was scaffolded before `app.json` gained `aps-environment` and `UIBackgroundModes`, and
nothing has regenerated it since. So the built binary has **no entitlements file and no
background modes**, even though `app.json` declares them. Confirmed by inspecting the
built binary:

```
$ codesign -d --entitlements :- BravoSecure.app
application-identifier: 622QE445GT.com.bravosecure.app
com.apple.developer.team-identifier: 622QE445GT
get-task-allow: true
# no aps-environment

$ PlistBuddy -c "Print :UIBackgroundModes" BravoSecure.app/Info.plist
# empty
```

This is why CallKeep and WebRTC won't survive backgrounding on the current build — a
separate issue from the push blocker, fixed by the same prebuild.

### The Xcode project disagrees with `app.json`

`ios/BravoSecure.xcodeproj` currently says `PRODUCT_BUNDLE_IDENTIFIER =
com.bravosecure.mobile` and `DEVELOPMENT_TEAM = 88X6H88A4R`, but the last build produced
`com.bravosecure.app` because those were passed as command-line overrides:

```sh
xcodebuild -workspace BravoSecure.xcworkspace -scheme BravoSecure -configuration Debug \
  -destination 'generic/platform=iOS' \
  PRODUCT_BUNDLE_IDENTIFIER=com.bravosecure.app DEVELOPMENT_TEAM=622QE445GT \
  CODE_SIGN_STYLE=Automatic ENABLE_USER_SCRIPT_SANDBOXING=NO build
```

**Building from Xcode directly, or via `npm run ios`, produces `com.bravosecure.mobile`
signed by the org team — which does not match the current Firebase plist, so Firebase
init fails at launch.** Adopting §3 resolves this permanently by making the project file
correct.

### Personal-team builds expire every 7 days

Free provisioning profiles are 7-day. The current one expires **2026-07-23**. Moving to
the org team makes this go away (org profiles last a year).

---

## 6. Reference

|                           |                                                                    |
| ------------------------- | ------------------------------------------------------------------ |
| Org team (Michele Cioffi) | `88X6H88A4R`                                                       |
| Personal team (stopgap)   | `622QE445GT`                                                       |
| Firebase project          | `bravo-734da` (number `150226560672`)                              |
| App Store Connect API key | `S6379ZCA56`                                                       |
| Toolchain verified        | Xcode 26.6, iOS 26.5 SDK, CocoaPods 1.17.0, RN 0.81.5, Expo SDK 54 |

The App Store Connect API key path has been used to register devices and manage signing
without portal access — useful because the Apple ID in use is an App Store Connect user
(Admin) with no Developer Program team membership, so Xcode shows only the personal team
and "Unknown Name (88X6H88A4R)". That's cosmetic; the API key path works.

### Cannot run on the iOS Simulator

`@react-native-ml-kit/face-detection` → GoogleMLKit ships no arm64-simulator slice, and
Xcode 26's simulator runtime no longer accepts x86_64 apps. **Builds** on simulator are
fine (that's the CI gate); **running** requires a real device. See
[`docs/runbooks/IOS_BUILD.md`](docs/runbooks/IOS_BUILD.md) §"Known limitation".
