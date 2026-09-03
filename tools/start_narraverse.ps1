param(
  [string]$DenovaExe = $env:DENOVA_EXE,
  [string]$FrontendUrl = $env:DENOVA_FRONTEND_URL,
  [string]$PythonExe = $env:NARRAVERSE_PYTHON,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $PSScriptRoot 'logs'

function Test-LocalService([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Start-LocalBridge {
  param(
    [string]$Name,
    [string]$ScriptPath,
    [string]$HealthUrl,
    [switch]$Optional
  )
  if (Test-LocalService $HealthUrl) { return $true }
  if (-not $PythonExe) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) { $script:PythonExe = $pythonCommand.Source }
  }
  if (-not $PythonExe -or -not (Test-Path -LiteralPath $PythonExe)) {
    if ($Optional) { return $false }
    throw "Python was not found. Set NARRAVERSE_PYTHON to a valid python.exe path before starting $Name."
  }
  if (-not (Test-Path -LiteralPath $ScriptPath)) {
    if ($Optional) { return $false }
    throw "Bridge script was not found: $ScriptPath"
  }
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  Start-Process -FilePath $PythonExe -ArgumentList @($ScriptPath) `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot "$Name.out.log") `
    -RedirectStandardError (Join-Path $logRoot "$Name.err.log")
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (Test-LocalService $HealthUrl) { return $true }
  }
  if ($Optional) { return $false }
  throw "$Name failed to start. Check logs in $logRoot."
}

$null = Start-LocalBridge `
  -Name 'denova-bridge' `
  -ScriptPath (Join-Path $PSScriptRoot 'denova_bridge.py') `
  -HealthUrl 'http://127.0.0.1:8097/api/denova/health'

$pixivConfig = Join-Path $PSScriptRoot 'pixiv_config.json'
if (Test-Path -LiteralPath $pixivConfig) {
  $null = Start-LocalBridge `
    -Name 'pixiv-bridge' `
    -ScriptPath (Join-Path $PSScriptRoot 'pixiv_bridge.py') `
    -HealthUrl 'http://127.0.0.1:8098/api/pixiv/status' `
    -Optional
}

if (-not $DenovaExe) {
  $DenovaExe = Join-Path $projectRoot 'denova\denova.exe'
}
if (-not (Test-Path -LiteralPath $DenovaExe)) {
  throw "Denova was not found at $DenovaExe. Set -DenovaExe or DENOVA_EXE to override it."
}

function Get-ConfiguredPorts {
  $ports = [System.Collections.Generic.List[int]]::new()
  if ($env:DENOVA_FRONTEND_PORT -match '^\d+$') { $ports.Add([int]$env:DENOVA_FRONTEND_PORT) }
  if ($env:DENOVA_BACKEND_PORT -match '^\d+$') { $ports.Add([int]$env:DENOVA_BACKEND_PORT) }
  $configCandidates = @(
    (Join-Path (Split-Path -Parent $DenovaExe) 'config.toml'),
    (Join-Path (Split-Path -Parent $DenovaExe) '.denova\config.toml')
  )
  foreach ($configPath in $configCandidates) {
    if (-not (Test-Path -LiteralPath $configPath)) { continue }
    foreach ($line in Get-Content -LiteralPath $configPath) {
      if ($line -match '^\s*(?:frontend|backend)_port\s*=\s*(\d+)\s*$') {
        $ports.Add([int]$Matches[1])
      }
    }
  }
  if ($ports.Count -eq 0) {
    # Release builds serve the frontend from the backend port; source builds usually use Vite.
    $ports.Add(8080)
    $ports.Add(5173)
  }
  return $ports | Select-Object -Unique
}

function Test-DenovaFrontend([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200 -and $response.Content -match 'Denova|Nova'
  } catch {
    return $false
  }
}

function Get-CandidateUrls {
  $urls = [System.Collections.Generic.List[string]]::new()
  if ($FrontendUrl) { $urls.Add($FrontendUrl.TrimEnd('/')) }
  foreach ($port in Get-ConfiguredPorts) {
    $urls.Add("http://127.0.0.1:$port")
  }
  foreach ($port in 8080..8090) {
    $urls.Add("http://127.0.0.1:$port")
  }
  foreach ($port in 5173..5190) {
    $urls.Add("http://127.0.0.1:$port")
  }
  return $urls | Select-Object -Unique
}

$candidateUrls = Get-CandidateUrls
$activeUrl = $candidateUrls | Where-Object { Test-DenovaFrontend $_ } | Select-Object -First 1

if (-not $activeUrl) {
  $running = Get-Process -Name 'denova' -ErrorAction SilentlyContinue
  if (-not $running) {
    Start-Process -FilePath $DenovaExe -WorkingDirectory (Split-Path -Parent $DenovaExe) -WindowStyle Hidden
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 500
    $activeUrl = $candidateUrls | Where-Object { Test-DenovaFrontend $_ } | Select-Object -First 1
  } while (-not $activeUrl -and [DateTime]::UtcNow -lt $deadline)
}

if (-not $activeUrl) {
  throw 'Denova started, but its frontend is unavailable. Check Denova logs or set DENOVA_FRONTEND_URL.'
}

$narraverseUrl = "$activeUrl/?mode=narraverse"
if ($NoOpen) {
  Write-Output $narraverseUrl
} else {
  Start-Process -FilePath $narraverseUrl
}
