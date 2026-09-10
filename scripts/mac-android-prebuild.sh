#!/usr/bin/env bash
#
# mac-android-prebuild.sh — reconstitute a buildable android/ tree on macOS.
#
# WHY THIS EXISTS
# ---------------
# `android/` is gitignored; only a curated subset was force-added to the repo.
# A fresh clone / zip download is therefore MISSING the generated scaffolding
# (settings.gradle, the Gradle wrapper, res/values/strings.xml, mipmap launcher
# icons, splash drawables, debug.keystore) and will not build.
#
# `npx expo prebuild` regenerates all of that — but it also OVERWRITES the
# curated files, and three of them fail SILENTLY when lost:
#   * AndroidManifest.xml       hand-injected CallForegroundService, CallKeep
#                               VoiceConnectionService, notifee location FGS,
#                               Mapbox androidx.startup removals,
#                               enableOnBackInvokedCallback="false".
#   * android/build.gradle      play-services-location 21.3.0 pin, notifee local
#                               maven, Mapbox maven, AppDistribution+Crashlytics.
#   * android/app/build.gradle  BRAVO_UPLOAD_* signing, firebaseAppDistribution,
#                               versionCode/versionName.
#   * MainApplication.kt        6 native package registrations + the WebRTC
#                               AEC3 AudioDeviceModule override (B-420).
#
# So: back up the curated files, prebuild clean, overlay them back, and print a
# diff of what the current Expo template WOULD have written, so template drift
# is visible instead of silent.
#
# Usage:  bash scripts/mac-android-prebuild.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Pre-flight ────────────────────────────────────────────────────────────
say "Pre-flight"

command -v node >/dev/null || die "node not found"
NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [[ "$NODE_MAJOR" == "20" || "$NODE_MAJOR" == "22" ]]; then
  ok "node $(node -v)"
else
  warn "node $(node -v) — Expo SDK 54 is tested on Node 20 or 22. If Metro or prebuild misbehaves, this is the first suspect."
fi

# Gradle picks its JVM from JAVA_HOME, NOT from the `java` on PATH — so check the
# binary Gradle will actually use. Setting JAVA_HOME alone never changes `java -version`.
if [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME}/bin/java" ]]; then
  JAVA_BIN="$JAVA_HOME/bin/java"; JAVA_SRC="JAVA_HOME"
elif command -v java >/dev/null; then
  JAVA_BIN="$(command -v java)"; JAVA_SRC="PATH (JAVA_HOME unset — Gradle will fall back to this)"
else
  die "no java found. Install Temurin 17:  brew install --cask temurin@17"
fi
JAVA_MAJOR="$("$JAVA_BIN" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')"

if [[ "$JAVA_MAJOR" != "17" && "${ALLOW_JDK:-}" != "1" ]]; then
  printf '\n  Java on %s is %s: %s\n' "$JAVA_SRC" "$JAVA_MAJOR" "$JAVA_BIN" >&2
  printf '  JDKs installed on this Mac:\n' >&2
  /usr/libexec/java_home -V 2>&1 | sed 's/^/    /' >&2
  die "JDK 17 required (this repo documents Gradle-configuration failures on 11 and 21).
  Install:  brew install --cask temurin@17
  Then:     export JAVA_HOME=\"\$(/usr/libexec/java_home -v 17)\"
  To override this gate anyway:  ALLOW_JDK=1 bash scripts/mac-android-prebuild.sh"
fi
[[ "$JAVA_MAJOR" == "17" ]] && ok "JDK 17 via $JAVA_SRC ($JAVA_BIN)" \
  || warn "JDK $JAVA_MAJOR via $JAVA_SRC — gate overridden with ALLOW_JDK=1"

[[ -n "${ANDROID_HOME:-}" && -d "${ANDROID_HOME:-}" ]] \
  || die "ANDROID_HOME not set or missing. export ANDROID_HOME=\"\$HOME/Library/Android/sdk\""
ok "ANDROID_HOME=$ANDROID_HOME"

[[ -d node_modules ]] || die "node_modules missing — run 'npm install' first (it also applies patches/ via patch-package)"
ok "node_modules present"

[[ -f GoogleService-Info.plist ]] || die "GoogleService-Info.plist missing — the RNFB config plugin throws without it"
ok "GoogleService-Info.plist present"

# Must live at the REPO ROOT and be declared as expo.android.googleServicesFile.
# --clean deletes android/ BEFORE the config plugins run, so a path pointing inside
# android/ resolves to nothing and @react-native-firebase/app's android mod aborts
# the prebuild ("Path to google-services.json is not defined").
[[ -f google-services.json ]] || die "google-services.json missing from the repo root.
  Recover it from a backup:  cp .android-backups/*/app/google-services.json ./google-services.json"
node -e 'const a=require("./app.json"); if(a.expo.android.googleServicesFile!=="./google-services.json"){console.error("app.json: expo.android.googleServicesFile must be \"./google-services.json\", got "+a.expo.android.googleServicesFile);process.exit(1)}' \
  || die "app.json is not pointing at the root google-services.json"
ok "google-services.json at repo root and declared in app.json"

# ── 1. Snapshot the curated tree ──────────────────────────────────────────
STAMP="$(date +%Y%m%d-%H%M%S)"
# Backups live in a DOT directory, never as a sibling `android.curated-*`. Gradle and
# Android Studio scan the repo root for buildable projects, and a bare copy of android/
# has no settings.gradle — so it configures as a root project whose plugin versions
# resolve to empty ("Could not find com.android.tools.build:gradle:").
mkdir -p .android-backups
BACKUP=".android-backups/$STAMP"

say "Backing up curated android/ → $BACKUP"
[[ -d android ]] || die "android/ not found — wrong directory?"
# Refuse to snapshot a half-generated tree as if it were the curated one. If a previous run
# aborted mid-prebuild, android/ is the bare Expo template — backing THAT up and overlaying
# it would destroy the real curated files.
grep -q "CallForegroundService" android/app/src/main/AndroidManifest.xml 2>/dev/null \
  || die "android/ is not the curated tree (no CallForegroundService in the manifest) —
  a previous run aborted mid-prebuild. Restore it first, then re-run:
    rm -rf android && cp -R \"\$(ls -td .android-backups/* | head -1)\" android"
cp -R android "$BACKUP"
ok "backup written"

# From here on, any failure leaves android/ half-generated (prebuild --clean deletes it
# first and can abort mid-mod). Roll back to exactly what we found.
RESTORE_ON_FAIL=1
rollback() {
  local code=$?
  [[ $code -eq 0 ]] && return 0
  [[ "${RESTORE_ON_FAIL:-0}" == "1" ]] || return 0
  printf '\n\033[33m! failed (exit %s) — restoring android/ from %s\033[0m\n' "$code" "$BACKUP"
  rm -rf android && cp -R "$BACKUP" android
  printf '  android/ is back to its pre-run state; the backup is kept.\n'
}
trap rollback EXIT

# Files the overlay restores. Everything else in android/ comes from the template.
CURATED=(
  "build.gradle"
  "gradle.properties"
  "app/build.gradle"
  "app/google-services.json"
  "app/proguard-rules.pro"
  "app/src/main/AndroidManifest.xml"
  "app/src/main/res/values/colors.xml"
  "app/src/main/res/values/styles.xml"
  "app/src/main/res/drawable/ic_stat_bravo.xml"
)
# every hand-written Kotlin source, MainApplication.kt + MainActivity.kt included
while IFS= read -r f; do
  CURATED+=("${f#"$BACKUP"/}")
done < <(find "$BACKUP/app/src/main/java" -name '*.kt' | sort)

for rel in "${CURATED[@]}"; do
  [[ -f "$BACKUP/$rel" ]] || die "expected curated file missing from backup: $rel"
done
ok "${#CURATED[@]} curated files catalogued"

# ── 2. Regenerate from the Expo template ──────────────────────────────────
say "npx expo prebuild -p android --clean   (this deletes and regenerates android/)"
npx expo prebuild -p android --clean
ok "prebuild complete"

# ── 3. Overlay the curated files back ─────────────────────────────────────
say "Restoring curated files"
DIFFLOG="$ROOT/.android-prebuild-drift-$STAMP.diff"
: > "$DIFFLOG"
restored=0
for rel in "${CURATED[@]}"; do
  gen="android/$rel"
  cur="$BACKUP/$rel"
  if [[ -f "$gen" ]] && ! diff -q "$gen" "$cur" >/dev/null 2>&1; then
    {
      printf '\n===== %s =====\n' "$rel"
      printf '(left: what THIS Expo template generated · right: the curated file we keep)\n'
      diff -u "$gen" "$cur" || true
    } >> "$DIFFLOG"
  fi
  mkdir -p "$(dirname "$gen")"
  cp "$cur" "$gen"
  restored=$((restored + 1))
done
ok "$restored files restored"
if [[ -s "$DIFFLOG" ]]; then
  warn "template drift recorded → ${DIFFLOG#"$ROOT"/}"
  warn "read it: anything the CURRENT template added that the curated file lacks is a real change you are discarding"
else
  ok "no template drift"
fi

# ── 4. Post-flight — the things whose absence is silent ───────────────────
say "Post-flight"
m="android/app/src/main/AndroidManifest.xml"
for needle in \
  ".CallForegroundService" \
  "io.wazo.callkeep.VoiceConnectionService" \
  "app.notifee.core.ForegroundService" \
  'enableOnBackInvokedCallback="false"'
do
  grep -q "$needle" "$m" || die "manifest lost: $needle"
done
ok "manifest: call FGS, CallKeep ConnectionService, notifee FGS, back-callback opt-out"

pkgs=$(grep -cE 'add\(Bravo[A-Za-z]+Package\(\)\)' android/app/src/main/java/com/bravosecure/app/MainApplication.kt || echo 0)
[[ "$pkgs" -eq 6 ]] || die "MainApplication registers $pkgs Bravo packages, expected 6"
ok "MainApplication: 6 native packages registered"

grep -q "setUseHardwareAcousticEchoCanceler(false)" android/app/src/main/java/com/bravosecure/app/MainApplication.kt \
  || die "MainApplication lost the WebRTC AEC3 override (B-420)"
ok "WebRTC AEC3 override present"

grep -q "play-services-location:21.3.0" android/build.gradle || die "android/build.gradle lost the play-services-location pin"
ok "play-services-location 21.3.0 pinned"

grep -q "BRAVO_UPLOAD_STORE_FILE" android/app/build.gradle || die "android/app/build.gradle lost the release signingConfig"
ok "release signingConfig present"

for f in android/settings.gradle android/gradlew android/app/src/main/res/values/strings.xml; do
  [[ -e "$f" ]] || die "prebuild did not produce $f"
done
ok "generated scaffolding present (settings.gradle, gradlew, strings.xml)"

# macOS has no Windows worker-crash bug; the cap only slows the build here.
if grep -q '^org.gradle.workers.max=3' android/gradle.properties; then
  warn "gradle.properties caps workers at 3 (a Windows-only workaround). On this Mac you can comment it out for a faster build."
fi

RESTORE_ON_FAIL=0

say "Done"
printf '  Curated backup kept at: %s\n' "$BACKUP"
printf '  Next: npm run android:staging:hot   (or: npx expo run:android)\n\n'
