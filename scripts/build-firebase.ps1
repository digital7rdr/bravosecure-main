# build-firebase.ps1
#
# One-shot pipeline:
#   1. Bump @react-native-firebase/* packages to the latest version
#      within the current major (default) or to an explicit target.
#   2. npm install to lock the new versions and refresh node_modules.
#   3. Hand off to scripts/release-apk.ps1 which version-bumps the
#      app, builds the release APK, and uploads to Firebase App
#      Distribution.
#
# Usage:
#   .\scripts\build-firebase.ps1
#   .\scripts\build-firebase.ps1 -FirebaseVersion 21.14.0
#   .\scripts\build-firebase.ps1 -SkipFirebaseUpdate     # straight to build
#   .\scripts\build-firebase.ps1 -SkipBuild              # only bump deps
#   .\scripts\build-firebase.ps1 -SkipUpload             # build, no upload
#   .\scripts\build-firebase.ps1 -AppVersion 1.0.20      # forwarded to release-apk
#   .\scripts\build-firebase.ps1 -Notes "Firebase bump + audit fix"
#   .\scripts\build-firebase.ps1 -Force                  # skip preflight
#
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 reads .ps1 as
# cp1252 and mojibakes any fancy unicode.

[CmdletBinding()]
param(
  # Explicit @react-native-firebase/* target (e.g. "21.14.0"). When
  # omitted the script picks the latest version that matches the
  # current major already pinned in package.json.
  [string]$FirebaseVersion,

  # Skip the Firebase package bump entirely - useful when you only
  # want the build + distribute flow without touching deps.
  [switch]$SkipFirebaseUpdate,

  # Forwarded to release-apk.ps1 -Version.
  [string]$AppVersion,

  # Forwarded to release-apk.ps1.
  [switch]$SkipBuild,
  [switch]$SkipUpload,
  [switch]$SkipPreflight,
  [switch]$Force,
  [string]$Notes,
  [string]$Testers
)

$ErrorActionPreference = 'Stop'

$RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..')
$PackageJson = Join-Path $RepoRoot 'package.json'
$ReleaseScript = Join-Path $PSScriptRoot 'release-apk.ps1'

if (-not (Test-Path $PackageJson))   { throw "package.json not found at $PackageJson" }
if (-not (Test-Path $ReleaseScript)) { throw "release-apk.ps1 not found at $ReleaseScript" }

Write-Host ""
Write-Host "==== Bravo Secure: Firebase + Build ====" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------
# 1. Firebase package bump
# ---------------------------------------------------------------------
$FIREBASE_PKGS = @(
  '@react-native-firebase/app',
  '@react-native-firebase/analytics',
  '@react-native-firebase/crashlytics',
  '@react-native-firebase/messaging'
)

function Read-FileUtf8([string]$Path) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  return [System.IO.File]::ReadAllText($Path, $utf8)
}

function Write-FileNoBom([string]$Path, [string]$Content) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Get-CurrentFirebaseMajor {
  $pkgText = Read-FileUtf8 $PackageJson
  # Look at app/ first - it pins the suite major.
  if ($pkgText -match '"@react-native-firebase/app":\s*"\^?([0-9]+)\.([0-9]+)\.([0-9]+)"') {
    return [int]$Matches[1]
  }
  throw 'Could not parse @react-native-firebase/app version from package.json'
}

function Resolve-LatestFirebaseVersion([int]$Major) {
  Write-Host "  ...    resolving latest @react-native-firebase/app within ^$Major" -NoNewline
  $raw = & npm view '@react-native-firebase/app' versions --json 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) {
    throw 'npm view failed - is the network up?'
  }
  $versions = $raw | ConvertFrom-Json
  $matching = $versions | Where-Object { $_ -match "^$Major\." } |
              ForEach-Object {
                $parts = $_ -split '\.'
                [pscustomobject]@{
                  Raw   = $_
                  Major = [int]$parts[0]
                  Minor = [int]$parts[1]
                  Patch = [int]$parts[2]
                }
              } |
              Sort-Object Major, Minor, Patch
  if (-not $matching) {
    throw "No published versions matching ^$Major for @react-native-firebase/app"
  }
  $latest = $matching[-1].Raw
  Write-Host ("`r  [ok]   latest in ^$Major " + ": $latest")
  return $latest
}

if (-not $SkipFirebaseUpdate) {
  Write-Host "---- Firebase deps ----" -ForegroundColor Cyan
  if (-not $FirebaseVersion) {
    $major = Get-CurrentFirebaseMajor
    $FirebaseVersion = Resolve-LatestFirebaseVersion $major
  }
  if ($FirebaseVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    throw "Firebase target $FirebaseVersion is not semver (X.Y.Z)"
  }

  $pkgText = Read-FileUtf8 $PackageJson
  $changed = $false
  foreach ($name in $FIREBASE_PKGS) {
    $esc = [regex]::Escape($name)
    $pattern = '("' + $esc + '":\s*")\^?[0-9]+\.[0-9]+\.[0-9]+(")'
    if ($pkgText -match $pattern) {
      $replacement = '${1}^' + $FirebaseVersion + '${2}'
      $next = [regex]::Replace($pkgText, $pattern, $replacement)
      if ($next -ne $pkgText) {
        $pkgText = $next
        $changed = $true
        Write-Host "  [ok]   $name -> ^$FirebaseVersion"
      } else {
        Write-Host "  [skip] $name already at ^$FirebaseVersion"
      }
    } else {
      Write-Host "  [warn] $name not found in package.json" -ForegroundColor Yellow
    }
  }

  if ($changed) {
    Write-FileNoBom $PackageJson $pkgText
    Write-Host "  [ok]   package.json updated"
  }

  Write-Host ""
  Write-Host "---- npm install ----" -ForegroundColor Cyan
  Push-Location $RepoRoot
  try {
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed (exit=$LASTEXITCODE). Resolve before building."
    }
  } finally {
    Pop-Location
  }
  Write-Host "  [ok]   dependencies installed"
} else {
  Write-Host "---- Firebase deps SKIPPED ----" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------
# 2. Hand off to release-apk.ps1
# ---------------------------------------------------------------------
Write-Host ""
Write-Host "---- Build + distribute ----" -ForegroundColor Cyan

$releaseArgs = @{}
if ($AppVersion)    { $releaseArgs.Version       = $AppVersion }
if ($SkipBuild)     { $releaseArgs.SkipBuild     = $true }
if ($SkipUpload)    { $releaseArgs.SkipUpload    = $true }
if ($SkipPreflight) { $releaseArgs.SkipPreflight = $true }
if ($Force)         { $releaseArgs.Force         = $true }
if ($Notes)         { $releaseArgs.Notes         = $Notes }
if ($Testers)       { $releaseArgs.Testers       = $Testers }

& $ReleaseScript @releaseArgs
if ($LASTEXITCODE -ne 0) {
  throw "release-apk.ps1 exited with $LASTEXITCODE"
}

Write-Host ""
Write-Host "==== build-firebase: done ====" -ForegroundColor Green
