<#
.SYNOPSIS
  Sets up thunderbird-cli for Claude Code on Windows.

.DESCRIPTION
  1. Installs the npm dependencies of this checkout.
  2. Writes %USERPROFILE%\.config\thunderbird-cli\config.json with a random bridge token and the
     access policy (kept if the file exists; only the policy is updated). bridge, tb and tb-mcp
     all read this file, so nothing needs environment variables.
  3. Starts the bridge at every logon, without a window (scheduled task; falls back to a
     Startup-folder shortcut if task registration is not allowed), and starts it now.
  4. Registers the MCP server with Claude Code (user scope) and installs the companion skill.
  5. Builds the Thunderbird extension (.xpi) and tells you where it is.

  Re-running is safe: it keeps the token, updates the policy and restarts the bridge.

.PARAMETER Policy
  What the agent may do: read | draft | organize | full. Default: draft
  (read everything, save drafts; never send, never delete).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1 -Policy organize
#>
param(
  [ValidateSet("read", "draft", "organize", "full")]
  [string]$Policy = "draft",
  [switch]$SkipTask,
  [switch]$SkipMcp,
  [switch]$SkipSkill
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskName = "thunderbird-cli bridge"
$me = "$env:USERDOMAIN\$env:USERNAME"

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

# Native tools write progress to stderr; in Windows PowerShell 5.1 that becomes an error record
# under "Stop". Run them with "Continue" and judge success by the exit code.
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $exe @arguments 2>&1 | ForEach-Object { Write-Host "   $_" }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Stop-Bridge {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*bridge\bridge.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# --- 1. Dependencies ------------------------------------------------
Step "Node.js and npm dependencies"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js not found. Install Node 20+ (https://nodejs.org) and run this again."
}
Write-Host "   node $(node -v)"
Push-Location $repo
try {
  if ((Invoke-Native "npm" @("ci", "--no-audit", "--no-fund")) -ne 0) { throw "npm ci failed" }
} finally { Pop-Location }

# --- 2. Config: token + policy --------------------------------------
Step "Config ($Policy)"
$cfgDir = Join-Path $HOME ".config\thunderbird-cli"
$cfgPath = Join-Path $cfgDir "config.json"
New-Item -ItemType Directory -Force $cfgDir | Out-Null
$cfg = [pscustomobject]@{}
if (Test-Path $cfgPath) {
  $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
if (-not $cfg.PSObject.Properties["bridge"]) {
  $cfg | Add-Member -NotePropertyName bridge -NotePropertyValue ([pscustomobject]@{})
}
if (-not $cfg.bridge.PSObject.Properties["authToken"] -or -not $cfg.bridge.authToken) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  $cfg.bridge | Add-Member -Force -NotePropertyName authToken -NotePropertyValue $token
  Write-Host "   new bridge token generated"
} else {
  Write-Host "   existing bridge token kept"
}
$cfg.bridge | Add-Member -Force -NotePropertyName policy -NotePropertyValue $Policy
# UTF-8 without BOM; readable by the current user only (it holds the bridge token).
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
Invoke-Native "icacls" @($cfgPath, "/inheritance:r", "/grant:r", "${me}:(F)") | Out-Null
Write-Host "   $cfgPath"

# --- 3. Bridge autostart --------------------------------------------
if (-not $SkipTask) {
  Step "Bridge autostart"
  $start = Join-Path $PSScriptRoot "start-bridge.ps1"
  $hiddenArgs = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$start`""
  $registered = $false
  try {
    $action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument $hiddenArgs
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -MultipleInstances IgnoreNew -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
      -Principal $principal -Description "thunderbird-cli: HTTP/WebSocket bridge between Claude Code and Thunderbird ($repo)" `
      -Force | Out-Null
    $registered = $true
    Write-Host "   scheduled task '$taskName' (at logon, restarts on failure)"
  } catch {
    Write-Warning "Scheduled task not allowed ($($_.Exception.Message)); using a Startup shortcut instead."
    $lnk = Join-Path ([Environment]::GetFolderPath("Startup")) "thunderbird-cli bridge.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath = "conhost.exe"
    $s.Arguments = $hiddenArgs
    $s.WorkingDirectory = $repo
    $s.Save()
    Write-Host "   $lnk"
  }

  Stop-Bridge
  if ($registered) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $taskName
  } else {
    Start-Process -FilePath "conhost.exe" -ArgumentList $hiddenArgs -WorkingDirectory $repo
  }

  $status = $null
  for ($i = 0; $i -lt 20 -and -not $status; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $status = Invoke-RestMethod -Uri "http://127.0.0.1:7700/bridge/status" `
        -Headers @{ Authorization = "Bearer $($cfg.bridge.authToken)" } -TimeoutSec 2
    } catch { }
  }
  if ($status) {
    Write-Host "   bridge running - policy: $($status.policy), extension: $($status.extension)"
  } else {
    Write-Warning "Bridge did not answer on 127.0.0.1:7700. See $env:LOCALAPPDATA\thunderbird-cli\bridge.err.log"
  }
}

# --- 4. Claude Code -------------------------------------------------
if (-not $SkipMcp) {
  Step "Claude Code MCP server"
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    Invoke-Native "claude" @("mcp", "remove", "thunderbird", "--scope", "user") | Out-Null
    $server = Join-Path $repo "mcp\src\server.js"
    if ((Invoke-Native "claude" @("mcp", "add", "--scope", "user", "thunderbird", "--", "node", $server)) -ne 0) {
      Write-Warning "claude mcp add failed - run it by hand: claude mcp add --scope user thunderbird -- node `"$server`""
    }
  } else {
    Write-Warning "claude not on PATH. Later run: claude mcp add --scope user thunderbird -- node `"$repo\mcp\src\server.js`""
  }
}

if (-not $SkipSkill) {
  Step "Claude Code skill"
  $skills = Join-Path $HOME ".claude\skills"
  New-Item -ItemType Directory -Force $skills | Out-Null
  Copy-Item -Recurse -Force (Join-Path $repo "skills\thunderbird-cli") $skills
  Write-Host "   $skills\thunderbird-cli"
}

# --- 5. Extension ---------------------------------------------------
Step "Thunderbird extension"
Push-Location $repo
try { Invoke-Native "node" @("scripts/build-xpi.mjs") | Out-Null } finally { Pop-Location }
$version = (Get-Content (Join-Path $repo "extension\manifest.json") -Raw | ConvertFrom-Json).version
$xpi = Join-Path $repo "dist\thunderbird-cli-$version.xpi"
Write-Host "   $xpi"
Write-Host @"

Next: install the extension in Thunderbird (once):
  Thunderbird > Add-ons and Themes (Ctrl+Shift+A) > gear icon > Install Add-on From File...
  > $xpi
Then check:  node "$repo\cli\src\cli.js" health
"@ -ForegroundColor Green
