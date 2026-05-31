#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$VencordDir  = "$env:USERPROFILE\Vencord"
$PluginRepo  = "https://github.com/brentspine/nrc-ticket-util"
$VencordRepo = "https://github.com/Vendicated/Vencord.git"
$TaskName    = "VencordAutoInject"

function Write-Step { param([string]$msg) Write-Host "`n$msg" -ForegroundColor Yellow }
function Write-OK   { param([string]$msg) Write-Host "  $msg" -ForegroundColor Green }
function Write-Info { param([string]$msg) Write-Host "  $msg" -ForegroundColor Cyan }
function Abort      { param([string]$msg) Write-Host "`nERROR: $msg" -ForegroundColor Red; Read-Host "`nPress Enter to exit"; exit 1 }

Write-Host ""
Write-Host "  NRC Ticket Util - Vencord Installer" -ForegroundColor Cyan
Write-Host "  =====================================" -ForegroundColor Cyan

Write-Step "[1/6] Checking prerequisites..."

try {
    $nodeRaw = (& node --version 2>&1) -as [string]
    $major   = [int]($nodeRaw -replace '^v(\d+)\..*$', '$1')
    if ($major -lt 18) { Abort "Node.js 18+ required. Found: $nodeRaw" }
    Write-OK "Node.js $nodeRaw"
} catch {
    Abort "Node.js not found. Install Node.js 18+ from https://nodejs.org"
}

try {
    & git --version | Out-Null
    Write-OK "Git"
} catch {
    Abort "Git not found. Install Git from https://git-scm.com"
}

Write-Step "[2/6] Setting up Vencord at $VencordDir..."

if (Test-Path "$VencordDir\.git") {
    Write-Info "Already cloned -- pulling latest..."
    & git -C $VencordDir pull --ff-only
} else {
    & git clone $VencordRepo $VencordDir
}

Set-Location $VencordDir

Write-Step "[3/6] Installing pnpm@10.4.1..."
& npm install -g pnpm@10.4.1

$machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath    = [System.Environment]::GetEnvironmentVariable("Path", "User")
$env:PATH    = "$machinePath;$userPath"

Write-Step "[4/6] Installing Vencord dependencies..."
& pnpm install --frozen-lockfile

Write-Step "[5/6] Setting up NRC Ticket Util plugin..."

# The repo root contains a nrcTicketUtil subfolder with the actual plugin.
# Clone to a staging area, then copy only that subfolder where Vencord expects it.
$RepoDir   = "$VencordDir\_nrc-ticket-util"
$PluginDir = "$VencordDir\src\plugins\nrcTicketUtil"

if (Test-Path "$RepoDir\.git") {
    Write-Info "Already cloned -- pulling latest..."
    & git -C $RepoDir pull --ff-only
} else {
    & git clone $PluginRepo $RepoDir
}

if (Test-Path $PluginDir) { Remove-Item -Recurse -Force $PluginDir }
Copy-Item -Recurse "$RepoDir\nrcTicketUtil" $PluginDir
Write-OK "Plugin copied to src\plugins\nrcTicketUtil"

Write-Step "[6/6] Building Vencord and injecting into Discord..."
& pnpm build
if ($LASTEXITCODE -ne 0) { Abort "Build failed. Check the output above." }
& pnpm inject

Write-Step "Registering startup task '$TaskName'..."

$AutoInjectScript = "$VencordDir\auto-inject.ps1"

Set-Content -Path $AutoInjectScript -Encoding UTF8 -Value @"
`$ErrorActionPreference = "SilentlyContinue"
Set-Location "$VencordDir"
Start-Sleep -Seconds 25
`$result = pnpm inject 2>&1
"[`$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] `$result" |
    Out-File -Append -Encoding UTF8 "$VencordDir\inject-log.txt"
"@

$Action = New-ScheduledTaskAction `
    -Execute  "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$AutoInjectScript`""

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 3) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Description "Re-injects Vencord into Discord after Discord auto-updates" |
    Out-Null

Write-Host ""
Write-Host "  =====================================" -ForegroundColor Green
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host "  =====================================" -ForegroundColor Green
Write-Host ""
Write-Host "  * Vencord injected into Discord" -ForegroundColor White
Write-Host "  * Task '$TaskName' runs at every logon to handle Discord auto-updates" -ForegroundColor White
Write-Host "  * Inject log: $VencordDir\inject-log.txt" -ForegroundColor White
Write-Host ""
Write-Host "  -> Relaunch Discord now." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to exit"
