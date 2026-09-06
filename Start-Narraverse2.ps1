[CmdletBinding()]
param(
  [switch]$Setup,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$setupScript = Join-Path $projectRoot 'tools\setup_narraverse2.ps1'
$startScript = Join-Path $projectRoot 'tools\start_narraverse.ps1'
$denovaExe = Join-Path $projectRoot 'denova-src\output\denova.exe'

if ($Setup -or -not (Test-Path -LiteralPath $denovaExe)) {
  if (-not (Test-Path -LiteralPath $setupScript)) {
    throw "初始化脚本不存在：$setupScript"
  }
  $setupArgs = @()
  if ($NoOpen) { $setupArgs += '-NoOpen' }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setupScript @setupArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  exit 0
}

if (-not (Test-Path -LiteralPath $startScript)) {
  throw "启动脚本不存在：$startScript"
}

$startArgs = @('-DenovaExe', $denovaExe)
if ($NoOpen) { $startArgs += '-NoOpen' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript @startArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
