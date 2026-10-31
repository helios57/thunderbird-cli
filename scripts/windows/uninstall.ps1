<#
.SYNOPSIS
  Removes what setup.ps1 set up: bridge autostart, the running bridge, the Claude Code MCP
  registration and skill. Keeps config.json (token/policy) unless -RemoveConfig is given.
  The Thunderbird extension is removed in Thunderbird (Add-ons and Themes > Remove).
#>
param([switch]$RemoveConfig)

$ErrorActionPreference = "Continue"
Unregister-ScheduledTask -TaskName "thunderbird-cli bridge" -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath("Startup")) "thunderbird-cli bridge.lnk") -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*bridge\bridge.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (Get-Command claude -ErrorAction SilentlyContinue) {
  & claude mcp remove thunderbird --scope user 2>&1 | Out-Null
}
Remove-Item -Recurse -Force (Join-Path $HOME ".claude\skills\thunderbird-cli") -ErrorAction SilentlyContinue
if ($RemoveConfig) {
  Remove-Item -Force (Join-Path $HOME ".config\thunderbird-cli\config.json") -ErrorAction SilentlyContinue
}
Write-Host "thunderbird-cli removed (config kept: $(-not $RemoveConfig))."
