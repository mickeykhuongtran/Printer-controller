[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$PrinterHost,

    [Parameter(Position = 1)]
    [ValidateRange(1, 65535)]
    [int]$Port = 9100,

    [Parameter()]
    [ValidateRange(100, 60000)]
    [int]$TimeoutMs = 3000
)

$ErrorActionPreference = "Stop"
$client = $null
$asyncResult = $null
$timer = [Diagnostics.Stopwatch]::StartNew()

try {
    if ([string]::IsNullOrWhiteSpace($PrinterHost)) {
        $PrinterHost = Read-Host "Printer IP address or DNS name"
    }
    $PrinterHost = $PrinterHost.Trim()
    if ([string]::IsNullOrWhiteSpace($PrinterHost)) {
        throw "PrinterHost is required."
    }

    $client = New-Object System.Net.Sockets.TcpClient
    $asyncResult = $client.BeginConnect($PrinterHost, $Port, $null, $null)
    if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
        throw "Connection timed out after $TimeoutMs ms."
    }
    $client.EndConnect($asyncResult)
    $timer.Stop()

    Write-Host ("OK: TCP {0}:{1} is reachable ({2} ms)." -f $PrinterHost, $Port, $timer.ElapsedMilliseconds) -ForegroundColor Green
    Write-Host "No print command was sent."
    exit 0
}
catch {
    $timer.Stop()
    Write-Error ("FAIL: Cannot connect to TCP {0}:{1}. {2}" -f $PrinterHost, $Port, $_.Exception.Message)
    exit 1
}
finally {
    if ($null -ne $asyncResult) {
        $asyncResult.AsyncWaitHandle.Close()
    }
    if ($null -ne $client) {
        $client.Close()
    }
}
