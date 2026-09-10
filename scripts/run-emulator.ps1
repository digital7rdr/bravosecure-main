$ErrorActionPreference = 'Stop'

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$emulator = Join-Path $sdk 'emulator\emulator.exe'
$adb = Join-Path $sdk 'platform-tools\adb.exe'

if (-not (Test-Path $emulator)) { throw "emulator.exe not found at $emulator" }
if (-not (Test-Path $adb))      { throw "adb.exe not found at $adb" }

$avds = & $emulator -list-avds
if (-not $avds) {
  Write-Host ""
  Write-Host "No AVD found. Create one in Android Studio:" -ForegroundColor Yellow
  Write-Host "  1. Open Android Studio"
  Write-Host "  2. More Actions -> Virtual Device Manager (or Tools -> Device Manager)"
  Write-Host "  3. Click '+' -> pick 'Pixel 6a' -> Next"
  Write-Host "  4. Pick the API 37 system image you already downloaded -> Next -> Finish"
  Write-Host "  5. Re-run this script"
  exit 1
}

# prefer a Pixel 6a AVD if present
$avd = ($avds | Where-Object { $_ -match 'Pixel.*6a' } | Select-Object -First 1)
if (-not $avd) { $avd = $avds | Select-Object -First 1 }
Write-Host "Booting AVD: $avd" -ForegroundColor Cyan

# launch emulator if no device is online yet
$devices = & $adb devices
if ($devices -notmatch 'emulator-\d+\s+device') {
  Start-Process -FilePath $emulator -ArgumentList @('-avd', $avd, '-no-snapshot-save', '-netdelay', 'none', '-netspeed', 'full') -WindowStyle Minimized
  Write-Host "Waiting for device to come online..."
  & $adb wait-for-device
  # wait for boot completion
  do {
    Start-Sleep -Seconds 2
    $boot = & $adb shell getprop sys.boot_completed 2>$null
  } while ($boot -notmatch '1')
  Write-Host "Emulator booted." -ForegroundColor Green
} else {
  Write-Host "Existing device detected, skipping emulator launch." -ForegroundColor Green
}

# reverse Metro port so the dev bundle reaches your PC
& $adb reverse tcp:8081 tcp:8081 | Out-Null
Write-Host "adb reverse tcp:8081 OK" -ForegroundColor Green

Write-Host ""
Write-Host "Now run in another terminal at the project root:" -ForegroundColor Yellow
Write-Host "  npm run android" -ForegroundColor White
Write-Host ""
Write-Host "First build will take 5-15 minutes (Gradle + native modules)." -ForegroundColor DarkGray
