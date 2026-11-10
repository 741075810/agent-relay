$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tools/dsh-direct/scheduler_shell.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('t331-shell-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  foreach ($case in @(@('Desktop','powershell.exe'), @('Core','pwsh.exe'))) {
    $p = Join-Path $root $case[1]
    New-Item -ItemType File -Path $p | Out-Null
    if ((Resolve-SchedulerShell -ShellHome $root -Edition $case[0]) -ne $p) { throw 'Wrong executable' }
    Remove-Item -LiteralPath $p
    $blocked = $false
    try { Resolve-SchedulerShell -ShellHome $root -Edition $case[0] | Out-Null } catch { $blocked = $true }
    if (-not $blocked) { throw 'Missing executable accepted' }
  }
  $blocked = $false
  try { Resolve-SchedulerShell -ShellHome $root -Edition 'unknown' | Out-Null } catch { $blocked = $true }
  if (-not $blocked) { throw 'Unknown edition accepted' }
  $live = Resolve-SchedulerShell
  & $live -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'tools/dsh-direct/schedule_after_turn.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Default-off child failed' }
  $tokens=$null; $errors=$null
  [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'tools/dsh-direct/schedule_after_turn.ps1'),[ref]$tokens,[ref]$errors) | Out-Null
  if ($errors.Count) { throw 'Launcher parse failed' }
  'PASS: Desktop/Core resolution, missing/unknown guards, real disabled child, launcher parse'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
