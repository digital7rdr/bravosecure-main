# release-apk.ps1
#
# One-shot release pipeline:
#   1. Bump app.json `version` and android/app/build.gradle
#      `versionCode` + `versionName` to the requested target
#   2. Run a full Gradle release build (assembleRelease)
#   3. Upload the APK to Firebase App Distribution (qa group)
#
# Usage:
#   .\scripts\release-apk.ps1                 # auto-bumps patch (e.g. 1.0.13 -> 1.0.14)
#   .\scripts\release-apk.ps1 -Version 1.0.14 # explicit target
#   .\scripts\release-apk.ps1 -SkipBuild      # only bump versions
#   .\scripts\release-apk.ps1 -SkipUpload     # build but don't upload
#   .\scripts\release-apk.ps1 -Notes "Round 4 audit fixes"
#   .\scripts\release-apk.ps1 -SkipPreflight  # skip typecheck + tests + git-clean checks
#   .\scripts\release-apk.ps1 -Force          # alias for -SkipPreflight (matches the
#                                             # "I know what I'm doing" mental model)
#
# Pre-flight blocks the build (~16 min Gradle compile) on:
#   - `tsc --noEmit` regressions vs the baseline-locked count (.tsc-baseline)
#   - `jest --selectProjects messenger-crypto` failure
# Pre-flight WARNS but does not block on:
#   - Uncommitted source changes (working tree dirty) - shown as a tally
#     so you don't accidentally ship without intending to.
#
# Requires:
#   - FIREBASE_SERVICE_ACCOUNT env-var pointing at a Firebase Admin SDK
#     service-account JSON. Without it the upload step fails fast.
#   - Gradle wrapper present in android/
#
# NOTE: file is intentionally ASCII-only - Windows PowerShell 5.1 reads
# .ps1 as cp1252 by default and fancy unicode (em-dash, arrows, ticks)
# get mojibake-mangled into syntax errors.

[CmdletBinding()]
param(
  # Explicit target version (e.g. "1.0.14"). When omitted the script
  # bumps the patch component of the current app.json version by 1.
  [string]$Version,

  # Skip the Gradle build - useful for "just bump the version number".
  [switch]$SkipBuild,

  # Skip the Firebase App Distribution upload - useful for local-only
  # builds that aren't ready to ship to testers yet.
  [switch]$SkipUpload,

  # Release notes shown to testers in the Firebase App Distribution UI.
  # Defaults to "Internal staging build - see commit history for changes."
  [string]$Notes,

  # Skip the pre-flight gate (typecheck regression + jest + git-clean
  # warn). Combined with -Force as alias.
  [switch]$SkipPreflight,
  [switch]$Force,

  # Comma-separated list of tester emails to invite on this release.
  # Wired into the Firebase App Distribution Gradle plugin via the
  # APP_DIST_TESTERS env-var (see android/app/build.gradle). The
  # plugin auto-emails each tester an install link for this build.
  # Empty by default — distribution targets the `qa` GROUP instead
  # (see $Groups below), so all QA testers auto-receive every build.
  [string]$Testers = '',

  # Comma-separated Firebase App Distribution group ALIASES to ship to.
  # Default = `qa` (the standing QA team). Every build auto-distributes
  # to this group; add/remove members in the Firebase console without
  # touching this script. Wired via APP_DIST_GROUPS env-var.
  [string]$Groups = 'qa'
)

$ErrorActionPreference = 'Stop'

# Resolve repo root from the script location so the script works no
# matter where it's invoked from.
$RepoRoot  = Resolve-Path (Join-Path $PSScriptRoot '..')
$AppJson   = Join-Path $RepoRoot 'app.json'
$BuildGrad = Join-Path $RepoRoot 'android\app\build.gradle'

if (-not (Test-Path $AppJson))   { throw "app.json not found at $AppJson" }
if (-not (Test-Path $BuildGrad)) { throw "build.gradle not found at $BuildGrad" }

# -Force is just a friendlier alias for -SkipPreflight.
if ($Force) { $SkipPreflight = $true }

# 0. Pre-flight gate. Block on real signals (test failure, new TS
#    errors); warn on dirty working tree. Skipped under -SkipPreflight.
function Invoke-Preflight {
  Write-Host ""
  Write-Host "---- Pre-flight ----" -ForegroundColor Cyan

  # Working-tree dirty check (warn-only).
  Push-Location $RepoRoot
  try {
    $dirty = & git status --porcelain 2>$null | Where-Object {
      # Ignore noise from local diagnostic logs that the gitStatus
      # snapshot showed as untracked at session start.
      $_ -notmatch 'bravo-log' -and $_ -notmatch '\.tsc-baseline'
    }
    $dirtyCount = if ($dirty) { @($dirty).Count } else { 0 }
    if ($dirtyCount -gt 0) {
      Write-Host "  [warn] working tree has $dirtyCount uncommitted file(s)" -ForegroundColor Yellow
      Write-Host "         the build will include them; commit first if you want a"
      Write-Host "         reproducible release."
    } else {
      Write-Host "  [ok]   working tree clean"
    }

    # Jest (messenger-crypto) gate. Real blocker.
    #
    # Windows PowerShell 5.1 quirk: redirecting a native exe's stderr
    # via `2>&1` wraps every stderr line in an ErrorRecord
    # (NativeCommandError). Combined with `$ErrorActionPreference = 'Stop'`
    # at the top of this script, the FIRST stderr line throws BEFORE we
    # ever get to check `$LASTEXITCODE` - so a perfectly successful
    # `jest --silent` (which writes `PASS …` lines to stderr by design)
    # killed the preflight at the first test file.
    #
    # Workaround: redirect to a temp file via cmd.exe so PowerShell never
    # sees the stderr stream, then read the file once jest completes.
    Write-Host "  ...    running jest (messenger-crypto)" -NoNewline
    $jestLog = Join-Path $env:TEMP "bravo-release-jest-$PID.log"
    & cmd /c "npx jest --selectProjects messenger-crypto --silent > `"$jestLog`" 2>&1"
    $jestExit = $LASTEXITCODE
    $jestOut = if (Test-Path $jestLog) { Get-Content $jestLog -Raw } else { "" }
    Remove-Item -Force -ErrorAction SilentlyContinue $jestLog
    if ($jestExit -ne 0) {
      Write-Host ""
      Write-Host "  [FAIL] jest messenger-crypto suite failed (exit=$jestExit)" -ForegroundColor Red
      Write-Host $jestOut
      throw "Pre-flight: jest failed. Fix tests or rerun with -SkipPreflight."
    }
    Write-Host "`r  [ok]   jest messenger-crypto"

    # tsc baseline-aware regression gate. Compares current error count
    # against .tsc-baseline (committed). New errors block; pre-existing
    # ones don't.
    #
    # Same NativeCommandError quirk as the jest call above; same
    # workaround: redirect to a temp file via cmd.exe.
    $tscBaselineFile = Join-Path $RepoRoot '.tsc-baseline'
    Write-Host "  ...    running tsc --noEmit" -NoNewline
    $tscLog = Join-Path $env:TEMP "bravo-release-tsc-$PID.log"
    & cmd /c "npx tsc --noEmit > `"$tscLog`" 2>&1"
    $tscOut = if (Test-Path $tscLog) { Get-Content $tscLog } else { @() }
    Remove-Item -Force -ErrorAction SilentlyContinue $tscLog
    $errCount = (@($tscOut) | Where-Object { $_ -match 'error TS' }).Count
    Write-Host "`r  [info] tsc errors: $errCount"
    if (Test-Path $tscBaselineFile) {
      $baseline = [int](Get-Content $tscBaselineFile -Raw).Trim()
      if ($errCount -gt $baseline) {
        Write-Host "  [FAIL] tsc regressed: baseline=$baseline, current=$errCount" -ForegroundColor Red
        Write-Host "         New errors introduced. Fix them, rerun, or rebaseline:"
        Write-Host "           npm run tsc:rebaseline"
        throw "Pre-flight: tsc regression. $errCount > baseline $baseline."
      }
      Write-Host "  [ok]   tsc within baseline ($errCount <= $baseline)"
    } else {
      Write-Host "  [warn] no .tsc-baseline file - establishing one at $errCount" -ForegroundColor Yellow
      Set-Content -Path $tscBaselineFile -Value $errCount -Encoding ASCII
    }
  } finally {
    Pop-Location
  }
  Write-Host ""
}

if (-not $SkipPreflight) {
  Invoke-Preflight
} else {
  Write-Host ""
  Write-Host "---- Pre-flight SKIPPED ----" -ForegroundColor Yellow
  Write-Host ""
}

# 0a. Re-apply patch-package patches into node_modules.
#
# The 4.3.16 release ships RNCallKeepModule.java with TWO @ReactMethod-
# annotated `displayIncomingCall` overloads. RN 0.81 + newArchEnabled=true
# (TurboModules) refuses overloaded JS-name collisions and the bundle
# crashes on cold start in `setupCallKit` with:
#   FATAL: TurboModuleInteropUtils.getMethodDescriptorsFromModule
#          "Module exports two methods to JavaScript with the same name:
#           displayIncomingCall"
# patches/react-native-callkeep+4.3.16.patch strips @ReactMethod off the
# 3-arg overloads. Without patch-package run before the gradle build the
# stale upstream class files end up in the AAR and every cold start
# crashes -- which is exactly what bravo-log-callkit-crash.txt captured
# on the v1.0.16 build.
#
# patch-package is idempotent: applying twice is a no-op, missing patches
# warn but don't fail. Cheap to always run.
Push-Location $RepoRoot
try {
  Write-Host "  ...    re-applying patch-package patches" -NoNewline
  $patchOut = & npx patch-package 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  [FAIL] patch-package failed" -ForegroundColor Red
    Write-Host $patchOut
    throw "patch-package failed. Inspect patches/ and node_modules state."
  }
  Write-Host "`r  [ok]   patch-package applied"

  # Patch-fingerprint check: confirm the RNCallKeep dual-@ReactMethod
  # mitigation actually landed before letting the 16-min Gradle build
  # ship a crashing APK. Looks for the marker comment inserted by the
  # patch (see patches/react-native-callkeep+4.3.16.patch).
  $rnCallKeepJava = Join-Path $RepoRoot 'node_modules\react-native-callkeep\android\src\main\java\io\wazo\callkeep\RNCallKeepModule.java'
  if (Test-Path $rnCallKeepJava) {
    $javaSrc  = Get-Content $rnCallKeepJava -Raw
    $occurrences = ([regex]::Matches($javaSrc, '@ReactMethod\s+public\s+void\s+displayIncomingCall')).Count
    if ($occurrences -ne 1) {
      Write-Host "  [FAIL] RNCallKeep displayIncomingCall has $occurrences @ReactMethod" -ForegroundColor Red
      Write-Host "         overloads (expected 1). Cold-start TurboModule crash imminent."
      Write-Host "         Inspect patches/react-native-callkeep+4.3.16.patch"
      throw "RNCallKeep patch fingerprint check failed."
    }
    Write-Host "  [ok]   RNCallKeep @ReactMethod fingerprint verified"
  } else {
    Write-Host "  [warn] RNCallKeep source missing - node_modules may be incomplete" -ForegroundColor Yellow
  }
} finally {
  Pop-Location
}
Write-Host ""

# Helper: read a file as UTF-8 explicitly. Get-Content -Raw in
# Windows PowerShell 5.1 reads with the system's "ANSI" code page
# (cp1252 on most installs), which mojibake-mangles any non-ASCII
# byte we then write back. Force UTF-8 to round-trip unicode in
# comments / release-notes intact.
function Read-FileUtf8([string]$Path) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  return [System.IO.File]::ReadAllText($Path, $utf8)
}

# 1. Read current versions
$appJsonText = Read-FileUtf8 $AppJson
if ($appJsonText -notmatch '"version":\s*"([0-9]+\.[0-9]+\.[0-9]+)"') {
  throw 'Could not find "version" in app.json'
}
$currentVersion = $Matches[1]

$buildGradText = Read-FileUtf8 $BuildGrad
if ($buildGradText -notmatch 'versionCode\s+([0-9]+)') {
  throw 'Could not find versionCode in build.gradle'
}
$currentVersionCode = [int]$Matches[1]

# 2. Compute target
if (-not $Version) {
  $parts = $currentVersion -split '\.'
  if ($parts.Length -ne 3) { throw "current version $currentVersion is not semver" }
  $parts[2] = ([int]$parts[2] + 1).ToString()
  $Version  = $parts -join '.'
}
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
  throw "Target version $Version is not semver (X.Y.Z)"
}
$targetVersionCode = $currentVersionCode + 1

$buildLabel  = if ($SkipBuild)  { 'SKIPPED' } else { 'gradlew assembleRelease' }
$uploadLabel = if ($SkipUpload) { 'SKIPPED' } else { 'firebase app distribution -> qa' }

Write-Host ""
Write-Host "---- Bravo Secure release ----" -ForegroundColor Cyan
Write-Host "  current : $currentVersion (code $currentVersionCode)"
Write-Host "  target  : $Version (code $targetVersionCode)"
Write-Host "  build   : $buildLabel"
Write-Host "  upload  : $uploadLabel"
Write-Host ""

# Helper: write UTF-8 WITHOUT a BOM. Set-Content -Encoding utf8 in
# Windows PowerShell 5.1 emits a BOM, which Gradle/Groovy chokes on
# (FAILURE: Unexpected character: '...' @ line 1, column 1). Use the
# .NET API with a no-BOM UTF8Encoding to be safe.
function Write-FileNoBom([string]$Path, [string]$Content) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

# 3. Patch app.json
$newAppJson = $appJsonText -replace `
  '("version":\s*")[0-9]+\.[0-9]+\.[0-9]+(")', `
  ('${1}' + $Version + '${2}')
Write-FileNoBom $AppJson $newAppJson
Write-Host "  [ok] app.json -> version $Version"

# 4. Patch build.gradle
$newBuildGrad = $buildGradText -replace `
  '(versionCode\s+)[0-9]+', `
  ('${1}' + $targetVersionCode)
$newBuildGrad = $newBuildGrad -replace `
  '(versionName\s+")[0-9]+\.[0-9]+\.[0-9]+(")', `
  ('${1}' + $Version + '${2}')
Write-FileNoBom $BuildGrad $newBuildGrad
Write-Host "  [ok] build.gradle -> versionCode $targetVersionCode versionName $Version"

if ($SkipBuild) {
  Write-Host ""
  Write-Host "Done - version bumped, build skipped." -ForegroundColor Green
  exit 0
}

# 5. Validate FIREBASE_SERVICE_ACCOUNT before kicking off the ~16-min
#    Gradle build (fail fast on a missing creds env-var, not after the
#    build's done).
if (-not $SkipUpload) {
  $sa = $env:FIREBASE_SERVICE_ACCOUNT
  if (-not $sa -or -not (Test-Path $sa)) {
    Write-Host ""
    Write-Host "ERROR: FIREBASE_SERVICE_ACCOUNT is unset or points at a" -ForegroundColor Red
    Write-Host "       missing file. Either:" -ForegroundColor Red
    Write-Host "         `$env:FIREBASE_SERVICE_ACCOUNT = 'C:\path\to\sa.json'"
    Write-Host "       or rerun with -SkipUpload to build without uploading."
    exit 1
  }
  if ($Notes) {
    $env:APP_DIST_NOTES = $Notes
  }
  # Wire tester invitations through the App Distribution Gradle plugin
  # (see android/app/build.gradle firebaseAppDistribution block). The
  # plugin auto-emails each listed tester an install link for this
  # release after a successful upload.
  if ($Testers) {
    $env:APP_DIST_TESTERS = $Testers
    Write-Host "  [ok] tester invites: $Testers"
  }
  # Wire group distribution (default `qa`). Every build ships to this
  # group so the QA team auto-receives it; manage membership in the
  # Firebase console, not here.
  if ($Groups) {
    $env:APP_DIST_GROUPS = $Groups
    Write-Host "  [ok] tester groups: $Groups"
  }
}

# 6. Build (Gradle) — always assembleRelease only. Distribution is done
#    separately via the Firebase CLI below (the project has no
#    firebaseAppDistribution Gradle plugin).
Push-Location (Join-Path $RepoRoot 'android')
try {
  Write-Host ""
  Write-Host "  > gradlew assembleRelease" -ForegroundColor Yellow
  & .\gradlew.bat assembleRelease
  if ($LASTEXITCODE -ne 0) {
    throw "Gradle exited with code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$apkPath = Join-Path $RepoRoot 'android\app\build\outputs\apk\release\app-release.apk'
if (Test-Path $apkPath) {
  $size = '{0:N1} MB' -f ((Get-Item $apkPath).Length / 1MB)
  Write-Host ""
  Write-Host "  [ok] APK built: $apkPath ($size)" -ForegroundColor Green
}

# 6b. Distribute via Firebase CLI (App Distribution). Targets the `qa`
#     GROUP by default so the standing QA team auto-receives every build.
#     Auth uses the service-account JSON at repo root via
#     GOOGLE_APPLICATION_CREDENTIALS. firebase-tools prefers a cached
#     interactive login over the service account, so if one exists we
#     move it aside for the duration and always restore it.
if (-not $SkipUpload) {
  if (-not (Test-Path $apkPath)) { throw "APK not found at $apkPath; cannot distribute." }
  $saJson = Join-Path $RepoRoot 'bravo-734da-firebase-adminsdk-fbsvc-f74f8bec45.json'
  if (-not (Test-Path $saJson)) { throw "Firebase service account JSON not found at $saJson" }
  $env:GOOGLE_APPLICATION_CREDENTIALS = $saJson

  $appId = '1:150226560672:android:ff3a71dcdb542556818bc5'   # com.bravosecure.app (release)
  $proj  = 'bravo-734da'
  $notes = if ($Notes) { $Notes } else { "Internal staging build v$Version (code $targetVersionCode)." }

  $distArgs = @('appdistribution:distribute', $apkPath, '--app', $appId, '--project', $proj, '--release-notes', $notes)
  if ($Groups)  { $distArgs += @('--groups',  $Groups)  }
  if ($Testers) { $distArgs += @('--testers', $Testers) }

  $cfg = Join-Path $env:USERPROFILE '.config\configstore\firebase-tools.json'
  $bak = "$cfg.bak-release"
  $movedLogin = $false
  try {
    if (Test-Path $cfg) { Copy-Item $cfg $bak -Force; Remove-Item $cfg -Force; $movedLogin = $true }
    Write-Host ""
    Write-Host "  > firebase $($distArgs -join ' ')" -ForegroundColor Yellow
    & firebase @distArgs
    if ($LASTEXITCODE -ne 0) { throw "firebase appdistribution:distribute exited with code $LASTEXITCODE" }
  } finally {
    if ($movedLogin -and (Test-Path $bak)) { Copy-Item $bak $cfg -Force; Remove-Item $bak -Force }
  }
}

Write-Host ""
if ($SkipUpload) {
  Write-Host "Done - v$Version (code $targetVersionCode) built locally." -ForegroundColor Green
  Write-Host "Install with:  adb install -r `"$apkPath`""
} else {
  Write-Host "Done - v$Version (code $targetVersionCode) shipped to Firebase qa group." -ForegroundColor Green
  Write-Host "Console: https://console.firebase.google.com/project/bravo-734da/appdistribution/app/android:com.bravosecure.app/releases"
}
