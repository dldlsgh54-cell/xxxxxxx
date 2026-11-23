[CmdletBinding()]
param(
    [ValidateSet('Install', 'Start', 'Stop', 'Pause', 'Status', 'Inspect')]
    [string]$Action = 'Status',
    [ValidateRange(1, 5)]
    [int]$Profile = 1
)

$ErrorActionPreference = 'Stop'
$taskName = if ($Profile -eq 1) { 'Threads to X Sync' } else { "Threads to X Sync $Profile" }
$profileEnv = if ($Profile -eq 1) { '.env' } else { "data\pairs\$Profile\.env" }
$worker = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($worker -and $worker.Actions.WorkingDirectory -ne $PSScriptRoot) {
    throw 'A task with this name already uses another project directory.'
}

switch ($Action) {
    'Install' {
        if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\twitter-text'))) {
            throw 'Install the Node.js dependencies first with npm.cmd ci --ignore-scripts.'
        }
        if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $profileEnv))) {
            throw 'Create and configure .env first.'
        }
        $node = (Get-Command node.exe).Source
        $env:NODE_USE_SYSTEM_CA = '1'
        & $node (Join-Path $PSScriptRoot 'sync.mjs') check --profile $Profile
        if ($LASTEXITCODE -ne 0) { throw 'Account check failed. The task was not changed.' }
        $account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $entrypoint = Join-Path $PSScriptRoot 'sync.mjs'
        $job = New-ScheduledTaskAction -Execute $node -Argument "--use-system-ca `"$entrypoint`" run --profile $Profile" -WorkingDirectory $PSScriptRoot
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
        $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2)
        Register-ScheduledTask -TaskName $taskName -Action $job -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
        Start-ScheduledTask -TaskName $taskName
        Write-Output 'Installed and started. The worker also starts at Windows sign-in.'
    }
    'Start' {
        if ($worker.State -eq 'Disabled') { Enable-ScheduledTask -TaskName $taskName | Out-Null }
        Start-ScheduledTask -TaskName $taskName
    }
    'Stop' { Stop-ScheduledTask -TaskName $taskName }
    'Pause' {
        Disable-ScheduledTask -TaskName $taskName | Out-Null
        Stop-ScheduledTask -TaskName $taskName
    }
    'Inspect' {
        $result = @{ installed = [bool]$worker; running = [bool]($worker -and $worker.State -eq 'Running'); paused = [bool]($worker -and $worker.State -eq 'Disabled') }
        if ($worker) { $result.lastResult = (Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult }
        $result | ConvertTo-Json -Compress
    }
    'Status' {
        if ($worker) {
            $worker | Select-Object TaskName, State
            Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime, LastTaskResult
        } else {
            Write-Output 'The scheduled task is not installed.'
        }
    }
}
