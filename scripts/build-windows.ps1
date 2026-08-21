[CmdletBinding()]
param(
    [ValidateSet("nsis", "msi", "all")]
    [string]$Bundle = "nsis"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "Windows installer packages must be built on Windows."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
$iconPath = Join-Path $projectRoot "src-tauri\icons\icon.ico"

if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    throw "Windows icon is missing: $iconPath"
}

$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.bundle.windows.nsis.installerIcon -ne "icons/icon.ico") {
    throw "bundle.windows.nsis.installerIcon must be icons/icon.ico in tauri.conf.json."
}

$iconBytes = [IO.File]::ReadAllBytes($iconPath)
if ($iconBytes.Length -lt 6 -or [BitConverter]::ToUInt16($iconBytes, 2) -ne 1) {
    throw "The Windows icon is not a valid ICO file: $iconPath"
}

$bundles = if ($Bundle -eq "all") { "nsis,msi" } else { $Bundle }
Push-Location $projectRoot
try {
    & npm.cmd run tauri -- build --bundles $bundles
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri Windows build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$bundleRoot = Join-Path $projectRoot "src-tauri\target\release\bundle"
Write-Host "Windows package build completed. Output: $bundleRoot"
Get-ChildItem -LiteralPath $bundleRoot -Recurse -File |
    Where-Object Extension -In ".exe", ".msi" |
    Select-Object FullName, Length, LastWriteTime
