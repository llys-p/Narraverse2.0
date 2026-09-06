[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://127.0.0.1:8080',
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$denovaExe = Join-Path $projectRoot 'denova-src\output\denova.exe'
$base = $BaseUrl.TrimEnd('/')

function Get-OkResponse([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10
    if ($response.StatusCode -ne 200) { throw "HTTP $($response.StatusCode)" }
    return $response
  } catch {
    throw "请求失败：$Url；$($_.Exception.Message)"
  }
}

if (-not (Test-Path -LiteralPath $denovaExe)) { throw "找不到正式 executable：$denovaExe" }
$exePath = (Resolve-Path -LiteralPath $denovaExe).Path
$running = Get-CimInstance Win32_Process -Filter "Name = 'denova.exe'" |
  Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $exePath }
if (-not $running) { throw "正式 executable 未运行：$exePath" }

$rootResponse = Get-OkResponse $base
$statusResponse = Get-OkResponse "$base/api/status"
$narraverseResponse = Get-OkResponse "$base/narraverse/index.html?embedded=denova"
$bridgeResponse = Get-OkResponse 'http://127.0.0.1:8097/api/denova/health'

$scriptRefs = [regex]::Matches(
  $narraverseResponse.Content,
  '<script[^>]+src="([^"]+)"',
  [Text.RegularExpressions.RegexOptions]::IgnoreCase
) | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
$failedScripts = [System.Collections.Generic.List[string]]::new()
foreach ($scriptRef in $scriptRefs) {
  try {
    $scriptResponse = Get-OkResponse "$base/narraverse/$scriptRef"
    if ($scriptResponse.Content.Length -eq 0) { $failedScripts.Add($scriptRef) }
  } catch {
    $failedScripts.Add($scriptRef)
  }
}
if ($failedScripts.Count -gt 0) { throw "脚本资源失败：$($failedScripts -join ', ')" }

$modelGatewayChecks = [System.Collections.Generic.List[object]]::new()
$modelGatewayState = 'skipped'
if (-not $SkipTests) {
  $node = Get-Command node -ErrorAction Stop
  Get-ChildItem (Join-Path $projectRoot 'tools\test_module4_*.js') | ForEach-Object {
    & $node.Source $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "Module4 测试失败：$($_.Name)" }
  }
  Push-Location (Join-Path $projectRoot 'denova-src\web')
  try {
    & $node.Source '.\scripts\test-narraverse-page-smoke.mjs'
    if ($LASTEXITCODE -ne 0) { throw 'Page smoke test failed.' }
  } finally {
    Pop-Location
  }

  # Exercise the same status/test endpoints exposed by all four module UIs.
  # Upstream authentication/configuration failures are reported as a distinct
  # state; only a missing local gateway route or malformed response aborts the
  # verifier. No credential or provider response body is printed.
  $modelModules = @('writing', 'game', 'narraverse', 'module4')
  foreach ($module in $modelModules) {
    try {
      $status = Invoke-RestMethod -Uri "$base/api/model/status?module=$module" -Method Get -UseBasicParsing -TimeoutSec 10
      $test = Invoke-RestMethod -Uri "$base/api/model/test?module=$module" -Method Post -UseBasicParsing -TimeoutSec 30 `
        -ContentType 'application/json' -Body (@{ module = $module } | ConvertTo-Json -Compress)
    } catch {
      throw ('Model gateway endpoint unavailable for {0}; check the local Denova route and executable.' -f $module)
    }
    if ([string]$status.module -ne $module -or [string]$test.module -ne $module) {
      throw ('Model gateway returned a mismatched module for {0}.' -f $module)
    }
    $upstreamStatus = [int]$test.upstream_status
    $code = [string]$test.code
    $state = if ([bool]$test.ok) {
      'passed'
    } elseif ($code -eq 'unauthorized' -or $upstreamStatus -in @(401, 403)) {
      'provider-auth-required'
    } elseif ($code -eq 'not_found' -or $upstreamStatus -eq 404) {
      'provider-endpoint-not-found'
    } elseif ($code -eq 'not_configured') {
      'not-configured'
    } else {
      'provider-error'
    }
    $modelGatewayChecks.Add([PSCustomObject]@{
      Module = $module
      Configured = [bool]$status.configured
      TestOK = [bool]$test.ok
      UpstreamStatus = $upstreamStatus
      Code = $code
      State = $state
    })
  }
  $modelGatewayState = if (@($modelGatewayChecks | Where-Object { $_.State -eq 'passed' }).Count -eq $modelModules.Count) {
    'passed'
  } elseif (@($modelGatewayChecks | Where-Object { $_.State -eq 'provider-auth-required' }).Count -gt 0) {
    'provider-auth-required'
  } elseif (@($modelGatewayChecks | Where-Object { $_.State -eq 'provider-endpoint-not-found' }).Count -gt 0) {
    'provider-endpoint-not-found'
  } elseif (@($modelGatewayChecks | Where-Object { $_.State -eq 'not-configured' }).Count -gt 0) {
    'not-configured'
  } else {
    'provider-error'
  }
}

$testStatus = 'passed'
if ($SkipTests) { $testStatus = 'skipped' }

[PSCustomObject]@{
  Executable = $exePath
  ProcessId = @($running | Select-Object -ExpandProperty ProcessId)
  Root = $rootResponse.StatusCode
  ApiStatus = $statusResponse.StatusCode
  Narraverse = $narraverseResponse.StatusCode
  Bridge = $bridgeResponse.StatusCode
  ScriptCount = $scriptRefs.Count
  ScriptFailures = $failedScripts.Count
  Tests = $testStatus
  ModelGateway = $modelGatewayState
  ModelChecks = @($modelGatewayChecks)
} | ConvertTo-Json -Compress
