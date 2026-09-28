[CmdletBinding()]
param([switch]$NoOpen)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $projectRoot 'denova-src\output\denova.exe'
$outputDir = Split-Path -Parent $exe
$workspaceDir = Join-Path (Split-Path -Parent $projectRoot) 'Narraverse2.0-runtime'
$dataDir = Join-Path $workspaceDir '.denova'
$port = 18095
$baseUrl = "http://127.0.0.1:$port"
$pageUrl = "$baseUrl/?mode=library"

foreach ($path in @($exe, $workspaceDir, $dataDir)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required path is missing: $path"
  }
}
$exe = (Resolve-Path -LiteralPath $exe).Path

$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
$owners = @($listeners | ForEach-Object OwningProcess | Sort-Object -Unique)
if ($owners.Count -gt 1) {
  throw "Port $port has multiple owners; not starting another server."
}

$started = $null
if ($owners.Count -eq 1) {
  $listenerPid = $owners[0]
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid"
  if (-not $owner -or $owner.ExecutablePath -ne $exe) {
    throw "Port $port belongs to another program; stop it yourself before launching Narraverse."
  }
} else {
  $env:DENOVA_WORKSPACE = $workspaceDir
  $env:DENOVA_DIR = $dataDir
  $env:DENOVA_BACKEND_PORT = "$port"
  $started = Start-Process -FilePath $exe -ArgumentList '--no-open' `
    -WorkingDirectory $outputDir -WindowStyle Hidden -PassThru
}

try {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    try {
      $health = Invoke-WebRequest -Uri "$baseUrl/api/status" -UseBasicParsing -TimeoutSec 2
      if ($health.StatusCode -eq 200) { break }
    } catch {
      if ($started -and $started.HasExited) { throw 'Denova exited before becoming ready.' }
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)
  if (-not $health -or $health.StatusCode -ne 200) {
    throw "Denova did not become ready on port $port."
  }

  $liveOwners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
    ForEach-Object OwningProcess | Sort-Object -Unique)
  if ($liveOwners.Count -ne 1) { throw "Port $port has an unexpected owner." }
  $liveProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($liveOwners[0])"
  if (-not $liveProcess -or $liveProcess.ExecutablePath -ne $exe) {
    throw "Port $port is not served by the expected release executable."
  }

  $response = Invoke-RestMethod -Uri "$baseUrl/api/work-libraries" -TimeoutSec 5
  $libraryFiles = @(Get-ChildItem -LiteralPath (Join-Path $dataDir 'libraries') `
    -Filter 'library-*.json' -File -ErrorAction SilentlyContinue)
  if ($libraryFiles.Count -gt 0 -and @($response.libraries).Count -eq 0) {
    throw 'Library files exist, but the running server returned an empty library list.'
  }
} catch {
  if ($started -and -not $started.HasExited) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($started.Id)"
    if ($current -and $current.ExecutablePath -eq $exe) {
      Stop-Process -Id $started.Id -ErrorAction SilentlyContinue
    }
  }
  throw
}

if ($NoOpen) {
  Write-Output $pageUrl
} else {
  Start-Process -FilePath $pageUrl
}
