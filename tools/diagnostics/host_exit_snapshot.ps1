# One-shot metadata only. Windows PowerShell 5.1 / PowerShell 7 on Windows.
[CmdletBinding()]
param(
    [int]$TargetProcessId = 0,
    [string]$ExpectedCreatedUtc = '',
    [string]$StartUtc = '',
    [string]$EndUtc = '',
    [switch]$IncludeServiceEvents
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Convert-StrictUtc([string]$Value) {
    if ($Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$') {
        throw 'invalid_utc'
    }
    return [datetime]::Parse($Value, [cultureinfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AdjustToUniversal)
}
function Read-Target([int]$Id) {
    try {
        # Never request command lines, executable paths, environments or all processes.
        $rows = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$Id" `
            -Property ProcessId,CreationDate,PrivatePageCount,WorkingSetSize `
            -OperationTimeoutSec 2 -ErrorAction Stop)
        if ($rows.Count -eq 0) { return @{ state='absent' } }
        if ($rows.Count -ne 1) { return @{ state='query_error' } }
        $p = $rows[0]
        if ($null -eq $p.CreationDate -or $null -eq $p.PrivatePageCount -or
            $null -eq $p.WorkingSetSize) { return @{ state='metadata_missing' } }
        return @{
            state='present'; pid=[int]$p.ProcessId
            createdUtc=$p.CreationDate.ToUniversalTime().ToString('o')
            privateBytes=[uint64]$p.PrivatePageCount
            workingSetBytes=[uint64]$p.WorkingSetSize
        }
    } catch { return @{ state='query_error' } }
}
function Read-EventMetadata([string]$Log, [int[]]$Ids, [datetime]$From, [datetime]$To) {
    try {
        # 9th record is a sentinel: emit at most 8, mark overflow explicitly.
        $events = @(Get-WinEvent -FilterHashtable @{
            LogName=$Log; Id=$Ids; StartTime=$From; EndTime=$To
        } -MaxEvents 9 -ErrorAction Stop)
        $safe = @($events | Select-Object -First 8 | ForEach-Object {
            # Do not render Message, XML, Properties or arbitrary provider fields.
            # Event metadata is temporal correlation only, NOT target PID attribution.
            $provider = switch ([string]$_.ProviderName) {
                'Application Error' { 'Application Error' }
                'Windows Error Reporting' { 'Windows Error Reporting' }
                'Application Hang' { 'Application Hang' }
                '.NET Runtime' { '.NET Runtime' }
                'Service Control Manager' { 'Service Control Manager' }
                default { 'other_redacted' }
            }
            @{
                eventId=[int]$_.Id; recordId=[long]$_.RecordId
                timeUtc=$_.TimeCreated.ToUniversalTime().ToString('o')
                provider=$provider; targetAttribution='UNKNOWN'
            }
        })
        return @{ state='ok'; records=$safe; truncated=($events.Count -gt 8) }
    } catch {
        if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') {
            return @{ state='no_matching_events'; records=@(); truncated=$false }
        }
        return @{ state='query_error'; records=@(); truncated=$false }
    }
}

$result = [ordered]@{ schema='host-exit-snapshot/1'; state='not_requested';
    cause='UNKNOWN'; writes=0; maxOutputBytes=16384 }
if ($PSBoundParameters.Count -gt 0) {
    try {
        if ($TargetProcessId -le 0 -or !$ExpectedCreatedUtc -or !$StartUtc -or !$EndUtc) {
            throw 'explicit_identity_and_window_required'
        }
        $created = Convert-StrictUtc $ExpectedCreatedUtc
        $from = Convert-StrictUtc $StartUtc
        $to = Convert-StrictUtc $EndUtc
        if ($to -le $from -or ($to-$from).TotalSeconds -gt 300 -or $created -gt $to) {
            throw 'invalid_window'
        }
        $result.state = 'collected'
        $result['targetPid'] = $TargetProcessId
        $result['expectedCreatedUtc'] = $created.ToString('o')
        $result['window'] = @{startUtc=$from.ToString('o');endUtc=$to.ToString('o')}
        $first = Read-Target $TargetProcessId
        $result['processBefore'] = $first
        $app = Read-EventMetadata 'Application' @(1000,1001,1002,1026) $from $to
        $result['application'] = $app
        if ($IncludeServiceEvents) {
            $result['systemService'] = Read-EventMetadata 'System' @(7031,7034) $from $to
        }
        $last = Read-Target $TargetProcessId
        $result['processAfter'] = $last
        $identity = 'unverified'
        if ($first.state -eq 'present' -and $last.state -eq 'present') {
            if ($first.pid -eq $TargetProcessId -and $last.pid -eq $TargetProcessId -and
                ([datetime]$first.createdUtc).ToUniversalTime().Ticks -eq $created.Ticks -and
                ([datetime]$last.createdUtc).ToUniversalTime().Ticks -eq $created.Ticks) {
                $identity = 'matched_before_and_after'
            } else { $identity = 'mismatch_or_pid_reused' }
        } elseif ($first.state -eq 'absent' -and $last.state -eq 'absent') {
            $identity = 'absent_both_samples'
        } elseif ($first.state -ne $last.state) { $identity = 'changed_or_query_uncertain' }
        $result['identity'] = $identity
        $result['limits'] = @{
            maxWindowSeconds=300; maxEventsPerLog=8; maxEventQueries=2; processQueries=2
            eventAttribution='time_window_only_not_process_proof'
            wallClockDeadline='not_guaranteed_by_Get-WinEvent'
            memoryMeaning='OS private/working set; not V8 heap or OOM proof'
        }
    } catch {
        # Never serialize exception text (may contain machine paths or credentials).
        $result = [ordered]@{ schema='host-exit-snapshot/1'; state='invalid_request';
            cause='UNKNOWN'; writes=0; maxOutputBytes=16384 }
    }
}
$json = $result | ConvertTo-Json -Depth 7 -Compress
if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 16384) {
    $json = '{"schema":"host-exit-snapshot/1","state":"output_limit","cause":"UNKNOWN","writes":0}'
}
Write-Output $json
