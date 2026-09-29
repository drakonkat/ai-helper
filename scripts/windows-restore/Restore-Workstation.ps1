#Requires -Version 5.1
<#
.SYNOPSIS
Ripristino Windows: applicazioni, WSL2, NVM/Node/aih e toolchain Neden UE 5.7.4.
.DESCRIPTION
Senza -Apply (o con -WhatIf) mostra solo il piano: nessun download o modifica.
Leggere README.md e salvare l'intera cartella prima di formattare.
Eseguire con Windows PowerShell 64-bit, come amministratore del proprio account.
.EXAMPLE
.\Restore-Workstation.ps1
.EXAMPLE
.\Restore-Workstation.ps1 -Apply -AcceptAgreements -BootstrapPackageManager
.EXAMPLE
.\Restore-Workstation.ps1 -Apply -AcceptAgreements -Phase Apps -PackageManager Chocolatey
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Apply,
    [switch]$AcceptAgreements,
    [ValidateSet('All', 'System', 'Apps', 'Node', 'Unreal')]
    [string[]]$Phase = @('All'),
    [ValidateSet('WinGet', 'Chocolatey')]
    [string]$PackageManager = 'WinGet',
    [switch]$BootstrapPackageManager,
    [ValidatePattern('^(lts|\d+\.\d+\.\d+)$')]
    [string]$NodeVersion = 'lts',
    [ValidatePattern('^(latest|\d+\.\d+\.\d+)$')]
    [string]$AihVersion = 'latest',
    [ValidatePattern('^(latest|\d+\.\d+\.\d+)$')]
    [string]$OpenCodexVersion = 'latest',
    [ValidatePattern('^(latest|\d+\.\d+\.\d+)$')]
    [string]$PxpipeVersion = 'latest',
    [ValidatePattern('^(latest|\d+\.\d+\.\d+)$')]
    [string]$AgentMemoryVersion = 'latest',
    [string[]]$SkipPackage = @(), # ID WinGet, anche in modalita Chocolatey
    [switch]$SkipWhatsApp,
    [string]$WorkspacePath = (Join-Path $env:USERPROFILE 'Perforce\Neden_NiccoloWorkspace'),
    [string]$EnginePath = 'D:\MMO\UE5.7',
    [switch]$PrepareSource,
    [switch]$BuildEditor,
    [switch]$ToolchainOnly,
    [string]$LogDirectory = (Join-Path $env:LOCALAPPDATA 'WorkstationRestore\logs')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Results = New-Object 'System.Collections.Generic.List[object]'
$script:RebootRequired = $false
$script:CommandLog = $null

function Test-Phase([string]$Name) { return ('All' -in $Phase -or $Name -in $Phase) }

function Refresh-Environment {
    # Aggiorna solo il processo, senza riscrivere il PATH persistente dell'utente.
    $parts = @([Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path)
    $env:Path = (($parts -join ';') -split ';' | Where-Object { $_ } | Select-Object -Unique) -join ';'
    foreach ($name in @('NVM_HOME', 'NVM_SYMLINK', 'ChocolateyInstall')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'User')
        if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name, 'Machine') }
        if ($value) { [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
    }
}

function Find-Executable([string]$Name) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    if ($Name -eq 'winget.exe') {
        $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
        if (Test-Path -LiteralPath $alias) { return $alias }
    }
    return $null
}

function Invoke-Tool {
    param([string]$File, [string[]]$Arguments = @(), [switch]$Quiet)
    if (-not $File) { throw "Eseguibile non trovato nel PATH. Riaprire PowerShell dopo l'installazione." }
    if (-not (Get-Command $File -CommandType Application -ErrorAction SilentlyContinue)) { throw "Eseguibile non disponibile: $File" }
    $label = "$File $($Arguments -join ' ')"
    Write-Host "> $label" -ForegroundColor DarkGray
    # PS5.1 trasforma stderr nativo in ErrorRecord: non scambiare una riga per un exit code.
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    # I comandi nativi aggiornano la variabile globale: non oscurarla con una locale.
    $global:LASTEXITCODE = $null
    $output = @(& $File @Arguments 2>&1 | ForEach-Object { $_.ToString() })
    $code = $global:LASTEXITCODE
    if ($null -eq $code) { throw "Impossibile avviare $File. $($output -join ' ')" }
    if ($script:CommandLog) {
        (@("> $label") + $output + @("ExitCode: $code")) | Add-Content -LiteralPath $script:CommandLog -Encoding UTF8
    }
    if (-not $Quiet) { $output | ForEach-Object { Write-Host $_ } }
    return [pscustomobject]@{ ExitCode = $code; Output = ($output -join "`n") }
}

function Assert-Exit($Result, [string]$Operation) {
    if ($Result.ExitCode -ne 0) { throw "$Operation : exit $($Result.ExitCode). $($Result.Output)" }
}

function Add-Result([string]$Name, [string]$Status, [string]$Detail) {
    $script:Results.Add([pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail })
    Write-Host "[$Status] $Name - $Detail"
}

function Invoke-Step([string]$Name, [scriptblock]$Action) {
    try { & $Action }
    catch { Add-Result $Name 'Failed' $_.Exception.Message }
}

function Get-ExitHex([long]$Code) { return ('{0:X8}' -f ($Code -band 4294967295L)) }

function Test-RestartPending {
    foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')) {
        if (Test-Path -LiteralPath $key) { return $true }
    }
    foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        $state = Get-WindowsOptionalFeature -Online -FeatureName $feature
        if ($state.State -in @('EnablePending', 'DisablePending')) { return $true }
    }
    return $false
}

function Ensure-PackageManager {
    Refresh-Environment
    $exe = if ($PackageManager -eq 'WinGet') { 'winget.exe' } else { 'choco.exe' }
    if (Find-Executable $exe) { return }
    if (-not $BootstrapPackageManager) {
        throw "$exe assente. Installare App Installer dallo Store oppure rieseguire con -BootstrapPackageManager."
    }
    if ($PackageManager -eq 'WinGet') {
        # Procedura Microsoft: modulo dal repository PSGallery, release stabile, niente preview.
        Install-PackageProvider -Name NuGet -Scope CurrentUser -Force | Out-Null
        Install-Module -Name Microsoft.WinGet.Client -Repository PSGallery -Scope CurrentUser -Force
        Import-Module Microsoft.WinGet.Client
        Repair-WinGetPackageManager -AllUsers
    } else {
        # Opt-in esplicito: script ufficiale Chocolatey salvato nel log, non iex su URL arbitrari.
        $bootstrap = Join-Path $script:RunDirectory 'install-chocolatey.ps1'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://community.chocolatey.org/install.ps1' -OutFile $bootstrap
        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $r = Invoke-Tool $ps @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap)
        Assert-Exit $r 'Bootstrap Chocolatey'
    }
    Refresh-Environment
    if (-not (Find-Executable $exe)) { throw "$exe non disponibile dopo il bootstrap. Riaprire PowerShell e riprovare." }
}

function Install-App($App) {
    if ($App.WinGet -eq 'Docker.DockerDesktop' -and $script:RebootRequired) {
        Add-Result $App.Name 'Deferred' 'Riavviare per WSL2, poi rieseguire la fase Apps.'
        return
    }
    if ($App.WinGet -eq 'CoreyButler.NVMforWindows' -and (Find-Executable 'node.exe') -and -not (Find-Executable 'nvm.exe')) {
        throw 'Node standalone presente: disinstallarlo manualmente prima di NVM; non viene cancellato automaticamente.'
    }
    # Codex Desktop resta Microsoft Store anche scegliendo Chocolatey; MAI installare la CLI al suo posto.
    if ($PackageManager -eq 'WinGet' -or $App.Source -eq 'msstore') {
        $exe = Find-Executable 'winget.exe'
        if (-not $exe -and $App.Source -eq 'msstore') {
            Add-Result $App.Name 'Manual' 'Installare dallo Store: https://apps.microsoft.com/detail/9PLM9XGG6VKS'
            return
        }
        if (-not $exe) { throw 'WinGet assente: completare il bootstrap.' }
        $query = @('--id', $App.WinGet, '--exact', '--source', $App.Source, '--accept-source-agreements', '--disable-interactivity')
        $listed = Invoke-Tool $exe (@('list') + $query) -Quiet
        if ($listed.ExitCode -eq 0) { Add-Result $App.Name 'Present' $App.WinGet; return }
        # Solo NO_APPLICATIONS_FOUND significa assente; errore rete/source NON significa assente.
        if ((Get-ExitHex $listed.ExitCode) -ne '8A150014') { throw "Verifica installazione fallita: $($listed.Output)" }
        $shown = Invoke-Tool $exe (@('show') + $query) -Quiet
        Assert-Exit $shown "Pacchetto $($App.WinGet) non disponibile"
        $r = Invoke-Tool $exe (@('install') + $query + @('--silent', '--no-upgrade', '--accept-package-agreements'))
        if ((Get-ExitHex $r.ExitCode) -in @('8A150061', '8A15002B', '8A15010D')) {
            Add-Result $App.Name 'Present' $App.WinGet
            return
        }
    } else {
        $exe = Find-Executable 'choco.exe'
        if (-not $exe) { throw 'Chocolatey assente: completare il bootstrap.' }
        if (-not $App.Chocolatey) { throw 'Nessun ID Chocolatey verificato per questa app.' }
        $version = Invoke-Tool $exe @('--version') -Quiet
        Assert-Exit $version 'Versione Chocolatey'
        $listArgs = @('list', '--exact', $App.Chocolatey, '--limit-output')
        if ($version.Output -match '^1\.') { $listArgs += '--local-only' }
        $listed = Invoke-Tool $exe $listArgs -Quiet
        Assert-Exit $listed 'Inventario Chocolatey'
        if ($listed.Output -match ('(?m)^' + [regex]::Escape($App.Chocolatey) + '\|')) {
            Add-Result $App.Name 'Present' $App.Chocolatey
            return
        }
        $r = Invoke-Tool $exe @('install', $App.Chocolatey, '--yes', '--no-progress',
            '--use-package-exit-codes', '--source', 'https://community.chocolatey.org/api/v2/')
    }
    if ($r.ExitCode -in @(1641, 3010) -or (Get-ExitHex $r.ExitCode) -in @('8A150109', '8A15010A', '8A15010B')) {
        $script:RebootRequired = $true
        Add-Result $App.Name 'Reboot' "Installer exit $($r.ExitCode). Riavvio manuale richiesto."
    } else {
        Assert-Exit $r "Installazione $($App.Name)"
        Add-Result $App.Name 'Installed' 'Installer completato; login e configurazione iniziale manuali.'
    }
    Refresh-Environment
}

function Enable-WSL {
    $computer = Get-CimInstance Win32_ComputerSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    if (-not $computer.HypervisorPresent -and -not $cpu.VirtualizationFirmwareEnabled) {
        throw 'Virtualizzazione disabilitata nel BIOS/UEFI. Abilitarla prima di WSL2/Docker.'
    }
    foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        $state = Get-WindowsOptionalFeature -Online -FeatureName $feature
        if ($state.State -eq 'EnablePending') { $script:RebootRequired = $true; continue }
        if ($state.State -ne 'Enabled') {
            $result = Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart
            if ($result.RestartNeeded) { $script:RebootRequired = $true }
        }
    }
    if ($script:RebootRequired) {
        Add-Result 'WSL2' 'Reboot' 'Funzionalita abilitate. Riavviare, poi rieseguire System e Apps.'
        return
    }
    $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
    Assert-Exit (Invoke-Tool $wsl @('--update', '--web-download')) 'Aggiornamento WSL'
    Assert-Exit (Invoke-Tool $wsl @('--set-default-version', '2')) 'Default WSL2'
    $version = Invoke-Tool $wsl @('--version')
    Assert-Exit $version 'Verifica WSL moderno'
    $cleanVersion = $version.Output -replace "`0", ''
    if ($cleanVersion -notmatch '(\d+\.\d+\.\d+)') { throw 'Versione WSL non riconosciuta; verificare wsl --version.' }
    if ([version]$Matches[1] -lt [version]'2.1.5') { throw 'Docker richiede WSL >= 2.1.5.' }
    Add-Result 'WSL2' 'OK' 'Backend aggiornato; nessuna distribuzione Ubuntu installata.'
}

function Get-NodeRelease([string]$Requested) {
    if ($Requested -ne 'lts') {
        if ([version]$Requested -lt [version]'20.19.0') { throw 'aih richiede Node >=20.19.0.' }
        return $Requested
    }
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
    $release = $releases | Where-Object { $_.lts -and 'win-x64-zip' -in $_.files } |
        Sort-Object { [version]($_.version.TrimStart('v')) } -Descending | Select-Object -First 1
    if (-not $release) { throw 'Nessuna release LTS x64 trovata nel catalogo ufficiale Node.js.' }
    return $release.version.TrimStart('v')
}

function Get-NpmGlobalVersion([string]$Npm, [string]$Package) {
    $inventory = Invoke-Tool $Npm @('list', '--global', '--depth=0', '--json') -Quiet
    # Errori su altre dipendenze globali NON autorizzano aggiornamenti/reinstallazioni.
    Assert-Exit $inventory 'Inventario npm globale (risolvere eventuali ELSPROBLEMS prima di proseguire)'
    $data = $inventory.Output | ConvertFrom-Json
    if ($null -eq $data) { throw 'Inventario npm vuoto/non valido.' }
    $dependencies = $data.PSObject.Properties['dependencies']
    if ($null -ne $dependencies -and $null -ne $dependencies.Value) {
        $entry = $dependencies.Value.PSObject.Properties[$Package]
        if ($entry) { return $entry.Value.version }
    }
    return $null
}

function Get-AihNpmTools {
    @(
        [pscustomobject]@{ Name = 'aih'; Package = '@drakonkat/ai-helper'; Version = $AihVersion; Command = 'aih.cmd' },
        [pscustomobject]@{ Name = 'OpenCodex'; Package = '@bitkyc08/opencodex'; Version = $OpenCodexVersion; Command = 'ocx.cmd' },
        [pscustomobject]@{ Name = 'pxpipe'; Package = 'pxpipe-proxy'; Version = $PxpipeVersion; Command = 'pxpipe.cmd' },
        [pscustomobject]@{ Name = 'agentmemory'; Package = '@agentmemory/agentmemory'; Version = $AgentMemoryVersion; Command = 'agentmemory.cmd' }
    )
}

function Install-NpmGlobalTool([string]$Npm, $Tool) {
    $installed = Get-NpmGlobalVersion $Npm $Tool.Package
    if (-not $installed -or ($Tool.Version -ne 'latest' -and $installed -ne $Tool.Version)) {
        Assert-Exit (Invoke-Tool $Npm @('install', '--global', "$($Tool.Package)@$($Tool.Version)")) "Installazione $($Tool.Name)"
    }
    Assert-Exit (Invoke-Tool $Npm @('list', '--global', $Tool.Package, '--depth=0')) "Verifica pacchetto $($Tool.Name)"
    Refresh-Environment
    if (-not (Find-Executable $Tool.Command)) {
        throw "$($Tool.Command) non sul PATH: controllare npm prefix -g e riaprire il terminale."
    }
    Add-Result $Tool.Name 'OK' "$($Tool.Package) installato e comando disponibile; nessun servizio avviato."
}

function Install-NodeAndAih {
    Refresh-Environment
    $nvm = Find-Executable 'nvm.exe'
    if (-not $nvm) { throw 'NVM non trovato. Eseguire prima la fase Apps e riaprire PowerShell.' }
    if (-not $env:NVM_HOME -or -not $env:NVM_SYMLINK) { throw 'NVM_HOME/NVM_SYMLINK mancanti: riaprire PowerShell.' }
    if (Test-Path -LiteralPath $env:NVM_SYMLINK) {
        $item = Get-Item -LiteralPath $env:NVM_SYMLINK -Force
        if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "NVM_SYMLINK e' una directory reale ($env:NVM_SYMLINK). Rimuovere Node standalone manualmente; nessuna cancellazione automatica."
        }
    }
    $version = Get-NodeRelease $NodeVersion
    $nodeFile = Join-Path $env:NVM_HOME "v$version\node.exe"
    if (-not (Test-Path -LiteralPath $nodeFile)) {
        Assert-Exit (Invoke-Tool $nvm @('install', $version, '64')) 'nvm install'
    }
    if (-not (Test-Path -LiteralPath $nodeFile)) { throw 'NVM non ha creato node.exe anche se ha restituito exit 0.' }
    Assert-Exit (Invoke-Tool $nvm @('use', $version, '64')) 'nvm use'
    Refresh-Environment
    $active = Invoke-Tool (Find-Executable 'node.exe') @('--version')
    Assert-Exit $active 'Verifica Node'
    if ($active.Output.Trim() -ne "v$version") { throw 'Conflitto PATH: node.exe non corrisponde alla versione NVM selezionata.' }
    Add-Result 'Node.js' 'OK' "v$version tramite NVM."
    $npm = Find-Executable 'npm.cmd'
    Assert-Exit (Invoke-Tool $npm @('--version')) 'Verifica npm'
    foreach ($tool in Get-AihNpmTools) {
        Invoke-Step $tool.Name { Install-NpmGlobalTool $npm $tool }
    }
    Write-Host 'Tool di base predisposti se tutti OK nel report. Ripristinare provider/login; poi avviare aih start da un terminale non amministrativo.'
}

function Add-WhatsAppShortcut {
    $programs = [Environment]::GetFolderPath('Programs')
    $path = Join-Path $programs 'WhatsApp Web.url'
    $text = "[InternetShortcut]`r`nURL=https://web.whatsapp.com/`r`n"
    if (Test-Path -LiteralPath $path) {
        if ((Get-Content -LiteralPath $path -Raw) -notmatch 'URL=https://web\.whatsapp\.com/') {
            throw "Esiste gia un collegamento diverso: $path. Non sovrascritto."
        }
    } else {
        New-Item -ItemType Directory -Path $programs -Force | Out-Null
        Set-Content -LiteralPath $path -Value $text -Encoding ASCII
    }
    Add-Result 'WhatsApp Web' 'OK' 'Collegamento nel menu Start; browser predefinito, nessuna app Desktop.'
}

function Invoke-UnrealRestore {
    $helper = Join-Path $PSScriptRoot 'Restore-Neden.ps1'
    if (-not (Test-Path -LiteralPath $helper)) { throw 'Restore-Neden.ps1 mancante: copiare tutta la cartella windows-restore.' }
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $params = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $helper,
        '-Apply', '-AcceptAgreements', '-WorkspacePath', $WorkspacePath, '-EnginePath', $EnginePath,
        '-LogDirectory', $script:RunDirectory)
    if ($PrepareSource) { $params += '-PrepareSource' }
    if ($BuildEditor) { $params += '-BuildEditor' }
    if ($ToolchainOnly) { $params += '-ToolchainOnly' }
    $r = Invoke-Tool $ps $params
    switch ($r.ExitCode) {
        0 { Add-Result 'Neden UE 5.7.4' 'OK' 'Fase richiesta completata. Consultare anche il log UE.' }
        2 { Add-Result 'Neden UE 5.7.4' 'Manual' 'Ripristino sorgenti/configurazioni incompleto: leggere il log UE e README.' }
        3010 { $script:RebootRequired = $true; Add-Result 'Neden UE 5.7.4' 'Reboot' 'Riavviare e rieseguire Unreal.' }
        default { throw "Restore-Neden fallito, exit $($r.ExitCode). Vedere log UE." }
    }
}

$catalog = @(Import-Csv -LiteralPath (Join-Path $PSScriptRoot 'packages.csv'))
foreach ($id in $SkipPackage) {
    if ($id -notin $catalog.WinGet) { throw "SkipPackage sconosciuto: $id. Usare gli ID WinGet del catalogo." }
}
$selected = @($catalog | Where-Object { $_.WinGet -notin $SkipPackage })
if (-not $Apply -or $WhatIfPreference) {
    Write-Host 'ANTEPRIMA: nessun download, installazione o modifica.' -ForegroundColor Cyan
    Write-Host "Fasi: $($Phase -join ', ') | Package manager: $PackageManager"
    if (Test-Phase 'System') { Write-Host 'System: abilita WSL + VirtualMachinePlatform senza riavvio; aggiorna WSL2 dopo il reboot.' }
    if (Test-Phase 'Apps') {
        $selected | Format-Table Name, WinGet, Chocolatey, Source -AutoSize
        if (-not $SkipWhatsApp) { Write-Host 'WhatsApp Web: collegamento https://web.whatsapp.com/ nel menu Start.' }
    }
    if (Test-Phase 'Node') {
        Write-Host "Node: NVM -> Node $NodeVersion -> aih + servizi base (non avvia servizi)."
        Get-AihNpmTools | Format-Table Name, Package, Version, Command -AutoSize
    }
    if (Test-Phase 'Unreal') {
        Write-Host "Unreal: VS2022 + Neden.vsconfig; progetto $WorkspacePath; engine sorgenti 5.7.4 $EnginePath."
        Write-Host "Setup sorgenti: $PrepareSource | Build editor: $BuildEditor | Solo toolchain: $ToolchainOnly"
    }
    Write-Host 'Per procedere: -Apply -AcceptAgreements. Bootstrap package manager solo con -BootstrapPackageManager.'
    return
}
if (-not $AcceptAgreements) { throw 'Per installare accettando le licenze dei pacchetti, aggiungere -AcceptAgreements dopo aver letto README.md.' }
if (-not $PSCmdlet.ShouldProcess('Workstation Windows e workspace Neden', 'Installare e configurare le fasi selezionate')) { return }
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or
    [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'X64') { throw 'Usare Windows PowerShell x64 su Windows x64 (non ARM64).' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $identity.IsSystem) {
    throw 'Aprire PowerShell come amministratore DEL PROPRIO ACCOUNT (non SYSTEM/altro utente).'
}
if ([Environment]::OSVersion.Version.Build -lt 22631) { Write-Warning 'Target consigliato: Windows 11 aggiornato, build >=22631. Verificare il supporto degli installer.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$script:RunDirectory = Join-Path $LogDirectory (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
New-Item -ItemType Directory -Path $script:RunDirectory -Force | Out-Null
$script:CommandLog = Join-Path $script:RunDirectory 'commands.log'
Start-Transcript -LiteralPath (Join-Path $script:RunDirectory 'transcript.log') | Out-Null
try {
    # Anche Apps da sola deve rispettare un reboot WSL pendente da un'esecuzione precedente.
    if ((Test-Phase 'System') -or (Test-Phase 'Apps')) { $script:RebootRequired = Test-RestartPending }
    if (Test-Phase 'System') { Invoke-Step 'WSL2' { Enable-WSL } }
    if (Test-Phase 'Apps') {
        Invoke-Step $PackageManager { Ensure-PackageManager }
        foreach ($app in $selected) { Invoke-Step $app.Name { Install-App $app } }
        if (-not $SkipWhatsApp) { Invoke-Step 'WhatsApp Web' { Add-WhatsAppShortcut } }
    }
    if (Test-Phase 'Node') { Invoke-Step 'Node/aih' { Install-NodeAndAih } }
    if (Test-Phase 'Unreal') { Invoke-Step 'Neden UE 5.7.4' { Invoke-UnrealRestore } }
} finally {
    $script:Results | Format-Table Name, Status, Detail -Wrap
    $report = [ordered]@{ Time = (Get-Date).ToString('o'); RebootRequired = $script:RebootRequired; Results = @($script:Results.ToArray()) }
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $script:RunDirectory 'report.json') -Encoding UTF8
    Write-Host "Log e report: $script:RunDirectory"
    Write-Host 'Login, licenze, profili periferiche, backup dati e configurazioni Perforce/MCP restano manuali. Vedere README.md.'
    if ($script:RebootRequired) { Write-Warning 'RIAVVIO MANUALE richiesto. Poi rieseguire le fasi incomplete.' }
    Stop-Transcript | Out-Null
}
if (@($script:Results | Where-Object Status -eq 'Failed').Count) { exit 1 }
if ($script:RebootRequired) { exit 3010 }
if (@($script:Results | Where-Object { $_.Status -in @('Deferred', 'Manual') }).Count) { exit 2 }
exit 0
