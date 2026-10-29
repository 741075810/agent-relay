// T045: a real .exe launcher for the com.dsh.notify native messaging host.
//
// Why this exists. Chrome's native messaging manifest has no "args" field: `path`
// must name an executable and nothing else. The host is Python, so something has
// to turn one executable name into `python.exe host.py --state-dir ... --manifest
// ... <origin>`. T044 used a .cmd wrapper, which works (T045 measured it: five
// round trips on one live process), but it inserts cmd.exe between Chrome and the
// host. That costs three things a plain .exe does not: cmd.exe parses the file, so
// line endings or a stray BOM change what runs; cmd.exe is the child Chrome holds
// a handle to, so if it exits early Chrome drops the port and python is orphaned;
// and any command echo that escapes `@echo off` lands on stdout, which is the wire.
//
// Why P/Invoke instead of System.Diagnostics.Process. The first version of this
// file used Process.Start and hung: `out.bin` stayed at 0 bytes with python alive
// and blocked. The cause is in .NET's implementation -- when none of
// RedirectStandard* is set it calls CreateProcess with `bInheritHandles = FALSE`,
// so the child does not receive the parent's stdin/stdout at all. For a native
// messaging host those handles are the entire channel, so the child sat on an
// invalid stdin and never answered. CreateProcess is called directly here with
// bInheritHandles = TRUE and STARTF_USESTDHANDLES, which is what cmd.exe was doing
// implicitly.
//
// This launcher writes nothing to stdout itself: stdout carries framed messages
// and nothing else. Diagnostics go to stderr, which Chrome forwards to its own log.
//
// Build: powershell -ExecutionPolicy Bypass -File build_launcher.ps1

using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

static class HostLauncher
{
    // Used when python_path.txt is absent. Kept identical to run_host.cmd so one
    // interpreter path is documented rather than two.
    const string DefaultPython = @"E:\program\python312\python.exe";

    const int STARTF_USESTDHANDLES = 0x00000100;
    const uint HANDLE_FLAG_INHERIT = 0x00000001;
    const int STD_INPUT_HANDLE = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE = -12;
    const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public int dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int which);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string appName, StringBuilder commandLine,
        IntPtr processAttrs, IntPtr threadAttrs, bool inheritHandles,
        uint creationFlags, IntPtr environment, string currentDirectory,
        ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);

        string python = DefaultPython;
        string pythonFile = Path.Combine(dir, "python_path.txt");
        if (File.Exists(pythonFile))
        {
            string configured = File.ReadAllText(pythonFile).Trim();
            if (configured.Length > 0)
            {
                python = configured;
            }
        }
        if (!File.Exists(python))
        {
            Console.Error.WriteLine("com.dsh.notify: python not found at " + python);
            return 4;
        }

        string script = Path.Combine(dir, "host.py");
        if (!File.Exists(script))
        {
            Console.Error.WriteLine("com.dsh.notify: host.py not found next to the launcher");
            return 4;
        }

        // -B: do not write __pycache__ inside the delivered tree.
        // -u: unbuffered, so a reply leaves the process as soon as it is written.
        //     The host flushes explicitly as well; this makes it impossible to
        //     regress into a host that is running but silent.
        StringBuilder commandLine = new StringBuilder();
        commandLine.Append(Quote(python));
        commandLine.Append(" -B -u ");
        commandLine.Append(Quote(script));
        commandLine.Append(" --state-dir ").Append(Quote(Path.Combine(dir, "state")));
        commandLine.Append(" --manifest ").Append(Quote(Path.Combine(dir, "host_manifest.json")));
        // Chrome appends the caller origin; forward it unchanged so the host's
        // allow-list check sees exactly what Chrome sent.
        foreach (string arg in args)
        {
            commandLine.Append(' ').Append(Quote(arg));
        }

        IntPtr stdIn = GetStdHandle(STD_INPUT_HANDLE);
        IntPtr stdOut = GetStdHandle(STD_OUTPUT_HANDLE);
        IntPtr stdErr = GetStdHandle(STD_ERROR_HANDLE);

        // The child only receives these handles if they are marked inheritable.
        // Set it explicitly rather than relying on how the parent was launched.
        if (stdIn != IntPtr.Zero) SetHandleInformation(stdIn, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        if (stdOut != IntPtr.Zero) SetHandleInformation(stdOut, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        if (stdErr != IntPtr.Zero) SetHandleInformation(stdErr, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = stdIn;
        startup.hStdOutput = stdOut;
        startup.hStdError = stdErr;

        PROCESS_INFORMATION info;
        bool started = CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero,
            true, 0, IntPtr.Zero, dir, ref startup, out info);
        if (!started)
        {
            int code = Marshal.GetLastWin32Error();
            Console.Error.WriteLine("com.dsh.notify: CreateProcess failed, win32 error "
                + code + ": " + commandLine);
            return 5;
        }

        // Wait, so Chrome's child handle lives exactly as long as the host does.
        // Returning early would make Chrome see the host exit and drop the port
        // while python was still running.
        WaitForSingleObject(info.hProcess, INFINITE);
        uint exitCode;
        GetExitCodeProcess(info.hProcess, out exitCode);
        CloseHandle(info.hThread);
        CloseHandle(info.hProcess);
        return unchecked((int)exitCode);
    }

    // Double quotes are the only quoting cmd.exe-free CreateProcess understands;
    // backslash-escaping before a quote is the documented rule.
    static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOf(' ') < 0 && value.IndexOf('\t') < 0
            && value.IndexOf('"') < 0)
        {
            return value;
        }
        StringBuilder out_ = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\')
            {
                backslashes++;
                out_.Append(ch);
            }
            else if (ch == '"')
            {
                out_.Append('\\', backslashes + 1);
                out_.Append('"');
                backslashes = 0;
            }
            else
            {
                backslashes = 0;
                out_.Append(ch);
            }
        }
        out_.Append('\\', backslashes);
        out_.Append('"');
        return out_.ToString();
    }
}
