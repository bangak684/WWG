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
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int type);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint sharing, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
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
        public Dictionary<string, string> environment { get; set; }
    }
    static void Check(bool result) { if (!result) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void HResult(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
    static bool Within(string child, string parent) {
        return child.Equals(parent, StringComparison.OrdinalIgnoreCase) || child.StartsWith(parent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
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
        OrdinaryTree(stage);
        var security = Directory.GetAccessControl(stage);
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(stage, security);
        IntPtr descriptor = IntPtr.Zero;
        try {
            uint size; Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)", 1, out descriptor, out size));
            bool present, defaulted; IntPtr sacl; Check(GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted));
            uint error = SetNamedSecurityInfo(stage, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
            if (error != 0) throw new Win32Exception((int)error);
        } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    static int Run(Request request) {
        if (request == null || request.profile == null || !System.Text.RegularExpressions.Regex.IsMatch(request.profile, "^WWG\\.Command\\.[a-f0-9-]{36}$") || request.command == null || request.command.Length > 8000 || request.command.IndexOf('\0') >= 0) throw new ArgumentException("Invalid command request.");
        string stage = Path.GetFullPath(request.stage).TrimEnd(Path.DirectorySeparatorChar);
        string cwd = Path.GetFullPath(request.cwd).TrimEnd(Path.DirectorySeparatorChar);
        if (!Within(cwd, stage) || stage == Path.GetPathRoot(stage).TrimEnd(Path.DirectorySeparatorChar)) throw new ArgumentException("Invalid workspace.");
        IntPtr sid = IntPtr.Zero, attributes = IntPtr.Zero, job = IntPtr.Zero, token = IntPtr.Zero;
        IntPtr registryGroups = IntPtr.Zero, registrySids = IntPtr.Zero; uint groupCount = 0, registryCount = 0;
        var allocated = new List<IntPtr>(); var localSids = new List<IntPtr>();
        ProcessInfo process = new ProcessInfo(); bool resumed = false;
        try {
            step = "create AppContainer profile";
            HResult(CreateAppContainerProfile(request.profile, "WWG command", "Isolated WWG command workspace", IntPtr.Zero, 0, out sid));
            step = "grant filtered workspace";
            GrantWorkspace(stage, sid);
            step = "derive runtime capabilities";
            var capabilitySids = new List<IntPtr>();
            foreach (string text in new [] { "S-1-15-3-1", "S-1-15-3-3" }) { IntPtr value; Check(ConvertStringSidToSid(text, out value)); localSids.Add(value); capabilitySids.Add(value); }
            HResult(DeriveCapabilitySidsFromName("registryRead", out registryGroups, out groupCount, out registrySids, out registryCount));
            for (int i = 0; i < registryCount; i++) capabilitySids.Add(Marshal.ReadIntPtr(registrySids, i * IntPtr.Size));
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
                environment.Add(pair.Key, pair.Value);
            }
            var block = new StringBuilder(); foreach (var pair in environment) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0'); block.Append('\0');
            IntPtr environmentBlock = Marshal.StringToHGlobalUni(block.ToString()); allocated.Add(environmentBlock);
            string executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
            step = "create suspended cmd";
            Check(CreateProcess(executable, new StringBuilder("\"" + executable + "\" /D /S /C \"" + request.command + "\""), IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | 0x00000004 | 0x00000400 | 0x08000000, environmentBlock, cwd, ref startup, out process));
            step = "contain process tree";
            job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
            Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
            Check(AssignProcessToJobObject(job, process.Process));
            step = "verify LPAC token";
            Check(OpenProcessToken(process.Process, 8, out token));
            int isContainer, isLpac, returned;
            Check(GetTokenInformation(token, 29, out isContainer, 4, out returned));
            Check(GetTokenInformation(token, 46, out isLpac, 4, out returned));
            if (isContainer != 1 || isLpac != 1) throw new IOException("Windows did not create the required LPAC sandbox.");
            step = "execute command";
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
            CloseHandle(job); job = IntPtr.Zero;
            step = "check result reparse points";
            OrdinaryTree(stage);
            return unchecked((int)code);
        } finally {
            if (!resumed && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 125);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (token != IntPtr.Zero) CloseHandle(token);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (localInput != IntPtr.Zero) { CloseHandle(localInput); localInput = IntPtr.Zero; }
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            foreach (IntPtr memory in allocated) Marshal.FreeHGlobal(memory);
            foreach (IntPtr value in localSids) LocalFree(value);
            for (int i = 0; i < registryCount; i++) LocalFree(Marshal.ReadIntPtr(registrySids, i * IntPtr.Size));
            for (int i = 0; i < groupCount; i++) LocalFree(Marshal.ReadIntPtr(registryGroups, i * IntPtr.Size));
            if (registrySids != IntPtr.Zero) LocalFree(registrySids);
            if (registryGroups != IntPtr.Zero) LocalFree(registryGroups);
            if (sid != IntPtr.Zero) { FreeSid(sid); DeleteAppContainerProfile(request.profile); }
        }
    }
    static IntPtr localInput;
    public static int Main(string[] args) {
        try {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            if (args.Length == 2 && args[0] == "--cleanup" && System.Text.RegularExpressions.Regex.IsMatch(args[1], "^WWG\\.Command\\.[a-f0-9-]{36}$")) { DeleteAppContainerProfile(args[1]); return 0; }
            if (args.Length != 0) throw new ArgumentException("Unknown launcher option.");
            var json = new JavaScriptSerializer { MaxJsonLength = 131072 };
            return Run(json.Deserialize<Request>(Console.In.ReadToEnd()));
        } catch (Exception error) { Console.Error.WriteLine("[WWG Windows sandbox: " + step + "] " + error.Message); return 125; }
    }
}
