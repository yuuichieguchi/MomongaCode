import { describe, expect, it } from 'vitest';
import type { CommandResult, SyncCommandRunner } from '../../src/platform/command-runner.ts';
import { createProcessGroupPort, createSignalSender } from '../../src/platform/group-port.ts';
import { createWindowsGroupControl, createWindowsInspector } from '../../src/platform/windows-inspector.ts';
import { descendantsOf, groupMembers, groupOfPid, parsePidList, parseProcessTable, parseStartTimeMs } from '../../src/platform/windows-parsers.ts';
import { holdersScript, powershellLiteral, startTimeScript } from '../../src/platform/windows-scripts.ts';

const ENV = { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' };
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const decodeScript = (args: readonly string[]): string => Buffer.from(args[args.length - 1] as string, 'base64').toString('utf16le');

const TABLE = JSON.stringify([
  { pid: 4, ppid: 0, startMs: 1000 },
  { pid: 100, ppid: 4, startMs: 5000 },
  { pid: 200, ppid: 100, startMs: 6000 },
  { pid: 300, ppid: 200, startMs: 7000 },
  { pid: 400, ppid: 999, startMs: 8000 },
  { pid: 500, ppid: 100, startMs: 4000 },
]);

describe('windows parsers (shape of ConvertTo-Json -Compress output)', () => {
  it('parses an array, a lone object and empty output', () => {
    expect(parseProcessTable('[{"pid":1,"ppid":0,"startMs":10}]')).toEqual([{ pid: 1, ppid: 0, startMs: 10 }]);
    expect(parseProcessTable('{"pid":1,"ppid":0,"startMs":10}')).toEqual([{ pid: 1, ppid: 0, startMs: 10 }]);
    expect(parseProcessTable('  \r\n')).toEqual([]);
  });

  it('rejects rows with missing or non-integer fields', () => {
    expect(() => parseProcessTable('[{"pid":1,"ppid":"0","startMs":10}]')).toThrow('ppid');
    expect(() => parseProcessTable('[3]')).toThrow('not an object');
  });

  it('parses pid lists and creation times', () => {
    expect(parsePidList('[12,34]')).toEqual([12, 34]);
    expect(parsePidList('12')).toEqual([12]);
    expect(parsePidList('')).toEqual([]);
    expect(() => parsePidList('[0]')).toThrow('positive integer');
    expect(parseStartTimeMs('1700000123456\r\n')).toBe(1700000123456);
    expect(parseStartTimeMs('')).toBeUndefined();
    expect(() => parseStartTimeMs('Monday')).toThrow('integer');
  });
});

describe('windows process trees', () => {
  const rows = parseProcessTable(TABLE);

  it('collects descendants by parent pid and ignores children older than their parent (reused pid)', () => {
    expect(descendantsOf(rows, 100).map((row) => row.pid)).toEqual([200, 300]);
  });

  it('keeps orphans of a dead root', () => {
    expect(groupMembers(rows, 999)).toEqual([400]);
  });

  it('includes the root when it is alive', () => {
    expect(groupMembers(rows, 200)).toEqual([200, 300]);
  });

  it('assigns a pid to the candidate group that contains it, otherwise to itself', () => {
    expect(groupOfPid(rows, 300, [100])).toBe(100);
    expect(groupOfPid(rows, 300, [999])).toBe(300);
    expect(groupOfPid(rows, 400, [100, 999])).toBe(999);
  });
});

describe('windows scripts', () => {
  it('quotes single quotes in literals', () => {
    expect(powershellLiteral("C:\\Users\\O'Brien\\m")).toBe("'C:\\Users\\O''Brien\\m'");
    expect(holdersScript("C:\\a'b")).toContain("Holders('C:\\a''b')");
  });

  it('rejects a non-positive pid for the creation-time query', () => {
    expect(() => startTimeScript(0)).toThrow(RangeError);
    expect(startTimeScript(42)).toContain("ProcessId=42");
  });
});

describe('windows inspector through an injected command runner', () => {
  const calls: Array<{ file: string; args: readonly string[]; env: Readonly<Record<string, string>> }> = [];
  const runnerReturning = (result: Partial<CommandResult>) => async (file: string, args: readonly string[], options: { env: Readonly<Record<string, string>> }): Promise<CommandResult> => {
    calls.push({ file, args, env: options.env });
    return { exitCode: 0, stdout: '', stderr: '', ...result };
  };

  it('asks Win32_Process for the creation time of one pid', async () => {
    calls.length = 0;
    const inspector = createWindowsInspector({ run: runnerReturning({ stdout: '1700000123456\r\n' }), env: ENV });
    expect(await inspector.startTimeOf(321)).toBe(1700000123456);
    expect(calls[0]?.file).toBe(POWERSHELL);
    expect(calls[0]?.args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive']);
    expect(decodeScript(calls[0]?.args ?? [])).toContain("Win32_Process -Filter 'ProcessId=321'");
    expect(calls[0]?.env).toEqual(ENV);
  });

  it('reports a pid without a row as undefined', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({ stdout: '\r\n' }), env: ENV });
    expect(await inspector.startTimeOf(321)).toBeUndefined();
  });

  it('propagates a failing powershell instead of reporting no process', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({ exitCode: 1, stderr: 'boom' }), env: ENV });
    await expect(inspector.startTimeOf(321)).rejects.toThrow('powershell exited with 1: boom');
  });

  it('needs SystemRoot to locate powershell', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({}), env: {} });
    await expect(inspector.startTimeOf(321)).rejects.toThrow('SystemRoot');
  });

  it('lists marker holders through the Restart Manager', async () => {
    calls.length = 0;
    const inspector = createWindowsInspector({ run: runnerReturning({ stdout: '[812,4096]' }), env: ENV });
    expect(await inspector.holdersOf('C:\\Users\\a\\marker')).toEqual([812, 4096]);
    const script = decodeScript(calls[0]?.args ?? []);
    expect(script).toContain('rstrtmgr.dll');
    expect(script).toContain("Holders('C:\\Users\\a\\marker')");
  });

  it('maps live pids to candidate groups from one process table snapshot', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({ stdout: TABLE }), env: ENV });
    expect(await inspector.groupsOf([300, 400, 12345], [100])).toEqual(
      new Map([
        [300, 100],
        [400, 400],
      ]),
    );
  });
});

describe('windows process group port and signal sender', () => {
  const syncRunner = (table: string, log: Array<{ file: string; args: readonly string[] }>, kill: Partial<CommandResult> = {}): SyncCommandRunner => (file, args) => {
    log.push({ file, args });
    if (file.endsWith('taskkill.exe')) return { exitCode: 0, stdout: '', stderr: '', ...kill };
    return { exitCode: 0, stdout: table, stderr: '' };
  };

  it('terminates every member of the tree with one taskkill', () => {
    const log: Array<{ file: string; args: readonly string[] }> = [];
    createProcessGroupPort('win32', { run: syncRunner(TABLE, log), env: ENV }).signal(100, 'SIGTERM');
    expect(log[1]).toEqual({ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/F', '/PID', '100', '/PID', '200', '/PID', '300'] });
  });

  it('does nothing when the tree is already gone and tolerates taskkill reporting not found', () => {
    const log: Array<{ file: string; args: readonly string[] }> = [];
    createProcessGroupPort('win32', { run: syncRunner(TABLE, log), env: ENV }).signal(7777, 'SIGKILL');
    expect(log).toHaveLength(1);
    const racing: Array<{ file: string; args: readonly string[] }> = [];
    expect(() => createProcessGroupPort('win32', { run: syncRunner(TABLE, racing, { exitCode: 128 }), env: ENV }).signal(100, 'SIGKILL')).not.toThrow();
  });

  it('propagates any other taskkill failure', () => {
    const log: Array<{ file: string; args: readonly string[] }> = [];
    const port = createProcessGroupPort('win32', { run: syncRunner(TABLE, log, { exitCode: 5, stderr: 'denied' }), env: ENV });
    expect(() => port.signal(100, 'SIGKILL')).toThrow('taskkill exited with 5: denied');
  });

  it('reports a tree as alive while the root or a descendant has a row', () => {
    const port = createProcessGroupPort('win32', { run: syncRunner(TABLE, []), env: ENV });
    expect(port.alive(100)).toBe(true);
    expect(port.alive(999)).toBe(true);
    expect(port.alive(7777)).toBe(false);
  });

  it('sends negative pids to the group port and signal 0 as an existence check', () => {
    const calls: string[] = [];
    const send = createSignalSender('win32', () => ({
      signal: (pgid, signal) => void calls.push(`signal ${pgid} ${signal}`),
      alive: (pgid) => pgid === 100,
    }));
    send(-100, 'SIGTERM');
    send(-100, 0);
    expect(() => send(-5, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
    expect(calls).toEqual(['signal 100 SIGTERM']);
  });
});
