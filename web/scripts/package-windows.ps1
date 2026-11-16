$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SetupDir = Join-Path $Root "Setup"
$StagingDir = Join-Path $SetupDir "ZbrePrinter"
$AppDir = Join-Path $StagingDir "app"
$NodeDir = Join-Path $StagingDir "node"
$AgentDir = Join-Path $StagingDir "agent"
$ZipPath = Join-Path $SetupDir "ZbrePrinter-Portable.zip"
$InstallerScriptPath = Join-Path $SetupDir "Install-ZbrePrinter.ps1"
$SedPath = Join-Path $SetupDir "ZbrePrinter-Setup.sed"
$InstallerExePath = Join-Path $SetupDir "ZbrePrinter-Setup.exe"

function Assert-PathUnder($Path, $Parent, $Label) {
    $FullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $FullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
    if ($FullPath -ne $FullParent -and -not $FullPath.StartsWith($FullParent + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label is outside the expected parent. Path=$FullPath Parent=$FullParent"
    }
}

function Copy-Directory($Source, $Destination) {
    if (!(Test-Path -LiteralPath $Source)) {
        throw "Missing required path: $Source"
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
}

function Resolve-NodeExe {
    if ($env:NODE_EXE -and (Test-Path -LiteralPath $env:NODE_EXE)) {
        return $env:NODE_EXE
    }

    $Bundled = "C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    if (Test-Path -LiteralPath $Bundled) {
        return $Bundled
    }

    $Command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($Command -and (Test-Path -LiteralPath $Command.Source)) {
        return $Command.Source
    }

    throw "node.exe was not found. Set NODE_EXE to a portable Node.js executable."
}

$RootResolved = (Resolve-Path -LiteralPath $Root).Path
$ExpectedSetupDir = Join-Path $RootResolved "Setup"
if (Test-Path -LiteralPath $SetupDir) {
    $SetupResolved = (Resolve-Path -LiteralPath $SetupDir).Path
    if ([System.IO.Path]::GetFullPath($SetupResolved).TrimEnd('\') -ne [System.IO.Path]::GetFullPath($ExpectedSetupDir).TrimEnd('\')) {
        throw "Refusing to delete unexpected Setup path: $SetupResolved"
    }
    Assert-PathUnder $SetupResolved $RootResolved "Setup directory"
    Remove-Item -LiteralPath $SetupResolved -Recurse -Force
}
New-Item -ItemType Directory -Path $SetupDir -Force | Out-Null

Push-Location $Root
try {
    npm run build
}
finally {
    Pop-Location
}

New-Item -ItemType Directory -Path $AppDir, $NodeDir, $AgentDir -Force | Out-Null

Copy-Directory (Join-Path $Root ".next\standalone") $AppDir
$NestedSetup = Join-Path $AppDir "Setup"
if (Test-Path -LiteralPath $NestedSetup) {
    Assert-PathUnder $NestedSetup $AppDir "Nested Setup directory"
    Remove-Item -LiteralPath $NestedSetup -Recurse -Force
}
Copy-Directory (Join-Path $Root ".next\static") (Join-Path $AppDir ".next\static")
Copy-Directory (Join-Path $Root "public") (Join-Path $AppDir "public")
Copy-Directory (Join-Path $Root "data") (Join-Path $AppDir "data")
Copy-Directory (Join-Path $Root "template") (Join-Path $AppDir "template")
Copy-Directory (Join-Path $Root "docs") (Join-Path $AppDir "docs")

$NodeExe = Resolve-NodeExe
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $NodeDir "node.exe") -Force

$AgentExe = Join-Path $Root "public\agent\ZbrePrinterLocalPrintAgent.exe"
if (!(Test-Path -LiteralPath $AgentExe)) {
    throw "Missing print agent exe: $AgentExe. Run npm run build-agent:windows first."
}
Copy-Item -LiteralPath $AgentExe -Destination (Join-Path $AgentDir "ZbrePrinterLocalPrintAgent.exe") -Force

Set-Content -LiteralPath (Join-Path $StagingDir "Start-PrintAgent.bat") -Encoding ASCII -Value @"
@echo off
setlocal
cd /d "%~dp0"
echo Starting ZbrePrinter Local Print Agent on http://127.0.0.1:17917
"%~dp0agent\ZbrePrinterLocalPrintAgent.exe" --host 127.0.0.1 --port 17917
pause
"@

Set-Content -LiteralPath (Join-Path $StagingDir "Start-ZbrePrinter.bat") -Encoding ASCII -Value @"
@echo off
setlocal
cd /d "%~dp0app"
set HOSTNAME=127.0.0.1
if "%PORT%"=="" set PORT=8888
echo Starting ZbrePrinter on http://localhost:%PORT%
start "" "http://localhost:%PORT%"
"%~dp0node\node.exe" server.js
pause
"@

Set-Content -LiteralPath (Join-Path $StagingDir "Run-ZbrePrinter-All.bat") -Encoding ASCII -Value @"
@echo off
setlocal
cd /d "%~dp0"
start "ZbrePrinter Print Agent" "%~dp0agent\ZbrePrinterLocalPrintAgent.exe" --host 127.0.0.1 --port 17917
timeout /t 2 >nul
cd /d "%~dp0app"
set HOSTNAME=127.0.0.1
if "%PORT%"=="" set PORT=8888
start "" "http://localhost:%PORT%"
"%~dp0node\node.exe" server.js
pause
"@

Set-Content -LiteralPath (Join-Path $StagingDir "Create-Desktop-Shortcut.ps1") -Encoding UTF8 -Value @'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = Join-Path $Root "Run-ZbrePrinter-All.bat"
$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "ZbrePrinter.lnk"
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Target
$Shortcut.WorkingDirectory = $Root
$Shortcut.IconLocation = Join-Path $Root "app\public\favicon.ico"
$Shortcut.Save()
Write-Host "Created shortcut: $ShortcutPath"
'@

Set-Content -LiteralPath (Join-Path $StagingDir "README-CaiDat.txt") -Encoding UTF8 -Value @"
ZbrePrinter - Zebra ZPL/RFID Label Designer

Cach chay portable:
1. Cai driver Zebra hoac Seagull cho may in tren Windows.
2. Chay Run-ZbrePrinter-All.bat.
3. Mo http://localhost:8888 neu trinh duyet chua tu mo.
4. Trong app, chon PRINTER va dung printer queue Zebra trong Windows.

File huu ich:
- Run-ZbrePrinter-All.bat: chay ca web app va local print agent.
- Start-ZbrePrinter.bat: chi chay web app.
- Start-PrintAgent.bat: chi chay local print agent.
- Create-Desktop-Shortcut.ps1: tao shortcut ngoai Desktop.

Cong:
- Web app: http://localhost:8888
- Print agent: http://127.0.0.1:17917

Ghi chu:
- Thu muc nay co kem Node.js portable, khong can cai Node.js rieng.
- RFID Zebra duoc in bang ZPL ^RS/^RR/^RFW.
"@

if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}
Compress-Archive -LiteralPath $StagingDir -DestinationPath $ZipPath -Force

Set-Content -LiteralPath $InstallerScriptPath -Encoding UTF8 -Value @'
$ErrorActionPreference = "Stop"
$SourceZip = Join-Path $PSScriptRoot "ZbrePrinter-Portable.zip"
$InstallRoot = Join-Path $env:LOCALAPPDATA "ZbrePrinter"

if (!(Test-Path -LiteralPath $SourceZip)) {
    throw "Missing package: $SourceZip"
}

if (Test-Path -LiteralPath $InstallRoot) {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
Expand-Archive -LiteralPath $SourceZip -DestinationPath $InstallRoot -Force

$AppRoot = Join-Path $InstallRoot "ZbrePrinter"
$ShortcutScript = Join-Path $AppRoot "Create-Desktop-Shortcut.ps1"
if (Test-Path -LiteralPath $ShortcutScript) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $ShortcutScript
}

Start-Process -FilePath (Join-Path $AppRoot "Run-ZbrePrinter-All.bat") -WorkingDirectory $AppRoot
'@

$IExpress = Get-Command iexpress.exe -ErrorAction SilentlyContinue
if ($IExpress) {
    $SetupDirEsc = $SetupDir
    $InstallerExeEsc = $InstallerExePath
    Set-Content -LiteralPath $SedPath -Encoding ASCII -Value @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=ZbrePrinter installed. A desktop shortcut was created.
TargetName=$InstallerExeEsc
FriendlyName=ZbrePrinter Setup
AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -File Install-ZbrePrinter.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[SourceFiles]
SourceFiles0=$SetupDirEsc
[SourceFiles0]
%FILE0%=
%FILE1%=
[Strings]
FILE0="ZbrePrinter-Portable.zip"
FILE1="Install-ZbrePrinter.ps1"
"@
    $IExpressProcess = Start-Process `
        -FilePath $IExpress.Source `
        -ArgumentList @("/N", "/Q", $SedPath) `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    if ($IExpressProcess.ExitCode -ne 0) {
        throw "IExpress failed with exit code $($IExpressProcess.ExitCode)."
    }
}
else {
    Write-Warning "iexpress.exe was not found; only the portable zip was created."
}

Write-Host "Created portable folder: $StagingDir"
Write-Host "Created zip: $ZipPath"
if (Test-Path -LiteralPath $InstallerExePath) {
    Write-Host "Created installer exe: $InstallerExePath"
}
