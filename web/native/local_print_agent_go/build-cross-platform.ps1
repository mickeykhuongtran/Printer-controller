[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "dist"),
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $stream = [System.IO.File]::OpenRead($LiteralPath)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw "Go was not found in PATH. Install Go 1.22 or newer from https://go.dev/dl/."
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$resolvedOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path
$targets = @(
    @{ OS = "windows"; Arch = "amd64"; File = "ZbrePrinterLocalPrintAgent-windows-x64.exe" },
    @{ OS = "windows"; Arch = "arm64"; File = "ZbrePrinterLocalPrintAgent-windows-arm64.exe" },
    @{ OS = "darwin"; Arch = "amd64"; File = "ZbrePrinterLocalPrintAgent-macos-x64" },
    @{ OS = "darwin"; Arch = "arm64"; File = "ZbrePrinterLocalPrintAgent-macos-arm64" }
)
$mainSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot "main.go") -Raw
$versionMatch = [regex]::Match($mainSource, 'agentVersion\s*=\s*"([^"]+)"')
if (-not $versionMatch.Success) {
    throw "Could not read agentVersion from main.go."
}
$connectorVersion = $versionMatch.Groups[1].Value
$artifacts = @()

$previousGOOS = $env:GOOS
$previousGOARCH = $env:GOARCH
$previousCGO = $env:CGO_ENABLED
$previousLocation = Get-Location

try {
    Set-Location -LiteralPath $PSScriptRoot
    if (-not $SkipTests) {
        & go test ./...
        if ($LASTEXITCODE -ne 0) {
            throw "Go tests failed."
        }
    }

    $env:CGO_ENABLED = "0"
    foreach ($target in $targets) {
        $env:GOOS = $target.OS
        $env:GOARCH = $target.Arch
        $outputPath = Join-Path $resolvedOutput $target.File
        Write-Host "Building $($target.OS)/$($target.Arch) -> $outputPath"
        & go build -trimpath -ldflags="-s -w" -o $outputPath .
        if ($LASTEXITCODE -ne 0) {
            throw "Build failed for $($target.OS)/$($target.Arch)."
        }
        $file = Get-Item -LiteralPath $outputPath
        $artifacts += [ordered]@{
            os = $target.OS
            arch = $target.Arch
            file = $target.File
            url = "/agent/$($target.File)"
            bytes = $file.Length
            sha256 = Get-Sha256Hex -LiteralPath $outputPath
            signed = $false
        }
    }
}
finally {
    $env:GOOS = $previousGOOS
    $env:GOARCH = $previousGOARCH
    $env:CGO_ENABLED = $previousCGO
    Set-Location -LiteralPath $previousLocation
}

$manifest = [ordered]@{
    schemaVersion = 1
    connectorVersion = $connectorVersion
    generatedAt = [DateTime]::UtcNow.ToString("o")
    productionSigningRequired = $true
    artifacts = $artifacts
}
$manifestPath = Join-Path $resolvedOutput "manifest.json"
$manifestJson = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText(
    $manifestPath,
    $manifestJson + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
)
Write-Host "Wrote artifact manifest -> $manifestPath"
Write-Host "Cross-platform connector builds completed in $resolvedOutput"
