import { describe, expect, it } from 'vitest';
import type { WindowsProcessRow } from '../../src/platform/windows-parsers.ts';
import type { CommandResult, CommandRunner } from '../../src/platform/command-runner.ts';
import { createAsyncSignalSender, createProcessGroupPort } from '../../src/platform/group-port.ts';
import { createWindowsGroupControl, createWindowsInspector } from '../../src/platform/windows-inspector.ts';
import { groupMembers, groupOfPid, parsePidList, parseProcessTable, parseStartTimeMs } from '../../src/platform/windows-parsers.ts';
import { holdersScript, powershellLiteral, startTimeScript } from '../../src/platform/windows-scripts.ts';

const LIVE = { signal: new AbortController().signal };

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
    expect(groupMembers(rows, 100, new Map())).toEqual([100, 200, 300]);
  });

  it('claims no process through a root that was never observed, because a stale parent pid is not evidence', () => {
    expect(groupMembers(rows, 999, new Map())).toEqual([]);
    expect(groupMembers([{ pid: 50, ppid: 7, startMs: 1000 }], 7, new Map())).toEqual([]);
  });

  it('keeps the orphans of a root observed alive and bounds them by its start time', () => {
    const ledger = new Map<number, number>();
    const alive: WindowsProcessRow[] = [
      { pid: 7, ppid: 1, startMs: 5000 },
      { pid: 8, ppid: 7, startMs: 5100 },
    ];
    expect(groupMembers(alive, 7, ledger)).toEqual([7, 8]);
    const afterRootExit: WindowsProcessRow[] = [
      { pid: 8, ppid: 7, startMs: 5100 },
      { pid: 50, ppid: 7, startMs: 1000 },
      { pid: 60, ppid: 7, startMs: 9000 },
    ];
    expect(groupMembers(afterRootExit, 7, ledger)).toEqual([8, 60]);
  });

  it('keeps the children of an intermediate process that exited after it was observed', () => {
    const ledger = new Map<number, number>();
    const first: WindowsProcessRow[] = [
      { pid: 7, ppid: 1, startMs: 5000 },
      { pid: 8, ppid: 7, startMs: 5100 },
      { pid: 9, ppid: 8, startMs: 5200 },
    ];
    expect(groupMembers(first, 7, ledger)).toEqual([7, 8, 9]);
    const intermediateGone: WindowsProcessRow[] = [
      { pid: 7, ppid: 1, startMs: 5000 },
      { pid: 9, ppid: 8, startMs: 5200 },
      { pid: 10, ppid: 8, startMs: 5300 },
    ];
    expect(groupMembers(intermediateGone, 7, ledger)).toEqual([7, 9, 10]);
  });

  it('forgets the group when no member is left, so a reused pid starts a new group', () => {
    const ledger = new Map<number, number>();
    expect(groupMembers([{ pid: 7, ppid: 1, startMs: 5000 }], 7, ledger)).toEqual([7]);
    expect(groupMembers([], 7, ledger)).toEqual([]);
    expect(groupMembers([{ pid: 50, ppid: 7, startMs: 9000 }], 7, ledger)).toEqual([]);
  });

  it('starts a new group when the root pid now belongs to a different process', () => {
    const ledger = new Map<number, number>();
    groupMembers([{ pid: 7, ppid: 1, startMs: 5000 }, { pid: 8, ppid: 7, startMs: 5100 }], 7, ledger);
    expect(groupMembers([{ pid: 7, ppid: 1, startMs: 9000 }, { pid: 8, ppid: 7, startMs: 5100 }], 7, ledger)).toEqual([7]);
  });

  it('includes the root when it is alive', () => {
    expect(groupMembers(rows, 200, new Map())).toEqual([200, 300]);
  });

  it('assigns a pid to the candidate group that contains it, otherwise to itself', () => {
    expect(groupOfPid(rows, 300, [100])).toBe(100);
    expect(groupOfPid(rows, 300, [999])).toBe(300);
    expect(groupOfPid(rows, 400, [100, 999])).toBe(400);
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
    expect(await inspector.startTimeOf(321, LIVE)).toEqual({ kind: 'value', value: 1700000123456 });
    expect(calls[0]?.file).toBe(POWERSHELL);
    expect(calls[0]?.args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive']);
    expect(decodeScript(calls[0]?.args ?? [])).toContain("Win32_Process -Filter 'ProcessId=321'");
    expect(calls[0]?.env).toEqual(ENV);
  });

  it('reports a pid without a row as gone', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({ stdout: '\r\n' }), env: ENV });
    expect(await inspector.startTimeOf(321, LIVE)).toEqual({ kind: 'gone' });
  });

  it('reports a failing powershell as a deterministic failure instead of no process', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({ exitCode: 1, stderr: 'boom' }), env: ENV });
    expect(await inspector.startTimeOf(321, LIVE)).toEqual({
      kind: 'failed',
      cause: 'deterministic',
      evidence: { kind: 'exit', exitCode: 1, detail: 'powershell exited with 1: boom' },
    });
  });

  it('reports a timed-out powershell as transient', async () => {
    const timedOut = Object.assign(new Error('Command failed: timed out'), { killed: true, signal: 'SIGKILL' });
    const inspector = createWindowsInspector({ run: async () => Promise.reject(timedOut), env: ENV });
    expect(await inspector.startTimeOf(321, LIVE)).toMatchObject({ kind: 'failed', cause: 'transient', evidence: { kind: 'timeout' } });
  });

  it('reports output it cannot parse as a deterministic failure', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({ stdout: 'Monday' }), env: ENV });
    expect(await inspector.startTimeOf(321, LIVE)).toMatchObject({ kind: 'failed', cause: 'deterministic', evidence: { kind: 'unparseable' } });
  });

  it('needs SystemRoot to locate powershell', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({}), env: {} });
    expect(await inspector.startTimeOf(321, LIVE)).toMatchObject({ kind: 'failed', cause: 'deterministic', evidence: { detail: expect.stringContaining('SystemRoot') } });
  });

  it('lists marker holders through the Restart Manager', async () => {
    calls.length = 0;
    const inspector = createWindowsInspector({ run: runnerReturning({ stdout: '[812,4096]' }), env: ENV });
    expect(await inspector.holdersOf('C:\\Users\\a\\marker', LIVE)).toEqual({ kind: 'value', value: [812, 4096] });
    const script = decodeScript(calls[0]?.args ?? []);
    expect(script).toContain('rstrtmgr.dll');
    expect(script).toContain("Holders('C:\\Users\\a\\marker')");
  });

  it('maps live pids to candidate groups from one process table snapshot', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({ stdout: TABLE }), env: ENV });
    expect(await inspector.groupsOf([300, 400, 12345], [100], LIVE)).toEqual({
      kind: 'value',
      value: new Map([
        [300, 100],
        [400, 400],
      ]),
    });
  });
});

describe('windows process group port and signal sender', () => {
  const syncRunner = (table: string, log: Array<{ file: string; args: readonly string[] }>, kill: Partial<CommandResult> = {}): CommandRunner => async (file, args) => {
    log.push({ file, args });
    if (file.endsWith('taskkill.exe')) return { exitCode: 0, stdout: '', stderr: '', ...kill };
    return { exitCode: 0, stdout: table, stderr: '' };
  };

  it('terminates every member of the tree with one taskkill', async () => {
    const log: Array<{ file: string; args: readonly string[] }> = [];
    await createProcessGroupPort('win32', { run: syncRunner(TABLE, log), env: ENV }).signal(100, 'SIGTERM', LIVE);
    expect(log[1]).toEqual({ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/F', '/PID', '100', '/PID', '200', '/PID', '300'] });
  });

  it('does nothing when the tree is already gone and tolerates taskkill reporting not found', async () => {
    const log: Array<{ file: string; args: readonly string[] }> = [];
    await createProcessGroupPort('win32', { run: syncRunner(TABLE, log), env: ENV }).signal(7777, 'SIGKILL', LIVE);
    expect(log).toHaveLength(1);
    const racing: Array<{ file: string; args: readonly string[] }> = [];
    await expect(createProcessGroupPort('win32', { run: syncRunner(TABLE, racing, { exitCode: 128 }), env: ENV }).signal(100, 'SIGKILL', LIVE)).resolves.toBeUndefined();
  });

  it('propagates any other taskkill failure', async () => {
    const log: Array<{ file: string; args: readonly string[] }> = [];
    const port = createProcessGroupPort('win32', { run: syncRunner(TABLE, log, { exitCode: 5, stderr: 'denied' }), env: ENV });
    await expect(port.signal(100, 'SIGKILL', LIVE)).rejects.toThrow('taskkill exited with 5: denied');
  });

  it('reports a tree as alive while the root or a descendant has a row', async () => {
    const port = createProcessGroupPort('win32', { run: syncRunner(TABLE, []), env: ENV });
    expect(await port.alive(100, LIVE)).toBe(true);
    expect(await port.alive(999, LIVE)).toBe(false);
    expect(await port.alive(7777, LIVE)).toBe(false);
  });

  it('sends negative pids to the group port and signal 0 as an existence check', async () => {
    const calls: string[] = [];
    const send = createAsyncSignalSender('win32', () => ({
      signal: async (pgid, signal) => void calls.push(`signal ${pgid} ${signal}`),
      alive: async (pgid) => pgid === 100,
    }));
    await send(-100, 'SIGTERM', LIVE);
    await send(-100, 0, LIVE);
    await expect(send(-5, 0, LIVE)).rejects.toMatchObject({ code: 'ESRCH' });
    expect(calls).toEqual(['signal 100 SIGTERM']);
  });
});

describe('windows group control keeps what it observed between probes', () => {
  const rowsOf = (table: unknown[]): CommandRunner => async () => ({ exitCode: 0, stdout: JSON.stringify(table), stderr: '' });

  it('still reports a member after the root and its intermediate exit', async () => {
    let table: unknown[] = [
      { pid: 7, ppid: 1, startMs: 5000 },
      { pid: 8, ppid: 7, startMs: 5100 },
      { pid: 9, ppid: 8, startMs: 5200 },
    ];
    const control = createWindowsGroupControl({ run: async () => ({ exitCode: 0, stdout: JSON.stringify(table), stderr: '' }), env: ENV });
    expect(await control.members(7, LIVE)).toEqual([7, 8, 9]);
    table = [{ pid: 9, ppid: 8, startMs: 5200 }];
    expect(await control.members(7, LIVE)).toEqual([9]);
  });

  it('does not report the orphans of an earlier process that had the same pid', async () => {
    const control = createWindowsGroupControl({ run: rowsOf([{ pid: 50, ppid: 7, startMs: 1000 }]), env: ENV });
    expect(await control.members(7, LIVE)).toEqual([]);
  });
});
