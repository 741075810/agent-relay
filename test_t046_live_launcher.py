"""T046: bounded live-pipe test for host_launcher.exe (Windows only).

Unlike subprocess.run(input=...), this keeps stdin open while it waits for the
hello response, then performs simulate/poll/ack/poll on the same live host. A
single monotonic deadline covers all round trips. The launcher is created
suspended, placed in a Windows Job Object configured with KILL_ON_JOB_CLOSE, and
only then resumed; if any assertion or timeout fails, closing the job terminates
the launcher and every descendant (including python.exe) together.

All queue writes go to a unique temporary directory under this project and that
exact directory is removed in finally. No Chrome, registry, profile, or real
conversation is touched.

Run: python -B -m unittest test_t046_live_launcher -v
"""
import ctypes
import ctypes.wintypes as wt
import json
try:
    import msvcrt
except ImportError:
    msvcrt = None
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from queue import Queue, Empty

import protocol as P

HERE = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.join(HERE, 'host_launcher.exe')
MANIFEST = os.path.join(HERE, 'host_manifest.json')


def _extension_id():
    """Derived, not hard-coded: an unpacked extension's id encodes its load path, so a
    literal here is one machine's configuration rather than part of the test."""
    from_env = os.environ.get('DSH_EXTENSION_ID')
    if from_env:
        return from_env
    if os.path.isfile(MANIFEST):
        try:
            with open(MANIFEST, 'r', encoding='utf-8-sig') as handle:
                for origin in json.load(handle).get('allowed_origins') or []:
                    found = re.match(r'chrome-extension://([^/]+)/?$', origin)
                    if found:
                        return found.group(1)
        except (OSError, ValueError):
            pass
    return 'EXTENSION_ID_PLACEHOLDER'


ORIGIN = 'chrome-extension://%s/' % _extension_id()

# The launcher is a build artefact, not source. A clone that has not built it should say
# so in one skip rather than in seventeen unrelated assertion errors.
needs_launcher = unittest.skipUnless(
    os.path.isfile(LAUNCHER),
    'host_launcher.exe is not built; run launcher\\build_launcher.ps1 '
    '(see docs/HOST_INSTALL.md)')

if os.name == 'nt':
    K32 = ctypes.WinDLL('kernel32', use_last_error=True)
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    HANDLE_FLAG_INHERIT = 1
    STARTF_USESTDHANDLES = 0x100
    CREATE_SUSPENDED = 0x4
    WAIT_OBJECT_0 = 0
    WAIT_TIMEOUT = 258
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000

    class SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [('nLength', wt.DWORD), ('lpSecurityDescriptor', wt.LPVOID),
                    ('bInheritHandle', wt.BOOL)]

    class STARTUPINFO(ctypes.Structure):
        _fields_ = [('cb', wt.DWORD), ('lpReserved', wt.LPWSTR),
                    ('lpDesktop', wt.LPWSTR), ('lpTitle', wt.LPWSTR),
                    ('dwX', wt.DWORD), ('dwY', wt.DWORD),
                    ('dwXSize', wt.DWORD), ('dwYSize', wt.DWORD),
                    ('dwXCountChars', wt.DWORD), ('dwYCountChars', wt.DWORD),
                    ('dwFillAttribute', wt.DWORD), ('dwFlags', wt.DWORD),
                    ('wShowWindow', wt.WORD), ('cbReserved2', wt.WORD),
                    ('lpReserved2', wt.LPVOID), ('hStdInput', wt.HANDLE),
                    ('hStdOutput', wt.HANDLE), ('hStdError', wt.HANDLE)]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [('hProcess', wt.HANDLE), ('hThread', wt.HANDLE),
                    ('dwProcessId', wt.DWORD), ('dwThreadId', wt.DWORD)]

    class BASIC_LIMIT(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong),
                    ('PerJobUserTimeLimit', ctypes.c_longlong),
                    ('LimitFlags', wt.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                    ('MaximumWorkingSetSize', ctypes.c_size_t),
                    ('ActiveProcessLimit', wt.DWORD), ('Affinity', ctypes.c_size_t),
                    ('PriorityClass', wt.DWORD), ('SchedulingClass', wt.DWORD)]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ('ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
                     'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]

    class EXTENDED_LIMIT(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', BASIC_LIMIT), ('IoInfo', IO_COUNTERS),
                    ('ProcessMemoryLimit', ctypes.c_size_t),
                    ('JobMemoryLimit', ctypes.c_size_t),
                    ('PeakProcessMemoryUsed', ctypes.c_size_t),
                    ('PeakJobMemoryUsed', ctypes.c_size_t)]

    class JOB_ACCOUNTING(ctypes.Structure):
        _fields_ = [('TotalUserTime', ctypes.c_longlong),
                    ('TotalKernelTime', ctypes.c_longlong),
                    ('ThisPeriodTotalUserTime', ctypes.c_longlong),
                    ('ThisPeriodTotalKernelTime', ctypes.c_longlong),
                    ('TotalPageFaultCount', wt.DWORD),
                    ('TotalProcesses', wt.DWORD),
                    ('ActiveProcesses', wt.DWORD),
                    ('TotalTerminatedProcesses', wt.DWORD)]

    K32.CreatePipe.argtypes = [ctypes.POINTER(wt.HANDLE), ctypes.POINTER(wt.HANDLE),
                               ctypes.POINTER(SECURITY_ATTRIBUTES), wt.DWORD]
    K32.CreatePipe.restype = wt.BOOL
    K32.SetHandleInformation.argtypes = [wt.HANDLE, wt.DWORD, wt.DWORD]
    K32.SetHandleInformation.restype = wt.BOOL
    K32.CreateJobObjectW.argtypes = [wt.LPVOID, wt.LPCWSTR]
    K32.CreateJobObjectW.restype = wt.HANDLE
    K32.SetInformationJobObject.argtypes = [wt.HANDLE, ctypes.c_int, wt.LPVOID, wt.DWORD]
    K32.SetInformationJobObject.restype = wt.BOOL
    K32.QueryInformationJobObject.argtypes = [wt.HANDLE, ctypes.c_int, wt.LPVOID,
                                             wt.DWORD, ctypes.POINTER(wt.DWORD)]
    K32.QueryInformationJobObject.restype = wt.BOOL
    K32.CreateProcessW.argtypes = [wt.LPCWSTR, wt.LPWSTR, wt.LPVOID, wt.LPVOID,
                                   wt.BOOL, wt.DWORD, wt.LPVOID, wt.LPCWSTR,
                                   ctypes.POINTER(STARTUPINFO),
                                   ctypes.POINTER(PROCESS_INFORMATION)]
    K32.CreateProcessW.restype = wt.BOOL
    K32.AssignProcessToJobObject.argtypes = [wt.HANDLE, wt.HANDLE]
    K32.AssignProcessToJobObject.restype = wt.BOOL
    K32.ResumeThread.argtypes = [wt.HANDLE]
    K32.ResumeThread.restype = wt.DWORD
    K32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
    K32.WaitForSingleObject.restype = wt.DWORD
    K32.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
    K32.GetExitCodeProcess.restype = wt.BOOL
    K32.TerminateJobObject.argtypes = [wt.HANDLE, wt.UINT]
    K32.TerminateJobObject.restype = wt.BOOL
    K32.TerminateProcess.argtypes = [wt.HANDLE, wt.UINT]
    K32.TerminateProcess.restype = wt.BOOL
    K32.CloseHandle.argtypes = [wt.HANDLE]
    K32.CloseHandle.restype = wt.BOOL


def _winerr(label):
    return OSError(ctypes.get_last_error(), label)


def _read_exact(fd, size):
    data = bytearray()
    while len(data) < size:
        part = os.read(fd, size - len(data))
        if not part:
            break
        data.extend(part)
    return bytes(data)


class JobGuardedHost:
    """Launch the real .exe suspended inside a kill-on-close Job Object."""
    def __init__(self, state_dir, origin=ORIGIN, extra_args=()):
        self.job = None
        self.process = None
        self.thread = None
        self.handles = []
        self.fds = []
        self.stderr_chunks = []
        self.stderr_eof = threading.Event()
        self.stdout_eof = threading.Event()
        self.stdout_byte_count = 0
        self.stdout_frames = 0
        self.cleanup_active_processes = None
        self.frames = Queue()
        try:
            self._launch(state_dir, origin, extra_args)
        except Exception:
            self.close()
            raise

    @staticmethod
    def _pipe():
        read_h, write_h = wt.HANDLE(), wt.HANDLE()
        sa = SECURITY_ATTRIBUTES(ctypes.sizeof(SECURITY_ATTRIBUTES), None, True)
        if not K32.CreatePipe(ctypes.byref(read_h), ctypes.byref(write_h),
                              ctypes.byref(sa), 0):
            raise _winerr('CreatePipe')
        return read_h, write_h

    @staticmethod
    def _handle_value(handle):
        return handle.value if hasattr(handle, 'value') else int(handle)

    def _own_fd(self, handle, flags):
        fd = msvcrt.open_osfhandle(self._handle_value(handle), flags | os.O_BINARY)
        self.fds.append(fd)
        return fd

    def _launch(self, state_dir, origin, extra_args):
        in_child, in_parent = self._pipe()
        out_parent, out_child = self._pipe()
        err_parent, err_child = self._pipe()
        self.handles.extend([in_child, in_parent, out_parent, out_child,
                             err_parent, err_child])
        for h in (in_parent, out_parent, err_parent):
            if not K32.SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0):
                raise _winerr('SetHandleInformation(parent pipe)')

        self.job = K32.CreateJobObjectW(None, None)
        if not self.job:
            raise _winerr('CreateJobObjectW')
        limits = EXTENDED_LIMIT()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not K32.SetInformationJobObject(
                self.job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(limits), ctypes.sizeof(limits)):
            raise _winerr('SetInformationJobObject')

        startup = STARTUPINFO()
        startup.cb = ctypes.sizeof(STARTUPINFO)
        startup.dwFlags = STARTF_USESTDHANDLES
        startup.hStdInput = in_child
        startup.hStdOutput = out_child
        startup.hStdError = err_child
        info = PROCESS_INFORMATION()
        cmd = ctypes.create_unicode_buffer(subprocess.list2cmdline(
            [LAUNCHER, '--state-dir', state_dir, '--manifest',
             os.path.join(HERE, 'host_manifest.json'), origin, *extra_args]))
        if not K32.CreateProcessW(LAUNCHER, cmd, None, None, True,
                                  CREATE_SUSPENDED, None, HERE,
                                  ctypes.byref(startup), ctypes.byref(info)):
            raise _winerr('CreateProcessW(host_launcher.exe)')
        self.process, self.thread = info.hProcess, info.hThread

        # Assign before ResumeThread: python cannot start outside the job, even if
        # a later assertion times out immediately after launch.
        if not K32.AssignProcessToJobObject(self.job, self.process):
            K32.TerminateProcess(self.process, 124)
            raise _winerr('AssignProcessToJobObject')

        for h in (in_child, out_child, err_child):
            K32.CloseHandle(h)
            self.handles.remove(h)
        if K32.ResumeThread(self.thread) == 0xFFFFFFFF:
            raise _winerr('ResumeThread')

        self.stdin_fd = self._own_fd(in_parent, os.O_WRONLY)
        self.stdout_fd = self._own_fd(out_parent, os.O_RDONLY)
        self.stderr_fd = self._own_fd(err_parent, os.O_RDONLY)
        for h in (in_parent, out_parent, err_parent):
            self.handles.remove(h)

        threading.Thread(target=self._read_frames, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    def _read_frames(self):
        try:
            while True:
                head = _read_exact(self.stdout_fd, 4)
                if not head:
                    self.frames.put((None, 'stdout EOF'))
                    return
                if len(head) != 4:
                    self.frames.put((None, 'truncated prefix'))
                    return
                size = struct.unpack('=I', head)[0]
                if not 0 < size <= P.MAX_TO_HOST_BYTES:
                    self.frames.put((None, 'invalid frame length %d' % size))
                    return
                body = _read_exact(self.stdout_fd, size)
                if len(body) != size:
                    self.frames.put((None, 'truncated body'))
                    return
                self.stdout_byte_count += 4 + size
                self.stdout_frames += 1
                try:
                    self.frames.put((json.loads(body.decode('utf-8')), None))
                except Exception as exc:
                    self.frames.put((None, 'invalid JSON: %s' % exc))
                    return
        except OSError as exc:
            self.frames.put((None, 'pipe read: %s' % exc))
        finally:
            self.stdout_eof.set()

    def _drain_stderr(self):
        try:
            while True:
                part = os.read(self.stderr_fd, 4096)
                if not part:
                    return
                if sum(map(len, self.stderr_chunks)) < 65536:
                    self.stderr_chunks.append(part[:65536])
        except OSError:
            pass
        finally:
            self.stderr_eof.set()

    def send(self, doc):
        raw = P.encode(doc)
        offset = 0
        while offset < len(raw):
            offset += os.write(self.stdin_fd, raw[offset:])

    def receive(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('overall live-pipe deadline expired')
        try:
            doc, error = self.frames.get(timeout=remaining)
        except Empty:
            raise TimeoutError('overall live-pipe deadline expired')
        if error:
            raise AssertionError('host produced no valid frame: ' + error)
        return doc

    def alive(self):
        return K32.WaitForSingleObject(self.process, 0) == WAIT_TIMEOUT

    def job_active_processes(self):
        info = JOB_ACCOUNTING()
        if not K32.QueryInformationJobObject(
                self.job, 1, ctypes.byref(info), ctypes.sizeof(info), None):
            raise _winerr('QueryInformationJobObject(JobObjectBasicAccountingInformation)')
        return info.ActiveProcesses

    def await_job_drained(self, timeout_ms=5000):
        """Active processes once the tree has settled, or the last reading at timeout.

        The launcher exiting is not the same event as its Job Object being empty: the
        Python child it spawned is still counted until Windows finishes tearing it
        down, and on a loaded machine that gap is longer than a single read. Asserting
        `job_active_processes() == 0` straight after `finish()` therefore failed
        intermittently (observed once in eight full-suite runs, always on this line)
        while nothing had actually leaked. Waiting for the drain keeps the property
        the assertion is for -- "the tree is gone, not orphaned" -- and drops the race.
        """
        deadline = time.monotonic() + max(0.0, timeout_ms / 1000.0)
        active = self.job_active_processes()
        while active != 0 and time.monotonic() < deadline:
            time.sleep(0.01)
            active = self.job_active_processes()
        return active

    def finish(self, timeout_ms):
        os.close(self.stdin_fd)
        self.fds.remove(self.stdin_fd)
        self.stdin_fd = None
        wait = K32.WaitForSingleObject(self.process, timeout_ms)
        if wait != WAIT_OBJECT_0:
            raise TimeoutError('launcher did not exit after stdin EOF')
        code = wt.DWORD()
        if not K32.GetExitCodeProcess(self.process, ctypes.byref(code)):
            raise _winerr('GetExitCodeProcess')
        return code.value

    def terminate_tree(self):
        if not K32.TerminateJobObject(self.job, 124):
            raise _winerr('TerminateJobObject')
        if K32.WaitForSingleObject(self.process, 2000) != WAIT_OBJECT_0:
            raise TimeoutError('launcher process did not terminate with its job')
        self.cleanup_active_processes = self.job_active_processes()
        if self.cleanup_active_processes != 0:
            raise AssertionError('Job Object still has %d live processes'
                                 % self.cleanup_active_processes)

    def close(self):
        # Terminate before closing so cleanup can verify the tree is gone;
        # KILL_ON_JOB_CLOSE remains the last-resort guard.
        cleanup_error = None
        if self.job:
            try:
                active = self.job_active_processes()
                if active and not K32.TerminateJobObject(self.job, 124):
                    raise _winerr('TerminateJobObject(cleanup)')
                if self.process:
                    K32.WaitForSingleObject(self.process, 2000)
                self.cleanup_active_processes = self.job_active_processes()
                if self.cleanup_active_processes != 0:
                    raise AssertionError('cleanup left %d process(es) in Job Object'
                                         % self.cleanup_active_processes)
            except Exception as exc:
                cleanup_error = exc
            finally:
                K32.CloseHandle(self.job)
                self.job = None
        if self.process:
            K32.WaitForSingleObject(self.process, 2000)
        for fd in self.fds:
            try:
                os.close(fd)
            except OSError:
                pass
        self.fds.clear()
        for handle in self.handles:
            K32.CloseHandle(handle)
        self.handles.clear()
        for handle in (self.thread, self.process):
            if handle:
                K32.CloseHandle(handle)
        self.thread = self.process = None
        if cleanup_error:
            raise cleanup_error


@unittest.skipUnless(os.name == 'nt' and msvcrt is not None,
                     'Windows Job Objects and msvcrt are required')
@needs_launcher
class LiveLauncherTests(unittest.TestCase):
    def test_hello_and_queue_cycle_before_eof_with_tree_cleanup(self):
        self.assertTrue(os.path.isfile(LAUNCHER), 'build host_launcher.exe first')
        state_dir = tempfile.mkdtemp(prefix='.t046-live-', dir=HERE)
        self.assertTrue(os.path.abspath(state_dir).startswith(os.path.abspath(HERE) + os.sep))
        guard = None
        try:
            deadline = time.monotonic() + 8.0
            guard = JobGuardedHost(state_dir)
            guard.send({'v': 1, 'id': 'live-hello', 'op': 'hello'})
            hello = guard.receive(deadline)
            self.assertTrue(hello.get('ok'), hello)
            self.assertEqual(hello.get('id'), 'live-hello')
            self.assertIs(hello['result'].get('deliver'), False)
            self.assertTrue(guard.alive(),
                            'host exited before hello while stdin was still open')
            self.assertGreaterEqual(guard.job_active_processes(), 2,
                                    'hello came from a process without a live '
                                    'python child in the Job Object')
            self.assertGreater(guard.stdout_byte_count, 0,
                               'hello was not emitted on the inherited stdout pipe')

            guard.send({'v': 1, 'id': 'live-sim', 'op': 'simulate',
                        'args': {'count': 2}})
            simulated = guard.receive(deadline)
            self.assertTrue(simulated.get('ok'), simulated)
            self.assertEqual(simulated['result'].get('added'), 2)
            self.assertTrue(guard.alive(), 'host exited after simulate')

            guard.send({'v': 1, 'id': 'live-poll', 'op': 'poll',
                        'args': {'limit': 10}})
            polled = guard.receive(deadline)
            events = polled['result'].get('events') or []
            self.assertEqual(len(events), 2)
            self.assertTrue(all(e.get('deliverable') is False for e in events))
            ids = [e['eventId'] for e in events]

            guard.send({'v': 1, 'id': 'live-ack', 'op': 'ack',
                        'args': {'acked': ids}})
            ack = guard.receive(deadline)
            self.assertTrue(ack.get('ok'), ack)
            self.assertEqual(ack['result'].get('newlyAcked'), 2)

            guard.send({'v': 1, 'id': 'live-poll2', 'op': 'poll',
                        'args': {'limit': 10}})
            poll2 = guard.receive(deadline)
            self.assertTrue(poll2.get('ok'), poll2)
            self.assertEqual(poll2['result'].get('events'), [])
            self.assertTrue(guard.alive(),
                            'host exited before the caller closed stdin')
            self.assertEqual(guard.finish(max(1, int((deadline - time.monotonic()) * 1000))), 0)
            self.assertFalse(guard.alive(), 'launcher did not exit cleanly at EOF')
            self.assertEqual(guard.stdout_frames, 5,
                             'stdout must contain only the five correlated protocol frames')
            self.assertEqual(guard.await_job_drained(), 0,
                             'the Python child remained after normal EOF')
            self.assertTrue(guard.stdout_eof.wait(2), 'stdout pipe did not close')
            self.assertTrue(guard.stderr_eof.wait(2), 'stderr pipe did not close')
            stderr = b''.join(guard.stderr_chunks)
            self.assertEqual(stderr, b'', 'unexpected stderr: %r' % stderr[:300])
        finally:
            try:
                if guard:
                    guard.close()
            finally:
                self._remove_temp_state(state_dir)

    def _remove_temp_state(self, state_dir):
        target = os.path.abspath(state_dir)
        root = os.path.abspath(HERE) + os.sep
        if target.startswith(root) and os.path.isdir(target):
            shutil.rmtree(target)

    def test_parent_window_zero_allows_live_hello(self):
        self._assert_parent_window_live_hello('--parent-window=0')

    def test_parent_window_nonzero_allows_live_hello(self):
        self._assert_parent_window_live_hello('--parent-window=2147483647')

    def test_malformed_parent_window_never_reaches_host_protocol(self):
        for raw in ('--parent-window=', '--parent-window=abc',
                    '--parent-window=-1', '--parent-window=1.5',
                    '--parent-window=0x10', '--parent-window=١',
                    '--parent-window=0 --parent-window=1',
                    '--parent-window=0 --unsafe-option'):
            with self.subTest(raw=raw):
                self._assert_parent_window_rejected(raw)

    def _assert_parent_window_live_hello(self, parent_arg):
        state_dir = tempfile.mkdtemp(prefix='.t047-parent-', dir=HERE)
        guard = None
        try:
            deadline = time.monotonic() + 8.0
            guard = JobGuardedHost(state_dir, extra_args=[parent_arg])
            guard.send({'v': 1, 'id': 'parent-hello', 'op': 'hello'})
            hello = guard.receive(deadline)
            self.assertTrue(hello.get('ok'), hello)
            self.assertEqual(hello.get('id'), 'parent-hello')
            self.assertTrue(guard.alive())
            self.assertGreaterEqual(guard.job_active_processes(), 2)

            guard.send({'v': 1, 'id': 'parent-sim', 'op': 'simulate',
                        'args': {'count': 1}})
            simulated = guard.receive(deadline)
            self.assertEqual(simulated.get('id'), 'parent-sim')
            self.assertTrue(simulated.get('ok'), simulated)
            self.assertEqual(simulated['result'].get('added'), 1)

            guard.send({'v': 1, 'id': 'parent-poll', 'op': 'poll',
                        'args': {'limit': 10}})
            polled = guard.receive(deadline)
            self.assertEqual(polled.get('id'), 'parent-poll')
            self.assertTrue(polled.get('ok'), polled)
            events = polled['result'].get('events') or []
            self.assertEqual(len(events), 1)
            self.assertIs(events[0].get('deliverable'), False)

            guard.send({'v': 1, 'id': 'parent-ack', 'op': 'ack',
                        'args': {'acked': [events[0]['eventId']]}})
            ack = guard.receive(deadline)
            self.assertEqual(ack.get('id'), 'parent-ack')
            self.assertTrue(ack.get('ok'), ack)
            self.assertEqual(ack['result'].get('newlyAcked'), 1)

            guard.send({'v': 1, 'id': 'parent-poll2', 'op': 'poll',
                        'args': {'limit': 10}})
            poll2 = guard.receive(deadline)
            self.assertEqual(poll2.get('id'), 'parent-poll2')
            self.assertTrue(poll2.get('ok'), poll2)
            self.assertEqual(poll2['result'].get('events'), [])

            self.assertEqual(guard.finish(
                max(1, int((deadline - time.monotonic()) * 1000))), 0)
            self.assertEqual(guard.stdout_frames, 5)
            self.assertEqual(guard.await_job_drained(), 0)
            self.assertTrue(guard.stdout_eof.wait(2))
            self.assertTrue(guard.stderr_eof.wait(2))
            self.assertEqual(b''.join(guard.stderr_chunks), b'')
        finally:
            try:
                if guard:
                    guard.close()
            finally:
                self._remove_temp_state(state_dir)

    def _assert_parent_window_rejected(self, raw_args):
        state_dir = tempfile.mkdtemp(prefix='.t047-invalid-', dir=HERE)
        guard = None
        try:
            guard = JobGuardedHost(state_dir, extra_args=raw_args.split(' '))
            self.assertTrue(guard.stdout_eof.wait(3),
                            'invalid CLI must exit without emitting a host frame')
            self.assertTrue(guard.stderr_eof.wait(3),
                            'invalid CLI stderr did not close')
            process_deadline = time.monotonic() + 2
            while guard.alive() and time.monotonic() < process_deadline:
                time.sleep(0.01)
            self.assertFalse(guard.alive())
            self.assertEqual(guard.stdout_frames, 0)
            self.assertEqual(guard.await_job_drained(), 0,
                             'invalid CLI should exit without starting a host')
            stderr = b''.join(guard.stderr_chunks).decode('utf-8', 'replace')
            # Python argparse diagnostics are on stderr; stdout stays protocol-clean.
            self.assertIn('unrecognized arguments', stderr)
        finally:
            try:
                if guard:
                    guard.close()
            finally:
                self._remove_temp_state(state_dir)

    def test_overall_timeout_kills_launcher_and_python_tree(self):
        self.assertTrue(os.path.isfile(LAUNCHER), 'build host_launcher.exe first')
        state_dir = tempfile.mkdtemp(prefix='.t046-timeout-', dir=HERE)
        guard = None
        try:
            guard = JobGuardedHost(state_dir, extra_args=['--parent-window=0'])
            spawn_deadline = time.monotonic() + 3.0
            while guard.job_active_processes() < 2:
                if time.monotonic() >= spawn_deadline:
                    self.fail('launcher did not start its Python child in 3 seconds')
                time.sleep(0.02)

            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                guard.receive(started + 0.20)
            self.assertLess(time.monotonic() - started, 1.0,
                            'the explicit receive deadline was not honored')

            guard.terminate_tree()
            self.assertFalse(guard.alive(), 'launcher survived Job Object termination')
            self.assertEqual(guard.cleanup_active_processes, 0,
                             'one or more descendants survived the timeout cleanup')
            self.assertTrue(guard.stdout_eof.wait(2), 'stdout remained open after kill')
            self.assertTrue(guard.stderr_eof.wait(2), 'stderr remained open after kill')
        finally:
            if guard:
                guard.close()
            self._remove_temp_state(state_dir)


if __name__ == '__main__':
    unittest.main(verbosity=2)
