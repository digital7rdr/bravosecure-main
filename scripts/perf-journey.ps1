# perf-journey.ps1 -- W3(a) of docs/planning/DEAD_PHONE_SMOOTHNESS_PLAN.md
#
# The reference-device budget harness: one scripted, repeatable measurement
# pass against whatever device is on ADB, reported against the plan's S3
# budgets. Run it before AND after any perf-relevant change; keep the report
# files (docs/qa/perf-runs/) so builds are comparable.
#
#   .\scripts\perf-journey.ps1                    # scripted scrolls, 45s window
#   .\scripts\perf-journey.ps1 -PassiveSeconds 120  # human drives the app instead
#   .\scripts\perf-journey.ps1 -SkipColdStart       # don't restart the app
#
# Scripted mode performs ONLY swipes and BACK -- never blind taps (a tap at
# fixed coordinates on a real account can open a chat or start a call).
# EXCEPTION (opt-in): -ChatOpen adds 4x (tap top chat row -> 3s -> BACK) and
# reads the B-691 [chat.open] bracket. ONLY use it with the messenger chat
# list already on screen on a QA account -- the tap coordinates (-TapX/-TapY,
# defaults for 1080x2400) must land on the FIRST conversation row.
# Interleave OLD/NEW builds when comparing (thermal drift lies -- CLAUDE.md).
#
# Reads (release builds only -- console.log is stripped, warn survives):
#   [LAGDIAG] JS thread blocked      -- watchdog stalls (B-285)
#   [LAGDIAG] [send.total]           -- send pipeline cost
#   [LAGDIAG] [backup.flush|merkle]  -- backup costs
#   [backup.merkle.shadow]           -- B-687 soak verdicts
#   [LAGDIAG] [crypto.floor]         -- B-688 floor probe (fires ~30s after boot)
#   [LAGDIAG] [chat.open]            -- B-691 tap->transitionEnd bracket (<300ms budget)

param(
  [int]$PassiveSeconds = 0,
  [switch]$SkipColdStart,
  [switch]$ChatOpen,
  [int]$TapX = 540,
  [int]$TapY = 640,
  [string]$Pkg = 'com.bravosecure.app'
)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# -- 0. Preconditions --------------------------------------------------------
$devices = (adb devices) -match "device$"
if (-not $devices) { throw 'No ADB device attached.' }
$serial = ($devices[0] -split "\s+")[0]
$model = (adb shell getprop ro.product.model).Trim()
$mem = ((adb shell "head -1 /proc/meminfo") -replace '\s+', ' ').Trim()
Write-Host "[dev] $serial  $model  $mem" -ForegroundColor Cyan
$installed = adb shell pm list packages | Select-String $Pkg
if (-not $installed) { throw "$Pkg not installed on $serial" }

# -- 1. Cold start x3 --------------------------------------------------------
$coldTimes = @()
if (-not $SkipColdStart) {
  foreach ($i in 1..3) {
    $out = adb shell am start -W -S -n "$Pkg/.MainActivity" 2>$null | Select-String 'TotalTime'
    if ($out) { $coldTimes += [int](($out -split ':')[1].Trim()) }
    Start-Sleep -Seconds 6
  }
  Write-Host "[cold] TotalTime ms: $($coldTimes -join ', ')" -ForegroundColor Cyan
} else {
  adb shell am start -n "$Pkg/.MainActivity" | Out-Null
  Start-Sleep -Seconds 3
}

# -- 2. Journey window (logcat + gfxinfo bracketed) -------------------------
adb logcat -c
adb shell dumpsys gfxinfo $Pkg reset | Out-Null
$logFile = Join-Path $env:TEMP "perf-journey-$(Get-Date -Format yyyyMMdd-HHmmss).log"
$logProc = Start-Process adb -ArgumentList 'logcat', '-v', 'time' -RedirectStandardOutput $logFile -NoNewWindow -PassThru

if ($PassiveSeconds -gt 0) {
  Write-Host "[journey] PASSIVE window: use the app normally for $PassiveSeconds s..." -ForegroundColor Yellow
  Start-Sleep -Seconds $PassiveSeconds
} else {
  Write-Host '[journey] scripted: 45s of swipes + BACK (no taps)' -ForegroundColor Yellow
  # Wait past nothing; scroll the visible list up/down repeatedly, with pauses,
  # then hardware BACK twice. Swipes are drags -- they never activate a row.
  foreach ($i in 1..6) {
    adb shell input swipe 540 1600 540 700 300   # scroll down
    Start-Sleep -Milliseconds 900
    adb shell input swipe 540 700 540 1600 300   # scroll back up
    Start-Sleep -Milliseconds 900
  }
  if ($ChatOpen) {
    # B-691/F4 -- the founder's actual complaint is the chat OPEN, and the
    # swipe-only journey never exercised it. Opt-in: needs the chat list on
    # screen; tap the first row, dwell, BACK. The [chat.open] bracket lands
    # at transitionEnd, well inside the 3s dwell.
    Write-Host "[journey] chat-open x4: tap ($TapX,$TapY) -> 3s -> BACK (chat list must be on screen)" -ForegroundColor Yellow
    foreach ($i in 1..4) {
      adb shell input tap $TapX $TapY
      Start-Sleep -Seconds 3
      adb shell input keyevent 4
      Start-Sleep -Seconds 2
    }
  }
  Start-Sleep -Seconds 8    # settle: let debounced work (flush/commit) fire
  adb shell input keyevent 4; Start-Sleep -Seconds 1
  adb shell input keyevent 4
  Start-Sleep -Seconds 12   # commit window tail
}

$gfx = adb shell dumpsys gfxinfo $Pkg
Stop-Process -Id $logProc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# -- 3. Parse ----------------------------------------------------------------
$log = Get-Content $logFile -ErrorAction SilentlyContinue
$stalls = @($log | Select-String 'JS thread blocked ~(\d+)ms' | ForEach-Object { [int]$_.Matches[0].Groups[1].Value })
$sends  = @($log | Select-String '\[send\.total\] ms=(\d+)'    | ForEach-Object { [int]$_.Matches[0].Groups[1].Value })
$walks  = @($log | Select-String '\[backup\.merkle\] tookMs=(\d+)' | ForEach-Object { [int]$_.Matches[0].Groups[1].Value })
$shadowMatch   = @($log | Select-String 'backup\.merkle\.shadow\] match=true').Count
$shadowDiverge = @($log | Select-String 'backup\.merkle\.shadow\] match=false').Count
$shadowUnusable = @($log | Select-String 'backup\.merkle\.shadow\] unusable').Count
$floor = ($log | Select-String '\[crypto\.floor\] (.+)$' | Select-Object -First 1)
$fatal = @($log | Select-String 'FATAL EXCEPTION').Count
$openTap   = @($log | Select-String '\[chat\.open\] \S+ \S+ tapToEnd=(\d+)ms' | ForEach-Object { [int]$_.Matches[0].Groups[1].Value })
$openMount = @($log | Select-String '\[chat\.open\] \S+ mountToEnd=(\d+)ms'   | ForEach-Object { [int]$_.Matches[0].Groups[1].Value })

$gfxJanky = ($gfx | Select-String 'Janky frames: (\d+) \(([\d.]+)%\)' | Select-Object -First 1)
$gfx95    = ($gfx | Select-String '95th percentile: (\d+)ms' | Select-Object -First 1)
$pssLine  = ((adb shell dumpsys meminfo $Pkg 2>$null) | Select-String 'TOTAL PSS:\s+(\d+)' | Select-Object -First 1)

function Stat($arr) {
  if ($arr.Count -eq 0) { return 'none' }
  $m = ($arr | Measure-Object -Maximum -Average -Sum)
  "n=$($arr.Count) avg=$([int]$m.Average)ms worst=$($m.Maximum)ms total=$([int]($m.Sum/1000))s"
}

# -- 4. Report vs S3 budgets ------------------------------------------------
$lines = @()
$lines += "# Perf journey -- $model ($serial) -- $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$lines += "Mode: $(if ($PassiveSeconds -gt 0) {"passive ${PassiveSeconds}s"} else {'scripted swipes 45s'})$(if ($ChatOpen) {' + 4x chat-open'})"
$lines += ''
$lines += '| metric | measured | budget (plan S3) | verdict |'
$lines += '|---|---|---|---|'
if ($coldTimes.Count -gt 0) {
  $bestWarm = ($coldTimes | Select-Object -Skip 1 | Measure-Object -Minimum).Minimum
  $lines += "| cold start (first / best-warm) | $($coldTimes[0]) / $bestWarm ms | <2500 ms (Go-class) | $(if ($coldTimes[0] -lt 2500) {'PASS'} else {'over (mid-tier device: informational)'}) |"
}
$worstStall = if ($stalls.Count) { ($stalls | Measure-Object -Maximum).Maximum } else { 0 }
$lines += "| JS stalls | $(Stat $stalls) | worst <250 ms in-burst | $(if ($worstStall -lt 250) {'PASS'} else {'FAIL'}) |"
$lines += "| send.total | $(Stat $sends) | tap->bubble <100 ms (proxy) | $(if ($sends.Count -eq 0) {'n/a'} elseif (($sends | Measure-Object -Average).Average -lt 500) {'PASS(proxy)'} else {'FAIL(proxy)'}) |"
$lines += "| merkle walks | $(Stat $walks) | near-zero after W2 flip | $(if ($walks.Count -eq 0) {'PASS'} else {'pre-flip: informational'}) |"
$lines += "| shadow verdicts | match=$shadowMatch diverge=$shadowDiverge unusable=$shadowUnusable | diverge=0 after first rebuild | $(if ($shadowDiverge -eq 0) {'PASS'} else {'FAIL -- do NOT flip'}) |"
if ($gfxJanky) { $lines += "| janky frames | $($gfxJanky.Matches[0].Groups[2].Value)% (95th $(if ($gfx95) {$gfx95.Matches[0].Groups[1].Value} else {'?'})ms) | scroll <=7.2% (B-279 baseline) | $(if ($ChatOpen) {'mixed journey (opens included) -- not comparable to the scroll baseline'} elseif ([double]$gfxJanky.Matches[0].Groups[2].Value -le 7.2) {'PASS'} else {'over baseline'}) |" }
if ($pssLine) { $lines += "| PSS | $([int]($pssLine.Matches[0].Groups[1].Value/1024)) MB | <350 MB steady | $(if ([int]($pssLine.Matches[0].Groups[1].Value/1024) -lt 350) {'PASS'} else {'FAIL'}) |" }
$worstOpen = if ($openTap.Count) { ($openTap | Measure-Object -Maximum).Maximum } else { 0 }
$lines += "| chat open (tap->transitionEnd) | $(Stat $openTap) | <300 ms (plan S3) | $(if ($openTap.Count -eq 0) {'n/a (run with -ChatOpen)'} elseif ($worstOpen -lt 300) {'PASS'} else {'FAIL'}) |"
if ($openMount.Count -gt 0) { $lines += "| chat open (mount->transitionEnd) | $(Stat $openMount) | informational (B-691) | -- |" }
$lines += "| crypto floor | $(if ($floor) {$floor.Matches[0].Groups[1].Value} else {'not captured (fires ~30s post-boot)'}) | informational (W5 gate) | -- |"
$lines += "| FATAL exceptions | $fatal | 0 | $(if ($fatal -eq 0) {'PASS'} else {'FAIL'}) |"
$lines += ''
$lines += "Raw log: $logFile"

$outDir = Join-Path $RepoRoot 'docs\qa\perf-runs'
New-Item -ItemType Directory -Force $outDir | Out-Null
$outFile = Join-Path $outDir "PERF_$(Get-Date -Format yyyyMMdd-HHmm)_$($model -replace '\s','').md"
$lines | Out-File $outFile -Encoding utf8
Write-Host ''
$lines | ForEach-Object { Write-Host $_ }
Write-Host "`n[ok] report: $outFile" -ForegroundColor Green
