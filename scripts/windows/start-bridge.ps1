<#
.SYNOPSIS
  Runs the thunderbird-cli bridge in the foreground of this process.

.DESCRIPTION
  Started at logon by the scheduled task (or Startup shortcut) that setup.ps1 creates, via
  "conhost.exe --headless" so no console window appears. Token and policy come from
  %USERPROFILE%\.config\thunderbird-cli\config.json. Output goes to
  %LOCALAPPDATA%\thunderbird-cli\bridge.log (previous run: bridge.log.1).
#>
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bridge = Join-Path $repo "bridge\bridge.js"
$logDir = Join-Path $env:LOCALAPPDATA "thunderbird-cli"
New-Item -ItemType Directory -Force $logDir | Out-Null

# Stop-ScheduledTask ends this wrapper but not node: a bridge from an earlier start keeps the
# ports and its log file open, so this start would fail and the old code keep running.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*bridge\bridge.js*" } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
  }

$out = Join-Path $logDir "bridge.log"
$err = Join-Path $logDir "bridge.err.log"
foreach ($f in @($out, $err)) {
  if (Test-Path $f) { Move-Item $f "$f.1" -Force }
}

$node = (Get-Command node -ErrorAction Stop).Source
$p = Start-Process -FilePath $node -ArgumentList "`"$bridge`"" -WorkingDirectory $repo `
  -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow -PassThru -Wait
exit $p.ExitCode
