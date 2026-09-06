param(
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$denovaRoot = Join-Path $projectRoot 'denova-src'
$webRoot = Join-Path $denovaRoot 'web'

function Resolve-CommandPath([string]$name, [string]$envName) {
  $configured = [Environment]::GetEnvironmentVariable($envName)
  if ($configured -and (Test-Path -LiteralPath $configured)) { return $configured }
  $command = Get-Command $name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "$name was not found. Install it and rerun this script."
}

function Get-Version([string]$commandPath, [string[]]$arguments) {
  $text = (& $commandPath @arguments 2>$null | Select-Object -First 1).ToString().Trim()
  if ($text -match '(\d+\.\d+(?:\.\d+)?)') { return [version]$Matches[1] }
  throw "Unable to read version from $commandPath."
}

function Stop-ExactDenovaProcess([string]$executablePath) {
  $target = [IO.Path]::GetFullPath($executablePath)
  $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target })
  if ($running.Count -eq 0) { return }

  Write-Host "==> Stop previous Denova executable at exact path: $target"
  foreach ($process in $running) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
  }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $stillRunning = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target })
    if ($stillRunning.Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "The previous Denova executable did not stop: $target"
}

$python = Resolve-CommandPath 'python' 'NARRAVERSE_PYTHON'
$node = Resolve-CommandPath 'node' 'NARRAVERSE_NODE'
$pnpm = Resolve-CommandPath 'pnpm' 'NARRAVERSE_PNPM'
$localGo = Join-Path $projectRoot 'tools\go\bin\go.exe'
$go = if (Test-Path -LiteralPath $localGo) { $localGo } else { Resolve-CommandPath 'go' 'NARRAVERSE_GO' }
$bashCandidates = @(
  [Environment]::GetEnvironmentVariable('NARRAVERSE_BASH'),
  (Join-Path ${env:ProgramFiles} 'Git\bin\bash.exe'),
  (Join-Path ${env:ProgramFiles} 'Git\usr\bin\bash.exe'),
  (Get-Command bash -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
)
$bash = $bashCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $bash) { throw 'Git Bash was not found. Install Git for Windows and rerun this script.' }
$env:Path = (Split-Path -Parent $go) + ';' + $env:Path
$env:GOROOT = Split-Path -Parent (Split-Path -Parent $go)

if ((Get-Version $node @('--version')) -lt [version]'20.0') { throw 'Node.js 20 or newer is required.' }
if ((Get-Version $pnpm @('--version')) -lt [version]'8.0') { throw 'pnpm 8 or newer is required.' }
$goText = (& $go version 2>&1 | Select-Object -First 1).ToString()
if ($goText -notmatch 'go(\d+\.\d+(?:\.\d+)?)') { throw 'Unable to read Go version.' }
if ([version]$Matches[1] -lt [version]'1.26.5') { throw 'Go 1.26.5 or newer is required.' }

$releaseExe = Join-Path $denovaRoot 'output\denova.exe'
Stop-ExactDenovaProcess $releaseExe

Write-Host '==> Generate local library'
& $python (Join-Path $projectRoot 'tools\gen_local_library_v2.py')

Write-Host '==> Sync Narraverse assets into Denova source'
& $node (Join-Path $denovaRoot 'scripts\sync-narraverse-assets.mjs') (Join-Path $projectRoot 'app')

Write-Host '==> Install frontend dependencies'
Push-Location $webRoot
try { & $pnpm install --frozen-lockfile }
finally { Pop-Location }

Write-Host '==> Build Denova executable with the repository build script'
Push-Location $denovaRoot
try { & $bash (Join-Path $denovaRoot 'scripts\build.sh') }
finally { Pop-Location }

$exe = Join-Path $denovaRoot 'output\denova.exe'
if (-not (Test-Path -LiteralPath $exe)) { $exe = Join-Path $denovaRoot 'output\denova' }
if (-not (Test-Path -LiteralPath $exe)) { throw "Denova executable was not produced in $($denovaRoot)\output." }

Write-Host "==> Start Denova: $exe"
$startScript = Join-Path $projectRoot 'tools\start_narraverse.ps1'
$startArgs = @('-DenovaExe', $exe)
if ($NoOpen) { $startArgs += '-NoOpen' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript @startArgs
