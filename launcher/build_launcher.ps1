# T045: build host_launcher.exe so Chrome talks to a real executable.
#
# This is a project-local build. It writes one file next to the sources and does
# not touch the registry, the extension, or any system setting. Installing the
# result (pointing the manifest's `path` at the .exe) is a separate decision that
# this script deliberately does not make -- it prints the exact change instead.
#
#   powershell -ExecutionPolicy Bypass -File build_launcher.ps1
#   powershell -ExecutionPolicy Bypass -File build_launcher.ps1 -Python C:\other\python.exe

[CmdletBinding()]
param(
    [string]$Python = 'E:\program\python312\python.exe'
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
$Out  = Join-Path $Root 'host_launcher.exe'

$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $Csc)) {
    $Csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $Csc)) {
    throw "no C# compiler found. Install .NET Framework 4, or keep using run_host.cmd (now CRLF-corrected)."
}
if (-not (Test-Path $Python)) {
    throw "python not found at $Python"
}

Write-Host "compiler : $Csc"
Write-Host "python   : $Python"
Write-Host "output   : $Out"
Write-Host ''

& $Csc /nologo /target:exe /optimize+ "/out:$Out" (Join-Path $Here 'HostLauncher.cs')
if ($LASTEXITCODE -ne 0) {
    throw "csc failed with exit code $LASTEXITCODE"
}

# Only write the override when it differs from the compiled-in default, so the
# tree does not carry a redundant file that could drift out of sync.
$PythonFile = Join-Path $Root 'python_path.txt'
if ($Python -ne 'E:\program\python312\python.exe') {
    [System.IO.File]::WriteAllText($PythonFile, $Python,
        (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "wrote $PythonFile"
}

Write-Host ''
Write-Host ("built: " + (Get-Item $Out).Length + " bytes")
Write-Host ''
Write-Host 'Verify it handshakes exactly like Chrome will (read-only, simulated only):'
Write-Host "  $Python -B $Root\t045_diagnose.py --launcher $Out"
Write-Host ''
Write-Host 'To actually switch Chrome over to it, edit host_manifest.json and change'
Write-Host '  "path" ...run_host.cmd'
Write-Host 'to'
Write-Host "  \"path\" ...host_launcher.exe"
Write-Host ''
Write-Host 'then reload the extension at chrome://extensions. No registry change is'
Write-Host 'needed: the key points at the manifest, not at the launcher.'
