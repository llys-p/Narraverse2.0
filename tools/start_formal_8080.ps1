param(
    [string]$DataDir = 'D:\Narraverse2.0\denova-src\.denova',
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $repo 'denova-src'
$binary = Join-Path $backend 'output\denova.exe'
$web = Join-Path $backend 'web\dist'
$booksFile = Join-Path $DataDir 'books.json'

foreach ($required in @($binary, (Join-Path $web 'index.html'), $booksFile)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing release file: $required" }
}
$listener = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) { throw "Port 8080 is already in use by PID $($listener.OwningProcess). Stop that exact process before starting this release." }

$books = Get-Content -LiteralPath $booksFile -Raw -Encoding UTF8 | ConvertFrom-Json
$workspace = [string]$books.current
if (-not $workspace -or -not (Test-Path -LiteralPath $workspace -PathType Container)) {
    throw 'The active book path in books.json is missing. Choose a valid book before starting this release.'
}

$env:DENOVA_DIR = (Resolve-Path -LiteralPath $DataDir).Path
$env:DENOVA_WORKSPACE = (Resolve-Path -LiteralPath $workspace).Path
$env:DENOVA_BACKEND_PORT = '8080'
$env:DENOVA_WEB_DIR = (Resolve-Path -LiteralPath $web).Path
$process = Start-Process -FilePath $binary -WorkingDirectory $backend -WindowStyle Hidden -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($process.HasExited) { throw "Denova exited during startup (code $($process.ExitCode))." }
    $response = $null
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/api/status' -UseBasicParsing -TimeoutSec 2
    } catch { }
    $owner = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($owner -and $owner.OwningProcess -ne $process.Id) { throw "A different process owns port 8080 (PID $($owner.OwningProcess))." }
    if ($response -and $response.StatusCode -eq 200 -and $owner) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw "Denova PID $($process.Id) did not become healthy on 8080." }
Write-Output "Denova release ready on http://127.0.0.1:8080/ (PID $($process.Id)); data=$env:DENOVA_DIR"
if (-not $NoOpen) { Start-Process 'http://127.0.0.1:8080/' }
