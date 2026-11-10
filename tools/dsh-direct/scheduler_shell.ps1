# Resolve the executable belonging to the running PowerShell edition, not a guessed filename.
function Resolve-SchedulerShell {
  param([string]$ShellHome = $PSHOME, [string]$Edition = $PSEdition)
  $name = if ($Edition -eq 'Core') { 'pwsh.exe' } elseif ($Edition -eq 'Desktop') { 'powershell.exe' } else { throw 'Unsupported PowerShell edition' }
  $candidate = Join-Path $ShellHome $name
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw 'Scheduler shell executable missing' }
  return (Resolve-Path -LiteralPath $candidate).Path
}
