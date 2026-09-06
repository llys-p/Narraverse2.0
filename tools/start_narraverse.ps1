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
$denovaExePath = (Resolve-Path -LiteralPath $DenovaExe).Path
$launchExePath = $denovaExePath
$launchWorkingDirectory = Split-Path -Parent $denovaExePath
$launchWebDirectory = $null
if ((Split-Path -Leaf $launchWorkingDirectory) -eq 'output') {
  $packagedWeb = Join-Path $launchWorkingDirectory 'web'
  if (Test-Path -LiteralPath (Join-Path $packagedWeb 'index.html')) {
    $launchWebDirectory = $packagedWeb
  }
  $sourceRoot = Split-Path -Parent $launchWorkingDirectory
  if (Test-Path -LiteralPath (Join-Path $sourceRoot 'go.mod')) {
    # Release artifacts live in output/, while the existing .denova runtime
    # data belongs to denova-src/. Start from the source root so rebuilding the
    # executable never creates a second empty runtime beside it.
    $launchWorkingDirectory = $sourceRoot
  }
}
if ([IO.Path]::GetExtension($denovaExePath) -eq '') {
  $launchExePath = "$denovaExePath.exe"
  $existingLaunchProcess = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq [IO.Path]::GetFullPath($launchExePath) }
  if (-not $existingLaunchProcess) {
    Copy-Item -LiteralPath $denovaExePath -Destination $launchExePath -Force
  }
}

function Get-ConfiguredPorts {
  $ports = [System.Collections.Generic.List[int]]::new()
  if ($env:DENOVA_FRONTEND_PORT -match '^\d+$') { $ports.Add([int]$env:DENOVA_FRONTEND_PORT) }
  if ($env:DENOVA_BACKEND_PORT -match '^\d+$') { $ports.Add([int]$env:DENOVA_BACKEND_PORT) }
  $configCandidates = @(
    (Join-Path (Split-Path -Parent $DenovaExe) 'config.toml'),
    (Join-Path (Split-Path -Parent $DenovaExe) '.denova\config.toml'),
    (Join-Path $launchWorkingDirectory 'config.toml'),
    (Join-Path $launchWorkingDirectory '.denova\config.toml')
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
    $uri = [Uri]$Url
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -ne 200 -or $response.Content -notmatch 'Denova|Nova') { return $false }
    $connections = Get-NetTCPConnection -State Listen -LocalPort $uri.Port -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
      if ($process -and $process.ExecutablePath -and
          [IO.Path]::GetFullPath($process.ExecutablePath) -eq [IO.Path]::GetFullPath($launchExePath)) {
        return $true
      }
    }
    return $false
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
$running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq [IO.Path]::GetFullPath($launchExePath) }
$activeUrl = $null
if ($running) {
  $activeUrl = $candidateUrls | Where-Object { Test-DenovaFrontend $_ } | Select-Object -First 1
}

if (-not $activeUrl) {
  if (-not $running) {
    $previousWebDirectory = $env:DENOVA_WEB_DIR
    try {
      if ($launchWebDirectory) { $env:DENOVA_WEB_DIR = $launchWebDirectory }
      Start-Process -FilePath $launchExePath -WorkingDirectory $launchWorkingDirectory -WindowStyle Hidden
    } finally {
      if ($null -eq $previousWebDirectory) { Remove-Item Env:DENOVA_WEB_DIR -ErrorAction SilentlyContinue }
      else { $env:DENOVA_WEB_DIR = $previousWebDirectory }
    }
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
