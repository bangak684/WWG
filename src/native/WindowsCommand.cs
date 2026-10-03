// Trusted launcher. The requested command and its descendants run in an LPAC,
// with access to a disposable filtered workspace rather than the user's files.
// Requires Windows 10 RS2 or newer; failure never falls back to an ordinary shell.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;

internal static class WindowsCommand {
    static string step = "read request";
    [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct Capabilities { public IntPtr Sid, Values; public uint Count, Reserved; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
        public int Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Id, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User, Kernel, PeriodUser, PeriodKernel; public uint PageFaults, Total, Active, Terminated; }
    [StructLayout(LayoutKind.Sequential)] struct GenericMapping { public uint Read, Write, Execute, All; }
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string text, out IntPtr sid);
    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode)] static extern int DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount, out IntPtr sids, out uint count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimits limits, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int info, out Accounting accounting, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int type);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DefineDosDevice(uint flags, string name, string target);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint QueryDosDevice(string name, StringBuilder target, int length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint sharing, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateToken(IntPtr token, int level, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool AccessCheck(IntPtr descriptor, IntPtr token, uint desired, ref GenericMapping mapping, IntPtr privileges, ref uint privilegeSize, out uint granted, out bool status);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int type, out int value, int size, out int returned);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint length);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    sealed class Request {
        public Request() {}
        public string profile { get; set; }
        public string stage { get; set; }
        public string cwd { get; set; }
        public string command { get; set; }
        public string powershell { get; set; }
        public uint parentPid { get; set; }
        public Dictionary<string, string> environment { get; set; }
        public string[] originalRoots { get; set; }
        public string[] excludedPaths { get; set; }
    }
    static void Check(bool result) { if (!result) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void HResult(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
    static bool Within(string child, string parent) {
        return child.Equals(parent, StringComparison.OrdinalIgnoreCase) || child.StartsWith(parent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }
    static string MountWorkspace(string stage) {
        using (var mutex = new System.Threading.Mutex(false, "Local\\WWG.Command.WorkspaceDrives")) {
            try { mutex.WaitOne(); } catch (System.Threading.AbandonedMutexException) {}
            try {
                for (char letter = 'Z'; letter >= 'D'; letter--) {
                    string name = letter + ":";
                    if (QueryDosDevice(name, new StringBuilder(32768), 32768) != 0) continue;
                    if (Marshal.GetLastWin32Error() != 2) continue;
                    Check(DefineDosDevice(1 | 8, name, "\\??\\" + stage));
                    return name;
                }
                throw new IOException("No temporary workspace drive is available.");
            } finally { mutex.ReleaseMutex(); }
        }
    }
    static string AtDrive(string value, string stage, string drive) {
        return value.Replace(stage, drive + "\\").Replace(drive + "\\\\", drive + "\\");
    }
    static void UnmountWorkspace(string stage) {
        string target = "\\??\\" + Path.GetFullPath(stage).TrimEnd(Path.DirectorySeparatorChar);
        for (char letter = 'D'; letter <= 'Z'; letter++) {
            string name = letter + ":"; var value = new StringBuilder(32768);
            if (QueryDosDevice(name, value, value.Capacity) != 0 && value.ToString().Equals(target, StringComparison.OrdinalIgnoreCase))
                Check(DefineDosDevice(1 | 2 | 4 | 8, name, target));
        }
    }
    static readonly object lifetimeLock = new object();
    static bool parentGone;
    static IntPtr lifetimeProcess, lifetimeJob;
    static string Extended(string value) {
        if (value.StartsWith("\\\\?\\", StringComparison.Ordinal)) return value;
        string full = Path.GetFullPath(value);
        return full.StartsWith("\\\\", StringComparison.Ordinal) ? "\\\\?\\UNC\\" + full.Substring(2) : "\\\\?\\" + full;
    }
    static string QuoteArgument(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static void OrdinaryTree(string root) {
        if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) throw new IOException("Workspace contains a reparse point.");
        foreach (string entry in Directory.EnumerateFileSystemEntries(root)) {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Workspace contains a reparse point.");
            if ((attributes & FileAttributes.Directory) != 0) OrdinaryTree(entry);
        }
    }
    static void GrantWorkspace(string stage, IntPtr sid) {
        stage = Extended(stage);
        OrdinaryTree(stage);
        var identity = new SecurityIdentifier(sid);
        GrantEntry(stage, identity, true);
    }
    static void GrantEntry(string target, SecurityIdentifier identity, bool directory) {
        if (directory) {
            var security = Directory.GetAccessControl(target);
            security.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(target, security);
        } else {
            var security = File.GetAccessControl(target);
            security.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl, AccessControlType.Allow));
            File.SetAccessControl(target, security);
        }
        IntPtr descriptor = IntPtr.Zero;
        try {
            uint size; Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)", 1, out descriptor, out size));
            bool present, defaulted; IntPtr sacl; Check(GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted));
            uint error = SetNamedSecurityInfo(target, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
            if (error != 0) throw new Win32Exception((int)error);
        } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
        if (directory) foreach (string entry in Directory.EnumerateFileSystemEntries(target)) GrantEntry(entry, identity, (File.GetAttributes(entry) & FileAttributes.Directory) != 0);
    }
    static void AddCapability(string name, List<IntPtr> values, List<IntPtr> owned) {
        IntPtr groups = IntPtr.Zero, sids = IntPtr.Zero; uint groupCount = 0, count = 0;
        try {
            HResult(DeriveCapabilitySidsFromName(name, out groups, out groupCount, out sids, out count));
            for (int i = 0; i < count; i++) { IntPtr value = Marshal.ReadIntPtr(sids, i * IntPtr.Size); values.Add(value); owned.Add(value); }
        } finally {
            for (int i = 0; i < groupCount; i++) LocalFree(Marshal.ReadIntPtr(groups, i * IntPtr.Size));
            if (groups != IntPtr.Zero) LocalFree(groups);
            if (sids != IntPtr.Zero) LocalFree(sids);
        }
    }
    static bool ProbeRead(IntPtr token, string packageSid) {
        IntPtr descriptor = IntPtr.Zero, privileges = Marshal.AllocHGlobal(1024);
        try {
            uint length;
            Check(ConvertStringSecurityDescriptorToSecurityDescriptor("O:WDG:WDD:(A;;0x1;;;WD)(A;;0x1;;;" + packageSid + ")", 1, out descriptor, out length));
            var mapping = new GenericMapping { Read = 1, Write = 2, Execute = 4, All = 7 };
            uint privilegeSize = 1024, granted; bool status;
            Check(AccessCheck(descriptor, token, 1, ref mapping, privileges, ref privilegeSize, out granted, out status));
            return status && (granted & 1) != 0;
        } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); Marshal.FreeHGlobal(privileges); }
    }
    static bool ProbePathRead(IntPtr token, string path) {
        path = Extended(path);
        byte[] bytes = (File.GetAttributes(path) & FileAttributes.Directory) != 0 ? Directory.GetAccessControl(path).GetSecurityDescriptorBinaryForm() : File.GetAccessControl(path).GetSecurityDescriptorBinaryForm();
        IntPtr descriptor = Marshal.AllocHGlobal(bytes.Length), privileges = Marshal.AllocHGlobal(1024);
        try {
            Marshal.Copy(bytes, 0, descriptor, bytes.Length);
            var mapping = new GenericMapping { Read = 0x120089, Write = 0x120116, Execute = 0x1200a0, All = 0x1f01ff };
            uint size = 1024, granted; bool status;
            Check(AccessCheck(descriptor, token, 1, ref mapping, privileges, ref size, out granted, out status));
            return status && (granted & 1) != 0;
        } finally { Marshal.FreeHGlobal(descriptor); Marshal.FreeHGlobal(privileges); }
    }
    static void VerifyLpac(IntPtr token, IntPtr appSid, Request request) {
        int isContainer, returned; Check(GetTokenInformation(token, 29, out isContainer, 4, out returned));
        IntPtr duplicate = IntPtr.Zero;
        try {
            Check(DuplicateToken(token, 2, out duplicate));
            // Class 46 is not implemented by GetTokenInformation on supported Windows builds.
            // Verify LPAC's actual access semantics: explicit app SID works, ALL_APPLICATION_PACKAGES does not.
            if (isContainer != 1 || !ProbeRead(duplicate, new SecurityIdentifier(appSid).Value) || ProbeRead(duplicate, "AC")) throw new IOException("Windows did not create the required LPAC sandbox.");
            // Public/restricted-package ACLs must not allow reads of originals or secrets.
            if (request.originalRoots == null) throw new IOException("Missing original workspace boundaries.");
            foreach (string original in request.originalRoots) if (ProbePathRead(duplicate, original)) throw new IOException("Original folder permissions bypass isolation. Select a private project folder.");
            if (request.excludedPaths != null) foreach (string excluded in request.excludedPaths) if (ProbePathRead(duplicate, excluded)) throw new IOException("Secret file permissions bypass isolation. Restrict the original file's OS permissions.");
        } finally { if (duplicate != IntPtr.Zero) CloseHandle(duplicate); }
    }
    static int Run(Request request) {
        if (request == null || request.profile == null || !System.Text.RegularExpressions.Regex.IsMatch(request.profile, "^WWG\\.Command\\.[a-f0-9-]{36}$") || request.command == null || request.command.Length > 8000 || request.command.IndexOf('\0') >= 0) throw new ArgumentException("Invalid command request.");
        string stage = Path.GetFullPath(request.stage).TrimEnd(Path.DirectorySeparatorChar);
        string cwd = Path.GetFullPath(request.cwd).TrimEnd(Path.DirectorySeparatorChar);
        if (!Within(cwd, stage) || stage == Path.GetPathRoot(stage).TrimEnd(Path.DirectorySeparatorChar)) throw new ArgumentException("Invalid workspace.");
        IntPtr parent = OpenProcess(0x00100000, false, request.parentPid);
        if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        // If WWG is terminated forcibly, closing this launcher also closes its job.
        // The OS releases this one lifetime handle when the launcher exits.
        var watch = new System.Threading.Thread(delegate() {
            if (WaitForSingleObject(parent, uint.MaxValue) == 0) lock (lifetimeLock) {
                parentGone = true;
                if (lifetimeJob != IntPtr.Zero) TerminateJobObject(lifetimeJob, 125);
                if (lifetimeProcess != IntPtr.Zero) TerminateProcess(lifetimeProcess, 125);
            }
        });
        watch.IsBackground = true; watch.Start();
        IntPtr sid = IntPtr.Zero, attributes = IntPtr.Zero, job = IntPtr.Zero, token = IntPtr.Zero;
        var allocated = new List<IntPtr>(); var localSids = new List<IntPtr>();
        ProcessInfo process = new ProcessInfo(); bool resumed = false; string workspaceDrive = null;
        try {
            step = "create AppContainer profile";
            HResult(CreateAppContainerProfile(request.profile, "WWG command", "Isolated WWG command workspace", IntPtr.Zero, 0, out sid));
            step = "grant filtered workspace";
            GrantWorkspace(stage, sid);
            step = "mount filtered workspace";
            // A per-logon DOS drive points only to the filtered copy. PowerShell's
            // built-in commands can normalize paths without traversing private parents.
            workspaceDrive = MountWorkspace(stage);
            string shellCwd = AtDrive(cwd, stage, workspaceDrive);
            step = "derive runtime capabilities";
            var capabilitySids = new List<IntPtr>();
            foreach (string text in new [] { "S-1-15-3-1", "S-1-15-3-3" }) { IntPtr value; Check(ConvertStringSidToSid(text, out value)); localSids.Add(value); capabilitySids.Add(value); }
            AddCapability("registryRead", capabilitySids, localSids);
            AddCapability("lpacInstrumentation", capabilitySids, localSids);
            AddCapability("lpacCom", capabilitySids, localSids);
            AddCapability("lpacAppExperience", capabilitySids, localSids);
            AddCapability("lpacCryptoServices", capabilitySids, localSids);
            int sidSize = Marshal.SizeOf(typeof(SidAttributes));
            IntPtr values = Marshal.AllocHGlobal(sidSize * capabilitySids.Count); allocated.Add(values);
            for (int i = 0; i < capabilitySids.Count; i++) Marshal.StructureToPtr(new SidAttributes { Sid = capabilitySids[i], Attributes = 4 }, IntPtr.Add(values, i * sidSize), false);
            IntPtr caps = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Capabilities))); allocated.Add(caps);
            Marshal.StructureToPtr(new Capabilities { Sid = sid, Values = values, Count = (uint)capabilitySids.Count }, caps, false);
            IntPtr policy = Marshal.AllocHGlobal(4); allocated.Add(policy); Marshal.WriteInt32(policy, 1); // ALL_APPLICATION_PACKAGES_OPT_OUT => LPAC
            var sa = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
            IntPtr input = CreateFile("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero);
            if (input == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            localInput = input;
            IntPtr output = GetStdHandle(-11), errorOutput = GetStdHandle(-12);
            Check(SetHandleInformation(output, 1, 1)); Check(SetHandleInformation(errorOutput, 1, 1));
            IntPtr handles = Marshal.AllocHGlobal(3 * IntPtr.Size); allocated.Add(handles);
            Marshal.WriteIntPtr(handles, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, errorOutput);
            IntPtr listSize = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 3, 0, ref listSize);
            step = "configure LPAC attributes";
            attributes = Marshal.AllocHGlobal(listSize); Check(InitializeProcThreadAttributeList(attributes, 3, 0, ref listSize));
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20009), caps, new IntPtr(Marshal.SizeOf(typeof(Capabilities))), IntPtr.Zero, IntPtr.Zero));
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000f), policy, new IntPtr(4), IntPtr.Zero, IntPtr.Zero));
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupEx { Info = new Startup { Size = Marshal.SizeOf(typeof(StartupEx)), Flags = 0x100, Input = input, Output = output, Error = errorOutput }, Attributes = attributes };
            var environment = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (request.environment != null) foreach (var pair in request.environment) {
                if (pair.Key.IndexOfAny(new [] { '=', '\0' }) >= 0 || pair.Value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid environment.");
                environment.Add(pair.Key, AtDrive(pair.Value, stage, workspaceDrive));
            }
            environment["=" + workspaceDrive] = shellCwd;
            var block = new StringBuilder(); foreach (var pair in environment) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0'); block.Append('\0');
            IntPtr environmentBlock = Marshal.StringToHGlobalUni(block.ToString()); allocated.Add(environmentBlock);
            string executable = Path.GetFullPath(request.powershell);
            if (!Within(executable, stage) || !File.Exists(executable)) throw new IOException("Filtered PowerShell runtime is missing.");
            executable = AtDrive(executable, stage, workspaceDrive);
            string script = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;Set-Location -LiteralPath '" + shellCwd.Replace("'", "''") + "';& {\n" + AtDrive(request.command, stage, workspaceDrive) + "\n};if(!$?){exit 1};if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}";
            step = "create suspended PowerShell";
            Check(CreateProcess(executable, new StringBuilder(QuoteArgument(executable) + " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -InputFormat Text -OutputFormat Text -Command " + QuoteArgument(script)), IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | 0x00000004 | 0x00000400 | 0x08000000, environmentBlock, shellCwd, ref startup, out process));
            lock (lifetimeLock) { lifetimeProcess = process.Process; if (parentGone) throw new IOException("WWG closed before execution."); }
            step = "contain process tree";
            job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
            Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
            Check(AssignProcessToJobObject(job, process.Process));
            lock (lifetimeLock) { lifetimeJob = job; if (parentGone) throw new IOException("WWG closed before execution."); }
            step = "verify LPAC token";
            Check(OpenProcessToken(process.Process, 10, out token));
            VerifyLpac(token, sid, request);
            step = "execute command";
            Console.Out.WriteLine("\u001eWWGDRIVE:" + workspaceDrive + "\u001f"); Console.Out.Flush();
            if (ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            resumed = true;
            if (WaitForSingleObject(process.Process, uint.MaxValue) != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint code; Check(GetExitCodeProcess(process.Process, out code));
            step = "stop command descendants";
            // Wait for descendants to exit before Node inspects any output files.
            Check(TerminateJobObject(job, 0));
            Accounting accounting;
            for (int attempt = 0; ; attempt++) {
                Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                if (accounting.Active == 0) break;
                if (attempt == 2000) throw new IOException("Windows command descendants did not stop.");
                System.Threading.Thread.Sleep(5);
            }
            lock (lifetimeLock) { lifetimeJob = IntPtr.Zero; CloseHandle(job); job = IntPtr.Zero; }
            step = "check result reparse points";
            OrdinaryTree(Extended(stage));
            return unchecked((int)code);
        } finally {
            lock (lifetimeLock) { lifetimeJob = IntPtr.Zero; lifetimeProcess = IntPtr.Zero; }
            if (!resumed && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 125);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (token != IntPtr.Zero) CloseHandle(token);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (localInput != IntPtr.Zero) { CloseHandle(localInput); localInput = IntPtr.Zero; }
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            foreach (IntPtr memory in allocated) Marshal.FreeHGlobal(memory);
            foreach (IntPtr value in localSids) LocalFree(value);
            if (workspaceDrive != null) UnmountWorkspace(stage);
            if (sid != IntPtr.Zero) { FreeSid(sid); DeleteAppContainerProfile(request.profile); }
        }
    }
    static IntPtr localInput;
    public static int Main(string[] args) {
        try {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            // Detached launchers have redirected handles but no console code page.
            // Configure the streams without calling SetConsoleCP/SetConsoleOutputCP.
            var utf8 = new UTF8Encoding(false);
            Console.SetIn(new StreamReader(Console.OpenStandardInput(), utf8));
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError(), utf8) { AutoFlush = true });
            if (args.Length == 3 && args[0] == "--cleanup" && System.Text.RegularExpressions.Regex.IsMatch(args[1], "^WWG\\.Command\\.[a-f0-9-]{36}$")) { UnmountWorkspace(args[2]); DeleteAppContainerProfile(args[1]); return 0; }
            if (args.Length != 0) throw new ArgumentException("Unknown launcher option.");
            var json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
            return Run(json.Deserialize<Request>(Console.In.ReadToEnd()));
        } catch (Exception error) { Console.Error.WriteLine("[WWG Windows sandbox: " + step + "] " + error.Message); return 125; }
    }
}
