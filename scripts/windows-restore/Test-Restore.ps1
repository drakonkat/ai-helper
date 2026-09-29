#Requires -Version 5.1
# Offline tests only. Never run the real scripts with Apply unless WhatIf is also set
# or the mandatory agreement is absent. Native installer calls are mocked below.
param([string]$FailureLog)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:Passed = 0
$script:Failed = 0
$script:Results = New-Object 'System.Collections.Generic.List[object]'
$script:RebootRequired = $false
$script:CommandLog = $null
$PackageManager = 'WinGet'
$AihVersion = 'latest'
$OpenCodexVersion = 'latest'
$PxpipeVersion = 'latest'
$AgentMemoryVersion = 'latest'
$main = Join-Path $PSScriptRoot 'Restore-Workstation.ps1'
$ue = Join-Path $PSScriptRoot 'Restore-Neden.ps1'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$temp = Join-Path $tempRoot ('restore-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null

function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action) {
    $thrown = $false
    try { & $Action | Out-Null } catch { $thrown = $true }
    Assert $thrown 'Expected an exception.'
}
function Run-Test([string]$Name, [scriptblock]$Action) {
    try { & $Action; $script:Passed++; Write-Host "PASS $Name" }
    catch {
        $script:Failed++
        Write-Host "FAIL $Name : $($_.Exception.Message)" -ForegroundColor Red
        if ($FailureLog) { "$Name : $($_.Exception.Message)" | Add-Content -LiteralPath $FailureLog }
    }
}
function New-Response([long]$Code, [string]$Output = '') { [pscustomobject]@{ ExitCode = $Code; Output = $Output } }
function Reset-Mocks([object[]]$Responses) {
    $script:Responses = New-Object 'System.Collections.Generic.Queue[object]'
    foreach ($response in $Responses) { $script:Responses.Enqueue($response) }
    $script:Calls = New-Object 'System.Collections.Generic.List[object]'
    $script:Results.Clear()
    $script:RebootRequired = $false
}

try {
    # Import function definitions only: do not evaluate the scripts' top-level bodies.
    foreach ($file in @($main, $ue)) {
        $tokens = $null; $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
        Assert ($errors.Count -eq 0) "Parser errors in $file : $errors"
        foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
            . ([scriptblock]::Create($fn.Extent.Text))
        }
    }
    Write-Host 'PASS PS5.1 AST parsing for both production scripts'

    Run-Test 'safe default preview' {
        $output = & $ps -NoProfile -ExecutionPolicy Bypass -File $main -LogDirectory (Join-Path $temp 'no-logs')
        Assert ($LASTEXITCODE -eq 0) 'Preview failed'
        Assert (($output -join ' ') -match 'ANTEPRIMA') 'Expected preview'
        Assert (-not (Test-Path -LiteralPath (Join-Path $temp 'no-logs'))) 'Preview wrote log directory'
    }
    Run-Test 'WhatIf overrides Apply and bootstrap/heavy switches' {
        $output = & $ps -NoProfile -ExecutionPolicy Bypass -File $main -Apply -AcceptAgreements -WhatIf -BootstrapPackageManager -PrepareSource -BuildEditor -LogDirectory (Join-Path $temp 'no-logs')
        Assert ($LASTEXITCODE -eq 0) 'WhatIf failed'
        Assert (($output -join ' ') -match 'ANTEPRIMA') 'Expected preview'
        Assert (-not (Test-Path -LiteralPath (Join-Path $temp 'no-logs'))) 'WhatIf wrote logs'
    }
    Run-Test 'Apply requires explicit agreements before any writes' {
        $ErrorActionPreference = 'Continue'
        $output = & $ps -NoProfile -ExecutionPolicy Bypass -File $main -Apply -LogDirectory (Join-Path $temp 'no-logs') 2>&1
        Assert ($LASTEXITCODE -ne 0) 'Apply without agreements should fail'
        Assert (-not (Test-Path -LiteralPath (Join-Path $temp 'no-logs'))) 'Agreement guard wrote logs'
    }
    Run-Test 'unknown exclusions rejected' {
        $ErrorActionPreference = 'Continue'
        $null = & $ps -NoProfile -ExecutionPolicy Bypass -File $main -SkipPackage unknown.app 2>&1
        Assert ($LASTEXITCODE -ne 0) 'Invalid exclusion should not silently install everything'
    }
    Run-Test 'standalone UE preview missing data is manual, no writes' {
        $null = & $ps -NoProfile -ExecutionPolicy Bypass -File $ue -Apply -AcceptAgreements -WhatIf -PrepareSource -BuildEditor -WorkspacePath (Join-Path $temp 'missing project') -EnginePath (Join-Path $temp 'missing engine') -LogDirectory (Join-Path $temp 'ue-no-logs')
        Assert ($LASTEXITCODE -eq 2) 'Missing source should be manual'
        Assert (-not (Test-Path -LiteralPath (Join-Path $temp 'ue-no-logs'))) 'UE preview wrote logs'
    }
    Run-Test 'catalog identifies desktops, unified Teams, P4V' {
        $apps = @(Import-Csv -LiteralPath (Join-Path $PSScriptRoot 'packages.csv'))
        Assert ($apps.Count -eq 23) 'Expected all requested application packages'
        Assert (@($apps.WinGet | Select-Object -Unique).Count -eq $apps.Count) 'Duplicate IDs'
        $codex = $apps | Where-Object Name -eq 'Codex Desktop'
        Assert ($codex.WinGet -eq '9PLM9XGG6VKS' -and $codex.Source -eq 'msstore' -and -not $codex.Chocolatey) 'Wrong Codex package'
        Assert ('Anthropic.Claude' -in $apps.WinGet -and 'OpenAI.Codex' -notin $apps.WinGet -and 'Anthropic.ClaudeCode' -notin $apps.WinGet) 'Desktop/CLI confusion'
        Assert ('microsoft-teams' -notin $apps.Chocolatey -and 'Perforce.P4' -notin $apps.WinGet) 'Invalid/classic package'
    }
    Run-Test 'signed HRESULT normalization' { Assert ((Get-ExitHex ([int]0x8A150014)) -eq '8A150014') 'HRESULT conversion' }
    Run-Test 'native wrapper preserves stdout, stderr and nonzero exit' {
        $result = Invoke-Tool $ps @('-NoProfile', '-Command', "[Console]::Out.WriteLine('out'); [Console]::Error.WriteLine('err'); exit 7") -Quiet
        Assert ($result.ExitCode -eq 7 -and $result.Output -match 'out' -and $result.Output -match 'err') 'Native exit/output lost'
    }
    Run-Test 'missing native executable cannot inherit previous successful exit' {
        Assert-Throws { Invoke-Tool (Join-Path $temp 'does-not-exist.exe') }
    }
    Run-Test 'UE Win32 argument quoting protects spaces and trailing backslash' {
        Assert ((Quote-Argument 'C:\folder with spaces\') -eq '"C:\folder with spaces\\"') 'Trailing backslash quoting'
    }
    Run-Test 'UE component verification failure keeps project readiness false' {
        function Get-VS2022 { return $null }
        function Get-MissingComponents { return @('missing.component') }
        function Test-Action { return $false }
        $script:ToolchainReady = $false
        Install-Toolchain @('missing.component')
        Assert (-not $script:ToolchainReady) 'Project marked ready without components'
    }
    Run-Test 'UE batch wrapper runs a harmless fixture with spaces and captures failure' {
        $LogDirectory = $temp
        $script:StepNumber = 0
        $batch = Join-Path $temp 'harmless fixture.cmd'
        "@echo off`r`necho %~1`r`nexit /b 7" | Set-Content -LiteralPath $batch -Encoding ASCII
        $failure = $null
        try { Invoke-Logged 'HarmlessFixture' $batch @('first argument') $temp } catch { $failure = $_.Exception.Message }
        Assert ($failure -match 'exit 7') "Expected batch exit 7, got: $failure"
        $logged = Get-Content -LiteralPath (Join-Path $temp '01-HarmlessFixture.stdout.log') -Raw
        Assert ($logged.Trim() -eq 'first argument') 'Batch quoting or output capture failed'
    }
    Run-Test 'pending WSL reboot detected even for an Apps-only rerun' {
        function Test-Path { return $false }
        function Get-WindowsOptionalFeature { [pscustomobject]@{ State = 'EnablePending' } }
        Assert (Test-RestartPending) 'Pending feature not detected'
    }
    Run-Test 'Node explicit minimum and offline resolution' {
        Assert ((Get-NodeRelease '24.14.0') -eq '24.14.0') 'Explicit version changed'
        Assert-Throws { Get-NodeRelease '18.20.0' }
    }
    Run-Test 'Node LTS selection excludes Current and unsupported platform' {
        function Invoke-RestMethod {
            @([pscustomobject]@{ version = 'v26.0.0'; lts = $false; files = @('win-x64-zip') },
              [pscustomobject]@{ version = 'v24.4.0'; lts = 'LTS'; files = @('win-x64-zip') },
              [pscustomobject]@{ version = 'v24.5.0'; lts = 'LTS'; files = @('linux-x64') },
              [pscustomobject]@{ version = 'v22.14.0'; lts = 'LTS'; files = @('win-x64-zip') })
        }
        Assert ((Get-NodeRelease 'lts') -eq '24.4.0') 'Wrong LTS resolution'
    }

    # From here all native calls used by Install-App are fake and recorded.
    function Find-Executable([string]$Name) { return "C:\fake\$Name" }
    function Refresh-Environment { }
    function Invoke-Tool {
        param([string]$File, [string[]]$Arguments = @(), [switch]$Quiet)
        $script:Calls.Add([pscustomobject]@{ File = $File; Arguments = $Arguments })
        if ($script:Responses.Count -eq 0) { throw 'Unexpected native command; no mock response' }
        return $script:Responses.Dequeue()
    }
    $app = [pscustomobject]@{ Name = 'Test app'; WinGet = 'Vendor.App'; Chocolatey = 'app'; Source = 'winget' }
    Run-Test 'npm inventory error cannot be interpreted as absent aih' {
        Reset-Mocks @((New-Response 1 'ELSPROBLEMS'))
        Assert-Throws { Get-NpmGlobalVersion 'C:\fake\npm.cmd' '@drakonkat/ai-helper' }
        Assert ($script:Calls.Count -eq 1) 'Unexpected install after failed inventory'
    }
    Run-Test 'npm inventory returns existing aih version' {
        Reset-Mocks @((New-Response 0 '{"dependencies":{"@drakonkat/ai-helper":{"version":"1.2.4"}}}'))
        Assert ((Get-NpmGlobalVersion 'C:\fake\npm.cmd' '@drakonkat/ai-helper') -eq '1.2.4') 'Existing aih not recognized'
    }
    Run-Test 'base npm catalog includes aih and each default service without CLI confusion' {
        $tools = @(Get-AihNpmTools)
        Assert ($tools.Count -eq 4) 'Incomplete base toolchain'
        Assert ('@bitkyc08/opencodex' -in $tools.Package -and 'pxpipe-proxy' -in $tools.Package -and '@agentmemory/agentmemory' -in $tools.Package) 'Missing service packages'
        Assert (($tools | Where-Object Package -eq '@bitkyc08/opencodex').Command -eq 'ocx.cmd') 'Wrong OpenCodex executable'
        Assert (($tools | Where-Object Package -eq 'pxpipe-proxy').Command -eq 'pxpipe.cmd') 'Wrong pxpipe executable'
        Assert ('@openai/codex' -notin $tools.Package) 'OpenCodex confused with Codex CLI'
    }
    Run-Test 'missing OpenCodex globally installed and checked without start command' {
        Reset-Mocks @((New-Response 0 '{}'), (New-Response 0), (New-Response 0))
        $tool = Get-AihNpmTools | Where-Object Name -eq 'OpenCodex'
        Install-NpmGlobalTool 'C:\fake\npm.cmd' $tool
        Assert (($script:Calls[1].Arguments -join ' ') -eq 'install --global @bitkyc08/opencodex@latest') 'Wrong install package'
        Assert ($script:Calls.Count -eq 3 -and $script:Results[0].Status -eq 'OK') 'Missing postinstall verification or unexpected service startup'
    }
    Run-Test 'existing pxpipe retained when latest requested' {
        Reset-Mocks @((New-Response 0 '{"dependencies":{"pxpipe-proxy":{"version":"0.13.2"}}}'), (New-Response 0))
        Install-NpmGlobalTool 'C:\fake\npm.cmd' (Get-AihNpmTools | Where-Object Name -eq 'pxpipe')
        Assert ($script:Calls.Count -eq 2 -and $script:Calls[1].Arguments[0] -eq 'list') 'Existing pxpipe was upgraded'
    }
    Run-Test 'explicit npm tool version honored and no false success on install failure' {
        $tool = [pscustomobject]@{ Name='pxpipe'; Package='pxpipe-proxy'; Version='0.13.2'; Command='pxpipe.cmd' }
        Reset-Mocks @((New-Response 0 '{"dependencies":{"pxpipe-proxy":{"version":"0.13.1"}}}'), (New-Response 1 'install failed'))
        Assert-Throws { Install-NpmGlobalTool 'C:\fake\npm.cmd' $tool }
        Assert ('pxpipe-proxy@0.13.2' -in $script:Calls[1].Arguments -and $script:Results.Count -eq 0) 'Pin not honored or false success'
    }
    Run-Test 'npm command missing after install is an error' {
        function Find-Executable([string]$Name) { return $null }
        Reset-Mocks @((New-Response 0 '{}'), (New-Response 0), (New-Response 0))
        Assert-Throws { Install-NpmGlobalTool 'C:\fake\npm.cmd' (Get-AihNpmTools | Where-Object Name -eq 'OpenCodex') }
        Assert ($script:Results.Count -eq 0) 'Missing command reported ready'
    }
    Run-Test 'one npm package failure is recorded and does not skip independent packages' {
        Reset-Mocks @((New-Response 0 '{}'), (New-Response 1 'failure'), (New-Response 0 '{}'), (New-Response 0), (New-Response 0))
        foreach ($tool in @(Get-AihNpmTools | Where-Object { $_.Name -in @('OpenCodex','pxpipe') })) {
            Invoke-Step $tool.Name { Install-NpmGlobalTool 'C:\fake\npm.cmd' $tool }
        }
        Assert ($script:Results[0].Status -eq 'Failed' -and $script:Results[1].Status -eq 'OK') 'Independent package failure handling broken'
    }
    Run-Test 'installed app skipped without installer' {
        Reset-Mocks @((New-Response 0 'installed'))
        Install-App $app
        Assert ($script:Calls.Count -eq 1 -and $script:Results[0].Status -eq 'Present') 'Installed app was not skipped'
    }
    Run-Test 'absent app exact install, source and safety flags' {
        Reset-Mocks @((New-Response ([int]0x8A150014)), (New-Response 0), (New-Response 0))
        Install-App $app
        $argsUsed = $script:Calls[2].Arguments
        Assert ($argsUsed[0] -eq 'install' -and '--exact' -in $argsUsed -and '--source' -in $argsUsed -and '--no-upgrade' -in $argsUsed) 'Missing deterministic install flags'
        Assert ('--allow-reboot' -notin $argsUsed -and '--ignore-security-hash' -notin $argsUsed) 'Unsafe installer flags'
        Assert ($script:Results[0].Status -eq 'Installed') 'Wrong result'
    }
    Run-Test 'source failure is not interpreted as absent' {
        Reset-Mocks @((New-Response ([int]0x8A150045) 'source unavailable'))
        Assert-Throws { Install-App $app }
        Assert ($script:Calls.Count -eq 1) 'Installer attempted despite unknown state'
    }
    Run-Test 'hash mismatch fails without alternative installer or checksum bypass' {
        Reset-Mocks @((New-Response ([int]0x8A150014)), (New-Response 0), (New-Response ([int]0x8A150011) 'hash mismatch'))
        Assert-Throws { Install-App $app }
        Assert ($script:Calls.Count -eq 3) 'Unexpected fallback'
    }
    Run-Test 'WinGet reboot HRESULT preserved as reboot, not success/failure' {
        Reset-Mocks @((New-Response ([int]0x8A150014)), (New-Response 0), (New-Response ([int]0x8A15010A)))
        Install-App $app
        Assert ($script:RebootRequired -and $script:Results[0].Status -eq 'Reboot') 'Reboot not propagated'
    }
    Run-Test 'Docker deferred while reboot pending' {
        Reset-Mocks @()
        $script:RebootRequired = $true
        Install-App ([pscustomobject]@{ Name = 'Docker'; WinGet = 'Docker.DockerDesktop' })
        Assert ($script:Calls.Count -eq 0 -and $script:Results[0].Status -eq 'Deferred') 'Docker attempted before WSL reboot'
    }
    Run-Test 'NVM does not overwrite standalone Node' {
        function Find-Executable([string]$Name) { if ($Name -eq 'node.exe') { return 'C:\standalone\node.exe' }; return $null }
        Reset-Mocks @()
        Assert-Throws { Install-App ([pscustomobject]@{ Name = 'NVM'; WinGet = 'CoreyButler.NVMforWindows' }) }
        Assert ($script:Calls.Count -eq 0) 'NVM install attempted despite conflict'
    }
    Run-Test 'Chocolatey v2 local inventory and installed skip' {
        $PackageManager = 'Chocolatey'
        Reset-Mocks @((New-Response 0 '2.6.0'), (New-Response 0 'app|1.2.3'))
        Install-App $app
        Assert ($script:Calls.Count -eq 2 -and '--local-only' -notin $script:Calls[1].Arguments) 'Invalid v2 listing'
        Assert ($script:Results[0].Status -eq 'Present') 'Chocolatey existing app not skipped'
    }
    Run-Test 'Chocolatey v1 uses local-only and install pins community source' {
        $PackageManager = 'Chocolatey'
        Reset-Mocks @((New-Response 0 '1.4.0'), (New-Response 0), (New-Response 3010))
        Install-App $app
        Assert ('--local-only' -in $script:Calls[1].Arguments) 'v1 listing could hit remote'
        Assert ('https://community.chocolatey.org/api/v2/' -in $script:Calls[2].Arguments) 'Wrong source'
        Assert $script:RebootRequired 'Chocolatey reboot lost'
    }
    Run-Test 'Codex in Chocolatey mode stays a manual Store step if WinGet absent' {
        $PackageManager = 'Chocolatey'
        function Find-Executable([string]$Name) { return $null }
        Reset-Mocks @()
        Install-App ([pscustomobject]@{ Name = 'Codex Desktop'; WinGet = '9PLM9XGG6VKS'; Chocolatey = ''; Source = 'msstore' })
        Assert ($script:Calls.Count -eq 0 -and $script:Results[0].Status -eq 'Manual') 'Wrong desktop fallback'
    }
    Run-Test 'UE bridge blocks empty local/self dependencies without npm' {
        $fixture = Join-Path $temp 'bridge'
        New-Item -ItemType Directory -Path $fixture | Out-Null
        '{"name":"ue5-mcp-server","dependencies":{"ue5-mcp-server":"file:"}}' | Set-Content -LiteralPath (Join-Path $fixture 'package.json')
        Assert ((Get-BridgeProblem $fixture) -match 'empty local target') 'Unsafe self dependency not surfaced'
        '{"name":"ue5-mcp-server","dependencies":{"sdk":"^1.0.0"}}' | Set-Content -LiteralPath (Join-Path $fixture 'package.json')
        Assert ($null -eq (Get-BridgeProblem $fixture)) 'Normal bridge incorrectly rejected'
    }
} finally {
    # One shell, explicit absolute containment check before deleting test fixtures only.
    $resolved = [IO.Path]::GetFullPath($temp)
    if (-not $resolved.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notlike 'restore-tests-*') { throw "Unsafe cleanup path: $resolved" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Host "Tests: $script:Passed passed, $script:Failed failed. No real installers executed."
if ($script:Failed) { exit 1 }
exit 0
