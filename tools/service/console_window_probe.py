"""Which process puts a console window on this desktop, and when.

This exists because "the code has no visible window" was believed twice and was wrong twice: the Python supervisor spawned
`powershell.exe` without CREATE_NO_WINDOW (T225), and the Node sidecar spawned the Python host without `windowsHide`
(T226, every twenty seconds). Both were invisible to every test because the tests ran from a console, where a child simply
reuses the parent's console instead of creating one.

Run it under pythonw.exe and it answers the question with a count rather than an opinion:

    pythonw.exe -B tools/service/console_window_probe.py --seconds 780 --out windows.jsonl

It is read-only and starts no child process of its own -- a child would be another window candidate and would contaminate
the measurement -- so the process table comes from a Toolhelp snapshot and the window list from EnumWindows. Only the
window *class* is recorded, never the title and never a command line, so nothing an operator is looking at can leak into
the log.
"""

import argparse
import ctypes
import ctypes.wintypes as wintypes
import json
import sys
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

CONSOLE_NAMES = {
    'python.exe', 'pythonw.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'conhost.exe',
    'node.exe', 'tasklist.exe', 'taskkill.exe', 'wscript.exe', 'cscript.exe', 'openconsole.exe',
}
CONSOLE_CLASSES = {
    'ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS', 'PseudoConsoleWindow', '#32770',
}

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
MAX_PATH = 260


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_void_p),
                ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', ctypes.c_long),
                ('dwFlags', wintypes.DWORD), ('szExeFile', ctypes.c_wchar * MAX_PATH)]


def started(pid):
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                        ctypes.byref(kernel), ctypes.byref(user)):
            return None
        return (created.dwHighDateTime << 32) | created.dwLowDateTime
    finally:
        kernel32.CloseHandle(handle)


def snapshot():
    """pid -> (name, parent pid, start FILETIME)."""
    table = {}
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        return table
    try:
        entry = PROCESSENTRY32()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
        more = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while more:
            pid = int(entry.th32ProcessID)
            table[pid] = (entry.szExeFile, int(entry.th32ParentProcessID), started(pid))
            more = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return table


def chain(pid, table, depth=5):
    out, seen = [], set()
    while pid and pid not in seen and len(out) < depth:
        seen.add(pid)
        name, parent, _ = table.get(pid, ('?', 0, None))
        out.append('%s(%d)' % (name, pid))
        pid = parent
    return ' <- '.join(out)


def visible_windows():
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _param):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        klass = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, klass, 256)
        found.append((int(hwnd), int(pid.value), klass.value))
        return True

    user32.EnumWindows(callback, 0)
    return found


def watch(out_path, seconds, interval=0.25):
    """Record every visible console-ish window and every console-ish process started in the window."""
    deadline = time.time() + seconds
    seen_windows, seen_pids = set(), set()
    count = {'window': 0, 'proc': 0}
    with open(out_path, 'w', encoding='utf-8') as out:
        def emit(record):
            out.write(json.dumps(record, ensure_ascii=False) + '\n')
            out.flush()

        emit({'kind': 'start', 'at': time.time()})
        while time.time() < deadline:
            table = snapshot()
            for pid, (name, parent, created) in table.items():
                if pid in seen_pids:
                    continue
                seen_pids.add(pid)
                if name.lower() in CONSOLE_NAMES:
                    count['proc'] += 1
                    emit({'kind': 'proc', 'at': time.time(), 'pid': pid, 'name': name,
                          'parent': parent, 'created': created, 'chain': chain(pid, table)})
            for hwnd, pid, klass in visible_windows():
                name = table.get(pid, ('?', 0, None))[0]
                if klass not in CONSOLE_CLASSES and name.lower() not in CONSOLE_NAMES:
                    continue
                if (hwnd, pid) in seen_windows:
                    continue
                seen_windows.add((hwnd, pid))
                count['window'] += 1
                emit({'kind': 'window', 'at': time.time(), 'hwnd': hwnd, 'pid': pid,
                      'name': name, 'class': klass, 'chain': chain(pid, table)})
            time.sleep(interval)
        emit({'kind': 'stop', 'at': time.time()})
    return count


def main(argv=None):
    parser = argparse.ArgumentParser(description='Count visible console windows and attribute each to a process chain.')
    parser.add_argument('--seconds', type=float, default=600.0, help='how long to watch (default 600)')
    parser.add_argument('--out', default='console_windows.jsonl', help='where to write the records')
    parser.add_argument('--quiet', action='store_true', help='print nothing but the totals')
    args = parser.parse_args(argv)

    if sys.platform != 'win32':
        print('windows only: this asks the Windows API about window visibility')
        return 2
    count = watch(args.out, args.seconds)
    if not args.quiet:
        print('watched %.0fs -> %d visible console windows, %d console processes' % (args.seconds, count['window'], count['proc']))
        print('records: %s' % args.out)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
