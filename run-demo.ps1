<#
.SYNOPSIS
    Start the GridShift demo: API on 8001, dashboard on 3000.

.DESCRIPTION
    Opens each server in its own window, so both outlive the shell that
    launched them and either can be restarted without touching the other.
    Close the windows to stop them.

    Everything runs out of .venv in this repository. It used to run out of a
    virtualenv under %TEMP%, which Windows Storage Sense is entitled to delete
    without warning -- not something to discover an hour before a demo.

.PARAMETER Agent
    gemini  the live agent: real function calling, about 80 s a run, needs
            GEMINI_API_KEY in .env and a working network.
    fake    the scripted stream: about 17 s, no key, no network, and the
            IDENTICAL plan -- the optimizer decides it either way and the
            agent only narrates. This is the one to fall back to on stage.

.PARAMETER Forecast
    backtest  the real metered day from data/processed/backtests (default).
    fixtures  the authored curves, if the artifacts are missing.

.PARAMETER Dev
    Run the dashboard with `next dev` instead of a production build. Slower to
    respond and it recompiles as you click; use it for development, not a demo.

.PARAMETER Only
    Start one half. `dashboard` rebuilds and restarts the UI while leaving the
    API up, which is what you want after a frontend edit -- restarting both
    would drop any run already on screen.

.EXAMPLE
    .\run-demo.ps1
    .\run-demo.ps1 -Agent fake
    .\run-demo.ps1 -Only dashboard
#>
[CmdletBinding()]
param(
    [ValidateSet('gemini', 'fake')]
    [string]$Agent = 'gemini',

    [ValidateSet('backtest', 'fixtures')]
    [string]$Forecast = 'backtest',

    [switch]$Dev,

    [ValidateSet('both', 'api', 'dashboard')]
    [string]$Only = 'both'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'

# Node is installed on this machine but is not on the default PATH, and a
# fresh PowerShell window inherits that. The dashboard window used to open,
# fail on `npm` instantly and close again, leaving the API up and nothing on
# :3000 -- which reads exactly like a frontend crash and is not one.
$nodeDir = $null
$onPath = Get-Command npm -ErrorAction SilentlyContinue
$candidates = @()
if ($onPath) { $candidates += (Split-Path $onPath.Source) }
$candidates += @(
    (Join-Path $env:ProgramFiles 'nodejs'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs')
)
foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path (Join-Path $candidate 'npm.cmd'))) { $nodeDir = $candidate; break }
}
if (-not $nodeDir) {
    Write-Host "Could not find npm. Install Node, or put its folder on PATH." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $python)) {
    Write-Host "No virtualenv at $python" -ForegroundColor Red
    Write-Host "Create one with:" -ForegroundColor Yellow
    Write-Host "  python -m venv .venv"
    Write-Host "  .venv\Scripts\python.exe -m pip install -r backend\requirements.txt"
    exit 1
}

# A port still held by a previous run is the single most common reason a demo
# "does not pick up my changes": the old server answers and the new one never
# binds. Say so rather than starting a second copy that silently loses.
$startApi = $Only -in @('both', 'api')
$startDashboard = $Only -in @('both', 'dashboard')

$wanted = @()
if ($startApi) { $wanted += 8001 }
if ($startDashboard) { $wanted += 3000 }
foreach ($port in $wanted) {
    $held = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($held) {
        $owner = (Get-Process -Id $held[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
        Write-Host "Port $port is already in use by $owner (pid $($held[0].OwningProcess))." -ForegroundColor Yellow
        Write-Host "  Stop it first:  Stop-Process -Id $($held[0].OwningProcess) -Force"
        exit 1
    }
}

if ($startApi -and $Agent -eq 'gemini') {
    $envFile = Join-Path $root '.env'
    $hasKey = (Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^\s*GEMINI_API_KEY\s*=\s*\S' -Quiet)
    if (-not $hasKey) {
        Write-Host "GEMINI_API_KEY is not set in .env, so the live agent cannot run." -ForegroundColor Yellow
        Write-Host "Falling back to the scripted agent. Re-run with -Agent fake to silence this." -ForegroundColor Yellow
        $Agent = 'fake'
    }
}

Write-Host ""
Write-Host "GridShift" -ForegroundColor Cyan
Write-Host "  agent    $Agent"
Write-Host "  forecast $Forecast"
Write-Host "  python   $python"
Write-Host "  node     $nodeDir"
Write-Host ""

# --- API ------------------------------------------------------------------
if ($startApi) {
$backend = @"
`$host.UI.RawUI.WindowTitle = 'GridShift API :8001'
Set-Location '$root\backend'
`$env:GRIDSHIFT_AGENT = '$Agent'
`$env:GRIDSHIFT_FORECAST = '$Forecast'
& '$python' -m uvicorn app.main:app --port 8001
"@
Start-Process powershell -ArgumentList '-NoExit', '-Command', $backend
Write-Host "API starting on http://localhost:8001 ..." -NoNewline

$ready = $false
foreach ($attempt in 1..40) {
    Start-Sleep -Milliseconds 500
    try {
        Invoke-WebRequest -Uri 'http://127.0.0.1:8001/health' -UseBasicParsing -TimeoutSec 2 | Out-Null
        $ready = $true
        break
    } catch { }
}
if ($ready) { Write-Host " ready" -ForegroundColor Green }
else { Write-Host " no health response yet; check its window" -ForegroundColor Yellow }
}

# --- Dashboard ------------------------------------------------------------
if ($startDashboard) {
# NEXT_PUBLIC_* is inlined at build time, so frontend\.env.local has to name
# the API before this builds, not after.
if ($Dev) {
    $cmd = 'npm run dev'
} else {
    $cmd = 'npm run build; if ($?) { npm run start }'
}

$frontend = @"
`$host.UI.RawUI.WindowTitle = 'GridShift dashboard :3000'
Set-Location '$root\frontend'
`$env:PATH = '$nodeDir' + ';' + `$env:PATH
$cmd
if (-not `$?) { Write-Host ''; Write-Host 'The dashboard exited with an error - scroll up.' -ForegroundColor Red }
"@
Start-Process powershell -ArgumentList '-NoExit', '-Command', $frontend

Write-Host ""
if ($Dev) {
    Write-Host "Dashboard starting on http://localhost:3000" -ForegroundColor Green
} else {
    Write-Host "Dashboard building, then starting on http://localhost:3000" -ForegroundColor Green
    Write-Host "(first build takes about a minute; it is cached after that)"
}
}
Write-Host ""
Write-Host "Both run in their own windows. Close them to stop." -ForegroundColor DarkGray
