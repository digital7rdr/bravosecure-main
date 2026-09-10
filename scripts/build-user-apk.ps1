# build-user-apk.ps1 — B-685
#
# Builds the USER-FACING arm64-only release APK (~110 MB vs the 327 MB
# universal QA build). Real phones are arm64; the x86/x86_64 ABIs exist only
# for BlueStacks QA, so users should never download them.
#
# Output:
#   android\app\build\outputs\apk\release\app-release.apk        (arm64, overwritten)
#   android\app\build\outputs\apk\release\app-release-arm64.apk  (preserved copy)
#
# NOTE: app-release.apk is the same path the QA/Firebase flows read. Those
# flows (release-apk.ps1, apk:dist) always run their own assembleRelease
# first, so they cannot upload this arm64 APK by accident — but a manual
# `adb install` onto BlueStacks right after this script fails with
# INSTALL_FAILED_NO_MATCHING_ABIS (expected; use a universal build for QA).
#
# Why a .ps1 and not cross-env-shell: cross-env v10's cross-env-shell exits 0
# without executing chained commands (observed 2026-08-28). Same env values as
# apk:staging / .env.production.

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Mapbox public token is NOT committed (GitHub push protection flags it).
# Supply it in the environment before running:  $env:EXPO_PUBLIC_MAPBOX_TOKEN = "pk.…"
if (-not $env:EXPO_PUBLIC_MAPBOX_TOKEN) {
  throw "EXPO_PUBLIC_MAPBOX_TOKEN is not set — export the Mapbox public token (pk.) first; maps would ship blank."
}
$env:EXPO_PUBLIC_API_BASE_URL = 'https://auth.94-136-184-52.sslip.io'
$env:EXPO_PUBLIC_MSG_BASE_URL = 'https://relay.94-136-184-52.sslip.io'
$env:EXPO_PUBLIC_AUTO_DISPATCH = 'true'
$env:EXPO_PUBLIC_DEPT_CHAT_V2 = 'true'
$env:EXPO_PUBLIC_SUPABASE_URL = 'https://qkkfkicgoncxslbwhyhz.supabase.co'
$env:EXPO_PUBLIC_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFra2ZraWNnb25jeHNsYndoeWh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NDEyNDAsImV4cCI6MjA5MzIxNzI0MH0.URJEGJBO3T1Z1Cr8QBNpfXWiO9Skbwea52ifjG7_Rdg'

Push-Location (Join-Path $RepoRoot 'android')
try {
  & .\gradlew.bat assembleRelease '-PreactNativeArchitectures=arm64-v8a'
  if ($LASTEXITCODE -ne 0) { throw "gradlew assembleRelease failed (exit $LASTEXITCODE)" }

  $out = 'app\build\outputs\apk\release'
  Copy-Item (Join-Path $out 'app-release.apk') (Join-Path $out 'app-release-arm64.apk') -Force
  $size = '{0:N1} MB' -f ((Get-Item (Join-Path $out 'app-release-arm64.apk')).Length / 1MB)
  Write-Host "[ok] arm64 user APK: $out\app-release-arm64.apk ($size)" -ForegroundColor Green
} finally {
  Pop-Location
}
