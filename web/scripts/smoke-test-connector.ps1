[CmdletBinding()]
param(
    [string]$Executable = "",
    [int]$Port = 17918
)

$ErrorActionPreference = "Stop"
if (-not $Executable) {
    $Executable = Join-Path $PSScriptRoot `
        "..\public\agent\ZbrePrinterLocalPrintAgent-windows-x64.exe"
}
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$runId = [guid]::NewGuid().ToString("N")
$runDirectory = Join-Path $env:TEMP "zbre-connector-smoke-$runId"
New-Item -ItemType Directory -Path $runDirectory | Out-Null
$state = Join-Path $runDirectory "state.json"
$stdout = Join-Path $runDirectory "stdout.log"
$stderr = Join-Path $runDirectory "stderr.log"
$origin = "https://labels.company.example"
$baseUrl = "http://127.0.0.1:$Port"

function Invoke-HttpStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [string]$Method = "Get",
        [hashtable]$Headers = @{},
        [string]$ContentType = "",
        [string]$Body = ""
    )

    $parameters = @{
        Uri = $Uri
        Method = $Method
        Headers = $Headers
        UseBasicParsing = $true
    }
    if ($ContentType) {
        $parameters.ContentType = $ContentType
    }
    if ($Body) {
        $parameters.Body = $Body
    }
    try {
        return [int](Invoke-WebRequest @parameters).StatusCode
    }
    catch {
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            return [int]$_.Exception.Response.StatusCode
        }
        throw
    }
}

$process = Start-Process `
    -FilePath $resolvedExecutable `
    -ArgumentList @(
        "--port", "$Port",
        "--state-file", $state,
        "--require-origin-token"
    ) `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru

try {
    $pairingCode = ""
    for ($index = 0; $index -lt 50; $index++) {
        Start-Sleep -Milliseconds 100
        if (Test-Path -LiteralPath $stderr) {
            $log = Get-Content -LiteralPath $stderr -Raw
            if ($log -match "PAIRING CODE:\s*(\d{8})") {
                $pairingCode = $Matches[1]
                break
            }
        }
    }
    if (-not $pairingCode) {
        throw "Connector did not become ready. See $stderr"
    }

    $health = Invoke-RestMethod `
        -Uri "$baseUrl/v1/health" `
        -Headers @{ Origin = $origin }
    $noOriginStatus = Invoke-HttpStatus `
        -Uri "$baseUrl/v1/printers"
    $beforePairStatus = Invoke-HttpStatus `
        -Uri "$baseUrl/v1/printers" `
        -Headers @{ Origin = $origin }
    $pair = Invoke-RestMethod `
        -Method Post `
        -Uri "$baseUrl/v1/pair" `
        -Headers @{ Origin = $origin } `
        -ContentType "application/json" `
        -Body (@{ code = $pairingCode } | ConvertTo-Json -Compress)
    $authorized = @{
        Origin = $origin
        Authorization = "Bearer $($pair.token)"
    }
    $printers = Invoke-RestMethod `
        -Uri "$baseUrl/v1/printers" `
        -Headers $authorized
    $evilOriginStatus = Invoke-HttpStatus `
        -Uri "$baseUrl/v1/printers" `
        -Headers @{
            Origin = "https://evil.example"
            Authorization = "Bearer $($pair.token)"
        }
    $tcpBlockedStatus = Invoke-HttpStatus `
        -Method Post `
        -Uri "$baseUrl/v1/tcp/exchange" `
        -Headers $authorized `
        -ContentType "application/json" `
        -Body (@{
            host = "127.0.0.1"
            port = 9100
            payloadBase64 = [Convert]::ToBase64String(
                [Text.Encoding]::ASCII.GetBytes("test")
            )
            readWindowMs = 0
        } | ConvertTo-Json -Compress)

    if ($health.version -ne "0.5.0") {
        throw "Unexpected connector version: $($health.version)"
    }
    if (
        $health.capabilities.tcpJobV1 -ne $true -or
        $health.capabilities.tcpJobIdempotencyV1 -ne $true -or
        $health.capabilities.printerTargetQueueV1 -ne $true -or
        $health.capabilities.rawBatchLeaseV1 -ne $true -or
        $health.capabilities.rawSpoolBatchV1 -ne $true
    ) {
        throw "Persistent TCP/RAW spool batch queue capabilities are missing."
    }
    if ($health.requireOriginToken -ne $true) {
        throw "Strict Origin/token mode is not active."
    }
    if ($noOriginStatus -ne 403 -or $beforePairStatus -ne 403) {
        throw "Strict pre-pair authorization checks did not return HTTP 403."
    }
    if ($evilOriginStatus -ne 403 -or $tcpBlockedStatus -ne 403) {
        throw "Origin or TCP destination security check did not return HTTP 403."
    }

    [ordered]@{
        healthOk = $health.ok
        version = $health.version
        durableRawSpool = $health.capabilities.rawSpoolBatchV1
        siteMode = $health.siteMode
        requireOriginToken = $health.requireOriginToken
        noOriginStatus = $noOriginStatus
        prePairStatus = $beforePairStatus
        pairedOrigin = $pair.origin
        protectedStatus = 200
        printerCount = @($printers.printers).Count
        evilOriginStatus = $evilOriginStatus
        loopbackTcpStatus = $tcpBlockedStatus
    } | ConvertTo-Json -Compress
}
finally {
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id
    }
    $resolvedRunDirectory = [IO.Path]::GetFullPath($runDirectory)
    $resolvedTempDirectory = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    if ($resolvedRunDirectory.StartsWith($resolvedTempDirectory, [System.StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedRunDirectory) -eq "zbre-connector-smoke-$runId") {
        Remove-Item -LiteralPath $resolvedRunDirectory -Recurse -Force
    }
}
