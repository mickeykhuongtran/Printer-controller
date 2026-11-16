$ErrorActionPreference = "Stop"

$NativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $NativeDir
$OutDir = Join-Path $RootDir "public\agent"
$BuildDir = Join-Path $NativeDir "build\agent"
$SpecDir = Join-Path $NativeDir "build"
$Entry = Join-Path $NativeDir "windows_print_agent.py"
$Requirements = Join-Path $NativeDir "requirements-build-windows.txt"
$Icon = Join-Path $RootDir "public\favicon.ico"
$Python = if ($env:PYTHON) { $env:PYTHON } else { "python" }
$AgentName = "ZbrePrinterLocalPrintAgent"

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
New-Item -ItemType Directory -Path $SpecDir -Force | Out-Null

& $Python -m pip install -r $Requirements

& $Python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --name $AgentName `
    --distpath $OutDir `
    --workpath $BuildDir `
    --specpath $SpecDir `
    --icon $Icon `
    --hidden-import win32print `
    --hidden-import win32timezone `
    --hidden-import pywintypes `
    $Entry

$ExePath = Join-Path $OutDir "$AgentName.exe"
if (!(Test-Path -LiteralPath $ExePath)) {
    throw "Build failed: $ExePath was not created."
}

Write-Host "Built $ExePath"
Write-Host "Download URL: /agent/$AgentName.exe"
