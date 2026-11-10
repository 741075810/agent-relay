param(
  [switch]$Enable,
  [switch]$Execute,
  [string]$Plan,
  [string]$TaskName,
  [string]$Node,
  [switch]$ExclusiveLedgerConfirmed
)
$ErrorActionPreference = 'Stop'
if (-not $Enable) { '{"code":"disabled"}'; exit 0 }
# Only this exact script's unique registration is eligible for cleanup.
if ($Execute) {
  if ($TaskName -notmatch '^DSH-Canary-Once-[0-9a-f]{32}$') { throw 'Invalid task name' }
  $exitCode = 2
  try {
    $others = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
      $_.CommandLine -match 'mcp_server\.mjs|completion_owner\.mjs|acceptance_bootstrap\.mjs|after_turn_once\.mjs'
    })
    if ($others.Count) { throw 'Competing Direct owner at execution time' }
    & $Node (Join-Path $PSScriptRoot 'after_turn_once.mjs') --enable --plan $Plan *> ($Plan + '.output.txt')
    $exitCode = $LASTEXITCODE
  } finally {
    try {
      $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      if ($task.Description -eq ('DSH finite canary plan: ' + $Plan)) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        'registration_removed' | Out-File -LiteralPath ($Plan + '.cleanup.txt') -Encoding utf8
      }
    } catch { 'cleanup_unverified' | Out-File -LiteralPath ($Plan + '.cleanup.txt') -Encoding utf8 }
  }
  exit $exitCode
}
if (-not $ExclusiveLedgerConfirmed) { throw 'Exclusive Direct ledger ownership has not been confirmed' }
$Plan = (Resolve-Path -LiteralPath $Plan).Path
if (-not $Node) { $Node = (Get-Command node -ErrorAction Stop).Source }
$Node = (Resolve-Path -LiteralPath $Node).Path
if ($Plan.Contains('"') -or $Node.Contains('"') -or $PSCommandPath.Contains('"')) { throw 'Invalid quoted path' }
if ((Get-Service Schedule).Status -ne 'Running') { throw 'Scheduler not running' }
# Refuse identifiable competing Direct owners; absence alone is not an exclusive ownership proof.
$others = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
  $_.CommandLine -match 'mcp_server\.mjs|completion_owner\.mjs|acceptance_bootstrap\.mjs|after_turn_once\.mjs'
})
if ($others.Count) { throw 'Existing Direct process owner detected' }
& $Node (Join-Path $PSScriptRoot 'after_turn_once.mjs') --enable --check-only --plan $Plan
if ($LASTEXITCODE -ne 0) { throw 'Direct preflight refused; no registration created' }
# Registration itself is one-shot per plan, even after success removes the scheduler entry.
$claim = [IO.File]::Open($Plan + '.registered', 'CreateNew', 'Write', 'None'); $claim.Dispose()
$TaskName = 'DSH-Canary-Once-' + [guid]::NewGuid().ToString('N')
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$triggerAt = (Get-Date).AddSeconds(20)
$arguments = '-NoProfile -NonInteractive -File "' + $PSCommandPath + '" -Enable -Execute -Plan "' + $Plan + '" -TaskName "' + $TaskName + '" -Node "' + $Node + '"'
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'pwsh.exe') -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Once -At $triggerAt
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew -RestartCount 0
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ('DSH finite canary plan: ' + $Plan) | Out-Null
[pscustomobject]@{taskName=$TaskName;trigger=$triggerAt.ToString('o');plan=$Plan;user=$user;status='armed_not_executed'} | ConvertTo-Json | Tee-Object -FilePath ($Plan + '.registration.json')
