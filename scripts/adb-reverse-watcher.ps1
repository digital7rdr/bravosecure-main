# ADB reverse watcher — keeps Metro (8081) and Supabase (54321–54324) reverse
# tunnels alive across USB reconnects / phone sleep cycles.
#
# Usage:  pwsh ./scripts/adb-reverse-watcher.ps1
#         (leave running in a dedicated terminal)

$ErrorActionPreference = 'Stop'

# Ensure JAVA_HOME is set for Gradle builds (uses Android Studio's bundled JBR)
if (-not $env:JAVA_HOME) {
    $jbr = "$env:ProgramFiles\Android\Android Studio\jbr"
    if (Test-Path $jbr) {
        $env:JAVA_HOME = $jbr
        $env:PATH = "$jbr\bin;$env:PATH"
        Write-Host "JAVA_HOME set to $jbr"
    }
}
# Ensure ANDROID_HOME is set
if (-not $env:ANDROID_HOME) {
    $sdk = "$env:LOCALAPPDATA\Android\Sdk"
    if (Test-Path $sdk) {
        $env:ANDROID_HOME = $sdk
        $env:PATH = "$sdk\platform-tools;$env:PATH"
        Write-Host "ANDROID_HOME set to $sdk"
    }
}

# Locate adb: prefer ANDROID_HOME, fall back to the standard Windows install.
$adb = $null
if ($env:ANDROID_HOME -and (Test-Path "$env:ANDROID_HOME\platform-tools\adb.exe")) {
    $adb = "$env:ANDROID_HOME\platform-tools\adb.exe"
} elseif (Test-Path "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe") {
    $adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
} elseif (Get-Command adb -ErrorAction SilentlyContinue) {
    $adb = (Get-Command adb).Source
} else {
    Write-Error "adb.exe not found. Install Android platform-tools or set ANDROID_HOME."
    exit 1
}

$ports = @(8081, 3001, 3100, 7379, 54321, 54322, 54323, 54324)
$lastDeviceState = ''

Write-Host "ADB reverse watcher started. Ports: $($ports -join ', ')"
Write-Host "adb: $adb"
Write-Host "Press Ctrl+C to stop.`n"

while ($true) {
    try {
        $devicesOutput = & $adb devices 2>&1 | Out-String
        $deviceLine    = ($devicesOutput -split "`n" | Where-Object { $_ -match "^\S+\s+(device|offline|unauthorized)\s*$" } | Select-Object -First 1)
        $state         = if ($deviceLine -match '\s+(\w+)\s*$') { $Matches[1] } else { 'none' }

        if ($state -ne $lastDeviceState) {
            Write-Host "[$(Get-Date -Format HH:mm:ss)] device state → $state"
            $lastDeviceState = $state
        }

        if ($state -eq 'device') {
            $listOutput = & $adb reverse --list 2>&1 | Out-String
            $missing = @()
            foreach ($p in $ports) {
                if ($listOutput -notmatch "tcp:$p\s+tcp:$p") { $missing += $p }
            }
            if ($missing.Count -gt 0) {
                Write-Host "[$(Get-Date -Format HH:mm:ss)] restoring reverses for: $($missing -join ', ')"
                foreach ($p in $missing) {
                    & $adb reverse "tcp:$p" "tcp:$p" 2>&1 | Out-Null
                }
            }
        }
    } catch {
        Write-Host "[$(Get-Date -Format HH:mm:ss)] watcher error: $_" -ForegroundColor Yellow
    }

    Start-Sleep -Seconds 3
}
