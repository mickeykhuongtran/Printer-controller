param(
    [string]$Executable = ".\dist\win-unpacked\ZbrePrinter.exe",
    [int]$StartupTimeoutSeconds = 45
)

$resolvedExecutable = (Resolve-Path -LiteralPath $Executable -ErrorAction Stop).Path
$process = Start-Process -FilePath $resolvedExecutable -PassThru -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$startedAtUtc = $process.StartTime.ToUniversalTime()
$logPath = Join-Path $env:APPDATA "ZbrePrinter\logs\desktop-main.log"

try {
    do {
        Start-Sleep -Milliseconds 500
        try {
            $web = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:18888/" -TimeoutSec 2
            $connector = Invoke-RestMethod -Uri "http://127.0.0.1:17917/v1/health" -TimeoutSec 2
            $desktopReady = $false
            if (Test-Path -LiteralPath $logPath) {
                $desktopReady = Get-Content -LiteralPath $logPath -Tail 60 |
                    ForEach-Object {
                        try { $_ | ConvertFrom-Json } catch { $null }
                    } |
                    Where-Object {
                        $_ -and
                        $_.message -eq "ZbrePrinter desktop is ready" -and
                        ([DateTime]$_.timestamp).ToUniversalTime() -ge $startedAtUtc
                    } |
                    Select-Object -First 1
            }
            if ($web.StatusCode -eq 200 -and $connector.ok -eq $true -and $desktopReady) {
                Write-Host "Installed smoke test passed: app window, UI and connector are healthy."
                exit 0
            }
        }
        catch {
            # Runtime can take several seconds to unpack and initialize.
        }
    } while ((Get-Date) -lt $deadline -and -not $process.HasExited)

    throw "ZbrePrinter did not become healthy within $StartupTimeoutSeconds seconds."
}
finally {
    if (-not $process.HasExited) {
        $closed = $process.CloseMainWindow()
        if ($closed) {
            $null = $process.WaitForExit(10000)
        }
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
        }
    }
}
