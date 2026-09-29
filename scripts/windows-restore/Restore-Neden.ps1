#requires -Version 5.1
<#
.SYNOPSIS
Restores Neden's Visual Studio 2022 toolchain and its source UE 5.7.4 association.
.DESCRIPTION
Preview is read-only. -Apply -AcceptAgreements enables installation and execution
of restored project/engine code; use only a trusted backup. Source downloads and
editor compilation require separate switches. No Perforce sync or config edits.
Exit codes: 0 complete/preview, 2 manual work, 3010 reboot, 1 failure.
.PARAMETER PrepareSource
Runs trusted Setup.bat --force (may replace GitDependencies-managed engine files)
to avoid its hidden interactive overwrite prompt, then GenerateProjectFiles.bat.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Apply,
    [switch]$AcceptAgreements,
    [string]$WorkspacePath = (Join-Path $env:USERPROFILE 'Perforce\Neden_NiccoloWorkspace'),
    [string]$EnginePath = 'D:\MMO\UE5.7',
    [switch]$ToolchainOnly,
    [switch]$PrepareSource,
    [switch]$BuildEditor,
    [string]$LogDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Controller = $PSCmdlet
$script:Reboot = $false
$script:Manual = $false
$script:ToolchainReady = $false
$script:StepNumber = 0
$transcriptStarted = $false
$preview = -not $Apply -or $WhatIfPreference
$expectedAssociation = '{FB7517BB-46EF-B579-0D08-F8A6ECE6D25E}'
$vsconfig = Join-Path $PSScriptRoot 'Neden.vsconfig'

function Write-Step([string]$Message) { Write-Host "[Neden] $Message" }
function Set-Manual([string]$Message) { $script:Manual = $true; Write-Warning $Message }
function Test-PendingReboot {
    (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or
    (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
}
function Test-Action([string]$Target, [string]$Action) {
    if ($script:Controller.ShouldProcess($Target, $Action)) { return $true }
    $script:Manual = $true
    return $false
}
function Assert-Signature([string]$Path, [switch]$Microsoft) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $Path ($($signature.Status))" }
    if ($Microsoft -and $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
        throw "Installer is not signed by Microsoft Corporation: $Path"
    }
}
function Quote-Argument([string]$Value) {
    # Win32 command-line escaping, including backslashes before a closing quote.
    '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
function Repair-ProcessEnvironmentCase {
    # Some command runners inject both Path and PATH. PS5.1 Start-Process then
    # throws a duplicate-key error. Normalize only this process, never the registry.
    $variables = [Environment]::GetEnvironmentVariables('Process')
    $duplicates = @($variables.Keys | Group-Object { ([string]$_).ToUpperInvariant() } | Where-Object Count -gt 1)
    foreach ($group in $duplicates) {
        $name = [string]$group.Group[0]
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        foreach ($variant in $group.Group) { [Environment]::SetEnvironmentVariable([string]$variant, $null, 'Process') }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}
function Invoke-Logged([string]$Label, [string]$File, [string[]]$Arguments, [string]$Directory = $PSScriptRoot) {
    $script:StepNumber++
    $prefix = Join-Path $LogDirectory ('{0:d2}-{1}' -f $script:StepNumber, ($Label -replace '[^a-zA-Z0-9-]', '-'))
    $argumentLine = ($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' '
    if ([IO.Path]::GetExtension($File) -in @('.cmd', '.bat')) {
        if (($File + ($Arguments -join ' ')) -match '[%\r\n]') { throw 'Batch arguments containing percent signs or newlines are unsafe; use different paths.' }
        # /v:off avoids delayed expansion; caller rejects percent signs in paths.
        $argumentLine = '/d /v:off /s /c "' + (Quote-Argument $File) + ' ' + $argumentLine + '"'
        $File = $env:ComSpec
    }
    Write-Step "$Label -> $prefix.stdout.log"
    Repair-ProcessEnvironmentCase
    $process = Start-Process -FilePath $File -ArgumentList $argumentLine -WorkingDirectory $Directory -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput "$prefix.stdout.log" -RedirectStandardError "$prefix.stderr.log"
    $code = $process.ExitCode
    Write-Step "$Label exit=$code"
    if ($code -in @(3010, 1641)) { $script:Reboot = $true; return }
    if ($code -ne 0) { throw "$Label failed (exit $code). Read $prefix.stderr.log and $prefix.stdout.log; VS also logs dd_* files in TEMP." }
}
function Get-VS2022 {
    $where = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $where)) { return $null }
    $raw = & $where -version '[17.0,18.0)' -products Microsoft.VisualStudio.Product.Community Microsoft.VisualStudio.Product.Professional Microsoft.VisualStudio.Product.Enterprise -latest -format json -utf8
    if ($LASTEXITCODE -ne 0) { throw 'vswhere could not enumerate Visual Studio 2022.' }
    $parsed = ($raw -join "`n") | ConvertFrom-Json
    $instances = @($parsed | Where-Object { $null -ne $_ })
    if ($instances.Count -gt 0) { return $instances[0] }
    return $null
}
function Get-MissingComponents($Instance, [string[]]$Components) {
    if ($null -eq $Instance) { return $Components }
    $where = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    foreach ($component in $Components) {
        $ids = @(& $where -version '[17.0,18.0)' -products '*' -requires $component -property instanceId)
        if ($LASTEXITCODE -ne 0) { throw "vswhere failed for $component" }
        if ($ids -notcontains $Instance.instanceId) { $component }
    }
}
function Test-NedenCompiler($Instance) {
    if ($null -ne $Instance) {
        $root = Join-Path $Instance.installationPath 'VC\Tools\MSVC'
        foreach ($directory in @(Get-ChildItem -LiteralPath $root -Directory -Filter '14.44.*' -ErrorAction SilentlyContinue)) {
            $compiler = Join-Path $directory.FullName 'bin\Hostx64\x64\cl.exe'
            if (-not (Test-Path -LiteralPath $compiler)) { continue }
            # Directory family may remain 14.44.35207 after servicing; use cl.exe's
            # actual ProductVersion (14.x), not FileVersion (19.x) or folder name.
            $actual = $null
            if ([version]::TryParse((Get-Item -LiteralPath $compiler).VersionInfo.ProductVersion, [ref]$actual) -and
                $actual.Major -eq 14 -and $actual.Minor -eq 44 -and $actual -ge [version]'14.44.35211.0') {
                Write-Step "Neden preferred compiler verified: MSVC $actual ($compiler)"
                return $true
            }
        }
    }
    Set-Manual 'MSVC 14.44.35211+ x64 compiler is missing or banned/too old. Update the VS2022 17.14 v143 component in Visual Studio Installer, then rerun. Component presence alone is insufficient.'
    return $false
}
function Test-VcRuntimeSatisfied([string]$Installer) {
    $required = $null
    if (-not [version]::TryParse((Get-Item -LiteralPath $Installer).VersionInfo.ProductVersion, [ref]$required)) {
        throw "Cannot determine signed VC runtime installer ProductVersion: $Installer"
    }
    $runtime = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
    if ($null -eq $runtime -or $null -eq $runtime.PSObject.Properties['Installed'] -or $runtime.Installed -ne 1 -or
        $null -eq $runtime.PSObject.Properties['Version']) { return $false }
    $installed = $null
    if ([version]::TryParse(([string]$runtime.Version).TrimStart('v', 'V'), [ref]$installed) -and $installed -ge $required) {
        Write-Step "VC x64 runtime $installed already satisfies bundled $required; skipping older/equal redistributable."
        return $true
    }
    return $false
}
function Install-Toolchain([string[]]$Components) {
    $instance = Get-VS2022
    $missing = @(Get-MissingComponents $instance $Components)
    if ($missing.Count -eq 0) { $script:ToolchainReady = Test-NedenCompiler $instance; Write-Step 'VS2022: all saved components already installed.'; return }
    Write-Step ('VS2022 missing components: ' + ($missing -join ', '))
    Write-Warning 'The saved config includes legacy MSVC 14.38/.NET 4.6.2. Some catalogs may no longer offer them; resolve explicitly in VS Installer if verification fails. No existing components will be removed.'
    if (-not (Test-Action 'Visual Studio 2022 (not 2026)' 'Install missing Neden.vsconfig components')) { return }
    $arguments = @('--config', $vsconfig, '--quiet', '--norestart')
    if ($null -ne $instance) {
        $installer = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\setup.exe'
        Assert-Signature $installer -Microsoft
        $channel = 'VisualStudio.17.Release'
        if ($null -ne $instance.PSObject.Properties['channelId']) { $channel = [string]$instance.channelId }
        if ($channel -notmatch '^VisualStudio\.17\.') { throw "Refusing to modify unexpected Visual Studio channel: $channel" }
        $arguments = @('modify', '--installPath', $instance.installationPath, '--channelId', $channel) + $arguments
    } else {
        $installer = Join-Path $LogDirectory 'vs2022-community.exe'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vs_community.exe' -OutFile $installer -UseBasicParsing
        Assert-Signature $installer -Microsoft
        $arguments += '--wait' # Supported by bootstrapper only, not setup.exe.
    }
    Invoke-Logged 'VisualStudio2022' $installer $arguments
    if ($script:Reboot) { return }
    $verified = Get-VS2022
    $stillMissing = @(Get-MissingComponents $verified $Components)
    if ($stillMissing.Count -gt 0) { Set-Manual ('VS2022 components still missing (possibly retired): ' + ($stillMissing -join ', ')) }
    else { $script:ToolchainReady = Test-NedenCompiler $verified }
}
function Get-BridgeProblem([string]$BridgePath) {
    $manifestPath = Join-Path $BridgePath 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { return 'UnrealClaude MCP bridge package.json is missing from the restored workspace.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($section in @('dependencies', 'devDependencies', 'optionalDependencies')) {
        $property = $manifest.PSObject.Properties[$section]
        if ($null -eq $property) { continue }
        foreach ($dependency in $property.Value.PSObject.Properties) {
            $value = [string]$dependency.Value
            if ($value -match '^(file|link):') {
                $target = $value -replace '^(file|link):', ''
                if ([string]::IsNullOrWhiteSpace($target)) { return "UnrealClaude dependency '$($dependency.Name)' is '$value' (empty local target). Restore/fix it manually; no npm install and no automatic package edits." }
                if ([IO.Path]::IsPathRooted($target)) { $resolved = [IO.Path]::GetFullPath($target) }
                else { $resolved = [IO.Path]::GetFullPath((Join-Path $BridgePath $target)) }
                if ($resolved.TrimEnd('\') -eq $BridgePath.TrimEnd('\') -or -not (Test-Path -LiteralPath $resolved)) {
                    return "UnrealClaude dependency '$($dependency.Name)' points to itself or a missing path: $value. Restore/fix manually before npm installation."
                }
            }
        }
    }
    return $null
}

try {
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or -not [Environment]::Is64BitProcess) {
        throw 'This helper requires native 64-bit Windows PowerShell on Windows x64 (not ARM64 or a 32-bit process).'
    }
    if ([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) { throw 'Do not run as SYSTEM; HKCU must belong to your normal Windows user.' }
    $WorkspacePath = [IO.Path]::GetFullPath($WorkspacePath)
    $EnginePath = [IO.Path]::GetFullPath($EnginePath)
    foreach ($path in @($WorkspacePath, $EnginePath)) {
        if ($path -match '[%"\r\n]') { throw 'Workspace/engine paths containing %, quotes or newlines are not supported by the batch tools.' }
    }
    if (-not (Test-Path -LiteralPath $vsconfig)) { throw "Keep Neden.vsconfig beside this script: $vsconfig" }
    $components = @((Get-Content -LiteralPath $vsconfig -Raw | ConvertFrom-Json).components)
    Write-Step "Mode=$(if ($preview) { 'READ-ONLY PREVIEW' } else { 'APPLY' }); Workspace=$WorkspacePath; Engine=$EnginePath"
    Write-Step 'Import exact saved VS2022 config: MSVC 14.38 + 14.44, Windows SDK 22621, UE/C++ workloads. No UBT compiler override; globally latest LLVM is not chosen as the preferred compiler.'
    $project = Join-Path $WorkspacePath 'Neden.uproject'
    $versionFile = Join-Path $EnginePath 'Engine\Build\Build.version'
    $buildBat = Join-Path $EnginePath 'Engine\Build\BatchFiles\Build.bat'
    $bridge = Join-Path $WorkspacePath 'Plugins\UnrealClaude\Resources\mcp-bridge'
    $projectReady = $false
    $bridgeProblem = $null
    if (-not $ToolchainOnly) {
        if (-not (Test-Path -LiteralPath $project) -or -not (Test-Path -LiteralPath $versionFile)) {
            Set-Manual 'Restore the Neden workspace AND source engine backup first. Epic Launcher alone does not restore this GUID-associated custom engine. No Perforce sync is performed.'
        } else {
            $descriptor = Get-Content -LiteralPath $project -Raw | ConvertFrom-Json
            $version = Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json
            $actualVersion = "$($version.MajorVersion).$($version.MinorVersion).$($version.PatchVersion)"
            if ($actualVersion -ne '5.7.4' -or $descriptor.EngineAssociation -ne $expectedAssociation) {
                Set-Manual "Expected UE 5.7.4 and association $expectedAssociation; found $actualVersion / $($descriptor.EngineAssociation). No project/engine/registry changes will run."
            } elseif (-not (Test-Path -LiteralPath $buildBat)) {
                Set-Manual "Missing source engine Build.bat: $buildBat"
            } else {
                $projectReady = $true
                $registry = 'HKCU:\Software\Epic Games\Unreal Engine\Builds'
                $existing = Get-ItemProperty -LiteralPath $registry -Name $expectedAssociation -ErrorAction SilentlyContinue
                if ($null -ne $existing) {
                    $registered = [IO.Path]::GetFullPath([string]$existing.$expectedAssociation).TrimEnd('\')
                    if ($registered -ine $EnginePath.TrimEnd('\')) {
                        Set-Manual "GUID already belongs to $registered. Refusing to overwrite or modify Neden.uproject. Resolve this association manually."
                        $projectReady = $false
                    }
                }
                $bridgeProblem = Get-BridgeProblem $bridge
                if ($bridgeProblem) { Set-Manual $bridgeProblem }
            }
        }
        Write-Step "Planned: register unchanged GUID; signed UE prerequisites; projectfiles (-2022); npm ci (or npm install without lock). PrepareSource=$PrepareSource; BuildEditor=$BuildEditor"
    }
    if ($preview) {
        Write-Step 'No writes, downloads or execution of installers/project scripts in preview. Re-run with -Apply -AcceptAgreements in an elevated Windows PowerShell session.'
        if ($script:Manual) { exit 2 }; exit 0
    }
    if (-not $AcceptAgreements) { throw '-Apply requires -AcceptAgreements (third-party licenses and trusted local engine/project scripts).' }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run Windows PowerShell as Administrator; use the same Windows account that owns the workspace (HKCU association).' }
    if (-not (Test-Action 'Neden restore' 'Create logs and perform selected changes')) { exit 2 }
    if (-not $LogDirectory) { $LogDirectory = Join-Path $env:LOCALAPPDATA ('WorkstationRestore\Neden-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
    $LogDirectory = [IO.Path]::GetFullPath($LogDirectory)
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    Start-Transcript -Path (Join-Path $LogDirectory ('Neden-' + [guid]::NewGuid().ToString('N') + '.log')) | Out-Null
    $transcriptStarted = $true
    if (Test-PendingReboot) { Write-Step 'Windows has a pending servicing reboot. Reboot and rerun.'; exit 3010 }
    Install-Toolchain $components
    if ($script:Reboot -or (Test-PendingReboot)) { Write-Step 'Reboot required; rerun afterward. Project preparation deferred.'; exit 3010 }
    if (-not $script:ToolchainReady) { Set-Manual 'Toolchain verification is incomplete. Project preparation/build deferred; resolve VS components and rerun.'; exit 2 }
    if (-not $ToolchainOnly -and $projectReady) {
        if (Test-Action $registry "Register unchanged engine association $expectedAssociation") {
            # Do not overwrite even if another process changed the value since preflight.
            if (-not (Test-Path -LiteralPath $registry)) { New-Item -Path $registry | Out-Null }
            $current = Get-ItemProperty -LiteralPath $registry -Name $expectedAssociation -ErrorAction SilentlyContinue
            if ($null -eq $current) { New-ItemProperty -LiteralPath $registry -Name $expectedAssociation -Value $EnginePath -PropertyType String | Out-Null }
            elseif ([IO.Path]::GetFullPath([string]$current.$expectedAssociation).TrimEnd('\') -ine $EnginePath.TrimEnd('\')) { throw 'Engine GUID association changed during execution; refusing to overwrite.' }
        } else { Write-Step 'Engine association step declined; project preparation deferred.'; exit 2 }
        $prereq = Join-Path $EnginePath 'Engine\Extras\Redist\en-us\UEPrereqSetup_x64.exe'
        if (-not (Test-Path -LiteralPath $prereq)) { $prereq = Join-Path $EnginePath 'Engine\Extras\Redist\en-us\vc_redist.x64.exe' }
        if (Test-Path -LiteralPath $prereq) {
            $isVcRuntime = [IO.Path]::GetFileName($prereq) -ieq 'vc_redist.x64.exe'
            Assert-Signature $prereq -Microsoft:$isVcRuntime
            if (-not ($isVcRuntime -and (Test-VcRuntimeSatisfied $prereq)) -and (Test-Action $prereq 'Install signed Unreal prerequisites')) {
                Invoke-Logged 'UEPrerequisites' $prereq @('/install', '/quiet', '/norestart')
            }
        } else { Set-Manual 'Engine prerequisite installer is missing (UEPrereqSetup_x64.exe/vc_redist.x64.exe); restore dependencies or use -PrepareSource on your trusted source snapshot.' }
        if ($script:Reboot) { Write-Step 'Unreal prerequisites request a reboot. Rerun after reboot.'; exit 3010 }
        if ($PrepareSource -and (Test-Action $EnginePath 'Execute Setup.bat --force (replace managed dependencies) and source GenerateProjectFiles.bat')) {
            Write-Warning 'Setup.bat --force can replace files managed by GitDependencies and register the engine; run only on your trusted restored source backup.'
            foreach ($batch in @('Setup.bat', 'GenerateProjectFiles.bat')) {
                $batchPath = Join-Path $EnginePath $batch
                if (-not (Test-Path -LiteralPath $batchPath)) { throw "Missing source script: $batchPath" }
                $batchArgs = @(); if ($batch -eq 'Setup.bat') { $batchArgs = @('--force') } else { $batchArgs = @('-2022') }
                Invoke-Logged ($batch -replace '\.bat$', '') $batchPath $batchArgs $EnginePath
            }
        }
        if (Test-Action $project 'Generate Neden project files for Visual Studio 2022') {
            Invoke-Logged 'NedenProjectFiles' $buildBat @('-projectfiles', "-project=$project", '-game', '-engine', '-2022') $EnginePath
        }
        if (-not $bridgeProblem) {
            $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
            if ($null -eq $npm) { Set-Manual 'npm.cmd is missing: install/select Node through nvm, then rerun this helper.' }
            elseif (Test-Action $bridge 'Restore npm dependencies (executes trusted package lifecycle scripts)') {
                $npmVerb = 'install'; if (Test-Path -LiteralPath (Join-Path $bridge 'package-lock.json')) { $npmVerb = 'ci' }
                Invoke-Logged 'UnrealClaudeNpm' $npm.Source @($npmVerb) $bridge
            }
        }
        if ($BuildEditor -and (Test-Action $EnginePath 'Compile ShaderCompileWorker and NedenEditor (heavy source build)')) {
            Invoke-Logged 'BuildShaderCompileWorker' $buildBat @('ShaderCompileWorker', 'Win64', 'Development', '-WaitMutex') $EnginePath
            Invoke-Logged 'BuildNedenEditor' $buildBat @('NedenEditor', 'Win64', 'Development', "-Project=$project", '-WaitMutex') $EnginePath
        } elseif (-not $BuildEditor -and -not (Test-Path -LiteralPath (Join-Path $EnginePath 'Engine\Binaries\Win64\UnrealEditor.exe'))) {
            Set-Manual 'UnrealEditor.exe is missing. Restore compiled binaries or explicitly rerun with -BuildEditor (and -PrepareSource if dependencies are missing).'
        }
    }
    if ($script:Reboot -or (Test-PendingReboot)) { Write-Step 'Reboot required; rerun afterward.'; exit 3010 }
    if ($script:Manual) { Write-Step 'Manual work remains; see warnings and rerun after resolving it.'; exit 2 }
    Write-Step 'Selected Neden restore steps complete. Perforce login/mapping/sync and private plugin credentials remain your responsibility.'
    exit 0
} catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
} finally {
    if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
