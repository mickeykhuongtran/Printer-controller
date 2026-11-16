[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$PrinterHost,

    [Parameter(Position = 1)]
    [ValidateRange(1, 65535)]
    [int]$Port = 9100,

    [Parameter(Position = 2)]
    [string]$FilePath,

    [Parameter()]
    [ValidateRange(100, 60000)]
    [int]$TimeoutMs = 5000
)

$ErrorActionPreference = "Stop"
$client = $null
$stream = $null
$asyncResult = $null

try {
    if ([string]::IsNullOrWhiteSpace($PrinterHost)) {
        $PrinterHost = Read-Host "Printer IP address or DNS name"
    }
    $PrinterHost = $PrinterHost.Trim()
    if ([string]::IsNullOrWhiteSpace($PrinterHost)) {
        throw "PrinterHost is required."
    }

    if ([string]::IsNullOrWhiteSpace($FilePath)) {
        $FilePath = Join-Path $PSScriptRoot "test-label.zpl"
    }
    $resolvedFile = (Resolve-Path -LiteralPath $FilePath).Path
    $payload = [IO.File]::ReadAllBytes($resolvedFile)
    if ($payload.Length -eq 0) {
        throw "The ZPL file is empty: $resolvedFile"
    }

    $client = New-Object System.Net.Sockets.TcpClient
    $asyncResult = $client.BeginConnect($PrinterHost, $Port, $null, $null)
    if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
        throw "Connection timed out after $TimeoutMs ms."
    }
    $client.EndConnect($asyncResult)
    $client.NoDelay = $true
    $client.SendTimeout = $TimeoutMs

    $stream = $client.GetStream()
    $stream.Write($payload, 0, $payload.Length)
    $stream.Flush()

    Write-Host ("Sent {0} bytes from '{1}' to {2}:{3}." -f $payload.Length, $resolvedFile, $PrinterHost, $Port) -ForegroundColor Green
    Write-Host "The send completed locally; RAW port 9100 does not guarantee a printer acknowledgement."
    exit 0
}
catch {
    Write-Error ("ZPL send failed for TCP {0}:{1}. {2}" -f $PrinterHost, $Port, $_.Exception.Message)
    exit 1
}
finally {
    if ($null -ne $asyncResult) {
        $asyncResult.AsyncWaitHandle.Close()
    }
    if ($null -ne $stream) {
        $stream.Close()
    }
    if ($null -ne $client) {
        $client.Close()
    }
}
