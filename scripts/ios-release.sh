#!/usr/bin/env bash
#
# ios-release.sh — cut an iOS build and ship it to TestFlight.
#
# Wraps the archive -> export -> upload pipeline that produced builds 143/144,
# with pre-flight guards for the traps that have already cost this project time:
#   - Info.plist versions are HARDCODED (not $(MARKETING_VERSION)), so
#     xcodebuild command-line overrides are silently ignored.
#   - ITSAppUsesNonExemptEncryption in Info.plist triggers altool error 90592
#     because ASC holds saved compliance docs expecting a paired code.
#   - CallKit wiring lives in the gitignored ios/ tree and can vanish after a
#     prebuild — shipping without it defeats the whole VoIP feature.
#   - altool exits non-zero INSIDE a wrapper that can still report 0; the log
#     is the only trustworthy verdict.
#
# Usage:
#   scripts/ios-release.sh                  # version from app.json, build auto-derived from ASC
#   scripts/ios-release.sh --build 145      # explicit build number
#   scripts/ios-release.sh --check          # run guards only, no compile (fast)
#   scripts/ios-release.sh --no-upload      # archive + export, skip TestFlight
#
# Docs: docs/runbooks/IOS_BUILD.md
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Config (override via env) ─────────────────────────────────────────────
ASC_KEY_ID="${ASC_KEY_ID:-S6379ZCA56}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-413b1e93-d5ea-46d2-85c0-838c6aebfba7}"
TEAM_ID="${TEAM_ID:-88X6H88A4R}"
SIGN_IDENTITY="${SIGN_IDENTITY:-Apple Distribution: Michele Cioffi (88X6H88A4R)}"
PROFILE_NAME="${PROFILE_NAME:-Bravo Secure App Store}"
BUNDLE_ID="${BUNDLE_ID:-com.bravosecure.mobile}"
SCHEME="${SCHEME:-BravoSecure}"

OUT_DIR="${OUT_DIR:-$REPO_ROOT/.ios-release}"
PLIST="ios/BravoSecure/Info.plist"
APPDELEGATE="ios/BravoSecure/AppDelegate.swift"
BRIDGING="ios/BravoSecure/BravoSecure-Bridging-Header.h"
PBXPROJ="ios/BravoSecure.xcodeproj/project.pbxproj"

CHECK_ONLY=0
DO_UPLOAD=1
BUILD_NUMBER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)     CHECK_ONLY=1; shift ;;
    --no-upload) DO_UPLOAD=0; shift ;;
    --build)     BUILD_NUMBER="$2"; shift 2 ;;
    -h|--help)   sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Pre-flight guards (all run BEFORE the ~25min compile) ─────────────────
say "Pre-flight guards"

[[ -d ios ]] || die "no ios/ directory — run: npx expo prebuild -p ios (then re-apply the fixes in docs/runbooks/IOS_BUILD.md)"
[[ -f "$PLIST" ]] || die "missing $PLIST"

# G1: CallKit must be wired in. A build without this silently loses VoIP wake.
callkit_hits=$(grep -cE "PushKit|voipRegistration|reportNewIncomingCall|didReceiveIncomingPush" "$APPDELEGATE" 2>/dev/null || echo 0)
[[ "$callkit_hits" -ge 4 ]] || die "CallKit wiring missing from AppDelegate (found $callkit_hits refs, expect >=4). A prebuild likely reset ios/. See docs/runbooks/IOS_CALLKIT_VOIP.md §6."
ok "CallKit wiring present in AppDelegate ($callkit_hits refs)"

grep -q "RNVoipPushNotificationManager.h" "$BRIDGING" 2>/dev/null || die "bridging header missing RNVoipPushNotification import"
grep -q "RNCallKeep.h" "$BRIDGING" 2>/dev/null || die "bridging header missing RNCallKeep import"
ok "Bridging-header imports present"

# G2: the 90592 trap. This key must NOT be in Info.plist.
if plutil -extract ITSAppUsesNonExemptEncryption raw "$PLIST" >/dev/null 2>&1; then
  die "ITSAppUsesNonExemptEncryption is in $PLIST — altool will reject with error 90592. Remove it (compliance is answered in the ASC UI). See docs/runbooks/IOS_BUILD.md."
fi
ok "No ITSAppUsesNonExemptEncryption key (90592 trap avoided)"

# G3: script-sandbox fix (prebuild resets this to YES, which breaks ip.txt write)
sandbox_no=$(grep -c "ENABLE_USER_SCRIPT_SANDBOXING = NO;" "$PBXPROJ" 2>/dev/null || echo 0)
[[ "$sandbox_no" -ge 2 ]] || die "ENABLE_USER_SCRIPT_SANDBOXING is not NO in both configs (found $sandbox_no). Fix: sed -i '' 's/ENABLE_USER_SCRIPT_SANDBOXING = YES;/ENABLE_USER_SCRIPT_SANDBOXING = NO;/g' $PBXPROJ"
ok "Script sandboxing disabled ($sandbox_no configs)"

# G4: signing material
security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_IDENTITY" \
  || die "distribution identity not in keychain: $SIGN_IDENTITY"
ok "Signing identity present"

profile_found=0
for p in ~/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision; do
  [[ -e "$p" ]] || continue
  if security cms -D -i "$p" 2>/dev/null | plutil -extract Name raw - 2>/dev/null | grep -qx "$PROFILE_NAME"; then
    profile_found=1; break
  fi
done
[[ "$profile_found" -eq 1 ]] || die "provisioning profile not installed: $PROFILE_NAME"
ok "Provisioning profile installed: $PROFILE_NAME"

[[ -f "$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8" ]] \
  || die "ASC API key missing: ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
ok "ASC API key present ($ASC_KEY_ID)"

[[ -f ios/Pods/Manifest.lock ]] || die "pods not installed — run: (cd ios && pod install)"
ok "Pods installed"

# G5: warn (don't block) on a dirty tree — you want to know what you shipped.
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  warn "working tree is dirty — the build will include uncommitted changes"
fi

# G6: every declared dependency must exist in node_modules. Why this is a
# guard and not a footnote: the Metro bundle is the LAST phase of the archive,
# so an unresolvable import fails ~25 min in, after everything compiled. Build
# 163 died exactly this way — @react-native-firebase/app-check had been in
# package.json + package-lock.json since 3641b2e9 but `npm install` was never
# run, so node_modules never had it. The fail-soft `require()` in
# appCheckHeader.ts does NOT cover this: Metro resolves require() statically at
# bundle time, so an absent package is a hard build error, not a soft degrade.
missing_deps=$(node -e '
  const fs = require("fs");
  const deps = Object.keys(JSON.parse(fs.readFileSync("package.json", "utf8")).dependencies || {});
  const missing = deps.filter(d => !fs.existsSync("node_modules/" + d));
  if (missing.length) console.log(missing.join(" "));
' 2>/dev/null || true)
[[ -z "$missing_deps" ]] || die "node_modules is out of sync with package.json — run: npm install
     missing: $missing_deps
     (Metro would fail at the END of the ~25min archive, not now.)"
ok "node_modules in sync with package.json"

# G7: a pod declared by an installed JS package but absent from Podfile.lock
# means the native half is missing — the JS bundles, then the module is not
# there at runtime. Same root cause as G6, one layer down.
if [[ -d node_modules/@react-native-firebase/app-check ]] \
   && ! grep -q "RNFBAppCheck" ios/Podfile.lock 2>/dev/null; then
  die "@react-native-firebase/app-check is installed but RNFBAppCheck is not in ios/Podfile.lock — run: (cd ios && pod install)"
fi
ok "Firebase App Check native pod matches the JS package"

# ── Resolve version + build number ────────────────────────────────────────
say "Version"
VERSION="$(node -p "require('./app.json').expo.version")"
[[ -n "$VERSION" ]] || die "could not read expo.version from app.json"

if [[ -z "$BUILD_NUMBER" ]]; then
  # Why: the ASC helper needs `cryptography` to sign the ES256 JWT. A pyenv or
  # /usr/bin python3 usually lacks it while Homebrew's has it, and picking the
  # wrong one made the lookup fail silently and fall back to app.json — which
  # still held an ALREADY-UPLOADED build number, i.e. a guaranteed collision.
  # Resolve a python that can actually import it.
  PYTHON_BIN=""
  for cand in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import cryptography" >/dev/null 2>&1; then
      PYTHON_BIN="$cand"; break
    fi
  done
  if [[ -z "$PYTHON_BIN" ]]; then
    warn "no python3 with the 'cryptography' module — ASC build-number lookup unavailable"
    warn "install with: /opt/homebrew/bin/python3 -m pip install cryptography"
  fi
  # Ask ASC for the highest build already uploaded, then +1. Prevents the
  # "build number already used" rejection without hand-tracking numbers.
  BUILD_NUMBER="$([[ -n "$PYTHON_BIN" ]] && "$PYTHON_BIN" "$REPO_ROOT/scripts/ios-asc-latest-build.py" --next \
                    --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --bundle-id "$BUNDLE_ID" 2>/dev/null || true)"
  if [[ -z "$BUILD_NUMBER" ]]; then
    # Why: app.json normally holds the number of the build ALREADY uploaded, so
    # falling back to it silently produces a duplicate that App Store Connect
    # rejects — after a ~25min archive. Refuse instead, and make the operator
    # pass --build explicitly so the choice is deliberate.
    die "ASC build-number lookup failed and there is no safe fallback.
     app.json currently says $(node -p "require('./app.json').expo.ios.buildNumber"), which is most likely ALREADY uploaded.
     Re-run with an explicit number, e.g.:  scripts/ios-release.sh --build <n>
     Or check the latest on TestFlight with: npm run ios:status"
  else
    ok "Next build number from ASC: $BUILD_NUMBER"
  fi
fi
ok "Shipping $VERSION ($BUILD_NUMBER)"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  say "All guards passed (--check: stopping before compile)"
  exit 0
fi

# Sync BOTH sources of truth. app.json drives EAS/prebuild; Info.plist drives
# this local archive (its values are literal, not build-setting references).
node -e '
  const fs = require("fs");
  const j = JSON.parse(fs.readFileSync("app.json", "utf8"));
  j.expo.ios.buildNumber = process.argv[1];
  fs.writeFileSync("app.json", JSON.stringify(j, null, 2) + "\n");
' "$BUILD_NUMBER"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$PLIST"
plutil -lint "$PLIST" >/dev/null || die "Info.plist is invalid after version sync"
ok "Synced app.json + Info.plist to $VERSION ($BUILD_NUMBER)"

# ── Archive ───────────────────────────────────────────────────────────────
mkdir -p "$OUT_DIR"
ARCHIVE="$OUT_DIR/BravoSecure-$BUILD_NUMBER.xcarchive"
EXPORT_DIR="$OUT_DIR/ipa-$BUILD_NUMBER"
ARCHIVE_LOG="$OUT_DIR/archive-$BUILD_NUMBER.log"
rm -rf "$ARCHIVE" "$EXPORT_DIR"

say "Archiving (this takes ~20-30 min)"
set +e
# Why: `expo prebuild` regenerates project.pbxproj with NO signing settings, so
# the archive dies with "Signing for BravoSecure requires a development team".
# Pass the team explicitly and let Xcode resolve the distribution profile.
# Do NOT pass PROVISIONING_PROFILE_SPECIFIER here: command-line build settings
# apply to EVERY target, and pod library targets reject a provisioning profile
# ("<pod> does not support provisioning profiles") — that fails ~157 targets.
xcodebuild -workspace ios/BravoSecure.xcworkspace -scheme "$SCHEME" \
  -configuration Release -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  -archivePath "$ARCHIVE" archive > "$ARCHIVE_LOG" 2>&1
archive_rc=$?
set -e
[[ $archive_rc -eq 0 ]] || die "archive failed (rc=$archive_rc) — see $ARCHIVE_LOG"
[[ -d "$ARCHIVE" ]] || die "archive reported success but no .xcarchive at $ARCHIVE"

# Verify by content, not exit code.
got_ver="$(plutil -extract ApplicationProperties.CFBundleShortVersionString raw "$ARCHIVE/Info.plist")"
got_build="$(plutil -extract ApplicationProperties.CFBundleVersion raw "$ARCHIVE/Info.plist")"
[[ "$got_ver" == "$VERSION" && "$got_build" == "$BUILD_NUMBER" ]] \
  || die "archive version mismatch: got $got_ver ($got_build), expected $VERSION ($BUILD_NUMBER)"
ok "Archived $got_ver ($got_build)"

# ── Export ────────────────────────────────────────────────────────────────
say "Exporting signed .ipa"
EXPORT_OPTS="$OUT_DIR/exportOptions.plist"
cat > "$EXPORT_OPTS" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>teamID</key><string>$TEAM_ID</string>
	<key>signingStyle</key><string>manual</string>
	<key>signingCertificate</key><string>$SIGN_IDENTITY</string>
	<key>provisioningProfiles</key>
	<dict><key>$BUNDLE_ID</key><string>$PROFILE_NAME</string></dict>
	<key>uploadSymbols</key><true/>
	<key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST_EOF

EXPORT_LOG="$OUT_DIR/export-$BUILD_NUMBER.log"
set +e
xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_OPTS" -exportPath "$EXPORT_DIR" > "$EXPORT_LOG" 2>&1
export_rc=$?
set -e
[[ $export_rc -eq 0 ]] || die "export failed (rc=$export_rc) — see $EXPORT_LOG"

IPA="$(ls "$EXPORT_DIR"/*.ipa 2>/dev/null | head -1)"
[[ -n "$IPA" ]] || die "export reported success but produced no .ipa"
ok "Exported $(basename "$IPA") ($(du -h "$IPA" | cut -f1))"

if [[ "$DO_UPLOAD" -eq 0 ]]; then
  say "Done (--no-upload). IPA: $IPA"
  exit 0
fi

# ── Upload ────────────────────────────────────────────────────────────────
say "Uploading to TestFlight"
UPLOAD_LOG="$OUT_DIR/upload-$BUILD_NUMBER.log"
set +e
xcrun altool --upload-app -f "$IPA" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" > "$UPLOAD_LOG" 2>&1
upload_rc=$?
set -e

# altool's exit code is necessary but NOT sufficient — grep the log. A wrapper
# shell can mask a non-zero rc, which is how a failed upload once looked green.
if grep -q "UPLOAD SUCCEEDED" "$UPLOAD_LOG"; then
  ok "UPLOAD SUCCEEDED"
  grep -E "Delivery UUID" "$UPLOAD_LOG" | sed 's/^/  /' || true
else
  echo "--- upload log ---" >&2
  tail -30 "$UPLOAD_LOG" >&2
  die "upload failed (rc=$upload_rc) — full log: $UPLOAD_LOG"
fi

say "Shipped $VERSION ($BUILD_NUMBER) to TestFlight"
cat <<NEXT

Next, in App Store Connect:
  1. Wait ~5-15 min for processing (state: VALID / READY_FOR_BETA_TESTING)
  2. Answer export compliance if prompted (encryption -> qualifies for exemption)
  3. TestFlight -> Internal Testing -> assign build $BUILD_NUMBER to your group

Check status without opening a browser:
  python3 scripts/ios-asc-latest-build.py --status

NEXT
