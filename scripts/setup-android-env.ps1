$ErrorActionPreference = 'Stop'

$sdk      = "$env:LOCALAPPDATA\Android\Sdk"
$jdk      = 'C:\Program Files\Android\Android Studio\jbr'
$avdHome  = 'E:\AndroidAvd'
$gradleH  = 'E:\.gradle'

if (-not (Test-Path $avdHome)) { New-Item -ItemType Directory -Path $avdHome | Out-Null }
if (-not (Test-Path $gradleH)) { New-Item -ItemType Directory -Path $gradleH | Out-Null }

[Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdk, 'User')
[Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', $sdk, 'User')
[Environment]::SetEnvironmentVariable('JAVA_HOME', $jdk, 'User')
[Environment]::SetEnvironmentVariable('ANDROID_AVD_HOME', $avdHome, 'User')
[Environment]::SetEnvironmentVariable('GRADLE_USER_HOME', $gradleH, 'User')

$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $path) { $path = '' }

$additions = @(
  "$sdk\platform-tools",
  "$sdk\emulator",
  "$jdk\bin"
)

foreach ($entry in $additions) {
  if (($path -split ';') -notcontains $entry) {
    if ($path) { $path = "$path;$entry" } else { $path = $entry }
  }
}

[Environment]::SetEnvironmentVariable('Path', $path, 'User')
Write-Host "ANDROID_HOME     = $sdk"
Write-Host "JAVA_HOME        = $jdk"
Write-Host "ANDROID_AVD_HOME = $avdHome"
Write-Host "GRADLE_USER_HOME = $gradleH"
Write-Host "PATH updated (User scope)."
Write-Host ""
Write-Host "IMPORTANT: Quit Android Studio fully, then reopen it,"
Write-Host "so it picks up ANDROID_AVD_HOME before you create the AVD."
