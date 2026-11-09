# Hermetic function mocks; no CIM or event log access, no Pester dependency.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$subject = Join-Path $PSScriptRoot 'host_exit_snapshot.ps1'
$global:T299_processCalls = 0
$global:T299_eventCalls = 0
$global:T299_mode = 'normal'
$global:T299_eventMode = 'normal'
$global:T299_checks = 0
function Assert($Condition, [string]$Label) {
    if (!$Condition) { throw "FAIL: $Label" }
    $global:T299_checks++
}
function Get-CimInstance {
    param($ClassName,$Filter,$Property,$OperationTimeoutSec,$ErrorAction)
    $global:T299_processCalls++
    Assert ($ClassName -eq 'Win32_Process' -and $Filter -eq 'ProcessId=4242') 'exact_pid_filter'
    Assert (($Property -join ',') -eq 'ProcessId,CreationDate,PrivatePageCount,WorkingSetSize') 'minimal_properties'
    Assert ($OperationTimeoutSec -eq 2) 'cim_timeout'
    if ($global:T299_mode -eq 'absent') { return }
    if ($global:T299_mode -eq 'error') { throw 'SECRET_TOKEN synthetic failure' }
    $time = [datetime]'2026-01-01T00:00:00Z'
    if ($global:T299_mode -eq 'reuse' -and $global:T299_processCalls % 2 -eq 0) { $time=$time.AddSeconds(1) }
    [pscustomobject]@{ProcessId=4242;CreationDate=$time;PrivatePageCount=1234;WorkingSetSize=5678}
}
function Get-WinEvent {
    param($FilterHashtable,$MaxEvents,$ErrorAction)
    $global:T299_eventCalls++
    Assert ($MaxEvents -eq 9) 'bounded_event_sentinel'
    Assert (($FilterHashtable.EndTime-$FilterHashtable.StartTime).TotalSeconds -eq 240) 'exact_window'
    if ($FilterHashtable.LogName -eq 'Application') {
        Assert (($FilterHashtable.Id -join ',') -eq '1000,1001,1002,1026') 'application_ids'
    } else {
        Assert ($FilterHashtable.LogName -eq 'System') 'only_system_optional'
        Assert (($FilterHashtable.Id -join ',') -eq '7031,7034') 'service_ids'
    }
    if ($global:T299_eventMode -eq 'error') { throw 'SECRET_TOKEN private path' }
    if ($global:T299_eventMode -eq 'none') {
        $ex = New-Object System.Exception 'no events'
        $record = New-Object System.Management.Automation.ErrorRecord($ex,'NoMatchingEventsFound',
            [System.Management.Automation.ErrorCategory]::ObjectNotFound,$null)
        throw $record
    }
    1..9 | ForEach-Object {
        [pscustomobject]@{Id=1000;RecordId=$_;TimeCreated=[datetime]'2026-01-01T00:02:00Z';
            ProviderName='Application Error';Message='SECRET_TOKEN';Properties=@('PRIVATE_PATH')}
    }
}
$params = @{TargetProcessId=4242;ExpectedCreatedUtc='2026-01-01T00:00:00Z';
    StartUtc='2026-01-01T00:01:00Z';EndUtc='2026-01-01T00:05:00Z'}
$tokens=$null; $errors=$null
$null=[System.Management.Automation.Language.Parser]::ParseFile($subject,[ref]$tokens,[ref]$errors)
Assert ($errors.Count -eq 0) 'syntax'
$r = & $subject | ConvertFrom-Json
Assert ($r.state -eq 'not_requested') 'no_arguments_no_probe'
Assert ($global:T299_processCalls -eq 0 -and $global:T299_eventCalls -eq 0) 'no_queries_default'
$r = & $subject -TargetProcessId 4242 | ConvertFrom-Json
Assert ($r.state -eq 'invalid_request') 'partial_parameters'
$bad=$params.Clone();$bad.EndUtc='2026-01-01T01:00:00Z'
$r = & $subject @bad | ConvertFrom-Json
Assert ($r.state -eq 'invalid_request') 'window_cap'
$bad=$params.Clone();$bad.StartUtc='2026-01-01T00:01:00'
$r = & $subject @bad | ConvertFrom-Json
Assert ($r.state -eq 'invalid_request') 'utc_required'
Assert ($global:T299_processCalls -eq 0 -and $global:T299_eventCalls -eq 0) 'invalid_no_queries'
$text = & $subject @params
$r=$text | ConvertFrom-Json
Assert ($r.identity -eq 'matched_before_and_after') ('same_identity: ' + $text)
Assert ($r.processBefore.privateBytes -eq 1234 -and $r.processAfter.workingSetBytes -eq 5678) 'memory_fields'
Assert ($r.application.records.Count -eq 8 -and $r.application.truncated) 'event_cap'
Assert ($r.application.records[0].targetAttribution -eq 'UNKNOWN') 'no_pid_inference'
Assert ($r.cause -eq 'UNKNOWN') 'no_oom_inference'
Assert ($text -notmatch 'SECRET_TOKEN|PRIVATE_PATH') 'no_payload_leak'
Assert ([Text.Encoding]::UTF8.GetByteCount($text) -le 16384) 'output_cap'
Assert ($global:T299_processCalls -eq 2 -and $global:T299_eventCalls -eq 1) 'bounded_query_count'
$global:T299_mode='reuse'
$r = & $subject @params | ConvertFrom-Json
Assert ($r.identity -eq 'mismatch_or_pid_reused') 'reuse_detected'
$global:T299_mode='absent';$global:T299_eventMode='none'
$r = & $subject @params | ConvertFrom-Json
Assert ($r.identity -eq 'absent_both_samples') 'absent_explicit'
Assert ($r.application.state -eq 'no_matching_events' -and $r.cause -eq 'UNKNOWN') 'no_events_not_oom'
$global:T299_mode='error';$global:T299_eventMode='error'
$text = & $subject @params
$r=$text | ConvertFrom-Json
Assert ($r.processBefore.state -eq 'query_error' -and $r.application.state -eq 'query_error') 'errors_not_absence'
Assert ($text -notmatch 'SECRET_TOKEN') 'errors_redacted'
$global:T299_mode='normal';$global:T299_eventMode='normal'
$r = & $subject @params -IncludeServiceEvents | ConvertFrom-Json
Assert ($r.systemService.records.Count -eq 8) 'service_optin'
Write-Output "PASS: $global:T299_checks assertions; all OS queries mocked"
