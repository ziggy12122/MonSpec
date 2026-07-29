#Requires -RunAsAdministrator
<#
.SYNOPSIS
    PC Temp Monitor - One-Line Installer from GitHub
    irm https://raw.githubusercontent.com/ziggy12122/MonSpec/main/install.ps1 | iex
#>

param([switch]$NoAutoElevate)

# Auto-elevate
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if (-not $NoAutoElevate) {
        Start-Process pwsh -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command `"irm https://raw.githubusercontent.com/ziggy12122/MonSpec/main/install.ps1 | iex`"" -Verb RunAs
        exit 0
    }
}

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Write-Host "`n🌡️  PC Temp Monitor Setup`n" -ForegroundColor Cyan

# Find Node.js
$nodeExe = $null
$searchPaths = @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe"
)

try { $nodeExe = (Get-Command node -ErrorAction Stop).Source }
catch {
    foreach ($p in $searchPaths) { 
        if (Test-Path $p) { $nodeExe = $p; break }
    }
}

# Install Node.js if missing
if (-not $nodeExe) {
    Write-Host "[1/5] Installing Node.js..." -ForegroundColor Cyan
    $tempMsi = "$env:TEMP\node.msi"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.19.4/node-v20.19.4-x64.msi" -OutFile $tempMsi -UseBasicParsing
    Start-Process msiexec -ArgumentList "/i `"$tempMsi`" /qn /norestart" -Wait
    $nodeExe = "C:\Program Files\nodejs\node.exe"
    if (-not (Test-Path $nodeExe)) {
        Write-Host "✗ Node.js installation failed" -ForegroundColor Red
        exit 1
    }
    Write-Host "✓ Node.js installed`n" -ForegroundColor Green
} else {
    Write-Host "[1/5] Node.js found`n" -ForegroundColor Green
}

# Setup directory
Write-Host "[2/5] Creating directory..." -ForegroundColor Cyan
$docsFolder = [Environment]::GetFolderPath('MyDocuments')
$monspecDir = Join-Path $docsFolder "MonSpec"
New-Item -ItemType Directory -Path $monspecDir -Force | Out-Null
Set-Location $monspecDir
Write-Host "✓ $monspecDir`n" -ForegroundColor Green

# GitHub base URL
$gitHub = "https://raw.githubusercontent.com/ziggy12122/MonSpec/main"

# Download backend from GitHub
Write-Host "[3/5] Downloading backend..." -ForegroundColor Cyan

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

try {
    Invoke-WebRequest -Uri "$gitHub/package.json" -OutFile "package.json" -UseBasicParsing
    Write-Host "  ✓ package.json" -ForegroundColor Green
} catch { Write-Host "  ✗ Failed to download package.json" -ForegroundColor Red; exit 1 }

try {
    Invoke-WebRequest -Uri "$gitHub/server.js" -OutFile "server.js" -UseBasicParsing
    Write-Host "  ✓ server.js" -ForegroundColor Green
} catch { Write-Host "  ✗ Failed to download server.js" -ForegroundColor Red; exit 1 }

# Create Libre folder and download all DLLs
New-Item -ItemType Directory -Path "Libre" -Force | Out-Null

# Critical DLLs needed for LibreHardwareMonitorLib.dll to work
$dlls = @(
    "LibreHardwareMonitorLib.dll",
    "System.Text.Json.dll",
    "System.Threading.Tasks.Extensions.dll",
    "System.Runtime.CompilerServices.Unsafe.dll",
    "System.Buffers.dll",
    "System.Memory.dll",
    "System.Numerics.Vectors.dll",
    "System.Collections.Immutable.dll",
    "System.Reflection.Metadata.dll",
    "System.IO.Pipelines.dll",
    "System.Text.Encodings.Web.dll",
    "System.Security.AccessControl.dll",
    "System.Security.Principal.Windows.dll",
    "System.Resources.Extensions.dll",
    "System.Formats.Nrbf.dll",
    "System.Threading.AccessControl.dll",
    "System.CodeDom.dll",
    "BlackSharp.Core.dll",
    "DiskInfoToolkit.dll",
    "HidSharp.dll",
    "Microsoft.Bcl.AsyncInterfaces.dll",
    "Microsoft.Bcl.HashCode.dll",
    "Microsoft.Win32.TaskScheduler.dll",
    "RAMSPDToolkit-NDD.dll"
)

$dllCount = 0
foreach ($dll in $dlls) {
    try {
        Invoke-WebRequest -Uri "$gitHub/Libre/$dll" -OutFile "Libre\$dll" -UseBasicParsing -ErrorAction SilentlyContinue
        $dllCount++
    } catch { }
}

if ($dllCount -gt 0) {
    Write-Host "  ✓ Downloaded $dllCount library files" -ForegroundColor Green
} else {
    Write-Host "  ✗ Failed to download libraries (WMI fallback available)" -ForegroundColor Yellow
}

Write-Host ""

# Install dependencies
Write-Host "[4/5] Installing dependencies..." -ForegroundColor Cyan
$npmCmd = Join-Path (Split-Path $nodeExe) "npm.cmd"
if (Test-Path $npmCmd) {
    & $npmCmd install 2>$null
} else {
    & $nodeExe (Join-Path (Split-Path $nodeExe) "node_modules\npm\bin\npm-cli.js") install 2>$null
}
Write-Host "✓ Dependencies installed`n" -ForegroundColor Green

# Cleanup and start
Write-Host "[5/5] Launching server..." -ForegroundColor Cyan

# Configure firewall to allow port 3000
Write-Host "  Configuring firewall..." -ForegroundColor Yellow
try {
    $rule = Get-NetFirewallRule -DisplayName "MonSpec Port 3000" -ErrorAction SilentlyContinue
    if ($rule) {
        Remove-NetFirewallRule -DisplayName "MonSpec Port 3000" -Force -ErrorAction SilentlyContinue
    }
    New-NetFirewallRule -DisplayName "MonSpec Port 3000" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -ErrorAction SilentlyContinue | Out-Null
    Write-Host "  ✓ Firewall rule added" -ForegroundColor Green
} catch {
    Write-Host "  ⚠ Firewall setup skipped" -ForegroundColor Yellow
}

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "`n✨ Starting PC Temp Monitor`n" -ForegroundColor Green
Write-Host "  🌐 http://localhost:3000" -ForegroundColor Cyan
Write-Host "  📱 http://<your-pc-ip>:3000 (from phone on same WiFi)`n" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop`n" -ForegroundColor Yellow

& $nodeExe server.js
