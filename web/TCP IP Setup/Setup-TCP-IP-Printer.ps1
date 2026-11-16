[CmdletBinding()]
param(
    [Parameter()]
    [string]$PrinterHost,

    [Parameter()]
    [ValidateRange(1, 65535)]
    [int]$Port = 9100,

    [Parameter()]
    [string]$PrinterName,

    [Parameter()]
    [string]$DriverName,

    [Parameter()]
    [string]$PortName,

    [Parameter()]
    [switch]$SkipConnectionTest,

    [Parameter()]
    [switch]$UpdateExistingQueue
)

$ErrorActionPreference = "Stop"

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-TcpEndpoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$HostName,

        [Parameter(Mandatory = $true)]
        [int]$PortNumber,

        [int]$TimeoutMs = 3000
    )

    $client = New-Object System.Net.Sockets.TcpClient
    $asyncResult = $null
    try {
        $asyncResult = $client.BeginConnect($HostName, $PortNumber, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            return $false
        }
        $client.EndConnect($asyncResult)
        return $client.Connected
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $asyncResult) {
            $asyncResult.AsyncWaitHandle.Close()
        }
        $client.Close()
    }
}

function Select-PrinterDriver {
    $allDrivers = @(Get-PrinterDriver | Sort-Object Name)
    if ($allDrivers.Count -eq 0) {
        throw "No Windows printer driver is installed. Install the Zebra/ZDesigner/Seagull driver first."
    }

    $candidates = @($allDrivers | Where-Object {
        $_.Name -match "ZDesigner|Zebra|ZT[0-9]|ZD[0-9]" -or
        $_.Manufacturer -match "Zebra|Seagull"
    })
    if ($candidates.Count -eq 0) {
        Write-Host "No Zebra-like driver was detected. Installed drivers:" -ForegroundColor Yellow
        $allDrivers | Select-Object Name, Manufacturer | Format-Table -AutoSize
        return (Read-Host "Enter the exact driver Name")
    }
    if ($candidates.Count -eq 1) {
        Write-Host "Using detected driver: $($candidates[0].Name)" -ForegroundColor Cyan
        return [string]$candidates[0].Name
    }

    Write-Host "Select the installed printer driver:" -ForegroundColor Cyan
    for ($index = 0; $index -lt $candidates.Count; $index++) {
        Write-Host ("  [{0}] {1}" -f ($index + 1), $candidates[$index].Name)
    }
    $selection = Read-Host "Driver number"
    $number = 0
    if (-not [int]::TryParse($selection, [ref]$number) -or
        $number -lt 1 -or $number -gt $candidates.Count) {
        throw "Invalid driver selection."
    }
    return [string]$candidates[$number - 1].Name
}

try {
    if (-not (Test-IsAdministrator)) {
        throw "Administrator rights are required. Right-click Setup-TCP-IP-Printer.bat and select 'Run as administrator'."
    }

    if ([string]::IsNullOrWhiteSpace($PrinterHost)) {
        $PrinterHost = Read-Host "Printer IP address or DNS name"
    }
    $PrinterHost = $PrinterHost.Trim()
    if ([string]::IsNullOrWhiteSpace($PrinterHost)) {
        throw "PrinterHost is required."
    }

    if ([string]::IsNullOrWhiteSpace($PrinterName)) {
        $defaultPrinterName = "Zebra TCP $PrinterHost"
        $enteredPrinterName = Read-Host "Windows queue name [$defaultPrinterName]"
        $PrinterName = if ([string]::IsNullOrWhiteSpace($enteredPrinterName)) {
            $defaultPrinterName
        } else {
            $enteredPrinterName.Trim()
        }
    }

    if ([string]::IsNullOrWhiteSpace($PortName)) {
        $safeHost = $PrinterHost -replace "[^A-Za-z0-9._-]", "_"
        $PortName = if ($Port -eq 9100) {
            "IP_$safeHost"
        } else {
            "IP_${safeHost}_$Port"
        }
    }

    $spooler = Get-Service -Name Spooler
    if ($spooler.Status -ne "Running") {
        Write-Host "Starting Windows Print Spooler..." -ForegroundColor Cyan
        Start-Service -Name Spooler
    }

    if (-not $SkipConnectionTest) {
        Write-Host "Testing TCP $PrinterHost`:$Port ..." -ForegroundColor Cyan
        if (Test-TcpEndpoint -HostName $PrinterHost -PortNumber $Port) {
            Write-Host "TCP connection succeeded." -ForegroundColor Green
        } else {
            Write-Warning "TCP connection failed. The port can still be configured, but printing will fail until routing/firewall/printer settings are corrected."
        }
    }

    if ([string]::IsNullOrWhiteSpace($DriverName)) {
        $DriverName = Select-PrinterDriver
    }
    $DriverName = $DriverName.Trim()
    $driver = Get-PrinterDriver -Name $DriverName -ErrorAction SilentlyContinue
    if ($null -eq $driver) {
        throw "Printer driver '$DriverName' is not installed. Use Get-PrinterDriver to obtain the exact name."
    }

    $existingPort = Get-PrinterPort -Name $PortName -ErrorAction SilentlyContinue
    if ($null -ne $existingPort) {
        $existingHost = [string]$existingPort.PrinterHostAddress
        $existingNumber = [int]$existingPort.PortNumber
        if ($existingHost -ne $PrinterHost -or $existingNumber -ne $Port) {
            throw "Port '$PortName' already exists but targets '$existingHost`:$existingNumber'. Choose a different -PortName; this script will not overwrite it."
        }
        Write-Host "Port already exists and matches: $PortName" -ForegroundColor Yellow
    } else {
        Write-Host "Creating Standard TCP/IP Port '$PortName' -> $PrinterHost`:$Port ..." -ForegroundColor Cyan
        Add-PrinterPort `
            -Name $PortName `
            -PrinterHostAddress $PrinterHost `
            -PortNumber ([uint32]$Port) `
            -SNMP 0
    }

    $existingPrinter = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
    if ($null -eq $existingPrinter) {
        Write-Host "Creating Windows printer queue '$PrinterName' ..." -ForegroundColor Cyan
        Add-Printer `
            -Name $PrinterName `
            -DriverName $DriverName `
            -PortName $PortName `
            -Datatype "RAW"
    } else {
        $samePort = [string]$existingPrinter.PortName -eq $PortName
        $sameDriver = [string]$existingPrinter.DriverName -eq $DriverName
        if (-not $samePort -or -not $sameDriver) {
            if (-not $UpdateExistingQueue) {
                throw "Queue '$PrinterName' already exists with port '$($existingPrinter.PortName)' and driver '$($existingPrinter.DriverName)'. Re-run with -UpdateExistingQueue only after confirming this queue may be changed."
            }
            Write-Host "Updating existing queue '$PrinterName' ..." -ForegroundColor Yellow
            Set-Printer `
                -Name $PrinterName `
                -DriverName $DriverName `
                -PortName $PortName `
                -Datatype "RAW"
        } else {
            Write-Host "Queue already exists and matches: $PrinterName" -ForegroundColor Yellow
        }
    }

    $resultPrinter = Get-Printer -Name $PrinterName
    $resultPort = Get-PrinterPort -Name $PortName

    Write-Host ""
    Write-Host "TCP/IP printer setup completed." -ForegroundColor Green
    [pscustomobject]@{
        PrinterName = $resultPrinter.Name
        DriverName = $resultPrinter.DriverName
        PortName = $resultPrinter.PortName
        PrinterHost = $resultPort.PrinterHostAddress
        TcpPort = $resultPort.PortNumber
        Datatype = $resultPrinter.Datatype
    } | Format-List
    Write-Host "Next: start the local print agent, open /printers, then select this queue in PRINTER mode."
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
