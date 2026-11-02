export const encodePowerShell = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');

export const POWERSHELL_ARGS_PREFIX = ['-NoLogo', '-NoProfile', '-NonInteractive'] as const;

export const powershellArgs = (script: string): string[] => [...POWERSHELL_ARGS_PREFIX, '-EncodedCommand', encodePowerShell(script)];

export const powershellPath = (env: Readonly<Record<string, string | undefined>>): string => {
  const systemRoot = env['SystemRoot'];
  if (systemRoot === undefined || systemRoot === '') throw new Error('SystemRoot is not set, so Windows PowerShell cannot be located');
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
};

export const taskkillPath = (env: Readonly<Record<string, string | undefined>>): string => {
  const systemRoot = env['SystemRoot'];
  if (systemRoot === undefined || systemRoot === '') throw new Error('SystemRoot is not set, so taskkill cannot be located');
  return `${systemRoot}\\System32\\taskkill.exe`;
};

export const PROCESS_TABLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$rows = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object {',
  '  [pscustomobject]@{ pid = [int64]$_.ProcessId; ppid = [int64]$_.ParentProcessId; startMs = [int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }',
  '})',
  'ConvertTo-Json -Compress -InputObject $rows',
].join('\n');

export const startTimeScript = (pid: number): string => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError(`pid must be a positive integer: ${pid}`);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}'`,
    'if ($p -and $p.CreationDate) { [string]([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }',
  ].join('\n');
};

const RESTART_MANAGER_TYPES = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MomongaRestartManager {
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] public struct UNIQUE_PROCESS { public int ProcessId; public FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct PROCESS_INFO {
    public UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint session, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint files, string[] names, uint apps, IntPtr applications, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] PROCESS_INFO[] info, out uint reasons);
  const int ERROR_MORE_DATA = 234;
  public static int[] Holders(string file) {
    uint session;
    var key = new StringBuilder(33);
    int status = RmStartSession(out session, 0, key);
    if (status != 0) throw new InvalidOperationException("RmStartSession failed: " + status);
    try {
      status = RmRegisterResources(session, 1, new[] { file }, 0, IntPtr.Zero, 0, null);
      if (status != 0) throw new InvalidOperationException("RmRegisterResources failed: " + status);
      uint needed = 0, count = 0, reasons;
      status = RmGetList(session, out needed, ref count, null, out reasons);
      if (status == 0) return new int[0];
      if (status != ERROR_MORE_DATA) throw new InvalidOperationException("RmGetList failed: " + status);
      var info = new PROCESS_INFO[needed];
      count = needed;
      status = RmGetList(session, out needed, ref count, info, out reasons);
      if (status != 0) throw new InvalidOperationException("RmGetList failed: " + status);
      var pids = new int[count];
      for (int i = 0; i < count; i++) pids[i] = info[i].Process.ProcessId;
      return pids;
    } finally {
      RmEndSession(session);
    }
  }
}`;

export const powershellLiteral = (text: string): string => `'${text.replaceAll("'", "''")}'`;

export const holdersScript = (file: string): string => {
  return [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -TypeDefinition @'${RESTART_MANAGER_TYPES}\n'@`,
    `$pids = [MomongaRestartManager]::Holders(${powershellLiteral(file)})`,
    'ConvertTo-Json -Compress -InputObject @($pids)',
  ].join('\n');
};
